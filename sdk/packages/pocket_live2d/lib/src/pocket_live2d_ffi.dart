import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'pocket_live2d_types.dart';

/// Official Core bridge implementation for the `native/include` C ABI.
///
/// Apple targets statically link the adapter and official Core through the
/// platform plugin; Android bundles an arm64 shared library; Windows bundles
/// the x86_64 adapter and the Core runtime DLL.
abstract final class PocketLive2dFfiCore {
  static PocketLive2dCoreModel createModel(
    Uint8List moc3Bytes, {
    DynamicLibrary? library,
  }) {
    return _FfiLive2dModel(
      _Live2dBindings(library ?? _openLibrary()),
      moc3Bytes,
    );
  }

  static DynamicLibrary _openLibrary() {
    final abi = Abi.current();
    if (Platform.isAndroid && abi == Abi.androidArm64) {
      return DynamicLibrary.open('libpocket_live2d.so');
    }
    if (Platform.isIOS && abi == Abi.iosArm64) {
      return DynamicLibrary.process();
    }
    if (Platform.isMacOS && (abi == Abi.macosArm64 || abi == Abi.macosX64)) {
      return DynamicLibrary.process();
    }
    if (Platform.isWindows && abi == Abi.windowsX64) {
      return DynamicLibrary.open('pocket_live2d.dll');
    }
    throw UnsupportedError(
      'Cubism Core has no configured Pocket FFI target for '
      '${Platform.operatingSystem} (${abi.toString()})',
    );
  }
}

final class _Live2dBindings {
  _Live2dBindings(DynamicLibrary library)
    : _create = library.lookupFunction<_CreateNative, _CreateDart>(
        'pocket_live2d_model_create',
      ),
      _destroy = library.lookupFunction<_DestroyNative, _DestroyDart>(
        'pocket_live2d_model_destroy',
      ),
      _mocVersion = library.lookupFunction<_MocVersionNative, _MocVersionDart>(
        'pocket_live2d_moc_version',
      ),
      _getCanvas = library.lookupFunction<_GetCanvasNative, _GetCanvasDart>(
        'pocket_live2d_model_get_canvas',
      ),
      _nativeBytes = library
          .lookupFunction<_NativeBytesNative, _NativeBytesDart>(
            'pocket_live2d_model_native_bytes',
          ),
      _getParameterCount = library
          .lookupFunction<_GetParameterCountNative, _GetParameterCountDart>(
            'pocket_live2d_model_get_parameter_count',
          ),
      _getParameter = library
          .lookupFunction<_GetParameterNative, _GetParameterDart>(
            'pocket_live2d_model_get_parameter',
          ),
      _getPartCount = library
          .lookupFunction<_GetParameterCountNative, _GetParameterCountDart>(
            'pocket_live2d_model_get_part_count',
          ),
      _getPart = library.lookupFunction<_GetPartNative, _GetPartDart>(
        'pocket_live2d_model_get_part',
      ),
      _resetToDefaults = library
          .lookupFunction<_ResetToDefaultsNative, _ResetToDefaultsDart>(
            'pocket_live2d_model_reset_to_defaults',
          ),
      _setParameter = library
          .lookupFunction<_SetParameterNative, _SetParameterDart>(
            'pocket_live2d_model_set_parameter',
          ),
      _setPartOpacity = library
          .lookupFunction<_SetPartOpacityNative, _SetPartOpacityDart>(
            'pocket_live2d_model_set_part_opacity',
          ),
      _update = library.lookupFunction<_UpdateNative, _UpdateDart>(
        'pocket_live2d_model_update',
      ),
      _getDrawableCount = library
          .lookupFunction<_GetDrawableCountNative, _GetDrawableCountDart>(
            'pocket_live2d_model_get_drawable_count',
          ),
      _getDrawable = library
          .lookupFunction<_GetDrawableNative, _GetDrawableDart>(
            'pocket_live2d_model_get_drawable',
          ),
      _statusMessage = library
          .lookupFunction<_StatusMessageNative, _StatusMessageDart>(
            'pocket_live2d_status_message',
          );

  final _CreateDart _create;
  final _DestroyDart _destroy;
  final _MocVersionDart _mocVersion;
  final _GetCanvasDart _getCanvas;
  final _NativeBytesDart _nativeBytes;
  final _GetParameterCountDart _getParameterCount;
  final _GetParameterDart _getParameter;
  final _GetParameterCountDart _getPartCount;
  final _GetPartDart _getPart;
  final _ResetToDefaultsDart _resetToDefaults;
  final _SetParameterDart _setParameter;
  final _SetPartOpacityDart _setPartOpacity;
  final _UpdateDart _update;
  final _GetDrawableCountDart _getDrawableCount;
  final _GetDrawableDart _getDrawable;
  final _StatusMessageDart _statusMessage;

