import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  for (final image in _imageFixtures) {
    test(
      'resource conversion handles PSM ${image.psm} offset views and padding',
      () {
        final pixelsStorage = Uint8List(image.pixels.length + 2)
          ..[0] = 0xee
          ..setRange(1, 1 + image.pixels.length, image.pixels)
          ..[image.pixels.length + 1] = 0xdd;
        final pixels = Uint8List.sublistView(pixelsStorage, 1);
        Uint8List? paletteStorage;
        Uint8List? palette;
        if (image.palette != null) {
          paletteStorage = Uint8List(image.palette!.length + 2)
            ..[0] = 0xee
            ..setRange(1, 1 + image.palette!.length, image.palette!)
            ..[image.palette!.length + 1] = 0xdd;
          palette = Uint8List.sublistView(paletteStorage, 1);
        }
        final resource = PocketImageResource(
          asset: 'pixel',
          width: 1,
          height: 1,
          psm: image.psm,
          linear: false,
          pixels: pixels,
          palette: palette,
        );

        final decoded = PocketPakImages.fromResource(resource);

        expect(decoded, isNotNull);
        expect(decoded!.rgba, image.rgba);
        pixelsStorage[1] ^= 0xff;
        if (paletteStorage != null) paletteStorage[5] ^= 0xff;
        expect(decoded.rgba, image.rgba, reason: 'RGBA output owns its data');
      },
    );
  }

  for (final image in _imageFixtures) {
    for (final compressed in <bool>[false, true]) {
      test(
        'PAK extraction handles PSM ${image.psm} compressed=$compressed offset views and padding',
        () {
          final pak = _singleImagePak(image, compressed: compressed);
          const prefix = 3;
          const padding = 5;
          final storage = Uint8List(prefix + pak.length + padding)
            ..setRange(prefix, prefix + pak.length, pak);
          final imagePak = Uint8List.sublistView(storage, prefix);

          final images = PocketPakImages.extract(imagePak);

          expect(images.keys, containsAll(<String>['hero', 'ui:img.hero']));
          expect(images['hero'], same(images['ui:img.hero']));
          expect(images['hero']!.rgba, image.rgba);
          storage[prefix + pak.length - 1] ^= 0xff;
          expect(
            images['hero']!.rgba,
            image.rgba,
            reason: 'RGBA output owns its data after extraction',
          );
        },
      );
    }
  }
}

final _imageFixtures =
    <({int psm, List<int> pixels, List<int>? palette, List<int> rgba})>[
      (
        psm: 0,
        pixels: <int>[31, 0],
        palette: null,
        rgba: <int>[255, 0, 0, 255],
      ),
      (
        psm: 2,
        pixels: <int>[0x0f, 0xf0],
        palette: null,
        rgba: <int>[255, 0, 0, 255],
      ),
      (
        psm: 3,
        pixels: <int>[255, 0, 0, 255],
        palette: null,
        rgba: <int>[255, 0, 0, 255],
      ),
      (
        psm: 5,
        pixels: <int>[1],
        palette: <int>[..._paletteWithPixelOne],
        rgba: <int>[11, 22, 33, 44],
      ),
    ];

final _paletteWithPixelOne = (() {
  final palette = List<int>.filled(1024, 0);
  palette.setRange(4, 8, <int>[11, 22, 33, 44]);
  return palette;
})();

Uint8List _singleImagePak(
  ({int psm, List<int> pixels, List<int>? palette, List<int> rgba}) image, {
  required bool compressed,
}) {
  const name = 'ui:img.hero';
  const directory = 32;
  const names = directory + 24;
  final blob = names + name.length;
  final paletteBytes = image.palette ?? const <int>[];
  final pixels = compressed
      ? <int>[image.pixels.length - 1, ...image.pixels]
      : image.pixels;
  final blobLength = 8 + paletteBytes.length + pixels.length;
  final pak = Uint8List(blob + blobLength);
  final data = ByteData.sublistView(pak);
  data
    ..setUint32(0, 0x4b504344, Endian.little) // DCPK
    ..setUint16(4, 1, Endian.little)
    ..setUint32(8, 1, Endian.little)
    ..setUint32(12, directory, Endian.little)
    ..setUint32(16, names, Endian.little)
    ..setUint32(directory + 4, blob, Endian.little)
    ..setUint32(directory + 8, blobLength, Endian.little)
    ..setUint32(directory + 12, 0, Endian.little)
    ..setUint16(directory + 16, name.length, Endian.little)
    ..setUint16(blob, 1, Endian.little)
    ..setUint16(blob + 2, 1, Endian.little)
    ..setUint8(blob + 4, image.psm)
    ..setUint8(blob + 5, compressed ? 1 : 0);
  pak.setRange(names, names + name.length, utf8.encode(name));
  pak
    ..setRange(blob + 8, blob + 8 + paletteBytes.length, paletteBytes)
    ..setRange(blob + 8 + paletteBytes.length, blob + blobLength, pixels);
  return pak;
}
