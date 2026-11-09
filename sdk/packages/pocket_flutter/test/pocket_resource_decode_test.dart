import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

Future<Uint8List> pixels(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  return data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final psm in [0, 2, 3, 5]) {
    test(
      'owned resource decode matches public conversion for PSM $psm',
      () async {
        final palette = Uint8List(1024)
          ..setRange(4, 8, [255, 91, 17, 128])
          ..setRange(8, 12, [255, 255, 255, 0]);
        final source = switch (psm) {
          0 => Uint8List.fromList([0x1f, 0, 0xe0, 0x07]),
          2 => Uint8List.fromList([0xaf, 0x80, 0xff, 0x0f]),
          3 => Uint8List.fromList([255, 91, 17, 128, 255, 255, 255, 0]),
          _ => Uint8List.fromList([1, 2]),
        };
        final original = Uint8List.fromList(source);
        final originalPalette = Uint8List.fromList(palette);
        final resource = PocketImageResource(
          asset: 'owned',
          width: 2,
          height: 1,
          psm: psm,
          linear: false,
          pixels: source,
          palette: psm == 5 ? palette : null,
        );
        final straight = PocketPakImages.fromResource(resource)!;
        final straightBefore = Uint8List.fromList(straight.rgba);
        final reference = await straight.decode();
        final actual = await PocketPakImages.decodeResource(resource)!;
        final repeated = await PocketPakImages.decodeResource(resource)!;
        try {
          final expected = await pixels(reference);
          expect(await pixels(actual), expected);
          expect(
            await pixels(repeated),
            expected,
            reason: 'the input cannot be premultiplied twice',
          );
          expect(source, original);
          expect(palette, originalPalette);
          expect(
            straight.rgba,
            straightBefore,
            reason: 'public PocketPakImage.decode keeps straight RGBA intact',
          );
          if (psm != 0) {
            expect(expected.sublist(4), [
              0,
              0,
              0,
              0,
            ], reason: 'transparent white must not leave a bright fringe');
          }
        } finally {
          reference.dispose();
          actual.dispose();
          repeated.dispose();
        }
      },
    );
  }

  test(
    '2048 RGBA resource retains every decoded pixel and source byte',
    () async {
      const size = 2048;
      final source = Uint8List(size * size * 4);
      for (var offset = 0; offset < source.length; offset += 4) {
        source[offset] = (offset ~/ 4) & 255;
        source[offset + 1] = (offset ~/ (size * 4)) & 255;
        source[offset + 2] = 255;
        source[offset + 3] = [0, 64, 128, 255][(offset ~/ 4) % 4];
      }
      final before = Uint8List.fromList(source);
      final resource = PocketImageResource(
        asset: 'atlas',
        width: size,
        height: size,
        psm: 3,
        linear: false,
        pixels: source,
      );
      final reference = await PocketPakImages.fromResource(resource)!.decode();
      final actual = await PocketPakImages.decodeResource(resource)!;
      try {
        expect(actual.width, size);
        expect(actual.height, size);
        expect(
          listEquals(await pixels(actual), await pixels(reference)),
          isTrue,
        );
        expect(listEquals(source, before), isTrue);
      } finally {
        actual.dispose();
        reference.dispose();
      }
    },
  );

  test('unsupported and truncated resources keep the no-image result', () {
    for (final resource in [
      PocketImageResource(
        asset: 'bad',
        width: 1,
        height: 1,
        psm: 3,
        linear: false,
        pixels: Uint8List(3),
      ),
      PocketImageResource(
        asset: 'unknown',
        width: 1,
        height: 1,
        psm: 99,
        linear: false,
        pixels: Uint8List(4),
      ),
      PocketImageResource(
        asset: 'palette',
        width: 1,
        height: 1,
        psm: 5,
        linear: false,
        pixels: Uint8List(1),
        palette: Uint8List(4),
      ),
    ]) {
      expect(PocketPakImages.decodeResource(resource), isNull);
    }
  });
}