  Pointer<Void> create(Uint8List bytes) {
    final input = calloc<Uint8>(bytes.length);
    final error = calloc<Char>(1024);
    try {
      input.asTypedList(bytes.length).setAll(0, bytes);
      final model = _create(input, bytes.length, error, 1024);
      if (model.address == 0) {
        final message = error.cast<Utf8>().toDartString();
        throw StateError(
          message.isEmpty ? 'Cubism Core model creation failed' : message,
        );
      }
      return model;
    } finally {
      calloc.free(error);
      calloc.free(input);
    }
  }

  int mocVersion(Pointer<Void> model) => _mocVersion(model);

  int nativeBytes(Pointer<Void> model) => _nativeBytes(model);

  List<PocketLive2dParameterMetadata> parameterMetadata(Pointer<Void> model) {
    final count = parameterCount(model);
    final output = calloc<_NativeParameterInfo>();
    try {
      return List<PocketLive2dParameterMetadata>.unmodifiable(
        List<PocketLive2dParameterMetadata>.generate(count, (index) {
          check(_getParameter(model, index, output), 'read parameter $index');
          final parameter = output.ref;
          return PocketLive2dParameterMetadata(
            id: parameter.id.cast<Utf8>().toDartString(),
            minimum: parameter.minimum,
            maximum: parameter.maximum,
            defaultValue: parameter.defaultValue,
          );
        }, growable: false),
      );
    } finally {
      calloc.free(output);
    }
  }

  List<PocketLive2dPartMetadata> parts(Pointer<Void> model) {
    final count = _getPartCount(model);
    if (count < 0)
      throw StateError('Cubism Core returned invalid part count $count');
    final output = calloc<_NativePartInfo>();
    try {
      return List<PocketLive2dPartMetadata>.unmodifiable(
        List<PocketLive2dPartMetadata>.generate(count, (index) {
          check(_getPart(model, index, output), 'read part $index');
          return PocketLive2dPartMetadata(
            id: output.ref.id.cast<Utf8>().toDartString(),
            defaultOpacity: output.ref.defaultOpacity,
          );
        }, growable: false),
      );
    } finally {
      calloc.free(output);
    }
  }

  PocketLive2dCanvas canvas(Pointer<Void> model) {
    final output = calloc<_NativeCanvasInfo>();
    try {
      check(_getCanvas(model, output), 'read canvas');
      final info = output.ref;
      return PocketLive2dCanvas(
        widthPixels: info.widthPixels,
        heightPixels: info.heightPixels,
        originXPixels: info.originXPixels,
        originYPixels: info.originYPixels,
        pixelsPerUnit: info.pixelsPerUnit,
      );
    } finally {
      calloc.free(output);
    }
  }

  int parameterCount(Pointer<Void> model) {
    final count = _getParameterCount(model);
    if (count < 0)
      throw StateError('Cubism Core returned invalid parameter count $count');
    return count;
  }

  void resetToDefaults(Pointer<Void> model) =>
      check(_resetToDefaults(model), 'reset model defaults');

  void setParameter(Pointer<Void> model, String id, double value) {
    final nativeId = id.toNativeUtf8(allocator: calloc).cast<Char>();
    try {
      check(_setParameter(model, nativeId, value), 'set parameter "$id"');
    } finally {
      calloc.free(nativeId);
    }
  }

  void setPartOpacity(Pointer<Void> model, String id, double opacity) {
    final nativeId = id.toNativeUtf8(allocator: calloc).cast<Char>();
    try {
      check(
        _setPartOpacity(model, nativeId, opacity),
        'set part opacity "$id"',
      );
    } finally {
      calloc.free(nativeId);
    }
  }

  void update(Pointer<Void> model) => check(_update(model), 'update model');

  int drawableCount(Pointer<Void> model) {
    final count = _getDrawableCount(model);
    if (count < 0)
      throw StateError('Cubism Core returned invalid drawable count $count');
    return count;
  }

