import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('guest TextField uses the Flutter system text client', (
    tester,
  ) async {
    // IntegrationTestWidgetsFlutterBinding deliberately does not install the
    // widget-test text-input stub. Install it explicitly so enterText and
    // updateEditingValue exercise the real Flutter TextInputClient while the
    // device-level keyboard remains covered by the separate screenshot run.
    tester.testTextInput.register();
    try {
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitFor(tester, '00');
      await guest.waitForContaining(tester, 'Tap to type');
      await guest.tapGuest(tester, 'Tap to type');
      await _waitForTextClient(tester);

      expect(find.byType(TextField), findsOneWidget);
      expect(find.byType(EditableText), findsOneWidget);
      expect(tester.testTextInput.hasAnyClients, isTrue);
      expect(tester.testTextInput.isVisible, isTrue);
      expect(
        tester.testTextInput.log.any(
          (call) => call.method == 'TextInput.setClient',
        ),
        isTrue,
      );

      // Drive the same Flutter text client used by a platform IME. This is not
      // a demo.setText bridge call: the values go through TextInputClient and
      // the real guest textInput.edit protocol.
      tester.testTextInput.enterText('你好🙂');
      await tester.pump();
      await guest.waitForContaining(tester, 'Draft: 你好🙂');

      final composingValue = TextEditingValue(
        text: '你好🙂世界',
        selection: const TextSelection(baseOffset: 2, extentOffset: 4),
        composing: const TextRange(start: 2, end: 4),
      );
      tester.testTextInput.updateEditingValue(composingValue);
      await tester.pump();
      await guest.waitForContaining(tester, 'Draft: 你好🙂世界');
      final composingEditor = tester.widget<EditableText>(
        find.byType(EditableText),
      );
      expect(
        composingEditor.controller.value.selection,
        composingValue.selection,
      );
      expect(
        composingEditor.controller.value.composing,
        composingValue.composing,
      );

      // Delete the final CJK character while retaining the emoji's UTF-16
      // surrogate pair and place the caret at the resulting text end.
      const deletedValue = TextEditingValue(
        text: '你好🙂世',
        selection: TextSelection.collapsed(offset: 5),
        composing: TextRange.empty,
      );
      tester.testTextInput.updateEditingValue(deletedValue);
      await tester.pump();
      await guest.waitForContaining(tester, 'Draft: 你好🙂世');
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).controller.text,
        '你好🙂世',
      );

      // Navigate away while the editor is focused. Route teardown must close
      // the platform connection, and returning Home must retain the JS signal
      // value.
      await guest.tapGuest(tester, 'Gallery');
      await guest.waitFor(tester, 'Official building blocks');
      await _waitForClosedTextClient(tester);
      await guest.tapGuest(tester, 'Home');
      await guest.waitForContaining(tester, 'Draft: 你好🙂世');

      // Reopen the field with its retained value. The done action must travel
      // through TextInputClient.performAction and close the Flutter editor
      // while leaving that JS-owned draft unchanged.
      await guest.tapGuest(tester, '你好🙂世');
      await _waitForTextClient(tester);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      await _waitForClosedTextClient(tester);
      expect(guest.texts(tester), contains('Draft: 你好🙂世'));

      // The integration test intentionally does not claim that a physical or
      // software keyboard key was pressed; platform-device screenshots cover
      // that OS-level behavior separately.
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      if (tester.testTextInput.isRegistered) {
        tester.testTextInput.unregister();
      }
    }
  });
}

Future<void> _waitForTextClient(WidgetTester tester) async {
  for (var index = 0; index < 160; index++) {
    if (find.byType(EditableText).evaluate().isNotEmpty &&
        tester.testTextInput.hasAnyClients &&
        tester.testTextInput.isVisible) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Flutter text client did not open: editable=${find.byType(EditableText).evaluate().length}, '
    'clients=${tester.testTextInput.hasAnyClients}, visible=${tester.testTextInput.isVisible}',
  );
}

Future<void> _waitForClosedTextClient(WidgetTester tester) async {
  for (var index = 0; index < 160; index++) {
    if (find.byType(EditableText).evaluate().isEmpty &&
        !tester.testTextInput.hasAnyClients) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Flutter text client did not close: editable=${find.byType(EditableText).evaluate().length}, '
    'clients=${tester.testTextInput.hasAnyClients}',
  );
}
