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
}
