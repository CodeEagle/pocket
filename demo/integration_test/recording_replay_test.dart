import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

Map<String, dynamic> _summarizeReplayRuntimes(Object? value) {
  if (value is! Map) return <String, dynamic>{};
  final summary = <String, dynamic>{};
  for (final entry in value.entries) {
    final result = entry.value;
    if (result is! Map) continue;
    final row = <String, dynamic>{
      'matched': result['matched'],
      'replayable': result['replayable'],
      'entriesReplayed': result['entriesReplayed'],
      'framesCompared': result['framesCompared'],
    };
    final mismatch = result['firstMismatch'];
    if (mismatch is Map) {
      row['firstMismatch'] = <String, dynamic>{
        'entryIndex': mismatch['entryIndex'],
        'transaction': mismatch['transaction'],
        'frameIndex': mismatch['frameIndex'],
        'reason': mismatch['reason'],
      };
    }
    summary[entry.key.toString()] = row;
  }
  return summary;
}

String _boundedDiagnostic(Object value) {
  final text = value.toString();
  return text.length <= 512 ? text : '${text.substring(0, 512)}…';
}

void _publishRecordingReport(
  IntegrationTestWidgetsFlutterBinding binding,
  Map<String, dynamic> report,
) {
  binding.reportData ??= <String, dynamic>{};
  binding.reportData!['recordingReplay'] = report;
  final archivePath = report['archivePath'];
  if (archivePath is String) {
    debugPrint('Pocket recording archive: $archivePath');
  }
}

