import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  requireReal(libraryPath == null ? 'POCKET_NATIVE_LIBRARY is not set' : null);
  test(
    'production FFI runtime maps duplex pointer records to input.pointer',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      final source = r'''
        const node = ui.createNode(0);
        ui.setProp(node, 1, 40);
        ui.setProp(node, 2, 24);
        ui.setProp(node, 64, 0xff336699);
        ui.insertBefore(1, node, 0);
        globalThis.frame = function() {};
        globalThis.__pocketEvent = function(event) {
          if (event.name === "input.pointer" &&
              event.payload.phase === "up") {
            ui.setProp(node, 64, 0xffcc6633);
          }
        };
        __pocketEvent.__binaryCapable = true;
        JSON.parse = JSON.stringify = () => { throw Error('JSON reached pointer transport'); };
      ''';
      try {
        final initial = runtime.eval(source);
        final initialColor = initial.ops.whereType<PocketRectOp>().single.color;

        final channel = PocketDuplexChannel.fromRuntime(runtime);
        expect(
          channel.pushBatch(const [
            PocketDuplexMessage(
              msgType: 1,
              flags: 1,
              targetId: 0,
              arg0: 8,
              arg1: 12,
            ),
            PocketDuplexMessage(
              msgType: 1,
              flags: 3,
              targetId: 0,
              arg0: 8,
              arg1: 12,
            ),
          ]),
          2,
        );
        final changed = runtime.frameDeltaAt(16);
        expect(changed, isNotNull);
        final changedColor = changed!.ops
            .whereType<PocketRectOp>()
            .single
            .color;
        expect(changedColor, isNot(initialColor));
        channel.close();
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
