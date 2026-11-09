import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;

import 'guest_interaction_test.dart' as guest;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Lantern audio settings change real music gain without restarting playback',
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
        await guest.waitForContaining(tester, '23点08分');
        await tester.pump(const Duration(milliseconds: 700));

        Map<String, dynamic> musicFacts() =>
            Map<String, dynamic>.from(audio!.snapshotChannel('music'));

        final before = musicFacts();
        expect(before['accepted'], isTrue);
        expect(before['playerPresent'], isTrue);
        expect(before['playing'], isTrue);
        final beforePosition = before['positionMs'] as int;

        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '阅读偏好');
        await guest.tapGuest(tester, '阅读偏好', scroll: false);
        await guest.waitForContaining(tester, '总音量 · ');
        // This is the actual persisted app store, which may contain the gain
        // left by another integration run. Establish the next step via UI.
        for (var attempt = 0; attempt < 6; attempt++) {
          final label = guest
              .texts(tester)
              .firstWhere((text) => text.startsWith('总音量 · '));
          if (label == '总音量 · 50%') break;
          await guest.tapGuest(tester, label, scroll: false);
          await tester.pump(const Duration(milliseconds: 50));
        }
        await guest.waitFor(tester, '总音量 · 50%');
        await guest.tapGuest(tester, '总音量 · 50%', scroll: false);
        await guest.waitFor(tester, '总音量 · 75%');
        await tester.pump(const Duration(milliseconds: 500));

        final after = musicFacts();
        expect(after['playing'], isTrue);
        expect(after['volume'], 0.75);
        expect(
          after['positionMs'] as int,
          greaterThan(beforePosition + 250),
          reason:
              'A real music player should keep advancing when JS applies a gain change',
        );
        expect(audio!.activeChannelCount, 1);
        debugPrint(
          'novel-audio-mix: real ${defaultTargetPlatform.name} music gain=${after['volume']} '
          'position=${after['positionMs']}ms; same channel remained playing',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
