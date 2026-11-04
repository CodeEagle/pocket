package dev.pocketjs.pocket_location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.LinkedHashMap
import java.util.Locale

/** Android LocationManager transport for the independent location group. */
class PocketLocationPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware/location"
        private const val LEGACY_SESSION_ID = "legacy"
    }

    private var applicationContext: Context? = null
    private var channel: MethodChannel? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingLocationResult: MethodChannel.Result? = null
    private var pendingLocationSessionId: String? = null
    private var locationTimeout: Runnable? = null
    private var locationListener: LocationListener? = null
    private var locationProvider: String? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disposeNativeResources("plugin detached")
        channel?.setMethodCallHandler(null)
        channel = null
        applicationContext = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments.asStringMap()
        when (call.method) {
            "getCurrentLocation" -> getCurrentLocation(args["sessionId"], result)
            "disposeSession" -> disposeSession(args["sessionId"], result)
            else -> result.success(error("hardware_unsupported", "unknown location method: ${call.method}"))
        }
    }

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

    /** Final boundary check; Dart permission_handler owns all prompts. */
    private fun hasLocationPermission(context: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < 23 ||
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun getCurrentLocation(sessionIdValue: Any?, result: MethodChannel.Result) {
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
                    this,
                )
            }

            override fun onProviderDisabled(providerName: String) {
                if (providerName == locationProvider) {
                    finishLocation(
                        error("hardware_location_error", "location provider was disabled"),
                        this,
                    )
                }
            }

            override fun onProviderEnabled(providerName: String) = Unit
            override fun onStatusChanged(providerName: String?, status: Int, extras: Bundle?) = Unit
        }
        locationListener = listener
        locationProvider = provider
        pendingLocationResult = result
        pendingLocationSessionId = normalizeSessionId(sessionIdValue)
        try {
            manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper())
        } catch (security: SecurityException) {
            finishLocation(
                error("hardware_permission_denied", security.message ?: "location permission is not granted"),
                listener,
            )
            return
        } catch (failure: Exception) {
            finishLocation(
                error("hardware_location_error", failure.message ?: "location request failed"),
                listener,
            )
            return
        }
        val timeout = Runnable {
            finishLocation(
                error("hardware_location_timeout", "no location fix was received"),
                listener,
            )
        }
        locationTimeout = timeout
        mainHandler.postDelayed(timeout, 30_000L)
    }

    private fun finishLocation(value: Map<String, Any?>, expectedListener: LocationListener? = null) {
        if (expectedListener != null && locationListener !== expectedListener) return
        val callback = pendingLocationResult ?: return
        pendingLocationResult = null
        pendingLocationSessionId = null
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

    private fun disposeSession(sessionIdValue: Any?, result: MethodChannel.Result) {
        val ownerSessionId = normalizeSessionId(sessionIdValue)
        cancelLocation("hardware session disposed", ownerSessionId, includeAll = false)
        result.success(ok("disposed" to true, "sessionId" to ownerSessionId))
    }

    private fun disposeNativeResources(reason: String) {
        cancelLocation(reason, ownerSessionId = null, includeAll = true)
    }

    private fun cancelLocation(reason: String, ownerSessionId: String?, includeAll: Boolean) {
        if (!includeAll && pendingLocationSessionId != ownerSessionId) return
        val listener = locationListener
        if (listener != null) {
            finishLocation(error("plugin_revoked", reason), listener)
        }
    }

    private fun normalizeSessionId(value: Any?): String =
        (value as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: LEGACY_SESSION_ID

    private fun Any?.asStringMap(): Map<String, Any?> =
        (this as? Map<*, *>)?.entries?.associate { (key, value) -> key.toString() to value } ?: emptyMap()

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
}
