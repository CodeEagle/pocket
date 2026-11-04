package dev.pocketjs.pocket_bluetooth

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.os.Build
import android.os.Handler
import java.util.ArrayDeque
import java.util.UUID

/**
 * A single-owner, serial BluetoothGatt operation queue.
 *
 * Android's GATT API only permits one in-flight operation per connection.  The
 * framework does not provide a queue, and callbacks can arrive after a timeout
 * or after a connection has been closed.  This class owns that small piece of
 * state so every operation has one completion and late callbacks cannot start
 * or complete a newer operation.
 */
@Suppress("DEPRECATION")
internal class PocketGattConnection(
    val deviceId: String,
    val ownerSessionId: String?,
    private val gatt: BluetoothGatt,
    private val mainHandler: Handler,
    private val operationTimeoutMs: Long = 8_000L,
    private val onNotification: (String, String, ByteArray) -> Unit,
    // The disconnect callback carries the same raw cause that fenced the
    // connection.  Notification cleanup must not replace a CCCD failure with
    // a generic disconnected code while still retaining the immediate fence.
    private val onDisconnected: (String, String, String) -> Unit,
) {
    internal sealed class OperationResult {
        data class Success(val value: ByteArray? = null) : OperationResult()
        data class Failure(val code: String, val message: String) : OperationResult()
    }

    private enum class OperationKind { READ, WRITE, DESCRIPTOR }

    private sealed class Operation(
        val kind: OperationKind,
        val serviceUuid: String,
        val characteristicUuid: String,
        val completion: (OperationResult) -> Unit,
    ) {
        var completed = false
        var timeout: Runnable? = null
    }

    private class ReadOperation(
        serviceUuid: String,
        characteristicUuid: String,
        completion: (OperationResult) -> Unit,
    ) : Operation(OperationKind.READ, serviceUuid, characteristicUuid, completion)

    private class WriteOperation(
        serviceUuid: String,
        characteristicUuid: String,
        val bytes: ByteArray,
        val withResponse: Boolean,
        completion: (OperationResult) -> Unit,
    ) : Operation(OperationKind.WRITE, serviceUuid, characteristicUuid, completion)

    private class DescriptorOperation(
        serviceUuid: String,
        characteristicUuid: String,
        val value: ByteArray,
        val enable: Boolean,
        completion: (OperationResult) -> Unit,
    ) : Operation(OperationKind.DESCRIPTOR, serviceUuid, characteristicUuid, completion) {
        // A failed CCCD write can leave the local notification producer or the
        // remote CCCD in an unknown state.  The caller must fence the GATT
        // connection instead of treating that state as safely released.
        var fenceOnFailure = false
    }

    private val lock = Any()
    private val queue = ArrayDeque<Operation>()
    private var active: Operation? = null
    private var closed = false
    private var closeReason: Pair<String, String>? = null

    fun ownerMatches(sessionId: String): Boolean = ownerSessionId == sessionId

    fun ownsGatt(candidate: BluetoothGatt): Boolean = gatt === candidate

    fun isClosed(): Boolean = synchronized(lock) { closed }

    fun canRead(serviceUuid: String, characteristicUuid: String): Boolean {
        val characteristic = findCharacteristic(serviceUuid, characteristicUuid) ?: return false
        return characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0
    }

    fun canWrite(serviceUuid: String, characteristicUuid: String, withResponse: Boolean): Boolean {
        val characteristic = findCharacteristic(serviceUuid, characteristicUuid) ?: return false
        val property = if (withResponse) {
            BluetoothGattCharacteristic.PROPERTY_WRITE
        } else {
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
        }
        return characteristic.properties and property != 0
    }

    fun notificationEnableValue(serviceUuid: String, characteristicUuid: String): ByteArray? {
        val characteristic = findCharacteristic(serviceUuid, characteristicUuid) ?: return null
        return when {
            characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 ->
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE.copyOf()
            characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0 ->
                BluetoothGattDescriptor.ENABLE_INDICATION_VALUE.copyOf()
            else -> null
        }
    }

    fun enqueueRead(
        serviceUuid: String,
        characteristicUuid: String,
        completion: (OperationResult) -> Unit,
    ) {
        enqueue(
            ReadOperation(serviceUuid, characteristicUuid, completion),
        )
    }

    fun enqueueWrite(
        serviceUuid: String,
        characteristicUuid: String,
        bytes: ByteArray,
        withResponse: Boolean,
        completion: (OperationResult) -> Unit,
    ) {
        enqueue(
            WriteOperation(serviceUuid, characteristicUuid, bytes, withResponse, completion),
        )
    }

    fun enqueueDescriptorWrite(
        serviceUuid: String,
        characteristicUuid: String,
        value: ByteArray,
        enable: Boolean,
        completion: (OperationResult) -> Unit,
    ) {
        enqueue(
            DescriptorOperation(serviceUuid, characteristicUuid, value, enable, completion),
        )
    }

    /** Returns the service/characteristic inventory discovered by Android. */
    fun serviceInventory(): List<Map<String, Any?>> {
        return try {
            gatt.services.orEmpty().map { service ->
                val characteristics = service.characteristics.orEmpty().map { characteristic ->
                    mapOf(
                        "uuid" to characteristic.uuid.toString(),
                        "properties" to characteristicProperties(characteristic.properties),
                        "canRead" to (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0),
                        "canWrite" to (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0),
                        "canWriteWithoutResponse" to (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0),
                        "canNotify" to (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0),
                        "canIndicate" to (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0),
                        // Android exposes no stable public isNotifying bit on
                        // BluetoothGattCharacteristic; this inventory is the
                        // pre-subscription state.
                        "notifying" to false,
                    )
                }
                mapOf(
                    "uuid" to service.uuid.toString(),
                    "characteristics" to characteristics,
                )
            }
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    /** Called by BluetoothGattCallback when an indication/notification arrives. */
    fun onCharacteristicChanged(
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
    ) {
        val address = try {
            characteristic.service.uuid.toString() to characteristic.uuid.toString()
        } catch (_: Exception) {
            return
        }
        postMain {
            synchronized(lock) {
                if (closed) return@synchronized
            }
            onNotification(address.first, address.second, value.copyOf())
        }
    }

    /** Called by BluetoothGattCallback for the pre-API-33 read callback. */
    fun onCharacteristicRead(
        characteristic: BluetoothGattCharacteristic,
        status: Int,
    ) {
        val bytes = try { characteristic.value?.copyOf() } catch (_: Exception) { null }
        onCharacteristicRead(characteristic, bytes, status)
    }

    /** Called by BluetoothGattCallback for the API-33+ read callback. */
    fun onCharacteristicRead(
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray?,
        status: Int,
    ) {
        val operation = currentOperation(OperationKind.READ, characteristic) ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
            complete(operation, OperationResult.Success(value?.copyOf() ?: ByteArray(0)))
        } else {
            complete(
                operation,
                OperationResult.Failure(
                    "hardware_bluetooth_read",
                    "Bluetooth characteristic read failed ($status)",
                ),
            )
        }
    }

    fun onCharacteristicWrite(
        characteristic: BluetoothGattCharacteristic,
        status: Int,
    ) {
        val operation = currentOperation(OperationKind.WRITE, characteristic) ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
            complete(operation, OperationResult.Success())
        } else {
            complete(
                operation,
                OperationResult.Failure(
                    "hardware_bluetooth_write",
                    "Bluetooth characteristic write failed ($status)",
                ),
            )
        }
    }

    fun onDescriptorWrite(
        descriptor: BluetoothGattDescriptor,
        status: Int,
    ) {
        val characteristic = descriptor.characteristic ?: return
        val operation = currentOperation(OperationKind.DESCRIPTOR, characteristic) ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
            complete(operation, OperationResult.Success())
        } else {
            val descriptorOperation = operation as? DescriptorOperation
            val rollbackFailed = if (descriptorOperation?.enable == true) {
                !rollbackNotification(characteristic)
            } else {
                // A failed disable leaves the remote CCCD potentially
                // enabled, so close the connection and fence late callbacks.
                true
            }
            if (descriptorOperation != null && rollbackFailed) {
                descriptorOperation.fenceOnFailure = true
            }
            complete(
                operation,
                OperationResult.Failure(
                    "hardware_bluetooth_notify",
                    "Bluetooth notification configuration failed ($status)",
                ),
                invalidateConnection = rollbackFailed,
            )
        }
    }

    /** Marks the connection unusable and completes every queued operation once. */
    fun disconnect(code: String = "hardware_bluetooth_disconnected", message: String = "Bluetooth connection was lost") {
        val pending: List<Operation>
        synchronized(lock) {
            if (closed) return
            closed = true
            closeReason = code to message
            pending = buildList {
                active?.let(::add)
                addAll(queue)
            }
            active = null
            queue.clear()
        }
        pending.forEach { operation ->
            cancelTimeout(operation)
            completeOnce(operation, OperationResult.Failure(code, message), startNext = false)
        }
        try {
            gatt.close()
        } catch (_: Exception) {
            // The adapter may already have released the GATT object.
        }
        postMain { onDisconnected(deviceId, code, message) }
    }

    /** Closes a connection without treating it as an unexpected disconnect. */
    fun close() {
        disconnect("plugin_revoked", "Bluetooth connection was released")
    }

    private fun enqueue(operation: Operation) {
        synchronized(lock) {
            if (closed) {
                val reason = closeReason ?: ("hardware_bluetooth_disconnected" to "Bluetooth connection is unavailable")
                postMain {
                    operation.completion(OperationResult.Failure(reason.first, reason.second))
                }
                return
            }
            queue.addLast(operation)
        }
        startNext()
    }

    private fun startNext() {
        val operation = synchronized(lock) {
            if (closed || active != null || queue.isEmpty()) return
            queue.removeFirst().also { active = it }
        }
        val characteristic = findCharacteristic(operation.serviceUuid, operation.characteristicUuid)
        if (characteristic == null) {
            complete(
                operation,
                OperationResult.Failure(
                    "hardware_bluetooth_characteristic",
                    "Bluetooth characteristic was not discovered",
                ),
            )
            return
        }
        try {
            val started = when (operation) {
                is ReadOperation -> startRead(characteristic)
                is WriteOperation -> startWrite(characteristic, operation)
                is DescriptorOperation -> startDescriptorWrite(characteristic, operation)
            }
            if (!started) {
                complete(
                    operation,
                    OperationResult.Failure(
                        "hardware_bluetooth_operation",
                        "Bluetooth GATT operation could not be started",
                    ),
                    invalidateConnection = (operation as? DescriptorOperation)?.fenceOnFailure == true,
                )
                return
            }
            val timeout = Runnable {
                // There is no cancellation API for a BluetoothGatt operation.
                // Closing the connection prevents a timed-out callback from
                // being mistaken for the next queued operation.
                complete(
                    operation,
                    OperationResult.Failure("hardware_timeout", "Bluetooth GATT operation timed out"),
                    invalidateConnection = true,
                )
            }
            operation.timeout = timeout
            mainHandler.postDelayed(timeout, operationTimeoutMs)
        } catch (security: SecurityException) {
            complete(
                operation,
                OperationResult.Failure("hardware_permission_denied", security.message ?: "Bluetooth permission is not granted"),
                invalidateConnection = true,
            )
        } catch (failure: Exception) {
            complete(
                operation,
                OperationResult.Failure("hardware_bluetooth_operation", failure.message ?: "Bluetooth GATT operation failed"),
                invalidateConnection = (operation as? DescriptorOperation)?.fenceOnFailure == true,
            )
        }
    }

    private fun startRead(characteristic: BluetoothGattCharacteristic): Boolean {
        return if (Build.VERSION.SDK_INT >= 33) {
            gatt.readCharacteristic(characteristic)
        } else {
            @Suppress("DEPRECATION")
            gatt.readCharacteristic(characteristic)
        }
    }

    private fun startWrite(
        characteristic: BluetoothGattCharacteristic,
        operation: WriteOperation,
    ): Boolean {
        val writeType = if (operation.withResponse) {
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        } else {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        return if (Build.VERSION.SDK_INT >= 33) {
            gatt.writeCharacteristic(characteristic, operation.bytes, writeType) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.writeType = writeType
            @Suppress("DEPRECATION")
            characteristic.value = operation.bytes
            @Suppress("DEPRECATION")
            gatt.writeCharacteristic(characteristic)
        }
    }

    private fun startDescriptorWrite(
        characteristic: BluetoothGattCharacteristic,
        operation: DescriptorOperation,
    ): Boolean {
        val descriptor = characteristic.getDescriptor(CCCD_UUID)
            ?: run {
                if (!operation.enable) operation.fenceOnFailure = true
                return false
            }
        val localConfigured = try {
            gatt.setCharacteristicNotification(characteristic, operation.enable)
        } catch (failure: Exception) {
            operation.fenceOnFailure = true
            throw failure
        }
        if (!localConfigured) {
            if (!operation.enable) operation.fenceOnFailure = true
            return false
        }
        return try {
            val started = if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeDescriptor(descriptor, operation.value) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                descriptor.value = operation.value
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(descriptor)
            }
            if (!started) {
                operation.fenceOnFailure = !operation.enable || !rollbackNotification(characteristic)
            }
            started
        } catch (failure: Exception) {
            val rollbackFailed = if (operation.enable) !rollbackNotification(characteristic) else true
            operation.fenceOnFailure = rollbackFailed
            throw failure
        }
    }

    private fun rollbackNotification(characteristic: BluetoothGattCharacteristic): Boolean = try {
        gatt.setCharacteristicNotification(characteristic, false)
    } catch (_: Exception) {
        false
    }

    private fun findCharacteristic(
        serviceUuid: String,
        characteristicUuid: String,
    ): BluetoothGattCharacteristic? {
        val service = try {
            gatt.getService(UUID.fromString(serviceUuid))
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: SecurityException) {
            null
        }
        return service?.getCharacteristicOrNull(characteristicUuid)
    }

    private fun currentOperation(
        kind: OperationKind,
        characteristic: BluetoothGattCharacteristic,
    ): Operation? {
        val serviceUuid = try { characteristic.service.uuid.toString() } catch (_: Exception) { return null }
        val characteristicUuid = try { characteristic.uuid.toString() } catch (_: Exception) { return null }
        synchronized(lock) {
            val operation = active ?: return null
            return if (
                operation.kind == kind &&
                operation.serviceUuid.equals(serviceUuid, ignoreCase = true) &&
                operation.characteristicUuid.equals(characteristicUuid, ignoreCase = true)
            ) operation else null
        }
    }

    private fun complete(
        operation: Operation,
        result: OperationResult,
        invalidateConnection: Boolean = false,
    ) {
        val shouldComplete = synchronized(lock) {
            if (operation.completed || active !== operation) false else {
                operation.completed = true
                active = null
                true
            }
        }
        if (!shouldComplete) return
        cancelTimeout(operation)
        if (invalidateConnection) {
            // Fence the connection immediately on the callback thread.  A
            // late notification callback may already be queued on the main
            // handler; marking the connection closed before that handler runs
            // prevents the stale producer from reaching the shared sink.
            val cause = result.disconnectCause()
            disconnect(cause.first, cause.second)
        }
        postMain {
            operation.completion(result)
            if (!invalidateConnection) startNext()
        }
    }

    private fun completeOnce(
        operation: Operation,
        result: OperationResult,
        startNext: Boolean,
    ) {
        val shouldComplete = synchronized(lock) {
            if (operation.completed) false else {
                operation.completed = true
                true
            }
        }
        if (!shouldComplete) return
        postMain {
            operation.completion(result)
            if (startNext) startNext()
        }
    }

    private fun cancelTimeout(operation: Operation) {
        operation.timeout?.let(mainHandler::removeCallbacks)
        operation.timeout = null
    }

    private fun postMain(block: () -> Unit) {
        if (LooperHolder.isMainThread()) block() else mainHandler.post(block)
    }

    private fun characteristicProperties(properties: Int): List<String> = buildList {
        if (properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) add("read")
        if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) add("write")
        if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) add("writeWithoutResponse")
        if (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) add("notify")
        if (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) add("indicate")
        if (properties and BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE != 0) add("signedWrite")
        if (properties and BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS != 0) add("extended")
    }

    private fun android.bluetooth.BluetoothGattService.getCharacteristicOrNull(uuid: String): BluetoothGattCharacteristic? {
        return try {
            getCharacteristic(UUID.fromString(uuid))
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private object LooperHolder {
        fun isMainThread(): Boolean = android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
    }

    companion object {
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}

internal fun PocketGattConnection.OperationResult.disconnectCause(): Pair<String, String> = when (this) {
    is PocketGattConnection.OperationResult.Failure -> code to message
    is PocketGattConnection.OperationResult.Success ->
        "hardware_bluetooth_disconnected" to "Bluetooth connection was released"
}
