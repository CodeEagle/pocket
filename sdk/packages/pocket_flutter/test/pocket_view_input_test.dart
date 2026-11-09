import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _RecordingRuntime implements PocketRuntime {
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];

  final PocketFrame _frame = const PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) => _frame;

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

final class _TextInputRuntime implements PocketRuntime {
  _TextInputRuntime({required this.initialEvent});

  final PocketEvent initialEvent;
  final List<PocketEvent> queuedEvents = <PocketEvent>[];
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  bool _sentInitial = false;
  bool denseCanvas = false;

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
    if (!_sentInitial) {
      _sentInitial = true;
      events.add(initialEvent);
    }
    events.addAll(queuedEvents);
    queuedEvents.clear();
    return PocketFrame(
      width: _baseFrame.width,
      height: _baseFrame.height,
      // Crossing the renderer's canvas block boundary changes the number of
      // direct Stack siblings. This is the regression shape that used to
      // rebuild the unkeyed text overlay and drop the platform focus.
      ops: denseCanvas
          ? List<PocketOp>.generate(
              33,
              (index) => PocketRectOp(
                x: index.toDouble(),
                y: 0,
                width: 1,
                height: 1,
                color: 0xff101827,
              ),
            )
          : _baseFrame.ops,
      events: events,
    );
  }

  void enqueue(PocketEvent event) => queuedEvents.add(event);

  void setDenseCanvas(bool value) => denseCanvas = value;

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

PocketEvent _textInputEvent(String method, Map<String, dynamic> params) =>
    PocketEvent(id: 'event-$method', method: method, params: params);

Map<String, dynamic> _textInputOpenParams(String id) => <String, dynamic>{
  'id': id,
  'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
  'text': '你好😀',
  'selectionBase': 4,
  'selectionExtent': 4,
  'composingBase': 2,
  'composingExtent': 4,
  'keyboardType': 'emailAddress',
  'action': 'next',
  'placeholder': '输入文本',
  'textColor': 0xff102030,
  'placeholderColor': 0xff607080,
  'fillColor': 0xfff7f9fc,
  'borderColor': 0xff9aa5b2,
  'focusedBorderColor': 0xff2676cb,
  'borderRadius': 10,
  'fontSize': 16,
  'paddingHorizontal': 10,
  'paddingVertical': 7,
};

Map<String, dynamic> _minimalTextInputOpenParams(String id) =>
    <String, dynamic>{
      'id': id,
      'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
      'text': '',
    };

Future<void> _sendWheelAndPanZoom(
  WidgetTester tester,
  RenderBox surface,
) async {
  const localPosition = Offset(40, 60);
  final globalPosition = surface.localToGlobal(localPosition);
  await tester.sendEventToBinding(
    PointerScrollEvent(
      kind: PointerDeviceKind.mouse,
      position: globalPosition,
      scrollDelta: const Offset(0, 12),
    ),
  );
  final trackpad = TestPointer(23, PointerDeviceKind.trackpad);
  await tester.sendEventToBinding(trackpad.panZoomStart(globalPosition));
  await tester.sendEventToBinding(
    trackpad.panZoomUpdate(globalPosition, pan: const Offset(0, -12)),
  );
  await tester.sendEventToBinding(trackpad.panZoomEnd());
}

