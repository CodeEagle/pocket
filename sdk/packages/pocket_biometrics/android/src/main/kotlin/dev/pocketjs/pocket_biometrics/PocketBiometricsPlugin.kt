package dev.pocketjs.pocket_biometrics

import android.app.Activity
import android.content.Context
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

internal fun biometricSessionMatches(
    requestedSessionId: String?,
    pendingSessionId: String?,
): Boolean = requestedSessionId == null || requestedSessionId == pendingSessionId

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
    private var pendingBiometricSessionId: String? = null
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
                args["sessionId"] as? String,
                result,
            )
            "disposeSession" -> {
                val disposed = cancelBiometric("hardware session disposed", args["sessionId"] as? String)
                result.success(ok("disposed" to disposed))
            }
            else -> result.success(error("hardware_unsupported", "unknown biometric method: ${call.method}"))
        }
    }

    // region Biometrics

    private fun authenticateBiometrics(
        reason: String,
        sessionId: String?,
        result: MethodChannel.Result,
    ) {
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
        // BiometricPrompt owns hardware/enrollment/lockout checks. Manual
        // fingerprint and keyguard probes incorrectly reject face/iris devices
        // before the prompt can report their real state.
        if (Build.VERSION.SDK_INT < 28) {
            result.success(error("hardware_unsupported", "biometric authentication is unavailable"))
            return
        }
        if (pendingBiometricResult != null) {
            result.success(error("hardware_busy", "biometric authentication is already running"))
            return
        }
        val cancellationSignal = CancellationSignal()
        pendingBiometricResult = result
        pendingBiometricSessionId = sessionId
        biometricCancellation = cancellationSignal
        try {
            val prompt = BiometricPrompt.Builder(hostActivity)
                .setTitle("Pocket")
                .setDescription(reason)
                .setNegativeButton("Cancel", hostActivity.mainExecutor) { _, _ ->
                    finishBiometric(cancellationSignal,
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
            val executor: Executor = hostActivity.mainExecutor
            val callback: BiometricPrompt.AuthenticationCallback =
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        finishBiometric(cancellationSignal,
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
                        finishBiometric(cancellationSignal,
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
            finishBiometric(
                cancellationSignal,
                error("hardware_permission_denied", security.message ?: "biometric permission is not granted"),
            )
        } catch (failure: Throwable) {
            finishBiometric(
                cancellationSignal,
                error("hardware_biometric_failed", failure.message ?: "biometric prompt failed"),
            )
        }
    }

    private fun finishBiometric(cancellation: CancellationSignal, value: Map<String, Any?>) {
        if (biometricCancellation !== cancellation) return
        val callback = pendingBiometricResult
        pendingBiometricResult = null
        pendingBiometricSessionId = null
        biometricPrompt = null
        biometricCancellation = null
        if (callback == null) return
        mainHandler.post { callback.success(value) }
    }

    // endregion

    private fun cancelBiometric(reason: String, sessionId: String? = null): Boolean {
        val cancellation = biometricCancellation
        val pendingSessionId = pendingBiometricSessionId
        if (cancellation != null && !biometricSessionMatches(sessionId, pendingSessionId)) {
            return false
        }
        if (cancellation != null) {
            finishBiometric(cancellation, error("plugin_revoked", reason))
        } else {
            biometricPrompt = null
            biometricCancellation = null
            pendingBiometricSessionId = null
        }
        cancellation?.cancel()
        return true
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
