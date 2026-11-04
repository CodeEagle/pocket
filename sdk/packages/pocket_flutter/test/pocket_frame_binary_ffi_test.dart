import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
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
          'payload': <String, dynamic>{
            'text': 'x' * 70000,
          },
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
        expect(
          (frame.events.single.params['items'] as List).length,
          8000,
        );
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
