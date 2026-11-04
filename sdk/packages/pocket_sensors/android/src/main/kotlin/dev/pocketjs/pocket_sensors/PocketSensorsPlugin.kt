package dev.pocketjs.pocket_sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.LinkedHashMap
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * A monotonic, bounded sampler used by the real SensorEventListener path.
 * The policy is deliberately independent from Android's event ordering: each
 * stream owns its own emission deadline and a stream packet is a snapshot of
 * all sensor classes it requested.
 */
internal object PocketSensorSamplingPolicy {
    fun periodNs(hz: Int): Long = 1_000_000_000L / hz.coerceIn(1, 60)

    fun isDue(nowNs: Long, lastEmissionNs: Long, periodNs: Long): Boolean =
        lastEmissionNs == 0L || (nowNs >= lastEmissionNs && nowNs - lastEmissionNs >= periodNs)

    fun maxHz(values: Iterable<Int>): Int = values.maxOrNull() ?: 10
}

internal data class PocketSensorSample(
    val timestampNs: Long,
    val values: List<Double>,
)

/** Retains one bounded latest value per Android sensor class. */
internal class PocketSensorSnapshot {
    private val latest = LinkedHashMap<Int, PocketSensorSample>()

    fun update(type: Int, timestampNs: Long, values: List<Double>) {
        latest[type] = PocketSensorSample(timestampNs, values.toList())
    }

    fun forTypes(types: Set<Int>): Map<Int, PocketSensorSample> =
        latest.filterKeys { it in types }

    fun clear() {
        latest.clear()
    }
}

