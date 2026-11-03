package dev.pocketjs.pocket_platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.util.Locale

/**
 * Native half of the opt-in links provider.
 *
 * This plugin does not add an intent filter. The trusted consumer owns its
 * scheme declaration and forwards explicit intents through the standard
 * Flutter activity lifecycle.
 */
class PocketPlatformPlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    ActivityAware, PluginRegistry.NewIntentListener {

    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/platform"
        private const val ENABLED_KEY = "dev.pocketjs.platform.DEEP_LINKS_ENABLED"
        private const val SCHEMES_KEY = "dev.pocketjs.platform.DEEP_LINK_SCHEMES"

        @Volatile
        private var shared: PocketPlatformPlugin? = null

        /** Forward a cold/warm URL from the consuming Activity. */
        @JvmStatic
        fun handleIncomingUri(uri: Uri) {
            shared?.receive(uri)
        }
    }

    private var applicationContext: Context? = null
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var linksEnabled = false
    private var configuredScheme: String? = null
    private var initialLink: String? = null
    private var latestLink: String? = null
    private data class RecentUri(val value: String, val atMillis: Long)
    private val recentUris = java.util.ArrayDeque<RecentUri>()
    private val deepLinkDedupeWindowMillis = 250L
    private val maxRecentUris = 32
    private var intentListenerAttached = false
    // A trusted static opt-in may deliver a cold launch intent before the Dart
    // isolate activates the provider. disableDeepLinks closes this window.
    private var preconfigurationCaptureOpen = true

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel?.setMethodCallHandler(this)
        shared = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disableDeepLinks()
        channel?.setMethodCallHandler(null)
        channel = null
        applicationContext = null
        if (shared === this) shared = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activityBinding = binding
        activity = binding.activity
        if (linksEnabled) attachIntentListener()
    }

    override fun onDetachedFromActivityForConfigChanges() {
        detachActivity()
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        detachActivity()
    }

    override fun onNewIntent(intent: Intent): Boolean {
        intent.data?.let(::receive)
        return false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "configureDeepLinks" -> configureDeepLinks(call.arguments, result)
            "getInitialLink" -> result.success(mapOf("uri" to initialLink))
            "getLatestLink" -> result.success(mapOf("uri" to latestLink))
            "disableDeepLinks" -> {
                disableDeepLinks()
                result.success(mapOf("disabled" to true))
            }
            else -> result.notImplemented()
        }
    }

    private fun configureDeepLinks(rawArguments: Any?, result: MethodChannel.Result) {
        val args = rawArguments as? Map<*, *>
        val enabled = args?.get("enabled") as? Boolean ?: false
        val rawScheme = args?.get("scheme") as? String
        val scheme = rawScheme?.let(::validatedScheme)
        if (!enabled || scheme == null) {
            result.error(
                "platform_invalid_argument",
                "deep links require enabled=true and a custom URL scheme",
                null,
            )
            return
        }
        if (!staticOptInAllows(scheme)) {
            result.error(
                "platform_deep_links_not_enabled",
                "DEEP_LINKS_ENABLED and DEEP_LINK_SCHEMES do not allow this scheme",
                mapOf("scheme" to scheme),
            )
            return
        }
        if (configuredScheme != scheme) {
            initialLink = null
            latestLink = null
            recentUris.clear()
        }
        linksEnabled = true
        configuredScheme = scheme
        attachIntentListener()
        result.success(mapOf("enabled" to true, "scheme" to scheme))
        // Android keeps the launch intent on the Activity. Read it only after
        // both opt-in layers have succeeded; disabled startup never caches it.
        activity?.intent?.data?.let(::receive)
    }

    private fun disableDeepLinks() {
        if (intentListenerAttached) {
            activityBinding?.removeOnNewIntentListener(this)
            intentListenerAttached = false
        }
        preconfigurationCaptureOpen = false
        linksEnabled = false
        configuredScheme = null
        initialLink = null
        latestLink = null
        recentUris.clear()
    }

    private fun receive(uri: Uri) {
        val incomingScheme = uri.scheme?.let(::validatedScheme) ?: return
        if (!staticOptInAllows(incomingScheme)) return
        if (!linksEnabled) {
            if (!preconfigurationCaptureOpen ||
                (configuredScheme != null && configuredScheme != incomingScheme)
            ) return
            configuredScheme = incomingScheme
        } else if (configuredScheme != incomingScheme) {
            return
        }
        val value = uri.toString()
        if (value.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (recentUris.any {
                it.value == value &&
                    now >= it.atMillis &&
                    now - it.atMillis < deepLinkDedupeWindowMillis
            }) return
        recentUris.addLast(RecentUri(value, now))
        while (recentUris.size > maxRecentUris) recentUris.removeFirst()
        if (initialLink == null) initialLink = value
        latestLink = value
        if (linksEnabled) channel?.invokeMethod("onDeepLink", mapOf("uri" to value))
    }

    private fun staticOptInAllows(scheme: String): Boolean {
        val context = applicationContext ?: return false
        val info = try {
            context.packageManager.getApplicationInfo(
                context.packageName,
                PackageManager.GET_META_DATA,
            )
        } catch (_: PackageManager.NameNotFoundException) {
            return false
        }
        val metadata = info.metaData ?: return false
        if (!metadata.getBoolean(ENABLED_KEY, false)) return false
        val schemes = metadata.getString(SCHEMES_KEY)
            ?.split(',')
            ?.mapNotNull { validatedScheme(it) }
            ?: emptyList()
        return schemes.contains(scheme)
    }

    private fun detachActivity() {
        if (intentListenerAttached) {
            activityBinding?.removeOnNewIntentListener(this)
            intentListenerAttached = false
        }
        activityBinding = null
        activity = null
    }

    private fun attachIntentListener() {
        if (!linksEnabled || intentListenerAttached) return
        activityBinding?.addOnNewIntentListener(this)
        intentListenerAttached = activityBinding != null
    }

    private fun validatedScheme(raw: String): String? {
        val scheme = raw
        val forbidden = setOf("http", "https", "file", "data", "javascript", "content", "intent")
        if (scheme.length !in 1..32 || scheme != scheme.lowercase(Locale.US) || forbidden.contains(scheme)) return null
        if (!scheme.matches(Regex("[a-z][a-z0-9+.-]*"))) return null
        return scheme
    }
}
