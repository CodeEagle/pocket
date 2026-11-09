import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'a complete Lantern route fits native storage and restores all rollback checkpoints',
    (tester) async {
      final support = await getApplicationSupportDirectory();
      final file = File(
        '${support.path}/pocket-platform-data/pocket_platform_data.json',
      );
      var largestBytes = 0;
      Map<String, dynamic>? latest;
      Future<Map<String, dynamic>?> observe() async {
        final save = await tester.runAsync(() async {
          try {
            final all = jsonDecode(await file.readAsString()) as Map;
            final app = (all['private'] as Map)['pocket.demo.lantern'] as Map;
            final value = app['lantern.slot.auto'];
            return value is Map ? Map<String, dynamic>.from(value) : null;
          } on Object {
            return null;
          }
        });
        if (save != null) {
          final bytes = utf8.encode(jsonEncode(save)).length;
          if (bytes > largestBytes) largestBytes = bytes;
          expect(
            bytes,
            lessThanOrEqualTo(65536),
            reason:
                'every observed actual save must fit the native per-value quota',
          );
          latest = save;
        }
        return save;
      }

      Future<void> frame() async {
        await tester.pump(const Duration(milliseconds: 30));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
      }

      Future<Map<String, dynamic>> reach(String kind, String id) async {
        for (var attempt = 0; attempt < 800; attempt++) {
          final save = await observe();
          final active = save?['state']?['active'];
          if (active is Map && active['kind'] == kind && active['id'] == id) {
            return Map<String, dynamic>.from(active);
          }
          if (active is Map && active['kind'] == 'choice') {
            fail(
              'Expected $kind/$id, but the actual disk save reached choice ${active['id']}',
            );
          }
          if (active is Map && active['kind'] == 'ending') {
            fail(
              'Expected $kind/$id, but the actual disk save reached ending ${active['id']}',
            );
          }
          final point =
              guest.pointFor(tester, '轻触继续  ›') ??
              guest.pointFor(tester, '轻触显全');
          if (point != null) {
            final pointer = await tester.startGesture(point);
            await tester.pump(const Duration(milliseconds: 30));
            await pointer.up();
          }
          await frame();
        }
        fail(
          'The real guest did not reach $kind/$id; last disk state=${latest?['state']?['active']}; painted=${guest.texts(tester)}',
        );
      }

      String normalized(String text) => text.replaceAll(RegExp(r'\s+'), '');
      Future<void> choose(String choiceId, String optionIdOrTarget) async {
        final active = await reach('choice', choiceId);
        final options = (active['options'] as List).cast<Map>();
        final option = options.firstWhere(
          (option) =>
              option['id'] == optionIdOrTarget ||
              option['target'] == optionIdOrTarget,
        );
        final expected = normalized(option['text'] as String);
        for (var attempt = 0; attempt < 100; attempt++) {
          final candidates =
              guest.texts(tester).where((label) {
                final candidate = normalized(label);
                return candidate.length >= 2 && expected.startsWith(candidate);
              }).toList()..sort(
                (a, b) => normalized(b).length.compareTo(normalized(a).length),
              );
          if (candidates.isNotEmpty) {
            await guest.tapGuest(tester, candidates.first);
            // Observe the committed next instruction before another route step.
            for (var flush = 0; flush < 100; flush++) {
              await frame();
              final next = await observe();
              if (next?['state']?['active']?['id'] != choiceId) return;
            }
            fail('Choice $choiceId did not commit to the native file');
          }
          await frame();
        }
        fail('Choice text was not painted: ${option['text']}');
      }

      try {
        await tester.pumpWidget(pocketHostApp());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        for (var attempt = 0; attempt < 100; attempt++) {
          final save = await observe();
          if (save?['formatVersion'] == 3 &&
              save?['state']?['active']?['id'] == 'arrival_01') {
            break;
          }
          await frame();
        }
        expect(latest?['formatVersion'], 3);
        expect(latest?['state']?['active']?['id'], 'arrival_01');
        // Stable authored IDs select the same true-ending route as the native
        // QJBC regression. IDs/options are observed in the actual OS autosave;
        // all decisions are delivered as painted pointer input.
        for (final step in <(String, String)>[
          ('arrival_approach', 'listen_mira'),
          ('memory_response', 'trust_mira'),
          // Revisit the authored conversation through its actual call/return
          // route, filling the configured 48-entry rollback window.
          ('investigation_hub', 'hub_memory'),
          ('memory_repeat_response', 'affirm_mira'),
          ('investigation_hub', 'hub_memory'),
          ('memory_repeat_response', 'affirm_mira'),
          ('investigation_hub', 'hub_memory'),
          ('memory_repeat_response', 'affirm_mira'),
          ('investigation_hub', 'archive_entry'),
          ('archive_read', 'archive_route'),
          ('investigation_hub', 'clock_entry'),
          ('clock_test', 'clock_single'),
          ('investigation_hub', 'roof_entry'),
          ('roof_inspection', 'roof_log'),
          ('investigation_hub', 'relay_entry'),
          ('relay_open', 'open_dial'),
          ('dial_one', 'route_7'),
          ('dial_two', 'pulse_1'),
          ('dial_three', 'minute_4'),
          ('memory_repeat_response', 'affirm_mira'),
          ('signal_window', 'send_truth'),
        ]) {
          await choose(step.$1, step.$2);
        }
        await reach('ending', 'truth_letter');
        final saved = latest!;
        expect(saved['formatVersion'], 3);
        final state = saved['state'] as Map;
        final history = state['rollbackHistory'] as Map;
        final entries = history['entries'] as List;
        final backlog = state['backlog'] as List;
        expect(entries.length, backlog.length < 48 ? backlog.length : 48);
        expect(entries.length, 48);
        expect(state['meta']['endingIds'], contains('truth_letter'));
        expect(state['variables']['found_route'], isTrue);
        expect(state['variables']['found_clock'], isTrue);
        expect(state['variables']['found_lens'], isTrue);

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pumpWidget(pocketHostApp());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '续写 · 继续旅程');
        await guest.tapGuest(tester, '续写 · 继续旅程', scroll: false);
        await guest.waitForContaining(tester, '灯亮过，信也抵达了。');
        await guest.waitFor(tester, '回溯');
        await guest.tapGuest(tester, '回溯', scroll: false);
        for (var attempt = 0; attempt < 100; attempt++) {
          await frame();
          final restored = await observe();
          if (restored?['state']?['active']?['kind'] == 'say') break;
        }
        expect(latest!['state']['active']['kind'], 'say');
        expect(
          latest!['state']['meta']['endingIds'],
          contains('truth_letter'),
          reason: 'rollback after V3 restore must retain persistent unlocks',
        );
        expect(
          (latest!['state']['rollbackHistory']['entries'] as List).length,
          entries.length - 1,
        );
        debugPrint(
          'novel-save-capacity: actual complete route largest=$largestBytes bytes, '
          '${entries.length} rollback checkpoints; new host restored V3 and rolled back through pointer input',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