/** Android SensorManager transport for the independent sensors capability. */
@Suppress("UNUSED_PARAMETER", "MemberVisibilityCanBePrivate")
class PocketSensorsPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware/sensors"
        private const val EVENTS_CHANNEL_NAME = "com.pocketnexus.host/hardware/sensors/events"
        private const val MAX_QUEUED_EVENTS = 128
        private const val SENSOR_DEFAULT_HZ = 10
        private const val SENSOR_MIN_HZ = 1
        private const val SENSOR_MAX_HZ = 60
    }

    private var applicationContext: Context? = null
    private var channel: MethodChannel? = null
    private var eventsChannel: EventChannel? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val eventLock = Any()
    private var eventSink: EventChannel.EventSink? = null
    private val queuedEvents = ArrayDeque<Map<String, Any?>>()

    private var pendingSensorResult: MethodChannel.Result? = null
    private var pendingSensorOwnerSessionId: String? = null
    private var pendingSensorGeneration: Long? = null
    private var sensorGeneration = 0L
    private var sensorTimeout: Runnable? = null
    private val sensorValues = LinkedHashMap<String, Any>()
    private val latestSensorSnapshot = PocketSensorSnapshot()
    private var pendingSensorTypes: Set<Int> = emptySet()
    private var sensorManager: SensorManager? = null
    private var sensorListenerRegistered = false
    private val registeredSensorTypes = LinkedHashSet<Int>()
    private var registeredSensorPeriodNs = 0L

    private data class SensorStream(
        val streamId: String,
        val sessionId: String,
        val sensorTypes: Set<Int>,
        val samplingPeriodNs: Long,
        var lastEmissionNs: Long = 0L,
    )

    private val sensorStreams = ConcurrentHashMap<String, SensorStream>()

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
            "readSensors" -> readSensors(args, result)
            "startHardwareStream" -> startHardwareStream(args, result)
            "stopHardwareStream" -> stopHardwareStream(args, result)
            "disposeSession" -> disposeSession(args, result)
            else -> result.success(error("hardware_unsupported", "unknown sensor method: ${call.method}"))
        }
    }

    // region Sensors

    private fun supportedSensors(context: Context): Boolean {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return false
        return defaultSensorTypes().any { manager.getDefaultSensor(it) != null }
    }

    private fun defaultSensorTypes(): Set<Int> = linkedSetOf(
            Sensor.TYPE_ACCELEROMETER,
            Sensor.TYPE_LINEAR_ACCELERATION,
            Sensor.TYPE_GYROSCOPE,
            Sensor.TYPE_ROTATION_VECTOR,
            Sensor.TYPE_PRESSURE,
            Sensor.TYPE_MAGNETIC_FIELD,
        )

    private fun activeSensorTypes(includePendingRead: Boolean = true): Set<Int> {
        val types = LinkedHashSet<Int>()
        sensorStreams.values.forEach { types.addAll(it.sensorTypes) }
        if (includePendingRead && pendingSensorResult != null) {
            types.addAll(pendingSensorTypes.ifEmpty { defaultSensorTypes() })
        }
        return types
    }

    private fun activeSensorPeriodNs(additionalHz: Int? = null): Long {
        val streamHz = sensorStreams.values.map { period ->
            (1_000_000_000L / period.samplingPeriodNs).toInt()
        }
        val pendingReadHz = if (pendingSensorResult != null) SENSOR_DEFAULT_HZ else null
        return PocketSensorSamplingPolicy.periodNs(
            PocketSensorSamplingPolicy.maxHz(streamHz + listOfNotNull(pendingReadHz, additionalHz)),
        )
    }

    private fun reconfigureSensorListenersIfNeeded() {
        val manager = sensorManager ?: return
        val types = activeSensorTypes()
        if (types.isEmpty()) {
            unregisterSensorListenersIfIdle()
            return
        }
        val configured = ensureSensorListeners(manager, types, activeSensorPeriodNs())
        if (!configured) failActiveSensorStreamsIfUnregistered()
    }

    private fun failActiveSensorStreams(code: String, message: String) {
        sensorStreams.values.toList().forEach { stream ->
            if (sensorStreams.remove(stream.streamId, stream)) {
                emitStreamErrorAndDone(stream.streamId, code, message)
            }
        }
        unregisterSensorListenersIfIdle()
    }

    private fun failActiveSensorStreamsIfUnregistered() {
        if (!sensorListenerRegistered && sensorStreams.isNotEmpty()) {
            failActiveSensorStreams(
                code = "hardware_sensor_error",
                message = "sensor listeners could not be reconfigured",
            )
        }
    }

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val values = event.values.map(Float::toDouble)
            val timestampNs = if (event.timestamp > 0L) event.timestamp else System.nanoTime()
            latestSensorSnapshot.update(event.sensor.type, timestampNs, values)
            if (pendingSensorResult != null) {
                when (event.sensor.type) {
                    Sensor.TYPE_ACCELEROMETER -> {
                        sensorValues["gravityX"] = values[0]
                        sensorValues["gravityY"] = values[1]
                        sensorValues["gravityZ"] = values[2]
                    }
                    Sensor.TYPE_LINEAR_ACCELERATION -> {
                        sensorValues["accelX"] = values[0]
                        sensorValues["accelY"] = values[1]
                        sensorValues["accelZ"] = values[2]
                    }
                    Sensor.TYPE_GYROSCOPE -> {
                        sensorValues["gyroX"] = values[0]
                        sensorValues["gyroY"] = values[1]
                        sensorValues["gyroZ"] = values[2]
                    }
                    Sensor.TYPE_PRESSURE -> sensorValues["pressureHpa"] = values[0]
                    Sensor.TYPE_ROTATION_VECTOR -> {
                        val matrix = FloatArray(9)
                        val orientation = FloatArray(3)
                        SensorManager.getRotationMatrixFromVector(matrix, event.values)
                        SensorManager.getOrientation(matrix, orientation)
                        sensorValues["yaw"] = orientation[0].toDouble()
                        sensorValues["pitch"] = orientation[1].toDouble()
                        sensorValues["roll"] = orientation[2].toDouble()
                    }
                    Sensor.TYPE_MAGNETIC_FIELD -> {
                        sensorValues["magneticX"] = values.getOrNull(0) ?: 0.0
                        sensorValues["magneticY"] = values.getOrNull(1) ?: 0.0
                        sensorValues["magneticZ"] = values.getOrNull(2) ?: 0.0
                    }
                }
            }
            val eligibleStreams = sensorStreams.values.toList().filter { stream ->
                if (event.sensor.type !in stream.sensorTypes) return@filter false
                if (!PocketSensorSamplingPolicy.isDue(
                        timestampNs,
                        stream.lastEmissionNs,
                        stream.samplingPeriodNs,
                    )
                ) {
                    return@filter false
                }
                stream.lastEmissionNs = timestampNs
                true
            }
            if (eligibleStreams.isEmpty()) return
            eligibleStreams.forEach { stream ->
                val data = sensorSnapshotData(
                    latestSensorSnapshot.forTypes(stream.sensorTypes),
                    event.sensor.type,
                    values,
                    timestampNs,
                )
                emitHardwareEvent(
                    mapOf(
                        "streamId" to stream.streamId,
                        "data" to data,
                    ),
                )
            }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    private fun sensorSnapshotData(
        samples: Map<Int, PocketSensorSample>,
        currentType: Int,
        currentValues: List<Double>,
        timestampNs: Long,
    ): LinkedHashMap<String, Any?> {
        val data = linkedMapOf<String, Any?>(
            "realSensors" to true,
            // Keep the current event identity for existing consumers while the
            // remaining fields below make this a bounded merged snapshot.
            "sensor" to sensorName(currentType),
            "sensorType" to currentType,
            "values" to currentValues,
            "timestampNs" to timestampNs,
            "timestamp" to formatTimestamp(System.currentTimeMillis()),
        )
        if (currentValues.size >= 3) {
            data["x"] = currentValues[0]
            data["y"] = currentValues[1]
            data["z"] = currentValues[2]
        }
        samples.forEach { (type, sample) ->
            val values = sample.values
            when (type) {
                Sensor.TYPE_ACCELEROMETER -> {
                    data["gravityX"] = values.getOrNull(0) ?: 0.0
                    data["gravityY"] = values.getOrNull(1) ?: 0.0
                    data["gravityZ"] = values.getOrNull(2) ?: 0.0
                }
                Sensor.TYPE_LINEAR_ACCELERATION -> {
                    data["accelX"] = values.getOrNull(0) ?: 0.0
                    data["accelY"] = values.getOrNull(1) ?: 0.0
                    data["accelZ"] = values.getOrNull(2) ?: 0.0
                }
                Sensor.TYPE_GYROSCOPE -> {
                    data["gyroX"] = values.getOrNull(0) ?: 0.0
                    data["gyroY"] = values.getOrNull(1) ?: 0.0
                    data["gyroZ"] = values.getOrNull(2) ?: 0.0
                }
                Sensor.TYPE_PRESSURE -> data["pressureHpa"] = values.getOrNull(0) ?: 0.0
                Sensor.TYPE_ROTATION_VECTOR -> {
                    val matrix = FloatArray(9)
                    val orientation = FloatArray(3)
                    SensorManager.getRotationMatrixFromVector(
                        matrix,
                        values.map(Double::toFloat).toFloatArray(),
                    )
                    SensorManager.getOrientation(matrix, orientation)
                    data["yaw"] = orientation[0].toDouble()
                    data["pitch"] = orientation[1].toDouble()
                    data["roll"] = orientation[2].toDouble()
                }
                Sensor.TYPE_MAGNETIC_FIELD -> {
                    data["magneticX"] = values.getOrNull(0) ?: 0.0
                    data["magneticY"] = values.getOrNull(1) ?: 0.0
                    data["magneticZ"] = values.getOrNull(2) ?: 0.0
                }
            }
        }
        return data
    }

    private fun ensureSensorListeners(
        manager: SensorManager,
        sensorTypes: Iterable<Int>,
        samplingPeriodNs: Long,
    ): Boolean {
        val targetTypes = sensorTypes.toSet()
        if (targetTypes.isEmpty()) return false
        if (
            sensorListenerRegistered &&
            registeredSensorTypes == targetTypes &&
            registeredSensorPeriodNs == samplingPeriodNs
        ) {
            return true
        }

        // Re-registration is transactional. A vendor may reject one sensor
        // type or period; keep the previous producer alive rather than
        // leaving active stream records with no listener at all.
        val previousTypes = if (sensorListenerRegistered) registeredSensorTypes.toSet() else emptySet()
        val previousPeriodNs = if (sensorListenerRegistered) registeredSensorPeriodNs else 0L
        fun unregisterCurrent() {
            try {
                manager.unregisterListener(sensorListener)
            } catch (_: Exception) {
                // Cleanup is best effort on vendor sensor services.
            }
            registeredSensorTypes.clear()
            sensorListenerRegistered = false
            registeredSensorPeriodNs = 0L
        }
        fun registerTypes(types: Set<Int>, periodNs: Long): Set<Int> {
            val delayUs = (periodNs / 1_000L)
                .coerceAtLeast(1L)
                .coerceAtMost(Int.MAX_VALUE.toLong())
                .toInt()
            return types.mapNotNull { type ->
                val sensor = try {
                    manager.getDefaultSensor(type)
                } catch (_: Exception) {
                    null
                } ?: return@mapNotNull null
                val didRegister = try {
                    manager.registerListener(sensorListener, sensor, delayUs, mainHandler)
                } catch (_: Exception) {
                    false
                }
                if (didRegister) type else null
            }.toSet()
        }
        if (sensorListenerRegistered) {
            unregisterCurrent()
        }
        val registered = registerTypes(targetTypes, samplingPeriodNs)
        if (registered.size != targetTypes.size) {
            unregisterCurrent()
            val restored = if (previousTypes.isNotEmpty()) {
                registerTypes(previousTypes, previousPeriodNs)
            } else {
                emptySet()
            }
            if (restored.size == previousTypes.size && previousTypes.isNotEmpty()) {
                registeredSensorTypes.addAll(restored)
                registeredSensorPeriodNs = previousPeriodNs
                sensorListenerRegistered = true
            } else if (restored.isNotEmpty()) {
                // A partial rollback still leaves callbacks registered in the
                // OS. Fence and unregister that subset before returning.
                unregisterCurrent()
            }
            return false
        }
        registeredSensorTypes.addAll(registered)
        registeredSensorPeriodNs = samplingPeriodNs
        sensorListenerRegistered = true
        return true
    }

    private fun readSensors(args: Map<String, Any?>, result: MethodChannel.Result) {
        if (pendingSensorResult != null) {
            result.success(error("hardware_busy", "sensor request is already pending"))
            return
        }
        val context = applicationContext
        val manager = context?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        if (context == null || manager == null || !supportedSensors(context)) {
            result.success(error("hardware_unsupported", "motion and barometer sensors are unavailable"))
            return
        }
        sensorManager = manager
        sensorValues.clear()
        val sensorTypes = defaultSensorTypes().filter { manager.getDefaultSensor(it) != null }.toSet()
        if (sensorTypes.isEmpty()) {
            result.success(error("hardware_unsupported", "motion and barometer sensors are unavailable"))
            return
        }
        val targetTypes = activeSensorTypes(includePendingRead = false) + sensorTypes
        pendingSensorTypes = sensorTypes
        if (!ensureSensorListeners(manager, targetTypes, activeSensorPeriodNs(additionalHz = SENSOR_DEFAULT_HZ))) {
            pendingSensorTypes = emptySet()
            failActiveSensorStreamsIfUnregistered()
            result.success(error("hardware_unsupported", "sensor listeners could not be registered"))
            return
        }
        val generation = ++sensorGeneration
        pendingSensorResult = result
        pendingSensorOwnerSessionId = normalizeSessionId(args["sessionId"])
        pendingSensorGeneration = generation
        val timeoutMillis = ((args["timeoutMs"] as? Number)?.toLong() ?: 750L)
            .coerceIn(250L, 30_000L)
        val timeout = Runnable { finishSensorRead(generation) }
        sensorTimeout = timeout
        // One frame is enough for the capability and bounds the call on slow
        // or partially virtualized devices.  The values remain real samples.
        mainHandler.postDelayed(timeout, timeoutMillis)
    }

    private fun finishSensorRead(generation: Long? = null) {
        if (generation != null && pendingSensorGeneration != generation) return
        val callback = pendingSensorResult ?: return
        pendingSensorResult = null
        pendingSensorOwnerSessionId = null
        pendingSensorGeneration = null
        pendingSensorTypes = emptySet()
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        if (sensorValues.isEmpty()) {
            callback.success(error("hardware_sensor_timeout", "sensor sample was unavailable"))
            sensorValues.clear()
            reconfigureSensorListenersIfNeeded()
            return
        }
        callback.success(ok("realSensors" to true, *sensorValues.entries.map { it.key to it.value }.toTypedArray()))
        sensorValues.clear()
        reconfigureSensorListenersIfNeeded()
    }

    private fun startHardwareStream(args: Map<String, Any?>, result: MethodChannel.Result) {
        val streamId = args["streamId"] as? String
        val sessionId = normalizeSessionId(args["sessionId"])
        val kind = args["kind"] as? String
        if (streamId.isNullOrBlank() || sessionId == null || kind.isNullOrBlank()) {
            result.success(error("invalid_argument", "kind, streamId and sessionId are required"))
            return
        }
        if (sensorStreams.containsKey(streamId)) {
            result.success(error("hardware_busy", "streamId is already active"))
            return
        }
        // A stream id can be reused by a later guest after the previous
        // stream was stopped while the shared EventChannel had no listener.
        // Drop the old buffered terminal packet before accepting the new id.
        clearQueuedEvents(streamId)
        when (kind) {
            "sensors" -> startSensorStream(args, streamId, sessionId, result)
            else -> result.success(error("invalid_argument", "unsupported hardware stream kind: $kind"))
        }
    }

    private fun stopHardwareStream(args: Map<String, Any?>, result: MethodChannel.Result) {
        val streamId = args["streamId"] as? String
        val sessionId = normalizeSessionId(args["sessionId"])
        if (streamId.isNullOrBlank() || sessionId == null) {
            result.success(error("invalid_argument", "streamId and sessionId are required"))
            return
        }
        val sensorStream = sensorStreams[streamId]
        if (sensorStream != null) {
            if (sensorStream.sessionId != sessionId) {
                result.success(error("hardware_owner_mismatch", "stream is owned by another session"))
                return
            }
            sensorStreams.remove(streamId)
            emitStreamDone(streamId)
            reconfigureSensorListenersIfNeeded()
            result.success(ok("streamId" to streamId, "stopped" to true))
            return
        }
        result.success(ok("streamId" to streamId, "stopped" to false))
    }

    private fun startSensorStream(
        args: Map<String, Any?>,
        streamId: String,
        sessionId: String,
        result: MethodChannel.Result,
    ) {
        val context = applicationContext
        val manager = context?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        if (context == null || manager == null) {
            result.success(error("hardware_not_ready", "Android sensor service is unavailable"))
            return
        }
        val requestedTypes = parseSensorTypes(args)
        if (requestedTypes == null || requestedTypes.isEmpty()) {
            result.success(error("invalid_argument", "sensor or sensors must identify at least one supported sensor"))
            return
        }
        val availableTypes = requestedTypes.filter { manager.getDefaultSensor(it) != null }.toSet()
        if (availableTypes.isEmpty()) {
            result.success(error("hardware_unsupported", "requested sensors are unavailable"))
            return
        }
        val hz = parseSamplingHz(args)
        if (hz == null) {
            result.success(error("invalid_argument", "samplingHz must be an integer between 1 and 60"))
            return
        }
        val targetTypes = activeSensorTypes() + availableTypes
        if (!ensureSensorListeners(manager, targetTypes, activeSensorPeriodNs(additionalHz = hz))) {
            failActiveSensorStreamsIfUnregistered()
            result.success(error("hardware_unsupported", "sensor listeners could not be registered"))
            return
        }
        sensorManager = manager
        sensorStreams[streamId] = SensorStream(
            streamId = streamId,
            sessionId = sessionId,
            sensorTypes = availableTypes,
            samplingPeriodNs = PocketSensorSamplingPolicy.periodNs(hz),
        )
        result.success(
            ok(
                "streamId" to streamId,
                "kind" to "sensors",
                "started" to true,
                "realHardware" to true,
                "samplingHz" to hz,
                "sensors" to availableTypes.map(::sensorName),
            ),
        )
    }

    private fun parseSensorTypes(args: Map<String, Any?>): Set<Int>? {
        val params = args["params"] as? Map<*, *>
        val raw = args["sensors"] ?: args["sensor"] ?: args["sensorType"] ?: params?.get("sensors") ?: params?.get("sensor") ?: params?.get("sensorType")
        val values: List<Any?> = when (raw) {
            null -> listOf("accelerometer", "linearAcceleration", "gyroscope", "rotationVector", "pressure", "magnetometer")
            is String -> listOf(raw)
            is List<*> -> raw
            else -> return null
        }
        val result = LinkedHashSet<Int>()
        values.forEach { value ->
            val name = value as? String ?: return null
            val type = when (name.lowercase(Locale.US)) {
                "accelerometer", "accel" -> Sensor.TYPE_ACCELEROMETER
                "linearacceleration", "linear_acceleration", "linear-acceleration" -> Sensor.TYPE_LINEAR_ACCELERATION
                "gyroscope", "gyro" -> Sensor.TYPE_GYROSCOPE
                "rotationvector", "rotation_vector", "rotation-vector" -> Sensor.TYPE_ROTATION_VECTOR
                "pressure", "barometer" -> Sensor.TYPE_PRESSURE
                "magnetometer", "magneticfield", "magnetic_field", "magnetic-field" -> Sensor.TYPE_MAGNETIC_FIELD
                else -> return null
            }
            result.add(type)
        }
        return result
    }

    private fun parseSamplingHz(args: Map<String, Any?>): Int? {
        val params = args["params"] as? Map<*, *>
        val raw = args["samplingHz"] ?: params?.get("samplingHz")
        if (raw == null) return SENSOR_DEFAULT_HZ
        val number = raw as? Number ?: return null
        val value = number.toDouble()
        if (!value.isFinite() || value % 1.0 != 0.0) return null
        val hz = value.toInt()
        if (hz !in SENSOR_MIN_HZ..SENSOR_MAX_HZ) return null
        return hz
    }

    private fun unregisterSensorListenersIfIdle() {
        if (sensorStreams.isNotEmpty() || pendingSensorResult != null) return
        sensorManager?.let { manager ->
            if (sensorListenerRegistered) {
                try {
                    manager.unregisterListener(sensorListener)
                } catch (_: Exception) {
                    // Cleanup is best effort on vendor sensor services.
                }
            }
        }
        registeredSensorTypes.clear()
        sensorListenerRegistered = false
        registeredSensorPeriodNs = 0L
        latestSensorSnapshot.clear()
    }

    // endregion

    private fun disposeSession(args: Map<String, Any?>, result: MethodChannel.Result) {
        val ownerSessionId = normalizeSessionId(args["sessionId"])
        cancelSensorStreams("hardware session disposed", ownerSessionId, includeAll = ownerSessionId == null)
        finishSensorWithError(
            "hardware session disposed",
            ownerSessionId,
            includeAll = ownerSessionId == null,
        )
        if (ownerSessionId == null) {
            result.success(ok("disposed" to true))
        } else {
            result.success(ok("disposed" to true, "sessionId" to ownerSessionId))
        }
    }

    private fun disposeNativeResources(reason: String) {
        cancelSensorStreams(reason, ownerSessionId = null, includeAll = true)
        finishSensorWithError(reason, ownerSessionId = null, includeAll = true)
    }

    private fun cancelSensorStreams(
        reason: String,
        ownerSessionId: String?,
        includeAll: Boolean,
    ) {
        sensorStreams.values.toList().forEach { stream ->
            if (includeAll || stream.sessionId == ownerSessionId) {
                sensorStreams.remove(stream.streamId, stream)
                emitStreamErrorAndDone(stream.streamId, "plugin_revoked", reason)
            }
        }
        unregisterSensorListenersIfIdle()
    }

    private fun finishSensorWithError(
        reason: String,
        ownerSessionId: String?,
        includeAll: Boolean,
    ) {
        if (!includeAll && pendingSensorOwnerSessionId != ownerSessionId) return
        val callback = pendingSensorResult
        pendingSensorResult = null
        pendingSensorOwnerSessionId = null
        pendingSensorGeneration = null
        pendingSensorTypes = emptySet()
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        unregisterSensorListenersIfIdle()
        sensorValues.clear()
        callback?.success(error("plugin_revoked", reason))
    }

    private fun normalizeSessionId(value: Any?): String? =
        (value as? String)?.trim()?.takeIf { it.isNotEmpty() }

    private fun formatTimestamp(epochMillis: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(epochMillis))

    private fun sensorName(type: Int): String = when (type) {
        Sensor.TYPE_ACCELEROMETER -> "accelerometer"
        Sensor.TYPE_LINEAR_ACCELERATION -> "linearAcceleration"
        Sensor.TYPE_GYROSCOPE -> "gyroscope"
        Sensor.TYPE_ROTATION_VECTOR -> "rotationVector"
        Sensor.TYPE_PRESSURE -> "pressure"
        Sensor.TYPE_MAGNETIC_FIELD -> "magnetometer"
        else -> "sensor:$type"
    }

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
