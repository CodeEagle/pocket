import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _IdlePointerRuntime
    implements PocketRuntime, PocketRuntimeScheduling {
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  final List<int> frameDeltas = <int>[];
  int frameCalls = 0;
  double nextWakeDelayMilliseconds = -1;
  PocketFrame? lastFrame;

  static const _baseColor = 0xff101827;
  static const _pressedColor = 0xff3b82f6;
  static const _releasedColor = 0xff22c55e;

  PocketFrame _frameForMessages() {
    var color = _baseColor;
    for (final message in messages) {
      if (message['name'] != 'input.pointer') continue;
      final payload = message['payload'];
      if (payload is! Map) continue;
      switch (payload['phase']) {
        case 'down':
          color = _pressedColor;
        case 'up':
          color = _releasedColor;
      }
    }
    return PocketFrame(
      width: 320,
      height: 480,
      ops: <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: color),
      ],
      events: const <PocketEvent>[],
    );
  }

  @override
  PocketFrame eval(String source) => _frameForMessages();

  @override
  PocketFrame load(String source, Uint8List pak) => _frameForMessages();

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls++;
    frameDeltas.add(deltaMilliseconds);
    lastFrame = _frameForMessages();
    return lastFrame!;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    messages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _AuxiliaryPointerRuntime extends _IdlePointerRuntime {
  bool auxiliaryEnabled = true;

  @override
  PocketFrame _frameForMessages() {
    final primary = super._frameForMessages();
    return PocketFrame(
      width: primary.width,
      height: primary.height,
      ops: primary.ops,
      events: primary.events,
      auxiliary: auxiliaryEnabled
          ? const PocketSurfaceFrame(
              width: 320,
              height: 240,
              ops: <PocketOp>[
                PocketRectOp(
                  x: 0,
                  y: 0,
                  width: 320,
                  height: 240,
                  color: _IdlePointerRuntime._baseColor,
                ),
              ],
            )
          : null,
    );
  }
}

