import 'dart:convert';
import 'dart:ffi';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'pocket_duplex.dart';
import 'pocket_model.dart';

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

typedef _CreateNative = Pointer<Void> Function(Double width, Double height);
typedef _CreateDart = Pointer<Void> Function(double width, double height);
typedef _CreateDensityNative = Pointer<Void> Function(Double, Double, Uint32);
typedef _CreateDensityDart = Pointer<Void> Function(double, double, int);
typedef _CreateDensityTickNative =
    Pointer<Void> Function(Double, Double, Uint32, Uint32);
typedef _CreateDensityTickDart =
    Pointer<Void> Function(double, double, int, int);
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
    implements PocketRuntime, PocketBytecodeRuntime, PocketBinaryDuplexRuntime {
  FfiPocketRuntime._({
    required DynamicLibrary library,
    required Pointer<Void> handle,
  }) : _library = library,
       _handle = handle,
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
  final Pointer<Void> _handle;
  final _EvalDart _eval;
  final _FrameDart _frame;
  _FrameDart? _frameDelta;
  bool _frameDeltaLookedUp = false;
  _FrameBinaryDart? _frameDeltaBinary;
  bool _frameDeltaBinaryLookedUp = false;
  _EnableAuxiliaryDart? _enableAuxiliary;
  _ResizeViewportDart? _resizeViewport;
  bool _resizeViewportLookedUp = false;
  final _SendDart _send;
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

  /// Opens a real QuickJS/PocketJS host. [tickHz] must match the bundle's
  /// compiler `--hz` value; it is not the display refresh rate. The native
  /// fixed-step clock uses the fractional delta supplied by [frameAt] and may
  /// advance multiple 120-Hz guest turns on a 60-Hz Flutter ticker.
  static FfiPocketRuntime open({
    double width = 360,
    double height = 640,
    int rasterDensity = 1,
    int tickHz = 60,
  }) {
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
    );
    if (handle.address == 0) {
      throw const PocketRuntimeException(
        'pocket_create returned a null handle',
      );
    }
    // Native creation can return an opaque handle carrying an initialization
    // error (for example, when the compositor capability could not be
    // installed). Do not let an unusable handle escape into the widget tree.
    final runtime = FfiPocketRuntime._(library: library, handle: handle);
    final error = runtime.lastError;
    if (error != null && error.isNotEmpty) {
      runtime.dispose();
      throw PocketRuntimeException('pocket_create failed: $error');
    }
    return runtime;
  }

  static Pointer<Void> _createHandle(
    DynamicLibrary library,
    double width,
    double height,
    int rasterDensity,
    int tickHz,
  ) {
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

  @override
  PocketFrame eval(String source) {
    _checkAlive();
    final sourcePointer = source.toNativeUtf8(allocator: calloc);
    try {
      final result = _eval(_handle, sourcePointer);
      if (result != 0) _throwLastError('pocket_eval failed');
      return frame(0);
    } finally {
      calloc.free(sourcePointer);
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
    try {
      final result = load(_handle, sourcePointer, pakPointer, pak.length);
      if (result != 0) _throwLastError('pocket_load failed');
      return frame(0);
    } finally {
      calloc.free(sourcePointer);
      if (pakPointer.address != 0) calloc.free(pakPointer);
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
    final bytecodePointer = calloc<Uint8>(bytecode.length);
    final pakPointer = calloc<Uint8>(pak.length);
    bytecodePointer.asTypedList(bytecode.length).setAll(0, bytecode);
    pakPointer.asTypedList(pak.length).setAll(0, pak);
    try {
      final result = load(
        _handle,
        bytecodePointer,
        bytecode.length,
        pakPointer,
        pak.length,
      );
      if (result != 0) _throwLastError('pocket_load_bytecode failed');
      return frame(0);
    } finally {
      calloc.free(bytecodePointer);
      calloc.free(pakPointer);
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
    try {
      final result = loadFiles(_handle, bytecodePointer, pakPointer);
      if (result != 0) _throwLastError('pocket_load_bytecode_files failed');
      return frame(0);
    } finally {
      calloc.free(bytecodePointer);
      calloc.free(pakPointer);
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
          'pocket_bytecode_actual_abi',
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
    try {
      final result = loadFiles(_handle, sourcePointer, pakPointer);
      if (result != 0) _throwLastError('pocket_load_files failed');
      return frame(0);
    } finally {
      calloc.free(sourcePointer);
      calloc.free(pakPointer);
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
    final pointer = _frame(
      _handle,
      deltaMilliseconds.clamp(0.0, 1000.0).toDouble(),
    );
    return _readFullFrame(pointer, 'pocket_frame returned no frame');
  }

  /// Calls the optional delta ABI. A missing symbol is normal when an older
  /// mobile library is loaded, so lookup failure permanently falls back to the
  /// legacy full-frame call for this runtime instance.
  PocketFrame? frameDeltaAt(double deltaMilliseconds) {
    _checkAlive();
    final binary = _lookupFrameDeltaBinary();
    if (binary != null) {
      final length = calloc<Uint64>();
      try {
        length.value = 0;
        final pointer = binary(
          _handle,
          deltaMilliseconds.clamp(0.0, 1000.0).toDouble(),
          length,
        );
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
        // The native pointer is borrowed until the next FFI call. Copy it
        // before parsing so model construction never observes mutable native
        // storage and no native allocation crosses the Dart boundary.
        final bytes = Uint8List.fromList(pointer.asTypedList(byteLength));
        return PocketFrame.fromBinary(bytes);
      } finally {
        calloc.free(length);
      }
    }
    final frameDelta = _lookupFrameDelta();
    if (frameDelta == null) return frameAt(deltaMilliseconds);
    final pointer = frameDelta(
      _handle,
      deltaMilliseconds.clamp(0.0, 1000.0).toDouble(),
    );
    final json = _copyString(pointer);
    if (json == null || json.isEmpty) {
      _throwLastError('pocket_frame_delta returned no frame');
    }
    final error = lastError;
    if (error != null && error.isNotEmpty) {
      throw PocketRuntimeException(error);
    }
    if (json == '{"unchanged":true}') return null;
    return PocketFrame.fromJson(json);
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

  @override
  void enableAuxiliary(double width, double height) {
    _checkAlive();
    final enable = _enableAuxiliary ??= _library
        .lookupFunction<_EnableAuxiliaryNative, _EnableAuxiliaryDart>(
          'pocket_enable_auxiliary',
        );
    final result = enable(_handle, width, height);
    if (result != 0) _throwLastError('pocket_enable_auxiliary failed');
  }

  @override
  bool resizeViewport(double width, double height) {
    _checkAlive();
    final resize = _lookupResizeViewport();
    // This is an optional ABI addition. A library built before live viewport
    // support remains usable with its original fixed logical surface.
    if (resize == null) return false;
    final result = resize(_handle, width, height);
    if (result != 0) _throwLastError('pocket_resize_viewport failed');
    return true;
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
    final step = _lookupDuplexStep();
    if (step == null) return 0;
    final result = step(_handle);
    if (result < 0) _throwLastError('pocket_duplex_step failed');
    return result;
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

  @override
  void send(Map<String, dynamic> message) {
    _checkAlive();
    final encoded = jsonEncode(message);
    final pointer = encoded.toNativeUtf8(allocator: calloc);
    try {
      final result = _send(_handle, pointer);
      if (result != 0) _throwLastError('pocket_send failed');
    } finally {
      calloc.free(pointer);
    }
  }

  @override
  String? get lastError => _copyString(_lastError(_handle));

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final endpoint in _duplexEndpoints) {
      endpoint.close();
    }
    _duplexEndpoints.clear();
    _destroy(_handle);
  }

  void _checkAlive() {
    if (_disposed) {
      throw const PocketRuntimeException('Pocket runtime is disposed');
    }
  }

  Never _throwLastError(String fallback) {
    throw PocketRuntimeException(lastError ?? fallback);
  }
}

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
  }) : _handle = handle,
       _release = release,
       _reserveIngress = reserveIngress,
       _publishIngress = publishIngress,
       _peekEgress = peekEgress,
       _consumeEgress = consumeEgress,
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
  final _FfiDuplexScratch _scratch;
  final NativeFinalizer _nativeFinalizer;
  // Keep scratch counts separate for the two lanes. They are allocated once
  // per endpoint, never per message/call. This endpoint remains isolate-affine;
  // independent lanes do not authorize concurrent calls on the same handle.
  bool _closed = false;

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
    return _view(pointer, _scratch.ingressCount.value, maxMessages, 'ingress');
  }

  @override
  void publishIngress(int messageCount) {
    _ensureOpen();
    _commit(_publishIngress, messageCount, 'ingress publish');
  }

  @override
  Uint8List? peekEgress(int maxMessages) {
    _ensureOpen();
    if (maxMessages < 1) throw RangeError.value(maxMessages, 'maxMessages');
    _scratch.egressCount.value = 0;
    final pointer = _peekEgress(_handle, maxMessages, _scratch.egressCount);
    return _view(pointer, _scratch.egressCount.value, maxMessages, 'egress');
  }

  @override
  void consumeEgress(int messageCount) {
    _ensureOpen();
    _commit(_consumeEgress, messageCount, 'egress consume');
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

String? _copyString(Pointer<Utf8> pointer) {
  if (pointer.address == 0) return null;
  // `toDart` copies the native NUL-terminated string before the next FFI call.
  return pointer.toDartString();
}
