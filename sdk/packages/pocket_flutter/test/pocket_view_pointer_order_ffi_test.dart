import 'dart:io';

import 'package:flutter/material.dart';
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

  testWidgets(
    'production fallback pointer up reaches GuestFrame before outside dismiss',
    (tester) async {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      final controller = PocketViewController();
      final events = <PocketEvent>[];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: SizedBox(
              width: 320,
              height: 480,
              child: PocketView(
                controller: controller,
                runtime: runtime,
                jsSource: r'''
                  let previousTouchCount = 0;
                  let dismissSeen = false;
                  globalThis.frame = function(_buttons, _analog, touches) {
                    const currentTouchCount = touches && touches.length
                      ? touches.length
                      : 0;
                    if (previousTouchCount > 0 && currentTouchCount === 0) {
                      pocket._emitValue({
                        type: "event",
                        name: "outside.pointer.order",
                        payload: {
                          status: dismissSeen ? "up-after-dismiss" : "up-before-dismiss"
                        }
                      });
                    }
                    previousTouchCount = currentTouchCount;
                  };
                  globalThis.__pocketEvent = function(event) {
                    if (event.name === "textInput.dismiss") dismissSeen = true;
                  };
                  __pocketEvent.__binaryCapable = true;
                  JSON.parse = JSON.stringify = () => { throw Error('JSON reached pointer transport'); };
                  pocket._emitValue({
                    type: "event",
                    name: "textInput.open",
                    payload: {
                      id: "ffi-outside-editor",
                      editingSession: "ffi-outside-editor:1",
                      rect: { x: 20, y: 40, w: 180, h: 42 },
                      text: ""
                    }
                  });
                ''',
                showDebugFps: false,
                onEvent: events.add,
              ),
            ),
          ),
        );
        await tester.pump();
        final channel = controller.duplexChannel;
        expect(channel, isNotNull);

        // Fill the native SPSC ingress with an unhandled application record.
        // Native drain stops at that record, so both pointer edges exercise
        // the production B1 fallback while retaining the real frame path.
        final accepted = channel!.pushBatch(
          List<PocketDuplexMessage>.generate(
            PocketDuplexChannel.ringCapacity - 1,
            (index) => PocketDuplexMessage(msgType: 9, targetId: index),
            growable: false,
          ),
        );
        expect(accepted, PocketDuplexChannel.ringCapacity - 1);

        final outside = await tester.startGesture(const Offset(300, 450));
        await tester.pump(const Duration(milliseconds: 50));
        await outside.up();
        await tester.pump(const Duration(milliseconds: 550));
        await tester.pump();

        final order = events.where(
          (event) => event.method == 'outside.pointer.order',
        );
        expect(order, hasLength(1));
        expect(order.single.params['status'], 'up-before-dismiss');
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null,
  );
}
