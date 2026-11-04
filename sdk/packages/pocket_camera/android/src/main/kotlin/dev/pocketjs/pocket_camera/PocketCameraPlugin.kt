package dev.pocketjs.pocket_camera

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Flutter transport for the camera capability group.
 *
 * Camera2 and the private photo store live in [CameraHardware]; this plugin
 * only owns registration and the group-specific channel. Permission prompts
 * are handled by the Dart permission provider, while CameraHardware keeps the
 * final Camera2 permission check and SecurityException boundary.
 */
class PocketCameraPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL_NAME = "com.pocketnexus.host/hardware/camera"
    }

    private var channel: MethodChannel? = null
    private var cameraHardware: CameraHardware? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cameraHardware = CameraHardware(binding.applicationContext, binding.textureRegistry)
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cameraHardware?.dispose()
        cameraHardware = null
        channel?.setMethodCallHandler(null)
        channel = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val worker = cameraHardware
        if (worker != null && worker.handle(call, result)) return
        result.success(
            linkedMapOf(
                "ok" to false,
                "errorCode" to "hardware_unsupported",
                "error" to "unknown camera method: ${call.method}",
                "errorMessage" to "unknown camera method: ${call.method}",
            ),
        )
    }
}
