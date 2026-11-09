import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_audio/pocket_audio.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Voiced dialogue emits real tokenized completion facts', (
    tester,
  ) async {
    final completed = Completer<Map<String, Object?>>();
    final facts = <Map<String, Object?>>[];
    final plugin = PocketAudioPlugin(
      assetPrefix: 'assets/apps/lantern/',
      onPlayback: (fact) {
        facts.add(fact);
        if (fact['status'] == 'completed' && !completed.isCompleted) {
          completed.complete(fact);
        }
      },
    );
    try {
      await plugin.play({
        'channel': '__pocket_vn_voice',
        'asset': 'audio/voice_mira_arrival_02.wav',
        'playbackId': 'original-mira-line',
        'loop': false,
        'volume': 0.3,
        'paused': false,
      });
      final terminal = await tester.runAsync(
        () => completed.future.timeout(const Duration(seconds: 30)),
      );
      expect(facts.any((fact) => fact['status'] == 'playing'), isTrue);
      expect(
        facts.every((fact) => fact['playbackId'] == 'original-mira-line'),
        isTrue,
      );
      expect(terminal!['channel'], '__pocket_vn_voice');
      expect(terminal['durationMs'] as int, greaterThan(13000));
      expect(terminal['positionMs'] as int, greaterThan(13000));
      debugPrint(
        'novel-voice: real completion ${terminal['positionMs']} / ${terminal['durationMs']}ms',
      );
    } finally {
      await plugin.dispose();
    }
  });

  testWidgets(
    'Pocket audio plays a bundled WAV and reports real transport state',
    (tester) async {
      final plugin = PocketAudioPlugin(
        assets: const <String, String>{
          'audio/music_storm.wav': 'assets/apps/lantern/audio/music_storm.wav',
        },
      );

      Future<void> wait(Duration duration) async {
        await tester.runAsync(() => Future<void>.delayed(duration));
      }

      Map<String, dynamic> facts(Object? value) =>
          Map<String, dynamic>.from(value! as Map);

      try {
        final accepted = facts(
          await plugin
              .play(<String, dynamic>{
                'channel': 'music',
                'asset': 'audio/music_storm.wav',
                'loop': true,
                'volume': 0.25,
                'paused': false,
              })
              .timeout(const Duration(seconds: 10)),
        );
        expect(accepted['accepted'], isTrue);
        expect(accepted['playerPresent'], isTrue);

        await wait(const Duration(milliseconds: 700));
        final playing = facts(
          await plugin.setVolume(<String, dynamic>{
            'channel': 'music',
            'volume': 0.25,
          }),
        );
        expect(playing['playing'], isTrue);
        expect(playing['processingState'], 'ready');
        final beforePause = playing['positionMs'] as int;
        expect(beforePause, greaterThan(250));

        final paused = facts(
          await plugin.pause(<String, dynamic>{'channel': 'music'}),
        );
        expect(paused['playing'], isFalse);
        final pausedAt = paused['positionMs'] as int;
        await wait(const Duration(milliseconds: 400));
        final stillPaused = facts(
          await plugin.setVolume(<String, dynamic>{
            'channel': 'music',
            'volume': 0.2,
          }),
        );
        expect(stillPaused['playing'], isFalse);
        expect((stillPaused['positionMs'] as int) - pausedAt, lessThan(180));

        await plugin.resume(<String, dynamic>{'channel': 'music'});
        await wait(const Duration(milliseconds: 500));
        final resumed = facts(
          await plugin.pause(<String, dynamic>{'channel': 'music'}),
        );
        expect(resumed['playing'], isFalse);
        expect((resumed['positionMs'] as int) - pausedAt, greaterThan(250));

        final stopped = facts(
          await plugin.stop(<String, dynamic>{'channel': 'music'}),
        );
        expect(stopped['playerPresent'], isFalse);
        expect(stopped['playing'], isFalse);
        expect(stopped['processingState'], 'idle');

        await plugin.play(<String, dynamic>{
          'channel': 'music',
          'asset': 'audio/music_storm.wav',
          'loop': true,
          'volume': 0.25,
          'paused': false,
        });
        expect(plugin.activeChannelCount, 1);
        await plugin.dispose();
        expect(plugin.activeChannelCount, 0);
      } finally {
        await plugin.dispose();
      }
    },
  );
}
