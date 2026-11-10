import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  test(
    'viewport baseline reset resynchronizes texture pixels through v2',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          let mounted = false;
          globalThis.frame = function() {
            if (mounted) return;
            mounted = true;
            const node = ui.createNode(2);
            ui.setProp(node, 1, 16);
            ui.setProp(node, 2, 16);
            const texture = ui.uploadTexture(new Uint8Array([10, 20, 30, 255]), 1, 1, 3);
            ui.setImage(node, texture);
            ui.insertBefore(1, node, 0);
          };
        ''');
        final original = initial.resources.single;
        expect(runtime.resizeViewport(360, 640), isTrue);
        final resynchronized = runtime.frameDeltaAt(0)!;
        expect(resynchronized.width, 360);
        expect(resynchronized.height, 640);
        expect(resynchronized.sequence, isNotNull);
        expect(resynchronized.resources.single.asset, original.asset);
        expect(resynchronized.resources.single.pixels, original.pixels);
        expect(runtime.frameDeltaAt(0), isNull);
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'resource-bearing baseline survives unchanged marker then applies a patch',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          const imageNode = ui.createNode(2);
          ui.setProp(imageNode, 1, 16);
          ui.setProp(imageNode, 2, 16);
          const texture = ui.uploadTexture(
            new Uint8Array([10, 20, 30, 255]), 1, 1, 3
          );
          ui.setImage(imageNode, texture);
          ui.insertBefore(1, imageNode, 0);

          const rectNode = ui.createNode(0);
          ui.setProp(rectNode, 1, 16);
          ui.setProp(rectNode, 2, 16);
          ui.setProp(rectNode, 24, 1);
          ui.setProp(rectNode, 28, 40);
          ui.setProp(rectNode, 25, 40);
          ui.setProp(rectNode, 64, 0xff336699);
          ui.insertBefore(1, rectNode, 1);

          globalThis.frame = function() {};
          globalThis.__pocketEvent = function(packet) {
            if (packet.name === 'notify') {
              pocket._emitValue({
                type: 'event',
                name: 'event-applied',
                payload: {},
              });
            }
          };
          globalThis.__pocketEvent.__binaryCapable = true;
        ''');
        expect(initial.resources, hasLength(1));
        final originalPixels = Uint8List.fromList(
          initial.resources.single.pixels,
        );

        // The second call is the native zero-byte unchanged marker. The
        // runtime must retain its operation base without retaining this
        // caller-visible resource payload as part of that private base.
        expect(runtime.frameDeltaAt(0), isNull);

        runtime.send(const <String, dynamic>{
          'type': 'event',
          'name': 'notify',
          'payload': <String, dynamic>{},
        });
        final patched = runtime.frameDeltaAt(0)!;
        expect(patched.events.single.method, 'event-applied');
        expect(patched.resources, isEmpty);
        expect(identical(patched.ops, initial.ops), isTrue);
        expect(initial.resources.single.pixels, originalPixels);
        expect(runtime.frameDeltaAt(0), isNull);
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    '2048-wide PFB1 resources stay owned after native output is replaced',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.load(r'''
          const largeNode = ui.createNode(2);
          ui.setProp(largeNode, 1, 320);
          ui.setProp(largeNode, 2, 240);
          ui.setImage(largeNode, ui.__textures.large_a);
          ui.insertBefore(1, largeNode, 0);
          const indexedNode = ui.createNode(2);
          ui.setProp(indexedNode, 1, 16);
          ui.setProp(indexedNode, 2, 16);
          ui.setImage(indexedNode, ui.__textures.palette_a);
          ui.insertBefore(1, indexedNode, 0);
          globalThis.frame = function() {};
          globalThis.__pocketEvent = function(packet) {
            if (packet.name === "replace-image-resources") {
              ui.setImage(largeNode, ui.__textures.large_b);
              ui.setImage(indexedNode, ui.__textures.palette_b);
            }
          };
          globalThis.__pocketEvent.__binaryCapable = true;
        ''', _largeResourcePak());

        expect(
          initial.resources.any((resource) => resource.width == 2048),
          isTrue,
          reason:
              'resources=${initial.resources.map((resource) => '${resource.width}x${resource.height}/psm${resource.psm}').toList()} '
              'ops=${initial.ops.map((op) => op.runtimeType).toList()} '
              'error=${runtime.lastError}',
        );
        final originalLarge = initial.resources.singleWhere(
          (resource) => resource.width == 2048,
        );
        final originalIndexed = initial.resources.singleWhere(
          (resource) => resource.psm == 5,
        );
        expect(originalLarge.height, 1024);
        expect(originalLarge.psm, 3);
        expect(originalLarge.pixels.length, 2048 * 1024 * 4);
        expect(originalLarge.pixels.first, 17);
        expect(originalLarge.pixels.last, 17);
        expect(originalIndexed.pixels, Uint8List.fromList(<int>[45]));
        expect(originalIndexed.palette, hasLength(1024));
        expect(originalIndexed.palette!.first, 41);
        expect(originalIndexed.palette![3], 44);
        final originalLargeHash = _hashBytes(originalLarge.pixels);
        final originalPaletteHash = _hashBytes(originalIndexed.palette!);

        runtime.send(const <String, dynamic>{
          'type': 'event',
          'name': 'replace-image-resources',
          'payload': <String, dynamic>{},
        });
        final replacement = runtime.frameDeltaAt(0)!;
        final replacementLarge = replacement.resources.singleWhere(
          (resource) => resource.width == 2048,
        );
        final replacementIndexed = replacement.resources.singleWhere(
          (resource) => resource.psm == 5,
        );
        expect(replacementLarge.asset, 'large_b');
        expect(replacementLarge.pixels.first, 93);
        expect(replacementLarge.pixels.last, 93);
        expect(replacementIndexed.asset, 'palette_b');
        expect(replacementIndexed.pixels, Uint8List.fromList(<int>[105]));
        expect(replacementIndexed.palette!.first, 101);

        // The native binary output has been replaced by a frame containing
        // different 2048-wide pixels and palette bytes. Parsed resource lists
        // must own their data instead of viewing the borrowed FFI buffer.
        expect(_hashBytes(originalLarge.pixels), originalLargeHash);
        expect(_hashBytes(originalIndexed.palette!), originalPaletteHash);

        final elapsedMicros = <int>[];
        for (var index = 0; index < 8; index++) {
          final width = index.isEven ? 321.0 : 320.0;
          expect(runtime.resizeViewport(width, 480), isTrue);
          final stopwatch = Stopwatch()..start();
          final resynchronized = runtime.frameDeltaAt(0)!;
          stopwatch.stop();
          final transported = resynchronized.resources.singleWhere(
            (resource) => resource.width == 2048,
          );
          expect(transported.pixels.length, 2048 * 1024 * 4);
          expect(transported.pixels.first, 93);
          if (index >= 2) elapsedMicros.add(stopwatch.elapsedMicroseconds);
        }
        final orderedMicros = List<int>.of(elapsedMicros)..sort();
        final medianMicros = (orderedMicros[2] + orderedMicros[3]) ~/ 2;
        // This stable-size real FFI resync is also the before/after timing
        // fixture. The number is diagnostic only; correctness is asserted
        // above, without a wall-clock threshold.
        // ignore: avoid_print
        print(
          'PFB1_COPY_ABLATION 2048x1024 rgbaBytes=${2048 * 1024 * 4} '
          'samplesMicros=${elapsedMicros.join(',')} medianMicros=$medianMicros',
        );
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'v2 binary operation splice is expanded into one full retained frame',
    () {
      final recording = PocketRecordingController();
      final runtime = FfiPocketRuntime.open(
        width: 640,
        height: 480,
        recording: recording,
      );
      try {
        final initial = runtime.eval(r'''
          const rects = [];
          let mounted = false;
          globalThis.frame = function() {
            if (mounted) return;
            mounted = true;
            for (let i = 0; i < 100; i++) {
              const node = ui.createNode(0);
              ui.setProp(node, 1, 16);
              ui.setProp(node, 2, 16);
              ui.setProp(node, 24, 1);
              ui.setProp(node, 28, 4 + (i % 10) * 24);
              ui.setProp(node, 25, 4 + Math.floor(i / 10) * 24);
              ui.setProp(node, 64, 0xff204060 + i);
              ui.insertBefore(1, node, 0);
              rects.push(node);
            }
          };
          globalThis.__pocketEvent = function(message) {
            if (message.name === "bump") {
              ui.setProp(rects[50], 64, 0xffcc6633);
            }
          };
          __pocketEvent.__binaryCapable = true;
          JSON.parse = JSON.stringify = () => { throw Error('JSON reached frame transport'); };
        ''');
        expect(initial.sequence, isNotNull);
        expect(initial.ops, hasLength(100));
        final firstSequence = initial.sequence!;
        final firstBumpedRect = initial.ops
            .whereType<PocketRectOp>()
            .singleWhere((op) => op.x == 4 && op.y == 124);

        runtime.send(const <String, dynamic>{
          'type': 'event',
          'name': 'bump',
          'payload': <String, dynamic>{},
        });
        final changed = runtime.frameDeltaAt(0);
        expect(changed, isNotNull);
        expect(changed!.sequence, greaterThan(firstSequence));
        expect(changed.ops, hasLength(100));
        final changedBumpedRect = changed.ops
            .whereType<PocketRectOp>()
            .singleWhere((op) => op.x == 4 && op.y == 124);
        expect(changedBumpedRect.color, isNot(firstBumpedRect.color));
      } finally {
        runtime.dispose();
      }
      final frameDelta = recording.finish().entries.lastWhere(
        (entry) => entry.kind == 'frameDelta',
      );
      expect(frameDelta.result['mode'], 'binaryV2');
      expect(frameDelta.result['unchanged'], isFalse);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'event-only PFP1 frame reuses its unchanged primary operation list',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          const node = ui.createNode(0);
          ui.setProp(node, 1, 80);
          ui.setProp(node, 2, 40);
          ui.setProp(node, 64, 0xff336699);
          ui.insertBefore(1, node, 0);
          globalThis.frame = function() {};
          globalThis.__pocketEvent = function(packet) {
            pocket._emitValue({
              type: 'event',
              name: 'guest.notice',
              payload: { acknowledged: packet.name },
            });
          };
          __pocketEvent.__binaryCapable = true;
        ''');
        expect(initial.ops, hasLength(1));
        expect(initial.sequence, isNotNull);

        runtime.send(const <String, dynamic>{
          'type': 'event',
          'name': 'host.notice',
          'payload': <String, dynamic>{},
        });
        final eventFrame = runtime.frameDeltaAt(0)!;

        expect(eventFrame.events.single.method, 'guest.notice');
        expect(eventFrame.events.single.params['acknowledged'], 'host.notice');
        expect(eventFrame.sequence, greaterThan(initial.sequence!));
        expect(identical(eventFrame.ops, initial.ops), isTrue);
        expect(
          () => eventFrame.ops.add(
            const PocketRectOp(
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              color: 0xffffffff,
            ),
          ),
          throwsUnsupportedError,
        );
        // The event was consumed, so the next stable probe uses the existing
        // native zero-length marker and does not fabricate another frame.
        expect(runtime.frameDeltaAt(0), isNull);
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'PFP1 v5 insertion decodes a rounded gradient into the retained frame',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          const rects = [];
          for (let index = 0; index < 10; index++) {
            const node = ui.createNode(0);
            ui.setProp(node, 1, 24);
            ui.setProp(node, 2, 16);
            ui.setProp(node, 24, 1);
            ui.setProp(node, 25, index * 20);
            ui.setProp(node, 28, 0);
            ui.setProp(node, 64, 0xff334455 + index);
            ui.insertBefore(1, node, index);
            rects.push(node);
          }
          globalThis.frame = function() {};
          globalThis.__pocketEvent = function(packet) {
            if (packet.name !== 'add-rounded-gradient') return;
            const node = ui.createNode(0);
            ui.setProp(node, 1, 80);
            ui.setProp(node, 2, 60);
            ui.setProp(node, 24, 1);
            ui.setProp(node, 25, 100);
            ui.setProp(node, 28, 100);
            ui.setProp(node, 68, 12);
            ui.setProp(node, 65, 0x80604020);
            ui.setProp(node, 82, 0x96dce6f0);
            ui.setProp(node, 83, 0.35);
            ui.setProp(node, 66, 0xdc786450);
            ui.setProp(node, 67, 3);
            ui.insertBefore(1, node, 0);
          };
          __pocketEvent.__binaryCapable = true;
        ''');
        expect(initial.ops, hasLength(10));
        expect(initial.sequence, isNotNull);

        runtime.send(const <String, dynamic>{
          'type': 'event',
          'name': 'add-rounded-gradient',
          'payload': <String, dynamic>{},
        });
        final patched = runtime.frameDeltaAt(0)!;
        expect(patched.sequence, greaterThan(initial.sequence!));
        expect(patched.ops, hasLength(11));
        final gradient = patched.ops.last as PocketRoundedGradientOp;
        expect(gradient.radius, 12);
        expect(gradient.direction, 3);
        expect(gradient.viaColor, 0x96f0e6dc);
        expect(gradient.viaPosition, closeTo(0.35, 1e-6));
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'production FfiPocketRuntime decodes the compact binary frame ABI and binary bridge events',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final frame = runtime.eval('''
          let tick = 0;
          const handler = function(packet) {
            if (typeof packet === "string") {
              throw new Error("expected direct JS object for __binaryCapable handler");
            }
            const bytes = packet.payload.bytes;
            if (!(bytes instanceof Uint8Array)) {
              throw new Error("expected Uint8Array payload");
            }
            pocket._emitValue({
              type: "event",
              name: "guest.binary.echo",
              payload: {
                count: packet.payload.count + 1,
                bytes: new Uint8Array([bytes[0], bytes[1], 200]),
              },
            });
          };
          handler.__binaryCapable = true;
          globalThis.__pocketEvent = handler;
          globalThis.frame = function() {
            tick++;
            const node = ui.createNode(0);
            ui.setProp(node, 1, 40);
            ui.setProp(node, 2, 24);
            ui.setProp(node, 64, tick % 2 === 0 ? 0xff336699 : 0xff996633);
            ui.insertBefore(1, node, 0);
          };
        ''');
        expect(frame.ops, isNotEmpty);

        runtime.send(<String, dynamic>{
          'type': 'event',
          'name': 'host.binary.push',
          'payload': <String, dynamic>{
            'count': 41,
            'bytes': Uint8List.fromList(<int>[10, 20]),
          },
        });

        final changed = runtime.frameDeltaAt(17);
        expect(changed, isNotNull);
        expect(changed!.ops, isNotEmpty);
        expect(changed.ops.first, isA<PocketRectOp>());
        expect(changed.events, hasLength(1));
        expect(changed.events.single.method, 'guest.binary.echo');
        expect(changed.events.single.params['count'], 42);
        expect(
          changed.events.single.params['bytes'],
          Uint8List.fromList(<int>[10, 20, 200]),
        );
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'binary frame, surface pointer duplex, and v2 delta stay JSON-free',
    () {
      final runtime = FfiPocketRuntime.open(width: 640, height: 480);
      PocketDuplexChannel? duplex;
      try {
        final initial = runtime.eval(r'''
          const rects = [];
          let mounted = false;
          globalThis.__pocketEvent = function(packet) {
            if (typeof packet === "string") {
              throw new Error("input.pointer must not use a JSON string");
            }
            if (packet.name !== "input.pointer") {
              throw new Error("unexpected binary pointer event");
            }
            ui.setProp(rects[packet.payload.id], 64, 0xffcc6633);
          };
          globalThis.__pocketEvent.__binaryCapable = true;
          globalThis.frame = function() {
            if (mounted) return;
            mounted = true;
            for (let i = 0; i < 100; i++) {
              const node = ui.createNode(0);
              ui.setProp(node, 1, 16);
              ui.setProp(node, 2, 16);
              ui.setProp(node, 24, 1);
              ui.setProp(node, 28, 4 + (i % 10) * 24);
              ui.setProp(node, 25, 4 + Math.floor(i / 10) * 24);
              ui.setProp(node, 64, 0xff204060 + i);
              ui.insertBefore(1, node, 0);
              rects.push(node);
            }
          };
          // The binary-capable bridge must not need either JS JSON helper.
          JSON.parse = function() { throw new Error("JSON.parse disabled"); };
          JSON.stringify = function() { throw new Error("JSON.stringify disabled"); };
        ''');
        expect(initial.ops, hasLength(100));
        final initialRect = initial.ops.whereType<PocketRectOp>().singleWhere(
          (op) => op.x == 4 && op.y == 124,
        );

        // A zero-delta probe is the native null/zero-length unchanged packet.
        expect(runtime.frameDeltaAt(0), isNull);

        final channel = PocketDuplexChannel.fromRuntime(runtime);
        duplex = channel;
        expect(channel.isNativeZeroCopy, isTrue);
        expect(
          channel.pushToPocketJs(
            msgType: PocketDuplexChannel.pointerMessageType,
            flags: PocketDuplexChannel.pointerDownFlag,
            targetId: 50,
            arg0: 12.5,
            arg1: 18.25,
          ),
          isTrue,
        );
        expect(channel.step(), 1);

        final changed = runtime.frameDeltaAt(0);
        expect(changed, isNotNull);
        expect(changed!.ops, hasLength(100));
        final changedRect = changed.ops.whereType<PocketRectOp>().singleWhere(
          (op) => op.x == 4 && op.y == 124,
        );
        expect(changedRect.color, isNot(initialRect.color));
      } finally {
        duplex?.close();
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'binary bridge replays Uint8List send messages and decodes 64KiB+ admitted event payloads',
    () async {
      final controller = PocketRecordingController(retainReplayAssets: true);
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 480,
        recording: controller,
      );
      try {
        runtime.eval('''
          const handler = function(packet) {
            if (packet.name === "host.large") {
              if (typeof packet.payload.text !== "string" || packet.payload.text.length !== 70000) {
                throw new Error("expected 70000-char payload");
              }
              return;
            }
            if (!(packet.payload.bytes instanceof Uint8Array)) {
              throw new Error("expected Uint8Array during send/replay");
            }
            if (!(packet.payload.__pocketEscapedMap.innerBytes instanceof Uint8Array)) {
              throw new Error("expected nested Uint8Array inside __pocketEscapedMap");
            }
            pocket._emitValue({
              type: "event",
              name: "guest.large",
              payload: {
                items: Array(8000).fill(7),
                sum: packet.payload.bytes[0] + packet.payload.bytes[1] + packet.payload.__pocketEscapedMap.innerBytes[0],
              },
            });
          };
          handler.__binaryCapable = true;
          globalThis.__pocketEvent = handler;
          globalThis.frame = function() {};
        ''');
        runtime.send(<String, dynamic>{
          'type': 'event',
          'name': 'host.large',
          'payload': <String, dynamic>{'text': 'x' * 70000},
        });
        runtime.send(<String, dynamic>{
          'type': 'event',
          'name': 'host.bytes',
          'payload': <String, dynamic>{
            'bytes': Uint8List.fromList(<int>[12, 20]),
            '__pocketEscapedMap': <String, dynamic>{
              'innerBytes': Uint8List.fromList(<int>[10]),
            },
          },
        });
        final frame = runtime.frameAt(16);
        expect(frame.events, hasLength(1));
        expect(frame.events.single.method, 'guest.large');
        expect(frame.events.single.params['sum'], 42);
        expect((frame.events.single.params['items'] as List).length, 8000);
      } finally {
        runtime.dispose();
      }
      final recording = controller.recording!;
      expect(recording.replayable, isTrue);
      final replay = await replayPocketRecording(
        recording,
        assets: controller.replayAssets,
      );
      expect(replay.matched, isTrue, reason: '${replay.firstMismatch}');
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}

Uint8List _largeResourcePak() {
  final entries = <({String key, int width, int height, int psm, int fill})>[
    (key: 'ui:img.large_a', width: 2048, height: 1024, psm: 3, fill: 17),
    (key: 'ui:img.large_b', width: 2048, height: 1024, psm: 3, fill: 93),
    (key: 'ui:img.palette_a', width: 1, height: 1, psm: 5, fill: 41),
    (key: 'ui:img.palette_b', width: 1, height: 1, psm: 5, fill: 101),
  ];
  const directoryOffset = 32;
  final namesOffset = directoryOffset + entries.length * 24;
  final names = <Uint8List>[
    for (final entry in entries) Uint8List.fromList(utf8.encode(entry.key)),
  ];
  final blobsOffset =
      namesOffset + names.fold<int>(0, (size, name) => size + name.length);
  final blobLengths = entries.map((entry) {
    final payloadBytes = entry.width * entry.height * (entry.psm == 3 ? 4 : 1);
    return 8 + (entry.psm == 5 ? 1024 : 0) + payloadBytes;
  }).toList();
  final pakLength =
      blobsOffset + blobLengths.fold<int>(0, (size, length) => size + length);
  final pak = Uint8List(pakLength);
  final data = ByteData.sublistView(pak);
  data
    ..setUint32(0, 0x4b504344, Endian.little) // DCPK
    ..setUint16(4, 1, Endian.little)
    ..setUint32(8, entries.length, Endian.little)
    ..setUint32(12, directoryOffset, Endian.little)
    ..setUint32(16, namesOffset, Endian.little);

  var nameOffset = 0;
  var blobOffset = blobsOffset;
  for (var index = 0; index < entries.length; index++) {
    final entry = entries[index];
    final name = names[index];
    final blobLength = blobLengths[index];
    final directoryEntry = directoryOffset + index * 24;
    data
      ..setUint32(directoryEntry + 4, blobOffset, Endian.little)
      ..setUint32(directoryEntry + 8, blobLength, Endian.little)
      ..setUint32(directoryEntry + 12, nameOffset, Endian.little)
      ..setUint16(directoryEntry + 16, name.length, Endian.little);
    pak.setRange(
      namesOffset + nameOffset,
      namesOffset + nameOffset + name.length,
      name,
    );
    data
      ..setUint16(blobOffset, entry.width, Endian.little)
      ..setUint16(blobOffset + 2, entry.height, Endian.little)
      ..setUint8(blobOffset + 4, entry.psm)
      ..setUint8(blobOffset + 5, 0);
    if (entry.psm == 5) {
      for (var byte = 0; byte < 1024; byte++) {
        pak[blobOffset + 8 + byte] = (entry.fill + byte) & 0xff;
      }
      pak[blobOffset + 8 + 1024] = entry.fill + 4;
    } else {
      pak.fillRange(blobOffset + 8, blobOffset + blobLength, entry.fill);
    }
    nameOffset += name.length;
    blobOffset += blobLength;
  }
  return pak;
}

int _hashBytes(Uint8List bytes) {
  var hash = 0x811c9dc5;
  for (final byte in bytes) {
    hash = ((hash ^ byte) * 0x01000193) & 0xffffffff;
  }
  return hash;
}
