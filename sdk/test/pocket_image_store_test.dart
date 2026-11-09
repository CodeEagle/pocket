import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/src/pocket_image_store.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  late Directory directory;
  late PocketImageStore store;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('pocket-image-store-');
    store = PocketImageStore(directory: directory);
  });

  tearDown(() async {
    await store.close();
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test(
    'stores immutable content IDs by private app scope and reopens them',
    () async {
      final png = _png(2, 1, <int>[255, 0, 0, 255, 0, 0, 255, 128]);
      final first = await store.put('app.one', png);
      expect(first.id, sha256.convert(png).toString());
      expect(first.width, 2);
      expect(first.height, 1);

      // A repeat save deduplicates by content and does not consume another slot.
      final repeated = await store.put('app.one', Uint8List.fromList(png));
      expect(repeated.id, first.id);
      expect(await store.list('app.one'), <Map<String, Object?>>[
        <String, Object?>{'id': first.id, 'width': 2, 'height': 1},
      ]);

      // The same ID is private to its app directory.
      expect(await store.read('app.two', first.id), isNull);
      expect(await store.list('app.two'), isEmpty);
      expect(await store.remove('app.two', first.id), isFalse);
      expect((await store.read('app.one', first.id))!.pngBytes, png);

      await store.close();
      store = PocketImageStore(directory: directory);
      final reopened = await store.read('app.one', first.id);
      expect(reopened, isNotNull);
      expect(reopened!.pngBytes, png);
      expect(await store.list('app.one'), hasLength(1));
    },
  );

  test(
    'quotas preserve existing images and enforce image ID validation',
    () async {
      await store.close();
      store = PocketImageStore(
        directory: directory,
        maxImageBytes: 64 * 1024,
        maxAppBytes: 128 * 1024,
        maxImagesPerApp: 1,
      );
      final firstPng = _png(1, 1, <int>[220, 20, 60, 255]);
      final secondPng = _png(1, 1, <int>[20, 80, 220, 255]);
      final first = await store.put('app.one', firstPng);
      await expectLater(
        store.put('app.one', secondPng),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'image_store_quota',
          ),
        ),
      );
      expect(await store.list('app.one'), hasLength(1));
      expect((await store.read('app.one', first.id))!.pngBytes, firstPng);
      await expectLater(
        Future<Object?>.sync(() => store.read('app.one', '../${first.id}')),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'invalid_image_id',
          ),
        ),
      );
    },
  );

  test('rejects oversized, malformed, and tampered image data', () async {
    final png = _png(1, 1, <int>[10, 20, 30, 255]);
    await expectLater(
      store.put('app.one', Uint8List(512 * 1024 + 1)),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'image_too_large',
        ),
      ),
    );
    await expectLater(
      store.put('app.one', Uint8List.fromList(<int>[1, 2, 3, 4])),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_image',
        ),
      ),
    );

    final stored = await store.put('app.one', png);
    final appKey = sha256.convert(utf8.encode('app.one')).toString();
    final file = File('${directory.path}/$appKey/${stored.id}.png');
    final changed = Uint8List.fromList(png);
    changed[changed.length - 1] ^= 1;
    await file.writeAsBytes(changed, flush: true);
    await expectLater(
      store.read('app.one', stored.id),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'image_store_corrupt',
        ),
      ),
    );
  });

  test('does not follow an image-ID symlink', () async {
    if (Platform.isWindows) return;
    final stored = await store.put(
      'app.one',
      _png(1, 1, <int>[10, 20, 30, 255]),
    );
    final appKey = sha256.convert(utf8.encode('app.one')).toString();
    final path = '${directory.path}/$appKey/${stored.id}.png';
    await File(path).delete();
    final outside = File('${directory.parent.path}/outside-image.png');
    await outside.writeAsBytes(_png(1, 1, <int>[1, 2, 3, 255]));
    await Link(path).create(outside.path);
    try {
      await expectLater(
        store.read('app.one', stored.id),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'image_store_corrupt',
          ),
        ),
      );
      expect(await outside.exists(), isTrue);
    } finally {
      await Link(path).delete();
      await outside.delete();
    }
  });
}

Uint8List _png(int width, int height, List<int> rgba) {
  if (rgba.length != width * height * 4) {
    throw ArgumentError('RGBA source must match the requested image size');
  }
  final header = ByteData(13)
    ..setUint32(0, width, Endian.big)
    ..setUint32(4, height, Endian.big)
    ..setUint8(8, 8) // 8 bits per channel
    ..setUint8(9, 6); // RGBA
  final scanlines = <int>[];
  for (var row = 0; row < height; row++) {
    scanlines.add(0); // PNG filter: None
    scanlines.addAll(rgba.skip(row * width * 4).take(width * 4));
  }
  return Uint8List.fromList(<int>[
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ..._chunk('IHDR', header.buffer.asUint8List()),
    ..._chunk('IDAT', ZLibEncoder().convert(scanlines)),
    ..._chunk('IEND', const <int>[]),
  ]);
}

List<int> _chunk(String type, List<int> data) {
  final payload = <int>[...utf8.encode(type), ...data];
  final crc = _crc32(payload);
  final length = ByteData(4)..setUint32(0, data.length, Endian.big);
  final checksum = ByteData(4)..setUint32(0, crc, Endian.big);
  return <int>[
    ...length.buffer.asUint8List(),
    ...payload,
    ...checksum.buffer.asUint8List(),
  ];
}

int _crc32(List<int> bytes) {
  var value = 0xffffffff;
  for (final byte in bytes) {
    value ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      value = value & 1 == 1 ? (value >> 1) ^ 0xedb88320 : value >> 1;
    }
  }
  return (value ^ 0xffffffff) & 0xffffffff;
}
