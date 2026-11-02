import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

class _TestMockRuntime implements PocketRuntime {
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

final class _ViewDuplexRuntime extends _TestMockRuntime
    implements PocketBinaryDuplexRuntime {
  _ViewDuplexRuntime(this.endpoint, {PocketEvent? initialEvent})
    : super(initialEvent: initialEvent);

  final _ViewDuplexEndpoint endpoint;
  bool alive = true;

  @override
  PocketDuplexEndpoint? get duplexEndpoint => endpoint;

  @override
  int duplexStep() => 0;

  @override
  bool get duplexRuntimeAlive => alive;

  @override
  void dispose() {
    alive = false;
  }
}

final class _ViewDuplexEndpoint implements PocketDuplexEndpoint {
  final List<PocketDuplexMessage> ingress = <PocketDuplexMessage>[];
  final List<PocketDuplexMessage> _egress = <PocketDuplexMessage>[];
  Uint8List? _reservedIngress;
  bool ingressFull = false;
  bool closed = false;

  void enqueue(PocketDuplexMessage event) => _egress.add(event);

  @override
  bool get isNativeZeroCopy => false;

  @override
  Uint8List? reserveIngress(int maxMessages) {
    if (closed || ingressFull || maxMessages < 1) return null;
    _reservedIngress = Uint8List(PocketDuplexChannel.messageByteSize);
    return _reservedIngress;
  }

  @override
  void publishIngress(int messageCount) {
    final bytes = _reservedIngress;
    _reservedIngress = null;
    if (bytes == null || messageCount != 1) return;
    final data = ByteData.sublistView(bytes);
    ingress.add(
      PocketDuplexMessage(
        msgType: data.getUint16(0, Endian.little),
        flags: data.getUint16(2, Endian.little),
        targetId: data.getUint32(4, Endian.little),
        arg0: data.getFloat32(8, Endian.little),
        arg1: data.getFloat32(12, Endian.little),
      ),
    );
  }

  @override
  Uint8List? peekEgress(int maxMessages) {
    if (closed || _egress.isEmpty || maxMessages < 1) return null;
    final count = maxMessages.clamp(1, _egress.length).toInt();
    final bytes = ByteData(count * PocketDuplexChannel.messageByteSize);
    for (var index = 0; index < count; index++) {
      final message = _egress[index];
      final offset = index * PocketDuplexChannel.messageByteSize;
      bytes.setUint16(offset, message.msgType, Endian.little);
      bytes.setUint16(offset + 2, message.flags, Endian.little);
      bytes.setUint32(offset + 4, message.targetId, Endian.little);
      bytes.setFloat32(offset + 8, message.arg0, Endian.little);
      bytes.setFloat32(offset + 12, message.arg1, Endian.little);
    }
    return bytes.buffer.asUint8List();
  }

  @override
  void consumeEgress(int messageCount) {
    _egress.removeRange(0, messageCount);
  }