  PocketLive2dDrawable drawable(
    Pointer<Void> model,
    int index, {
    bool includeTopology = true,
  }) {
    final output = calloc<_NativeDrawableInfo>();
    try {
      check(_getDrawable(model, index, output), 'read drawable $index');
      final info = output.ref;
      final vertexCount = info.vertexCount;
      final indexCount = info.indexCount;
      final maskCount = info.maskCount;
      if (vertexCount < 0 || indexCount < 0 || maskCount < 0) {
        throw StateError(
          'Cubism Core returned a negative drawable buffer size',
        );
      }
      return PocketLive2dDrawable(
        id: info.id.cast<Utf8>().toDartString(),
        textureIndex: info.textureIndex,
        drawOrder: info.drawOrder,
        renderOrder: info.renderOrder,
        blendMode: info.blendMode,
        constantFlags: info.constantFlags,
        dynamicFlags: info.dynamicFlags,
        opacity: info.opacity,
        vertexCount: vertexCount,
        indexCount: indexCount,
        maskCount: maskCount,
        positionsXYPixels: _copyFloats(info.positionsXYPixels, vertexCount * 2),
        uvs: includeTopology
            ? _copyFloats(info.uvs, vertexCount * 2)
            : const <double>[],
        indices: includeTopology
            ? _copyU16(info.indices, indexCount)
            : const <int>[],
        maskIndices: includeTopology
            ? _copyI32(info.maskIndices, maskCount)
            : const <int>[],
        multiplyColorRgba: _copyFloats(info.multiplyColorRgba, 4),
        screenColorRgba: _copyFloats(info.screenColorRgba, 4),
      );
    } finally {
      calloc.free(output);
    }
  }

  void destroy(Pointer<Void> model) => _destroy(model);

  void check(int status, String operation) {
    if (status == 0) return;
    final message = _statusMessage(status).cast<Utf8>().toDartString();
    throw StateError(
      'Cubism Core could not $operation (${status.toRadixString(10)}): $message',
    );
  }
}

final class _FfiLive2dModel
    implements
        PocketLive2dCoreModel,
        PocketLive2dCoreMetadata,
        PocketLive2dCoreTopologyReader {
  _FfiLive2dModel(this._bindings, Uint8List moc3Bytes)
    : _handle = _bindings.create(moc3Bytes),
      _disposed = false {
    try {
      _mocVersion = _bindings.mocVersion(_handle);
      _nativeBytes = _bindings.nativeBytes(_handle);
      _canvas = _bindings.canvas(_handle);
      _parameterMetadata = _bindings.parameterMetadata(_handle);
      _parts = _bindings.parts(_handle);
      _drawableCount = _bindings.drawableCount(_handle);
    } catch (_) {
      _bindings.destroy(_handle);
      rethrow;
    }
  }

  final _Live2dBindings _bindings;
  final Pointer<Void> _handle;
  bool _disposed;
  late final int _mocVersion;
  late final int _nativeBytes;
  late final PocketLive2dCanvas _canvas;
  late final List<PocketLive2dParameterMetadata> _parameterMetadata;
  late final List<PocketLive2dPartMetadata> _parts;
  late int _drawableCount;

  @override
  PocketLive2dCanvas get canvas {
    _ensureOpen();
    return _canvas;
  }

  @override
  int get drawableCount {
    _ensureOpen();
    return _drawableCount;
  }

  @override
  int get mocVersion {
    _ensureOpen();
    return _mocVersion;
  }

  @override
  int get nativeBytes {
    _ensureOpen();
    return _nativeBytes;
  }

  @override
  List<PocketLive2dParameterDefault> get parameterDefaults {
    _ensureOpen();
    return List<PocketLive2dParameterDefault>.unmodifiable(
      _parameterMetadata.map(
        (entry) => PocketLive2dParameterDefault(
          id: entry.id,
          value: entry.defaultValue,
        ),
      ),
    );
  }

  @override
  List<PocketLive2dParameterMetadata> get parameterMetadata {
    _ensureOpen();
    return _parameterMetadata;
  }

  @override
  List<PocketLive2dPartMetadata> get parts {
    _ensureOpen();
    return _parts;
  }

  @override
  int get parameterCount {
    _ensureOpen();
    return _parameterMetadata.length;
  }

  @override
  void resetToDefaults() {
    _ensureOpen();
    _bindings.resetToDefaults(_handle);
  }

  @override
  void setParameter(String id, double value) {
    _ensureOpen();
    _bindings.setParameter(_handle, id, value);
  }

  @override
  void setPartOpacity(String id, double opacity) {
    _ensureOpen();
    _bindings.setPartOpacity(_handle, id, opacity);
  }

  @override
  void update() {
    _ensureOpen();
    _bindings.update(_handle);
    _drawableCount = _bindings.drawableCount(_handle);
  }

  @override
  PocketLive2dDrawable drawableAt(int index) => drawableAtWithTopology(index);

  @override
  PocketLive2dDrawable drawableAtWithTopology(
    int index, {
    bool includeTopology = true,
  }) {
    _ensureOpen();
    if (index < 0 || index >= _drawableCount) {
      throw RangeError.index(index, this, 'index', null, _drawableCount);
    }
    return _bindings.drawable(_handle, index, includeTopology: includeTopology);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _bindings.destroy(_handle);
  }

  void _ensureOpen() {
    if (_disposed) throw StateError('Cubism Core model is disposed');
  }
}

List<double> _copyFloats(Pointer<Float> source, int count) {
  if (count == 0) return const <double>[];
  if (source.address == 0)
    throw StateError('Cubism Core returned a null float buffer');
  return Float32List.fromList(source.asTypedList(count)).asUnmodifiableView();
}

