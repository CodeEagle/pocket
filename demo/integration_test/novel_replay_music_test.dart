import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show debugPrint, defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

final _isolatedSupport = IsolatedNovelSupportDirectory();
late String _normalAppSupportPath;

Future<void> _expectIsolatedSupportPath() async {
  final support = await getApplicationSupportDirectory();
  expect(support.path, _isolatedSupport.path);
  expect(support.path, isNot(_normalAppSupportPath));
  expect(
    support.path.startsWith(
      '${Directory.systemTemp.path}${Platform.pathSeparator}',
    ),
    isTrue,
    reason: 'The real platform store must use a temporary test directory.',
  );
}

Future<void> _waitForIsolatedAutoSave(WidgetTester tester) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    final found = await tester.runAsync<bool>(() async {
      await _expectIsolatedSupportPath();
      final support = await getApplicationSupportDirectory();
      final file = File(
        '${support.path}/pocket-platform-data/pocket_platform_data.json',
      );
      if (!await file.exists()) return false;
      try {
        final root = jsonDecode(await file.readAsString()) as Map;
        final private = root['private'];
        final app = private is Map ? private['pocket.demo.lantern'] : null;
        return app is Map && app['lantern.slot.auto'] is Map;
      } on Object {
        // The platform store may be between atomic writes as autosave settles.
        return false;
      }
    });
    if (found == true) return;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail('The real auto-save did not appear in the isolated app-support store.');
}

