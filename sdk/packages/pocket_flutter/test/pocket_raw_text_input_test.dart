import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _RawRuntime implements PocketRuntime {
  _RawRuntime({this.initialEvents = const <PocketEvent>[]});

  final List<PocketEvent> initialEvents;
  final List<PocketEvent> queuedEvents = <PocketEvent>[];
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  bool _sentInitial = false;

  PocketFrame _next() {
    final events = <PocketEvent>[];
    if (!_sentInitial) {
      _sentInitial = true;
      events.addAll(initialEvents);
    }
    events.addAll(queuedEvents);
    queuedEvents.clear();
    return PocketFrame(
      width: 320,
      height: 480,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
      ],
      events: events,
    );
  }

  List<Map<String, dynamic>> get textEvents => messages
      .where((m) => m['name'] == 'input.text')
      .map((m) => Map<String, dynamic>.from(m['payload'] as Map))
      .toList();

  List<Map<String, dynamic>> named(String name) => messages
      .where((m) => m['name'] == name)
      .map((m) => Map<String, dynamic>.from(m['payload'] as Map))
      .toList();

  @override
  PocketFrame eval(String source) => _next();
  @override
  PocketFrame load(String source, Uint8List pak) => _next();
  @override
  PocketFrame frame(int deltaMilliseconds) => _next();
  @override
  bool resizeViewport(double width, double height) => false;
  @override
  void enableAuxiliary(double width, double height) {}
  @override
  void send(Map<String, dynamic> message) =>
      messages.add(Map<String, dynamic>.from(message));
  @override
  String? get lastError => null;
  @override
  void dispose() {}
}

PocketEvent _event(String method, Map<String, dynamic> params) =>
    PocketEvent(id: 'e-$method', method: method, params: params);

Map<String, dynamic> _rawOpen(String id) => <String, dynamic>{
  'id': id,
  'rect': <String, double>{'x': 20, 'y': 40, 'w': 2, 'h': 16},
};

