import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Lantern decodes bounded synthesized text cues and does not resume one-shots after lifecycle return',
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
        await guest.tapGuest(tester, '阅读偏好', scroll: false);
        await guest.waitForContaining(tester, '文字提示音 ·');
        // Preferences survive actual host restarts. Normalize through the
        // shipped UI rather than assuming this device has a fresh data store.
        if (guest.texts(tester).contains('文字提示音 · 开启')) {
          await guest.tapGuest(tester, '文字提示音 · 开启', scroll: false);
        }
        await guest.waitFor(tester, '文字提示音 · 关闭');
        for (final group in ['总音量', '音效']) {
          for (var attempt = 0; attempt < 6; attempt++) {
            final label = guest
                .texts(tester)
                .firstWhere((text) => text.startsWith('$group · '));
            if (label == '$group · 100%') break;
            await guest.tapGuest(tester, label, scroll: false);
            await tester.pump(const Duration(milliseconds: 50));
          }
          await guest.waitFor(tester, '$group · 100%');
        }
        await guest.tapGuest(tester, '文字提示音 · 关闭', scroll: false);
        await guest.waitFor(tester, '文字提示音 · 开启');
        await guest.tapGuest(tester, '返回', scroll: false);
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        // A channel is allocated before just_audio finishes loading its asset.
        // Wait for the native decode fact rather than treating allocation or a
        // fixed frame delay as proof that the short WAV was decoded.
        final decodeDeadline = Stopwatch()..start();
        Map<String, Object?> narrator;
        do {
          await tester.pump(const Duration(milliseconds: 30));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 30)),
          );
          narrator = audio!.snapshotChannel('effect-0');
        } while ((narrator['asset'] != 'audio/text_narrator.wav' ||
                narrator['durationMs'] == null) &&
            narrator['error'] == null &&
            decodeDeadline.elapsed < const Duration(seconds: 10));
        debugPrint('novel-text-sounds: decoded native facts $narrator');
        expect(narrator['accepted'], isTrue);
        expect(narrator['playerPresent'], isTrue);
        expect(narrator['asset'], 'audio/text_narrator.wav');
        expect(narrator['durationMs'], lessThan(100));
        expect(narrator['volume'], 1.0);
        // Reusing a decoded player must actually rewind the short sample. A
        // completed just_audio player remains `playing: true` at the end, so
        // that flag alone cannot prove subsequent glyph cues are audible.
        final replayDeadline = Stopwatch()..start();
        var completed = narrator['processingState'] == 'completed';
        var rewound = false;
        while (!rewound &&
            replayDeadline.elapsed < const Duration(seconds: 3)) {
          await tester.pump(const Duration(milliseconds: 10));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          final facts = audio!.snapshotChannel('effect-0');
          if (completed &&
              facts['asset'] == 'audio/text_narrator.wav' &&
              facts['processingState'] == 'ready' &&
              (facts['positionMs'] as int) > 0 &&
              (facts['positionMs'] as int) < (facts['durationMs'] as int)) {
            rewound = true;
            debugPrint(
              'novel-text-sounds: reused native player rewound $facts',
            );
          }
          if (facts['processingState'] == 'completed') completed = true;
        }
        expect(
          rewound,
          isTrue,
          reason:
              'Repeated glyphs must replay the decoded sample, rather than silently calling play at its end',
        );
        expect(
          audio!.activeChannelCount,
          inInclusiveRange(2, 5),
          reason:
              'Music plus the four reusable glyph channels must stay below the native eight-player limit',
        );
        for (final channel in [
          'effect-0',
          'effect-1',
          'effect-2',
          'effect-3',
        ]) {
          final facts = Map<String, Object?>.from(
            audio!.snapshotChannel(channel),
          );
          if (facts['playerPresent'] == true) {
            expect(facts['asset'], 'audio/text_narrator.wav');
            expect(facts['volume'], 1.0);
          }
        }

        // The journal pauses the JS engine. Leave glyph cues disabled while
        // exercising the same lifecycle callback used by a real app switch.
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '旅途手札');
        await guest.tapGuest(tester, '阅读偏好', scroll: false);
        await guest.waitFor(tester, '文字提示音 · 开启');
        await guest.tapGuest(tester, '文字提示音 · 开启', scroll: false);
        await guest.waitFor(tester, '文字提示音 · 关闭');

        final activeView = guest.activePocketViewFinder();
        final controller = tester.widget<PocketView>(activeView).controller!;
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 150)),
        );
        expect(audio!.isActive, isFalse);
        for (final channel in [
          'effect-0',
          'effect-1',
          'effect-2',
          'effect-3',
        ]) {
          expect(audio!.snapshotChannel(channel)['playing'], isFalse);
        }

        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        final activation = Stopwatch()..start();
        while (!controller.appActive &&
            activation.elapsed < const Duration(seconds: 10)) {
          await tester.pump(const Duration(milliseconds: 30));
        }
        expect(controller.appActive, isTrue);
        expect(audio!.isActive, isTrue);
        for (final channel in [
          'effect-0',
          'effect-1',
          'effect-2',
          'effect-3',
        ]) {
          expect(
            audio!.snapshotChannel(channel)['playing'],
            isFalse,
            reason:
                'completed transient glyph sounds are not replayed after the host returns',
          );
        }
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
