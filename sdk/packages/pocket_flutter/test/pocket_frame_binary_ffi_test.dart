import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  test(
    'production FfiPocketRuntime decodes the compact binary frame ABI',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final frame = runtime.eval('''
          let tick = 0;
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

        final changed = runtime.frameDeltaAt(17);
        expect(changed, isNotNull);
        expect(changed!.ops, isNotEmpty);
        expect(changed.ops.first, isA<PocketRectOp>());
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
