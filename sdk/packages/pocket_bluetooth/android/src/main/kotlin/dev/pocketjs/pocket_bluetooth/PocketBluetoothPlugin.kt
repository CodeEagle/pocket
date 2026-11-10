package dev.pocketjs.pocket_bluetooth

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.ArrayDeque
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Android Bluetooth LE transport for the independent Bluetooth group. */
@Suppress("DEPRECATION", "UNUSED_PARAMETER", "MemberVisibilityCanBePrivate")
class PocketBluetoothPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware/bluetooth"
        private const val EVENTS_CHANNEL_NAME = "com.pocketnexus.host/hardware/bluetooth/events"
        private const val MAX_QUEUED_EVENTS = 128
    }

    private var applicationContext: Context? = null
    private var channel: MethodChannel? = null
    private var eventsChannel: EventChannel? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val eventLock = Any()
    private var eventSink: EventChannel.EventSink? = null
    private val queuedEvents = ArrayDeque<Map<String, Any?>>()

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bluetoothScanner: BluetoothLeScanner? = null
    private val bluetoothLock = Any()
    private val discoveredDevices = ConcurrentHashMap<String, Map<String, Any?>>()
    private val discoveredBluetoothDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private var pendingScanResult: MethodChannel.Result? = null
    private var pendingScanOwnerSessionId: String? = null
    private var pendingScanCallback: ScanCallback? = null
    private var pendingScanGeneration: Long? = null
    private var scanGeneration = 0L
    private var scanTimeout: Runnable? = null
    private val activeGattConnections = ConcurrentHashMap<String, PocketGattConnection>()
    private val pendingGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val pendingConnectionOwners = ConcurrentHashMap<String, String>()
    private val pendingConnectionGenerations = ConcurrentHashMap<String, Long>()
    private var connectionGeneration = 0L
    private val pendingConnections = ConcurrentHashMap<String, MethodChannel.Result>()
    private val connectionTimeouts = ConcurrentHashMap<String, Runnable>()
    private val pendingDisconnects = ConcurrentHashMap<String, PendingBleDisconnect>()

    private data class PendingBleDisconnect(
        val ownerSessionId: String,
        val connection: PocketGattConnection,
        val result: MethodChannel.Result,
        val timeout: Runnable,
    )

    private data class NotificationKey(
        val deviceId: String,
        val serviceUuid: String,
        val characteristicUuid: String,
    )

    private data class NotificationStream(
        val streamId: String,
        val sessionId: String,
        val key: NotificationKey,
        val connection: PocketGattConnection,
    )

    private class NotificationState(
        val key: NotificationKey,
        val connection: PocketGattConnection,
        val enableValue: ByteArray,
    ) {
        val streamIds = LinkedHashMap<String, MethodChannel.Result?>()
        var configured = false
        var enableQueued = false
        var disableQueued = false
        var disableRequested = false
    }

    private val notificationStreams = ConcurrentHashMap<String, NotificationStream>()
    private val notificationStates = ConcurrentHashMap<NotificationKey, NotificationState>()

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
        eventsChannel = EventChannel(binding.binaryMessenger, EVENTS_CHANNEL_NAME).also { eventChannel ->
            eventChannel.setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
                    val pending = synchronized(eventLock) {
                        eventSink = events
                        val values = queuedEvents.toList()
                        queuedEvents.clear()
                        values
                    }
                    pending.forEach(events::success)
                }

                override fun onCancel(arguments: Any?) {
                    synchronized(eventLock) { eventSink = null }
                }
            })
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disposeNativeResources("plugin detached")
        channel?.setMethodCallHandler(null)
        channel = null
        eventsChannel?.setStreamHandler(null)
        eventsChannel = null
        synchronized(eventLock) {
            eventSink = null
            queuedEvents.clear()
        }
        applicationContext = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments.asStringMap()
        when (call.method) {
            "startBleScan" -> startBleScan(
                (args["timeoutMs"] as? Number)?.toLong() ?: 1600L,
                normalizeSessionId(args["sessionId"]),
                result,
            )
            "connectBleDevice" -> connectBleDevice(
                args["deviceId"] as? String,
                normalizeSessionId(args["sessionId"]),
                result,
            )
            "disconnectBleDevice" -> disconnectBleDevice(
                args["deviceId"] as? String,
                normalizeSessionId(args["sessionId"]),
                result,
            )
            "readBleCharacteristic" -> readBleCharacteristic(args, result)
            "writeBleCharacteristic" -> writeBleCharacteristic(args, result)
            "startHardwareStream" -> startHardwareStream(args, result)
            "stopHardwareStream" -> stopHardwareStream(args, result)
            "disposeSession" -> disposeSession(args, result)
            else -> result.success(error("hardware_unsupported", "unknown Bluetooth method: ${call.method}"))
        }
    }

    // Permission prompts/status are owned by the Dart permission provider.
    // These guards only fence an operation at the native API boundary.
    private fun bluetoothPermissions(): List<String> = if (Build.VERSION.SDK_INT >= 31) {
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else if (Build.VERSION.SDK_INT >= 23) {
        listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    } else {
        emptyList()
    }

    private fun hasBluetoothPermissions(context: Context): Boolean =
        bluetoothPermissions().all { permission ->
            Build.VERSION.SDK_INT < 23 ||
                context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        }

    private fun startHardwareStream(args: Map<String, Any?>, result: MethodChannel.Result) {
        val streamId = args["streamId"] as? String
        val sessionId = normalizeSessionId(args["sessionId"])
        val kind = args["kind"] as? String
        if (streamId.isNullOrBlank() || sessionId == null || kind != "ble.notifications") {
            result.success(error("invalid_argument", "ble.notifications requires streamId, sessionId and kind"))
            return
        }
        clearQueuedEvents(streamId)
        startBleNotificationStream(args, streamId, sessionId, result)
    }

    private fun stopHardwareStream(args: Map<String, Any?>, result: MethodChannel.Result) {
        val streamId = args["streamId"] as? String
        val sessionId = normalizeSessionId(args["sessionId"])
        if (streamId.isNullOrBlank() || sessionId == null) {
            result.success(error("invalid_argument", "streamId and sessionId are required"))
            return
        }
        stopBleNotificationStream(streamId, sessionId, result)
    }

    // region Bluetooth LE

    private fun startBleScan(
        timeoutMillis: Long,
        ownerSessionId: String?,
        result: MethodChannel.Result,
    ) {
        val context = applicationContext
        if (context == null) {
            result.success(error("hardware_not_ready", "Android context is not attached"))
            return
        }
        val adapter = bluetoothAdapter(context)
        if (adapter == null) {
            result.success(error("hardware_unsupported", "Bluetooth LE is unavailable on this device"))
            return
        }
        if (!hasBluetoothPermissions(context)) {
            result.success(error("hardware_permission_denied", "Bluetooth permission is not granted"))
            return
        }
        val adapterEnabled = try {
            adapter.isEnabled
        } catch (_: SecurityException) {
            result.success(error("hardware_permission_denied", "Bluetooth permission is not granted"))
            return
        }
        if (!adapterEnabled) {
            result.success(error("hardware_bluetooth_unavailable", "Bluetooth is not powered on"))
            return
        }
        val scanner = try {
            adapter.bluetoothLeScanner
        } catch (_: SecurityException) {
            null
        }
        if (scanner == null) {
            result.success(error("hardware_bluetooth_unavailable", "Bluetooth LE scanner is unavailable"))
            return
        }
        val clampedTimeout = timeoutMillis.coerceIn(250L, 30_000L)
        val generation: Long
        val callback: ScanCallback
        val timeout: Runnable
        synchronized(bluetoothLock) {
            if (pendingScanResult != null) {
                result.success(error("hardware_busy", "Bluetooth scan is already running"))
                return
            }
            generation = ++scanGeneration
            callback = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    if (!isActiveScan(generation)) return
                    val device = result.device ?: return
                    val id = try {
                        device.address
                    } catch (_: SecurityException) {
                        return
                    }
                    val name = try {
                        device.name ?: result.scanRecord?.deviceName ?: ""
                    } catch (_: SecurityException) {
                        result.scanRecord?.deviceName ?: ""
                    }
                    val manufacturerData = LinkedHashMap<String, Any?>()
                    result.scanRecord?.manufacturerSpecificData?.let { entries ->
                        for (index in 0 until entries.size()) {
                            val companyId = entries.keyAt(index)
                            val bytes = entries.valueAt(index) ?: ByteArray(0)
                            manufacturerData[companyId.toString()] = bytes.map { it.toInt() and 0xff }
                        }
                    }
                    discoveredBluetoothDevices[id] = device
                    discoveredDevices[id] = mapOf(
                        "id" to id,
                        "name" to name,
                        "rssi" to result.rssi,
                        "manufacturerData" to manufacturerData,
                    )
                }

                override fun onScanFailed(errorCode: Int) {
                    completeBleScan(
                        error("hardware_bluetooth_scan", "Bluetooth scan failed ($errorCode)"),
                        generation,
                    )
                }
            }
            timeout = Runnable { finishBleScan(generation) }
            discoveredDevices.clear()
            discoveredBluetoothDevices.clear()
            pendingScanResult = result
            pendingScanOwnerSessionId = ownerSessionId
            pendingScanCallback = callback
            pendingScanGeneration = generation
            scanTimeout = timeout
            bluetoothAdapter = adapter
            bluetoothScanner = scanner
        }
        mainHandler.postDelayed(timeout, clampedTimeout)
        try {
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            scanner.startScan(null, settings, callback)
        } catch (security: SecurityException) {
            completeBleScan(
                error("hardware_permission_denied", security.message ?: "Bluetooth scan permission is not granted"),
                generation,
            )
            return
        } catch (failure: Exception) {
            completeBleScan(
                error("hardware_bluetooth_scan", failure.message ?: "Bluetooth scan failed"),
                generation,
            )
            return
        }
    }

    private fun isActiveScan(generation: Long): Boolean = synchronized(bluetoothLock) {
        pendingScanResult != null && pendingScanGeneration == generation
    }

    private fun finishBleScan(generation: Long) {
        if (!isActiveScan(generation)) return
        completeBleScan(
            ok(
                "realBle" to true,
                "state" to "poweredOn",
                "devices" to discoveredDevices.values.sortedBy { "${it["id"]}" },
            ),
            generation,
        )
    }

    private fun completeBleScan(value: Map<String, Any?>, generation: Long? = null) {
        var callback: MethodChannel.Result? = null
        var scannerToStop: BluetoothLeScanner? = null
        var callbackToStop: ScanCallback? = null
        var timeoutToRemove: Runnable? = null
        synchronized(bluetoothLock) {
            if (generation != null && pendingScanGeneration != generation) return
            callback = pendingScanResult
            scannerToStop = bluetoothScanner
            callbackToStop = pendingScanCallback
            timeoutToRemove = scanTimeout
            pendingScanResult = null
            pendingScanOwnerSessionId = null
            pendingScanCallback = null
            pendingScanGeneration = null
            scanTimeout = null
            bluetoothScanner = null
        }
        callback ?: return
        timeoutToRemove?.let(mainHandler::removeCallbacks)
        try {
            if (scannerToStop != null && callbackToStop != null) {
                scannerToStop?.stopScan(callbackToStop)
            }
        } catch (_: SecurityException) {
            // The request is still completed with a structured result.  The
            // adapter may have been revoked while the scan was ending.
        } catch (_: Exception) {
            // Some vendor stacks throw IllegalStateException when a scan has
            // already stopped.  The pending method result is still complete.
        }
        mainHandler.post { callback?.success(value) }
    }

    private fun completeBleScanForOwner(value: Map<String, Any?>, ownerSessionId: String?) {
        val generation = synchronized(bluetoothLock) {
            if (pendingScanResult == null || pendingScanOwnerSessionId != ownerSessionId) {
                return
            }
            pendingScanGeneration
        } ?: return
        completeBleScan(value, generation)
    }

    private fun connectBleDevice(
        deviceId: String?,
        ownerSessionId: String?,
        result: MethodChannel.Result,
    ) {
        if (deviceId.isNullOrBlank()) {
            result.success(error("invalid_argument", "deviceId must not be empty"))
            return
        }
        val context = applicationContext
        val adapter = context?.let(::bluetoothAdapter)
        if (context == null || adapter == null) {
            result.success(error("hardware_unsupported", "Bluetooth LE is unavailable on this device"))
            return
        }
        if (!hasBluetoothPermissions(context)) {
            result.success(error("hardware_permission_denied", "Bluetooth permission is not granted"))
            return
        }
        val adapterEnabled = try {
            adapter.isEnabled
        } catch (_: SecurityException) {
            result.success(error("hardware_permission_denied", "Bluetooth permission is not granted"))
            return
        }
        if (!adapterEnabled) {
            result.success(error("hardware_bluetooth_unavailable", "Bluetooth is not powered on"))
            return
        }
        val device = discoveredBluetoothDevices[deviceId]
        if (device == null) {
            result.success(error("hardware_not_found", "device was not discovered by this host"))
            return
        }
        if (pendingDisconnects.containsKey(deviceId)) {
            result.success(error("hardware_busy", "Bluetooth disconnect is still pending"))
            return
        }
        activeGattConnections[deviceId]?.let { connection ->
            if (connection.isClosed()) {
                activeGattConnections.remove(deviceId, connection)
                handleGattDisconnected(
                    deviceId,
                    "hardware_bluetooth_disconnected",
                    "Bluetooth connection was lost",
                )
            }
        }
        val current = activeGattConnections[deviceId]
        if (current != null) {
            if (current.ownerSessionId != ownerSessionId) {
                result.success(error("hardware_owner_mismatch", "Bluetooth device is owned by another session"))
            } else {
                val inventory = current.serviceInventory()
                result.success(
                    ok(
                        "realBle" to true,
                        "device" to deviceId,
                        "state" to "connected",
                        "services" to inventory,
                        "serviceUuids" to inventory.mapNotNull { it["uuid"] as? String },
                    ),
                )
            }
            return
        }
        val generation: Long
        synchronized(bluetoothLock) {
            if (pendingConnections.containsKey(deviceId)) {
                result.success(error("hardware_busy", "connection is already pending"))
                return
            }
            generation = ++connectionGeneration
            pendingConnections[deviceId] = result
            pendingConnectionOwners[deviceId] = ownerSessionId ?: ""
            pendingConnectionGenerations[deviceId] = generation
        }
        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                val activeConnection = activeGattConnections[deviceId]
                val connection = activeConnection?.takeIf { it.ownsGatt(gatt) }
                    ?: pendingDisconnects[deviceId]?.connection?.takeIf { it.ownsGatt(gatt) }
                if (connection != null) {
                    if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                        val message = "Bluetooth connection was lost ($status)"
                        connection.disconnect(
                            "hardware_bluetooth_disconnected",
                            message,
                        )
                        handleGattDisconnected(
                            deviceId,
                            "hardware_bluetooth_disconnected",
                            message,
                            expectedGatt = gatt,
                        )
                        if (isNativeBleDisconnectConfirmation(newState)) {
                            confirmGattDisconnect(deviceId, connection, gatt)
                        }
                    }
                    return
                }
                if (activeConnection != null) {
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                if (!isPendingConnection(deviceId, generation)) {
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                val pendingGatt = pendingGatts[deviceId]
                if (pendingGatt != null && pendingGatt !== gatt) {
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    finishConnection(deviceId, error("hardware_bluetooth_connect", "Bluetooth connection failed ($status)"), generation)
                    try { gatt.close() } catch (_: Exception) { }
                } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try {
                        if (!gatt.discoverServices()) {
                            finishConnection(deviceId, error("hardware_bluetooth_services", "service discovery could not be started"), generation)
                            try { gatt.close() } catch (_: Exception) { }
                        }
                    } catch (security: SecurityException) {
                        finishConnection(deviceId, error("hardware_bluetooth_services", security.message ?: "service discovery failed"), generation)
                        try { gatt.close() } catch (_: Exception) { }
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    finishConnection(deviceId, error("hardware_bluetooth_connect", "Bluetooth connection failed ($status)"), generation)
                    try { gatt.close() } catch (_: Exception) { }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val active = activeGattConnections[deviceId]
                if (active != null) {
                    if (!active.ownsGatt(gatt)) {
                        try { gatt.close() } catch (_: Exception) { }
                    }
                    return
                }
                val pendingSnapshot = pendingConnectionSnapshot(deviceId, generation, gatt)
                if (pendingSnapshot == null) {
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    finishConnection(deviceId, error("hardware_bluetooth_services", "service discovery failed ($status)"), generation)
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                val services = try {
                    gatt.services.orEmpty()
                } catch (_: SecurityException) {
                    null
                }
                if (services == null) {
                    finishConnection(
                        deviceId,
                        error("hardware_bluetooth_services", "Bluetooth services could not be read"),
                        generation,
                    )
                    try { gatt.close() } catch (_: Exception) { }
                    return
                }
                val connection = PocketGattConnection(
                    deviceId = deviceId,
                    ownerSessionId = pendingSnapshot.ownerSessionId,
                    gatt = gatt,
                    mainHandler = mainHandler,
                    onNotification = { serviceUuid, characteristicUuid, value ->
                        handleBleNotification(deviceId, serviceUuid, characteristicUuid, value)
                    },
                    onDisconnected = { disconnectedDeviceId, code, message ->
                        handleGattDisconnected(disconnectedDeviceId, code, message, gatt)
                    },
                )
                if (!activatePendingConnection(deviceId, generation, gatt, connection)) {
                    connection.close()
                    return
                }
                val inventory = connection.serviceInventory()
                finishConnection(
                    deviceId,
                    ok(
                        "realBle" to true,
                        "device" to deviceId,
                        "state" to "connected",
                        "services" to inventory,
                        "serviceUuids" to inventory.mapNotNull { it["uuid"] as? String },
                    ),
                    generation,
                )
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: android.bluetooth.BluetoothGattCharacteristic,
                status: Int,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onCharacteristicRead(characteristic, status)
            }

            override fun onCharacteristicRead(
                gatt: BluetoothGatt,
                characteristic: android.bluetooth.BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onCharacteristicRead(characteristic, value, status)
            }

            override fun onCharacteristicWrite(
                gatt: BluetoothGatt,
                characteristic: android.bluetooth.BluetoothGattCharacteristic,
                status: Int,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onCharacteristicWrite(characteristic, status)
            }

            override fun onDescriptorWrite(
                gatt: BluetoothGatt,
                descriptor: BluetoothGattDescriptor,
                status: Int,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onDescriptorWrite(descriptor, status)
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: android.bluetooth.BluetoothGattCharacteristic,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onCharacteristicChanged(
                    characteristic,
                    characteristic.value?.copyOf() ?: ByteArray(0),
                    )
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: android.bluetooth.BluetoothGattCharacteristic,
                value: ByteArray,
            ) {
                activeGattConnections[deviceId]
                    ?.takeIf { it.ownsGatt(gatt) }
                    ?.onCharacteristicChanged(characteristic, value)
            }
        }
        try {
            val gatt = if (Build.VERSION.SDK_INT >= 23) {
                device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(context, false, callback)
            }
            if (gatt == null) {
                if (clearPendingConnection(deviceId, generation)) {
                    result.success(error("hardware_bluetooth_connect", "Bluetooth connection could not be started"))
                }
                return
            }
            if (!registerPendingGatt(deviceId, generation, gatt)) return
        } catch (security: SecurityException) {
            if (clearPendingConnection(deviceId, generation)) {
                result.success(error("hardware_permission_denied", security.message ?: "Bluetooth connection permission is not granted"))
            }
            return
        } catch (failure: Exception) {
            if (clearPendingConnection(deviceId, generation)) {
                result.success(error("hardware_bluetooth_connect", failure.message ?: "Bluetooth connection could not be started"))
            }
            return
        }
        val timeout = Runnable {
            finishConnection(deviceId, error("hardware_timeout", "Bluetooth connection timed out"), generation)
        }
        if (installConnectionTimeout(deviceId, generation, timeout)) {
            mainHandler.postDelayed(timeout, 15_000L)
        }
    }

    private fun disconnectBleDevice(
        deviceId: String?,
        ownerSessionId: String?,
        result: MethodChannel.Result,
    ) {
        if (deviceId.isNullOrBlank() || ownerSessionId.isNullOrBlank()) {
            result.success(error("invalid_argument", "deviceId and sessionId are required"))
            return
        }

        val snapshot = synchronized(bluetoothLock) {
            val connection = activeGattConnections[deviceId]
            val pendingCallback = pendingConnections[deviceId]
            val pendingOwner = pendingConnectionOwners[deviceId]?.takeIf { it.isNotEmpty() }
            val generation = pendingConnectionGenerations[deviceId]
            val ownerMismatch = (connection != null && connection.ownerSessionId != ownerSessionId) ||
                (pendingCallback != null && pendingOwner != ownerSessionId)
            val cancellation = if (!ownerMismatch && pendingCallback != null && generation != null &&
                pendingConnectionGenerations[deviceId] == generation &&
                pendingConnections.remove(deviceId, pendingCallback)) {
                PendingConnectCancellation(
                    callback = pendingCallback,
                    gatt = pendingGatts.remove(deviceId),
                    timeout = connectionTimeouts.remove(deviceId),
                ).also {
                    pendingConnectionOwners.remove(deviceId)
                    pendingConnectionGenerations.remove(deviceId)
                }
            } else {
                null
            }
            DisconnectSnapshot(connection, ownerMismatch, cancellation)
        }
        if (snapshot.ownerMismatch) {
            result.success(error("hardware_owner_mismatch", "Bluetooth connection attempt is owned by another session"))
            return
        }
        pendingDisconnects[deviceId]?.let { pending ->
            val response = if (pending.ownerSessionId == ownerSessionId) {
                error("hardware_busy", "Bluetooth disconnect is already pending")
            } else {
                error("hardware_owner_mismatch", "Bluetooth device is owned by another session")
            }
            result.success(response)
            return
        }

        snapshot.pendingConnectCancellation?.let { cancellation ->
            cancellation.timeout?.let(mainHandler::removeCallbacks)
            mainHandler.post {
                cancellation.callback.success(
                    error("hardware_cancelled", "Bluetooth connection was cancelled by disconnect"),
                )
            }
            if (cancellation.gatt?.let { snapshot.connection?.ownsGatt(it) == true } != true) {
                try { cancellation.gatt?.close() } catch (_: Exception) { }
            }
        }

        val connection = snapshot.connection
        if (connection == null) {
            if (snapshot.pendingConnectCancellation != null) {
                result.success(
                    disconnectReceipt(deviceId, pendingConnectCancelled = true),
                )
            } else {
                result.success(disconnectReceipt(deviceId, alreadyClosed = true))
            }
            return
        }

        if (connection.isClosed()) {
            handleGattDisconnected(
                deviceId,
                "hardware_bluetooth_disconnected",
                "Bluetooth connection was released",
                expectedConnection = connection,
            )
            result.success(disconnectReceipt(deviceId, alreadyClosed = true))
            return
        }

        val context = applicationContext
        if (context == null || bluetoothAdapter(context) == null) {
            result.success(error("hardware_unsupported", "Bluetooth LE is unavailable on this device"))
            return
        }
        if (!hasBluetoothPermissions(context)) {
            result.success(error("hardware_permission_denied", "Bluetooth permission is not granted"))
            return
        }

        lateinit var pendingDisconnect: PendingBleDisconnect
        val timeout = Runnable {
            if (pendingDisconnects.remove(deviceId, pendingDisconnect)) {
                connection.close()
                mainHandler.post {
                    result.success(error("hardware_timeout", "Bluetooth disconnect was not confirmed"))
                }
            }
        }
        pendingDisconnect = PendingBleDisconnect(ownerSessionId, connection, result, timeout)
        if (pendingDisconnects.putIfAbsent(deviceId, pendingDisconnect) != null) {
            result.success(error("hardware_busy", "Bluetooth disconnect is already pending"))
            return
        }
        mainHandler.postDelayed(timeout, 12_000L)
        if (!connection.requestDisconnect() && pendingDisconnects.remove(deviceId, pendingDisconnect)) {
            mainHandler.removeCallbacks(timeout)
            connection.close()
            result.success(error("hardware_bluetooth_disconnect", "Bluetooth disconnect could not be started"))
        }
    }

    private fun isPendingConnection(deviceId: String, generation: Long): Boolean = synchronized(bluetoothLock) {
        pendingConnections.containsKey(deviceId) && pendingConnectionGenerations[deviceId] == generation
    }

    private fun pendingConnectionSnapshot(
        deviceId: String,
        generation: Long,
        gatt: BluetoothGatt,
    ): PendingConnectionSnapshot? = synchronized(bluetoothLock) {
        if (pendingConnections[deviceId] == null || pendingConnectionGenerations[deviceId] != generation) {
            return null
        }
        val pendingGatt = pendingGatts[deviceId]
        if (pendingGatt != null && pendingGatt !== gatt) return null
        PendingConnectionSnapshot(pendingConnectionOwners[deviceId]?.takeIf { it.isNotEmpty() })
    }

    private fun activatePendingConnection(
        deviceId: String,
        generation: Long,
        gatt: BluetoothGatt,
        connection: PocketGattConnection,
    ): Boolean = synchronized(bluetoothLock) {
        if (pendingConnections[deviceId] == null || pendingConnectionGenerations[deviceId] != generation) {
            return false
        }
        val pendingGatt = pendingGatts[deviceId]
        if (pendingGatt != null && pendingGatt !== gatt) return false
        pendingGatts.remove(deviceId, gatt)
        activeGattConnections[deviceId] = connection
        true
    }

    private fun clearPendingConnection(deviceId: String, generation: Long): Boolean {
        val timeout = synchronized(bluetoothLock) {
            if (pendingConnectionGenerations[deviceId] != generation) return false
            pendingConnections.remove(deviceId)
            pendingConnectionOwners.remove(deviceId)
            pendingConnectionGenerations.remove(deviceId)
            connectionTimeouts.remove(deviceId)
        }
        timeout?.let(mainHandler::removeCallbacks)
        return true
    }

    private fun installConnectionTimeout(
        deviceId: String,
        generation: Long,
        timeout: Runnable,
    ): Boolean = synchronized(bluetoothLock) {
        if (!isPendingConnection(deviceId, generation)) return false
        connectionTimeouts[deviceId] = timeout
        true
    }

    private fun registerPendingGatt(deviceId: String, generation: Long, gatt: BluetoothGatt): Boolean {
        if (activeGattConnections[deviceId]?.ownsGatt(gatt) == true) return true
        val accepted = synchronized(bluetoothLock) {
            if (!isPendingConnection(deviceId, generation)) {
                false
            } else {
                pendingGatts[deviceId] = gatt
                true
            }
        }
        if (accepted) return true
        try { gatt.close() } catch (_: Exception) { }
        return false
    }

    private fun finishConnection(
        deviceId: String,
        value: Map<String, Any?>,
        generation: Long? = null,
    ): Boolean {
        var callback: MethodChannel.Result? = null
        var pendingGatt: BluetoothGatt? = null
        var timeout: Runnable? = null
        synchronized(bluetoothLock) {
            if (generation != null && pendingConnectionGenerations[deviceId] != generation) return false
            callback = pendingConnections.remove(deviceId)
            if (callback == null) return false
            pendingGatt = pendingGatts.remove(deviceId)
            pendingConnectionOwners.remove(deviceId)
            pendingConnectionGenerations.remove(deviceId)
            timeout = connectionTimeouts.remove(deviceId)
        }
        timeout?.let(mainHandler::removeCallbacks)
        if (value["ok"] != true) {
            try {
                pendingGatt?.close()
            } catch (_: Exception) {
                // The adapter may already have closed the GATT instance.
            }
        }
        val callbackValue = callback ?: return false
        mainHandler.post { callbackValue.success(value) }
        return true
    }

    private data class BleIdentity(
        val sessionId: String,
        val deviceId: String,
        val serviceUuid: String,
        val characteristicUuid: String,
    )

    private data class PendingConnectionSnapshot(val ownerSessionId: String?)

    private data class PendingConnectCancellation(
        val callback: MethodChannel.Result,
        val gatt: BluetoothGatt?,
        val timeout: Runnable?,
    )

    private data class DisconnectSnapshot(
        val connection: PocketGattConnection?,
        val ownerMismatch: Boolean,
        val pendingConnectCancellation: PendingConnectCancellation?,
    )

    private fun parseBleIdentity(
        args: Map<String, Any?>,
        requireSession: Boolean = true,
    ): BleIdentity? {
        val sessionId = normalizeSessionId(args["sessionId"])
        val deviceId = args["deviceId"] as? String
        val serviceUuid = args["serviceUuid"] as? String
        val characteristicUuid = args["characteristicUuid"] as? String
        if (requireSession && sessionId == null) return null
        if (deviceId.isNullOrBlank() || serviceUuid.isNullOrBlank() || characteristicUuid.isNullOrBlank()) {
            return null
        }
        try {
            UUID.fromString(serviceUuid)
            UUID.fromString(characteristicUuid)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return BleIdentity(
            sessionId = sessionId ?: "",
            deviceId = deviceId,
            serviceUuid = serviceUuid.lowercase(Locale.US),
            characteristicUuid = characteristicUuid.lowercase(Locale.US),
        )
    }

    private fun connectionFor(
        identity: BleIdentity,
        result: MethodChannel.Result,
    ): PocketGattConnection? {
        val connection = activeGattConnections[identity.deviceId]
        if (connection == null) {
            result.success(error("hardware_not_ready", "Bluetooth device is not connected"))
            return null
        }
        if (!connection.ownerMatches(identity.sessionId)) {
            result.success(error("hardware_owner_mismatch", "Bluetooth device is owned by another session"))
            return null
        }
        return connection
    }

    private fun readBleCharacteristic(args: Map<String, Any?>, result: MethodChannel.Result) {
        val identity = parseBleIdentity(args)
        if (identity == null) {
            result.success(error("invalid_argument", "sessionId, deviceId, serviceUuid and characteristicUuid are required and must be valid"))
            return
        }
        val connection = connectionFor(identity, result) ?: return
        if (!connection.canRead(identity.serviceUuid, identity.characteristicUuid)) {
            result.success(error("hardware_bluetooth_characteristic", "Bluetooth characteristic is not readable"))
            return
        }
        connection.enqueueRead(identity.serviceUuid, identity.characteristicUuid) { operation ->
            when (operation) {
                is PocketGattConnection.OperationResult.Success -> result.success(
                    ok(
                        "realBle" to true,
                        "device" to identity.deviceId,
                        "deviceId" to identity.deviceId,
                        "serviceUuid" to identity.serviceUuid,
                        "characteristicUuid" to identity.characteristicUuid,
                        "value" to (operation.value ?: ByteArray(0)).unsignedBytes(),
                        "bytesRead" to (operation.value ?: ByteArray(0)).size,
                    ),
                )
                is PocketGattConnection.OperationResult.Failure -> result.success(
                    error(operation.code, operation.message),
                )
            }
        }
    }

    private fun writeBleCharacteristic(args: Map<String, Any?>, result: MethodChannel.Result) {
        val identity = parseBleIdentity(args)
        if (identity == null) {
            result.success(error("invalid_argument", "sessionId, deviceId, serviceUuid and characteristicUuid are required and must be valid"))
            return
        }
        val rawValue = args["value"]
        val bytes = when (rawValue) {
            is List<*> -> {
                val converted = ByteArray(rawValue.size)
                rawValue.forEachIndexed { index, value ->
                    val number = value as? Number
                    if (number == null || number.toDouble() != number.toInt().toDouble() || number.toInt() !in 0..255) {
                        result.success(error("invalid_argument", "value must contain only integers from 0 to 255"))
                        return
                    }
                    converted[index] = number.toInt().toByte()
                }
                converted
            }
            else -> {
                result.success(error("invalid_argument", "value must be an array of bytes"))
                return
            }
        }
        if (bytes.size > 512) {
            result.success(error("invalid_argument", "value must not exceed 512 bytes"))
            return
        }
        val withResponse = when (val raw = args["withResponse"]) {
            null -> true
            is Boolean -> raw
            else -> {
                result.success(error("invalid_argument", "withResponse must be a boolean"))
                return
            }
        }
        val connection = connectionFor(identity, result) ?: return
        if (!connection.canWrite(identity.serviceUuid, identity.characteristicUuid, withResponse)) {
            result.success(
                error(
                    "hardware_bluetooth_characteristic",
                    if (withResponse) "Bluetooth characteristic does not support writes" else "Bluetooth characteristic does not support no-response writes",
                ),
            )
            return
        }
        connection.enqueueWrite(
            identity.serviceUuid,
            identity.characteristicUuid,
            bytes,
            withResponse,
        ) { operation ->
            when (operation) {
                is PocketGattConnection.OperationResult.Success -> result.success(
                    ok(
                        "realBle" to true,
                        "device" to identity.deviceId,
                        "deviceId" to identity.deviceId,
                        "serviceUuid" to identity.serviceUuid,
                        "characteristicUuid" to identity.characteristicUuid,
                        "written" to true,
                        "bytesWritten" to bytes.size,
                        "withResponse" to withResponse,
                    ),
                )
                is PocketGattConnection.OperationResult.Failure -> result.success(
                    error(operation.code, operation.message),
                )
            }
        }
    }

    private fun startBleNotificationStream(
        args: Map<String, Any?>,
        streamId: String,
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        val identity = parseBleIdentity(args) ?: run {
            result.success(error("invalid_argument", "sessionId, deviceId, serviceUuid and characteristicUuid are required and must be valid"))
            return
        }
        if (identity.sessionId != sessionId) {
            result.success(error("invalid_argument", "sessionId is inconsistent"))
            return
        }
        if (notificationStreams.containsKey(streamId)) {
            result.success(error("hardware_busy", "streamId is already active"))
            return
        }
        val connection = connectionFor(identity, result) ?: return
        val enableValue = connection.notificationEnableValue(identity.serviceUuid, identity.characteristicUuid)
        if (enableValue == null) {
            result.success(error("hardware_bluetooth_characteristic", "Bluetooth characteristic does not support notifications or indications"))
            return
        }
        val key = NotificationKey(identity.deviceId, identity.serviceUuid, identity.characteristicUuid)
        val previousState = notificationStates[key]
        if (previousState != null && previousState.connection !== connection) {
            failNotificationState(
                previousState,
                "hardware_bluetooth_disconnected",
                "Bluetooth connection was replaced",
            )
        }
        val state = notificationStates[key] ?: NotificationState(key, connection, enableValue).also {
            notificationStates[key] = it
        }
        val stream = NotificationStream(streamId, sessionId, key, connection)
        notificationStreams[streamId] = stream
        state.disableRequested = false
        state.streamIds[streamId] = result
        if (state.configured && !state.disableQueued) {
            state.streamIds[streamId] = null
            result.success(ok("streamId" to streamId, "kind" to "ble.notifications", "started" to true, "realHardware" to true))
            return
        }
        if (!state.enableQueued) {
            state.enableQueued = true
            connection.enqueueDescriptorWrite(
                identity.serviceUuid,
                identity.characteristicUuid,
                enableValue,
                enable = true,
            ) { operation ->
                finishNotificationConfiguration(state, enabling = true, operation = operation)
            }
        }
    }

    private fun finishNotificationConfiguration(
        state: NotificationState,
        enabling: Boolean,
        operation: PocketGattConnection.OperationResult,
    ) {
        // A stopped/disposed stream may have been replaced with a new stream
        // using the same id before this native callback reaches the main
        // handler.  A stale state callback must not touch that replacement.
        if (notificationStates[state.key] !== state) return
        if (enabling) state.enableQueued = false else state.disableQueued = false
        val success = operation is PocketGattConnection.OperationResult.Success
        if (!success) {
            val failure = operation as PocketGattConnection.OperationResult.Failure
            failNotificationState(state, failure.code, failure.message)
            return
        }
        if (enabling) {
            state.configured = true
            val streamIds = state.streamIds.keys.toList()
            streamIds.forEach { streamId ->
                val pending = state.streamIds[streamId]
                if (pending != null) {
                    state.streamIds[streamId] = null
                    pending.success(ok("streamId" to streamId, "kind" to "ble.notifications", "started" to true, "realHardware" to true))
                }
            }
            if (state.disableRequested || state.streamIds.isEmpty()) {
                requestNotificationDisable(state)
            }
        } else {
            state.configured = false
            if (state.streamIds.isEmpty()) {
                notificationStates.remove(state.key, state)
            } else if (!state.enableQueued) {
                state.disableRequested = false
                state.enableQueued = true
                state.connection.enqueueDescriptorWrite(
                    state.key.serviceUuid,
                    state.key.characteristicUuid,
                    state.enableValue,
                    enable = true,
                ) { next ->
                    finishNotificationConfiguration(state, enabling = true, operation = next)
                }
            }
        }
    }

    private fun failNotificationState(state: NotificationState, code: String, message: String) {
        if (notificationStates[state.key] !== state) return
        state.enableQueued = false
        state.disableQueued = false
        state.disableRequested = false
        val streamIds = state.streamIds.keys.toList()
        streamIds.forEach { streamId ->
            val pending = state.streamIds.remove(streamId)
            pending?.success(error(code, message))
            notificationStreams.remove(streamId)
            emitStreamErrorAndDone(streamId, code, message)
        }
        notificationStates.remove(state.key, state)
    }

    private fun requestNotificationDisable(state: NotificationState) {
        if (state.streamIds.isNotEmpty()) return
        state.disableRequested = true
        if (state.enableQueued || state.disableQueued) return
        if (!state.configured) {
            notificationStates.remove(state.key, state)
            state.disableRequested = false
            return
        }
        enqueueNotificationDisable(state)
    }

    private fun enqueueNotificationDisable(state: NotificationState) {
        if (state.disableQueued) return
        if (state.enableQueued) {
            state.disableRequested = true
            return
        }
        if (!state.configured) {
            notificationStates.remove(state.key, state)
            state.disableRequested = false
            return
        }
        state.disableRequested = true
        state.disableQueued = true
        state.connection.enqueueDescriptorWrite(
            state.key.serviceUuid,
            state.key.characteristicUuid,
            BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE,
            enable = false,
        ) { operation ->
            finishNotificationConfiguration(state, enabling = false, operation = operation)
        }
    }

    private fun handleBleNotification(
        deviceId: String,
        serviceUuid: String,
        characteristicUuid: String,
        value: ByteArray,
    ) {
        val key = NotificationKey(
            deviceId,
            serviceUuid.lowercase(Locale.US),
            characteristicUuid.lowercase(Locale.US),
        )
        val state = notificationStates[key] ?: return
        state.streamIds.keys.toList().forEach { streamId ->
            emitHardwareEvent(
                mapOf(
                    "streamId" to streamId,
                    "data" to mapOf(
                        "realBle" to true,
                        "deviceId" to deviceId,
                        "serviceUuid" to key.serviceUuid,
                        "characteristicUuid" to key.characteristicUuid,
                        "value" to value.unsignedBytes(),
                        "timestampMs" to System.currentTimeMillis(),
                    ),
                ),
            )
        }
    }

    private fun stopBleNotificationStream(
        streamId: String,
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        val stream = notificationStreams[streamId]
        if (stream == null) {
            result.success(ok("streamId" to streamId, "stopped" to false))
            return
        }
        if (stream.sessionId != sessionId) {
            result.success(error("hardware_owner_mismatch", "stream is owned by another session"))
            return
        }
        notificationStreams.remove(streamId)
        val state = notificationStates[stream.key]
        val pendingStart = state?.streamIds?.remove(streamId)
        pendingStart?.success(error("hardware_cancelled", "hardware stream was stopped before it started"))
        emitStreamDone(streamId)
        if (state != null && state.streamIds.isEmpty()) {
            requestNotificationDisable(state)
        }
        result.success(ok("streamId" to streamId, "stopped" to true))
    }

    private fun handleGattDisconnected(
        deviceId: String,
        code: String = "hardware_bluetooth_disconnected",
        message: String,
        expectedGatt: BluetoothGatt? = null,
        expectedConnection: PocketGattConnection? = null,
    ) {
        val active = activeGattConnections[deviceId]
        val matchesActive = when {
            expectedConnection != null -> active === expectedConnection
            expectedGatt != null -> active?.ownsGatt(expectedGatt) == true
            else -> true
        }
        if (matchesActive) {
            if (active != null) {
                activeGattConnections.remove(deviceId, active)
            } else {
                activeGattConnections.remove(deviceId)
            }
        }
        val states = notificationStates.values.filter { state ->
            state.key.deviceId == deviceId &&
                when {
                    expectedConnection != null -> state.connection === expectedConnection
                    expectedGatt != null -> state.connection.ownsGatt(expectedGatt)
                    else -> true
                }
        }.toList()
        states.forEach { state ->
            failNotificationState(state, code, message)
        }
        notificationStreams.values
            .filter { stream ->
                stream.key.deviceId == deviceId &&
                    when {
                        expectedConnection != null -> stream.connection === expectedConnection
                        expectedGatt != null -> stream.connection.ownsGatt(expectedGatt)
                        else -> true
                    }
            }
            .toList()
            .forEach { stream ->
                if (notificationStreams.remove(stream.streamId, stream)) {
                    emitStreamErrorAndDone(stream.streamId, code, message)
                }
            }
    }

    /** Only the Android GATT state callback can confirm the native link closed. */
    private fun confirmGattDisconnect(
        deviceId: String,
        connection: PocketGattConnection,
        gatt: BluetoothGatt,
    ) {
        val disconnect = pendingDisconnects[deviceId] ?: return
        if (disconnect.connection !== connection ||
            disconnect.ownerSessionId != connection.ownerSessionId ||
            !connection.ownsGatt(gatt) ||
            !pendingDisconnects.remove(deviceId, disconnect)) {
            return
        }
        mainHandler.removeCallbacks(disconnect.timeout)
        mainHandler.post {
            disconnect.result.success(
                disconnectReceipt(deviceId, disconnected = true, closeConfirmed = true),
            )
        }
    }

    // endregion

    private fun disposeSession(args: Map<String, Any?>, result: MethodChannel.Result) {
        val ownerSessionId = normalizeSessionId(args["sessionId"])
        cancelBluetoothOperations(
            "hardware session disposed",
            ownerSessionId = ownerSessionId,
            includeAll = false,
        )
        if (ownerSessionId == null) {
            result.success(ok("disposed" to true))
        } else {
            result.success(ok("disposed" to true, "sessionId" to ownerSessionId))
        }
    }

    private fun disposeNativeResources(reason: String) {
        cancelBluetoothOperations(reason, ownerSessionId = null, includeAll = true)
    }

    private fun cancelBluetoothOperations(
        reason: String,
        ownerSessionId: String?,
        includeAll: Boolean,
    ) {
        pendingDisconnects.entries.toList().forEach { (deviceId, disconnect) ->
            if (includeAll || disconnect.ownerSessionId == ownerSessionId) {
                if (pendingDisconnects.remove(deviceId, disconnect)) {
                    mainHandler.removeCallbacks(disconnect.timeout)
                    mainHandler.post {
                        disconnect.result.success(error("plugin_revoked", reason))
                    }
                }
            }
        }
        if (includeAll) {
            completeBleScan(error("plugin_revoked", reason))
        } else {
            completeBleScanForOwner(error("plugin_revoked", reason), ownerSessionId)
        }
        val pending = synchronized(bluetoothLock) {
            pendingConnections.keys.toList().map { deviceId ->
                Triple(
                    deviceId,
                    pendingConnectionOwners[deviceId]?.takeIf { it.isNotEmpty() },
                    pendingConnectionGenerations[deviceId],
                )
            }
        }
        pending.forEach { (deviceId, owner, generation) ->
            if (generation != null && (includeAll || owner == ownerSessionId)) {
                val completed = finishConnection(
                    deviceId,
                    error("plugin_revoked", reason),
                    generation,
                )
                if (completed) {
                    try { pendingGatts.remove(deviceId)?.close() } catch (_: Exception) { }
                }
            }
        }
        activeGattConnections.entries.toList().forEach { (deviceId, connection) ->
            if (includeAll || connection.ownerSessionId == ownerSessionId) {
                connection.close()
                activeGattConnections.remove(deviceId, connection)
            }
        }
        notificationStreams.values.toList().forEach { stream ->
            if (includeAll || stream.sessionId == ownerSessionId) {
                notificationStreams.remove(stream.streamId, stream)
                val state = notificationStates[stream.key]
                val pendingStart = state?.streamIds?.remove(stream.streamId)
                pendingStart?.success(error("plugin_revoked", reason))
                emitStreamErrorAndDone(stream.streamId, "plugin_revoked", reason)
                if (state != null && state.streamIds.isEmpty()) {
                    requestNotificationDisable(state)
                }
            }
        }
        if (includeAll) {
            pendingGatts.values.toList().forEach { gatt ->
                try { gatt.close() } catch (_: Exception) { }
            }
            pendingGatts.clear()
            pendingConnectionOwners.clear()
            pendingConnectionGenerations.clear()
            notificationStates.clear()
            notificationStreams.clear()
        }
    }

    private fun bluetoothAdapter(context: Context): BluetoothAdapter? {
        if (bluetoothAdapter != null) return bluetoothAdapter
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager ?: return null
        return try {
            manager.adapter.also { bluetoothAdapter = it }
        } catch (_: SecurityException) {
            null
        }
    }

    private fun normalizeSessionId(value: Any?): String? =
        (value as? String)?.trim()?.takeIf { it.isNotEmpty() }

    private fun ByteArray.unsignedBytes(): List<Int> = map { it.toInt() and 0xFF }

    private fun emitHardwareEvent(event: Map<String, Any?>) {
        val sink = synchronized(eventLock) {
            val current = eventSink
            if (current == null) {
                while (queuedEvents.size >= MAX_QUEUED_EVENTS) queuedEvents.removeFirst()
                queuedEvents.addLast(event)
            }
            current
        }
        if (sink != null) {
            mainHandler.post {
                val stillCurrent = synchronized(eventLock) { eventSink === sink }
                if (stillCurrent) sink.success(event)
            }
        }
    }

    private fun emitStreamDone(streamId: String) {
        clearQueuedEvents(streamId)
        emitHardwareEvent(mapOf("streamId" to streamId, "done" to true))
    }

    private fun emitStreamErrorAndDone(streamId: String, code: String, message: String) {
        clearQueuedEvents(streamId)
        emitHardwareEvent(
            mapOf(
                "streamId" to streamId,
                "error" to mapOf("code" to code, "message" to message),
            ),
        )
        emitHardwareEvent(mapOf("streamId" to streamId, "done" to true))
    }

    private fun clearQueuedEvents(streamId: String) {
        synchronized(eventLock) {
            val iterator = queuedEvents.iterator()
            while (iterator.hasNext()) {
                if (iterator.next()["streamId"] == streamId) iterator.remove()
            }
        }
    }

    private fun ok(vararg values: Pair<String, Any?>): Map<String, Any?> {
        val result = LinkedHashMap<String, Any?>()
        result["ok"] = true
        values.forEach { result[it.first] = it.second }
        return result
    }

    private fun disconnectReceipt(
        deviceId: String,
        disconnected: Boolean = false,
        closeConfirmed: Boolean = false,
        alreadyClosed: Boolean = false,
        pendingConnectCancelled: Boolean = false,
    ): Map<String, Any?> = ok(
        "realBle" to true,
        "deviceId" to deviceId,
        "disconnected" to disconnected,
        "closeConfirmed" to closeConfirmed,
        "alreadyClosed" to alreadyClosed,
        "pendingConnectCancelled" to pendingConnectCancelled,
    )

    private fun error(code: String, message: String): Map<String, Any?> = linkedMapOf(
        "ok" to false,
        "errorCode" to code,
        "error" to message,
        "errorMessage" to message,
    )

    private fun Any?.asStringMap(): Map<String, Any?> {
        val source = this as? Map<*, *> ?: return emptyMap()
        return source.entries.associate { (key, value) -> key.toString() to value }
    }

    // endregion
}

internal fun isNativeBleDisconnectConfirmation(newState: Int): Boolean =
    newState == BluetoothProfile.STATE_DISCONNECTED