Future<void> _pump(
  WidgetTester tester,
  _RawRuntime runtime, {
  bool raw = true,
  bool keyboardInput = true,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SizedBox(
        width: 320,
        height: 480,
        child: PocketView(
          runtime: runtime,
          jsSource: '',
          pakBytes: Uint8List(0),
          rawTextInputEnabled: raw,
          keyboardInputEnabled: keyboardInput,
          showDebugFps: false,
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

Map<String, dynamic> _delta({
  required String oldText,
  required String deltaText,
  required int start,
  required int end,
  required int selection,
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

Future<void> _deltas(WidgetTester tester, List<Map<String, dynamic>> deltas) {
  final setClient = tester.testTextInput.log.lastWhere(
    (call) => call.method == 'TextInput.setClient',
  );
  final clientId = (setClient.arguments as List<dynamic>)[0] as int;
  return tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/textinput',
    const JSONMethodCodec().encodeMethodCall(
      MethodCall('TextInputClient.updateEditingStateWithDeltas', <dynamic>[
        clientId,
        <String, dynamic>{'deltas': deltas},
      ]),
    ),
    (_) {},
  );
}

void main() {
  testWidgets('rawOpen attaches a delta client, reports caret and opened', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    final setClient = tester.testTextInput.log.lastWhere(
      (call) => call.method == 'TextInput.setClient',
    );
    final config = (setClient.arguments as List<dynamic>)[1] as Map;
    expect(config['enableDeltaModel'], isTrue);
    final methods = tester.testTextInput.log.map((c) => c.method).toList();
    expect(methods, contains('TextInput.show'));
    expect(methods, contains('TextInput.setCaretRect'));
    final caret = tester.testTextInput.log.lastWhere(
      (call) => call.method == 'TextInput.setCaretRect',
    );
    // The 320x480 guest is scaled 1.25x into the 800x600 test surface.
    expect((caret.arguments as Map)['x'], closeTo(25, 0.01));
    expect((caret.arguments as Map)['y'], closeTo(50, 0.01));
    expect(runtime.named('textInput.rawOpened'), <Map<String, dynamic>>[
      <String, dynamic>{'id': 'r1'},
    ]);
    // No TextField overlay is created for a raw session.
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('hardware keys carry logical name, repeat and modifiers', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyRepeatEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.keyS);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyS);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await tester.pump();
    expect(runtime.textEvents, <Map<String, dynamic>>[
      <String, dynamic>{'kind': 'keyDown', 'key': 'Control', 'modifiers': 2},
      <String, dynamic>{'kind': 'keyDown', 'key': 'Shift', 'modifiers': 3},
      <String, dynamic>{'kind': 'keyDown', 'key': 'ArrowLeft', 'modifiers': 3},
      <String, dynamic>{
        'kind': 'keyDown',
        'key': 'ArrowLeft',
        'repeat': true,
        'modifiers': 3,
      },
      <String, dynamic>{'kind': 'keyUp', 'key': 'ArrowLeft', 'modifiers': 3},
      <String, dynamic>{'kind': 'keyUp', 'key': 'Shift', 'modifiers': 2},
      <String, dynamic>{'kind': 'keyUp', 'key': 'Control'},
      <String, dynamic>{'kind': 'keyDown', 'key': 'Meta', 'modifiers': 8},
      <String, dynamic>{'kind': 'keyDown', 'key': 's', 'modifiers': 8},
      <String, dynamic>{'kind': 'keyUp', 'key': 's', 'modifiers': 8},
      <String, dynamic>{'kind': 'keyUp', 'key': 'Meta'},
    ]);
    // No double delivery through the button bitmask path.
    expect(runtime.named('input.buttons'), isEmpty);
  });

  testWidgets('IME: pinyin composition, candidate commit and cancel', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    // n -> ni (marked), then candidate replaces the marked text.
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: 'n',
        start: 0,
        end: 0,
        selection: 1,
        composingBase: 0,
        composingExtent: 1,
      ),
    ]);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: 'n',
        deltaText: 'ni',
        start: 0,
        end: 1,
        selection: 2,
        composingBase: 0,
        composingExtent: 2,
      ),
    ]);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: 'ni', deltaText: '你', start: 0, end: 2, selection: 1),
    ]);
    expect(runtime.textEvents, <Map<String, dynamic>>[
      <String, dynamic>{
        'kind': 'composition',
        'text': 'n',
        'selectionStart': 1,
        'selectionEnd': 1,
      },
      <String, dynamic>{
        'kind': 'composition',
        'text': 'ni',
        'selectionStart': 2,
        'selectionEnd': 2,
      },
      <String, dynamic>{'kind': 'compositionEnd'},
      <String, dynamic>{'kind': 'commit', 'text': '你'},
    ]);
    // The scratch buffer is reset so the platform cannot edit committed text.
    final reset = tester.testTextInput.log.lastWhere(
      (call) => call.method == 'TextInput.setEditingState',
    );
    expect((reset.arguments as Map)['text'], '');

    // Cancel: composing text removed, no commit.
    runtime.messages.clear();
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: 'k',
        start: 0,
        end: 0,
        selection: 1,
        composingBase: 0,
        composingExtent: 1,
      ),
    ]);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: 'k', deltaText: '', start: 0, end: 1, selection: 0),
    ]);
    expect(runtime.textEvents.map((e) => e['kind']).toList(), <String>[
      'composition',
      'compositionEnd',
    ]);
  });

  testWidgets('IME: dead key, plain insertion and astral composition', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    // Dead acute then e becomes e-acute.
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: '´',
        start: 0,
        end: 0,
        selection: 1,
        composingBase: 0,
        composingExtent: 1,
      ),
    ]);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: '´', deltaText: 'é', start: 0, end: 1, selection: 1),
    ]);
    // Plain typing arrives as a commit.
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: '', deltaText: 'x', start: 0, end: 0, selection: 1),
    ]);
    // Composition with a non-BMP character: offsets are UTF-16 units and the
    // selection is relative to the marked text.
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: 'あ😀',
        start: 0,
        end: 0,
        selection: 3,
        composingBase: 0,
        composingExtent: 3,
      ),
    ]);
    expect(runtime.textEvents, <Map<String, dynamic>>[
      <String, dynamic>{
        'kind': 'composition',
        'text': '´',
        'selectionStart': 1,
        'selectionEnd': 1,
      },
      <String, dynamic>{'kind': 'compositionEnd'},
      <String, dynamic>{'kind': 'commit', 'text': 'é'},
      <String, dynamic>{'kind': 'commit', 'text': 'x'},
      <String, dynamic>{
        'kind': 'composition',
        'text': 'あ😀',
        'selectionStart': 3,
        'selectionEnd': 3,
      },
    ]);
  });

  testWidgets('commits above 4096 UTF-8 bytes are split on code points', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    final big = '😀' * 2000; // 8000 UTF-8 bytes
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: big,
        start: 0,
        end: 0,
        selection: big.length,
      ),
    ]);
    final commits = runtime.textEvents;
    expect(commits.length, 2);
    expect(commits.every((e) => e['kind'] == 'commit'), isTrue);
    expect(
      commits.every((e) => (e['text'] as String).runes.length * 4 <= 4096),
      isTrue,
    );
    expect(commits.map((e) => e['text']).join(), big);
  });

  testWidgets('while composing, key presses belong to the IME', (tester) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: 'ni',
        start: 0,
        end: 0,
        selection: 2,
        composingBase: 0,
        composingExtent: 2,
      ),
    ]);
    runtime.messages.clear();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    expect(runtime.textEvents, <Map<String, dynamic>>[
      <String, dynamic>{'kind': 'keyUp', 'key': 'Enter'},
    ]);
  });

  testWidgets('guest close, TextField open and gate-off all stop capture', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    runtime.queuedEvents.add(
      _event('textInput.open', <String, dynamic>{
        'id': 'field',
        'rect': <String, double>{'x': 0, 'y': 0, 'w': 100, 'h': 30},
        'text': '',
      }),
    );
    await tester.pump(const Duration(milliseconds: 20));
    await tester.pump();
    expect(find.byType(TextField), findsOneWidget);
    expect(runtime.named('textInput.rawDismiss'), <Map<String, dynamic>>[
      <String, dynamic>{'id': 'r1', 'reason': 'replaced'},
    ]);
    // Keys are no longer forwarded as raw text.
    runtime.messages.clear();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.keyA);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyA);
    expect(runtime.textEvents, isEmpty);

    final gated = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('g'))],
    );
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, gated, raw: false);
    expect(gated.named('textInput.rawDismiss'), <Map<String, dynamic>>[
      <String, dynamic>{'id': 'g', 'reason': 'unavailable'},
    ]);
    expect(tester.testTextInput.hasAnyClients, isFalse);
  });

  testWidgets('disabling inputEnabled dismisses the IME session', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            inputEnabled: false,
            showDebugFps: false,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(runtime.named('textInput.rawDismiss'), <Map<String, dynamic>>[
      <String, dynamic>{'id': 'r1', 'reason': 'unavailable'},
    ]);
    expect(tester.testTextInput.hasAnyClients, isFalse);
    // A late IME commit must not reach the guest as input.text.
    runtime.messages.clear();
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(
        oldText: '',
        deltaText: 'x',
        start: 0,
        end: 0,
        selection: 1,
      ),
    ]);
    await tester.pump();
    expect(runtime.textEvents, isEmpty);
  });

  testWidgets('rawClose detaches the IME and restores button keys', (
    tester,
  ) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    runtime.queuedEvents.add(
      _event('textInput.rawClose', <String, dynamic>{'id': 'r1'}),
    );
    await tester.pump(const Duration(milliseconds: 20));
    await tester.pump();
    expect(tester.testTextInput.hasAnyClients, isFalse);
    runtime.messages.clear();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    await tester.sendKeyUpEvent(LogicalKeyboardKey.arrowRight);
    expect(runtime.textEvents, isEmpty);
    expect(
      runtime.named('input.buttons').map((e) => e['buttons']).toList(),
      containsAll(<int>[0x0020]),
    );
  });

  Future<_RawRuntime> openRaw(WidgetTester tester) async {
    final runtime = _RawRuntime(
      initialEvents: <PocketEvent>[_event('textInput.rawOpen', _rawOpen('r1'))],
    );
    await _pump(tester, runtime);
    runtime.messages.clear();
    return runtime;
  }

  List<String> keyPairs(_RawRuntime runtime) =>
      runtime.textEvents.map((e) => '${e['kind']}:${e['key']}').toList();

  testWidgets('keyUp reuses the keyDown name for printable keys', (
    tester,
  ) async {
    final runtime = await openRaw(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.keyA, character: 'A');
    await tester.sendKeyRepeatEvent(LogicalKeyboardKey.keyA, character: 'A');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.keyA);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    // Shift released first: the up must still match the down.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.slash, character: '?');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.slash);
    expect(keyPairs(runtime), <String>[
      'keyDown:Shift',
      'keyDown:A',
      'keyDown:A',
      'keyUp:A',
      'keyUp:Shift',
      'keyDown:Shift',
      'keyDown:?',
      'keyUp:Shift',
      'keyUp:?',
    ]);
  });

  testWidgets('AltGr text and multi-rune characters reach the IME', (
    tester,
  ) async {
    final runtime = await openRaw(tester);
    Future<KeyEventResult?> result(LogicalKeyboardKey key, String? ch) async {
      KeyEventResult? out;
      final focus = FocusManager.instance.primaryFocus!;
      // Probe the real handler through the focus node.
      final event = KeyDownEvent(
        physicalKey: PhysicalKeyboardKey.keyQ,
        logicalKey: key,
        character: ch,
        timeStamp: Duration.zero,
      );
      out = focus.onKeyEvent?.call(focus, event);
      return out;
    }

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    expect(await result(LogicalKeyboardKey.keyQ, '@'), KeyEventResult.ignored);
    expect(
      await result(LogicalKeyboardKey.keyE, '\u20ac'),
      KeyEventResult.ignored,
    );
    // Control+Alt without text stays a shortcut.
    expect(
      await result(LogicalKeyboardKey.delete, null),
      KeyEventResult.handled,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    // Control alone with a control character is a handled shortcut.
    expect(
      await result(LogicalKeyboardKey.keyZ, '\u001a'),
      KeyEventResult.handled,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    expect(await result(LogicalKeyboardKey.keyS, 's'), KeyEventResult.handled);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    // Multi-rune (emoji / combined) character is printable.
    expect(
      await result(LogicalKeyboardKey.keyA, '\u{1F469}\u200D\u{1F4BB}'),
      KeyEventResult.ignored,
    );
    expect(keyPairs(runtime), contains('keyDown:@'));
  });

  testWidgets('Enter key is delivered once even if the IME commits newline', (
    tester,
  ) async {
    final runtime = await openRaw(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: '', deltaText: '\n', start: 0, end: 0, selection: 1),
    ]);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    expect(runtime.textEvents.map((e) => e['kind']).toList(), <String>[
      'keyDown',
      'keyUp',
    ]);
    // A newline that is not tied to an Enter keyDown (soft keyboard) commits.
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: '', deltaText: '\n', start: 0, end: 0, selection: 1),
    ]);
    expect(runtime.textEvents.last, <String, dynamic>{
      'kind': 'commit',
      'text': '\n',
    });
    // Suppression does not eat ordinary text after Enter.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await _deltas(tester, <Map<String, dynamic>>[
      _delta(oldText: '', deltaText: 'x', start: 0, end: 0, selection: 1),
    ]);
    expect(runtime.textEvents.last['text'], 'x');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
  });

  testWidgets('disabling raw or keyboard input dismisses the session', (
    tester,
  ) async {
    for (final turnOff in <String>['raw', 'keyboard']) {
      final runtime = _RawRuntime(
        initialEvents: <PocketEvent>[
          _event('textInput.rawOpen', _rawOpen('r-$turnOff')),
        ],
      );
      await _pump(tester, runtime);
      expect(tester.testTextInput.hasAnyClients, isTrue);
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              rawTextInputEnabled: turnOff != 'raw',
              keyboardInputEnabled: turnOff != 'keyboard',
              showDebugFps: false,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(runtime.named('textInput.rawDismiss'), <Map<String, dynamic>>[
        <String, dynamic>{'id': 'r-$turnOff', 'reason': 'unavailable'},
      ], reason: turnOff);
      expect(tester.testTextInput.hasAnyClients, isFalse, reason: turnOff);
      await tester.pumpWidget(const SizedBox());
    }
  });
}