void main() {
  testWidgets('opt-in keyboard input publishes official button edges', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            keyboardInputEnabled: true,
            keyboardAutofocus: false,
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();

    final buttons = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .map((message) => (message['payload'] as Map)['buttons'])
        .toList();
    expect(buttons, containsAllInOrder(<int>[0x0020, 0]));
  });

  testWidgets('keyboard aliases keep a shared button held until all release', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            keyboardInputEnabled: true,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.keyD);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyD);
    await tester.pump();

    final buttons = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .map((message) => (message['payload'] as Map)['buttons'])
        .toList();
    expect(buttons, <int>[0x0020, 0]);
  });

  testWidgets('keyboard and external button sources are ORed independently', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    final controller = PocketViewController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            jsSource: '',
            pakBytes: Uint8List(0),
            keyboardInputEnabled: true,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    expect(controller.sendButtons(buttons: 0x0100), isTrue);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    expect(controller.sendButtons(buttons: 0), isTrue);
    await tester.pump();

    final buttons = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .map((message) => (message['payload'] as Map)['buttons'])
        .toList();
    expect(buttons, <int>[0x0020, 0x0120, 0x0100, 0]);
  });

  testWidgets('detaching a view drops both button sources', (tester) async {
    final firstRuntime = _RecordingRuntime();
    final controller = PocketViewController();
    Future<void> pumpView(PocketRuntime runtime) async {
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              controller: controller,
              jsSource: '',
              pakBytes: Uint8List(0),
              keyboardInputEnabled: true,
            ),
          ),
        ),
      );
      await tester.pump();
    }

    await pumpView(firstRuntime);
    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    expect(controller.sendButtons(buttons: 0x0100), isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    final secondRuntime = _RecordingRuntime();
    await pumpView(secondRuntime);
    expect(
      secondRuntime.messages.where(
        (message) => message['name'] == 'input.buttons',
      ),
      isEmpty,
    );
  });

  testWidgets('changing keyboard bindings recomputes held keys', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    Future<void> pumpView(Map<LogicalKeyboardKey, int> bindings) async {
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              keyboardInputEnabled: true,
              keyboardButtonMap: bindings,
            ),
          ),
        ),
      );
      await tester.pump();
    }

    await pumpView(const <LogicalKeyboardKey, int>{});
    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    await pumpView(<LogicalKeyboardKey, int>{
      LogicalKeyboardKey.arrowRight: 0x0040,
    });
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();

    final buttons = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .map((message) => (message['payload'] as Map)['buttons'])
        .toList();
    expect(buttons, <int>[0x0020, 0x0040, 0]);
  });

  testWidgets('hidden keyboard input is cleared and does not accept new keys', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    Future<void> pumpView(bool active) async {
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              keyboardInputEnabled: true,
              active: active,
            ),
          ),
        ),
      );
      await tester.pump();
    }

    await pumpView(true);
    await tester.tap(find.byKey(const ValueKey<String>('pocket-surface-0')));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    final beforeHide = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .length;

    await pumpView(false);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    final hiddenButtons = runtime.messages
        .where((message) => message['name'] == 'input.buttons')
        .skip(beforeHide)
        .map((message) => (message['payload'] as Map)['buttons'])
        .toList();
    expect(hiddenButtons, isEmpty);
  });

  testWidgets('keyboard buttons stay out of an active PocketJS IME field', (
    tester,
  ) async {
    final runtime = _TextInputRuntime(
      initialEvent: _textInputEvent(
        'textInput.open',
        _minimalTextInputOpenParams('keyboard-ime'),
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
            keyboardInputEnabled: true,
          ),
        ),
      ),
    );
    await tester.pump();
    final field = tester.widget<TextField>(
      find.byKey(const ValueKey<String>('pocket-text-input-keyboard-ime')),
    );
    expect(field.focusNode?.hasFocus, isTrue);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    expect(
      runtime.messages.where((message) => message['name'] == 'input.buttons'),
      isEmpty,
    );
  });

  testWidgets('controller publishes validated absolute axes', (tester) async {
    final runtime = _RecordingRuntime();
    final controller = PocketViewController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            jsSource: '',
            pakBytes: Uint8List(0),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(controller.sendAxes(<int, double>{0: 300, 1: 64}), isTrue);
    expect(controller.sendAxes(<int, double>{4: 1}), isFalse);
    final message = runtime.messages.lastWhere(
      (entry) => entry['name'] == 'input.axes',
    );
    expect(message['payload']['axes'], <Map<String, dynamic>>[
      <String, dynamic>{'id': 0, 'value': 255.0},
      <String, dynamic>{'id': 1, 'value': 64.0},
    ]);
  });

  testWidgets('forwards Flutter pointer edges in guest logical coordinates', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
          ),
        ),
      ),
    );
    await tester.pump();

    final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
    expect(surface, findsOneWidget);
    final renderBox = tester.renderObject<RenderBox>(surface);
    final origin = renderBox.localToGlobal(Offset.zero);
    const tapOffset = Offset(40, 20);
    await tester.tapAt(origin + tapOffset);

    final pointers = runtime.messages
        .where((message) => message['name'] == 'input.pointer')
        .toList();
    expect(pointers, hasLength(2));
    expect(
      pointers.map((message) => (message['payload'] as Map)['phase']),
      orderedEquals(<String>['down', 'up']),
    );
    final down = pointers.first['payload'] as Map;
    expect(
      down['x'],
      closeTo(tapOffset.dx * 320 / renderBox.size.width, 0.001),
    );
    expect(
      down['y'],
      closeTo(tapOffset.dy * 480 / renderBox.size.height, 0.001),
    );
    expect(down['surface'], isNull);
  });

  testWidgets('forwards mouse wheel position and delta in guest coordinates', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 160,
          height: 240,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
          ),
        ),
      ),
    );
    await tester.pump();

    final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
    final renderBox = tester.renderObject<RenderBox>(surface);
    const localPosition = Offset(40, 60);
    const wheelDelta = Offset(8, -12);
    await tester.sendEventToBinding(
      PointerScrollEvent(
        kind: PointerDeviceKind.mouse,
        position: renderBox.localToGlobal(localPosition),
        scrollDelta: wheelDelta,
      ),
    );
    await tester.pump();

    final scrolls = runtime.messages
        .where((message) => message['name'] == 'input.scroll')
        .toList();
    expect(scrolls, hasLength(1));
    final payload = scrolls.single['payload'] as Map;
    final scaleX = 320 / renderBox.size.width;
    final scaleY = 480 / renderBox.size.height;
    expect(payload['x'], closeTo(localPosition.dx * scaleX, 0.001));
    expect(payload['y'], closeTo(localPosition.dy * scaleY, 0.001));
    expect(payload['deltaX'], closeTo(wheelDelta.dx * scaleX, 0.001));
    expect(payload['deltaY'], closeTo(wheelDelta.dy * scaleY, 0.001));
    expect(payload['phase'], 'update');
    expect(payload['source'], 'wheel');
    expect(
      runtime.messages.where((message) => message['name'] == 'input.pointer'),
      isEmpty,
      reason: 'a wheel signal must not synthesize a touch or click',
    );
  });

  testWidgets('forwards trackpad pan phases without scale-only scrolls', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 160,
          height: 240,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
          ),
        ),
      ),
    );
    await tester.pump();

    final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
    final renderBox = tester.renderObject<RenderBox>(surface);
    const localPosition = Offset(40, 60);
    final globalPosition = renderBox.localToGlobal(localPosition);
    final trackpad = TestPointer(17, PointerDeviceKind.trackpad);
    await tester.sendEventToBinding(trackpad.panZoomStart(globalPosition));
    await tester.sendEventToBinding(
      trackpad.panZoomUpdate(globalPosition, pan: const Offset(0, -12)),
    );
    // A zoom-only update has no scroll component and must not be forwarded.
    await tester.sendEventToBinding(
      trackpad.panZoomUpdate(
        globalPosition,
        pan: const Offset(0, -12),
        scale: 1.2,
      ),
    );
    await tester.sendEventToBinding(trackpad.panZoomEnd());
    await tester.pump();

    final scrolls = runtime.messages
        .where((message) => message['name'] == 'input.scroll')
        .toList();
    expect(scrolls, hasLength(3));
    final payloads = scrolls
        .map((message) => message['payload'] as Map)
        .toList();
    expect(payloads.map((payload) => payload['phase']), <String>[
      'start',
      'update',
      'end',
    ]);
    expect(
      payloads.map((payload) => payload['source']),
      everyElement('trackpad'),
    );
    final scaleY = 480 / renderBox.size.height;
    expect(payloads[1]['deltaX'], 0.0);
    expect(payloads[1]['deltaY'], closeTo(12 * scaleY, 0.001));
    expect(payloads.first['deltaY'], 0.0);
    expect(payloads.last['deltaY'], 0.0);
    expect(
      runtime.messages.where((message) => message['name'] == 'input.pointer'),
      isEmpty,
      reason: 'trackpad scrolling must not synthesize a touch or click',
    );
  });

  testWidgets('wheel deltas follow ancestor transforms into guest units', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topLeft,
          child: Transform.scale(
            scale: 2,
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 160,
              height: 240,
              child: PocketView(
                runtime: runtime,
                jsSource: '',
                pakBytes: Uint8List(0),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
    final renderBox = tester.renderObject<RenderBox>(surface);
    const localPosition = Offset(40, 60);
    const wheelDelta = Offset(16, -24);
    await tester.sendEventToBinding(
      PointerScrollEvent(
        kind: PointerDeviceKind.mouse,
        position: renderBox.localToGlobal(localPosition),
        scrollDelta: wheelDelta,
      ),
    );
    await tester.pump();

    final scroll = runtime.messages.singleWhere(
      (message) => message['name'] == 'input.scroll',
    );
    final payload = scroll['payload'] as Map;
    expect(payload['x'], closeTo(80, 0.001));
    expect(payload['y'], closeTo(120, 0.001));
    // The transform halves the wheel delta in surface-local units; the guest
    // viewport conversion then doubles it back to screen/guest logical units.
    expect(payload['deltaX'], closeTo(16, 0.001));
    expect(payload['deltaY'], closeTo(-24, 0.001));
  });

  testWidgets('inactive surfaces do not queue wheel or trackpad scrolls', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    final controller = PocketViewController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            jsSource: '',
            pakBytes: Uint8List(0),
            active: false,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(controller.isReady, isTrue);
    final pendingBefore = controller.pendingMessageCount;
    final surface = tester.renderObject<RenderBox>(
      find.byKey(const ValueKey<String>('pocket-surface-0')),
    );
    await _sendWheelAndPanZoom(tester, surface);
    expect(controller.pendingMessageCount, pendingBefore);
    expect(
      runtime.messages.where((message) => message['name'] == 'input.scroll'),
      isEmpty,
    );
  });

  testWidgets('input-disabled surfaces discard wheel and trackpad scrolls', (
    tester,
  ) async {
    final runtime = _RecordingRuntime();
    final controller = PocketViewController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            jsSource: '',
            pakBytes: Uint8List(0),
            inputEnabled: false,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(controller.isReady, isTrue);
    final pendingBefore = controller.pendingMessageCount;
    final surface = tester.renderObject<RenderBox>(
      find.byKey(const ValueKey<String>('pocket-surface-0')),
    );
    await _sendWheelAndPanZoom(tester, surface);
    expect(controller.pendingMessageCount, pendingBefore);
    expect(
      runtime.messages.where((message) => message['name'] == 'input.scroll'),
      isEmpty,
    );
  });

  testWidgets(
    'native TextField round-trips UTF-16 state and rejects stale events',
    (tester) async {
      final runtime = _TextInputRuntime(
        initialEvent: _textInputEvent(
          'textInput.open',
          _textInputOpenParams('session-a'),
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
              fontFamilyFallback: const <String>['InputTestSerif'],
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump();

      final fieldFinder = find.byKey(
        const ValueKey<String>('pocket-text-input-session-a'),
      );
      expect(fieldFinder, findsOneWidget);
      final field = tester.widget<TextField>(fieldFinder);
      expect(field.keyboardType, TextInputType.emailAddress);
      expect(field.textInputAction, TextInputAction.next);
      expect(field.style?.color, const Color(0xff102030));
      expect(field.style?.fontFamilyFallback, <String>['InputTestSerif']);
      expect(field.style?.fontSize, 16);
      expect(field.style?.fontWeight, FontWeight.normal);
      expect(field.style?.height, closeTo(20 / 16, 0.0001));
      expect(field.decoration?.hintText, '输入文本');
      expect(field.decoration?.hintStyle?.fontFamilyFallback, <String>[
        'InputTestSerif',
      ]);
      expect(field.decoration?.fillColor, const Color(0xfff7f9fc));
      expect(field.decoration?.hintStyle?.color, const Color(0xff607080));
      expect(field.decoration?.hintStyle?.height, closeTo(20 / 16, 0.0001));
      final inputBorder = field.decoration?.border as OutlineInputBorder;
      expect(inputBorder.borderRadius, BorderRadius.circular(10));
      expect(inputBorder.borderSide.color, const Color(0xff9aa5b2));
      expect(inputBorder.gapPadding, 0);
      final enabledBorder =
          field.decoration?.enabledBorder as OutlineInputBorder;
      expect(enabledBorder.gapPadding, 0);
      final focusBorder = field.decoration?.focusedBorder as OutlineInputBorder;
      expect(focusBorder.borderSide.color, const Color(0xff2676cb));
      expect(focusBorder.gapPadding, 0);
      expect(
        field.decoration?.contentPadding,
        const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      );
      expect(field.controller!.value.selection.baseOffset, 4);
      expect(
        field.controller!.value.composing,
        const TextRange(start: 2, end: 4),
      );

      // A shell appearance update must not replace the native controller or
      // disturb the caret/composing range. This is the path used when the JS
      // theme changes while the system keyboard remains open.
      final stableController = field.controller!;
      runtime.enqueue(
        _textInputEvent('textInput.update', <String, dynamic>{
          'id': 'session-a',
          'fillColor': 0xffeef6ff,
          'focusedBorderColor': 0xff0b63ce,
          'borderRadius': 12,
        }),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final styledUpdate = tester.widget<TextField>(fieldFinder);
      expect(styledUpdate.controller, same(stableController));
      expect(styledUpdate.controller!.value.text, '你好😀');
      expect(
        styledUpdate.controller!.value.selection,
        const TextSelection.collapsed(offset: 4),
      );
      expect(
        styledUpdate.controller!.value.composing,
        const TextRange(start: 2, end: 4),
      );
      expect(styledUpdate.decoration?.fillColor, const Color(0xffeef6ff));
      final styledFocusBorder =
          styledUpdate.decoration?.focusedBorder as OutlineInputBorder;
      expect(styledFocusBorder.borderSide.color, const Color(0xff0b63ce));
      expect(styledFocusBorder.borderRadius, BorderRadius.circular(12));

      // Image-skinned JS fields retain this same IME session while the
      // native editor contributes only editable text and a visible caret.
      runtime.enqueue(
        _textInputEvent('textInput.update', <String, dynamic>{
          'id': 'session-a',
          'fillColor': 'transparent',
          'borderColor': 'transparent',
          'focusedBorderColor': 'transparent',
          'borderRadius': 0,
        }),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final transparentUpdate = tester.widget<TextField>(fieldFinder);
      expect(transparentUpdate.controller, same(stableController));
      expect(transparentUpdate.controller!.value.text, '你好😀');
      expect(transparentUpdate.style?.fontFamilyFallback, <String>[
        'InputTestSerif',
      ]);
      expect(
        transparentUpdate.decoration?.hintStyle?.fontFamilyFallback,
        <String>['InputTestSerif'],
      );
      expect(
        transparentUpdate.controller!.value.composing,
        const TextRange(start: 2, end: 4),
      );
      expect(transparentUpdate.decoration?.fillColor, Colors.transparent);
      for (final border in [
        transparentUpdate.decoration?.border,
        transparentUpdate.decoration?.enabledBorder,
        transparentUpdate.decoration?.focusedBorder,
      ]) {
        expect(border!.borderSide.color, Colors.transparent);
      }
      expect(transparentUpdate.cursorColor, transparentUpdate.style?.color);

      // An old session cannot overwrite the active IME value, even when its
      // text and selection look otherwise valid.
      runtime.enqueue(
        _textInputEvent('textInput.update', <String, dynamic>{
          ..._textInputOpenParams('stale-session'),
          'text': 'stale',
        }),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(tester.widget<TextField>(fieldFinder).controller!.text, '你好😀');

      runtime.enqueue(
        _textInputEvent('textInput.close', <String, dynamic>{
          'id': 'stale-session',
        }),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(fieldFinder, findsOneWidget);

      // Dart offsets are UTF-16 code-unit offsets. The emoji therefore occupies
      // two units and must round-trip without being split by the bridge.
      runtime.enqueue(
        _textInputEvent('textInput.update', <String, dynamic>{
          'id': 'session-a',
          'text': 'A😀B',
          'selectionBase': 3,
          'selectionExtent': 3,
          'composingBase': 1,
          'composingExtent': 3,
        }),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final updated = tester.widget<TextField>(fieldFinder).controller!.value;
      expect(updated.text, 'A😀B');
      expect(updated.selection.baseOffset, 3);
      expect(updated.selection.extentOffset, 3);
      expect(updated.composing, const TextRange(start: 1, end: 3));
      expect(
        runtime.messages.where(
          (message) => message['name'] == 'textInput.edit',
        ),
        isEmpty,
      );
    },
  );

  testWidgets('native input glyph origin matches the JS text slot', (
    tester,
  ) async {
    final open = _minimalTextInputOpenParams('session-line-box');
    open.addAll(<String, dynamic>{
      'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 33},
      'placeholder': 'Tap to type',
      'fontSize': 14,
      'paddingHorizontal': 12,
      'paddingVertical': 8,
    });
    final runtime = _TextInputRuntime(
      initialEvent: _textInputEvent('textInput.open', open),
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
      const ValueKey<String>('pocket-text-input-session-line-box'),
    );
    final hintFinder = find.text('Tap to type');
    expect(fieldFinder, findsOneWidget);
    expect(hintFinder, findsOneWidget);
    final field = tester.widget<TextField>(fieldFinder);
    final fieldRect = tester.getRect(fieldFinder);
    final hintRect = tester.getRect(hintFinder);

    // Native TEXT_RUN defaults to ceil(fontSize * 1.2), i.e. a 17px line box
    // for the JS text-sm slot. The host must keep the Flutter glyph origin at
    // the guest shell's padding edge instead of inheriting Material 3's
    // 21px bodyLarge line box (which shifts it three pixels upward in a 33px
    // input shell).
    expect(field.style?.height, closeTo(17 / 14, 0.0001));
    expect(field.decoration?.hintStyle?.height, closeTo(17 / 14, 0.0001));
    expect(hintRect.left, closeTo(fieldRect.left + 12, 0.001));
    expect(hintRect.top, closeTo(fieldRect.top + 8, 0.001));
    expect(hintRect.height, closeTo(17, 0.001));
  });

  testWidgets(
    'submit, outside tap, and disposal send session-scoped messages',
    (tester) async {
      final runtime = _TextInputRuntime(
        initialEvent: _textInputEvent(
          'textInput.open',
          _textInputOpenParams('session-submit'),
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
        const ValueKey<String>('pocket-text-input-session-submit'),
      );
      expect(fieldFinder, findsOneWidget);
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      await tester.pump();
      final submit = runtime.messages.singleWhere(
        (message) => message['name'] == 'textInput.submit',
      );
      expect((submit['payload'] as Map)['id'], 'session-submit');
      expect((submit['payload'] as Map)['action'], 'next');
      expect(
        find.byKey(const ValueKey<String>('pocket-text-input-session-submit')),
        findsNothing,
      );

      runtime.enqueue(
        _textInputEvent('textInput.open', _textInputOpenParams('session-blur')),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final blurField = find.byKey(
        const ValueKey<String>('pocket-text-input-session-blur'),
      );
      expect(blurField, findsOneWidget);
      tester.widget<TextField>(blurField).focusNode!.unfocus();
      await tester.pump();
      final blurDismiss = runtime.messages.lastWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      expect((blurDismiss['payload'] as Map)['id'], 'session-blur');
      expect((blurDismiss['payload'] as Map)['reason'], 'blur');

      // Re-open a different session and dismiss it by tapping outside the
      // native editor. This must not be interpreted as a guest pointer edge.
      runtime.enqueue(
        _textInputEvent(
          'textInput.open',
          _textInputOpenParams('session-outside'),
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      final outsideField = find.byKey(
        const ValueKey<String>('pocket-text-input-session-outside'),
      );
      expect(outsideField, findsOneWidget);

      // A scroll/drag that starts outside the editor is not a tap and must
      // leave the focused session alive.
      final drag = await tester.startGesture(const Offset(300, 450));
      await drag.moveTo(const Offset(300, 300));
      await tester.pump(const Duration(milliseconds: 120));
      await drag.up();
      await tester.pump();
      expect(outsideField, findsOneWidget);

      final outsideMessageStart = runtime.messages.length;
      await tester.tapAt(const Offset(300, 450));
      await tester.pump();
      await tester.pump();
      final outsideMessages = runtime.messages.sublist(outsideMessageStart);
      expect(
        outsideMessages
            .where((message) => message['name'] == 'input.pointer')
            .map((message) => (message['payload'] as Map)['phase']),
        containsAllInOrder(<String>['down', 'up']),
      );
      final dismiss = runtime.messages.lastWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      final dismissIndex = outsideMessages.indexOf(dismiss);
      final pointerUpIndex = outsideMessages.lastIndexWhere(
        (message) =>
            message['name'] == 'input.pointer' &&
            (message['payload'] as Map)['phase'] == 'up',
      );
      expect(dismissIndex, greaterThan(pointerUpIndex));
      expect((dismiss['payload'] as Map)['id'], 'session-outside');
      expect((dismiss['payload'] as Map)['reason'], 'outside');
      expect(
        find.byKey(const ValueKey<String>('pocket-text-input-session-outside')),
        findsNothing,
      );

      // A live editor is explicitly dismissed before the runtime is detached.
      runtime.enqueue(
        _textInputEvent(
          'textInput.open',
          _textInputOpenParams('session-dispose'),
        ),
      );
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        find.byKey(const ValueKey<String>('pocket-text-input-session-dispose')),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      final disposeDismiss = runtime.messages.lastWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      expect((disposeDismiss['payload'] as Map)['id'], 'session-dispose');
      expect((disposeDismiss['payload'] as Map)['reason'], 'runtime.dispose');
    },
  );

  testWidgets('text input appearance keeps defaults for older guests', (
    tester,
  ) async {
    final runtime = _TextInputRuntime(
      initialEvent: _textInputEvent(
        'textInput.open',
        _minimalTextInputOpenParams('session-default-style'),
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
    final field = tester.widget<TextField>(
      find.byKey(
        const ValueKey<String>('pocket-text-input-session-default-style'),
      ),
    );
    expect(field.style?.color, const Color(0xff283444));
    expect(field.style?.fontFamilyFallback, isNull);
    expect(field.decoration?.fillColor, Colors.white);
    expect(field.decoration?.hintStyle?.fontFamilyFallback, isNull);
    expect(field.decoration?.hintStyle?.color, const Color(0xff667485));
    expect(field.decoration?.hintText, isNull);
  });

  testWidgets('text input overlay follows and clips to the guest page viewport', (
    tester,
  ) async {
    final open = _textInputOpenParams('session-clip');
    open['rect'] = <String, double>{'x': 20, 'y': 180, 'w': 180, 'h': 42};
    open['clip'] = <String, double>{'x': 0, 'y': 0, 'w': 320, 'h': 200};
    final runtime = _TextInputRuntime(
      initialEvent: _textInputEvent('textInput.open', open),
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

    final overlay = find.byKey(
      const ValueKey<String>('pocket-text-overlay-session-clip'),
    );
    expect(overlay, findsOneWidget);
    final clippedOverlay = tester.widget<Positioned>(overlay);
    final surfaceSize = tester.getSize(
      find.byKey(const ValueKey<String>('pocket-surface-0')),
    );
    final scaleX = surfaceSize.width / 320;
    final scaleY = surfaceSize.height / 480;
    // The viewport remains the stable clipping container; the field keeps its
    // full geometry inside it so scrolling it out does not dispose EditableText.
    expect(clippedOverlay.left, 0);
    expect(clippedOverlay.top, 0);
    expect(clippedOverlay.width, closeTo(320 * scaleX, 0.001));
    expect(clippedOverlay.height, closeTo(200 * scaleY, 0.001));
    expect(
      find.descendant(of: overlay, matching: find.byType(ClipRect)),
      findsOneWidget,
    );

    // A scroll/viewport update must move the existing platform field and its
    // clip together, without replacing the controller/focus owner.
    final controller = tester
        .widget<TextField>(
          find.byKey(const ValueKey<String>('pocket-text-input-session-clip')),
        )
        .controller;
    final focusNode = tester
        .widget<TextField>(
          find.byKey(const ValueKey<String>('pocket-text-input-session-clip')),
        )
        .focusNode;
    runtime.enqueue(
      _textInputEvent('textInput.update', <String, dynamic>{
        'id': 'session-clip',
        'rect': <String, double>{'x': 20, 'y': 300, 'w': 180, 'h': 42},
        'clip': <String, double>{'x': 0, 'y': 0, 'w': 320, 'h': 160},
      }),
    );
    await tester.pump(const Duration(milliseconds: 16));
    final movedOverlay = tester.widget<Positioned>(overlay);
    expect(movedOverlay.left, 0);
    expect(movedOverlay.top, 0);
    expect(movedOverlay.width, closeTo(320 * scaleX, 0.001));
    expect(movedOverlay.height, closeTo(160 * scaleY, 0.001));
    expect(
      find.byKey(const ValueKey<String>('pocket-text-input-session-clip')),
      findsOneWidget,
    );
    expect(focusNode!.hasFocus, isTrue);

    runtime.enqueue(
      _textInputEvent('textInput.update', <String, dynamic>{
        'id': 'session-clip',
        'rect': <String, double>{'x': 20, 'y': 100, 'w': 180, 'h': 42},
        'clip': <String, double>{'x': 0, 'y': 0, 'w': 320, 'h': 160},
      }),
    );
    await tester.pump(const Duration(milliseconds: 16));
    expect(
      tester.widget<Positioned>(overlay).height,
      closeTo(160 * scaleY, 0.001),
    );
    expect(focusNode.hasFocus, isTrue);
    expect(
      tester
          .widget<TextField>(
            find.byKey(
              const ValueKey<String>('pocket-text-input-session-clip'),
            ),
          )
          .controller,
      same(controller),
    );
  });

  testWidgets(
    'pointer taps in the clipped-away part of an input reach the guest',
    (tester) async {
      final open = _textInputOpenParams('session-clip-hit-test');
      open['rect'] = <String, double>{'x': 20, 'y': 180, 'w': 180, 'h': 42};
      open['clip'] = <String, double>{'x': 0, 'y': 0, 'w': 320, 'h': 200};
      final runtime = _TextInputRuntime(
        initialEvent: _textInputEvent('textInput.open', open),
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
            ),
          ),
        ),
      );
      await tester.pump();

      final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
      final surfaceBox = tester.renderObject<RenderBox>(surface);
      final messageStart = runtime.messages.length;
      // y=210 is inside the raw field (180..222), but outside its visible
      // clip (0..200). It must be treated as a guest/page tap, not swallowed
      // by the platform TextField hit-test guard.
      await tester.tapAt(surfaceBox.localToGlobal(const Offset(50, 210)));
      await tester.pump();
      await tester.pump();

      final messages = runtime.messages.sublist(messageStart);
      expect(
        messages
            .where((message) => message['name'] == 'input.pointer')
            .map((message) => (message['payload'] as Map)['phase']),
        containsAllInOrder(<String>['down', 'up']),
      );
      final dismiss = messages.lastWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      final pointerUpIndex = messages.lastIndexWhere(
        (message) =>
            message['name'] == 'input.pointer' &&
            (message['payload'] as Map)['phase'] == 'up',
      );
      expect(messages.indexOf(dismiss), greaterThan(pointerUpIndex));
      expect(
        find.byKey(
          const ValueKey<String>('pocket-text-input-session-clip-hit-test'),
        ),
        findsNothing,
      );
    },
  );

  testWidgets(
    'transient view inset changes do not dismiss a focused text input',
    (tester) async {
      addTearDown(tester.view.resetViewInsets);
      final runtime = _TextInputRuntime(
        initialEvent: _textInputEvent(
          'textInput.open',
          _textInputOpenParams('session-insets'),
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
            ),
          ),
        ),
      );
      await tester.pump();

      final fieldFinder = find.byKey(
        const ValueKey<String>('pocket-text-input-session-insets'),
      );
      expect(fieldFinder, findsOneWidget);
      final field = tester.widget<TextField>(fieldFinder);
      expect(field.focusNode!.hasFocus, isTrue);

      // The platform may report an intermediate zero while the IME is
      // animating. A focused session must stay alive through that transition.
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pump();
      tester.view.viewInsets = FakeViewPadding.zero;
      await tester.pump();
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pump();
      expect(fieldFinder, findsOneWidget);
      expect(tester.widget<TextField>(fieldFinder).focusNode!.hasFocus, isTrue);
      expect(
        runtime.messages.where(
          (message) => message['name'] == 'textInput.dismiss',
        ),
        isEmpty,
      );

      // Focus changes remain authoritative even after the inset transition.
      tester.widget<TextField>(fieldFinder).focusNode!.unfocus();
      await tester.pump();
      await tester.pump();
      expect(fieldFinder, findsNothing);
      final dismiss = runtime.messages.singleWhere(
        (message) => message['name'] == 'textInput.dismiss',
      );
      expect((dismiss['payload'] as Map)['id'], 'session-insets');
      expect((dismiss['payload'] as Map)['reason'], 'blur');
    },
  );

  testWidgets('canvas block count changes preserve the focused text overlay', (
    tester,
  ) async {
    final runtime = _TextInputRuntime(
      initialEvent: _textInputEvent(
        'textInput.open',
        _textInputOpenParams('session-stable-overlay'),
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
          ),
        ),
      ),
    );
    await tester.pump();

    final fieldFinder = find.byKey(
      const ValueKey<String>('pocket-text-input-session-stable-overlay'),
    );
    final initialField = tester.widget<TextField>(fieldFinder);
    final focusNode = initialField.focusNode!;
    final controller = initialField.controller!;
    final editableState = tester.state<EditableTextState>(
      find.byType(EditableText),
    );
    expect(focusNode.hasFocus, isTrue);

    runtime.setDenseCanvas(true);
    await tester.pump(const Duration(milliseconds: 16));
    expect(fieldFinder, findsOneWidget);
    expect(
      identical(tester.widget<TextField>(fieldFinder).focusNode, focusNode),
      isTrue,
    );
    expect(focusNode.hasFocus, isTrue);
    expect(tester.widget<TextField>(fieldFinder).controller, controller);
    expect(
      tester.state<EditableTextState>(find.byType(EditableText)),
      same(editableState),
    );

    runtime.setDenseCanvas(false);
    await tester.pump(const Duration(milliseconds: 16));
    expect(fieldFinder, findsOneWidget);
    expect(
      identical(tester.widget<TextField>(fieldFinder).focusNode, focusNode),
      isTrue,
    );
    expect(focusNode.hasFocus, isTrue);
    expect(tester.widget<TextField>(fieldFinder).controller, controller);
    expect(
      tester.state<EditableTextState>(find.byType(EditableText)),
      same(editableState),
    );
    expect(
      runtime.messages.where(
        (message) => message['name'] == 'textInput.dismiss',
      ),
      isEmpty,
    );
  });
}
