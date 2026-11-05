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
