package dev.pocketjs.pocket_biometrics

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.LinkedHashMap
import java.util.concurrent.Executor

/** Android BiometricPrompt transport for the independent biometrics group. */
class PocketBiometricsPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware/biometrics"
    }

    private var applicationContext: Context? = null
    private var activity: Activity? = null
    private var channel: MethodChannel? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingBiometricResult: MethodChannel.Result? = null
    private var biometricPrompt: BiometricPrompt? = null
    private var biometricCancellation: CancellationSignal? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cancelBiometric("plugin detached")
        channel?.setMethodCallHandler(null)
        channel = null
        applicationContext = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        cancelBiometric("activity detached during configuration change")
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivity() {
        cancelBiometric("activity detached")
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *> ?: emptyMap<Any?, Any?>()
        when (call.method) {
            "authenticateBiometrics" -> authenticateBiometrics(
                args["reason"] as? String ?: "Authenticate to continue",
                result,
            )
            "disposeSession" -> {
                cancelBiometric("hardware session disposed")
                result.success(ok("disposed" to true))
            }
            else -> result.success(error("hardware_unsupported", "unknown biometric method: ${call.method}"))
        }
    }

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

    private fun cancelBiometric(reason: String) {
        val cancellation = biometricCancellation
        finishBiometric(error("plugin_revoked", reason))
        cancellation?.cancel()
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
}
