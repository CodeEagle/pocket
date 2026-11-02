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
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
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
        private const val REQUEST_PERMISSION_CODE = 0x504B
    }

    private var applicationContext: Context? = null
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var cameraHardware: CameraHardware? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    private var pendingPermissionResult: MethodChannel.Result? = null
    private var pendingPermissionName: String? = null
    private var pendingPermissionManifest: List<String> = emptyList()

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var bluetoothScanner: BluetoothLeScanner? = null
    private val bluetoothLock = Any()
    private val discoveredDevices = ConcurrentHashMap<String, Map<String, Any?>>()
    private val discoveredBluetoothDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private var pendingScanResult: MethodChannel.Result? = null
    private var scanTimeout: Runnable? = null
    private val activeGatts = ConcurrentHashMap<String, BluetoothGatt>()
    private val pendingConnections = ConcurrentHashMap<String, MethodChannel.Result>()
    private val connectionTimeouts = ConcurrentHashMap<String, Runnable>()

    private var pendingSensorResult: MethodChannel.Result? = null
    private var sensorTimeout: Runnable? = null
    private val sensorValues = LinkedHashMap<String, Any>()
    private var sensorManager: SensorManager? = null
    private var sensorListenerRegistered = false

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
        cameraHardware = CameraHardware(binding.applicationContext, binding.textureRegistry)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disposeNativeResources("plugin detached", closeCameraWorker = true)
        channel?.setMethodCallHandler(null)
        channel = null
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
            "disposeSession" -> disposeSession(result)
            "startBleScan" -> startBleScan((args["timeoutMs"] as? Number)?.toLong() ?: 1600L, result)
            "connectBleDevice" -> connectBleDevice(args["deviceId"] as? String, result)
            "readSensors" -> readSensors(result)
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

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
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
            completeBleScan(error("hardware_bluetooth_scan", "Bluetooth scan failed ($errorCode)"))
        }
    }

    private fun startBleScan(timeoutMillis: Long, result: MethodChannel.Result) {
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
        synchronized(bluetoothLock) {
            if (pendingScanResult != null) {
                result.success(error("hardware_busy", "Bluetooth scan is already running"))
                return
            }
            discoveredDevices.clear()
            discoveredBluetoothDevices.clear()
            pendingScanResult = result
        }
        bluetoothAdapter = adapter
        bluetoothScanner = scanner
        try {
            val settings = ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
            scanner.startScan(null, settings, scanCallback)
        } catch (security: SecurityException) {
            completeBleScan(error("hardware_permission_denied", security.message ?: "Bluetooth scan permission is not granted"))
            return
        } catch (failure: Exception) {
            completeBleScan(error("hardware_bluetooth_scan", failure.message ?: "Bluetooth scan failed"))
            return
        }
        val timeout = Runnable { finishBleScan() }
        scanTimeout = timeout
        mainHandler.postDelayed(timeout, clampedTimeout)
    }

    private fun finishBleScan() {
        completeBleScan(
            ok(
                "realBle" to true,
                "state" to "poweredOn",
                "devices" to discoveredDevices.values.sortedBy { "${it["id"]}" },
            ),
        )
    }

    private fun completeBleScan(value: Map<String, Any?>) {
        val callback = synchronized(bluetoothLock) {
            val pending = pendingScanResult
            pendingScanResult = null
            pending
        } ?: return
        scanTimeout?.let(mainHandler::removeCallbacks)
        scanTimeout = null
        try {
            bluetoothScanner?.stopScan(scanCallback)
        } catch (_: SecurityException) {
            // The request is still completed with a structured result.  The
            // adapter may have been revoked while the scan was ending.
        }
        mainHandler.post { callback.success(value) }
    }

    private fun connectBleDevice(deviceId: String?, result: MethodChannel.Result) {
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
        if (pendingConnections.containsKey(deviceId)) {
            result.success(error("hardware_busy", "connection is already pending"))
            return
        }
        pendingConnections[deviceId] = result
        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (!pendingConnections.containsKey(deviceId)) {
                    try {
                        gatt.close()
                    } catch (_: Exception) {
                        // The timeout/dispose path already owns cleanup.
                    }
                    return
                }
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    try {
                        gatt.discoverServices()
                    } catch (security: SecurityException) {
                        finishConnection(deviceId, error("hardware_bluetooth_services", security.message ?: "service discovery failed"))
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    finishConnection(deviceId, error("hardware_bluetooth_connect", "Bluetooth connection failed ($status)"))
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    finishConnection(deviceId, error("hardware_bluetooth_services", "service discovery failed ($status)"))
                    return
                }
                val services = try {
                    gatt.services.orEmpty().map(BluetoothGattService::getUuid).map(UUID::toString)
                } catch (_: SecurityException) {
                    emptyList()
                }
                if (!pendingConnections.containsKey(deviceId)) {
                    try {
                        gatt.close()
                    } catch (_: Exception) {
                        // The timeout/dispose path already owns cleanup.
                    }
                    return
                }
                activeGatts[deviceId] = gatt
                finishConnection(
                    deviceId,
                    ok(
                        "realBle" to true,
                        "device" to deviceId,
                        "state" to "connected",
                        "services" to services,
                    ),
                )
            }
        }
        try {
            val gatt = if (Build.VERSION.SDK_INT >= 23) {
                device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(context, false, callback)
            }
            if (gatt == null) {
                pendingConnections.remove(deviceId)
                result.success(error("hardware_bluetooth_connect", "Bluetooth connection could not be started"))
                return
            }
            activeGatts[deviceId] = gatt
        } catch (security: SecurityException) {
            pendingConnections.remove(deviceId)
            result.success(error("hardware_permission_denied", security.message ?: "Bluetooth connection permission is not granted"))
            return
        } catch (failure: Exception) {
            pendingConnections.remove(deviceId)
            result.success(error("hardware_bluetooth_connect", failure.message ?: "Bluetooth connection could not be started"))
            return
        }
        val timeout = Runnable {
            finishConnection(deviceId, error("hardware_timeout", "Bluetooth connection timed out"))
        }
        if (pendingConnections.containsKey(deviceId)) {
            connectionTimeouts[deviceId] = timeout
            mainHandler.postDelayed(timeout, 15_000L)
        }
    }

    private fun finishConnection(deviceId: String, value: Map<String, Any?>) {
        connectionTimeouts.remove(deviceId)?.let(mainHandler::removeCallbacks)
        val callback = pendingConnections.remove(deviceId) ?: return
        if (value["ok"] != true) {
            try {
                activeGatts.remove(deviceId)?.close()
            } catch (_: Exception) {
                // The adapter may already have closed the GATT instance.
            }
        }
        mainHandler.post { callback.success(value) }
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
        ).any { manager.getDefaultSensor(it) != null }
    }

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            if (pendingSensorResult == null) return
            val values = event.values.map(Float::toDouble)
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
            }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    private fun readSensors(result: MethodChannel.Result) {
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
        )
        var registered = false
        sensorTypes.forEach { type ->
            manager.getDefaultSensor(type)?.let {
                registered = manager.registerListener(sensorListener, it, SensorManager.SENSOR_DELAY_GAME) || registered
            }
        }
        if (!registered) {
            result.success(error("hardware_unsupported", "sensor listeners could not be registered"))
            return
        }
        sensorListenerRegistered = true
        pendingSensorResult = result
        val timeout = Runnable { finishSensorRead() }
        sensorTimeout = timeout
        // One frame is enough for the capability and bounds the call on slow
        // or partially virtualized devices.  The values remain real samples.
        mainHandler.postDelayed(timeout, 750L)
    }

    private fun finishSensorRead() {
        val callback = pendingSensorResult ?: return
        pendingSensorResult = null
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        sensorManager?.let { manager ->
            if (sensorListenerRegistered) manager.unregisterListener(sensorListener)
        }
        sensorListenerRegistered = false
        if (sensorValues.isEmpty()) {
            callback.success(error("hardware_sensor_timeout", "sensor sample was unavailable"))
            return
        }
        callback.success(ok("realSensors" to true, *sensorValues.entries.map { it.key to it.value }.toTypedArray()))
        sensorValues.clear()
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

    private fun disposeSession(result: MethodChannel.Result) {
        // A session dispose is reversible: Dart may mount another guest on the
        // same Flutter engine.  CameraHardware.handle("disposeSession", ...)
        // releases the texture/camera without permanently stopping its worker.
        disposeNativeResources("hardware session disposed", closeCameraWorker = false)
        val camera = cameraHardware
        if (camera == null || !camera.handle("disposeSession", emptyMap(), result)) {
            result.success(ok("disposed" to true))
        }
    }

    private fun disposeNativeResources(reason: String, closeCameraWorker: Boolean) {
        if (closeCameraWorker) cameraHardware?.dispose()
        finishPendingPermission(reason)
        cancelBluetoothOperations(reason)
        finishSensorWithError(reason)
        cancelBiometric(reason)
        finishLocation(error("plugin_revoked", reason))
    }

    private fun cancelActivityBoundOperations(reason: String) {
        finishPendingPermission(reason)
        cancelBluetoothOperations(reason)
        finishSensorWithError(reason)
        cancelBiometric(reason)
        finishLocation(error("plugin_revoked", reason))
    }

    private fun cancelBluetoothOperations(reason: String) {
        completeBleScan(error("plugin_revoked", reason))
        pendingConnections.keys.toList().forEach {
            finishConnection(it, error("plugin_revoked", reason))
        }
        activeGatts.values.toList().forEach { gatt ->
            try {
                gatt.disconnect()
                gatt.close()
            } catch (_: Exception) {
                // Closing a revoked Bluetooth resource is best effort.
            }
        }
        activeGatts.clear()
    }

    private fun finishPendingPermission(reason: String) {
        val callback = pendingPermissionResult ?: return
        pendingPermissionResult = null
        pendingPermissionName = null
        pendingPermissionManifest = emptyList()
        callback.success(error("plugin_revoked", reason))
    }

    private fun finishSensorWithError(reason: String) {
        val callback = pendingSensorResult ?: return
        pendingSensorResult = null
        sensorTimeout?.let(mainHandler::removeCallbacks)
        sensorTimeout = null
        sensorManager?.let { if (sensorListenerRegistered) it.unregisterListener(sensorListener) }
        sensorListenerRegistered = false
        sensorValues.clear()
        callback.success(error("plugin_revoked", reason))
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
