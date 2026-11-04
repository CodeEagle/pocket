import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io' show File, Platform;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'pocket_binary_codec.dart';
import 'pocket_duplex.dart';
import 'pocket_model.dart';
import 'pocket_memory_limits.dart';
import 'pocket_offload_runtime.dart';
import 'pocket_recording.dart';
import 'pocket_worker_runtime.dart';

part 'pocket_offload_binding.dart';

/// The narrow ABI shared by the Flutter side and the PocketJS host library.
///
/// The native implementation owns the QuickJS/PocketJS instance. Legacy
/// runtimes expose a JSON frame; current runtimes additionally expose a
/// compact borrowed binary frame ABI. Dart copies either result before making
/// another native call, so no native pointer is retained by this class.
abstract interface class PocketRuntime {
  PocketFrame eval(String source);

  /// Loads a guest source together with its PocketJS `.pak` bytes.
  ///
  /// The default keeps injected test runtimes and source-only hosts source
  /// compatible. The real FFI implementation overrides this and copies the
  /// package into the native guest before requesting the first frame.
  PocketFrame load(String source, Uint8List pak) => eval(source);

  /// Legacy integer-delta entry point retained for injected runtimes.
  PocketFrame frame(int deltaMilliseconds);

  /// Enables the optional PocketJS auxiliary DrawList before the guest is
  /// loaded. Injected test runtimes keep the default no-op implementation;
  /// the real FFI runtime forwards the viewport to native once per handle.
  void enableAuxiliary(double width, double height) {}

  /// Resizes a mounted guest without recreating its QuickJS realm.
  ///
  /// Implementations backed by an older native library return false. Injected
  /// runtimes keep the no-op default so existing tests and hosts retain their
  /// original fixed viewport contract.
  bool resizeViewport(double width, double height) => false;

  void send(Map<String, dynamic> message);

  String? get lastError;

  void dispose();
}

/// Optional trusted compositor configuration installed before guest evaluation.
abstract interface class PocketCompositorRuntime {
  void configureCompositor(Map<String, int> applications);
}

/// Optional scheduling snapshot for runtimes that know when the guest next
/// needs a frame. Values follow the native `pocket_next_wake_delay_ms` ABI:
/// negative means indefinitely idle, zero means continuous/unknown, and a
/// positive finite value is the delay to the next virtual timer deadline.
///
/// This stays separate from [PocketRuntime] so existing injected runtimes keep
/// their source-compatible contract and safely continue to use vsync.
abstract interface class PocketRuntimeScheduling {
  double get nextWakeDelayMilliseconds;
}

/// Returns a runtime's optional scheduling snapshot. Runtimes without the
/// capability are treated as continuously active; the renderer must not infer
/// legacy timer deadlines by periodically probing them.
double pocketNextWakeDelayMilliseconds(PocketRuntime runtime) =>
    runtime is PocketRuntimeScheduling
    ? (runtime as PocketRuntimeScheduling).nextWakeDelayMilliseconds
    : 0.0;

/// Optional capability implemented by native runtimes that can admit real
/// QuickJS bytecode. Keeping this separate preserves source-only injected
/// runtimes without introducing a source fallback.
abstract interface class PocketBytecodeRuntime {
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  });

  String? get actualAbi;
}

extension PocketRuntimeBytecode on PocketRuntime {
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) {
    final runtime = this;
    if (runtime is PocketBytecodeRuntime) {
      return (runtime as PocketBytecodeRuntime).loadBytecode(
        bytecode,
        pak,
        expectedRuntimeAbi: expectedRuntimeAbi,
      );
    }
    throw UnsupportedError('QuickJS bytecode is unavailable');
  }

  String? get actualAbi => this is PocketBytecodeRuntime
      ? (this as PocketBytecodeRuntime).actualAbi
      : null;
}

class PocketRuntimeException implements Exception {
  const PocketRuntimeException(this.message);

  final String message;

  @override
  String toString() => 'PocketRuntimeException: $message';
}

/// Build-time metadata paired with `app.qjbc`. The native envelope remains
/// authoritative for cryptographic verification; this signed/asset metadata
/// binds the Flutter package entry to the host ABI and fixed tick rate before
/// any native allocation or evaluation.
final class PocketBytecodeMetadata {
  const PocketBytecodeMetadata({
    required this.entryFormat,
    required this.formatVersion,
    required this.kind,
    required this.bindingGeneration,
    required this.tickHz,
    required this.runtimeAbi,
    required this.bytecodeBytes,
    this.engineAbi,
    this.sourceSha256,
    this.payloadSha256,
  });

  factory PocketBytecodeMetadata.fromJsonString(String source) {
    final decoded = jsonDecode(source);
    if (decoded is! Map) {
      throw const PocketRuntimeException(
        'bytecode metadata must be a JSON object',
      );
    }
    Object? field(String name) => decoded[name];
    String requiredString(String name) {
      final value = field(name);
      if (value is! String || value.trim().isEmpty) {
        throw PocketRuntimeException('bytecode metadata $name is required');
      }
      return value;
    }

    int requiredInt(String name) {
      final value = field(name);
      if (value is! num || !value.isFinite || value % 1 != 0) {
        throw PocketRuntimeException(
          'bytecode metadata $name must be an integer',
        );
      }
      return value.toInt();
    }

    return PocketBytecodeMetadata(
      entryFormat: requiredString('entryFormat'),
      formatVersion: requiredInt('formatVersion'),
      kind: requiredString('kind'),
      bindingGeneration: requiredInt('bindingGeneration'),
      tickHz: requiredInt('tickHz'),
      runtimeAbi: requiredString('runtimeAbi'),
      bytecodeBytes: requiredInt('bytecodeBytes'),
      engineAbi: field('engineAbi') is String
          ? field('engineAbi') as String
          : null,
      sourceSha256: field('sourceSha256') is String
          ? field('sourceSha256') as String
          : null,
      payloadSha256: field('payloadSha256') is String
          ? field('payloadSha256') as String
          : null,
    );
  }

  final String entryFormat;
  final int formatVersion;
  final String kind;
  final int bindingGeneration;
  final int tickHz;
  final String runtimeAbi;
  final int bytecodeBytes;
  final String? engineAbi;
  final String? sourceSha256;
  final String? payloadSha256;
}

/// Drives a runtime with a fractional scheduler delta when the concrete host
/// supports it. Existing injected runtimes only implement the original
/// integer [PocketRuntime.frame] contract and are rounded at this boundary.
PocketFrame pocketFrameAt(PocketRuntime runtime, double deltaMilliseconds) {
  if (runtime is FfiPocketRuntime) {
    return runtime.frameAt(deltaMilliseconds);
  }
  return runtime.frame(deltaMilliseconds.round());
}

/// Same as [pocketFrameAt], but returns `null` when the native delta ABI
/// proves that the retained visual frame is unchanged. Older libraries and
/// injected runtimes take the full-frame fallback and never return null.
PocketFrame? pocketFrameDeltaAt(
  PocketRuntime runtime,
  double deltaMilliseconds,
) {
  if (runtime is FfiPocketRuntime) {
    return runtime.frameDeltaAt(deltaMilliseconds);
  }
  return runtime.frame(deltaMilliseconds.round());
}

double _finiteNonNegativeDelta(double deltaMilliseconds) =>
    deltaMilliseconds.isFinite && deltaMilliseconds > 0
    ? deltaMilliseconds
    : 0.0;

typedef _CreateNative = Pointer<Void> Function(Double width, Double height);
typedef _CreateDart = Pointer<Void> Function(double width, double height);
typedef _CreateDensityNative = Pointer<Void> Function(Double, Double, Uint32);
typedef _CreateDensityDart = Pointer<Void> Function(double, double, int);
typedef _CreateDensityTickNative =
    Pointer<Void> Function(Double, Double, Uint32, Uint32);
typedef _CreateDensityTickDart =
    Pointer<Void> Function(double, double, int, int);
typedef _CreateMemoryNative =
    Pointer<Void> Function(Double, Double, Uint32, Uint32, Uint64, Uint64);
typedef _CreateMemoryDart =
    Pointer<Void> Function(double, double, int, int, int, int);
typedef _EvalNative = Int32 Function(Pointer<Void>, Pointer<Utf8> source);
typedef _EvalDart = int Function(Pointer<Void>, Pointer<Utf8> source);
typedef _LoadNative =
    Int32 Function(
      Pointer<Void>,
      Pointer<Utf8> source,
      Pointer<Uint8> pak,
      IntPtr pakLength,
    );
typedef _LoadDart =
    int Function(
      Pointer<Void>,
      Pointer<Utf8> source,
      Pointer<Uint8> pak,
      int pakLength,
    );
typedef _LoadFilesNative =
    Int32 Function(
      Pointer<Void>,
      Pointer<Utf8> sourcePath,
      Pointer<Utf8> pakPath,
    );
typedef _LoadFilesDart =
    int Function(
      Pointer<Void>,
      Pointer<Utf8> sourcePath,
      Pointer<Utf8> pakPath,
    );
typedef _LoadBytecodeNative =
    Int32 Function(
      Pointer<Void>,
      Pointer<Uint8> bytecode,
      IntPtr bytecodeLength,
      Pointer<Uint8> pak,
      IntPtr pakLength,
    );
typedef _LoadBytecodeDart =
    int Function(
      Pointer<Void>,
      Pointer<Uint8> bytecode,
      int bytecodeLength,
      Pointer<Uint8> pak,
      int pakLength,
    );
typedef _LoadBytecodeFilesNative =
    Int32 Function(
      Pointer<Void>,
      Pointer<Utf8> bytecodePath,
      Pointer<Utf8> pakPath,
    );
typedef _LoadBytecodeFilesDart =
    int Function(
      Pointer<Void>,
      Pointer<Utf8> bytecodePath,
      Pointer<Utf8> pakPath,
    );
typedef _FrameNative = Pointer<Utf8> Function(Pointer<Void>, Double deltaMs);
typedef _FrameDart = Pointer<Utf8> Function(Pointer<Void>, double deltaMs);
typedef _FrameBinaryNative =
    Pointer<Uint8> Function(
      Pointer<Void>,
      Double deltaMs,
      Pointer<Uint64> outByteLength,
    );
typedef _FrameBinaryDart =
    Pointer<Uint8> Function(
      Pointer<Void>,
      double deltaMs,
      Pointer<Uint64> outByteLength,
    );
typedef _NextWakeDelayNative = Double Function(Pointer<Void>);
typedef _NextWakeDelayDart = double Function(Pointer<Void>);
typedef _SetSchedulerPausedNative = Void Function(Pointer<Void>, Int32 paused);
typedef _SetSchedulerPausedDart = void Function(Pointer<Void>, int paused);
typedef _TraceClockModeNative = Int32 Function(Pointer<Void>, Uint32 mode);
typedef _TraceClockModeDart = int Function(Pointer<Void>, int mode);
typedef _TraceClockBeginNative =
    Int32 Function(Pointer<Void>, Pointer<Utf8> envelope);
typedef _TraceClockBeginDart =
    int Function(Pointer<Void>, Pointer<Utf8> envelope);
typedef _TraceClockEndNative = Pointer<Utf8> Function(Pointer<Void>);
typedef _TraceClockEndDart = Pointer<Utf8> Function(Pointer<Void>);
typedef _WorkerWakeNative = Void Function();
typedef _ConfigureWorkerNative =
    Int32 Function(
      Pointer<Void>,
      Pointer<Uint8>,
      UintPtr,
      Pointer<Utf8>,
      Pointer<NativeFunction<_WorkerWakeNative>>,
    );
typedef _ConfigureWorkerDart =
    int Function(
      Pointer<Void>,
      Pointer<Uint8>,
      int,
      Pointer<Utf8>,
      Pointer<NativeFunction<_WorkerWakeNative>>,
    );
typedef _StopAsyncNative = Int32 Function(Pointer<Void>);
typedef _StopAsyncDart = int Function(Pointer<Void>);

typedef _ConfigureCompositorNative =
    Int32 Function(Pointer<Void>, Pointer<Utf8>);
typedef _ConfigureCompositorDart = int Function(Pointer<Void>, Pointer<Utf8>);

typedef _EnableAuxiliaryNative =
    Int32 Function(Pointer<Void>, Double width, Double height);
typedef _EnableAuxiliaryDart =
    int Function(Pointer<Void>, double width, double height);
typedef _ResizeViewportNative =
    Int32 Function(Pointer<Void>, Double width, Double height);
typedef _ResizeViewportDart =
    int Function(Pointer<Void>, double width, double height);
typedef _SendNative = Int32 Function(Pointer<Void>, Pointer<Utf8> message);
typedef _SendDart = int Function(Pointer<Void>, Pointer<Utf8> message);
typedef _SendBinaryNative =
    Int32 Function(Pointer<Void>, Pointer<Uint8> data, UintPtr len);
