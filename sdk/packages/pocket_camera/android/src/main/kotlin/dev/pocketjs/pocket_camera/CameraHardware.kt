package dev.pocketjs.pocket_camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureFailure
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Surface
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

/** Camera2 + Flutter texture implementation used by the Android hardware plugin. */
internal class CameraHardware(
    private val context: Context,
    private val textureRegistry: TextureRegistry,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val cameraThread = HandlerThread("PocketHardwareCamera").also { it.start() }
    private val cameraHandler = Handler(cameraThread.looper)
    private val cameraManager: CameraManager? =
        context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

    private var textureEntry: TextureRegistry.SurfaceTextureEntry? = null
    private var previewSurface: Surface? = null
    private var imageReader: ImageReader? = null
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var cameraId: String? = null
    private var cameraLens: String? = null
    private var previewSize: android.util.Size? = null
    private var flashAvailable = false
    private var flashMode = FLASH_OFF
    private var previewRotationDegrees = 0

    private var generation = 0L
    private var pendingStartResult: MethodChannel.Result? = null
    private var pendingPhotoResult: MethodChannel.Result? = null
    private var photoTimeout: Runnable? = null
    private var disposed = false

    /** Delegates camera/photo methods and returns false for methods it does not own. */
    fun handle(call: MethodCall, result: MethodChannel.Result): Boolean {
        if (disposed) {
            error(result, "plugin_revoked", "hardware camera session is disposed")
            return true
        }
        val arguments = call.arguments as? Map<*, *> ?: emptyMap<Any?, Any?>()
        when (call.method) {
            "startCameraPreview" -> {
                startCameraPreview(arguments["lens"] as? String ?: LENS_BACK, result)
                return true
            }
            "stopCameraPreview" -> {
                stopCameraPreview(result)
                return true
            }
            "switchCameraLens" -> {
                val requested = arguments["lens"] as? String
                val target = requested ?: if (cameraLens == LENS_BACK) LENS_FRONT else LENS_BACK
                startCameraPreview(target, result)
                return true
            }
            "toggleCameraFlash" -> {
                toggleCameraFlash(arguments["flash"] as? String, result)
                return true
            }
            "capturePhoto" -> {
                capturePhoto(result)
                return true
            }
            "listSavedPhotos" -> {
                listSavedPhotos(result)
                return true
            }
            "deleteSavedPhoto" -> {
                deleteSavedPhoto(arguments["filePath"] as? String, result)
                return true
            }
            "disposeSession" -> {
                disposeSession(result)
                return true
            }
        }
        return false
    }

    /** Reflection-friendly entry point used by the host's thin transport plugin. */
    fun handle(method: String, args: Map<String, Any?>, result: MethodChannel.Result): Boolean =
        handle(MethodCall(method, args), result)

    /** Releases camera, texture, pending callbacks, and the camera worker. */
    fun dispose() {
        if (disposed) return
        disposed = true
        cameraHandler.post {
            pendingStartResult?.let {
                pendingStartResult = null
                error(it, "plugin_revoked", "hardware camera session is disposed")
            }
            closeCameraResources(releaseTexture = true)
            cameraThread.quitSafely()
        }
    }

    private fun startCameraPreview(lens: String, result: MethodChannel.Result) {
        if (lens != LENS_BACK && lens != LENS_FRONT) {
            error(result, "invalid_argument", "lens must be front or back")
            return
        }
        if (!cameraPermissionGranted()) {
            error(result, "hardware_permission_denied", "camera permission is not granted")
            return
        }
        val manager = cameraManager
        if (manager == null) {
            error(result, "hardware_unsupported", "Android camera service is unavailable")
            return
        }

        cameraHandler.post {
            if (disposed) {
                return@post
            }
            if (captureSession != null && cameraDevice != null && cameraLens == lens) {
                postSuccess(result, cameraResponse())
                return@post
            }

            pendingStartResult?.let {
                pendingStartResult = null
                error(it, "hardware_busy", "a camera preview request is already in progress")
            }
            pendingStartResult = result
            val requestGeneration = ++generation
            val hadTexture = textureEntry != null
            closeCameraResources(releaseTexture = false)

            try {
                val selectedId = findCameraId(manager, lens)
                if (selectedId == null) {
                    finishStartError(requestGeneration, "hardware_unsupported", "requested camera lens is unavailable", !hadTexture)
                    return@post
                }
                cameraId = selectedId
                cameraLens = lens
                val characteristics = manager.getCameraCharacteristics(selectedId)
                flashAvailable = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                val relativeRotation = relativePreviewRotation(characteristics)
                // Keep one transform path: the Flutter Texture surface
                // consumes this metadata. Applying Camera2 rotate-and-crop as
                // well would rotate twice on API 30+ and make source sizes
                // disagree with the JS surface snapshot.
                previewRotationDegrees = relativeRotation
                val streamMap = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                if (streamMap == null) {
                    finishStartError(requestGeneration, "hardware_unsupported", "camera output configuration is unavailable", !hadTexture)
                    return@post
                }
                val selectedSize = choosePreviewSize(streamMap.getOutputSizes(SurfaceTexture::class.java))
                    ?: run {
                        finishStartError(requestGeneration, "hardware_unsupported", "camera preview output is unavailable", !hadTexture)
                        return@post
                    }
                val jpegSize = chooseJpegSize(streamMap.getOutputSizes(ImageFormat.JPEG), selectedSize)
                    ?: run {
                        finishStartError(requestGeneration, "hardware_unsupported", "camera photo output is unavailable", !hadTexture)
                        return@post
                    }
                previewSize = selectedSize

                val entry = textureEntry ?: textureRegistry.createSurfaceTexture().also { textureEntry = it }
                entry.surfaceTexture().setDefaultBufferSize(selectedSize.width, selectedSize.height)
                previewSurface = Surface(entry.surfaceTexture())
                imageReader = ImageReader.newInstance(jpegSize.width, jpegSize.height, ImageFormat.JPEG, 2).also { reader ->
                    reader.setOnImageAvailableListener({ availableReader -> onPhotoAvailable(availableReader) }, cameraHandler)
                }

                manager.openCamera(
                    selectedId,
                    object : CameraDevice.StateCallback() {
                        override fun onOpened(device: CameraDevice) {
                            if (requestGeneration != generation || disposed) {
                                device.close()
                                return
                            }
                            cameraDevice = device
                            createCaptureSession(device, requestGeneration, !hadTexture)
                        }

                        override fun onDisconnected(device: CameraDevice) {
                            device.close()
                            if (requestGeneration == generation) {
                                finishStartError(requestGeneration, "hardware_camera_error", "camera was disconnected", !hadTexture)
                            }
                        }

                        override fun onError(device: CameraDevice, error: Int) {
                            device.close()
                            if (requestGeneration == generation) {
                                finishStartError(requestGeneration, "hardware_camera_error", "camera failed to open (code $error)", !hadTexture)
                            }
                        }
                    },
                    cameraHandler,
                )
            } catch (security: SecurityException) {
                finishStartError(requestGeneration, "hardware_permission_denied", security.message ?: "camera permission is not granted", !hadTexture)
            } catch (access: CameraAccessException) {
                finishStartError(requestGeneration, "hardware_camera_error", access.message ?: "camera access failed", !hadTexture)
            } catch (failure: Exception) {
                finishStartError(requestGeneration, "hardware_camera_error", failure.message ?: "camera failed to start", !hadTexture)
            }
        }
    }

    private fun createCaptureSession(
        device: CameraDevice,
        requestGeneration: Long,
        releaseTextureOnFailure: Boolean,
    ) {
        val outputSurface = previewSurface
        val readerSurface = imageReader?.surface
        if (outputSurface == null || readerSurface == null) {
            finishStartError(requestGeneration, "hardware_camera_error", "camera output surfaces are unavailable", releaseTextureOnFailure)
            return
        }
        try {
            device.createCaptureSession(
                listOf(outputSurface, readerSurface),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (requestGeneration != generation || disposed) {
                            session.close()
                            return
                        }
                        try {
                            captureSession = session
                            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                            request.addTarget(outputSurface)
                            configureRequest(request, false)
                            session.setRepeatingRequest(request.build(), null, cameraHandler)
                            val callback = pendingStartResult
                            pendingStartResult = null
                            if (callback != null) postSuccess(callback, cameraResponse())
                        } catch (failure: Exception) {
                            finishStartError(requestGeneration, "hardware_camera_error", failure.message ?: "camera preview failed to start", releaseTextureOnFailure)
                        }
                    }

                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        session.close()
                        finishStartError(requestGeneration, "hardware_camera_error", "camera preview session configuration failed", releaseTextureOnFailure)
                    }
                },
                cameraHandler,
            )
        } catch (failure: Exception) {
            finishStartError(requestGeneration, "hardware_camera_error", failure.message ?: "camera preview session failed", releaseTextureOnFailure)
        }
    }

    private fun stopCameraPreview(result: MethodChannel.Result) {
        cameraHandler.post {
            ++generation
            pendingStartResult?.let {
                pendingStartResult = null
                error(it, "plugin_revoked", "camera preview was stopped")
            }
            closeCameraResources(true)
            postSuccess(result, mapOf("ok" to true, "previewActive" to false, "realHardwareCamera" to true))
        }
    }

    private fun disposeSession(result: MethodChannel.Result) {
        cameraHandler.post {
            ++generation
            pendingStartResult?.let {
                pendingStartResult = null
                error(it, "plugin_revoked", "hardware session disposed")
            }
            closeCameraResources(true)
            postSuccess(result, mapOf("ok" to true, "disposed" to true))
        }
    }

    private fun toggleCameraFlash(requested: String?, result: MethodChannel.Result) {
        if (requested != null && requested !in FLASH_MODES) {
            error(result, "invalid_argument", "flash must be on, off or auto")
            return
        }
        cameraHandler.post {
            val device = cameraDevice
            val session = captureSession
            if (device == null || session == null) {
                error(result, "hardware_not_ready", "camera preview is not running")
                return@post
            }
            if (!flashAvailable) {
                error(result, "hardware_unsupported", "selected camera has no flash")
                return@post
            }
            flashMode = requested ?: if (flashMode == FLASH_OFF) FLASH_ON else FLASH_OFF
            try {
                val preview = previewSurface ?: throw IllegalStateException("camera preview surface is unavailable")
                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                request.addTarget(preview)
                configureRequest(request, false)
                session.setRepeatingRequest(request.build(), null, cameraHandler)
                postSuccess(result, mapOf("ok" to true, "flash" to flashMode, "realHardwareCamera" to true))
            } catch (failure: Exception) {
                error(result, "hardware_camera_error", failure.message ?: "flash update failed")
            }
        }
    }

    private fun capturePhoto(result: MethodChannel.Result) {
        cameraHandler.post {
            val device = cameraDevice
            val session = captureSession
            val reader = imageReader
            if (device == null || session == null || reader == null) {
                error(result, "hardware_not_ready", "camera preview is not running")
                return@post
            }
            if (pendingPhotoResult != null) {
                error(result, "hardware_busy", "a photo capture is already in progress")
                return@post
            }
            try {
                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                request.addTarget(reader.surface)
                configureRequest(request, true)
                pendingPhotoResult = result
                val timeout = Runnable {
                    val callback = pendingPhotoResult ?: return@Runnable
                    pendingPhotoResult = null
                    photoTimeout = null
                    error(callback, "hardware_timeout", "camera photo capture timed out")
                }
                photoTimeout = timeout
                cameraHandler.postDelayed(timeout, PHOTO_TIMEOUT_MS)
                session.capture(
                    request.build(),
                    object : CameraCaptureSession.CaptureCallback() {
                        override fun onCaptureFailed(
                            session: CameraCaptureSession,
                            request: CaptureRequest,
                            failure: CaptureFailure,
                        ) {
                            val callback = pendingPhotoResult ?: return
                            pendingPhotoResult = null
                            photoTimeout?.let(cameraHandler::removeCallbacks)
                            photoTimeout = null
                            error(callback, "hardware_capture_error", "camera capture failed (reason ${failure.reason})")
                        }
                    },
                    cameraHandler,
                )
            } catch (failure: Exception) {
                pendingPhotoResult = null
                photoTimeout?.let(cameraHandler::removeCallbacks)
                photoTimeout = null
                error(result, "hardware_capture_error", failure.message ?: "camera capture failed")
            }
        }
    }

    private fun onPhotoAvailable(reader: ImageReader) {
        val image = try {
            reader.acquireLatestImage()
        } catch (_: Exception) {
            null
        } ?: return
        var callback: MethodChannel.Result? = null
        try {
            callback = pendingPhotoResult ?: return
            pendingPhotoResult = null
            photoTimeout?.let(cameraHandler::removeCallbacks)
            photoTimeout = null
            val buffer = image.planes.firstOrNull()?.buffer
                ?: throw IllegalStateException("camera returned no photo data")
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            val directory = photoDirectory()
            if (!directory.exists() && !directory.mkdirs()) {
                throw IllegalStateException("unable to create private photo directory")
            }
            val fileName = "POCKET_IMG_${System.currentTimeMillis()}.jpg"
            val file = File(directory, fileName)
            FileOutputStream(file).use { output -> output.write(bytes) }
            postSuccess(
                callback,
                mapOf(
                    "ok" to true,
                    "realHardwareCamera" to true,
                    "fileName" to fileName,
                    "filePath" to file.canonicalPath,
                    "sizeBytes" to file.length(),
                    "sizeKB" to (file.length() / 1024.0),
                    "width" to image.width,
                    "height" to image.height,
                    "lens" to (cameraLens ?: LENS_BACK),
                    "flash" to flashMode,
                    "timestamp" to isoTimestamp(Date()),
                    "savedToAlbum" to false,
                    "storage" to STORAGE_PRIVATE,
                    "albumErrorCode" to "android_private_storage",
                ),
            )
        } catch (failure: Exception) {
            if (callback != null) error(callback, "hardware_storage_error", failure.message ?: "photo could not be saved")
        } finally {
            image.close()
        }
    }

    private fun listSavedPhotos(result: MethodChannel.Result) {
        cameraHandler.post {
            try {
                postSuccess(
                    result,
                    mapOf("ok" to true, "photos" to listPhotos(), "realHardwareCamera" to true, "storage" to STORAGE_PRIVATE),
                )
            } catch (failure: Exception) {
                error(result, "hardware_storage_error", failure.message ?: "photo list failed")
            }
        }
    }

    private fun deleteSavedPhoto(path: String?, result: MethodChannel.Result) {
        if (path.isNullOrBlank()) {
            error(result, "invalid_argument", "filePath must not be empty")
            return
        }
        cameraHandler.post {
            try {
                val directory = photoDirectory().canonicalFile
                val file = File(path).canonicalFile
                if (!file.path.startsWith(directory.path + File.separator)) {
                    error(result, "invalid_argument", "photo path is outside the host photo directory")
                    return@post
                }
                if (!file.exists()) {
                    error(result, "hardware_not_found", "photo does not exist")
                    return@post
                }
                if (!file.delete()) {
                    error(result, "hardware_storage_error", "photo could not be deleted")
                    return@post
                }
                postSuccess(
                    result,
                    mapOf("ok" to true, "deleted" to true, "photos" to listPhotos(), "realHardwareCamera" to true, "storage" to STORAGE_PRIVATE),
                )
            } catch (failure: Exception) {
                error(result, "hardware_storage_error", failure.message ?: "photo delete failed")
            }
        }
    }

    private fun listPhotos(): List<Map<String, Any>> {
        val directory = photoDirectory()
        if (!directory.exists() && !directory.mkdirs()) {
            throw IllegalStateException("unable to create private photo directory")
        }
        return directory.listFiles()
            ?.asSequence()
            ?.filter { it.isFile && (it.extension.equals("jpg", true) || it.extension.equals("jpeg", true)) }
            ?.sortedByDescending { it.name }
            ?.map {
                mapOf(
                    "fileName" to it.name,
                    "filePath" to it.canonicalPath,
                    "sizeBytes" to it.length(),
                    "sizeKB" to (it.length() / 1024.0),
                    "modifiedAt" to isoTimestamp(Date(it.lastModified())),
                )
            }
            ?.toList()
            ?: emptyList()
    }

    private fun configureRequest(request: CaptureRequest.Builder, forStill: Boolean) {
        request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
        request.set(
            CaptureRequest.CONTROL_AE_MODE,
            when (flashMode) {
                FLASH_ON -> if (forStill) CaptureRequest.CONTROL_AE_MODE_ON_ALWAYS_FLASH else CaptureRequest.CONTROL_AE_MODE_ON
                FLASH_AUTO -> CaptureRequest.CONTROL_AE_MODE_ON_AUTO_FLASH
                else -> CaptureRequest.CONTROL_AE_MODE_ON
            },
        )
        if (!forStill && flashAvailable && flashMode == FLASH_ON) {
            request.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH)
        } else {
            request.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
        }
        if (forStill) request.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation())
    }

    private fun cameraResponse(): Map<String, Any?> = mapOf(
        "ok" to true,
        "previewActive" to true,
        "textureId" to textureEntry?.id(),
        "width" to previewSize?.width,
        "height" to previewSize?.height,
        "lens" to cameraLens,
        "flash" to flashMode,
        "previewRotationDegrees" to previewRotationDegrees,
        // Camera2 does not mirror a front-facing stream. This is an explicit
        // transform request for the JS/Flutter surface layer, not a false
        // claim that the native SurfaceTexture is already mirrored.
        "previewMirrorX" to (cameraLens == LENS_FRONT),
        "realHardwareCamera" to true,
    )

    private fun finishStartError(generationAtRequest: Long, code: String, message: String, releaseTexture: Boolean) {
        if (generationAtRequest != generation) return
        val callback = pendingStartResult
        pendingStartResult = null
        closeCameraResources(releaseTexture)
        if (callback != null) error(callback, code, message)
    }

    private fun closeCameraResources(releaseTexture: Boolean) {
        pendingPhotoResult?.let {
            pendingPhotoResult = null
            photoTimeout?.let(cameraHandler::removeCallbacks)
            photoTimeout = null
            error(it, "plugin_revoked", "camera session was closed")
        }
        try {
            captureSession?.stopRepeating()
        } catch (_: Exception) {
            // Camera2 may already have closed the session.
        }
        captureSession?.close()
        cameraDevice?.close()
        imageReader?.setOnImageAvailableListener(null, null)
        imageReader?.close()
        previewSurface?.release()
        captureSession = null
        cameraDevice = null
        imageReader = null
        previewSurface = null
        cameraId = null
        cameraLens = null
        previewSize = null
        flashAvailable = false
        flashMode = FLASH_OFF
        previewRotationDegrees = 0
        if (releaseTexture) {
            textureEntry?.release()
            textureEntry = null
        }
    }

    private fun findCameraId(manager: CameraManager, lens: String): String? {
        val requestedFacing = if (lens == LENS_FRONT) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        return manager.cameraIdList.firstOrNull { id ->
            manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == requestedFacing
        }
    }

    private fun choosePreviewSize(sizes: Array<android.util.Size>?): android.util.Size? {
        val candidates = sizes?.toList().orEmpty()
        if (candidates.isEmpty()) return null
        return candidates.filter { it.width <= MAX_PREVIEW_EDGE && it.height <= MAX_PREVIEW_EDGE }
            .maxByOrNull { it.width.toLong() * it.height.toLong() }
            ?: candidates.minByOrNull { abs(it.width - 1280) + abs(it.height - 720) }
    }

    private fun chooseJpegSize(sizes: Array<android.util.Size>?, preview: android.util.Size): android.util.Size? {
        val candidates = sizes?.toList().orEmpty()
        if (candidates.isEmpty()) return null
        val previewRatio = preview.width.toDouble() / preview.height.toDouble()
        return candidates.filter { it.width.toLong() * it.height.toLong() <= MAX_PHOTO_PIXELS }
            .minByOrNull {
                abs((it.width.toDouble() / it.height.toDouble()) - previewRatio) * 10000 +
                    abs(it.width - preview.width) + abs(it.height - preview.height)
            }
            ?: candidates.minByOrNull { abs(it.width - preview.width) + abs(it.height - preview.height) }
    }

    private fun jpegOrientation(): Int {
        val id = cameraId ?: return 0
        return try {
            cameraManager?.getCameraCharacteristics(id)?.let(::relativePreviewRotation) ?: 0
        } catch (_: Exception) {
            0
        }
    }

    private fun relativePreviewRotation(characteristics: CameraCharacteristics): Int {
        val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val deviceOrientation = displayRotationDegrees()
        val frontFacing = characteristics.get(CameraCharacteristics.LENS_FACING) ==
            CameraCharacteristics.LENS_FACING_FRONT
        // Same relative-rotation convention used by CameraX: back cameras
        // rotate opposite to display rotation, front cameras with it.
        val sign = if (frontFacing) 1 else -1
        return (sensorOrientation - deviceOrientation * sign + 360) % 360
    }

    private fun displayRotationDegrees(): Int {
        val rotation = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                context.display?.rotation
                    ?: (context.getSystemService(Context.WINDOW_SERVICE) as? android.view.WindowManager)
                        ?.defaultDisplay
                        ?.rotation
                    ?: Surface.ROTATION_0
            } else {
                @Suppress("DEPRECATION")
                (context.getSystemService(Context.WINDOW_SERVICE) as? android.view.WindowManager)
                    ?.defaultDisplay
                    ?.rotation
                    ?: Surface.ROTATION_0
            }
        } catch (_: Exception) {
            Surface.ROTATION_0
        }
        return when (rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    private fun cameraPermissionGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun photoDirectory(): File = File(context.filesDir, PHOTO_DIRECTORY)

    private fun isoTimestamp(date: Date): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(date)

    private fun postSuccess(result: MethodChannel.Result, value: Any?) {
        mainHandler.post { result.success(value) }
    }

    private fun error(result: MethodChannel.Result, code: String, message: String) {
        // The cross-platform hardware contract represents capability and
        // permission failures as a normal response object.  Dart's native
        // adapter turns `ok: false` into PocketCapabilityException, matching
        // the iOS manager and avoiding a PlatformException-only code path.
        mainHandler.post {
            result.success(
                linkedMapOf(
                    "ok" to false,
                    "errorCode" to code,
                    "error" to message,
                    "errorMessage" to message,
                ),
            )
        }
    }

    private companion object {
        const val LENS_BACK = "back"
        const val LENS_FRONT = "front"
        const val FLASH_OFF = "off"
        const val FLASH_ON = "on"
        const val FLASH_AUTO = "auto"
        const val PHOTO_DIRECTORY = "pocket_photos"
        const val STORAGE_PRIVATE = "app-private"
        const val MAX_PREVIEW_EDGE = 1280
        const val MAX_PHOTO_PIXELS = 8_000_000L
        const val PHOTO_TIMEOUT_MS = 10_000L
        val FLASH_MODES = setOf(FLASH_OFF, FLASH_ON, FLASH_AUTO)
    }
}
