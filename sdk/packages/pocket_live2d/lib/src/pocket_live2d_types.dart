import 'dart:typed_data';

/// Injectable boundary for tests and native integration harnesses.
/// Returned drawable arrays are Dart copies, never pointers into Cubism Core.
typedef PocketLive2dCoreFactory =
    PocketLive2dCoreModel Function(Uint8List moc3Bytes);

abstract interface class PocketLive2dCoreModel {
  PocketLive2dCanvas get canvas;
  int get drawableCount;
  int get mocVersion;
  int get nativeBytes;
  List<PocketLive2dParameterDefault> get parameterDefaults;
  int get parameterCount;

  void resetToDefaults();
  void setParameter(String id, double value);
  void setPartOpacity(String id, double opacity);
  void update();

  /// Reads one drawable's current pose using the original complete-frame API.
  PocketLive2dDrawable drawableAt(int index);
  void dispose();
}

/// Optional extension for providers that can avoid copying static Cubism
/// topology after its first frame. Existing injected Core providers keep their
/// original [PocketLive2dCoreModel] contract and continue to return full data.
abstract interface class PocketLive2dCoreTopologyReader {
  PocketLive2dDrawable drawableAtWithTopology(
    int index, {
    bool includeTopology = true,
  });
}

/// Optional real Core facts needed by JS physics and pose. Existing injected
/// providers remain valid for motion/expression without fabricating ranges.
abstract interface class PocketLive2dCoreMetadata {
  List<PocketLive2dParameterMetadata> get parameterMetadata;
  List<PocketLive2dPartMetadata> get parts;
}

final class PocketLive2dParameterMetadata {
  const PocketLive2dParameterMetadata({
    required this.id,
    required this.minimum,
    required this.maximum,
    required this.defaultValue,
  });
  final String id;
  final double minimum;
  final double maximum;
  final double defaultValue;
  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'minimum': minimum,
    'maximum': maximum,
    'defaultValue': defaultValue,
  };
}

final class PocketLive2dPartMetadata {
  const PocketLive2dPartMetadata({
    required this.id,
    required this.defaultOpacity,
  });
  final String id;
  final double defaultOpacity;
  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'defaultOpacity': defaultOpacity,
  };
}

final class PocketLive2dParameterDefault {
  const PocketLive2dParameterDefault({required this.id, required this.value});

  final String id;
  final double value;

  Map<String, Object?> toJson() => <String, Object?>{'id': id, 'value': value};
}

final class PocketLive2dCanvas {
  const PocketLive2dCanvas({
    required this.widthPixels,
    required this.heightPixels,
    required this.originXPixels,
    required this.originYPixels,
    required this.pixelsPerUnit,
  });

  final double widthPixels;
  final double heightPixels;
  final double originXPixels;
  final double originYPixels;
  final double pixelsPerUnit;

  Map<String, Object?> toJson() => <String, Object?>{
    'widthPixels': widthPixels,
    'heightPixels': heightPixels,
    'originXPixels': originXPixels,
    'originYPixels': originYPixels,
    'pixelsPerUnit': pixelsPerUnit,
  };
}

final class PocketLive2dDrawable {
  const PocketLive2dDrawable({
    required this.id,
    required this.textureIndex,
    required this.drawOrder,
    required this.renderOrder,
    required this.blendMode,
    required this.constantFlags,
    required this.dynamicFlags,
    required this.opacity,
    int? vertexCount,
    int? indexCount,
    int? maskCount,
    required this.positionsXYPixels,
    required this.uvs,
    required this.indices,
    required this.maskIndices,
    required this.multiplyColorRgba,
    required this.screenColorRgba,
  }) : vertexCount = vertexCount ?? positionsXYPixels.length ~/ 2,
       indexCount = indexCount ?? indices.length,
       maskCount = maskCount ?? maskIndices.length;

  final String id;
  final int textureIndex;
  final int drawOrder;
  final int renderOrder;
  final int blendMode;
  final int constantFlags;
  final int dynamicFlags;
  final double opacity;

  /// Topology sizes are returned even when the static arrays are not copied.
  final int vertexCount;
  final int indexCount;
  final int maskCount;
  final List<double> positionsXYPixels;
  final List<double> uvs;
  final List<int> indices;
  final List<int> maskIndices;
  final List<double> multiplyColorRgba;
  final List<double> screenColorRgba;

  Map<String, Object?> toJson({bool includeTopology = true}) =>
      <String, Object?>{
        'id': id,
        'textureIndex': textureIndex,
        'drawOrder': drawOrder,
        'renderOrder': renderOrder,
        'blendMode': blendMode,
        'constantFlags': constantFlags,
        'dynamicFlags': dynamicFlags,
        'opacity': opacity,
        'positionsXYPixels': _float32Bytes(positionsXYPixels),
        if (includeTopology) 'uvs': _float32Bytes(uvs),
        if (includeTopology) 'indices': _uint16Bytes(indices),
        if (includeTopology) 'maskIndices': _uint32Bytes(maskIndices),
        'multiplyColorRgba': _float32Bytes(multiplyColorRgba),
        'screenColorRgba': _float32Bytes(screenColorRgba),
      };
}

Uint8List _float32Bytes(List<double> values) {
  if (values is Float32List && Endian.host == Endian.little) {
    // The FFI provider already owns a detached float32 snapshot. Copy its bytes
    // without boxing every component and writing it back to the same format.
    // Keep this response detached even for mutable injected-provider arrays.
    return Uint8List.fromList(
      Uint8List.view(values.buffer, values.offsetInBytes, values.lengthInBytes),
    );
  }
  final bytes = Uint8List(values.length * 4);
  final data = ByteData.sublistView(bytes);
  for (var index = 0; index < values.length; index++) {
    data.setFloat32(index * 4, values[index], Endian.little);
  }
  return bytes;
}

Uint8List _uint16Bytes(List<int> values) {
  final bytes = Uint8List(values.length * 2);
  final data = ByteData.sublistView(bytes);
  for (var index = 0; index < values.length; index++) {
    final value = values[index];
    if (value < 0 || value > 0xffff) {
      throw StateError(
        'Cubism Core returned an index outside the uint16 range',
      );
    }
    data.setUint16(index * 2, value, Endian.little);
  }
  return bytes;
}

Uint8List _uint32Bytes(List<int> values) {
  final bytes = Uint8List(values.length * 4);
  final data = ByteData.sublistView(bytes);
  for (var index = 0; index < values.length; index++) {
    final value = values[index];
    if (value < 0 || value > 0xffffffff) {
      throw StateError(
        'Cubism Core returned a mask index outside uint32 range',
      );
    }
    data.setUint32(index * 4, value, Endian.little);
  }
  return bytes;
}