typedef _SendBinaryDart =
    int Function(Pointer<Void>, Pointer<Uint8> data, int len);
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);
typedef _StringNative = Pointer<Utf8> Function(Pointer<Void>);
typedef _StringDart = Pointer<Utf8> Function(Pointer<Void>);
typedef _AbiNative = Pointer<Utf8> Function();
typedef _AbiDart = Pointer<Utf8> Function();
typedef _DuplexStepNative = Int32 Function(Pointer<Void>);
typedef _DuplexStepDart = int Function(Pointer<Void>);
typedef _DuplexEndpointAcquireNative = Pointer<Void> Function(Pointer<Void>);
typedef _DuplexEndpointAcquireDart = Pointer<Void> Function(Pointer<Void>);
typedef _DuplexEndpointReleaseNative = Void Function(Pointer<Void>);
typedef _DuplexEndpointReleaseDart = void Function(Pointer<Void>);
typedef _DuplexReserveNative =
    Pointer<Uint8> Function(
      Pointer<Void>,
      Uint32 maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _DuplexReserveDart =
    Pointer<Uint8> Function(
      Pointer<Void>,
      int maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _DuplexCommitNative = Int32 Function(Pointer<Void>, Uint32 count);
typedef _DuplexCommitDart = int Function(Pointer<Void>, int count);
typedef _DuplexPeekNative =
    Pointer<Uint8> Function(
      Pointer<Void>,
      Uint32 maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _DuplexPeekDart =
    Pointer<Uint8> Function(
      Pointer<Void>,
      int maxMessages,
      Pointer<Uint32> outCount,
    );
typedef _DuplexU32Native = Uint32 Function();
typedef _DuplexU32Dart = int Function();

/// FFI binding to the PocketJS host. Apple targets link the static archive into
/// the runner process; Android packages the shared library in the APK.
final class FfiPocketRuntime
    implements
        PocketRuntime,
        PocketRuntimeScheduling,
        PocketCompositorRuntime,
        PocketWorkerRuntime,
        PocketOffloadRuntime,
        PocketBytecodeRuntime,
        PocketBinaryDuplexRuntime {
  FfiPocketRuntime._({
    required DynamicLibrary library,
    required Pointer<Void> handle,
    PocketRecordingController? recording,
    this.memoryLimits = const PocketMemoryLimits(),
  }) : _library = library,
       _handle = handle,
       _recordingController = recording?.enabled == true ? recording : null,
       _eval = library.lookupFunction<_EvalNative, _EvalDart>('pocket_eval'),
       _frame = library.lookupFunction<_FrameNative, _FrameDart>(
         'pocket_frame',
       ),
       _send = library.lookupFunction<_SendNative, _SendDart>('pocket_send'),
       _destroy = library.lookupFunction<_DestroyNative, _DestroyDart>(
         'pocket_destroy',
       ),
       _lastError = library.lookupFunction<_StringNative, _StringDart>(
         'pocket_last_error',
       );

  final DynamicLibrary _library;
  final PocketMemoryLimits memoryLimits;
  final Pointer<Void> _handle;
  final PocketRecordingController? _recordingController;
  final _EvalDart _eval;
  final _FrameDart _frame;
  _FrameBinaryDart? _frameBinary;
  bool _frameBinaryLookedUp = false;
  _FrameDart? _frameDelta;
  bool _frameDeltaLookedUp = false;
  _FrameBinaryDart? _frameDeltaBinary;
  bool _frameDeltaBinaryLookedUp = false;
  String _lastFrameDeltaMode = 'full';
  _NextWakeDelayDart? _nextWakeDelay;
  bool _nextWakeDelayLookedUp = false;
  _SetSchedulerPausedDart? _setSchedulerPaused;
  bool _setSchedulerPausedLookedUp = false;
  _TraceClockModeDart? _traceClockMode;
  _TraceClockBeginDart? _traceClockBegin;
  _TraceClockEndDart? _traceClockEnd;
  _StopAsyncDart? _stopAsync;
  bool _traceClockLookedUp = false;
  bool _stopAsyncLookedUp = false;
  bool _traceClockConfigured = false;
  bool _traceClockReplayMode = false;
  bool _traceTransactionActive = false;
  Map<String, dynamic>? _pendingReplayTraceClock;
  Map<String, dynamic>? _lastTraceClock;
  bool _messageWasRedacted = false;
  _EnableAuxiliaryDart? _enableAuxiliary;
  _ResizeViewportDart? _resizeViewport;
  bool _resizeViewportLookedUp = false;
  final _SendDart _send;
  _SendBinaryDart? _sendBinary;
  bool _sendBinaryLookedUp = false;
  final _DestroyDart _destroy;
  final _StringDart _lastError;
  _LoadDart? _load;
  _LoadFilesDart? _loadFiles;
  bool _loadFilesLookedUp = false;
  _LoadBytecodeDart? _loadBytecode;
  _LoadBytecodeFilesDart? _loadBytecodeFiles;
  bool _loadBytecodeFilesLookedUp = false;
  _AbiDart? _actualAbi;
  bool _actualAbiLookedUp = false;
  _DuplexStepDart? _duplexStep;
  bool _duplexStepLookedUp = false;
  _DuplexEndpointAcquireDart? _duplexEndpointAcquire;
  _DuplexEndpointReleaseDart? _duplexEndpointRelease;
  Pointer<NativeFunction<_DuplexEndpointReleaseNative>>?
  _duplexEndpointReleasePointer;
  _DuplexReserveDart? _duplexIngressReserve;
  _DuplexCommitDart? _duplexIngressPublish;
  _DuplexPeekDart? _duplexEgressPeek;
  _DuplexCommitDart? _duplexEgressConsume;
  _DuplexU32Dart? _duplexAbiVersion;
  _DuplexU32Dart? _duplexMessageSize;
  _DuplexU32Dart? _duplexCapacity;
  bool _duplexEndpointBindingsLookedUp = false;
  bool _duplexAbiValidated = false;
  final List<_FfiPocketDuplexEndpoint> _duplexEndpoints =
      <_FfiPocketDuplexEndpoint>[];
  bool _disposed = false;
  NativeCallable<_WorkerWakeNative>? _workerWake;
  bool _workerConfigured = false;
  bool _asyncStopped = false;
  _PocketOffloadBinding? _offloadBinding;
  bool _offloadReplayConfigured = false;

  /// Opens a real QuickJS/PocketJS host. [tickHz] must match the bundle's
  /// compiler `--hz` value; it is not the display refresh rate. The native
  /// fixed-step clock uses the fractional delta supplied by [frameAt] and may
  /// advance multiple 120-Hz guest turns on a 60-Hz Flutter ticker.
  static FfiPocketRuntime open({
    double width = 360,
    double height = 640,
    int rasterDensity = 1,
    int tickHz = 60,
    PocketRecordingController? recording,
    PocketMemoryLimits memoryLimits = const PocketMemoryLimits(),
  }) {
    memoryLimits.validate();
    if (rasterDensity < 1 || rasterDensity > 4) {
      throw RangeError.range(rasterDensity, 1, 4, 'rasterDensity');
    }
    if (tickHz < 1 || tickHz > 120) {
      throw RangeError.range(tickHz, 1, 120, 'tickHz');
    }
    final library = _openLibrary();
    final handle = FfiPocketRuntime._createHandle(
      library,
      width,
      height,
      rasterDensity,
      tickHz,
      memoryLimits,
    );
    if (handle.address == 0) {
      throw const PocketRuntimeException(
        'pocket_create returned a null handle',
      );
    }
    // Native creation can return an opaque handle carrying an initialization
    // error (for example, when the compositor capability could not be
    // installed). Do not let an unusable handle escape into the widget tree.
    final runtime = FfiPocketRuntime._(
      library: library,
      handle: handle,
      recording: recording,
      memoryLimits: memoryLimits,
    );
    final error = runtime.lastError;
    if (error != null && error.isNotEmpty) {
      runtime.dispose();
      throw PocketRuntimeException('pocket_create failed: $error');
    }
    if (recording?.enabled == true) {
      try {
        runtime._setTraceClockMode(1);
        recording!.start(
          PocketRecordingMetadata(
            width: width,
            height: height,
            density: rasterDensity,
            tickHz: tickHz,
            engineAbi: runtime.actualAbi,
            memoryLimits: memoryLimits,
          ),
        );
        recording.bindBeforeFinish(runtime._captureStopBoundary);
      } catch (_) {
        runtime.dispose();
        rethrow;
      }
    }
    return runtime;
  }

  static Pointer<Void> _createHandle(
    DynamicLibrary library,
    double width,
    double height,
    int rasterDensity,
    int tickHz,
    PocketMemoryLimits memoryLimits,
  ) {
    if (!memoryLimits.isEmpty) {
      try {
        return library.lookupFunction<_CreateMemoryNative, _CreateMemoryDart>(
          'pocket_create_with_memory_limits',
        )(
          width,
          height,
          rasterDensity,
          tickHz,
          memoryLimits.heapLimitBytes ?? 0,
          memoryLimits.maxPakBytes ?? 0,
        );
      } on ArgumentError {
        throw UnsupportedError(
          'Native library does not support memory limits; rebuild the Pocket native SDK',
        );
      }
    }
    if (tickHz != 60) {
      return library
          .lookupFunction<_CreateDensityTickNative, _CreateDensityTickDart>(
            'pocket_create_with_density_and_tick_hz',
          )(width, height, rasterDensity, tickHz);
    }
    if (rasterDensity != 1) {
      return library.lookupFunction<_CreateDensityNative, _CreateDensityDart>(
        'pocket_create_with_density',
      )(width, height, rasterDensity);
    }
    final create = library.lookupFunction<_CreateNative, _CreateDart>(
      'pocket_create',
    );
    return create(width, height);
  }

  static DynamicLibrary _openLibrary() {
    final override = Platform.environment['POCKET_NATIVE_LIBRARY'];
    if (override != null && override.isNotEmpty) {
      return DynamicLibrary.open(override);
    }
    if (Platform.isAndroid) return DynamicLibrary.open('libpocket_flutter.so');
    if (Platform.isIOS) return DynamicLibrary.process();
    if (Platform.isMacOS) return DynamicLibrary.process();
    throw UnsupportedError(
      'Pocket Flutter host supports macOS, iOS and Android.',
    );
  }

  /// The completed trace, when this runtime was opened with a recording
  /// controller and has since been disposed/finished. The controller itself
  /// remains the preferred lifecycle owner for long-lived hosts.
  PocketRecording? get recording => _recordingController?.recording;

  @override
  PocketFrame eval(String source) {
    _checkAlive();
    final sourcePointer = source.toNativeUtf8(allocator: calloc);
    _traceTransactionBegin();
    PocketFrame? output;
    Object? failure;
    try {
      final result = _eval(_handle, sourcePointer);
      if (result != 0) _throwLastError('pocket_eval failed');
      output = _loadFrame();
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      calloc.free(sourcePointer);
      _recordContentHash('source', source);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'eval',
          args: <String, dynamic>{'source': _inlineAsset(source)},
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  @override
  PocketFrame load(String source, Uint8List pak) {
    _checkAlive();
    // Resolve lazily so source-only and injected test runtimes can still
    // use a host library built before pocket_load was added.
    final load = _load ??= _library.lookupFunction<_LoadNative, _LoadDart>(
      'pocket_load',
    );
    final sourcePointer = source.toNativeUtf8(allocator: calloc);
    Pointer<Uint8> pakPointer = Pointer<Uint8>.fromAddress(0);
    if (pak.isNotEmpty) {
      pakPointer = calloc<Uint8>(pak.length);
      pakPointer.asTypedList(pak.length).setAll(0, pak);
    }
    _traceTransactionBegin();
    PocketFrame? output;
    Object? failure;
    try {
      final result = load(_handle, sourcePointer, pakPointer, pak.length);
      if (result != 0) _throwLastError('pocket_load failed');
      output = _loadFrame();
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      calloc.free(sourcePointer);
      if (pakPointer.address != 0) calloc.free(pakPointer);
      _recordContentHash('source', source);
      _recordContentHashBytes('pak', pak);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'load',
          args: <String, dynamic>{
            'source': _inlineAsset(source),
            'pak': _bytesAsset(pak, key: 'pak'),
          },
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) {
    _checkAlive();
    if (bytecode.isEmpty) {
      throw const PocketRuntimeException('bytecode envelope is empty');
    }
    if (pak.isEmpty) {
      throw const PocketRuntimeException(
        'bytecode loading requires a non-empty PAK',
      );
    }
    final actual = actualAbi;
    if (expectedRuntimeAbi != null &&
        (actual == null || actual != expectedRuntimeAbi)) {
      throw PocketRuntimeException(
        'bytecode runtimeAbi mismatch: package=$expectedRuntimeAbi host=${actual ?? '<unavailable>'}',
      );
    }
    final load = _loadBytecode ??= _lookupRequiredLoadBytecode();
    _traceTransactionBegin();
    final bytecodePointer = calloc<Uint8>(bytecode.length);
    final pakPointer = calloc<Uint8>(pak.length);
    bytecodePointer.asTypedList(bytecode.length).setAll(0, bytecode);
    pakPointer.asTypedList(pak.length).setAll(0, pak);
    PocketFrame? output;
    Object? failure;
    try {
      final result = load(
        _handle,
        bytecodePointer,
        bytecode.length,
        pakPointer,
        pak.length,
      );
      if (result != 0) _throwLastError('pocket_load_bytecode failed');
      output = _loadFrame();
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      calloc.free(bytecodePointer);
      calloc.free(pakPointer);
      _recordContentHashBytes('bytecode', bytecode);
      _recordContentHashBytes('pak', pak);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'loadBytecode',
          args: <String, dynamic>{
            'bytecode': _bytesAsset(bytecode, key: 'bytecode'),
            'pak': _bytesAsset(pak, key: 'pak'),
            'expectedRuntimeAbi': expectedRuntimeAbi,
          },
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  /// Loads bytecode from already-admitted native-owned package files.
  Future<PocketFrame> loadBytecodeFiles({
    required String bytecodePath,
    required String pakPath,
    String? expectedRuntimeAbi,
  }) async {
    _checkAlive();
    final actual = actualAbi;
    if (expectedRuntimeAbi != null &&
        (actual == null || actual != expectedRuntimeAbi)) {
      throw PocketRuntimeException(
        'bytecode runtimeAbi mismatch: package=$expectedRuntimeAbi host=${actual ?? '<unavailable>'}',
      );
    }
    final loadFiles = _lookupLoadBytecodeFiles();
    if (loadFiles == null) {
      throw UnsupportedError('pocket_load_bytecode_files is unavailable');
    }
    final bytecodePointer = bytecodePath.toNativeUtf8(allocator: calloc);
    final pakPointer = pakPath.toNativeUtf8(allocator: calloc);
    _traceTransactionBegin();
    PocketFrame? output;
    Object? failure;
    try {
      final result = loadFiles(_handle, bytecodePointer, pakPointer);
      if (result != 0) _throwLastError('pocket_load_bytecode_files failed');
      output = _loadFrame();
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      calloc.free(bytecodePointer);
      calloc.free(pakPointer);
      final bytecodeAsset = _fileAsset(bytecodePath, key: 'bytecode');
      final pakAsset = _fileAsset(pakPath, key: 'pak');
      _recordContentHashDescriptor('bytecode', bytecodeAsset);
      _recordContentHashDescriptor('pak', pakAsset);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'loadBytecodeFiles',
          args: <String, dynamic>{
            'bytecode': bytecodeAsset,
            'pak': pakAsset,
            'expectedRuntimeAbi': expectedRuntimeAbi,
          },
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  _LoadBytecodeDart _lookupRequiredLoadBytecode() {
    try {
      return _library.lookupFunction<_LoadBytecodeNative, _LoadBytecodeDart>(
        'pocket_load_bytecode',
      );
    } on Object {
      throw UnsupportedError('pocket_load_bytecode is unavailable');
    }
  }

  _LoadBytecodeFilesDart? _lookupLoadBytecodeFiles() {
    if (_loadBytecodeFilesLookedUp) return _loadBytecodeFiles;
    _loadBytecodeFilesLookedUp = true;
    try {
      _loadBytecodeFiles = _library
          .lookupFunction<_LoadBytecodeFilesNative, _LoadBytecodeFilesDart>(
            'pocket_load_bytecode_files',
          );
    } on Object {
      _loadBytecodeFiles = null;
    }
    return _loadBytecodeFiles;
  }

  @override
  String? get actualAbi {
    if (!_actualAbiLookedUp) {
      _actualAbiLookedUp = true;
      try {
        _actualAbi = _library.lookupFunction<_AbiNative, _AbiDart>(
          'pocket_bytecode_runtime_abi',
        );
      } on Object {
        _actualAbi = null;
      }
    }
    final getter = _actualAbi;
    return getter == null ? null : _copyString(getter());
  }

  /// Loads already verified package files directly from native-owned paths.
  /// Older libraries do not expose this optional symbol; callers can fall
  /// back to [load] after reading the files in Dart.
  Future<PocketFrame> loadFiles({
    required String sourcePath,
    required String pakPath,
  }) async {
    _checkAlive();
    final loadFiles = _lookupLoadFiles();
    if (loadFiles == null) {
      throw UnsupportedError('pocket_load_files is unavailable');
    }
    final sourcePointer = sourcePath.toNativeUtf8(allocator: calloc);
    final pakPointer = pakPath.toNativeUtf8(allocator: calloc);
    _traceTransactionBegin();
    PocketFrame? output;
    Object? failure;
    try {
      final result = loadFiles(_handle, sourcePointer, pakPointer);
      if (result != 0) _throwLastError('pocket_load_files failed');
      output = _loadFrame();
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      calloc.free(sourcePointer);
      calloc.free(pakPointer);
      final sourceAsset = _fileAsset(sourcePath, key: 'source');
      final pakAsset = _fileAsset(pakPath, key: 'pak');
      _recordContentHashDescriptor('source', sourceAsset);
      _recordContentHashDescriptor('pak', pakAsset);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'loadFiles',
          args: <String, dynamic>{'source': sourceAsset, 'pak': pakAsset},
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  _LoadFilesDart? _lookupLoadFiles() {
    if (_loadFilesLookedUp) return _loadFiles;
    _loadFilesLookedUp = true;
    try {
      _loadFiles = _library.lookupFunction<_LoadFilesNative, _LoadFilesDart>(
        'pocket_load_files',
      );
    } on Object {
      _loadFiles = null;
    }
    return _loadFiles;
  }

  @override
  PocketFrame frame(int deltaMilliseconds) {
    return frameAt(deltaMilliseconds.toDouble());
  }

  /// Native-only fractional entry point used by [pocketFrameAt].
  PocketFrame frameAt(double deltaMilliseconds) {
    _checkAlive();
    _traceTransactionBegin();
    final delta = _finiteNonNegativeDelta(deltaMilliseconds);
    PocketFrame? output;
    Object? failure;
    try {
      final binary = _lookupFrameBinary();
      if (binary != null) {
        output = _readBinaryFullFrame(binary, delta);
        return output;
      }
      final pointer = _frame(_handle, delta);
      output = _readFullFrame(pointer, 'pocket_frame returned no frame');
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'frame',
          args: <String, dynamic>{'deltaMs': delta},
          result: output == null
              ? const <String, dynamic>{}
              : <String, dynamic>{'frame': _frameSummary(output)},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  /// Calls the optional delta ABI. A missing symbol is normal when an older
  /// mobile library is loaded, so lookup failure permanently falls back to the
  /// legacy full-frame call for this runtime instance.
  PocketFrame? frameDeltaAt(double deltaMilliseconds) {
    _checkAlive();
    _traceTransactionBegin();
    final delta = _finiteNonNegativeDelta(deltaMilliseconds);
    PocketFrame? output;
    Object? failure;
    var mode = 'full';
    try {
      final binary = _lookupFrameDeltaBinary();
      if (binary != null) {
        mode = 'binary';
        final length = calloc<Uint64>();
        try {
          length.value = 0;
          final pointer = binary(_handle, delta, length);
          if (pointer.address == 0 || length.value == 0) {
            final error = lastError;
            if (error != null && error.isNotEmpty) {
              throw PocketRuntimeException(error);
            }
            return null;
          }
          final byteLength = length.value;
          if (byteLength > 64 * 1024 * 1024) {
            throw const PocketRuntimeException(
              'pocket_frame_delta_binary returned an oversized frame',
            );
          }
          // The native pointer is borrowed until the next FFI call. Parse
          // directly from the borrowed typed view; retained resources copy
          // only their own pixel/palette slices inside PocketFrame.fromBinary.
          output = PocketFrame.fromBinary(pointer.asTypedList(byteLength));
          return output;
        } finally {
          calloc.free(length);
        }
      }
      final frameDelta = _lookupFrameDelta();
      if (frameDelta == null) {
        mode = 'full';
        final pointer = _frame(_handle, delta);
        output = _readFullFrame(pointer, 'pocket_frame returned no frame');
        return output;
      }
      mode = 'delta';
      final pointer = frameDelta(_handle, delta);
      final json = _copyString(pointer);
      if (json == null || json.isEmpty) {
        _throwLastError('pocket_frame_delta returned no frame');
      }
      final error = lastError;
      if (error != null && error.isNotEmpty) {
        throw PocketRuntimeException(error);
      }
      if (json == '{"unchanged":true}') return null;
      output = PocketFrame.fromJson(json);
      return output;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'frameDelta',
          args: <String, dynamic>{'deltaMs': delta, 'mode': mode},
          result: <String, dynamic>{
            'mode': mode,
            'unchanged': output == null && failure == null,
            if (output != null) 'frame': _frameSummary(output),
          },
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
      _lastFrameDeltaMode = mode;
    }
  }

  @override
  double get nextWakeDelayMilliseconds {
    _checkAlive();
    return _lookupNextWakeDelay()?.call(_handle) ?? 0.0;
  }

  /// Informs newer native hosts that the Flutter app is backgrounded. Older
  /// native libraries omit this optional symbol and remain unaffected.
  void setSchedulerPaused(bool paused) {
    _checkAlive();
    _traceTransactionBegin();
    Object? failure;
    var supported = false;
    try {
      final setter = _lookupSetSchedulerPaused();
      supported = setter != null;
      setter?.call(_handle, paused ? 1 : 0);
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'schedulerPause',
          args: <String, dynamic>{'paused': paused},
          result: <String, dynamic>{'supported': supported, 'paused': paused},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  _NextWakeDelayDart? _lookupNextWakeDelay() {
    if (_nextWakeDelayLookedUp) return _nextWakeDelay;
    _nextWakeDelayLookedUp = true;
    try {
      _nextWakeDelay = _library
          .lookupFunction<_NextWakeDelayNative, _NextWakeDelayDart>(
            'pocket_next_wake_delay_ms',
          );
    } on Object {
      // Older libraries cannot prove that a guest is idle or when a timer is
      // due, so they stay on vsync indefinitely.
      _nextWakeDelay = null;
    }
    return _nextWakeDelay;
  }

  _SetSchedulerPausedDart? _lookupSetSchedulerPaused() {
    if (_setSchedulerPausedLookedUp) return _setSchedulerPaused;
    _setSchedulerPausedLookedUp = true;
    try {
      _setSchedulerPaused = _library
          .lookupFunction<_SetSchedulerPausedNative, _SetSchedulerPausedDart>(
            'pocket_set_scheduler_paused',
          );
    } on Object {
      // Older native libraries do not expose scheduler lifecycle control.
      _setSchedulerPaused = null;
    }
    return _setSchedulerPaused;
  }

  _FrameBinaryDart? _lookupFrameBinary() {
    if (_frameBinaryLookedUp) return _frameBinary;
    _frameBinaryLookedUp = true;
    try {
      _frameBinary = _library
          .lookupFunction<_FrameBinaryNative, _FrameBinaryDart>(
            'pocket_frame_binary',
          );
    } on Object {
      // Older native libraries continue through the JSON full-frame ABI.
      _frameBinary = null;
    }
    return _frameBinary;
  }

  PocketFrame _readBinaryFullFrame(
    _FrameBinaryDart binary,
    double delta,
  ) {
    final length = calloc<Uint64>();
    try {
      length.value = 0;
      final pointer = binary(_handle, delta, length);
      final error = lastError;
      if (error != null && error.isNotEmpty) {
        throw PocketRuntimeException(error);
      }
      if (pointer.address == 0 || length.value == 0) {
        _throwLastError('pocket_frame_binary returned no frame');
      }
      final byteLength = length.value;
      if (byteLength > 64 * 1024 * 1024) {
        throw const PocketRuntimeException(
          'pocket_frame_binary returned an oversized frame',
        );
      }
      return PocketFrame.fromBinary(pointer.asTypedList(byteLength));
    } finally {
      calloc.free(length);
    }
  }

  _FrameBinaryDart? _lookupFrameDeltaBinary() {
    if (_frameDeltaBinaryLookedUp) return _frameDeltaBinary;
    _frameDeltaBinaryLookedUp = true;
    try {
      _frameDeltaBinary = _library
          .lookupFunction<_FrameBinaryNative, _FrameBinaryDart>(
            'pocket_frame_delta_binary',
          );
    } on Object {
      // Older native libraries continue through the JSON delta ABI.
      _frameDeltaBinary = null;
    }
    return _frameDeltaBinary;
  }

  _FrameDart? _lookupFrameDelta() {
    if (_frameDeltaLookedUp) return _frameDelta;
    _frameDeltaLookedUp = true;
    try {
      _frameDelta = _library.lookupFunction<_FrameNative, _FrameDart>(
        'pocket_frame_delta',
      );
    } on Object {
      // Old release libraries predate the optional symbol. The full ABI stays
      // authoritative and keeps the runtime usable without a rebuild.
      _frameDelta = null;
    }
    return _frameDelta;
  }

  PocketFrame _readFullFrame(Pointer<Utf8> pointer, String fallback) {
    final json = _copyString(pointer);
    if (json == null || json.isEmpty) {
      _throwLastError(fallback);
    }
    // The native side reports build_frame failures through pocket_last_error,
    // even when it can return a fallback/empty JSON buffer. Read it after every
    // frame call so an engine error cannot be mistaken for a valid blank frame.
    final error = lastError;
    if (error != null && error.isNotEmpty) {
      throw PocketRuntimeException(error);
    }
    return PocketFrame.fromJson(json);
  }

  void _notifyExternalWork({String source = 'external'}) {
    if (_disposed) return;
    _traceTransactionBegin();
    var notified = false;
    Object? failure;
    try {
      _library.lookupFunction<
        Void Function(Pointer<Void>),
        void Function(Pointer<Void>)
      >('pocket_notify_external_work')(_handle);
      notified = true;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled) {
        _recordTransaction(
          'externalWork',
          args: <String, dynamic>{'source': source},
          result: notified
              ? const <String, dynamic>{'notified': true}
              : const <String, dynamic>{},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
      }
    }
  }

  @override
  void configureOffload(
    PocketOffloadProvider? provider, {
    required void Function() onWake,
  }) {
    _checkAlive();
    if (_offloadBinding != null)
      throw StateError('Offload provider is already configured');
    if (provider == null) return;
    _offloadBinding = _PocketOffloadBinding(this, provider, onWake: onWake);
  }

  void _configureOffloadForReplay(Map<String, dynamic> config) {
    _checkAlive();
    if (!_traceClockReplayMode) {
      throw StateError(
        'offload replay configuration requires trace replay mode',
      );
    }
    if (_offloadBinding != null || _offloadReplayConfigured) {
      throw StateError('Offload is already configured');
    }
    final configure = _library
        .lookupFunction<_ConfigureOffloadNative, _ConfigureOffloadDart>(
          'pocket_configure_offload',
        );
    final pointer = jsonEncode(config).toNativeUtf8(allocator: malloc);
    final notify = Pointer<NativeFunction<_WorkerWakeNative>>.fromAddress(0);
    _traceTransactionBegin();
    Object? failure;
    var configured = false;
    try {
      if (configure(_handle, pointer, notify) != 0) {
        _throwLastError('pocket_configure_offload replay failed');
      }
      _offloadReplayConfigured = true;
      configured = true;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      malloc.free(pointer);
      if (_recordingEnabled) {
        _recordTransaction(
          'offloadConfigure',
          args: <String, dynamic>{'config': config},
          result: configured
              ? const <String, dynamic>{'configured': true}
              : const <String, dynamic>{},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
      }
    }
  }

  @override
  void configureWorker(
    PocketWorkerProgram program, {
    required void Function() onWake,
  }) {
    _checkAlive();
    _configureWorkerNative(program, nativeGeneration: 1, onWake: onWake);
  }

  void _configureWorkerForReplay(
    PocketWorkerProgram program, {
    required int nativeGeneration,
  }) {
    _checkAlive();
    if (!_traceClockReplayMode) {
      throw StateError(
        'worker replay configuration requires trace replay mode',
      );
    }
    _configureWorkerNative(
      program,
      nativeGeneration: nativeGeneration,
      onWake: null,
    );
  }

  void _configureWorkerNative(
    PocketWorkerProgram program, {
    required int nativeGeneration,
    required void Function()? onWake,
  }) {
    if (_workerConfigured) throw StateError('Worker is already configured');
    if (program.expectedRuntimeAbi != actualAbi) {
      throw const PocketRuntimeException('Worker runtime ABI mismatch');
    }
    final callback = onWake == null
        ? null
        : NativeCallable<_WorkerWakeNative>.listener(() {
            if (!_disposed) {
              _notifyExternalWork(source: 'worker');
              onWake();
            }
          });
    final bytes = program.bytecode;
    final pointer = malloc<Uint8>(bytes.length);
    final nativeConfig = program.nativeConfigJson(
      nativeGeneration: nativeGeneration,
    );
    final configFields = _recordingEnabled
        ? Map<String, dynamic>.from(jsonDecode(nativeConfig) as Map)
        : const <String, dynamic>{};
    final config = nativeConfig.toNativeUtf8();
    final bytecodeAsset = _bytesAsset(bytes, key: 'workerBytecode');
    _recordContentHashDescriptor('workerBytecode', bytecodeAsset);
    _traceTransactionBegin();
    Object? failure;
    var configured = false;
    try {
      pointer.asTypedList(bytes.length).setAll(0, bytes);
      final configure = _library
          .lookupFunction<_ConfigureWorkerNative, _ConfigureWorkerDart>(
            'pocket_configure_worker',
          );
      final notifyPointer =
          callback?.nativeFunction ??
          Pointer<NativeFunction<_WorkerWakeNative>>.fromAddress(0);
      if (configure(_handle, pointer, bytes.length, config, notifyPointer) !=
          0) {
        _throwLastError('pocket_configure_worker failed');
      }
      _workerConfigured = true;
      _workerWake = callback;
      configured = true;
    } catch (error) {
      failure = error;
      callback?.close();
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled) {
        _recordTransaction(
          'workerConfigure',
          args: <String, dynamic>{
            'workerBytecode': bytecodeAsset,
            'config': configFields,
            'configSha256': pocketSha256(
              utf8.encode(pocketCanonicalJson(configFields)),
            ),
          },
          result: configured
              ? const <String, dynamic>{'configured': true}
              : const <String, dynamic>{},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
      }
      malloc.free(config);
      malloc.free(pointer);
    }
  }

  @override
  void configureCompositor(Map<String, int> applications) {
    _checkAlive();
    _traceTransactionBegin();
    Object? failure;
    final encoded = jsonEncode(applications);
    final pointer = encoded.toNativeUtf8();
    try {
      final configure = _library
          .lookupFunction<_ConfigureCompositorNative, _ConfigureCompositorDart>(
            'pocket_configure_compositor',
          );
      if (configure(_handle, pointer) != 0) {
        _throwLastError('pocket_configure_compositor failed');
      }
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      malloc.free(pointer);
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled) {
        _recordTransaction(
          'compositor',
          args: <String, dynamic>{'applications': applications},
          result: const <String, dynamic>{'configured': true},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
      }
    }
  }

  @override
  void enableAuxiliary(double width, double height) {
    _checkAlive();
    _traceTransactionBegin();
    Object? failure;
    try {
      final enable = _enableAuxiliary ??= _library
          .lookupFunction<_EnableAuxiliaryNative, _EnableAuxiliaryDart>(
            'pocket_enable_auxiliary',
          );
      final result = enable(_handle, width, height);
      if (result != 0) _throwLastError('pocket_enable_auxiliary failed');
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'auxiliary',
          args: <String, dynamic>{'width': width, 'height': height},
          result: const <String, dynamic>{'enabled': true},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  @override
  bool resizeViewport(double width, double height) {
    _checkAlive();
    _traceTransactionBegin();
    final resize = _lookupResizeViewport();
    // This is an optional ABI addition. A library built before live viewport
    // support remains usable with its original fixed logical surface.
    var resized = false;
    Object? failure;
    try {
      if (resize == null) return false;
      final result = resize(_handle, width, height);
      if (result != 0) _throwLastError('pocket_resize_viewport failed');
      resized = true;
      return true;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'resize',
          args: <String, dynamic>{'width': width, 'height': height},
          result: <String, dynamic>{'resized': resized},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  _ResizeViewportDart? _lookupResizeViewport() {
    if (_resizeViewportLookedUp) return _resizeViewport;
    _resizeViewportLookedUp = true;
    try {
      _resizeViewport = _library
          .lookupFunction<_ResizeViewportNative, _ResizeViewportDart>(
            'pocket_resize_viewport',
          );
    } on Object {
      _resizeViewport = null;
    }
    return _resizeViewport;
  }

  @override
  bool get duplexRuntimeAlive => !_disposed;

  /// Returns the retained native SPSC endpoint when all atomic reserve/commit
  /// symbols are present. Older libraries return null and are rejected by
  /// [PocketDuplexChannel.fromRuntime] instead of falling back to a raw ring
  /// view. The native header/cursors are never exposed to Dart.
  @override
  PocketDuplexEndpoint? get duplexEndpoint {
    _checkAlive();
    final bindings = _lookupDuplexEndpointBindings();
    if (bindings == null) return null;
    if (!_duplexAbiValidated) {
      final abiVersion = bindings.abiVersion();
      final messageSize = bindings.messageSize();
      final capacity = bindings.capacity();
      if (abiVersion != 2 ||
          messageSize != PocketDuplexChannel.messageByteSize ||
          capacity != PocketDuplexChannel.ringCapacity - 1) {
        throw PocketRuntimeException(
          'Pocket duplex ABI mismatch: version=$abiVersion '
          'messageSize=$messageSize capacity=$capacity',
        );
      }
      _duplexAbiValidated = true;
    }

    // Deliberately acquire on every channel construction. Native owns both
    // SPSC role claims in this retained endpoint; a second endpoint must be
    // rejected by those atomics, including construction in another isolate.
    // A Dart-side cached bool would not provide that guarantee.
    final endpoint = bindings.acquire(_handle);
    if (endpoint.address == 0) {
      throw StateError(
        'Pocket native duplex endpoint claim rejected; '
        'the SPSC producer/consumer lease is already in use',
      );
    }
    final retained = _FfiPocketDuplexEndpoint(
      handle: endpoint,
      release: bindings.release,
      releasePointer: bindings.releasePointer,
      reserveIngress: bindings.reserveIngress,
      publishIngress: bindings.publishIngress,
      peekEgress: bindings.peekEgress,
      consumeEgress: bindings.consumeEgress,
      isRecording: () => _recordingEnabled,
      onDuplexTransactionBegin: _beginDuplexTransaction,
      onDuplexTransaction: _recordDuplexTransaction,
    );
    _duplexEndpoints.add(retained);
    return retained;
  }

  _FfiPocketDuplexBindings? _lookupDuplexEndpointBindings() {
    if (_duplexEndpointBindingsLookedUp) {
      final acquire = _duplexEndpointAcquire;
      final release = _duplexEndpointRelease;
      final releasePointer = _duplexEndpointReleasePointer;
      final reserveIngress = _duplexIngressReserve;
      final publishIngress = _duplexIngressPublish;
      final peekEgress = _duplexEgressPeek;
      final consumeEgress = _duplexEgressConsume;
      final abiVersion = _duplexAbiVersion;
      final messageSize = _duplexMessageSize;
      final capacity = _duplexCapacity;
      if (acquire == null ||
          release == null ||
          releasePointer == null ||
          reserveIngress == null ||
          publishIngress == null ||
          peekEgress == null ||
          consumeEgress == null ||
          abiVersion == null ||
          messageSize == null ||
          capacity == null) {
        return null;
      }
      return _FfiPocketDuplexBindings(
        acquire: acquire,
        release: release,
        releasePointer: releasePointer,
        reserveIngress: reserveIngress,
        publishIngress: publishIngress,
        peekEgress: peekEgress,
        consumeEgress: consumeEgress,
        abiVersion: abiVersion,
        messageSize: messageSize,
        capacity: capacity,
      );
    }
    _duplexEndpointBindingsLookedUp = true;
    try {
      _duplexEndpointAcquire = _library
          .lookupFunction<
            _DuplexEndpointAcquireNative,
            _DuplexEndpointAcquireDart
          >('pocket_duplex_endpoint_acquire');
      _duplexEndpointRelease = _library
          .lookupFunction<
            _DuplexEndpointReleaseNative,
            _DuplexEndpointReleaseDart
          >('pocket_duplex_endpoint_release');
      _duplexEndpointReleasePointer = _library
          .lookup<NativeFunction<_DuplexEndpointReleaseNative>>(
            'pocket_duplex_endpoint_release',
          );
      _duplexIngressReserve = _library
          .lookupFunction<_DuplexReserveNative, _DuplexReserveDart>(
            'pocket_duplex_ingress_reserve',
            isLeaf: true,
          );
      _duplexIngressPublish = _library
          .lookupFunction<_DuplexCommitNative, _DuplexCommitDart>(
            'pocket_duplex_ingress_publish',
            isLeaf: true,
          );
      _duplexEgressPeek = _library
          .lookupFunction<_DuplexPeekNative, _DuplexPeekDart>(
            'pocket_duplex_egress_peek',
            isLeaf: true,
          );
      _duplexEgressConsume = _library
          .lookupFunction<_DuplexCommitNative, _DuplexCommitDart>(
            'pocket_duplex_egress_consume',
            isLeaf: true,
          );
      _duplexAbiVersion = _library
          .lookupFunction<_DuplexU32Native, _DuplexU32Dart>(
            'pocket_duplex_abi_version',
            isLeaf: true,
          );
      _duplexMessageSize = _library
          .lookupFunction<_DuplexU32Native, _DuplexU32Dart>(
            'pocket_duplex_message_size',
            isLeaf: true,
          );
      _duplexCapacity = _library
          .lookupFunction<_DuplexU32Native, _DuplexU32Dart>(
            'pocket_duplex_capacity',
            isLeaf: true,
          );
    } on Object {
      _duplexEndpointAcquire = null;
      _duplexEndpointRelease = null;
      _duplexEndpointReleasePointer = null;
      _duplexIngressReserve = null;
      _duplexIngressPublish = null;
      _duplexEgressPeek = null;
      _duplexEgressConsume = null;
      _duplexAbiVersion = null;
      _duplexMessageSize = null;
      _duplexCapacity = null;
    }
    return _lookupDuplexEndpointBindings();
  }

  @override
  int duplexStep() {
    _checkAlive();
    _traceTransactionBegin();
    var result = 0;
    Object? failure;
    try {
      final step = _lookupDuplexStep();
      if (step == null) return 0;
      result = step(_handle);
      if (result < 0) _throwLastError('pocket_duplex_step failed');
      return result;
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'duplexStep',
          args: const <String, dynamic>{},
          result: <String, dynamic>{'processed': result},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  _DuplexStepDart? _lookupDuplexStep() {
    if (_duplexStepLookedUp) return _duplexStep;
    _duplexStepLookedUp = true;
    try {
      _duplexStep = _library.lookupFunction<_DuplexStepNative, _DuplexStepDart>(
        'pocket_duplex_step',
      );
    } on Object {
      _duplexStep = null;
    }
    return _duplexStep;
  }

  _SendBinaryDart? _lookupSendBinary() {
    if (_sendBinaryLookedUp) return _sendBinary;
    _sendBinaryLookedUp = true;
    try {
      _sendBinary = _library.lookupFunction<_SendBinaryNative, _SendBinaryDart>(
        'pocket_send_binary',
      );
    } on Object {
      _sendBinary = null;
    }
    return _sendBinary;
  }

  @override
  void send(Map<String, dynamic> message) {
    _checkAlive();
    _traceTransactionBegin();
    Object? failure;
    try {
      final sendBinary = _lookupSendBinary();
      if (sendBinary != null) {
        final encodedBytes = PocketBinaryCodec.encodeMessage(message);
        final pointer = calloc<Uint8>(encodedBytes.length);
        try {
          pointer.asTypedList(encodedBytes.length).setAll(0, encodedBytes);
          final result = sendBinary(_handle, pointer, encodedBytes.length);
          if (result != 0) _throwLastError('pocket_send_binary failed');
        } finally {
          calloc.free(pointer);
        }
      } else {
        final encoded = jsonEncode(message);
        final pointer = encoded.toNativeUtf8(allocator: calloc);
        try {
          final result = _send(_handle, pointer);
          if (result != 0) _throwLastError('pocket_send failed');
        } finally {
          calloc.free(pointer);
        }
      }
    } catch (error) {
      failure = error;
      rethrow;
    } finally {
      final traceClock = _traceTransactionEnd();
      if (_recordingEnabled)
        _recordTransaction(
          'send',
          args: <String, dynamic>{'message': _sanitizeMessage(message)},
          result: const <String, dynamic>{'sent': true},
          error: _errorSummary(failure),
          traceClock: traceClock,
        );
    }
  }

  @override
  String? get lastError => _copyString(_lastError(_handle));

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    if (!_asyncStopped &&
        (_workerConfigured ||
            _offloadBinding != null ||
            _offloadReplayConfigured)) {
      _stopAsyncForDispose();
    }
    final controller = _recordingController;
    controller?.clearBeforeFinish();
    if (_traceClockConfigured) {
      try {
        _setTraceClockMode(0);
      } on Object catch (error) {
        if (controller?.isRecording == true) {
          controller!.markIncomplete('native trace clock stop failed: $error');
        }
      }
    }
    for (final endpoint in _duplexEndpoints) {
      endpoint.close();
    }
    _duplexEndpoints.clear();
    _offloadBinding?.disposeBeforeNative();
    _destroy(_handle);
    _offloadBinding?.disposeAfterNative();
    _offloadBinding = null;
    _workerWake?.close();
    _workerWake = null;
    if (controller != null && controller.isStarted && !controller.isFinished) {
      controller.finish();
    }
  }

  void _captureStopBoundary() {
    if (!_traceClockConfigured) return;
    final controller = _recordingController;
    if (controller == null) return;
    if (!_workerConfigured &&
        _offloadBinding == null &&
        !_offloadReplayConfigured) {
      // A pure UI realm cannot execute between host transactions. Its last
      // completed transaction already is the final prefix; keep v1 archives.
      try {
        _setTraceClockMode(0);
      } on Object catch (error) {
        controller.markIncomplete('native trace clock stop failed: $error');
      }
      return;
    }
    if (!controller.isRecording) {
      try {
        _setTraceClockMode(0);
      } on Object catch (error) {
        controller.markIncomplete('native trace clock stop failed: $error');
      }
      return;
    }

    try {
      _traceTransactionBegin();
      final traceClock = _traceTransactionEnd();
      if (traceClock == null) {
        controller.markIncomplete('native capture stop trace is unavailable');
      } else {
        _recordTransaction(
          'captureStop',
          args: const <String, dynamic>{},
          result: const <String, dynamic>{'captured': true},
          traceClock: traceClock,
        );
      }
    } on Object catch (error) {
      controller.markIncomplete('native capture stop failed: $error');
    } finally {
      try {
        _setTraceClockMode(0);
      } on Object catch (error) {
        controller.markIncomplete('native trace clock stop failed: $error');
      }
    }
  }

  Map<String, dynamic> _captureStopForReplay() {
    if (!_traceClockReplayMode) {
      throw StateError('capture stop requires trace replay mode');
    }
    _traceTransactionBegin();
    final traceClock = _traceTransactionEnd();
    if (traceClock == null) {
      throw const PocketRuntimeException(
        'native capture stop trace is unavailable',
      );
    }
    _setTraceClockMode(0);
    return traceClock;
  }

  void _stopAsyncForDispose() {
    final controller = _recordingController;
    final shouldRecord = _recordingEnabled;
    final replaying = _traceClockReplayMode;
    if (replaying && !shouldRecord) {
      try {
        _setTraceClockMode(0);
      } on Object {
        // Continue to native destroy even if replay mode cannot be reset.
      }
      try {
        _lookupStopAsync()?.call(_handle);
        _asyncStopped = true;
      } on Object {
        // pocket_destroy retains the final safety-net teardown.
      }
      return;
    }
    var traceOpened = false;
    var stopped = false;
    Object? failure;
    if (shouldRecord) {
      try {
        _traceTransactionBegin();
        traceOpened = _traceTransactionActive;
      } on Object catch (error) {
        failure = error;
        controller?.markIncomplete(
          'native async stop trace begin failed: $error',
        );
      }
    }
    try {
      final stop = _lookupStopAsync();
      if (stop == null) {
        throw UnsupportedError('pocket_stop_async is unavailable');
      }
      if (stop(_handle) != 0) _throwLastError('pocket_stop_async failed');
      stopped = true;
      _asyncStopped = true;
    } catch (error) {
      failure = error;
    } finally {
      if (shouldRecord) {
        Map<String, dynamic>? traceClock;
        if (traceOpened) {
          try {
            traceClock = _traceTransactionEnd();
          } on Object catch (error) {
            failure ??= error;
          }
        }
        if (traceClock != null && controller?.isRecording == true) {
          try {
            _recordTransaction(
              'asyncStop',
              args: const <String, dynamic>{},
              result: <String, dynamic>{'stopped': stopped},
              error: _errorSummary(failure),
              traceClock: traceClock,
            );
          } on Object catch (error) {
            controller!.markIncomplete(
              'async stop could not be recorded: $error',
            );
          }
        } else if (controller?.isRecording == true) {
          controller!.markIncomplete('native async stop trace is unavailable');
        }
      }
      if (!stopped && controller?.isRecording == true) {
        controller!.markIncomplete('native async stop failed: $failure');
      }
    }
  }

  void _stopAsyncForReplay() {
    _checkAlive();
    if (!_traceClockReplayMode) {
      throw StateError('async replay stop requires trace replay mode');
    }
    if (_asyncStopped) throw StateError('async services are already stopped');
    _traceTransactionBegin();
    try {
      final stop = _lookupStopAsync();
      if (stop == null) {
        throw UnsupportedError('pocket_stop_async is unavailable');
      }
      if (stop(_handle) != 0) _throwLastError('pocket_stop_async failed');
      _asyncStopped = true;
    } finally {
      _traceTransactionEnd();
    }
  }

  void _checkAlive() {
    if (_disposed) {
      throw const PocketRuntimeException('Pocket runtime is disposed');
    }
  }

  Never _throwLastError(String fallback) {
    throw PocketRuntimeException(lastError ?? fallback);
  }

  /// Load/eval use this direct full-frame call so the first frame is one
  /// transaction with the admission operation rather than an invisible
  /// nested `frame(0)` transaction.
  PocketFrame _loadFrame() {
    final binary = _lookupFrameBinary();
    if (binary != null) {
      return _readBinaryFullFrame(binary, 0.0);
    }
    final pointer = _frame(_handle, 0.0);
    return _readFullFrame(pointer, 'pocket_frame returned no frame');
  }

  bool get _recordingEnabled =>
      _recordingController?.enabled == true &&
      _recordingController!.isStarted &&
      !_recordingController.isFinished &&
      !_recordingController.isIncomplete;

  void _recordTransaction(
    String kind, {
    required Map<String, dynamic> args,
    required Map<String, dynamic> result,
    Object? error,
    Map<String, dynamic>? traceClock,
  }) {
    final controller = _recordingController;
    if (controller == null || !_recordingEnabled) return;
    final tracedResult = <String, dynamic>{...result};
    if (traceClock != null) tracedResult['traceClock'] = traceClock;
    try {
      controller.add(
        PocketRecordingEntry(
          index: 0,
          kind: kind,
          args: args,
          result: tracedResult,
          error: error is Map<String, dynamic> ? error : null,
        ),
      );
    } on Object catch (recordingError) {
      controller.markIncomplete('invalid transaction: $recordingError');
    }
  }

  void _recordDuplexTransaction(
    String operation,
    int maxMessages,
    int count,
    Uint8List? bytes,
    Object? failure,
  ) {
    final traceClock = _traceTransactionEnd();
    if (!_recordingEnabled) return;
    final kind = switch (operation) {
      'ingress.publish' => 'duplexIngressPublish',
      'egress.peek' => 'duplexEgressPeek',
      'egress.consume' => 'duplexEgressConsume',
      _ => operation,
    };
    final payload = bytes == null ? null : base64Encode(bytes);
    _recordTransaction(
      kind,
      args: <String, dynamic>{
        'maxMessages': maxMessages,
        'count': count,
        if (payload != null) 'payloadBase64': payload,
        if (bytes != null) 'payloadSha256': pocketSha256(bytes),
      },
      result: <String, dynamic>{
        'count': count,
        if (bytes != null && operation != 'egress.consume')
          'payloadSha256': pocketSha256(bytes),
      },
      error: _errorSummary(failure),
      traceClock: traceClock,
    );
  }

  void _beginDuplexTransaction(String operation) {
    if (!_recordingEnabled && !_traceClockConfigured) return;
    _traceTransactionBegin();
  }

  Map<String, dynamic> _inlineAsset(String source) {
    if (!_recordingEnabled) return <String, dynamic>{};
    final bytes = Uint8List.fromList(utf8.encode(source));
    final digest = pocketSha256(bytes);
    _retainReplayAsset('source:${digest.substring(0, 16)}', bytes);
    return <String, dynamic>{
      'encoding': 'utf8',
      'bytes': bytes.length,
      'sha256': digest,
      'key': 'source:${digest.substring(0, 16)}',
    };
  }

  Map<String, dynamic> _bytesAsset(Uint8List bytes, {required String key}) {
    if (!_recordingEnabled) return <String, dynamic>{};
    final digest = pocketSha256(bytes);
    _retainReplayAsset('$key:${digest.substring(0, 16)}', bytes);
    return <String, dynamic>{
      'bytes': bytes.length,
      'sha256': digest,
      'key': '$key:${digest.substring(0, 16)}',
    };
  }

  Map<String, dynamic> _fileAsset(String path, {required String key}) {
    if (!_recordingEnabled) return <String, dynamic>{};
    // The path itself never enters a tape. It is only used to derive a stable
    // opaque resolver key and, when available, a content digest.
    final pathDigest = pocketSha256(utf8.encode(path));
    Uint8List? bytes;
    try {
      bytes = Uint8List.fromList(File(path).readAsBytesSync());
    } on Object {
      bytes = null;
      // A file descriptor without content cannot reconstruct the load on an
      // offline runner. Preserve the native load's own error/return semantics
      // but make the tape explicitly non-replayable.
      _recordingController?.markIncomplete('file replay asset unavailable');
    }
    final digest = bytes == null ? null : pocketSha256(bytes);
    if (bytes != null) _retainReplayAsset('$key:$pathDigest', bytes);
    return <String, dynamic>{
      'key': '$key:$pathDigest',
      'bytes': bytes?.length,
      'sha256': digest,
    };
  }

  void _recordContentHash(String name, String value) {
    if (!_recordingEnabled) return;
    _recordContentHashBytes(name, Uint8List.fromList(utf8.encode(value)));
  }

  void _recordContentHashBytes(String name, Uint8List bytes) {
    if (!_recordingEnabled) return;
    _recordingController!.setContentHash(name, pocketSha256(bytes));
  }

  void _recordContentHashDescriptor(
    String name,
    Map<String, dynamic> descriptor,
  ) {
    if (!_recordingEnabled) return;
    final digest = descriptor['sha256'];
    if (digest is String) _recordingController!.setContentHash(name, digest);
  }

  void _retainReplayAsset(String key, Uint8List bytes) {
    if (!_recordingEnabled) return;
    _recordingController!.retainAsset(key, bytes);
  }

  Map<String, dynamic>? _errorSummary(Object? error) {
    if (error == null) return null;
    return <String, dynamic>{
      'type': error.runtimeType.toString(),
      'message': '$error',
    };
  }

  Map<String, dynamic> _sanitizeMessage(Map<String, dynamic> message) {
    if (!_recordingEnabled) return <String, dynamic>{};
    _messageWasRedacted = false;
    try {
      final sanitized =
          _snapshotJsonObject(message, 0, redactPrivateKeys: true)
              as Map<String, dynamic>;
      if (_messageWasRedacted) {
        _recordingController!.markIncomplete(
          'send contained a redacted private key field',
        );
      }
      return sanitized;
    } on Object catch (error) {
      // Preserve the native jsonEncode error while ensuring recording itself
      // cannot leak or throw from a finally block.
      _recordingController!.markIncomplete('send snapshot failed: $error');
      return <String, dynamic>{'invalid': true};
    }
  }

  Object? _snapshotJsonObject(
    Object? value,
    int depth, {
    bool redactPrivateKeys = false,
  }) {
    if (depth > 16) throw const FormatException('message nesting is too deep');
    if (value == null || value is bool || value is String || value is int)
      return value;
    if (value is Uint8List) {
      return <String, dynamic>{'__pocketBytesBase64': base64Encode(value)};
    }
    if (value is double) {
      if (!value.isFinite)
        throw const FormatException('message number is not finite');
      return value;
    }
    if (value is num) {
      if (!value.isFinite)
        throw const FormatException('message number is not finite');
      return value.toDouble();
    }
    if (value is Map) {
      final result = <String, dynamic>{};
      for (final item in value.entries) {
        if (item.key is! String)
          throw const FormatException('message key is not string');
        final key = item.key as String;
        if (redactPrivateKeys && _isPrivateKeyField(key)) {
          _messageWasRedacted = true;
          result[key] = '<redacted>';
        } else {
          result[key] = _snapshotJsonObject(
            item.value,
            depth + 1,
            redactPrivateKeys: redactPrivateKeys,
          );
        }
      }
      if (result.length == 1 &&
          (result.containsKey('__pocketBytesBase64') ||
              result.containsKey('__pocketEscapedMap'))) {
        return <String, dynamic>{'__pocketEscapedMap': result};
      }
      return result;
    }
    if (value is Iterable) {
      return value
          .map(
            (item) => _snapshotJsonObject(
              item,
              depth + 1,
              redactPrivateKeys: redactPrivateKeys,
            ),
          )
          .toList(growable: false);
    }
    throw const FormatException('unsupported message value');
  }

  bool _isPrivateKeyField(String key) {
    final normalized = key
        .toLowerCase()
        .replaceAll('_', '')
        .replaceAll('-', '');
    return normalized == 'privatekey' || normalized == 'privatekeypem';
  }

  Map<String, dynamic> _frameSummary(PocketFrame frame) {
    try {
      return _strictFrameSummary(frame);
    } on Object catch (error) {
      if (!_recordingEnabled) rethrow;
      _recordingController!.markIncomplete('frame snapshot failed: $error');
      return <String, dynamic>{};
    }
  }

  Map<String, dynamic> _strictFrameSummary(PocketFrame frame) {
    final canonical = <String, dynamic>{
      'width': frame.width,
      'height': frame.height,
      'ops': frame.ops.map(_opSummary).toList(growable: false),
      'events': frame.events
          .map(
            (event) => <String, dynamic>{
              'id': event.id,
              'method': event.method,
              'params': _snapshotJsonObject(event.params, 0),
            },
          )
          .toList(growable: false),
      'resources': frame.resources
          .map(
            (resource) => <String, dynamic>{
              'asset': resource.asset,
              'revision': resource.revision,
              'width': resource.width,
              'height': resource.height,
              'psm': resource.psm,
              'linear': resource.linear,
              'pixelsBytes': resource.pixels.length,
              'pixelsSha256': pocketSha256(resource.pixels),
              'paletteBytes': resource.palette?.length,
              'paletteSha256': resource.palette == null
                  ? null
                  : pocketSha256(resource.palette!),
            },
          )
          .toList(growable: false),
      'releasedResources': frame.releasedResources,
      'auxiliary': frame.auxiliary == null
          ? null
          : <String, dynamic>{
              'width': frame.auxiliary!.width,
              'height': frame.auxiliary!.height,
              'ops': frame.auxiliary!.ops
                  .map(_opSummary)
                  .toList(growable: false),
            },
    };
    String digest(Object? value) =>
        pocketSha256(utf8.encode(pocketCanonicalJson(value)));
    return <String, dynamic>{
      'sha256': pocketSha256(utf8.encode(pocketCanonicalJson(canonical))),
      // Keep component digests alongside the aggregate so a replay mismatch
      // identifies the unstable lane (draw ops, events, resources, or the
      // auxiliary surface) without exposing private host state.
      'opsSha': digest(canonical['ops']),
      'eventsSha': digest(canonical['events']),
      'resourcesSha': digest(canonical['resources']),
      'auxSha': digest(canonical['auxiliary']),
      'width': frame.width,
      'height': frame.height,
      'ops': frame.ops.length,
      'events': frame.events.length,
      'resources': frame.resources.length,
      'releasedResources': frame.releasedResources.length,
      'auxiliaryOps': frame.auxiliary?.ops.length ?? 0,
    };
  }

  Map<String, dynamic> _opSummary(PocketOp op) {
    final result = <String, dynamic>{
      'type': switch (op) {
        PocketRectOp() => 'rect',
        PocketRoundedOp() => 'rounded',
        PocketGradientOp() => 'gradient',
        PocketTriangleOp() => 'triangle',
        PocketTextureTriangleOp() => 'textureTriangle',
        PocketTextOp() => 'text',
        PocketImageOp() => 'image',
        PocketHostSurfaceOp() => 'hostSurface',
        PocketVideoOp() => 'video',
      },
      'x': op.x,
      'y': op.y,
      'width': op.width,
      'height': op.height,
      'clip': op.clip == null
          ? null
          : <String, dynamic>{
              'x': op.clip!.x,
              'y': op.clip!.y,
              'width': op.clip!.width,
              'height': op.clip!.height,
            },
    };
    switch (op) {
      case PocketRectOp value:
        result['color'] = value.color;
      case PocketRoundedOp value:
        result['color'] = value.color;
        result['radius'] = value.radius;
      case PocketGradientOp value:
        result['fromColor'] = value.fromColor;
        result['toColor'] = value.toColor;
        result['direction'] = value.direction;
      case PocketTriangleOp value:
        result['points'] = value.points
            .map((point) => <String, dynamic>{'x': point.x, 'y': point.y})
            .toList(growable: false);
        result['colors'] = value.colors;
      case PocketTextureTriangleOp value:
        result['asset'] = value.asset;
        result['color'] = value.color;
        result['points'] = value.points
            .map((point) => <String, dynamic>{'x': point.x, 'y': point.y})
            .toList(growable: false);
        result['uvs'] = value.uvs;
      case PocketTextOp value:
        result['text'] = value.text;
        result['size'] = value.size;
        result['color'] = value.color;
        result['fontSlot'] = value.fontSlot;
        result['align'] = value.align;
      case PocketImageOp value:
        result['asset'] = value.asset;
        result['uv'] = value.uv;
        result['tint'] = value.tint;
      case PocketHostSurfaceOp value:
        result['id'] = value.id;
        result['kind'] = value.kind;
        result['surfaceHandle'] = value.surfaceHandle;
        result['focused'] = value.focused;
        result['parameters'] = _snapshotJsonObject(value.parameters, 0);
      case PocketVideoOp value:
        result['id'] = value.id;
        result['asset'] = value.asset;
        result['autoplay'] = value.autoplay;
        result['fit'] = value.fit;
    }
    return result;
  }

  /// Selects live (0), record (1), or replay (2) clock mode before loading.
  void _setTraceClockMode(int mode) {
    _lookupTraceClock();
    final setter = _traceClockMode;
    if (setter == null) {
      if (mode != 0) {
        throw const PocketRuntimeException(
          'native trace clock ABI is required for recording and replay',
        );
      }
      _traceClockConfigured = false;
      _traceClockReplayMode = false;
      return;
    }
    final result = setter(_handle, mode);
    if (result != 0) _throwLastError('pocket_trace_clock_mode failed');
    if (mode == 0) {
      // Once recording has stopped, return to the allocation-free disabled
      // path. In particular, do not issue mode(0) on every later transaction.
      _traceClockConfigured = false;
      _traceClockReplayMode = false;
    } else {
      _traceClockConfigured = true;
      _traceClockReplayMode = mode == 2;
    }
  }

  void _setReplayTraceEnvelope(Object? envelope) {
    _lastTraceClock = null;
    _pendingReplayTraceClock = envelope == null
        ? null
        : Map<String, dynamic>.from(envelope as Map);
  }

  void _traceTransactionBegin() {
    if (!_recordingEnabled && !_traceClockReplayMode) {
      if (_traceClockConfigured) {
        _setTraceClockMode(0);
      }
      return;
    }
    _lookupTraceClock();
    final begin = _traceClockBegin;
    if (begin == null) return;
    final envelope =
        _pendingReplayTraceClock ??
        const <String, dynamic>{'idleMs': <dynamic>[], 'scalars': <dynamic>[]};
    _pendingReplayTraceClock = null;
    final pointer = jsonEncode(envelope).toNativeUtf8(allocator: calloc);
    try {
      final result = begin(_handle, pointer);
      if (result != 0) _throwLastError('pocket_trace_clock_begin_json failed');
      _traceTransactionActive = true;
    } finally {
      calloc.free(pointer);
    }
  }

  Map<String, dynamic>? _traceTransactionEnd() {
    _lastTraceClock = null;
    if (!_traceTransactionActive) return null;
    _traceTransactionActive = false;
    _lookupTraceClock();
    final end = _traceClockEnd;
    if (end == null) return null;
    Pointer<Utf8> pointer;
    try {
      pointer = end(_handle);
    } on Object catch (error) {
      if (_recordingEnabled) {
        _recordingController!.markIncomplete(
          'native trace clock end failed: $error',
        );
        return null;
      }
      rethrow;
    }
    final json = _copyString(pointer);
    if (json == null || json.isEmpty) {
      final detail = lastError;
      final message = detail == null || detail.isEmpty
          ? 'native trace clock returned no envelope'
          : 'native trace clock end failed: $detail';
      if (_recordingEnabled) {
        _recordingController!.markIncomplete(message);
        return null;
      }
      throw PocketRuntimeException(message);
    }
    try {
      _lastTraceClock = pocketValidateTraceClockEnvelope(jsonDecode(json));
      return _lastTraceClock;
    } on Object catch (error) {
      if (_recordingEnabled) {
        _recordingController!.markIncomplete(
          'invalid native trace clock envelope: $error',
        );
        return null;
      }
      rethrow;
    }
  }

  Map<String, dynamic>? get _lastCompletedTraceClock => _lastTraceClock;

  void _lookupTraceClock() {
    if (_traceClockLookedUp) return;
    _traceClockLookedUp = true;
    try {
      _traceClockMode = _library
          .lookupFunction<_TraceClockModeNative, _TraceClockModeDart>(
            'pocket_trace_clock_mode',
          );
      _traceClockBegin = _library
          .lookupFunction<_TraceClockBeginNative, _TraceClockBeginDart>(
            'pocket_trace_clock_begin_json',
          );
      _traceClockEnd = _library
          .lookupFunction<_TraceClockEndNative, _TraceClockEndDart>(
            'pocket_trace_clock_end_json',
          );
    } on Object {
      _traceClockMode = null;
      _traceClockBegin = null;
      _traceClockEnd = null;
    }
  }

  _StopAsyncDart? _lookupStopAsync() {
    if (_stopAsyncLookedUp) return _stopAsync;
    _stopAsyncLookedUp = true;
    try {
      _stopAsync = _library.lookupFunction<_StopAsyncNative, _StopAsyncDart>(
        'pocket_stop_async',
      );
    } on Object {
      _stopAsync = null;
    }
    return _stopAsync;
  }
}

/// Factory used by [PocketReplayRunner]. Tests may provide a factory that
/// points at a specific native library; the default always creates a new real
/// FFI runtime from the recording metadata.
typedef PocketReplayRuntimeFactory =
    FfiPocketRuntime Function(PocketRecordingMetadata metadata);

/// Replays a host transaction tape against a fresh native guest. The runner
/// never opens paths from the tape and never installs hardware/plugin
/// providers; file lanes are resolved from [PocketReplayAssets].
final class PocketReplayRunner {
  const PocketReplayRunner({this.runtimeFactory});

  final PocketReplayRuntimeFactory? runtimeFactory;

  Future<PocketReplayResult> run(
    PocketRecording recording, {
    required PocketReplayAssets assets,
  }) async {
    if (!recording.replayable) {
      return PocketReplayResult(
        matched: false,
        replayable: false,
        entriesReplayed: 0,
        framesCompared: 0,
        rejection: recording.incompleteReason ?? 'recording is incomplete',
      );
    }
    if (recording.entries.isEmpty) {
      return const PocketReplayResult(
        matched: false,
        replayable: false,
        entriesReplayed: 0,
        framesCompared: 0,
        rejection: 'recording contains no transactions',
      );
    }
    final evidenceMismatch = _validateReplayEvidence(recording);
    if (evidenceMismatch != null) {
      return PocketReplayResult(
        matched: false,
        replayable: false,
        entriesReplayed: 0,
        framesCompared: 0,
        firstMismatch: evidenceMismatch,
        rejection: evidenceMismatch.reason,
      );
    }
    FfiPocketRuntime? runtime;
    PocketDuplexEndpoint? endpoint;
    var frameIndex = 0;
    var heldEgressCount = 0;
    var entriesReplayed = 0;
    try {
      final factory = runtimeFactory;
      runtime = factory == null
          ? FfiPocketRuntime.open(
              width: recording.metadata.width,
              height: recording.metadata.height,
              rasterDensity: recording.metadata.density,
              tickHz: recording.metadata.tickHz,
              memoryLimits: recording.metadata.memoryLimits,
            )
          : factory(recording.metadata);
      if (runtime.memoryLimits != recording.metadata.memoryLimits) {
        return PocketReplayResult(
          matched: false,
          replayable: true,
          entriesReplayed: 0,
          framesCompared: 0,
          firstMismatch: PocketReplayMismatch(
            entryIndex: -1,
            transaction: 'runtime.open',
            reason: 'runtime memory limits mismatch',
            expected: recording.metadata.memoryLimits.toJson(),
            actual: runtime.memoryLimits.toJson(),
          ),
        );
      }
      final hasTraceClock = recording.entries.any(
        (entry) => entry.result['traceClock'] != null,
      );
      if (hasTraceClock) runtime._setTraceClockMode(2);
      final expectedAbi = recording.metadata.engineAbi;
      final actualAbi = runtime.actualAbi;
      if (expectedAbi != null && actualAbi != expectedAbi) {
        return PocketReplayResult(
          matched: false,
          replayable: true,
          entriesReplayed: 0,
          framesCompared: 0,
          firstMismatch: PocketReplayMismatch(
            entryIndex: -1,
            transaction: 'runtime.open',
            reason: 'engine ABI mismatch',
            expected: expectedAbi,
            actual: actualAbi,
          ),
        );
      }
      final metadataMismatch = _validateMetadataAssets(
        recording.metadata,
        assets,
      );
      if (metadataMismatch != null) {
        return PocketReplayResult(
          matched: false,
          replayable: true,
          entriesReplayed: 0,
          framesCompared: 0,
          firstMismatch: metadataMismatch,
        );
      }
      for (final entry in recording.entries) {
        final mismatch = await _runEntry(
          runtime,
          entry,
          assets,
          endpoint: endpoint,
          heldEgressCount: heldEgressCount,
          frameIndex: frameIndex,
        );
        endpoint = mismatch.endpoint;
        heldEgressCount = mismatch.heldEgressCount;
        if (mismatch.frameCompared) frameIndex++;
        entriesReplayed++;
        if (mismatch.mismatch != null) {
          return PocketReplayResult(
            matched: false,
            replayable: true,
            entriesReplayed: entriesReplayed,
            framesCompared: frameIndex,
            firstMismatch: mismatch.mismatch,
          );
        }
      }
      if (heldEgressCount != 0) {
        return PocketReplayResult(
          matched: false,
          replayable: true,
          entriesReplayed: entriesReplayed,
          framesCompared: frameIndex,
          firstMismatch: PocketReplayMismatch(
            entryIndex: recording.entries.length - 1,
            transaction: 'duplex.egress.consume',
            reason: 'egress peek was not consumed',
          ),
        );
      }
      return PocketReplayResult(
        matched: true,
        replayable: true,
        entriesReplayed: entriesReplayed,
        framesCompared: frameIndex,
      );
    } catch (error) {
      return PocketReplayResult(
        matched: false,
        replayable: true,
        entriesReplayed: entriesReplayed,
        framesCompared: frameIndex,
        firstMismatch: PocketReplayMismatch(
          entryIndex: entriesReplayed,
          transaction: 'runner',
          frameIndex: frameIndex,
          reason: '$error',
        ),
      );
    } finally {
      endpoint?.close();
      runtime?.dispose();
    }
  }

  PocketReplayMismatch? _validateMetadataAssets(
    PocketRecordingMetadata metadata,
    PocketReplayAssets assets,
  ) {
    for (final item in metadata.contentHashes.entries) {
      Uint8List? bytes;
      if (item.key == 'source' && assets.source != null) {
        bytes = Uint8List.fromList(utf8.encode(assets.source!));
      } else if (item.key == 'bytecode') {
        bytes = assets.bytecode;
      } else if (item.key == 'pak') {
        bytes = assets.pak;
      }
      bytes ??= assets.byHash[item.value];
      // A zero-length asset has no retained bytes to resolve, but its SHA is
      // still part of the ABI and must be checked like every other asset.
      if (bytes == null && item.value == pocketSha256(Uint8List(0))) {
        bytes = Uint8List(0);
      }
      if (bytes == null) {
        return PocketReplayMismatch(
          entryIndex: -1,
          transaction: 'runtime.assets',
          reason: 'metadata content asset unavailable',
          expected: item.value,
        );
      }
      if (pocketSha256(bytes) != item.value) {
        return PocketReplayMismatch(
          entryIndex: -1,
          transaction: 'runtime.assets',
          reason: 'metadata content SHA-256 mismatch',
          expected: item.value,
          actual: pocketSha256(bytes),
        );
      }
    }
    return null;
  }

  Future<_ReplayStep> _runEntry(
    FfiPocketRuntime runtime,
    PocketRecordingEntry entry,
    PocketReplayAssets assets, {
    required PocketDuplexEndpoint? endpoint,
    required int heldEgressCount,
    required int frameIndex,
  }) async {
    final expectedError = entry.error;
    Map<String, dynamic>? actualResult;
    Object? actualError;
    PocketDuplexEndpoint? currentEndpoint = endpoint;
    var currentHeldEgress = heldEgressCount;
    var frameCompared = false;
    try {
      runtime._setReplayTraceEnvelope(entry.result['traceClock']);
      switch (entry.kind) {
        case 'eval':
          final source = _sourceBytes(entry.args['source'], assets);
          final frame = runtime.eval(utf8.decode(source));
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'load':
          final source = _sourceBytes(entry.args['source'], assets);
          final pak = _assetBytes(entry.args['pak'], assets);
          final frame = runtime.load(utf8.decode(source), pak);
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'loadBytecode':
          final bytecode = _assetBytes(entry.args['bytecode'], assets);
          final pak = _assetBytes(entry.args['pak'], assets);
          final frame = runtime.loadBytecode(
            bytecode,
            pak,
            expectedRuntimeAbi: entry.args['expectedRuntimeAbi'] as String?,
          );
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'loadFiles':
          final source = _sourceBytes(entry.args['source'], assets);
          final pak = _assetBytes(entry.args['pak'], assets);
          final frame = await runtime.load(utf8.decode(source), pak);
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'loadBytecodeFiles':
          final bytecode = _assetBytes(entry.args['bytecode'], assets);
          final pak = _assetBytes(entry.args['pak'], assets);
          final frame = runtime.loadBytecode(
            bytecode,
            pak,
            expectedRuntimeAbi: entry.args['expectedRuntimeAbi'] as String?,
          );
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'frame':
          final frame = runtime.frameAt(
            _finiteArg(entry.args['deltaMs'], 'deltaMs'),
          );
          actualResult = <String, dynamic>{
            'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'frameDelta':
          final frame = runtime.frameDeltaAt(
            _finiteArg(entry.args['deltaMs'], 'deltaMs'),
          );
          actualResult = <String, dynamic>{
            'mode': runtime._lastFrameDeltaMode,
            'unchanged': frame == null,
            if (frame != null) 'frame': runtime._frameSummary(frame),
          };
          frameCompared = true;
        case 'send':
          final message = entry.args['message'];
          if (message is! Map)
            throw const FormatException(
              'recorded send message is not an object',
            );
          final restored = _restoreRecordedMessage(message, 0);
          if (restored is! Map<String, dynamic>) {
            throw const FormatException(
              'recorded send message is not an object',
            );
          }
          runtime.send(restored);
          actualResult = <String, dynamic>{'sent': true};
        case 'resize':
          final resized = runtime.resizeViewport(
            _finiteArg(entry.args['width'], 'width'),
            _finiteArg(entry.args['height'], 'height'),
          );
          actualResult = <String, dynamic>{'resized': resized};
        case 'compositor':
          final applications = entry.args['applications'];
          if (applications is! Map ||
              applications.values.any((v) => v is! int)) {
            throw const FormatException('Invalid recorded compositor registry');
          }
          runtime.configureCompositor(Map<String, int>.from(applications));
          actualResult = <String, dynamic>{'configured': true};
        case 'offloadConfigure':
          final config = entry.args['config'];
          if (config is! Map) {
            throw const FormatException('recorded offload config is invalid');
          }
          runtime._configureOffloadForReplay(Map<String, dynamic>.from(config));
          actualResult = <String, dynamic>{'configured': true};
        case 'workerConfigure':
          final config = entry.args['config'];
          if (config is! Map) {
            throw const FormatException('recorded worker config is invalid');
          }
          final fields = Map<String, dynamic>.from(config);
          final program = _workerProgram(
            fields,
            entry.args['workerBytecode'],
            assets,
          );
          runtime._configureWorkerForReplay(
            program,
            nativeGeneration: _integerArg(
              fields['nativeGeneration'],
              'nativeGeneration',
            ),
          );
          actualResult = <String, dynamic>{'configured': true};
        case 'externalWork':
          final source = entry.args['source'];
          if (source is! String) {
            throw const FormatException(
              'recorded external work source is invalid',
            );
          }
          runtime._notifyExternalWork(source: source);
          actualResult = <String, dynamic>{'notified': true};
        case 'asyncStop':
          runtime._stopAsyncForReplay();
          actualResult = <String, dynamic>{'stopped': true};
        case 'captureStop':
          final traceClock = runtime._captureStopForReplay();
          actualResult = <String, dynamic>{
            'captured': true,
            'traceClock': traceClock,
          };
        case 'auxiliary':
          runtime.enableAuxiliary(
            _finiteArg(entry.args['width'], 'width'),
            _finiteArg(entry.args['height'], 'height'),
          );
          actualResult = <String, dynamic>{'enabled': true};
        case 'schedulerPause':
          final paused = entry.args['paused'];
          if (paused is! bool)
            throw const FormatException('recorded paused flag is invalid');
          final supported = runtime._lookupSetSchedulerPaused() != null;
          runtime.setSchedulerPaused(paused);
          actualResult = <String, dynamic>{
            'supported': supported,
            'paused': paused,
          };
        case 'duplexIngressPublish':
          currentEndpoint ??= runtime.duplexEndpoint;
          if (currentEndpoint == null)
            throw UnsupportedError('duplex endpoint unavailable');
          final count = expectedError == null
              ? _integerArg(entry.args['count'], 'count')
              : _signedIntegerArg(entry.args['count'], 'count');
          final reservation = _signedIntegerArg(
            entry.args['maxMessages'],
            'maxMessages',
          );
          if (reservation < 0) {
            throw const FormatException('negative ingress reservation');
          }
          final bytes =
              entry.args['payloadBase64'] == null && expectedError != null
              ? Uint8List(0)
              : _base64Bytes(entry.args['payloadBase64']);
          if (expectedError == null &&
              bytes.length != count * PocketDuplexEndpoint.messageByteSize) {
            throw const FormatException(
              'duplex ingress payload length mismatch',
            );
          }
          final view = reservation == 0
              ? null
              : currentEndpoint.reserveIngress(reservation);
          if ((expectedError == null && view == null) ||
              (view?.length ?? 0) < bytes.length) {
            throw StateError('duplex ingress reservation unavailable');
          }
          view?.setAll(0, bytes);
          currentEndpoint.publishIngress(count);
          actualResult = <String, dynamic>{
            'count': count,
            'payloadSha256': pocketSha256(bytes),
          };
        case 'duplexStep':
          final processed = runtime.duplexStep();
          actualResult = <String, dynamic>{'processed': processed};
        case 'duplexEgressPeek':
          currentEndpoint ??= runtime.duplexEndpoint;
          if (currentEndpoint == null)
            throw UnsupportedError('duplex endpoint unavailable');
          final maxMessages = _integerArg(
            entry.args['maxMessages'],
            'maxMessages',
          );
          final view = currentEndpoint.peekEgress(maxMessages);
          final bytes = view == null ? Uint8List(0) : Uint8List.fromList(view);
          final actualCount =
              bytes.length ~/ PocketDuplexEndpoint.messageByteSize;
          currentHeldEgress = actualCount;
          if (actualCount > 0 && (view == null || bytes.isEmpty)) {
            throw StateError('expected duplex egress payload is absent');
          }
          actualResult = <String, dynamic>{
            'count': actualCount,
            if (bytes.isNotEmpty) 'payloadSha256': pocketSha256(bytes),
          };
        case 'duplexEgressConsume':
          currentEndpoint ??= runtime.duplexEndpoint;
          if (currentEndpoint == null)
            throw UnsupportedError('duplex endpoint unavailable');
          final count = expectedError == null
              ? _integerArg(entry.args['count'], 'count')
              : _signedIntegerArg(entry.args['count'], 'count');
          currentEndpoint.consumeEgress(count);
          currentHeldEgress = 0;
          actualResult = <String, dynamic>{'count': count};
      }
    } catch (error) {
      actualError = error;
      if (entry.kind == 'duplexIngressPublish' ||
          entry.kind == 'duplexEgressConsume') {
        currentEndpoint?.close();
        currentEndpoint = null;
        currentHeldEgress = 0;
      }
    }
    final replayTrace = runtime._lastCompletedTraceClock;
    if (replayTrace != null) {
      actualResult ??= <String, dynamic>{};
      actualResult['traceClock'] = replayTrace;
    }
    final mismatch = _compareEntry(
      entry,
      expectedError,
      actualError,
      actualResult,
      frameIndex,
    );
    return _ReplayStep(
      endpoint: currentEndpoint,
      heldEgressCount: currentHeldEgress,
      frameCompared: frameCompared,
      mismatch: mismatch,
    );
  }

  PocketReplayMismatch? _compareEntry(
    PocketRecordingEntry entry,
    Map<String, dynamic>? expectedError,
    Object? actualError,
    Map<String, dynamic>? actualResult,
    int frameIndex,
  ) {
    if (expectedError != null) {
      if (actualError == null) {
        return PocketReplayMismatch(
          entryIndex: entry.index,
          transaction: entry.kind,
          frameIndex: frameIndex,
          reason: 'expected transaction error but replay succeeded',
          expected: expectedError,
        );
      }
      final expectedMessage = expectedError['message'];
      final actualMessage = '$actualError';
      if (expectedError['type'] != actualError.runtimeType.toString() ||
          expectedMessage != actualMessage) {
        return PocketReplayMismatch(
          entryIndex: entry.index,
          transaction: entry.kind,
          frameIndex: frameIndex,
          reason: 'transaction error differs',
          expected: expectedError,
          actual: <String, dynamic>{
            'type': actualError.runtimeType.toString(),
            'message': actualMessage,
          },
        );
      }
      return _traceMismatch(entry, actualResult, frameIndex);
    }
    if (actualError != null) {
      return PocketReplayMismatch(
        entryIndex: entry.index,
        transaction: entry.kind,
        frameIndex: frameIndex,
        reason: 'replay transaction threw',
        expected: entry.result,
        actual: '$actualError',
      );
    }
    final expectedFrame = entry.result['frame'];
    final actualFrame = actualResult?['frame'];
    if (_requiresFrameSummary(entry.kind, entry.result) &&
        (!_hasFrameSummary(expectedFrame) || !_hasFrameSummary(actualFrame))) {
      return PocketReplayMismatch(
        entryIndex: entry.index,
        transaction: entry.kind,
        frameIndex: frameIndex,
        reason: 'frame summary is missing or invalid',
        expected: expectedFrame,
        actual: actualFrame,
      );
    }
    if (expectedFrame is Map && actualFrame is Map) {
      if (expectedFrame['sha256'] != actualFrame['sha256']) {
        return PocketReplayMismatch(
          entryIndex: entry.index,
          transaction: entry.kind,
          frameIndex: frameIndex,
          reason: 'first frame output mismatch',
          expected: Map<String, dynamic>.from(expectedFrame),
          actual: Map<String, dynamic>.from(actualFrame),
        );
      }
    }
    final clockMismatch = _traceMismatch(entry, actualResult, frameIndex);
    if (clockMismatch != null) return clockMismatch;
    final expectedComparable = Map<String, dynamic>.from(entry.result)
      ..remove('frame')
      ..remove('traceClock');
    final actualComparable =
        Map<String, dynamic>.from(actualResult ?? const <String, dynamic>{})
          ..remove('frame')
          ..remove('traceClock');
    if (pocketCanonicalJson(expectedComparable) !=
        pocketCanonicalJson(actualComparable)) {
      return PocketReplayMismatch(
        entryIndex: entry.index,
        transaction: entry.kind,
        frameIndex: frameIndex,
        reason: 'transaction result differs',
        expected: expectedComparable,
        actual: actualComparable,
      );
    }
    return null;
  }

  /// A recording remains parseable when an old v1 archive omits diagnostic
  /// evidence, but it must not be reported as a deterministic match. The
  /// native replay runner is the only place that can make that distinction
  /// without adding another schema/state machine to the archive model.
  PocketReplayMismatch? _validateReplayEvidence(PocketRecording recording) {
    final activeWorkerTurns = <String, int>{};
    for (final entry in recording.entries) {
      if (entry.result['traceClock'] is! Map) {
        return PocketReplayMismatch(
          entryIndex: entry.index,
          transaction: entry.kind,
          reason: 'recording clock envelope is missing; replay is unverified',
          expected: 'traceClock',
        );
      }
      final traceClock = entry.result['traceClock'] as Map;
      final workerEvents = traceClock['workerEvents'];
      if (workerEvents is List) {
        for (final rawEvent in workerEvents) {
          if (rawEvent is! Map) continue;
          final kind = rawEvent['kind']?.toString() ?? '';
          final session = rawEvent['session']?.toString() ?? '';
          if (kind == 'turn.begin') {
            if (activeWorkerTurns.containsKey(session)) {
              return PocketReplayMismatch(
                entryIndex: entry.index,
                transaction: entry.kind,
                reason:
                    'worker turn.begin occurred while a turn was already active; replay is unverified',
              );
            }
            activeWorkerTurns[session] = entry.index;
          } else if (kind == 'turn.end' || kind == 'worker.exit') {
            if (kind == 'turn.end' && !activeWorkerTurns.containsKey(session)) {
              return PocketReplayMismatch(
                entryIndex: entry.index,
                transaction: entry.kind,
                reason:
                    'worker turn.end occurred without matching turn.begin; replay is unverified',
              );
            }
            activeWorkerTurns.remove(session);
          }
        }
      }
      if (entry.error != null) continue;
      if (entry.kind == 'frameDelta') {
        final unchanged = entry.result['unchanged'];
        if (unchanged is! bool) {
          return PocketReplayMismatch(
            entryIndex: entry.index,
            transaction: entry.kind,
            reason: 'frame delta outcome is missing; replay is unverified',
            expected: 'result.unchanged',
          );
        }
        if (!unchanged && !_hasFrameSummary(entry.result['frame'])) {
          return PocketReplayMismatch(
            entryIndex: entry.index,
            transaction: entry.kind,
            reason: 'recording frame summary is missing; replay is unverified',
            expected: 'result.frame.sha256',
          );
        }
      } else if (_requiresFrameSummary(entry.kind, entry.result) &&
          !_hasFrameSummary(entry.result['frame'])) {
        return PocketReplayMismatch(
          entryIndex: entry.index,
          transaction: entry.kind,
          reason: 'recording frame summary is missing; replay is unverified',
          expected: 'result.frame.sha256',
        );
      }
    }
    if (activeWorkerTurns.isNotEmpty) {
      final unclosedIndex = activeWorkerTurns.values.first;
      final unclosedEntry = recording.entries.firstWhere(
        (e) => e.index == unclosedIndex,
        orElse: () => recording.entries.last,
      );
      return PocketReplayMismatch(
        entryIndex: unclosedIndex,
        transaction: unclosedEntry.kind,
        reason:
            'worker turn was not closed before recording ended; replay is unverified',
        expected: const <String, Object?>{'workerTurnClosed': true},
        actual: <String, Object?>{
          'activeSessions': activeWorkerTurns.keys.toList(growable: false),
        },
      );
    }
    return null;
  }

  bool _requiresFrameSummary(String kind, Map<String, dynamic> result) {
    if (const <String>{
      'eval',
      'load',
      'loadBytecode',
      'loadFiles',
      'loadBytecodeFiles',
      'frame',
    }.contains(kind)) {
      return true;
    }
    if (kind != 'frameDelta') return false;
    final unchanged = result['unchanged'];
    return unchanged is bool && !unchanged;
  }

  bool _hasFrameSummary(Object? value) {
    if (value is! Map) return false;
    final digest = value['sha256'];
    return digest is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(digest);
  }

  PocketReplayMismatch? _traceMismatch(
    PocketRecordingEntry entry,
    Map<String, dynamic>? actualResult,
    int frameIndex,
  ) {
    final expected = entry.result['traceClock'];
    final actual = actualResult?['traceClock'];
    if (expected == null || _traceEnvelopeMatches(expected, actual))
      return null;
    return PocketReplayMismatch(
      entryIndex: entry.index,
      transaction: entry.kind,
      frameIndex: frameIndex,
      reason: 'transaction clock envelope mismatch',
      expected: expected,
      actual: actual,
    );
  }

  bool _traceEnvelopeMatches(Object? expected, Object? actual) {
    if (expected is! Map || actual is! Map) return false;
    return pocketCanonicalJson(expected) == pocketCanonicalJson(actual);
  }

  double _finiteArg(Object? value, String field) {
    if (value is! num || !value.isFinite)
      throw FormatException('$field is not finite');
    return value.toDouble();
  }

  int _integerArg(Object? value, String field) {
    if (value is! int || value < 1) throw FormatException('$field is invalid');
    return value;
  }

  int _signedIntegerArg(Object? value, String field) {
    if (value is! int) throw FormatException('$field is invalid');
    return value;
  }

  Uint8List _sourceBytes(Object? descriptor, PocketReplayAssets assets) {
    final map = _assetDescriptor(descriptor);
    final digest = map['sha256'] as String?;
    final direct = assets.source == null
        ? null
        : Uint8List.fromList(utf8.encode(assets.source!));
    return _verifyAsset(
      map,
      direct ?? assets.resolve(key: map['key'] as String?, sha256: digest),
    );
  }

  PocketWorkerProgram _workerProgram(
    Map<String, dynamic> config,
    Object? bytecodeDescriptor,
    PocketReplayAssets assets,
  ) {
    final declaration = config['declaration'];
    final policy = config['policy'];
    final limits = config['limits'];
    if (declaration is! Map || policy is! Map || limits is! Map) {
      throw const FormatException('recorded worker config is incomplete');
    }
    final policyFields = Map<String, dynamic>.from(policy);
    final limitFields = Map<String, dynamic>.from(limits);
    final capabilities = policyFields['requiredCapabilities'];
    final origins = policyFields['allowedHttpOrigins'];
    if (capabilities is! List ||
        capabilities.any((value) => value is! String) ||
        origins is! List ||
        origins.any((value) => value is! String)) {
      throw const FormatException('recorded worker grants are invalid');
    }
    return PocketWorkerProgram(
      bytecode: _assetBytes(bytecodeDescriptor, assets),
      declaration: Map<String, Object?>.from(declaration),
      expectedRuntimeAbi: config['expectedRuntimeAbi'] as String,
      bindingGeneration: _integerArg(
        config['bindingGeneration'],
        'bindingGeneration',
      ),
      tickHz: _integerArg(config['tickHz'], 'tickHz'),
      requiredCapabilities: capabilities.cast<String>(),
      allowedHttpOrigins: origins.cast<String>(),
      protocolVersion: _integerArg(
        config['protocolVersion'],
        'protocolVersion',
      ),
      limits: PocketWorkerLimits(
        heapBytes: _integerArg(limitFields['heapBytes'], 'heapBytes'),
        stackBytes: _integerArg(limitFields['stackBytes'], 'stackBytes'),
        turnBudgetMicros: _integerArg(
          limitFields['turnBudgetMicros'],
          'turnBudgetMicros',
        ),
        windowMicros: _integerArg(limitFields['windowMicros'], 'windowMicros'),
        quotaMicros: _integerArg(limitFields['quotaMicros'], 'quotaMicros'),
      ),
    );
  }

  Uint8List _assetBytes(Object? descriptor, PocketReplayAssets assets) {
    final map = _assetDescriptor(descriptor);
    final key = map['key'] as String?;
    final digest = map['sha256'] as String?;
    Uint8List? direct;
    if (key?.startsWith('bytecode:') == true) direct = assets.bytecode;
    if (key?.startsWith('pak:') == true) direct = assets.pak;
    return _verifyAsset(
      map,
      direct ?? assets.resolve(key: key, sha256: digest),
    );
  }

  Map<String, dynamic> _assetDescriptor(Object? value) {
    if (value is! Map)
      throw const FormatException('asset descriptor is not an object');
    final map = Map<String, dynamic>.from(value);
    for (final key in map.keys) {
      if (key != 'key' &&
          key != 'bytes' &&
          key != 'sha256' &&
          key != 'encoding') {
        throw FormatException('asset descriptor has unknown field: $key');
      }
    }
    if (map['key'] != null &&
        (map['key'] is! String || (map['key'] as String).length > 4096)) {
      throw const FormatException('asset key is invalid');
    }
    if (map['bytes'] != null &&
        (map['bytes'] is! int ||
            (map['bytes'] as int) < 0 ||
            (map['bytes'] as int) > 64 * 1024 * 1024)) {
      throw const FormatException('asset byte length is invalid');
    }
    final sha = map['sha256'];
    if (sha != null && sha is! String)
      throw const FormatException('asset digest is invalid');
    if (sha is String &&
        (sha.length != 64 || !RegExp(r'^[0-9a-f]{64}$').hasMatch(sha))) {
      throw const FormatException('asset digest is invalid');
    }
    return map;
  }

  Object? _restoreRecordedMessage(Object? value, int depth) {
    if (depth > 16) throw const FormatException('message nesting is too deep');
    if (value == null || value is bool || value is String || value is num) {
      return value;
    }
    if (value is Uint8List) return value;
    if (value is Map) {
      if (value.length == 1) {
        final rawBytes = value['__pocketBytesBase64'];
        if (rawBytes is String) {
          return _base64Bytes(rawBytes);
        }
        final escaped = value['__pocketEscapedMap'];
        if (escaped is Map) {
          return Map<String, dynamic>.from(escaped);
        }
      }
      final result = <String, dynamic>{};
      for (final entry in value.entries) {
        if (entry.key is! String) {
          throw const FormatException('message key is not string');
        }
        result[entry.key as String] = _restoreRecordedMessage(
          entry.value,
          depth + 1,
        );
      }
      return result;
    }
    if (value is Iterable) {
      return value
          .map((item) => _restoreRecordedMessage(item, depth + 1))
          .toList(growable: false);
    }
    throw const FormatException('unsupported recorded message value');
  }

  Uint8List _base64Bytes(Object? value) {
    if (value is! String || value.length > 4 * 1024 * 1024) {
      throw const FormatException('duplex payload is invalid');
    }
    try {
      return Uint8List.fromList(base64Decode(value));
    } on Object {
      throw const FormatException('duplex payload is not valid base64');
    }
  }

  Uint8List _verifyAsset(Map<String, dynamic> descriptor, Uint8List? bytes) {
    if (bytes == null && descriptor['bytes'] == 0) bytes = Uint8List(0);
    if (bytes == null)
      throw const FormatException('replay asset is unavailable');
    final expectedLength = descriptor['bytes'];
    if (expectedLength is int && expectedLength != bytes.length) {
      throw const FormatException('replay asset length mismatch');
    }
    final expectedSha = descriptor['sha256'];
    if (expectedSha is String && pocketSha256(bytes) != expectedSha) {
      throw const FormatException('replay asset SHA-256 mismatch');
    }
    return bytes;
  }
}

final class _ReplayStep {
  const _ReplayStep({
    required this.endpoint,
    required this.heldEgressCount,
    required this.frameCompared,
    required this.mismatch,
  });

  final PocketDuplexEndpoint? endpoint;
  final int heldEgressCount;
  final bool frameCompared;
  final PocketReplayMismatch? mismatch;
}

extension PocketRecordingReplay on PocketRecording {
  Future<PocketReplayResult> replay({
    required PocketReplayAssets assets,
    PocketReplayRuntimeFactory? runtimeFactory,
  }) => PocketReplayRunner(
    runtimeFactory: runtimeFactory,
  ).run(this, assets: assets);
}

/// Convenience entry point for hosts that keep recordings in a separate
/// diagnostics store (and for isolates, where an extension method is less
/// discoverable).
Future<PocketReplayResult> replayPocketRecording(
  PocketRecording recording, {
  required PocketReplayAssets assets,
  PocketReplayRuntimeFactory? runtimeFactory,
}) => PocketReplayRunner(
  runtimeFactory: runtimeFactory,
).run(recording, assets: assets);

final class _FfiPocketDuplexBindings {
  const _FfiPocketDuplexBindings({
    required this.acquire,
    required this.release,
    required this.releasePointer,
    required this.reserveIngress,
    required this.publishIngress,
    required this.peekEgress,
    required this.consumeEgress,
    required this.abiVersion,
    required this.messageSize,
    required this.capacity,
  });

  final _DuplexEndpointAcquireDart acquire;
  final _DuplexEndpointReleaseDart release;
  final Pointer<NativeFunction<_DuplexEndpointReleaseNative>> releasePointer;
  final _DuplexReserveDart reserveIngress;
  final _DuplexCommitDart publishIngress;
  final _DuplexPeekDart peekEgress;
  final _DuplexCommitDart consumeEgress;
  final _DuplexU32Dart abiVersion;
  final _DuplexU32Dart messageSize;
  final _DuplexU32Dart capacity;
}

// Keep the native finalizer objects reachable for the lifetime of the isolate.
// The callback pointer belongs to the loaded Pocket library, so one finalizer
// per callback address is sufficient for all endpoint leases in that isolate.
final Map<int, NativeFinalizer> _pocketDuplexNativeFinalizers =
    <int, NativeFinalizer>{};

NativeFinalizer _pocketDuplexNativeFinalizer(
  Pointer<NativeFunction<_DuplexEndpointReleaseNative>> callback,
) => _pocketDuplexNativeFinalizers.putIfAbsent(
  callback.address,
  () => NativeFinalizer(callback),
);

final _pocketDuplexScratchFinalizer = Finalizer<_FfiDuplexScratch>(
  (scratch) => scratch.dispose(),
);

final class _FfiDuplexScratch {
  _FfiDuplexScratch()
    : ingressCount = calloc<Uint32>(),
      egressCount = calloc<Uint32>();

  final Pointer<Uint32> ingressCount;
  final Pointer<Uint32> egressCount;
  bool _disposed = false;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    calloc.free(ingressCount);
    calloc.free(egressCount);
  }
}

/// FFI adapter for the retained native SPSC endpoint. Native owns cursor
/// publication; Dart only receives borrowed payload views and commits counts
/// through atomic native calls. The endpoint contains no `ByteData` cursor
/// access. Its lease is not transferable through Dart isolates: an embedding
/// that needs a background producer/consumer must expose an opaque native
/// retain/claim token and reconstruct the endpoint there. The QuickJS step
/// remains owner-thread-only.
final class _FfiPocketDuplexEndpoint
    implements PocketDuplexEndpoint, Finalizable {
  _FfiPocketDuplexEndpoint({
    required Pointer<Void> handle,
    required _DuplexEndpointReleaseDart release,
    required Pointer<NativeFunction<_DuplexEndpointReleaseNative>>
    releasePointer,
    required _DuplexReserveDart reserveIngress,
    required _DuplexCommitDart publishIngress,
    required _DuplexPeekDart peekEgress,
    required _DuplexCommitDart consumeEgress,
    required bool Function() isRecording,
    required void Function(String operation) onDuplexTransactionBegin,
    required void Function(
      String operation,
      int maxMessages,
      int count,
      Uint8List? bytes,
      Object? failure,
    )
    onDuplexTransaction,
  }) : _handle = handle,
       _release = release,
       _reserveIngress = reserveIngress,
       _publishIngress = publishIngress,
       _peekEgress = peekEgress,
       _consumeEgress = consumeEgress,
       _isRecording = isRecording,
       _onDuplexTransactionBegin = onDuplexTransactionBegin,
       _onDuplexTransaction = onDuplexTransaction,
       _scratch = _FfiDuplexScratch(),
       _nativeFinalizer = _pocketDuplexNativeFinalizer(releasePointer) {
    _nativeFinalizer.attach(this, handle, detach: this);
    _pocketDuplexScratchFinalizer.attach(this, _scratch, detach: this);
  }

  final Pointer<Void> _handle;
  final _DuplexEndpointReleaseDart _release;
  final _DuplexReserveDart _reserveIngress;
  final _DuplexCommitDart _publishIngress;
  final _DuplexPeekDart _peekEgress;
  final _DuplexCommitDart _consumeEgress;
  final bool Function() _isRecording;
  final void Function(String operation) _onDuplexTransactionBegin;
  final void Function(
    String operation,
    int maxMessages,
    int count,
    Uint8List? bytes,
    Object? failure,
  )
  _onDuplexTransaction;
  final _FfiDuplexScratch _scratch;
  final NativeFinalizer _nativeFinalizer;
  // Keep scratch counts separate for the two lanes. They are allocated once
  // per endpoint, never per message/call. This endpoint remains isolate-affine;
  // independent lanes do not authorize concurrent calls on the same handle.
  bool _closed = false;
  Uint8List? _borrowedIngress;
  Uint8List? _borrowedEgress;

  @override
  bool get isNativeZeroCopy => true;

  @override
  Uint8List? reserveIngress(int maxMessages) {
    _ensureOpen();
    if (maxMessages < 1) throw RangeError.value(maxMessages, 'maxMessages');
    _scratch.ingressCount.value = 0;
    final pointer = _reserveIngress(
      _handle,
      maxMessages,
      _scratch.ingressCount,
    );
    final view = _view(
      pointer,
      _scratch.ingressCount.value,
      maxMessages,
      'ingress',
    );
    _borrowedIngress = view;
    return view;
  }

  @override
  void publishIngress(int messageCount) {
    _ensureOpen();
    _onDuplexTransactionBegin('ingress.publish');
    final view = _borrowedIngress;
    final byteLength = messageCount > 0
        ? messageCount * PocketDuplexEndpoint.messageByteSize
        : 0;
    final reservedCount =
        (view?.length ?? 0) ~/ PocketDuplexEndpoint.messageByteSize;
    final bytes = !_isRecording() || view == null || byteLength > view.length
        ? null
        : Uint8List.fromList(view.sublist(0, byteLength));
    // Copying happens before the native publish and only while recording is
    // enabled (the endpoint callback is a no-op for disabled runtimes).
    _borrowedIngress = null;
    try {
      _commit(_publishIngress, messageCount, 'ingress publish');
    } catch (error, stack) {
      try {
        _onDuplexTransaction(
          'ingress.publish',
          reservedCount,
          messageCount,
          bytes,
          error,
        );
      } on Object {
        // Recording diagnostics must not hide the native commit error.
      }
      // A native reservation has no rollback ABI. Releasing this endpoint
      // drops the producer token and aborts the pending reservation without
      // publishing an uninitialized slot.
      close();
      Error.throwWithStackTrace(error, stack);
    }
    _onDuplexTransaction(
      'ingress.publish',
      reservedCount,
      messageCount,
      bytes,
      null,
    );
  }

  @override
  Uint8List? peekEgress(int maxMessages) {
    _ensureOpen();
    if (maxMessages < 1) throw RangeError.value(maxMessages, 'maxMessages');
    _onDuplexTransactionBegin('egress.peek');
    _scratch.egressCount.value = 0;
    final pointer = _peekEgress(_handle, maxMessages, _scratch.egressCount);
    final view = _view(
      pointer,
      _scratch.egressCount.value,
      maxMessages,
      'egress',
    );
    _borrowedEgress = !_isRecording() || view == null
        ? null
        : Uint8List.fromList(view);
    _onDuplexTransaction(
      'egress.peek',
      maxMessages,
      _scratch.egressCount.value,
      _borrowedEgress,
      null,
    );
    return view;
  }

  @override
  void consumeEgress(int messageCount) {
    _ensureOpen();
    _onDuplexTransactionBegin('egress.consume');
    final bytes = _borrowedEgress;
    _borrowedEgress = null;
    try {
      _commit(_consumeEgress, messageCount, 'egress consume');
    } catch (error, stack) {
      try {
        _onDuplexTransaction(
          'egress.consume',
          messageCount,
          messageCount,
          bytes,
          error,
        );
      } on Object {
        // Recording diagnostics must not hide the native commit error.
      }
      // A native egress reservation has no rollback ABI; dropping the
      // endpoint releases its pending consumer token without consuming data.
      close();
      Error.throwWithStackTrace(error, stack);
    }
    _onDuplexTransaction(
      'egress.consume',
      messageCount,
      messageCount,
      bytes,
      null,
    );
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _nativeFinalizer.detach(this);
    _pocketDuplexScratchFinalizer.detach(this);
    _release(_handle);
    _scratch.dispose();
  }

  void _ensureOpen() {
    if (_closed) throw StateError('Pocket duplex endpoint is closed');
  }

  static Uint8List? _view(
    Pointer<Uint8> pointer,
    int count,
    int requested,
    String lane,
  ) {
    if (pointer.address == 0 || count == 0) return null;
    if (count > requested) {
      throw StateError('native $lane reservation exceeds requested batch');
    }
    return pointer.asTypedList(count * PocketDuplexEndpoint.messageByteSize);
  }

  void _commit(_DuplexCommitDart commit, int count, String operation) {
    if (count < 1) throw RangeError.value(count, 'messageCount');
    final result = commit(_handle, count);
    if (result != 1) throw PocketRuntimeException('$operation failed');
  }
}

/// Pauses or resumes native scheduler wall-clock accounting when supported.
/// Injected runtimes and legacy hosts keep their existing no-op lifecycle
/// behavior without taking on another [PocketRuntime] member.
void pocketSetSchedulerPaused(PocketRuntime runtime, bool paused) {
  if (runtime case FfiPocketRuntime ffiRuntime) {
    ffiRuntime.setSchedulerPaused(paused);
  }
}

String? _copyString(Pointer<Utf8> pointer) {
  if (pointer.address == 0) return null;
  // `toDart` copies the native NUL-terminated string before the next FFI call.
  return pointer.toDartString();
}
