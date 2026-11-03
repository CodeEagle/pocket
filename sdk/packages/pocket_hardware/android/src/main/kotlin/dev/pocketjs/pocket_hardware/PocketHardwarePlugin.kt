package dev.pocketjs.pocket_hardware

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.biometrics.BiometricPrompt
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
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
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.util.ArrayDeque
import java.text.SimpleDateFormat
import java.util.Date
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor

/**
 * Android half of the compiled-in `flutter.hardware` provider.
 *
 * This class is deliberately a thin transport boundary.  It only reports
 * values obtained from Android APIs and returns a structured error when the
 * corresponding device capability, permission, or lifecycle resource is not
 * available.  It never supplies fixture values in place of a hardware call.
 * Camera/photo work is kept in CameraHardware so the texture pipeline can be
 * optimized independently of this permission and sensor bridge.
 */
@Suppress("DEPRECATION", "UNUSED_PARAMETER", "MemberVisibilityCanBePrivate")
class PocketHardwarePlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    ActivityAware, PluginRegistry.RequestPermissionsResultListener {

    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware"
        private const val EVENTS_CHANNEL_NAME = "com.pocketnexus.host/hardware/events"
        private const val REQUEST_PERMISSION_CODE = 0x504B
        private const val MAX_QUEUED_EVENTS = 128
        private const val SENSOR_DEFAULT_HZ = 10
        private const val SENSOR_MIN_HZ = 1
        private const val SENSOR_MAX_HZ = 60
    }

    private var applicationContext: Context? = null
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var eventsChannel: EventChannel? = null
    private var cameraHardware: CameraHardware? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    private val eventLock = Any()
    private var eventSink: EventChannel.EventSink? = null
    private val queuedEvents = ArrayDeque<Map<String, Any?>>()

    private var pendingPermissionResult: MethodChannel.Result? = null
    private var pendingPermissionName: String? = null
    private var pendingPermissionManifest: List<String> = emptyList()

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
    // ConcurrentHashMap cannot store null; the empty string represents a
    // legacy connection created before owner-scoped calls were introduced.
    private val pendingConnectionOwners = ConcurrentHashMap<String, String>()
    private val pendingConnectionGenerations = ConcurrentHashMap<String, Long>()
    private var connectionGeneration = 0L
    private val pendingConnections = ConcurrentHashMap<String, MethodChannel.Result>()
    private val connectionTimeouts = ConcurrentHashMap<String, Runnable>()

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

    private var pendingSensorResult: MethodChannel.Result? = null
    private var pendingSensorOwnerSessionId: String? = null
    private var pendingSensorGeneration: Long? = null
    private var sensorGeneration = 0L
    private var sensorTimeout: Runnable? = null
    private val sensorValues = LinkedHashMap<String, Any>()
    private var sensorManager: SensorManager? = null
    private var sensorListenerRegistered = false
    private val registeredSensorTypes = LinkedHashSet<Int>()

    private data class SensorStream(
        val streamId: String,
        val sessionId: String,
        val sensorTypes: Set<Int>,
        val samplingPeriodNs: Long,
        var lastEventNs: Long = 0L,
    )

    private val sensorStreams = ConcurrentHashMap<String, SensorStream>()

    private var pendingBiometricResult: MethodChannel.Result? = null
    private var biometricPrompt: BiometricPrompt? = null
    private var biometricCancellation: CancellationSignal? = null

    private var pendingLocationResult: MethodChannel.Result? = null
    private var locationTimeout: Runnable? = null
    private var locationListener: LocationListener? = null
    private var locationProvider: String? = null

    // region Flutter plugin/lifecycle

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel?.setMethodCallHandler(this)
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
                    synchronized(eventLock) {
                        eventSink = null
                    }
                }
            })
        }
        cameraHardware = CameraHardware(binding.applicationContext, binding.textureRegistry)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disposeNativeResources("plugin detached", closeCameraWorker = true)
        channel?.setMethodCallHandler(null)
        channel = null
        eventsChannel?.setStreamHandler(null)
        eventsChannel = null
        synchronized(eventLock) {
            eventSink = null
            queuedEvents.clear()
        }
        cameraHardware = null
        applicationContext = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        activity = binding.activity
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        cancelActivityBoundOperations("activity detached during configuration change")
        activityBinding?.removeRequestPermissionsResultListener(this)
        activityBinding = null
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activityBinding = binding
        activity = binding.activity
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivity() {
        cancelActivityBoundOperations("activity detached")
        activityBinding?.removeRequestPermissionsResultListener(this)
        activityBinding = null
        activity = null
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != REQUEST_PERMISSION_CODE) return false
        val callback = pendingPermissionResult ?: return false
        val name = pendingPermissionName ?: "unknown"
        val requested = pendingPermissionManifest
        pendingPermissionResult = null
        pendingPermissionName = null
        pendingPermissionManifest = emptyList()
        val allGranted = requested.isNotEmpty() && requested.all { checkPermission(it) }
        callback.success(
            if (allGranted) {
                permissionSuccess(name, true)
            } else {
                permissionSuccess(name, false)
            },
        )
        return true
    }

    // endregion

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments.asStringMap()

        // The camera worker owns the Flutter texture and photo files.  It is a
        // typed part of this plugin so camera registration cannot silently
        // disappear from a release build.
        if (isCameraMethod(call.method)) {
            if (delegateCamera(call.method, args, result)) return
            result.success(error("hardware_not_ready", "camera provider is not attached"))
            return
        }

        when (call.method) {
            "checkPermissions" -> result.success(permissionSnapshot())
            "requestPermission" -> requestPermission(args["permission"] as? String, result)
            "disposeSession" -> disposeSession(args, result)
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
            "readBleCharacteristic" -> readBleCharacteristic(args, result)
            "writeBleCharacteristic" -> writeBleCharacteristic(args, result)
            "startHardwareStream" -> startHardwareStream(args, result)
            "stopHardwareStream" -> stopHardwareStream(args, result)
            "readSensors" -> readSensors(args, result)
            "authenticateBiometrics" -> authenticateBiometrics(
                args["reason"] as? String ?: "Authenticate to continue",
                result,
            )
            "getCurrentLocation" -> getCurrentLocation(result)
            else -> result.success(error("hardware_unsupported", "unknown hardware method: ${call.method}"))
        }
    }

    // region Permissions

    private fun permissionSnapshot(): Map<String, Any?> {
        val context = applicationContext
            ?: return error("hardware_not_ready", "Android context is not attached")
        val cameraSupported = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
        val bluetoothSupported = bluetoothAdapter(context) != null
        val sensorsSupported = supportedSensors(context)
        val locationSupported = hasLocationProvider(context)
        val biometric = biometricAvailability(context)
        return ok(
            "permissions" to mapOf(
                "camera" to permissionState(
                    cameraSupported,
                    permissionStatus(listOf(Manifest.permission.CAMERA), cameraSupported),
                    cameraSupported && checkPermission(Manifest.permission.CAMERA),
                ),
                "photos" to permissionState(
                    true,
                    "available",
                    true,
                ),
                "bluetooth" to permissionState(
                    bluetoothSupported,
                    bluetoothPermissionStatus(bluetoothSupported),
                    bluetoothSupported && hasBluetoothPermissions(context),
                ),
                "sensors" to permissionState(
                    sensorsSupported,
                    if (sensorsSupported) "available" else "unavailable",
                    sensorsSupported,
                ),
                "biometrics" to permissionState(
                    biometric == BiometricAvailability.AVAILABLE,
                    if (biometric == BiometricAvailability.AVAILABLE) "available" else "unavailable",
                    biometric == BiometricAvailability.AVAILABLE,
                ),
                "location" to permissionState(
                    locationSupported,
                    permissionStatus(locationPermissions(), locationSupported),
                    locationSupported && hasLocationPermission(context),
                ),
                "microphone" to permissionState(
                    false,
                    "unavailable",
                    false,
                ),
                "network" to permissionState(true, "available", true),
            ),
        )
    }

    private fun requestPermission(permission: String?, result: MethodChannel.Result) {
        if (permission.isNullOrBlank()) {
            result.success(error("invalid_argument", "permission must be a string"))
            return
        }
        val context = applicationContext
        if (context == null) {
            result.success(error("hardware_not_ready", "Android context is not attached"))
            return
        }
        when (permission) {
            "camera" -> requestRuntimePermission(
                permission,
                listOf(Manifest.permission.CAMERA),
                context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
                result,
            )
            // Android stores captures in the app-private files directory, so
            // no READ_MEDIA_* or external-storage permission is needed.
            "photos" -> result.success(permissionSuccess(permission, true))
            "bluetooth" -> requestRuntimePermission(
                permission,
                bluetoothPermissions(),
                bluetoothAdapter(context) != null,
                result,
            )
            "location" -> requestRuntimePermission(
                permission,
                locationPermissions(),
                hasLocationProvider(context),
                result,
            )
            // There is intentionally no Android microphone implementation in
            // this provider; do not request RECORD_AUDIO just to claim support.
            "microphone" -> result.success(error("hardware_unsupported", "microphone capture is unavailable"))
            "sensors" -> {
                if (supportedSensors(context)) result.success(permissionSuccess(permission, true))
                else result.success(error("hardware_unsupported", "motion sensors are unavailable"))
            }
            "biometrics" -> {
                if (biometricAvailability(context) == BiometricAvailability.AVAILABLE) {
                    result.success(permissionSuccess(permission, true))
                } else {
                    result.success(error("hardware_unsupported", "biometric authentication is unavailable"))
                }
            }
            "network" -> result.success(permissionSuccess(permission, true))
            else -> result.success(error("invalid_argument", "unknown hardware permission: $permission"))
        }
    }

    private fun requestRuntimePermission(
        name: String,
        permissions: List<String>,
        supported: Boolean,
        result: MethodChannel.Result,
    ) {
        if (!supported) {
            result.success(error("hardware_unsupported", "$name is unavailable on this device"))
            return
        }
        if (permissions.isEmpty() || permissions.all { checkPermission(it) }) {
            result.success(permissionSuccess(name, true))
            return
        }
        val hostActivity = activity
        if (hostActivity == null) {
            result.success(error("hardware_not_ready", "an attached Activity is required to request $name"))
            return
        }
        if (pendingPermissionResult != null) {
            result.success(error("hardware_busy", "another permission request is already running"))
            return
        }
        pendingPermissionResult = result
        pendingPermissionName = name
        pendingPermissionManifest = permissions
        try {
            hostActivity.requestPermissions(permissions.toTypedArray(), REQUEST_PERMISSION_CODE)
        } catch (security: SecurityException) {
            pendingPermissionResult = null
            pendingPermissionName = null
            pendingPermissionManifest = emptyList()
            result.success(error("hardware_permission_denied", security.message ?: "permission request failed"))
        }
    }

    private fun permissionState(supported: Boolean, status: String, granted: Boolean): Map<String, Any?> =
        mapOf("supported" to supported, "status" to status, "granted" to granted)

    private fun permissionSuccess(permission: String, granted: Boolean): Map<String, Any?> =
        ok(
            "permission" to permission,
            "granted" to granted,
            "status" to if (granted) "granted" else "denied",
            "realHardware" to true,
        )

    private fun permissionStatus(permissions: List<String>, supported: Boolean): String {
        if (!supported) return "unavailable"
        if (permissions.isNotEmpty() && permissions.all { checkPermission(it) }) return "granted"
        val hostActivity = activity
        if (hostActivity != null && permissions.any { hostActivity.shouldShowRequestPermissionRationale(it) }) {
            return "denied"
        }
        return "notDetermined"
    }

    private fun bluetoothPermissionStatus(supported: Boolean): String =
        if (!supported) "unavailable" else permissionStatus(bluetoothPermissions(), true)

    private fun bluetoothPermissions(): List<String> = if (Build.VERSION.SDK_INT >= 31) {
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else if (Build.VERSION.SDK_INT >= 23) {
        listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    } else {
        emptyList()
    }

    private fun locationPermissions(): List<String> = if (Build.VERSION.SDK_INT >= 23) {
        listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    } else {
        emptyList()
    }

    private fun hasBluetoothPermissions(context: Context): Boolean =
        bluetoothPermissions().all { checkPermission(it) }

    private fun hasLocationPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < 23 ||
            checkPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
            checkPermission(Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun checkPermission(permission: String): Boolean {
        val context = applicationContext ?: return false
        return Build.VERSION.SDK_INT < 23 ||
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    // endregion

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
                    discoveredBluetoothDevices[id] = device
                    discoveredDevices[id] = mapOf(
                        "id" to id,
                        "name" to name,
                        "rssi" to result.rssi,
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
        activeGattConnections[deviceId]?.let { connection ->
            if (connection.isClosed()) {
                activeGattConnections.remove(deviceId, connection)
                handleGattDisconnected(deviceId, "Bluetooth connection was lost")
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
                val connection = activeGattConnections[deviceId]
                if (connection != null && connection.ownsGatt(gatt)) {
                    if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                        connection.disconnect(
                            "hardware_bluetooth_disconnected",
                            "Bluetooth connection was lost ($status)",
                        )
                    }
                    return
                }
                if (connection != null && !connection.ownsGatt(gatt)) {
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
                    onDisconnected = { disconnectedDeviceId, message ->
                        handleGattDisconnected(disconnectedDeviceId, message, gatt)
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
        message: String,
        expectedGatt: BluetoothGatt? = null,
    ) {
        val active = activeGattConnections[deviceId]
        if (expectedGatt == null || active?.ownsGatt(expectedGatt) == true) {
            if (active != null) {
                activeGattConnections.remove(deviceId, active)
            } else {
                activeGattConnections.remove(deviceId)
            }
        }
        val states = notificationStates.values.filter { state ->
            state.key.deviceId == deviceId &&
                (expectedGatt == null || state.connection.ownsGatt(expectedGatt))
        }.toList()
        states.forEach { state ->
            failNotificationState(state, "hardware_bluetooth_disconnected", message)
        }
        notificationStreams.values
            .filter { stream ->
                stream.key.deviceId == deviceId &&
                    (expectedGatt == null || stream.connection.ownsGatt(expectedGatt))
            }
            .toList()
            .forEach { stream ->
                if (notificationStreams.remove(stream.streamId, stream)) {
                    emitStreamErrorAndDone(stream.streamId, "hardware_bluetooth_disconnected", message)
                }
            }
    }

    // endregion

    // region Sensors

    private fun supportedSensors(context: Context): Boolean {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return false
        return listOf(
            Sensor.TYPE_ACCELEROMETER,
            Sensor.TYPE_LINEAR_ACCELERATION,
            Sensor.TYPE_GYROSCOPE,
            Sensor.TYPE_ROTATION_VECTOR,
            Sensor.TYPE_PRESSURE,
            Sensor.TYPE_MAGNETIC_FIELD,
        ).any { manager.getDefaultSensor(it) != null }
    }

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val values = event.values.map(Float::toDouble)
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
            val timestampNs = if (event.timestamp > 0L) event.timestamp else System.nanoTime()
            val eligibleStreams = sensorStreams.values.toList().filter { stream ->
                if (event.sensor.type !in stream.sensorTypes) return@filter false
                if (stream.lastEventNs != 0L && timestampNs - stream.lastEventNs < stream.samplingPeriodNs) {
                    return@filter false
                }
                stream.lastEventNs = timestampNs
                true
            }
            if (eligibleStreams.isEmpty()) return
            val data = linkedMapOf<String, Any?>(
                "realSensors" to true,
                "sensor" to sensorName(event.sensor.type),
                "sensorType" to event.sensor.type,
                "values" to values,
                "timestampNs" to timestampNs,
                "timestamp" to formatTimestamp(System.currentTimeMillis()),
            )
            if (values.size >= 3) {
                data["x"] = values[0]
                data["y"] = values[1]
                data["z"] = values[2]
            }
            when (event.sensor.type) {
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
                    SensorManager.getRotationMatrixFromVector(matrix, event.values)
                    SensorManager.getOrientation(matrix, orientation)
                    data["yaw"] = orientation[0].toDouble()
                    data["pitch"] = orientation[1].toDouble()
                    data["roll"] = orientation[2].toDouble()
                }
            }
            eligibleStreams.forEach { stream ->
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

    private fun ensureSensorListeners(
        manager: SensorManager,
        sensorTypes: Iterable<Int>,
    ): Boolean {
        var registeredAny = registeredSensorTypes.isNotEmpty()
        sensorTypes.forEach { type ->
            if (type in registeredSensorTypes) return@forEach
            val sensor = try {
                manager.getDefaultSensor(type)
            } catch (_: Exception) {
                null
            } ?: return@forEach
            val registered = try {
                manager.registerListener(
                    sensorListener,
                    sensor,
                    SensorManager.SENSOR_DELAY_FASTEST,
                    mainHandler,
                )
            } catch (_: Exception) {
                false
            }
            if (registered) {
                registeredSensorTypes.add(type)
                registeredAny = true
            }
        }
        sensorListenerRegistered = registeredSensorTypes.isNotEmpty()
        return registeredAny
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
        val sensorTypes = listOf(
            Sensor.TYPE_ACCELEROMETER,
            Sensor.TYPE_LINEAR_ACCELERATION,
            Sensor.TYPE_GYROSCOPE,
            Sensor.TYPE_ROTATION_VECTOR,
            Sensor.TYPE_PRESSURE,
            Sensor.TYPE_MAGNETIC_FIELD,
        )
        if (!ensureSensorListeners(manager, sensorTypes)) {
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
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        sensorManager?.let { manager ->
            if (sensorStreams.isEmpty() && sensorListenerRegistered) {
                try {
                    manager.unregisterListener(sensorListener)
                } catch (_: Exception) {
                    // The one-shot result is still completed; a detached
                    // vendor sensor service may have already released it.
                }
                registeredSensorTypes.clear()
                sensorListenerRegistered = false
            }
        }
        if (sensorValues.isEmpty()) {
            callback.success(error("hardware_sensor_timeout", "sensor sample was unavailable"))
            sensorValues.clear()
            return
        }
        callback.success(ok("realSensors" to true, *sensorValues.entries.map { it.key to it.value }.toTypedArray()))
        sensorValues.clear()
    }

    private fun startHardwareStream(args: Map<String, Any?>, result: MethodChannel.Result) {
        val streamId = args["streamId"] as? String
        val sessionId = normalizeSessionId(args["sessionId"])
        val kind = args["kind"] as? String
        if (streamId.isNullOrBlank() || sessionId == null || kind.isNullOrBlank()) {
            result.success(error("invalid_argument", "kind, streamId and sessionId are required"))
            return
        }
        if (sensorStreams.containsKey(streamId) || notificationStreams.containsKey(streamId)) {
            result.success(error("hardware_busy", "streamId is already active"))
            return
        }
        // A stream id can be reused by a later guest after the previous
        // stream was stopped while the shared EventChannel had no listener.
        // Drop the old buffered terminal packet before accepting the new id.
        clearQueuedEvents(streamId)
        when (kind) {
            "sensors" -> startSensorStream(args, streamId, sessionId, result)
            "ble.notifications" -> startBleNotificationStream(args, streamId, sessionId, result)
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
            if (sensorStreams.isEmpty()) unregisterSensorListenersIfIdle()
            result.success(ok("streamId" to streamId, "stopped" to true))
            return
        }
        if (notificationStreams.containsKey(streamId)) {
            stopBleNotificationStream(streamId, sessionId, result)
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
        if (!ensureSensorListeners(manager, availableTypes)) {
            result.success(error("hardware_unsupported", "sensor listeners could not be registered"))
            return
        }
        sensorManager = manager
        sensorStreams[streamId] = SensorStream(
            streamId = streamId,
            sessionId = sessionId,
            sensorTypes = availableTypes,
            samplingPeriodNs = 1_000_000_000L / hz,
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
    }

    // endregion

    // region Biometrics

    private enum class BiometricAvailability { AVAILABLE, UNAVAILABLE }

    private fun biometricAvailability(context: Context): BiometricAvailability {
        if (Build.VERSION.SDK_INT < 28) return BiometricAvailability.UNAVAILABLE
        val packageManager = context.packageManager
        val hasBiometricFeature = packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ||
            packageManager.hasSystemFeature("android.hardware.biometrics.face") ||
            packageManager.hasSystemFeature("android.hardware.biometrics.iris")
        if (!hasBiometricFeature) return BiometricAvailability.UNAVAILABLE
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (keyguard != null && !keyguard.isDeviceSecure) return BiometricAvailability.UNAVAILABLE
        if (Build.VERSION.SDK_INT >= 23 && packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)) {
            try {
                val fingerprint = context.getSystemService(Context.FINGERPRINT_SERVICE) as? android.hardware.fingerprint.FingerprintManager
                if (fingerprint != null && (!fingerprint.isHardwareDetected || !fingerprint.hasEnrolledFingerprints())) {
                    return BiometricAvailability.UNAVAILABLE
                }
            } catch (_: SecurityException) {
                return BiometricAvailability.UNAVAILABLE
            }
        }
        return BiometricAvailability.AVAILABLE
    }

    private fun authenticateBiometrics(reason: String, result: MethodChannel.Result) {
        if (reason.trim().isEmpty()) {
            result.success(error("invalid_argument", "biometric reason must not be empty"))
            return
        }
        val context = applicationContext
        val hostActivity = activity
        if (context == null || hostActivity == null) {
            result.success(error("hardware_not_ready", "an attached Activity is required for biometrics"))
            return
        }
        if (biometricAvailability(context) != BiometricAvailability.AVAILABLE) {
            result.success(error("hardware_unsupported", "biometric authentication is unavailable"))
            return
        }
        if (pendingBiometricResult != null) {
            result.success(error("hardware_busy", "biometric authentication is already running"))
            return
        }
        pendingBiometricResult = result
        try {
            val prompt = BiometricPrompt.Builder(hostActivity)
                .setTitle("Pocket")
                .setDescription(reason)
                .setNegativeButton("Cancel", hostActivity.mainExecutor) { _, _ ->
                    finishBiometric(
                        ok(
                            "authenticated" to false,
                            "realBiometrics" to true,
                            "biometricType" to "AndroidBiometric",
                            "errorCode" to "hardware_biometric_failed",
                            "error" to "authentication cancelled",
                        ),
                    )
                }
                .build()
            biometricPrompt = prompt
            val cancellationSignal: CancellationSignal = CancellationSignal()
            biometricCancellation = cancellationSignal
            val executor: Executor = hostActivity.mainExecutor
            val callback: BiometricPrompt.AuthenticationCallback =
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        finishBiometric(
                            ok(
                                "authenticated" to true,
                                "realBiometrics" to true,
                                "biometricType" to "AndroidBiometric",
                            ),
                        )
                    }

                    override fun onAuthenticationFailed() {
                        // Android keeps the prompt open after a failed scan;
                        // only onAuthenticationError completes the request.
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        finishBiometric(
                            ok(
                                "authenticated" to false,
                                "realBiometrics" to true,
                                "biometricType" to "AndroidBiometric",
                                "errorCode" to "hardware_biometric_failed",
                                "error" to errString.toString(),
                            ),
                        )
                    }
                }
            prompt.authenticate(cancellationSignal, executor, callback)
        } catch (security: SecurityException) {
            pendingBiometricResult = null
            biometricPrompt = null
            biometricCancellation = null
            result.success(error("hardware_permission_denied", security.message ?: "biometric permission is not granted"))
        } catch (failure: Throwable) {
            pendingBiometricResult = null
            biometricPrompt = null
            biometricCancellation = null
            result.success(error("hardware_biometric_failed", failure.message ?: "biometric prompt failed"))
        }
    }

    private fun finishBiometric(value: Map<String, Any?>) {
        val callback = pendingBiometricResult ?: return
        pendingBiometricResult = null
        biometricPrompt = null
        biometricCancellation = null
        mainHandler.post { callback.success(value) }
    }

    // endregion

    // region Location

    private fun hasLocationProvider(context: Context): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return try {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (_: Exception) {
            false
        }
    }

    private fun getCurrentLocation(result: MethodChannel.Result) {
        val context = applicationContext
        if (context == null) {
            result.success(error("hardware_not_ready", "Android context is not attached"))
            return
        }
        if (!hasLocationProvider(context)) {
            result.success(error("hardware_unsupported", "location services are disabled"))
            return
        }
        if (!hasLocationPermission(context)) {
            result.success(error("hardware_permission_denied", "location permission is not granted"))
            return
        }
        if (pendingLocationResult != null) {
            result.success(error("hardware_busy", "location request is already pending"))
            return
        }
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (manager == null) {
            result.success(error("hardware_unsupported", "location manager is unavailable"))
            return
        }
        val provider = try {
            if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                LocationManager.GPS_PROVIDER
            } else {
                LocationManager.NETWORK_PROVIDER
            }
        } catch (_: Exception) {
            result.success(error("hardware_unsupported", "location provider is unavailable"))
            return
        }
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                finishLocation(
                    ok(
                        "realGps" to true,
                        "latitude" to location.latitude,
                        "longitude" to location.longitude,
                        "altitudeM" to location.altitude,
                        "horizontalAccuracyM" to location.accuracy.toDouble(),
                        "timestamp" to formatTimestamp(location.time),
                    ),
                )
            }

            override fun onProviderDisabled(providerName: String) {
                if (providerName == locationProvider) {
                    finishLocation(error("hardware_location_error", "location provider was disabled"))
                }
            }

            override fun onProviderEnabled(providerName: String) = Unit
            override fun onStatusChanged(providerName: String?, status: Int, extras: Bundle?) = Unit
        }
        locationListener = listener
        locationProvider = provider
        pendingLocationResult = result
        try {
            manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper())
        } catch (security: SecurityException) {
            pendingLocationResult = null
            locationListener = null
            locationProvider = null
            result.success(error("hardware_permission_denied", security.message ?: "location permission is not granted"))
            return
        } catch (failure: Exception) {
            pendingLocationResult = null
            locationListener = null
            locationProvider = null
            result.success(error("hardware_location_error", failure.message ?: "location request failed"))
            return
        }
        val timeout = Runnable {
            finishLocation(error("hardware_location_timeout", "no location fix was received"))
        }
        locationTimeout = timeout
        mainHandler.postDelayed(timeout, 30_000L)
    }

    private fun finishLocation(value: Map<String, Any?>) {
        val callback = pendingLocationResult ?: return
        pendingLocationResult = null
        locationTimeout?.let(mainHandler::removeCallbacks)
        locationTimeout = null
        val context = applicationContext
        val manager = context?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        try {
            locationListener?.let { manager?.removeUpdates(it) }
        } catch (_: Exception) {
            // The callback still receives the actual result; cleanup is best effort.
        }
        locationListener = null
        locationProvider = null
        mainHandler.post { callback.success(value) }
    }

    private fun formatTimestamp(epochMillis: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(epochMillis))

    // endregion

    // region Resource cleanup and camera worker

    private fun disposeSession(args: Map<String, Any?>, result: MethodChannel.Result) {
        // A session dispose is reversible: Dart may mount another guest on the
        // same Flutter engine.  New stream/GATT resources are owner-scoped;
        // calls from older hosts without sessionId only release legacy,
        // ownerless resources.  Camera remains a legacy resource and is
        // released only by the legacy no-session form.
        val ownerSessionId = normalizeSessionId(args["sessionId"])
        if (ownerSessionId == null) {
            cancelBluetoothOperations("hardware session disposed", ownerSessionId = null, includeAll = false)
            cancelSensorStreams("hardware session disposed", ownerSessionId = null, includeAll = false)
            finishSensorWithError(
                "hardware session disposed",
                ownerSessionId = null,
                includeAll = false,
            )
            val camera = cameraHardware
            if (camera == null || !camera.handle("disposeSession", emptyMap(), result)) {
                result.success(ok("disposed" to true))
            }
        } else {
            cancelBluetoothOperations("hardware session disposed", ownerSessionId, includeAll = false)
            cancelSensorStreams("hardware session disposed", ownerSessionId, includeAll = false)
            finishSensorWithError(
                "hardware session disposed",
                ownerSessionId,
                includeAll = false,
            )
            result.success(ok("disposed" to true, "sessionId" to ownerSessionId))
        }
    }

    private fun disposeNativeResources(reason: String, closeCameraWorker: Boolean) {
        if (closeCameraWorker) cameraHardware?.dispose()
        finishPendingPermission(reason)
        cancelBluetoothOperations(reason, ownerSessionId = null, includeAll = true)
        cancelSensorStreams(reason, ownerSessionId = null, includeAll = true)
        finishSensorWithError(reason, ownerSessionId = null, includeAll = true)
        cancelBiometric(reason)
        finishLocation(error("plugin_revoked", reason))
    }

    private fun cancelActivityBoundOperations(reason: String) {
        finishPendingPermission(reason)
        cancelBluetoothOperations(reason, ownerSessionId = null, includeAll = true)
        cancelSensorStreams(reason, ownerSessionId = null, includeAll = true)
        finishSensorWithError(reason, ownerSessionId = null, includeAll = true)
        cancelBiometric(reason)
        finishLocation(error("plugin_revoked", reason))
    }

    private fun cancelBluetoothOperations(
        reason: String,
        ownerSessionId: String?,
        includeAll: Boolean,
    ) {
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
        if (includeAll) {
            pendingGatts.values.toList().forEach { gatt ->
                try { gatt.close() } catch (_: Exception) { }
            }
            pendingGatts.clear()
            pendingConnectionOwners.clear()
            pendingConnectionGenerations.clear()
        }
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
        notificationStreams.values.toList().forEach { stream ->
            if (includeAll || stream.sessionId == ownerSessionId) {
                notificationStreams.remove(stream.streamId, stream)
                val state = notificationStates[stream.key]
                val pending = state?.streamIds?.remove(stream.streamId)
                pending?.success(error("plugin_revoked", reason))
                emitStreamErrorAndDone(stream.streamId, "plugin_revoked", reason)
                if (state != null && state.streamIds.isEmpty()) {
                    requestNotificationDisable(state)
                }
            }
        }
        unregisterSensorListenersIfIdle()
    }

    private fun finishPendingPermission(reason: String) {
        val callback = pendingPermissionResult ?: return
        pendingPermissionResult = null
        pendingPermissionName = null
        pendingPermissionManifest = emptyList()
        callback.success(error("plugin_revoked", reason))
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
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        unregisterSensorListenersIfIdle()
        sensorValues.clear()
        callback?.success(error("plugin_revoked", reason))
    }

    private fun cancelBiometric(reason: String) {
        val cancellation = biometricCancellation
        finishBiometric(error("plugin_revoked", reason))
        cancellation?.cancel()
    }

    private fun isCameraMethod(method: String): Boolean = method in setOf(
        "startCameraPreview",
        "stopCameraPreview",
        "switchCameraLens",
        "toggleCameraFlash",
        "capturePhoto",
        "listSavedPhotos",
        "deleteSavedPhoto",
    )

    private fun delegateCamera(
        method: String,
        args: Map<String, Any?>,
        result: MethodChannel.Result,
    ): Boolean {
        val worker = cameraHardware ?: return false
        return worker.handle(method, args, result)
    }

    // endregion

    // region Helpers

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