/// The keyboard can leave the persistent Showcase page scrolled below its
/// input card when the nested app returns. The new root safe-area/culling
/// path omits that offscreen text from [guest.texts], so drag toward the top
/// before asserting the restored draft rather than treating culling as lost
/// JS state.
Future<void> _revealReturnedDraft(WidgetTester tester) async {
  const fragment = 'Draft: 确定性🙂';
  for (var attempt = 0; attempt < 8; attempt++) {
    // Draw-op culling can leave the label text present while less than half
    // its height is visible. Keep using the real reverse drag until the
    // shared hit geometry reports a pointable target.
    if (guest.pointFor(tester, fragment) != null) {
      // The real drag may have made the label pointable before kinetic
      // scrolling settled. Reuse the shared geometry sampler without another
      // drag so recording stops only at a stable Draft frame.
      await guest.reveal(tester, fragment, scroll: false);
      return;
    }
    final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
    final gesture = await tester.startGesture(
      box.localToGlobal(Offset(box.size.width * .35, box.size.height * .72)),
    );
    for (var step = 0; step < 8; step++) {
      // A positive dy reduces ScrollablePage's offset and reveals its top.
      await gesture.moveBy(const Offset(0, 30));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
  }
  await guest.waitForContaining(tester, fragment);
  await guest.reveal(tester, fragment, scroll: false);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real QJBC input, composing and nested apps replay after disposal',
    (tester) async {
      final library = PocketRecordingLibrary()..start();
      tester.testTextInput.register();
      Directory? exported;
      var preserveExported = false;
      var captureStopped = false;
      Map<String, dynamic>? replayReport;
      try {
        await tester.pumpWidget(pocketHostApp(recordings: library));
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
        await guest.tapGuest(tester, 'Return visits to caller');
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.waitForContaining(tester, 'Last shared value: Lin Mei');
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.reveal(tester, 'Prewarm lobby');
        await guest.waitForContaining(tester, 'App result:');
        await _revealReturnedDraft(tester);

        final tapes = library.stop();
        captureStopped = true;
        expect(tapes, hasLength(3));
        // These are three real native realms created by the JS system
        // manager. Verify that the trusted per-app budgets survive Session,
        // FFI construction and recording rather than testing JSON alone.
        expect(
          tapes.values.where(
            (tape) =>
                tape.metadata.memoryLimits.heapLimitBytes == 128 * 1024 * 1024,
          ),
          hasLength(2),
        );
        expect(
          tapes.values.where(
            (tape) => tape.metadata.memoryLimits.maxPakBytes == 8 * 1024 * 1024,
          ),
          hasLength(2),
        );
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

        // Export before replay so a failed replay still leaves a complete,
        // content-addressed tape for offline reproduction. The default
        // directory is app Documents, which the device runner can retrieve.
        final output = await library.export();
        final manifest = File(output['path'] as String);
        exported = manifest.parent;
        preserveExported = true;
        replayReport = <String, dynamic>{
          'archivePath': manifest.path,
          'runtimeCount': output['runtimeCount'],
        };
        _publishRecordingReport(binding, replayReport);

        // Tear down actual Sessions/native handles before replay. The offline
        // runner must reconstruct every realm and must not use live providers.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        final clock = Stopwatch()..start();
        final replay = await library.replay();
        debugPrint(
          'Pocket recording replay: ${clock.elapsedMilliseconds}ms $replay',
        );
        replayReport['replayMilliseconds'] = clock.elapsedMilliseconds;
        replayReport['replayOk'] = replay['ok'];
        replayReport['runtimes'] = _summarizeReplayRuntimes(replay['runtimes']);
        expect(replay['ok'], isTrue, reason: replay.toString());
        expect((replay['runtimes'] as Map), hasLength(3));

        final imported = await PocketRecordingLibrary.replayArchive(manifest);
        replayReport['archiveReplayOk'] = imported['ok'];
        expect(imported['ok'], isTrue, reason: imported.toString());
        preserveExported = false;
      } finally {
        if (replayReport == null) {
          final report = <String, dynamic>{
            'phase': 'beforeReplay',
            'archivePreserved': false,
          };
          _publishRecordingReport(binding, report);
          try {
            if (!captureStopped) {
              final tapes = library.stop();
              captureStopped = true;
              report['runtimeCount'] = tapes.length;
            }
            final status = library.status();
            report['incomplete'] = status['incomplete'];
            final output = await library.export();
            final manifest = File(output['path'] as String);
            exported = manifest.parent;
            preserveExported = true;
            report['archivePath'] = manifest.path;
            report['runtimeCount'] = output['runtimeCount'];
          } catch (error) {
            report['archiveExportError'] = _boundedDiagnostic(error);
          }
          report['archivePreserved'] = preserveExported;
          _publishRecordingReport(binding, report);
        } else {
          replayReport['archivePreserved'] = preserveExported;
          _publishRecordingReport(binding, replayReport);
        }
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        if (tester.testTextInput.isRegistered) {
          tester.testTextInput.unregister();
        }
        if (!preserveExported) {
          await exported?.delete(recursive: true);
        }
      }
    },
  );

  testWidgets(
    'JS debug controls start, stop, verify and export their real guest',
    (tester) async {
      final library = PocketRecordingLibrary();
      Directory? exported;
      try {
        await tester.pumpWidget(pocketHostApp(recordings: library));
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, 'Open Host details');
        await guest.waitFor(tester, 'Runtime');
        await guest.tapGuest(tester, 'Recording status');
        await guest.waitForContaining(tester, 'Idle · 0 guests');
        await guest.tapGuest(tester, 'Start recording');
        // Starting remounts the guest generation. Re-reveal the Runtime page
        // before inspecting its status because the mobile shell may reset the
        // page viewport while the recording-start event arrives.
        await guest.tapGuest(tester, 'Recording status');
        await guest.waitForContaining(tester, 'Recording · 1 guests');
        await guest.tapGuest(tester, 'Stop & verify replay');
        await guest.waitForContaining(
          tester,
          'Replay matched · 1 native guests',
        );
        await guest.tapGuest(tester, 'Export recording');
        await guest.waitForContaining(tester, 'Exported: ');
        final exportedText = guest
            .texts(tester)
            .firstWhere(
              (text) =>
                  text.replaceAll(RegExp(r'\s+'), ' ').startsWith('Exported: '),
            );
        final pathStart =
            exportedText.indexOf('Exported: ') + 'Exported: '.length;
        final manifest = File(
          exportedText.substring(pathStart).replaceAll(RegExp(r'\s+'), ''),
        );
        exported = manifest.parent;
        expect(await manifest.exists(), isTrue);
        final imported = await PocketRecordingLibrary.replayArchive(manifest);
        expect(imported['ok'], isTrue, reason: imported.toString());
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        final archive = exported;
        if (archive != null && await archive.exists()) {
          await archive.delete(recursive: true);
        }
      }
    },
  );
}
