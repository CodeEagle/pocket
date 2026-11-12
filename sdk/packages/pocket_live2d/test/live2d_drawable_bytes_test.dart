import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_live2d/src/pocket_live2d_types.dart';

PocketLive2dDrawable drawable(
  List<double> positions, {
  List<double>? uvs,
  List<int>? indices,
  double opacity = 1,
}) => PocketLive2dDrawable(
  id: 'buffer',
  textureIndex: 0,
  drawOrder: 0,
  renderOrder: 0,
  blendMode: 0,
  constantFlags: 0,
  dynamicFlags: 0,
  opacity: opacity,
  positionsXYPixels: positions,
  uvs: uvs ?? List<double>.filled(positions.length, 0.25),
  indices: indices ?? (positions.length >= 6 ? const [0, 1, 2] : const []),
  maskIndices: const [],
  multiplyColorRgba: const [1, 1, 1, 1],
  screenColorRgba: const [0, 0, 0, 0],
);

/// Exact Dart port of the former JS `live2d.ts` transform + `mesh.ts`
/// `encodeNovelMesh` pipeline for byte-for-byte fixture comparison.
Uint8List legacyJsEncodeNovelMesh({
  required List<double> positionsXYPixels,
  required List<double> uvs,
  required List<int> indices,
  required double drawableOpacity,
  required double dx,
  required double dy,
  required double scale,
  double modelOpacity = 1.0,
}) {
  final n = positionsXYPixels.length ~/ 2;
  final m = indices.length;
  if (n == 0 || m == 0) return Uint8List(0);
  final vertices = Float32List(n * 4);
  for (var index = 0; index < n; index++) {
    vertices[index * 4] = dx + positionsXYPixels[index * 2] * scale;
    vertices[index * 4 + 1] = dy + positionsXYPixels[index * 2 + 1] * scale;
    vertices[index * 4 + 2] = uvs[index * 2];
    vertices[index * 4 + 3] = 1.0 - uvs[index * 2 + 1];
  }
  final clamped = (drawableOpacity * modelOpacity).clamp(0.0, 1.0);
  final opacityByte = (clamped * 255.0 + 0.5).floor();
  final color = ((opacityByte << 24) | 0x00ffffff) & 0xffffffff;
  final bytes = Uint8List(16 + n * 16 + m * 4);
  final view = ByteData.sublistView(bytes);
  view.setUint32(0, 0x31534d50, Endian.little);
  view.setUint32(4, n, Endian.little);
  view.setUint32(8, m, Endian.little);
  view.setUint32(12, color, Endian.little);
  for (var i = 0; i < vertices.length; i++) {
    view.setFloat32(16 + i * 4, vertices[i], Endian.little);
  }
  for (var i = 0; i < m; i++) {
    view.setUint32(16 + n * 16 + i * 4, indices[i], Endian.little);
  }
  return bytes;
}

void main() {
  test(
    'PMS1 packer matches legacy JS transform and encodeNovelMesh byte-for-byte',
    () {
      const positions = <double>[
        12.5,
        -3.25,
        104.125,
        88.75,
        -42.0,
        215.5,
        0.3333333432674408,
        19.875,
      ];
      const uvs = <double>[
        -0.0003222227,
        0.0,
        1.0,
        0.25,
        0.5,
        1.0,
        0.125,
        0.875,
      ];
      const indices = <int>[0, 1, 2, 0, 2, 3];
      const placement = PocketLive2dPlacement(
        dx: 14.25,
        dy: -8.5,
        scale: 0.165,
        opacity: 0.4,
      );
      final d = PocketLive2dDrawable(
        id: 'ArtMeshFixture',
        textureIndex: 0,
        drawOrder: 1,
        renderOrder: 2,
        blendMode: 0,
        constantFlags: 0,
        dynamicFlags: 1,
        opacity: 0.85,
        positionsXYPixels: positions,
        uvs: uvs,
        indices: indices,
        maskIndices: const [0],
        multiplyColorRgba: const [1, 1, 1, 1],
        screenColorRgba: const [0, 0, 0, 1],
      );
      final packed =
          d.toJson(packedMesh: true, placement: placement)['meshBytes']!
              as Uint8List;
      final expected = legacyJsEncodeNovelMesh(
        positionsXYPixels: positions,
        uvs: uvs,
        indices: indices,
        drawableOpacity: 0.85,
        dx: placement.dx,
        dy: placement.dy,
        scale: placement.scale,
        modelOpacity: placement.opacity,
      );
      expect(packed, expected);
    },
  );

  test(
    'float32 subview uses only its logical range and owns response bytes',
    () {
      final backing = Float32List.fromList([
        99,
        -0.0,
        1.25,
        -7.5,
        88,
        10.0,
        20.0,
        30.0,
      ]);
      final view = Float32List.sublistView(backing, 1, 7);
      final packet = drawable(view).toJson(packedMesh: true);
      final bytes = packet['meshBytes']! as Uint8List;
      final expected = legacyJsEncodeNovelMesh(
        positionsXYPixels: view,
        uvs: List<double>.filled(6, 0.25),
        indices: const [0, 1, 2],
        drawableOpacity: 1,
        dx: 0,
        dy: 0,
        scale: 1,
      );
      expect(bytes, expected);
      backing.fillRange(0, backing.length, 123);
      expect(
        bytes,
        expected,
        reason: 'a provider update cannot mutate a response',
      );
      bytes[0] ^= 0xff;
      expect(
        backing,
        everyElement(123),
        reason: 'responses do not expose provider buffers',
      );
    },
  );

  test(
    'read-only float32 arrays encode the same little-endian PMS1 wire values',
    () {
      final values = Float32List.fromList([
        -0.0,
        0.0,
        -1.5,
        3.5,
        12.25,
        -8.75,
      ]).asUnmodifiableView();
      final bytes =
          drawable(values).toJson(packedMesh: true)['meshBytes']! as Uint8List;
      expect(
        bytes,
        legacyJsEncodeNovelMesh(
          positionsXYPixels: values,
          uvs: List<double>.filled(6, 0.25),
          indices: const [0, 1, 2],
          drawableOpacity: 1,
          dx: 0,
          dy: 0,
          scale: 1,
        ),
      );
      expect(() => values[0] = 0, throwsUnsupportedError);
      expect(() => values.buffer.asUint8List()[0] = 0, throwsUnsupportedError);
    },
  );

  test(
    'generic provider doubles retain float32 rounding and response isolation',
    () {
      final values = [1.0 / 3, -0.0, 1e-40, 2.5, -4.0, 8.0];
      final bytes =
          drawable(values).toJson(packedMesh: true)['meshBytes']! as Uint8List;
      expect(
        bytes,
        legacyJsEncodeNovelMesh(
          positionsXYPixels: values,
          uvs: List<double>.filled(6, 0.25),
          indices: const [0, 1, 2],
          drawableOpacity: 1,
          dx: 0,
          dy: 0,
          scale: 1,
        ),
      );
      values[0] = 99;
      expect(
        ByteData.sublistView(bytes).getFloat32(16, Endian.little),
        Float32List.fromList([1.0 / 3])[0],
      );
    },
  );

  test(
    'empty typed and generic arrays retain the full/cached protocol shape',
    () {
      for (final positions in <List<double>>[Float32List(0), const []]) {
        expect(
          drawable(positions).toJson(packedMesh: true)['meshBytes'],
          isEmpty,
        );
        final cached = drawable(
          positions,
        ).toJson(packedMesh: true, includeTopology: false);
        expect(cached['meshBytes'], isEmpty);
        expect(cached.containsKey('maskIndices'), isFalse);
      }
    },
  );
}