List<int> _copyU16(Pointer<Uint16> source, int count) {
  if (count == 0) return const <int>[];
  if (source.address == 0)
    throw StateError('Cubism Core returned a null index buffer');
  return List<int>.unmodifiable(source.asTypedList(count));
}

List<int> _copyI32(Pointer<Int32> source, int count) {
  if (count == 0) return const <int>[];
  if (source.address == 0)
    throw StateError('Cubism Core returned a null mask buffer');
  return List<int>.unmodifiable(source.asTypedList(count));
}

final class _NativeCanvasInfo extends Struct {
  @Float()
  external double widthPixels;
  @Float()
  external double heightPixels;
  @Float()
  external double originXPixels;
  @Float()
  external double originYPixels;
  @Float()
  external double pixelsPerUnit;
}

final class _NativeParameterInfo extends Struct {
  external Pointer<Char> id;
  @Float()
  external double minimum;
  @Float()
  external double maximum;
  @Float()
  external double defaultValue;
  @Float()
  external double value;
}

final class _NativePartInfo extends Struct {
  external Pointer<Char> id;
  @Float()
  external double defaultOpacity;
}

final class _NativeDrawableInfo extends Struct {
  external Pointer<Char> id;
  @Int32()
  external int textureIndex;
  @Int32()
  external int drawOrder;
  @Int32()
  external int renderOrder;
  @Int32()
  external int blendMode;
  @Uint8()
  external int constantFlags;
  @Uint8()
  external int dynamicFlags;
  @Float()
  external double opacity;
  @Int32()
  external int vertexCount;
  @Int32()
  external int indexCount;
  @Int32()
  external int maskCount;
  external Pointer<Float> positionsXYPixels;
  external Pointer<Float> uvs;
  external Pointer<Uint16> indices;
  external Pointer<Int32> maskIndices;
  external Pointer<Float> multiplyColorRgba;
  external Pointer<Float> screenColorRgba;
}

typedef _CreateNative =
    Pointer<Void> Function(Pointer<Uint8>, IntPtr, Pointer<Char>, IntPtr);
typedef _CreateDart =
    Pointer<Void> Function(Pointer<Uint8>, int, Pointer<Char>, int);
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _DestroyDart = void Function(Pointer<Void>);
typedef _MocVersionNative = Int32 Function(Pointer<Void>);
typedef _MocVersionDart = int Function(Pointer<Void>);
typedef _NativeBytesNative = IntPtr Function(Pointer<Void>);
typedef _NativeBytesDart = int Function(Pointer<Void>);
typedef _GetCanvasNative =
    Int32 Function(Pointer<Void>, Pointer<_NativeCanvasInfo>);
typedef _GetCanvasDart =
    int Function(Pointer<Void>, Pointer<_NativeCanvasInfo>);
typedef _GetParameterCountNative = Int32 Function(Pointer<Void>);
typedef _GetParameterCountDart = int Function(Pointer<Void>);
typedef _GetParameterNative =
    Int32 Function(Pointer<Void>, Int32, Pointer<_NativeParameterInfo>);
typedef _GetParameterDart =
    int Function(Pointer<Void>, int, Pointer<_NativeParameterInfo>);
typedef _GetPartNative =
    Int32 Function(Pointer<Void>, Int32, Pointer<_NativePartInfo>);
typedef _GetPartDart =
    int Function(Pointer<Void>, int, Pointer<_NativePartInfo>);
typedef _ResetToDefaultsNative = Int32 Function(Pointer<Void>);
typedef _ResetToDefaultsDart = int Function(Pointer<Void>);
typedef _SetParameterNative =
    Int32 Function(Pointer<Void>, Pointer<Char>, Float);
typedef _SetParameterDart = int Function(Pointer<Void>, Pointer<Char>, double);
typedef _SetPartOpacityNative =
    Int32 Function(Pointer<Void>, Pointer<Char>, Float);
typedef _SetPartOpacityDart =
    int Function(Pointer<Void>, Pointer<Char>, double);
typedef _UpdateNative = Int32 Function(Pointer<Void>);
typedef _UpdateDart = int Function(Pointer<Void>);
typedef _GetDrawableCountNative = Int32 Function(Pointer<Void>);
typedef _GetDrawableCountDart = int Function(Pointer<Void>);
typedef _GetDrawableNative =
    Int32 Function(Pointer<Void>, Int32, Pointer<_NativeDrawableInfo>);
typedef _GetDrawableDart =
    int Function(Pointer<Void>, int, Pointer<_NativeDrawableInfo>);
typedef _StatusMessageNative = Pointer<Char> Function(Int32);
typedef _StatusMessageDart = Pointer<Char> Function(int);