Future<void> _waitForAudioChannelsToRelease(
  WidgetTester tester,
  PocketAudioPlugin audio,
) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (audio.activeChannelCount == 0) return;
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  expect(
    audio.activeChannelCount,
    0,
    reason: 'Unmounting the full host must dispose all actual audio channels.',
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUp(() async {
    _normalAppSupportPath = (await getApplicationSupportDirectory()).path;
    await _isolatedSupport.install();
    await _expectIsolatedSupportPath();
  });
  tearDown(() async => _isolatedSupport.restore());

  testWidgets(
    'Lantern gallery music preview preserves and resumes the real main player',
    (tester) async {
      PocketAudioPlugin? audio;
      try {
        await tester.pumpWidget(
          pocketHostApp(
            nativePolicies: {
              ...showcaseNativePolicies,
              'pocket.demo.lantern':
                  showcaseNativePolicies['pocket.demo.lantern']!.copyWith(
                    pluginFactories: [
                      (controller) {
                        final plugin =
                            createLanternAudioPlugin(controller)
                                as PocketAudioPlugin;
                        audio = plugin;
                        return plugin;
                      },
                    ],
                  ),
            },
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await _waitForIsolatedAutoSave(tester);

        final decodeDeadline = Stopwatch()..start();
        Map<String, Object?> mainBefore;
        do {
          await tester.pump(const Duration(milliseconds: 20));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          mainBefore = audio!.snapshotChannel('music');
        } while ((mainBefore['asset'] != 'audio/music_storm.wav' ||
                mainBefore['durationMs'] == null ||
                mainBefore['positionMs'] == null ||
                (mainBefore['positionMs'] as int) < 250) &&
            decodeDeadline.elapsed < const Duration(seconds: 10));
        expect(mainBefore['playerPresent'], isTrue);
        expect(mainBefore['playing'], isTrue);
        expect(mainBefore['asset'], 'audio/music_storm.wav');
        final menuLabel = guest.texts(tester).contains('手札') ? '手札' : 'Journal';
        await guest.tapGuest(tester, menuLabel, scroll: false);
        var panelLabels = guest.texts(tester);
        for (
          var attempt = 0;
          attempt < 100 &&
              !panelLabels.contains('旅途手札') &&
              !panelLabels.contains('Journey journal');
          attempt++
        ) {
          await tester.pump(const Duration(milliseconds: 30));
          panelLabels = guest.texts(tester);
        }
        final galleryLabel = panelLabels.contains('雾港纪念') ? '雾港纪念' : 'Memories';
        await guest.tapGuest(tester, galleryLabel, scroll: false);
        final previewLabel = menuLabel == '手札'
            ? '试听 · 风暴将至'
            : 'Preview · Before the storm';
        await guest.reveal(tester, previewLabel);
        expect(
          guest.texts(tester),
          contains(previewLabel),
          reason:
              'the actually-heard registered storm cue should be painted after scrolling the gallery',
        );
        final beforePreview = audio!.snapshotChannel('music');
        await guest.tapGuest(tester, previewLabel);
        await tester.pump(const Duration(milliseconds: 30));
        final firstPaused = audio!.snapshotChannel('music');
        expect(firstPaused['playing'], isFalse);
        expect(
          firstPaused['positionMs'] as int,
          greaterThanOrEqualTo(beforePreview['positionMs'] as int),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 500)),
        );

        final mainPaused = audio!.snapshotChannel('music');
        final preview = audio!.snapshotChannel('music-preview');
        expect(mainPaused['playerPresent'], isTrue);
        expect(mainPaused['playing'], isFalse);
        expect(mainPaused['asset'], 'audio/music_storm.wav');
        expect(
          (mainPaused['positionMs'] as int) -
              (firstPaused['positionMs'] as int),
          lessThan(100),
          reason: 'the paused main playhead must stay fixed during preview',
        );
        expect(preview['accepted'], isTrue);
        expect(preview['playerPresent'], isTrue);
        expect(preview['playing'], isTrue);
        expect(preview['asset'], 'audio/music_storm.wav');
        expect(preview['durationMs'], isNotNull);

        final binding = tester.binding;
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        // Background hosts withhold vsync; observe real native players using
        // wall time rather than requesting a frame that cannot be delivered.
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 600)),
        );
        final backgroundPreview = audio!.snapshotChannel('music-preview');
        expect(backgroundPreview['playing'], isFalse);
        expect(audio!.snapshotChannel('music')['playing'], isFalse);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        final resumeDeadline = Stopwatch()..start();
        var foregroundPreview = audio!.snapshotChannel('music-preview');
        while ((foregroundPreview['playing'] != true ||
                (foregroundPreview['positionMs'] as int? ?? 0) <=
                    (backgroundPreview['positionMs'] as int) + 100) &&
            resumeDeadline.elapsed < const Duration(seconds: 10)) {
          await tester.pump(const Duration(milliseconds: 30));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 30)),
          );
          foregroundPreview = audio!.snapshotChannel('music-preview');
        }
        expect(foregroundPreview['playing'], isTrue);
        expect(
          foregroundPreview['positionMs'] as int,
          greaterThan((backgroundPreview['positionMs'] as int) + 100),
        );
        final mainAfterLifecycle = audio!.snapshotChannel('music');
        expect(mainAfterLifecycle['playing'], isFalse);
        expect(
          (mainAfterLifecycle['positionMs'] as int) -
              (mainPaused['positionMs'] as int),
          lessThan(250),
        );

        final stopLabel = guest.texts(tester).contains('停止试听')
            ? '停止试听'
            : 'Stop preview';
        await guest.tapGuest(tester, stopLabel);
        await tester.pump(const Duration(milliseconds: 20));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 500)),
        );
        final mainResumed = audio!.snapshotChannel('music');
        final stoppedPreview = audio!.snapshotChannel('music-preview');
        expect(mainResumed['playerPresent'], isTrue);
        expect(mainResumed['playing'], isTrue);
        expect(mainResumed['asset'], 'audio/music_storm.wav');
        expect(
          mainResumed['positionMs'] as int,
          greaterThan((mainPaused['positionMs'] as int) + 250),
          reason:
              'stopping the overlay must resume the same player from its saved playhead',
        );
        expect(stoppedPreview['playerPresent'], isFalse);
        expect(audio!.activeChannelCount, 1);
        await tester.pumpWidget(const SizedBox.shrink());
        await _waitForAudioChannelsToRelease(tester, audio!);
        debugPrint(
          'novel-replay-music: real ${defaultTargetPlatform.name} main music resumed at '
          '${mainResumed['positionMs']}ms; preview player was released',
        );
      } finally {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
