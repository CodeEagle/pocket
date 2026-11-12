import 'dart:math' as math;
import 'dart:typed_data';

/// Injectable boundary for tests and native integration harnesses.
/// Returned drawable arrays are Dart copies, never pointers into Cubism Core.
typedef PocketLive2dCoreFactory =
    PocketLive2dCoreModel Function(Uint8List moc3Bytes);

const int pocketLive2dPms1Magic = 0x31534d50;

final class PocketLive2dPlacement {
  const PocketLive2dPlacement({
    this.dx = 0.0,
    this.dy = 0.0,
    this.scale = 1.0,
    this.opacity = 1.0,
  });

  static const PocketLive2dPlacement identity = PocketLive2dPlacement();

  final double dx;
  final double dy;
  final double scale;
  final double opacity;
}

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

/// Optional extension for providers that pack transformed PMS1 mesh bytes
/// directly during the native update pass.
abstract interface class PocketLive2dCorePlacementUpdater {
  void updateWithPlacement(PocketLive2dPlacement placement);
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
    this.pms1Bytes,
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
  final Uint8List? pms1Bytes;

  Uint8List packPms1({
    PocketLive2dPlacement placement = PocketLive2dPlacement.identity,
    List<double>? uvsOverride,
    List<int>? indicesOverride,
  }) {
    final prepacked = pms1Bytes;
    if (prepacked != null) {
      return Uint8List.fromList(prepacked);
    }
    return packPocketLive2dDrawablePms1(
      positionsXYPixels: positionsXYPixels,
      uvs: uvsOverride ?? uvs,
      indices: indicesOverride ?? indices,
      drawableOpacity: opacity,
      placement: placement,
    );
  }

  Map<String, Object?> toJson({
    bool packedMesh = true,
    bool includeTopology = true,
    PocketLive2dPlacement placement = PocketLive2dPlacement.identity,
    List<double>? uvsOverride,
    List<int>? indicesOverride,
  }) => <String, Object?>{
    'id': id,
    'textureIndex': textureIndex,
    'drawOrder': drawOrder,
    'renderOrder': renderOrder,
    'blendMode': blendMode,
    'constantFlags': constantFlags,
    'dynamicFlags': dynamicFlags,
    'opacity': opacity,
    if (packedMesh)
      'meshBytes': packPms1(
        placement: placement,
        uvsOverride: uvsOverride,
        indicesOverride: indicesOverride,
      )
    else ...<String, Object?>{
      // Keep unnegotiated replies as ordinary lists. Older Guests validate
      // these fields with Array.isArray and cannot read typed buffers.
      'positionsXYPixels': List<double>.of(positionsXYPixels),
      if (includeTopology) 'uvs': List<double>.of(uvs),
      if (includeTopology) 'indices': List<int>.of(indices),
    },
    if (includeTopology)
      'maskIndices': packedMesh
          ? _uint32Bytes(maskIndices)
          : List<int>.of(maskIndices),
    'multiplyColorRgba': packedMesh
        ? _float32Bytes(multiplyColorRgba)
        : List<double>.of(multiplyColorRgba),
    'screenColorRgba': packedMesh
        ? _float32Bytes(screenColorRgba)
        : List<double>.of(screenColorRgba),
  };
}

/// Packs one Live2D drawable into the exact PMS1 binary layout produced by
/// `@pocket/vn` `encodeNovelMesh` (16-byte header, interleaved `[x, y, u, 1 - v]`
/// float32 vertices, uint32 triangle indices).
Uint8List packPocketLive2dDrawablePms1({
  required List<double> positionsXYPixels,
  required List<double> uvs,
  required List<int> indices,
  required double drawableOpacity,
  PocketLive2dPlacement placement = PocketLive2dPlacement.identity,
}) {
  final vertexCount = positionsXYPixels.length ~/ 2;
  final indexCount = indices.length;
  if (vertexCount == 0 || indexCount == 0) {
    return Uint8List(0);
  }
  if (positionsXYPixels.length != vertexCount * 2 ||
      uvs.length != vertexCount * 2 ||
      vertexCount < 1 ||
      vertexCount > 16384 ||
      indexCount < 3 ||
      indexCount > 98304 ||
      indexCount % 3 != 0) {
    throw StateError('Invalid Live2D drawable mesh vertex/index counts');
  }
  final bytes = Uint8List(16 + vertexCount * 16 + indexCount * 4);
  final data = ByteData.sublistView(bytes);
  final clampedOpacity = (drawableOpacity * placement.opacity).clamp(0.0, 1.0);
  final opacityByte = (clampedOpacity * 255.0 + 0.5).floor();
  final color = ((opacityByte << 24) | 0x00ffffff) & 0xffffffff;
  data.setUint32(0, pocketLive2dPms1Magic, Endian.little);
  data.setUint32(4, vertexCount, Endian.little);
  data.setUint32(8, indexCount, Endian.little);
  data.setUint32(12, color, Endian.little);

  final dx = placement.dx;
  final dy = placement.dy;
  final scale = placement.scale;
  var byteOffset = 16;
  for (var vertex = 0; vertex < vertexCount; vertex++) {
    final pairOffset = vertex * 2;
    final px = positionsXYPixels[pairOffset];
    final py = positionsXYPixels[pairOffset + 1];
    final u = uvs[pairOffset];
    final v = 1.0 - uvs[pairOffset + 1];
    data.setFloat32(byteOffset, dx + px * scale, Endian.little);
    data.setFloat32(byteOffset + 4, dy + py * scale, Endian.little);
    data.setFloat32(byteOffset + 8, u, Endian.little);
    data.setFloat32(byteOffset + 12, v, Endian.little);
    byteOffset += 16;
  }
  for (var index = 0; index < indexCount; index++) {
    final vertexIndex = indices[index];
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      throw StateError('Live2D drawable index outside vertex range');
    }
    data.setUint32(byteOffset, vertexIndex, Endian.little);
    byteOffset += 4;
  }
  return math.max(0, bytes.length) == 0 ? Uint8List(0) : bytes;
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
