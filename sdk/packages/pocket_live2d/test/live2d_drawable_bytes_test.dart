import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_live2d/src/pocket_live2d_types.dart';

PocketLive2dDrawable drawable(List<double> positions) => PocketLive2dDrawable(
  id: 'buffer',
  textureIndex: 0,
  drawOrder: 0,
  renderOrder: 0,
  blendMode: 0,
  constantFlags: 0,
  dynamicFlags: 0,
  opacity: 1,
  positionsXYPixels: positions,
  uvs: const [],
  indices: const [],
  maskIndices: const [],
  multiplyColorRgba: const [1, 1, 1, 1],
  screenColorRgba: const [0, 0, 0, 0],
);

Uint8List reference(List<double> values) {
  final bytes = Uint8List(values.length * 4);
  final data = ByteData.sublistView(bytes);
  for (var index = 0; index < values.length; index++) {
    data.setFloat32(index * 4, values[index], Endian.little);
  }
  return bytes;
}

void main() {
  test(
    'float32 subview uses only its logical range and owns response bytes',
    () {
      final backing = Float32List.fromList([99, -0.0, 1.25, -7.5, 88]);
      final view = Float32List.sublistView(backing, 1, 4);
      final packet = drawable(view).toJson();
      final bytes = packet['positionsXYPixels']! as Uint8List;
      final expected = reference(view);
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
    'read-only float32 arrays encode the same little-endian wire values',
    () {
      final values = Float32List.fromList([
        -0.0,
        0.0,
        -1.5,
        3.4028234663852886e38,
        1.401298464324817e-45,
        double.infinity,
        double.negativeInfinity,
        double.nan,
      ]).asUnmodifiableView();
      final bytes =
          drawable(values).toJson()['positionsXYPixels']! as Uint8List;
      expect(bytes, reference(values));
      expect(() => values[0] = 0, throwsUnsupportedError);
      expect(() => values.buffer.asUint8List()[0] = 0, throwsUnsupportedError);
    },
  );

  test(
    'generic provider doubles retain float32 rounding and response isolation',
    () {
      final values = [1.0 / 3, -0.0, 1e-40, double.infinity];
      final bytes =
          drawable(values).toJson()['positionsXYPixels']! as Uint8List;
      expect(bytes, reference(values));
      values[0] = 99;
      expect(
        ByteData.sublistView(bytes).getFloat32(0, Endian.little),
        Float32List.fromList([1.0 / 3])[0],
      );
    },
  );

  test(
    'empty typed and generic arrays retain the full/cached protocol shape',
    () {
      for (final positions in <List<double>>[Float32List(0), const []]) {
        expect(drawable(positions).toJson()['positionsXYPixels'], isEmpty);
        final cached = drawable(positions).toJson(includeTopology: false);
        expect(cached['positionsXYPixels'], isEmpty);
        expect(cached.containsKey('uvs'), isFalse);
        expect(cached.containsKey('indices'), isFalse);
        expect(cached.containsKey('maskIndices'), isFalse);
      }
    },
  );
}
