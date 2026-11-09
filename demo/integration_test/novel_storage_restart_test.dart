import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_test_driver.dart' as novel;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Lantern resumes a disk autosave after disposing the entire host', (
    tester,
  ) async {
    Future<Map<String, dynamic>> readSlot(String slot) async {
      final support = await getApplicationSupportDirectory();
      final file = File(
        '${support.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final data = jsonDecode(await file.readAsString()) as Map;
      final app = (data['private'] as Map)['pocket.demo.lantern'] as Map;
      return Map<String, dynamic>.from(app['lantern.slot.$slot'] as Map);
    }

    Future<Map<String, dynamic>> waitForDiskSlot(
      String slot,
      String line,
    ) async {
      final deadline = Stopwatch()..start();
      while (deadline.elapsed < const Duration(seconds: 10)) {
        final data = await tester.runAsync(() async {
          try {
            return await readSlot(slot);
          } on Object {
            return null;
          }
        });
        if (data?['state']?['active']?['id'] == line) return data!;
        await tester.pump(const Duration(milliseconds: 30));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
      }
      fail('The actual platform file did not persist $slot at $line');
    }

    Future<void> advanceUntil(String fragment) async {
      for (var attempt = 0; attempt < 100; attempt++) {
        if (guest.texts(tester).any((text) => text.contains(fragment))) return;
        final point =
            guest.pointFor(tester, '轻触继续  ›') ?? guest.pointFor(tester, '轻触显全');
        if (point == null) {
          await tester.pump(const Duration(milliseconds: 50));
          continue;
        }
        final pointer = await tester.startGesture(point);
        await tester.pump(const Duration(milliseconds: 30));
        await pointer.up();
        await tester.pump(const Duration(milliseconds: 60));
      }
      fail('Story did not reach $fragment: ${guest.texts(tester)}');
    }

    try {
      await tester.pumpWidget(pocketHostApp());
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
      await guest.waitFor(tester, '启程 · 开始新的故事');
      await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
      await advanceUntil('问 Ren：旧中继为什么停在二十年前？');
      await guest.tapGuest(tester, '问 Ren：旧中继为什么停在二十年前？', scroll: false);
      await advanceUntil('我不想再让别人替我承担一次错误');
      final before = await waitForDiskSlot('auto', 'arrival_ren_02');
      expect(before['state']['variables']['ren_trust'], 1);
      expect(before['state']['stage']['background'], 'station');

      // Remove the System host, its native VM and its in-memory storage object.
      // No save or engine state is injected into the next host instance.
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
      await guest.waitForContaining(tester, '我不想再让别人替我承担一次错误');

      // Save from the restored JS engine through the real UI and compare the
      // native file. This verifies restored variables/stage as well as text.
      await guest.tapGuest(tester, '手札', scroll: false);
      await guest.waitFor(tester, '旅途手札');
      await guest.tapGuest(tester, '封存此刻', scroll: false);
      await novel.saveNovelSlot(tester, '2');
      final restored = await waitForDiskSlot('2', 'arrival_ren_02');
      expect(restored['state']['variables'], before['state']['variables']);
      expect(restored['state']['stage'], before['state']['stage']);
      expect(restored['state']['location'], before['state']['location']);
      debugPrint(
        'novel-storage-restart: actual disk save restored Ren trust=1, '
        'location and station stage through a new System host',
      );
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  }, timeout: const Timeout(Duration(minutes: 3)));
}
