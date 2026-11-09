import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

class _TestMockRuntime implements PocketRuntime {
  _TestMockRuntime({this.initialEvent});

  final PocketEvent? initialEvent;
  final List<PocketEvent> queuedEvents = <PocketEvent>[];
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  bool _sentInitial = false;
  int frameCalls = 0;
  final List<int> frameDeltas = <int>[];

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
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls++;
    frameDeltas.add(deltaMilliseconds);
    return _nextFrame();
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

final class _ScheduledTestRuntime extends _TestMockRuntime
    implements PocketRuntimeScheduling {
  _ScheduledTestRuntime({
    required this.nextWakeDelayMilliseconds,
    this.afterFrameDelayMilliseconds,
  });

  double nextWakeDelayMilliseconds;
  double? afterFrameDelayMilliseconds;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    final frame = super.frame(deltaMilliseconds);
    final next = afterFrameDelayMilliseconds;
    if (next != null) nextWakeDelayMilliseconds = next;
    return frame;
  }
}

final class _ViewDuplexRuntime extends _TestMockRuntime
    implements PocketBinaryDuplexRuntime, PocketRuntimeScheduling {
  _ViewDuplexRuntime(this.endpoint, {PocketEvent? initialEvent})
    : super(initialEvent: initialEvent);

  final _ViewDuplexEndpoint endpoint;
  final List<PocketDuplexMessage> consumedIngress = <PocketDuplexMessage>[];
  bool alive = true;
  double nextWakeDelayMilliseconds = 0;
  bool consumeIngressOnFrame = false;
  PocketDuplexMessage? egressOnNextFrame;
  PocketFrame? lastFrame;

  @override
  PocketDuplexEndpoint? get duplexEndpoint => endpoint;

  @override
  int duplexStep() => 0;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    final frame = super.frame(deltaMilliseconds);
    final egress = egressOnNextFrame;
    if (egress != null) {
      endpoint.enqueue(egress);
      egressOnNextFrame = null;
      nextWakeDelayMilliseconds = -1;
    }
    final consumedNow = consumeIngressOnFrame
        ? List<PocketDuplexMessage>.of(endpoint.ingress)
        : const <PocketDuplexMessage>[];
    consumedIngress.addAll(consumedNow);
    if (consumeIngressOnFrame) endpoint.ingress.clear();
    if (consumedNow.isEmpty) {
      lastFrame = frame;
      return frame;
    }
    final responseFrame = PocketFrame(
      width: 320,
      height: 480,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff45a070),
      ],
      events: const <PocketEvent>[],
    );
    lastFrame = responseFrame;
    return responseFrame;
  }

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

  Future<void> mountView(
    WidgetTester tester,
    PocketRuntime runtime, {
    PocketViewController? controller,
    Key? viewKey,
    bool active = true,
    ValueChanged<PocketViewController>? onReady,
    PocketPerformanceSampleCallback? onPerformanceSample,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            key: viewKey,
            controller: controller,
            active: active,
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: false,
            onReady: onReady,
            onPerformanceSample: onPerformanceSample,
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('publishes official accessibility preference facts and changes', (
    tester,
  ) async {
    final runtime = _TestMockRuntime();
    final controller = PocketViewController();

    Widget host(MediaQueryData data) => MaterialApp(
      home: MediaQuery(
        data: data,
        child: SizedBox(
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

    await tester.pumpWidget(
      host(
        const MediaQueryData(
          disableAnimations: true,
          highContrast: true,
          textScaler: TextScaler.linear(1.25),
          accessibleNavigation: true,
        ),
      ),
    );
    await tester.pump();
    final initial = runtime.messages
        .where((message) => message['name'] == 'accessibility.preferences')
        .toList();
    expect(initial, hasLength(1));
    expect(initial.single['payload'], <String, dynamic>{
      'reduceMotion': true,
      'increaseContrast': true,
      'textScale': 1.25,
      'accessibleNavigation': true,
      'reduceTransparency': null,
    });

    await tester.pumpWidget(
      host(
        const MediaQueryData(
          disableAnimations: false,
          highContrast: false,
          textScaler: TextScaler.linear(1.5),
          accessibleNavigation: false,
        ),
      ),
    );
    await tester.pump();
    final updates = runtime.messages
        .where((message) => message['name'] == 'accessibility.preferences')
        .toList();
    expect(updates, hasLength(2));
    expect(updates.last['payload'], <String, dynamic>{
      'reduceMotion': false,
      'increaseContrast': false,
      'textScale': 1.5,
      'accessibleNavigation': false,
      'reduceTransparency': null,
    });

    await tester.pumpWidget(const SizedBox.shrink());
  });

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

  testWidgets('public duplex ingress and notifyWork wake an idle guest', (
    tester,
  ) async {
    final endpoint = _ViewDuplexEndpoint();
    final runtime = _ViewDuplexRuntime(endpoint);
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

    runtime.nextWakeDelayMilliseconds = -1;
    await tester.pump(const Duration(milliseconds: 16));
    final state = tester.state(find.byType(PocketView)) as dynamic;
    expect(state.isTickerActive, isFalse);
    final channel = controller.duplexChannel!;

    var callsBeforePublish = runtime.frameCalls;
    expect(channel.pushToPocketJs(msgType: 9, targetId: 1), isTrue);
    expect(state.isTickerActive, isTrue);
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, callsBeforePublish + 1);
    expect(state.isTickerActive, isFalse);

    callsBeforePublish = runtime.frameCalls;
    expect(
      channel.pushBatch(const [PocketDuplexMessage(msgType: 10, targetId: 2)]),
      1,
    );
    expect(state.isTickerActive, isTrue);
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, callsBeforePublish + 1);
    expect(state.isTickerActive, isFalse);

    callsBeforePublish = runtime.frameCalls;
    controller.notifyWork();
    expect(state.isTickerActive, isTrue);
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, callsBeforePublish + 1);
    expect(state.isTickerActive, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
    expect(endpoint.closed, isTrue);
  });

  testWidgets('duplex response published during output delivery gets a turn', (
    tester,
  ) async {
    final endpoint = _ViewDuplexEndpoint();
    final runtime = _ViewDuplexRuntime(endpoint);
    runtime.consumeIngressOnFrame = true;
    runtime.nextWakeDelayMilliseconds = 100;
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
    await tester.pump(const Duration(milliseconds: 16));

    final state = tester.state(find.byType(PocketView)) as dynamic;
    expect(state.isTickerActive, isFalse);
    expect(state.hasScheduledWake, isTrue);
    runtime.egressOnNextFrame = const PocketDuplexMessage(
      msgType: 9,
      targetId: 7,
    );

    controller.addDuplexListener((_) {
      expect(
        controller.duplexChannel!.pushToPocketJs(msgType: 10, targetId: 42),
        isTrue,
      );
    });
    var wakePumps = 0;
    while (endpoint.ingress.isEmpty && wakePumps < 10) {
      await tester.pump(const Duration(milliseconds: 16));
      wakePumps++;
    }

    // No host input is sent after the timer wake: the inline duplex response
    // itself must preserve the next frame.
    expect(wakePumps, greaterThan(0));
    expect(endpoint.ingress, hasLength(1));
    expect(state.isTickerActive, isTrue);
    await tester.pump(const Duration(milliseconds: 16));

    // The fake native frame has already captured `-1` before Flutter drains
    // the egress event. Its inline response must keep the ticker alive for a
    // fresh frame that can consume the newly published ingress record.
    expect(runtime.consumedIngress, hasLength(1));
    expect(runtime.consumedIngress.single.msgType, 10);
    expect(runtime.consumedIngress.single.targetId, 42);
    expect(runtime.lastFrame!.ops.single, isA<PocketRectOp>());
    expect((runtime.lastFrame!.ops.single as PocketRectOp).color, 0xff45a070);
    expect(state.isTickerActive, isFalse);

    await tester.pumpWidget(const SizedBox.shrink());
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

  testWidgets('known static idle parks with no recurring runtime calls', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: -1,
    );
    await mountView(tester, runtime);

    final state = tester.state(find.byType(PocketView)) as dynamic;
    // The initial display.viewport host message may request one frame.
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.isTickerActive, isFalse);
    expect(state.hasScheduledWake, isFalse);
    final callsAfterParking = runtime.frameCalls;
    await tester.pump(const Duration(minutes: 5));
    expect(runtime.frameCalls, callsAfterParking);
    expect(state.isTickerActive, isFalse);
  });

  testWidgets('discrete event wakes do not sample intentional idle gaps', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(nextWakeDelayMilliseconds: -1);
    final controller = PocketViewController();
    final samples = <PocketPerformanceSample>[];
    await mountView(
      tester,
      runtime,
      controller: controller,
      onPerformanceSample: samples.add,
    );

    final state = tester.state(find.byType(PocketView)) as dynamic;
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.isTickerActive, isFalse);
    // Each discrete message gets one guest frame, then intentional idle time.
    // That cadence is not a sustained FPS window and must not report the gaps.
    for (var index = 0; index < 80; index++) {
      controller.send(method: 'discrete.update');
      await tester.pump(const Duration(milliseconds: 16));
      expect(state.isTickerActive, isFalse);
    }
    expect(samples, isEmpty);
  });

  testWidgets('known timer deadline wakes once and then parks again', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: -1,
    );
    final controller = PocketViewController();
    await mountView(tester, runtime, controller: controller);

    // Startup's zero-time display.viewport frame is intentionally idle. Arm
    // the fake timer through a later guest frame so the tested deadline has
    // an explicit, stable time origin independent of startup work.
    await tester.pump(const Duration(milliseconds: 16));
    final state = tester.state(find.byType(PocketView)) as dynamic;
    expect(state.isTickerActive, isFalse);
    expect(state.hasScheduledWake, isFalse);

    runtime.afterFrameDelayMilliseconds = 100;
    controller.send(method: 'arm.timer');
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.isTickerActive, isFalse);
    expect(state.hasScheduledWake, isTrue);
    final callsBeforeDeadline = runtime.frameCalls;
    runtime.afterFrameDelayMilliseconds = -1;
    await tester.pump(const Duration(milliseconds: 99));
    expect(runtime.frameCalls, callsBeforeDeadline);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();
    expect(runtime.frameCalls, callsBeforeDeadline + 1);
    expect(state.isTickerActive, isFalse);
    expect(state.hasScheduledWake, isFalse);

    await tester.pump(const Duration(seconds: 2));
    expect(runtime.frameCalls, callsBeforeDeadline + 1);
  });

  testWidgets('continuous and legacy runtimes stay on vsync', (tester) async {
    final continuous = _ScheduledTestRuntime(nextWakeDelayMilliseconds: 0);
    await mountView(tester, continuous);
    final continuousState = tester.state(find.byType(PocketView)) as dynamic;
    expect(continuousState.isTickerActive, isTrue);
    for (var index = 0; index < 3; index++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(continuous.frameCalls, greaterThanOrEqualTo(3));

    final legacy = _TestMockRuntime();
    await mountView(tester, legacy, viewKey: const ValueKey('legacy'));
    final legacyState = tester.state(find.byType(PocketView)) as dynamic;
    expect(legacyState.isTickerActive, isTrue);
    for (var index = 0; index < 3; index++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(legacy.frameCalls, greaterThanOrEqualTo(3));
  });

  testWidgets('host response and pointer input wake a known-idle guest', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: -1,
    );
    final controller = PocketViewController();
    await mountView(tester, runtime, controller: controller);

    final state = tester.state(find.byType(PocketView)) as dynamic;
    await tester.pump(const Duration(milliseconds: 16));
    expect(state.isTickerActive, isFalse);
    final framesBeforeResponse = runtime.frameCalls;
    controller.sendRaw(<String, dynamic>{
      'type': 'response',
      'id': 'request-1',
      'result': true,
    });
    expect(state.isTickerActive, isTrue);
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, framesBeforeResponse + 1);
    expect(state.isTickerActive, isFalse);

    await tester.tap(find.byType(PocketView));
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, greaterThan(framesBeforeResponse + 1));
  });

  testWidgets(
    'inactive prewarm permits one load frame then parks timers and queues sends',
    (tester) async {
      final runtime = _ScheduledTestRuntime(
        nextWakeDelayMilliseconds: -1,
        afterFrameDelayMilliseconds: -1,
      );
      final controller = PocketViewController();
      var ready = false;
      await mountView(
        tester,
        runtime,
        controller: controller,
        active: false,
        onReady: (_) => ready = true,
      );
      expect(ready, isTrue);
      final state = tester.state(find.byType(PocketView)) as dynamic;
      expect(runtime.frameCalls, 0);
      expect(state.isTickerActive, isFalse);
      expect(state.hasScheduledWake, isFalse);
      final startupPending = controller.pendingMessageCount;

      final params = <String, dynamic>{
        'sequence': 1,
        'nested': <String, dynamic>{'value': 'before-mutation'},
      };
      expect(controller.send(method: 'hidden.one', params: params), isTrue);
      (params['nested'] as Map<String, dynamic>)['value'] = 'after-mutation';
      expect(
        controller.sendRaw(<String, dynamic>{
          'type': 'response',
          'id': 'hidden-two',
          'result': <String, dynamic>{'sequence': 2},
        }),
        isTrue,
      );
      expect(runtime.messages, isEmpty);
      expect(controller.pendingMessageCount, startupPending + 2);
      final oversized = List<String>.filled(
        PocketViewController.maxPendingMessageBytes,
        'x',
      ).join();
      expect(
        controller.send(
          method: 'hidden.oversized',
          params: <String, dynamic>{'value': oversized},
        ),
        isFalse,
      );

      final remaining =
          PocketViewController.maxPendingMessages -
          controller.pendingMessageCount;
      for (var index = 0; index < remaining; index++) {
        expect(
          controller.send(
            method: 'hidden.$index',
            params: <String, dynamic>{'index': index},
          ),
          isTrue,
        );
      }
      expect(
        controller.pendingMessageCount,
        PocketViewController.maxPendingMessages,
      );
      expect(controller.send(method: 'hidden.full', params: const {}), isFalse);
      expect(runtime.messages, isEmpty);

      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              active: true,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
            ),
          ),
        ),
      );
      expect(runtime.messages, isNotEmpty);
      final hiddenMessages = runtime.messages
          .where(
            (message) =>
                message['name'] == 'hidden.one' ||
                message['name']?.toString().startsWith('hidden.') == true ||
                message['id'] == 'hidden-two',
          )
          .toList(growable: false);
      expect(
        hiddenMessages,
        hasLength(PocketViewController.maxPendingMessages - startupPending),
      );
      expect(hiddenMessages.first['name'], 'hidden.one');
      expect(
        (hiddenMessages.first['payload'] as Map<String, dynamic>)['nested'],
        <String, dynamic>{'value': 'before-mutation'},
      );
      expect(hiddenMessages[1]['type'], 'response');
      expect(controller.pendingMessageCount, 0);
      await tester.pump(const Duration(milliseconds: 16));
      expect(state.isTickerActive, isFalse);
    },
  );

  testWidgets('controller appActive gate composes with widget and OS gates', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: -1,
    );
    final controller = PocketViewController();
    await mountView(tester, runtime, controller: controller);
    final state = tester.state(find.byType(PocketView)) as dynamic;
    await tester.pump(const Duration(milliseconds: 16));
    final callsBeforeHide = runtime.frameCalls;
    final messagesBeforeHide = runtime.messages.length;

    controller.setAppActive(false);
    expect(state.isTickerActive, isFalse);
    expect(
      controller.send(method: 'controller.hidden', params: const {}),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 1));
    expect(runtime.frameCalls, callsBeforeHide);
    expect(runtime.messages, hasLength(messagesBeforeHide));

    controller.setAppActive(true);
    expect(
      runtime.messages.where(
        (message) => message['name'] == 'controller.hidden',
      ),
      hasLength(1),
    );
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, callsBeforeHide + 1);
    expect(state.isTickerActive, isFalse);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    controller.setAppActive(false);
    controller.setAppActive(true);
    expect(state.isTickerActive, isFalse);
    await tester.pump(const Duration(seconds: 1));
    expect(runtime.frameCalls, callsBeforeHide + 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, callsBeforeHide + 2);
    expect(runtime.frameDeltas.last, lessThan(100));
  });

  testWidgets('detaching a hidden generation drops its queued messages', (
    tester,
  ) async {
    final controller = PocketViewController();
    final oldRuntime = _ScheduledTestRuntime(nextWakeDelayMilliseconds: -1);
    await mountView(tester, oldRuntime, controller: controller, active: false);
    expect(controller.send(method: 'old-generation'), isTrue);
    expect(controller.pendingMessageCount, greaterThan(0));

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(controller.pendingMessageCount, 0);

    final newRuntime = _ScheduledTestRuntime(nextWakeDelayMilliseconds: -1);
    await mountView(tester, newRuntime, controller: controller);
    expect(
      newRuntime.messages.where(
        (message) => message['name'] == 'old-generation',
      ),
      isEmpty,
    );
  });

  testWidgets(
    'hidden duplex ingress remains writable but is consumed on resume',
    (tester) async {
      final endpoint = _ViewDuplexEndpoint();
      final runtime = _ViewDuplexRuntime(endpoint)
        ..consumeIngressOnFrame = true
        ..nextWakeDelayMilliseconds = -1;
      final controller = PocketViewController();
      await mountView(tester, runtime, controller: controller, active: false);
      final channel = controller.duplexChannel;
      expect(channel, isNotNull);
      expect(channel!.pushToPocketJs(msgType: 22, targetId: 7), isTrue);
      controller.notifyWork();
      await tester.pump(const Duration(seconds: 1));
      expect(runtime.consumedIngress, isEmpty);

      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              active: true,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(runtime.consumedIngress, hasLength(1));
      expect(runtime.consumedIngress.single.msgType, 22);
    },
  );

  testWidgets('hidden prewarm closes IME and buffers its dismiss response', (
    tester,
  ) async {
    final runtime = _TestMockRuntime(
      initialEvent: const PocketEvent(
        id: 'open-hidden-input',
        method: 'textInput.open',
        params: <String, dynamic>{
          'id': 'hidden-field',
          'editingSession': 'hidden-session',
          'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
          'text': '',
        },
      ),
    );
    final controller = PocketViewController();
    await mountView(tester, runtime, controller: controller, active: false);
    expect(find.byType(EditableText), findsNothing);
    expect(runtime.messages, isEmpty);
    expect(controller.pendingMessageCount, greaterThanOrEqualTo(1));

    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            controller: controller,
            runtime: runtime,
            active: true,
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: false,
          ),
        ),
      ),
    );
    // The queued dismiss is delivered before the first resumed turn.
    expect(
      runtime.messages.where(
        (message) => message['name'] == 'textInput.dismiss',
      ),
      hasLength(1),
    );
  });

  testWidgets('pause and runtime replacement cancel stale deadline timers', (
    tester,
  ) async {
    final pausedRuntime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: 100,
    );
    await mountView(tester, pausedRuntime);
    await tester.pump(const Duration(milliseconds: 16));
    final pausedState = tester.state(find.byType(PocketView)) as dynamic;
    expect(pausedState.hasScheduledWake, isTrue);
    final callsBeforePause = pausedRuntime.frameCalls;

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(pausedState.hasScheduledWake, isFalse);
    await tester.pump(const Duration(seconds: 1));
    expect(pausedRuntime.frameCalls, callsBeforePause);

    pausedRuntime.afterFrameDelayMilliseconds = -1;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 16));
    expect(pausedRuntime.frameCalls, callsBeforePause + 1);
    expect(pausedState.isTickerActive, isFalse);

    final oldGeneration = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: 100,
    );
    await mountView(tester, oldGeneration, viewKey: const ValueKey('old'));
    await tester.pump(const Duration(milliseconds: 16));
    expect(
      (tester.state(find.byType(PocketView)) as dynamic).hasScheduledWake,
      isTrue,
    );
    final newGeneration = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: -1,
      afterFrameDelayMilliseconds: -1,
    );
    await mountView(tester, newGeneration, viewKey: const ValueKey('new'));
    await tester.pump(const Duration(milliseconds: 16));
    final oldCallsAfterReplacement = oldGeneration.frameCalls;
    final newCallsAfterParking = newGeneration.frameCalls;
    await tester.pump(const Duration(seconds: 1));
    expect(oldGeneration.frameCalls, oldCallsAfterReplacement);
    expect(newGeneration.frameCalls, newCallsAfterParking);
  });

  testWidgets('known idle time stays out of FPS gap accounting', (
    tester,
  ) async {
    final runtime = _ScheduledTestRuntime(
      nextWakeDelayMilliseconds: 0,
      afterFrameDelayMilliseconds: -1,
    );
    final samples = <PocketPerformanceSample>[];
    final controller = PocketViewController();
    await mountView(
      tester,
      runtime,
      controller: controller,
      onPerformanceSample: samples.add,
    );

    await tester.pump(const Duration(milliseconds: 16));
    expect(runtime.frameCalls, greaterThanOrEqualTo(1));
    expect(
      (tester.state(find.byType(PocketView)) as dynamic).isTickerActive,
      isFalse,
    );

    await tester.pump(const Duration(seconds: 5));
    runtime.afterFrameDelayMilliseconds = 0;
    controller.send(method: 'resume-animation');
    await tester.pump(const Duration(milliseconds: 16));
    for (var index = 0; index < 75; index++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(samples, isNotEmpty);
    expect(samples.first.fps, greaterThan(45));
    expect(samples.first.maxGapMs, lessThan(50));
    expect(samples.last.slowFrames, 0);
  });

  testWidgets('forwards an explicit JS semantics snapshot and action', (
    tester,
  ) async {
    final runtime = _TestMockRuntime(
      initialEvent: const PocketEvent(
        id: 'semantic-snapshot-1',
        method: 'accessibility.snapshot',
        params: <String, dynamic>{
          'generation': 1,
          'controls': <Map<String, dynamic>>[
            <String, dynamic>{
              'guestId': 'apple.save',
              'nativeId': 11,
              'label': 'Save',
              'role': 'button',
              'selected': true,
              'checked': true,
              'disabled': false,
              'enabled': true,
              'rect': <String, double>{
                'x': 20,
                'y': 30,
                'width': 100,
                'height': 44,
              },
            },
            <String, dynamic>{
              'guestId': 'apple.delete',
              'nativeId': 12,
              'label': 'Delete',
              'role': 'button',
              'selected': false,
              'checked': false,
              'disabled': true,
              'enabled': false,
              'rect': <String, double>{
                'x': 20,
                'y': 90,
                'width': 100,
                'height': 44,
              },
            },
          ],
        },
      ),
    );
    final controller = PocketViewController();
    final semanticsHandle = tester.ensureSemantics();
    await mountView(tester, runtime, controller: controller);
    await tester.pump();

    expect(
      tester.getSemantics(find.bySemanticsLabel('Save')),
      matchesSemantics(
        label: 'Save',
        isButton: true,
        hasToggledState: true,
        isToggled: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
      ),
    );
    expect(
      tester.getSemantics(find.bySemanticsLabel('Delete')),
      matchesSemantics(
        label: 'Delete',
        isButton: true,
        hasToggledState: true,
        isToggled: false,
        hasEnabledState: true,
        isEnabled: false,
      ),
    );

    tester.semantics.performAction(
      find.semantics.byLabel('Save'),
      SemanticsAction.tap,
    );
    final actionMessages = runtime.messages
        .where((message) => message['name'] == 'accessibility.action')
        .toList();
    expect(actionMessages, hasLength(1));
    expect(actionMessages.single['payload'], <String, dynamic>{
      'action': 'activate',
      'guestId': 'apple.save',
      'nativeId': 11,
      'generation': 1,
    });

    runtime.enqueue(
      const PocketEvent(
        id: 'semantic-snapshot-2',
        method: 'accessibility.snapshot',
        params: <String, dynamic>{'generation': 2, 'controls': <dynamic>[]},
      ),
    );
    expect(controller.send(method: 'semantic.wake'), isTrue);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump();
    expect(find.bySemanticsLabel('Save'), findsNothing);
    expect(find.bySemanticsLabel('Delete'), findsNothing);
    semanticsHandle.dispose();
  });
}