  @override
  void close() {
    closed = true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('PocketView owns the duplex generation and drains egress', (
    tester,
  ) async {
    final endpoint = _ViewDuplexEndpoint();
    final runtime = _ViewDuplexRuntime(endpoint);
    final controller = PocketViewController();
    final received = <PocketDuplexEvent>[];

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
            onDuplexEvent: received.add,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(controller.duplexChannel, isNotNull);

    endpoint.enqueue(
      const PocketDuplexMessage(msgType: 9, targetId: 17, arg0: 1.5),
    );
    await tester.pump(const Duration(milliseconds: 16));
    expect(received, hasLength(1));
    expect(received.single.msgType, 9);
    expect(received.single.targetId, 17);

    await tester.pumpWidget(const SizedBox.shrink());
    expect(endpoint.closed, isTrue);
  });

  testWidgets('PocketView defaults pointer edges to the duplex channel', (
    tester,
  ) async {
    final endpoint = _ViewDuplexEndpoint();
    final runtime = _ViewDuplexRuntime(endpoint);
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

    await tester.tap(find.byType(PocketView));
    expect(endpoint.ingress.map((event) => event.msgType), [1, 1]);
    expect(endpoint.ingress.map((event) => event.flags), [1, 3]);
    expect(
      runtime.messages.where((message) => message['name'] == 'input.pointer'),
      isEmpty,
    );
  });

  testWidgets(
    'full duplex ring defers JSON fallback without reordering edges',
    (tester) async {
      final endpoint = _ViewDuplexEndpoint()..ingressFull = true;
      final runtime = _ViewDuplexRuntime(endpoint);
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

      await tester.tap(find.byType(PocketView));
      expect(
        runtime.messages.where((message) => message['name'] == 'input.pointer'),
        isEmpty,
      );
      endpoint.ingressFull = false;
      await tester.pump(const Duration(milliseconds: 16));
      final pointerMessages = runtime.messages
          .where((message) => message['name'] == 'input.pointer')
          .toList(growable: false);
      expect(
        pointerMessages.map(
          (message) => (message['payload'] as Map<String, dynamic>)['phase'],
        ),
        ['down', 'up'],
      );
    },
  );

  testWidgets(
    'outside editor tap flushes fallback up before dismissing the editor',
    (tester) async {
      // Keep the production default duplex path enabled, but force its ring
      // full so this exercises the delayed JSON fallback that can race a
      // post-frame TextField outside dismissal.
      final endpoint = _ViewDuplexEndpoint()..ingressFull = true;
      final runtime = _ViewDuplexRuntime(
        endpoint,
        initialEvent: const PocketEvent(
          id: 'event-open-outside-duplex',
          method: 'textInput.open',
          params: <String, dynamic>{
            'id': 'field-outside-duplex',
            'editingSession': 'session-outside-duplex',
            'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
            'text': '',
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
      final field = find.byKey(
        const ValueKey<String>('pocket-text-input-field-outside-duplex'),
      );
      expect(field, findsOneWidget);

      final messageStart = runtime.messages.length;
      final gesture = await tester.startGesture(const Offset(300, 450));
      await tester.pump(const Duration(milliseconds: 50));
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 550));
      await tester.pump();

      final outsideMessages = runtime.messages.sublist(messageStart);
      final pointerPhases = outsideMessages
          .where((message) => message['name'] == 'input.pointer')
          .map(
            (message) => (message['payload'] as Map<String, dynamic>)['phase'],
          )
          .toList(growable: false);
      expect(pointerPhases, <Object?>['down', 'up']);
      final pointerUpIndex = outsideMessages.lastIndexWhere(
        (message) =>
            message['name'] == 'input.pointer' &&
            (message['payload'] as Map<String, dynamic>)['phase'] == 'up',
      );
      final dismissIndex = outsideMessages.lastIndexWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      expect(pointerUpIndex, greaterThanOrEqualTo(0));
      expect(dismissIndex, greaterThan(pointerUpIndex));
      expect(field, findsNothing);
    },
  );

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
    'text input revision rejects stale values and scopes same-id sessions',
    (tester) async {
      final runtime = _TestMockRuntime(
        initialEvent: const PocketEvent(
          id: 'event-open-revision',
          method: 'textInput.open',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
            'revision': 0,
            'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
            'text': 'abc',
            'selectionBase': 3,
            'selectionExtent': 3,
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
        const ValueKey<String>('pocket-text-input-field-revision'),
      );
      expect(fieldFinder, findsOneWidget);
      final textController = tester.widget<TextField>(fieldFinder).controller!;
      textController.value = const TextEditingValue(
        text: 'abcd',
        selection: TextSelection.collapsed(offset: 4),
      );
      final edit = runtime.messages.lastWhere(
        (message) => message['name'] == 'textInput.edit',
      );
      final editPayload = edit['payload'] as Map<String, dynamic>;
      expect(editPayload['revision'], 1);
      expect(editPayload['jsRevision'], 0);
      expect(editPayload['editingSession'], 'session-a');
      expect(editPayload['source'], 'native');

      runtime.enqueue(
        const PocketEvent(
          id: 'event-stale-value',
          method: 'textInput.update',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
            'revision': 0,
            'text': 'stale',
            'selectionBase': 5,
            'selectionExtent': 5,
            'rect': <String, double>{'x': 20, 'y': 60, 'w': 180, 'h': 42},
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(textController.text, 'abcd');

      // A guest-owned prop update is an explicit override even when its
      // observed revision is behind the most recent native edit.
      runtime.enqueue(
        const PocketEvent(
          id: 'event-programmatic-value',
          method: 'textInput.update',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
            'revision': 0,
            'observedRevision': 0,
            'source': 'programmatic',
            'text': 'from-js',
            'selectionBase': 7,
            'selectionExtent': 7,
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(textController.text, 'from-js');

      // The current JS component uses source=js + force for a value command.
      // It must be allowed to repair an older native revision, while still
      // advancing the independent JS revision stream.
      runtime.enqueue(
        const PocketEvent(
          id: 'event-js-force-value',
          method: 'textInput.update',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
            'revision': 0,
            'jsRevision': 2,
            'source': 'js',
            'force': true,
            'text': 'force-accepted',
            'selectionBase': 14,
            'selectionExtent': 14,
            'rect': <String, double>{'x': 20, 'y': 80, 'w': 180, 'h': 42},
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(textController.text, 'force-accepted');
      final forceTop = tester.getTopLeft(fieldFinder).dy;

      // A delayed JS value from an older JS revision must not overwrite the
      // accepted value. Its rect-only portion is still applied so layout can
      // converge even when value messages arrive out of order.
      runtime.enqueue(
        const PocketEvent(
          id: 'event-stale-js-value',
          method: 'textInput.update',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
            'revision': 0,
            'jsRevision': 1,
            'source': 'js',
            'force': true,
            'text': 'stale-js',
            'selectionBase': 8,
            'selectionExtent': 8,
            'rect': <String, double>{'x': 20, 'y': 120, 'w': 180, 'h': 42},
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(textController.text, 'force-accepted');
      expect(tester.getTopLeft(fieldFinder).dy, greaterThan(forceTop));

      // A subsequent native edit acknowledges the accepted JS revision so
      // the guest can discard any older native echo on its side.
      textController.value = const TextEditingValue(
        text: 'native-after-js',
        selection: TextSelection.collapsed(offset: 15),
      );
      final nativeAfterJs = runtime.messages.lastWhere(
        (message) => message['name'] == 'textInput.edit',
      );
      expect(
        (nativeAfterJs['payload'] as Map<String, dynamic>)['jsRevision'],
        2,
      );

      // A delayed close from the previous epoch must not remove the active
      // native editor merely because it reused the same guest id.
      runtime.enqueue(
        const PocketEvent(
          id: 'event-stale-close',
          method: 'textInput.close',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-old',
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(fieldFinder, findsOneWidget);

      runtime.enqueue(
        const PocketEvent(
          id: 'event-close',
          method: 'textInput.close',
          params: <String, dynamic>{
            'id': 'field-revision',
            'editingSession': 'session-a',
          },
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(fieldFinder, findsNothing);
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

        // A quiet guest still needs a bounded wake for a future QuickJS
        // timeout. The ticker may be stopped again after the wake, but it
        // must not remain permanently dormant.
        await tester.pump(const Duration(milliseconds: 100));
        // The timer probe stays asleep when no frame changed. External
        // controller messages below still restart the normal active ticker.
        expect(state.isTickerActive, isFalse);
        expect(state.idleTicks, greaterThanOrEqualTo(6));

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

  testWidgets(
    'repeated idle probes exclude all sleep from the performance window',
    (tester) async {
      final runtime = _TestMockRuntime();
      final samples = <PocketPerformanceSample>[];
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
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();

      var calls = 0;
      var sleeping = true;
      debugPocketFrameDeltaAtOverride = (rt, _) {
        calls++;
        // Remain unchanged across multiple timer probes, then resume drawing.
        if (calls >= 9 && sleeping) return null;
        return rt.frame(0);
      };
      try {
        for (var index = 0; index < 8; index++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        for (var index = 0; index < 6; index++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        final state = tester.state(find.byType(PocketView)) as dynamic;
        expect(state.isTickerActive, isFalse);

        // Earlier sleep intervals must survive multiple unsuccessful probes.
        // Resetting the idle baseline on every probe depresses the first FPS
        // sample even though no display work was requested during this time.
        for (var probe = 0; probe < 4; probe++) {
          await tester.pump(const Duration(milliseconds: 250));
          await tester.pump();
          expect(state.isTickerActive, isFalse);
        }
        sleeping = false;
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump();
        expect(state.isTickerActive, isTrue);
        for (var index = 0; index < 90; index++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(samples, isNotEmpty);
        expect(samples.first.fps, greaterThan(45));
        expect(samples.first.maxGapMs, lessThan(50));
        expect(samples.last.slowFrames, 0);
      } finally {
        debugPocketFrameDeltaAtOverride = null;
      }
    },
  );
}
