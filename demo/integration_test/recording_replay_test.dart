import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real QJBC input, composing and nested apps replay after disposal',
    (tester) async {
      final library = PocketRecordingLibrary();
      tester.testTextInput.register();
      Directory? exported;
      try {
        await tester.pumpWidget(PocketHostApp(recordings: library));
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '+1');
        await guest.waitFor(tester, '01');
        await guest.tapGuest(tester, 'Tap to type');
        for (var attempt = 0; attempt < 160; attempt++) {
          if (find.byType(EditableText).evaluate().isNotEmpty &&
              tester.testTextInput.hasAnyClients) {
            break;
          }
          await tester.pump(const Duration(milliseconds: 30));
        }
        expect(find.byType(EditableText), findsOneWidget);
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: '确定性🙂',
            selection: TextSelection(baseOffset: 1, extentOffset: 3),
            composing: TextRange(start: 1, end: 3),
          ),
        );
        await tester.pump();
        await guest.waitForContaining(tester, 'Draft: 确定性🙂');
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();

        await guest.tapGuest(tester, 'Open profile app');
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.tapGuest(tester, 'Lin Mei (VIP 7)');
        await guest.tapGuest(tester, 'Save identity & open Lobby');
        await guest.waitFor(tester, 'Pocket Lobby');
        await guest.waitFor(tester, 'Lin Mei');
        await guest.tapGuest(tester, 'Increment lobby counter');
        await guest.waitForContaining(tester, 'visits=1');
        await guest.tapGuest(tester, 'Return visits to Showcase');
        await guest.waitForContaining(tester, 'App result:');
        await guest.waitForContaining(tester, 'Draft: 确定性🙂');

        final tapes = library.stop();
        expect(tapes, hasLength(3));
        expect(library.status()['incomplete'], isFalse);
        expect(tapes.values.every((tape) => tape.replayable), isTrue);
        expect(tapes.values.every((tape) => tape.entries.isNotEmpty), isTrue);
        expect(
          tapes.values.first.entries.any(
            (entry) => entry.kind == 'duplexIngressPublish',
          ),
          isTrue,
        );
        expect(
          tapes.values.first.entries.any(
            (entry) =>
                entry.kind == 'send' &&
                entry.args.toString().contains('composing'),
          ),
          isTrue,
        );

        // Tear down actual Sessions/native handles before replay. The offline
        // runner must reconstruct every realm and must not use live providers.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        final clock = Stopwatch()..start();
        final replay = await library.replay();
        debugPrint(
          'Pocket recording replay: ${clock.elapsedMilliseconds}ms $replay',
        );
        expect(replay['ok'], isTrue, reason: replay.toString());
        expect((replay['runtimes'] as Map), hasLength(3));

        final output = await library.export(directory: Directory.systemTemp);
        final manifest = File(output['path'] as String);
        exported = manifest.parent;
        final imported = await PocketRecordingLibrary.replayArchive(manifest);
        expect(imported['ok'], isTrue, reason: imported.toString());
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        if (tester.testTextInput.isRegistered) {
          tester.testTextInput.unregister();
        }
        await exported?.delete(recursive: true);
      }
    },
  );

  testWidgets('JS debug controls stop, verify and export their real guest', (
    tester,
  ) async {
    final library = PocketRecordingLibrary();
    Directory? exported;
    try {
      await tester.pumpWidget(PocketHostApp(recordings: library));
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, 'Open Host details');
      await guest.waitFor(tester, 'Runtime');
      await guest.tapGuest(tester, 'Recording status');
      await guest.waitForContaining(tester, 'Recording · 1 guests');
      await guest.tapGuest(tester, 'Stop & verify replay');
      await guest.waitForContaining(tester, 'Replay matched · 1 native guests');
      await guest.tapGuest(tester, 'Export recording');
      await guest.waitForContaining(tester, 'Exported: ');
      final label = guest
          .texts(tester)
          .firstWhere((text) => text.startsWith('Exported: '));
      final manifest = File(label.substring('Exported: '.length));
      exported = manifest.parent;
      expect(await manifest.exists(), isTrue);
      final imported = await PocketRecordingLibrary.replayArchive(manifest);
      expect(imported['ok'], isTrue, reason: imported.toString());
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await exported?.delete(recursive: true);
    }
  });
}
