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
    'B1 pointer and text input stay typed after malformed text rejection',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          const node = ui.createNode(0);
          ui.setProp(node, 1, 80);
          ui.setProp(node, 2, 40);
          ui.setProp(node, 64, 0xff336699);
          ui.insertBefore(1, node, 0);

          globalThis.__pocketEvent = function(packet) {
            if (typeof packet === "string") {
              throw new Error("B1 input must reach the handler as an object");
            }
            if (packet.name === "input.pointer" &&
                packet.payload.phase !== "down") {
              throw new Error("unexpected pointer phase");
            }
            if (packet.name === "input.text" &&
                packet.payload.kind !== "commit") {
              throw new Error("unexpected text event");
            }
          };
          __pocketEvent.__binaryCapable = true;

          let pressed = false;
          globalThis.frame = function(_buttons, _analog, touches) {
            if (!pressed && touches && touches.length > 0) {
              pressed = true;
              ui.setProp(node, 64, 0xffcc6633);
            }
            const textEvents = arguments[8] || [];
            if (textEvents.length > 0) {
              const first = textEvents[0];
              pocket._emitValue({
                type: "event",
                name: "text.facts",
                payload: {
                  kind: first.kind,
                  text: first.text || "",
                  key: first.key || "",
                  selectionStart: first.selectionStart,
                  selectionEnd: first.selectionEnd,
                },
              });
            }
          };

          JSON.parse = function() { throw new Error("JSON.parse reached B1 input"); };
          JSON.stringify = function() { throw new Error("JSON.stringify reached B1 input"); };
        ''');
        final initialColor = initial.ops.whereType<PocketRectOp>().single.color;

        runtime.send(<String, dynamic>{
          'type': 'event',
          'name': 'input.pointer',
          'payload': <String, dynamic>{
            'phase': 'down',
            'id': 0,
            'x': 8.0,
            'y': 12.0,
          },
        });
        final pointerFrame = runtime.frameDeltaAt(0);
        expect(pointerFrame, isNotNull);
        final pointerColor = pointerFrame!.ops
            .whereType<PocketRectOp>()
            .single
            .color;
        expect(pointerColor, isNot(initialColor));

        expect(
          () => runtime.send(<String, dynamic>{
            'type': 'event',
            'name': 'input.text',
            'payload': <String, dynamic>{
              'kind': 'composition',
              'text': '😀',
              'selectionStart': 0,
              // 😀 occupies two UTF-16 code units; 3 must be rejected.
              'selectionEnd': 3,
            },
          }),
          throwsA(isA<PocketRuntimeException>()),
        );

        runtime.send(<String, dynamic>{
          'type': 'event',
          'name': 'input.text',
          'payload': <String, dynamic>{'kind': 'commit', 'text': '中😀'},
        });
        final textFrame = runtime.frameDeltaAt(0);
        expect(textFrame, isNotNull);
        final facts = textFrame!.events
            .where((event) => event.method == 'text.facts')
            .toList(growable: false);
        expect(facts, hasLength(1));
        // Pocket's GuestFrame uses the stable ABI tag for commit events.
        expect(facts.single.params['kind'], 2);
        expect(facts.single.params['text'], '中😀');
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
