import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _TestMockRuntime implements PocketRuntime {
  _TestMockRuntime({this.initialEvent});

  final PocketEvent? initialEvent;
  final List<PocketEvent> queuedEvents = <PocketEvent>[];
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  bool _sentInitial = false;

  final PocketFrame _baseFrame = const PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );

  PocketFrame _nextFrame() {
    final events = <PocketEvent>[];
    if (!_sentInitial && initialEvent != null) {
      _sentInitial = true;
      events.add(initialEvent!);
    }
    events.addAll(queuedEvents);
    queuedEvents.clear();
    return PocketFrame(
      width: _baseFrame.width,
      height: _baseFrame.height,
      ops: _baseFrame.ops,
      events: events,
    );
  }

  void enqueue(PocketEvent event) => queuedEvents.add(event);

  @override
  PocketFrame eval(String source) => _nextFrame();

  @override
  PocketFrame load(String source, Uint8List pak) => _nextFrame();

  @override
  PocketFrame frame(int deltaMilliseconds) => _nextFrame();

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'rect-only textInput.update preserves TextAffinity.upstream and skips setEditingState',
    (tester) async {
      final runtime = _TestMockRuntime(
        initialEvent: const PocketEvent(
          id: 'event-open',
          method: 'textInput.open',
          params: <String, dynamic>{
            'id': 'field-test',
            'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
            'text': '你好',
            'selectionBase': 2,
            'selectionExtent': 2,
          },
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump();

      final fieldFinder = find.byKey(
        const ValueKey<String>('pocket-text-input-field-test'),
      );
      expect(fieldFinder, findsOneWidget);
      final field = tester.widget<TextField>(fieldFinder);
      final controller = field.controller!;

      // Simulate active IME composing state with TextAffinity.upstream
      controller.value = const TextEditingValue(
        text: 'nihao',
        selection: TextSelection(
          baseOffset: 5,
          extentOffset: 5,
          affinity: TextAffinity.upstream,
        ),
        composing: TextRange(start: 0, end: 5),
      );
      await tester.pump();

      expect(controller.value.selection.affinity, TextAffinity.upstream);
      expect(controller.value.composing, const TextRange(start: 0, end: 5));

      // Intercept TextInput calls on SystemChannels.textInput
      var setEditingStateCallCount = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.textInput,
        (MethodCall methodCall) async {
          if (methodCall.method == 'TextInput.setEditingState') {
            setEditingStateCallCount++;
          }
          return null;
        },
      );

      // Send rect-only update from JS (e.g. scroll / sendRectUpdate)
      runtime.enqueue(
        const PocketEvent(
          id: 'event-update-rect-only',
          method: 'textInput.update',
          params: <String, dynamic>{
            'id': 'field-test',
            'rect': <String, double>{'x': 20, 'y': 60, 'w': 180, 'h': 42},
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));

      // Verify affinity and composing are preserved, and 0 setEditingState calls were dispatched
      expect(controller.value.selection.affinity, TextAffinity.upstream);
      expect(controller.value.composing, const TextRange(start: 0, end: 5));
      expect(controller.value.text, 'nihao');
      expect(setEditingStateCallCount, 0);

      // Clean up mock handler
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.textInput,
        null,
      );
    },
  );

  testWidgets(
    'ticker pauses after 6 consecutive unchanged frames and wakes on interaction or message',
    (tester) async {
      final runtime = _TestMockRuntime();
      final controller = PocketViewController();

      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump();

      dynamic state = tester.state(find.byType(PocketView));
      expect(state.isTickerActive, isTrue);

      // Now override delta function to return null (unchanged frames)
      debugPocketFrameDeltaAtOverride = (rt, delta) => null;

      try {
        // Pump 5 unchanged frames
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 16));
          expect(state.idleTicks, i + 1);
          expect(state.isTickerActive, isTrue);
        }

        // 6th unchanged frame pauses ticker
        await tester.pump(const Duration(milliseconds: 16));
        expect(state.idleTicks, greaterThanOrEqualTo(6));
        expect(state.isTickerActive, isFalse);

        // Sending a message via controller wakes the ticker
        controller.send(method: 'test.wake');
        expect(state.idleTicks, 0);
        expect(state.isTickerActive, isTrue);

        // Allow it to pause again
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(state.isTickerActive, isFalse);

        // Dispatching pointer tap wakes the ticker
        await tester.tap(find.byType(PocketView));
        expect(state.idleTicks, 0);
        expect(state.isTickerActive, isTrue);
      } finally {
        debugPocketFrameDeltaAtOverride = null;
      }
    },
  );
}
