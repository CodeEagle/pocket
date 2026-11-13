import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _Runtime implements PocketRuntime {
  _Runtime(this.initial);

  final PocketEvent initial;
  final List<PocketEvent> queued = <PocketEvent>[];
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  bool _sent = false;

  PocketFrame _next() {
    final events = <PocketEvent>[if (!_sent) initial, ...queued];
    _sent = true;
    queued.clear();
    return PocketFrame(
      width: 320,
      height: 480,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
      ],
      events: events,
    );
  }

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

Map<String, dynamic> _open(Map<String, dynamic> extra) => <String, dynamic>{
  'id': 'ml',
  'rect': <String, double>{'x': 10, 'y': 10, 'w': 200, 'h': 80},
  'text': '',
  ...extra,
};

Future<_Runtime> _mount(
  WidgetTester tester,
  Map<String, dynamic> extra,
) async {
  final runtime = _Runtime(
    PocketEvent(id: 'o', method: 'textInput.open', params: _open(extra)),
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
  await tester.pump();
  return runtime;
}

TextField _field(WidgetTester tester) => tester.widget<TextField>(
  find.byKey(const ValueKey<String>('pocket-text-input-ml')),
);

void main() {
  testWidgets('single-line default stays maxLines 1 / done', (tester) async {
    await _mount(tester, <String, dynamic>{
      'keyboardType': 'text',
      'action': 'done',
      'maxLines': 1,
    });
    final field = _field(tester);
    expect(field.maxLines, 1);
    expect(field.minLines, isNull);
    expect(field.textInputAction, TextInputAction.done);
  });

  testWidgets('multiline with explicit null maxLines is unbounded', (
    tester,
  ) async {
    await _mount(tester, <String, dynamic>{
      'keyboardType': 'multiline',
      'action': 'newline',
      'maxLines': null,
      'minLines': 2,
    });
    final field = _field(tester);
    expect(field.keyboardType, TextInputType.multiline);
    expect(field.textInputAction, TextInputAction.newline);
    expect(field.maxLines, isNull);
    expect(field.minLines, 2);
  });

  testWidgets('bounded maxLines is honoured and minLines is clamped', (
    tester,
  ) async {
    await _mount(tester, <String, dynamic>{
      'keyboardType': 'multiline',
      'action': 'newline',
      'maxLines': 4,
      'minLines': 9,
    });
    final field = _field(tester);
    expect(field.maxLines, 4);
    expect(field.minLines, 4);
  });

  testWidgets('textInput.update can switch maxLines to unbounded', (
    tester,
  ) async {
    final runtime = await _mount(tester, <String, dynamic>{
      'keyboardType': 'multiline',
      'action': 'newline',
      'maxLines': 3,
    });
    expect(_field(tester).maxLines, 3);
    runtime.queued.add(
      PocketEvent(
        id: 'u',
        method: 'textInput.update',
        params: <String, dynamic>{'id': 'ml', 'maxLines': null},
      ),
    );
    await tester.pump(const Duration(milliseconds: 20));
    await tester.pump();
    expect(_field(tester).maxLines, isNull);
  });

  testWidgets('multiline Enter inserts a newline and never submits', (
    tester,
  ) async {
    final runtime = await _mount(tester, <String, dynamic>{
      'keyboardType': 'multiline',
      'action': 'newline',
      'maxLines': null,
    });
    await tester.showKeyboard(find.byType(TextField));
    await tester.testTextInput.receiveAction(TextInputAction.newline);
    await tester.pump();
    expect(runtime.named('textInput.submit'), isEmpty);
    // The platform inserts the newline as text; it round-trips to the guest.
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'a\nb',
        selection: TextSelection.collapsed(offset: 3),
      ),
    );
    await tester.pump();
    expect(_field(tester).controller!.text, 'a\nb');
    expect(runtime.named('textInput.edit').last['text'], 'a\nb');
    expect(runtime.named('textInput.submit'), isEmpty);
    expect(find.byKey(const ValueKey<String>('pocket-text-input-ml')),
        findsOneWidget);
  });

  testWidgets('single-line done action still submits', (tester) async {
    final runtime = await _mount(tester, <String, dynamic>{
      'keyboardType': 'text',
      'action': 'done',
      'maxLines': 1,
    });
    await tester.showKeyboard(find.byType(TextField));
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(runtime.named('textInput.submit'), hasLength(1));
  });
}