Future<void> _mountPointerView(
  WidgetTester tester,
  PocketRuntime runtime, {
  PocketViewController? controller,
  bool inputEnabled = true,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SizedBox(
        width: 320,
        height: 480,
        child: PocketView(
          controller: controller,
          runtime: runtime,
          inputEnabled: inputEnabled,
          enableDuplexPointerInput: false,
          jsSource: '',
          pakBytes: Uint8List(0),
          showDebugFps: false,
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 16));
}

RenderPointerListener _surfaceListener(WidgetTester tester, {int surface = 0}) {
  return tester.renderObject<RenderPointerListener>(
    find.byKey(ValueKey<String>('pocket-surface-$surface')),
  );
}

void main() {
  testWidgets(
    'rejected, stale, and invalid pointer events do not wake an idle ticker',
    (tester) async {
      final runtime = _IdlePointerRuntime();
      await _mountPointerView(tester, runtime);
      runtime.messages.clear();
      final state = tester.state(find.byType(PocketView)) as dynamic;
      expect(state.isTickerActive, isFalse);

      final listener = _surfaceListener(tester);
      // MOVE/UP without a native DOWN have no slot and must be ignored before
      // the ticker wake. Calling the render listener directly keeps this test
      // focused on the PocketView routing contract rather than hit testing.
      listener.onPointerMove?.call(
        const PointerMoveEvent(
          pointer: 41,
          position: Offset(30, 30),
          delta: Offset(1, 0),
        ),
      );
      listener.onPointerUp?.call(
        const PointerUpEvent(pointer: 41, position: Offset(31, 30)),
      );
      expect(state.isTickerActive, isFalse);
      expect(runtime.messages, isEmpty);

      // A non-finite local coordinate is rejected before any transport write.
      listener.onPointerDown?.call(
        PointerDownEvent(position: Offset(double.nan, 30)),
      );
      expect(state.isTickerActive, isFalse);
      expect(runtime.messages, isEmpty);

      // The same early-return guarantee applies when the surface is not an
      // input-enabled surface. This is the host-owned/rejected surface path.
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              inputEnabled: false,
              enableDuplexPointerInput: false,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      runtime.messages.clear();
      final disabledState = tester.state(find.byType(PocketView)) as dynamic;
      expect(disabledState.isTickerActive, isFalse);
      final disabledListener = _surfaceListener(tester);
      disabledListener.onPointerDown?.call(
        const PointerDownEvent(pointer: 42, position: Offset(30, 30)),
      );
      expect(disabledState.isTickerActive, isFalse);
      expect(runtime.messages, isEmpty);
    },
  );

  testWidgets('accepted down/move/up wakes once and preserves frame update', (
    tester,
  ) async {
    final runtime = _IdlePointerRuntime();
    await _mountPointerView(tester, runtime);
    final state = tester.state(find.byType(PocketView)) as dynamic;
    final listener = _surfaceListener(tester);

    listener.onPointerDown?.call(
      const PointerDownEvent(pointer: 7, position: Offset(40, 20)),
    );
    listener.onPointerMove?.call(
      const PointerMoveEvent(
        pointer: 7,
        position: Offset(48, 26),
        delta: Offset(8, 6),
      ),
    );
    listener.onPointerUp?.call(
      const PointerUpEvent(pointer: 7, position: Offset(48, 26)),
    );

    expect(state.isTickerActive, isTrue);
    expect(
      runtime.messages
          .where((message) => message['name'] == 'input.pointer')
          .map((message) => (message['payload'] as Map)['phase']),
      orderedEquals(<String>['down', 'move', 'up']),
    );

    await tester.pump(const Duration(milliseconds: 16));
    expect(state.isTickerActive, isFalse);
    expect(runtime.lastFrame, isNotNull);
    expect(
      runtime.lastFrame!.ops.whereType<PocketRectOp>().single.color,
      _IdlePointerRuntime._releasedColor,
    );
  });

  testWidgets(
    'rejected auxiliary surface pointer does not wake an idle ticker',
    (tester) async {
      final runtime = _AuxiliaryPointerRuntime();
      final controller = PocketViewController();
      await _mountPointerView(tester, runtime, controller: controller);
      runtime.messages.clear();
      final auxiliaryListener = _surfaceListener(tester, surface: 1);
      final state = tester.state(find.byType(PocketView)) as dynamic;

      runtime.auxiliaryEnabled = false;
      controller.notifyWork();
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        find.byKey(const ValueKey<String>('pocket-surface-1')),
        findsNothing,
      );
      expect(state.isTickerActive, isFalse);

      // The retained render listener still has the surface-1 callback, but the
      // current frame no longer owns that surface. It must be rejected without
      // reviving the idle ticker.
      auxiliaryListener.onPointerDown?.call(
        const PointerDownEvent(pointer: 9, position: Offset(10, 10)),
      );
      expect(state.isTickerActive, isFalse);
      expect(runtime.messages, isEmpty);
    },
  );

  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  test(
    'production FFI pointer down/move/up order reaches the final draw state',
    () {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      try {
        final initial = runtime.eval(r'''
          const node = ui.createNode(0);
          ui.setProp(node, 1, 40);
          ui.setProp(node, 2, 24);
          ui.setProp(node, 64, 0xff101827);
          ui.insertBefore(1, node, 0);
          globalThis.frame = function() {};
          globalThis.__pocketEvent = function(event) {
            if (event.name !== "input.pointer") return;
            if (event.payload.phase === "down") {
              ui.setProp(node, 64, 0xff3b82f6);
            } else if (event.payload.phase === "move") {
              ui.setProp(node, 64, 0xfff59e0b);
            } else if (event.payload.phase === "up") {
              ui.setProp(node, 64, 0xff22c55e);
            }
          };
          __pocketEvent.__binaryCapable = true;
          JSON.parse = JSON.stringify = () => { throw Error('JSON reached pointer transport'); };
        ''');
        final initialColor = initial.ops.whereType<PocketRectOp>().single.color;
        final baseline = runtime.frame(0);
        final baselineColor = baseline.ops
            .whereType<PocketRectOp>()
            .single
            .color;
        expect(initialColor, isNotNull);

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
              flags: 2,
              targetId: 0,
              arg0: 16,
              arg1: 20,
            ),
            PocketDuplexMessage(
              msgType: 1,
              flags: 3,
              targetId: 0,
              arg0: 16,
              arg1: 20,
            ),
          ]),
          3,
        );
        final changed = runtime.frameDeltaAt(16);
        expect(changed, isNotNull);
        expect(
          changed!.ops.whereType<PocketRectOp>().single.color,
          isNot(baselineColor),
        );
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
