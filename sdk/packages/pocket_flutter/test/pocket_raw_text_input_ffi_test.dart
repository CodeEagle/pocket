import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

Map<String, dynamic> _delta(
  String oldText,
  String deltaText,
  int start,
  int end,
  int selection, {
  int composingBase = -1,
  int composingExtent = -1,
}) => <String, dynamic>{
  'oldText': oldText,
  'deltaText': deltaText,
  'deltaStart': start,
  'deltaEnd': end,
  'selectionBase': selection,
  'selectionExtent': selection,
  'selectionAffinity': 'TextAffinity.downstream',
  'selectionIsDirectional': false,
  'composingBase': composingBase,
  'composingExtent': composingExtent,
};

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
    'real guest requests a raw session and receives modified keys and IME',
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
                rawTextInputEnabled: true,
                jsSource: r'''
                  globalThis.__pocketEvent = function() {};
                  __pocketEvent.__binaryCapable = true;
                  globalThis.frame = function() {
                    const text = arguments[8] || [];
                    if (text.length === 0) return;
                    pocket._emitValue({
                      type: "event",
                      name: "raw.facts",
                      payload: {
                        events: text.map((e) => [e.kind, e.text, e.selectionStart, e.selectionEnd, e.repeat === true]),
                      },
                    });
                  };
                  pocket._emitValue({
                    type: "event",
                    name: "textInput.rawOpen",
                    payload: { id: "ffi-raw", rect: { x: 10, y: 20, w: 2, h: 16 } },
                  });
                ''',
                showDebugFps: false,
                onEvent: events.add,
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(tester.testTextInput.hasAnyClients, isTrue);

        await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.keyZ);
        await tester.pump(const Duration(milliseconds: 50));
        await tester.sendKeyUpEvent(LogicalKeyboardKey.keyZ);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await tester.pump(const Duration(milliseconds: 50));

        final setClient = tester.testTextInput.log.lastWhere(
          (call) => call.method == 'TextInput.setClient',
        );
        final clientId = (setClient.arguments as List<dynamic>)[0] as int;
        Future<void> deltas(List<Map<String, dynamic>> list) async {
          await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            'flutter/textinput',
            const JSONMethodCodec().encodeMethodCall(
              MethodCall(
                'TextInputClient.updateEditingStateWithDeltas',
                <dynamic>[
                  clientId,
                  <String, dynamic>{'deltas': list},
                ],
              ),
            ),
            (_) {},
          );
          await tester.pump(const Duration(milliseconds: 50));
        }

        await deltas(<Map<String, dynamic>>[
          _delta('', 'ni', 0, 0, 2, composingBase: 0, composingExtent: 2),
        ]);
        await deltas(<Map<String, dynamic>>[_delta('ni', '你', 0, 2, 1)]);

        final facts = <List<dynamic>>[
          for (final event in events.where((e) => e.method == 'raw.facts'))
            ...(event.params['events'] as List<dynamic>).cast<List<dynamic>>(),
        ];
        // kind: 0 keyDown, 1 keyUp, 2 commit, 3 composition, 4 compositionEnd.
        expect(facts, <List<dynamic>>[
          <dynamic>[0, 'Control', 0, 0, false],
          <dynamic>[0, 'Control+z', 0, 0, false],
          <dynamic>[1, 'Control+z', 0, 0, false],
          <dynamic>[1, 'Control', 0, 0, false],
          <dynamic>[3, 'ni', 2, 2, false],
          <dynamic>[4, '', 0, 0, false],
          <dynamic>[2, '你', 0, 0, false],
        ]);
        expect(
          events.where((e) => e.method == 'textInput.rawOpened'),
          isEmpty,
          reason: 'host replies to the guest, not through onEvent',
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        runtime.dispose();
      }
    },
    // Set POCKET_NATIVE_LIBRARY to a built Pocket native library.
    skip: libraryPath == null,
  );
}
