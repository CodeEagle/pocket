package dev.pocketjs.pocket_archive

import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Arrays
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger

/** File-path transport from Flutter to the shared Pocket archive core. */
class PocketArchivePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val CHANNEL_NAME = "dev.pocketjs/pocket_archive"
        private const val NATIVE_ERROR_BUFFER_SIZE = 512
        private const val MAX_ARGUMENT_BYTES = 1 shl 20

        init {
            System.loadLibrary("pocket_archive")
        }
    }

    private val threadNumber = AtomicInteger(1)
    private var executor: ExecutorService = createExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var channel: MethodChannel? = null

    private fun createExecutor(): ExecutorService = Executors.newSingleThreadExecutor { task ->
        Thread(task, "pocket-archive-${threadNumber.getAndIncrement()}").apply {
            isDaemon = true
        }
    }

    private external fun nativeExtract(
        archivePathUtf8: ByteArray,
        destinationPathUtf8: ByteArray,
        passwordUtf8: ByteArray?,
        maxOutputBytes: Long,
        errorBuffer: ByteArray,
    ): Int

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        if (executor.isShutdown) executor = createExecutor()
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        // Let an in-flight native extraction finish before its Dart future is
        // released; shutdown only prevents new work after channel detachment.
        executor.shutdown()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "extract") {
            result.notImplemented()
            return
        }
        val arguments = call.arguments as? Map<*, *>
        if (arguments == null) {
            result.error("invalid_argument", "extract expects an argument map", null)
            return
        }

        val archivePath = arguments["archivePath"] as? String
        val destinationPath = arguments["destinationPath"] as? String
        val passwordArgument = arguments["password"]
        val password = when (passwordArgument) {
            null -> null
            is String -> passwordArgument
            else -> {
                result.error("invalid_argument", "password must be a string or null", null)
                return
            }
        }
        val maxOutputBytes = positiveLong(arguments["maxOutputBytes"])

        if (archivePath.isNullOrEmpty() || destinationPath.isNullOrEmpty() ||
            !File(archivePath).isAbsolute || !File(destinationPath).isAbsolute ||
            archivePath.indexOf('\u0000') >= 0 || destinationPath.indexOf('\u0000') >= 0 ||
            (password?.indexOf('\u0000') ?: -1) >= 0 || maxOutputBytes == null ||
            archivePath.length > MAX_ARGUMENT_BYTES ||
            destinationPath.length > MAX_ARGUMENT_BYTES ||
            (password?.length ?: 0) > MAX_ARGUMENT_BYTES
        ) {
            result.error(
                "invalid_argument",
                "archivePath and destinationPath must be absolute, NUL-free strings, and maxOutputBytes must be a positive integer",
                null,
            )
            return
        }

        val archiveUtf8 = archivePath.toByteArray(StandardCharsets.UTF_8)
        val destinationUtf8 = destinationPath.toByteArray(StandardCharsets.UTF_8)
        val passwordUtf8 = password?.takeIf { it.isNotEmpty() }
            ?.toByteArray(StandardCharsets.UTF_8)
        if (archiveUtf8.size > MAX_ARGUMENT_BYTES ||
            destinationUtf8.size > MAX_ARGUMENT_BYTES ||
            (passwordUtf8?.size ?: 0) > MAX_ARGUMENT_BYTES
        ) {
            Arrays.fill(archiveUtf8, 0)
            Arrays.fill(destinationUtf8, 0)
            passwordUtf8?.let { Arrays.fill(it, 0) }
            result.error("invalid_argument", "archive arguments exceed the supported size", null)
            return
        }

        try {
            executor.execute {
                val errorBuffer = ByteArray(NATIVE_ERROR_BUFFER_SIZE)
                try {
                    val status = nativeExtract(
                        archiveUtf8,
                        destinationUtf8,
                        passwordUtf8,
                        maxOutputBytes,
                        errorBuffer,
                    )
                    if (status == 0) {
                        postSuccess(result)
                    } else {
                        val nativeMessage = decodeNativeError(errorBuffer)
                        postError(
                            result,
                            "archive_extract_failed",
                            nativeMessage.ifEmpty { "native archive extraction failed" },
                            mapOf("nativeStatus" to status),
                        )
                    }
                } catch (error: Throwable) {
                    postError(
                        result,
                        "archive_extract_failed",
                        error.message ?: "native archive extraction failed",
                        mapOf("exception" to error.javaClass.name),
                    )
                } finally {
                    Arrays.fill(archiveUtf8, 0)
                    Arrays.fill(destinationUtf8, 0)
                    passwordUtf8?.let { Arrays.fill(it, 0) }
                    Arrays.fill(errorBuffer, 0)
                }
            }
        } catch (error: RejectedExecutionException) {
            Arrays.fill(archiveUtf8, 0)
            Arrays.fill(destinationUtf8, 0)
            passwordUtf8?.let { Arrays.fill(it, 0) }
            postError(result, "archive_unavailable", "archive extraction is unavailable", null)
        }
    }

    private fun positiveLong(value: Any?): Long? {
        val parsed = when (value) {
            is Int -> value.toLong()
            is Long -> value
            else -> return null
        }
        return parsed.takeIf { it > 0L }
    }

    private fun decodeNativeError(errorBuffer: ByteArray): String {
        val length = errorBuffer.indexOf(0).let { if (it < 0) errorBuffer.size else it }
        return String(errorBuffer, 0, length, StandardCharsets.US_ASCII)
    }

    private fun postSuccess(result: MethodChannel.Result) {
        mainHandler.post { result.success(null) }
    }

    private fun postError(
        result: MethodChannel.Result,
        code: String,
        message: String,
        details: Any?,
    ) {
        mainHandler.post { result.error(code, message, details) }
    }
}
