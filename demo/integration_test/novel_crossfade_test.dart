import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

Future<void> _frame(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 20));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 5)),
  );
}

Map<String, Object?> _snapshot(PocketAudioPlugin audio, String channel) =>
    Map<String, Object?>.from(audio.snapshotChannel(channel));

Future<Map<String, Object?>> _waitReady(
  WidgetTester tester,
  PocketAudioPlugin audio,
  String channel,
  String asset, {
  Duration timeout = const Duration(seconds: 12),
}) async {
  final elapsed = Stopwatch()..start();
  Map<String, Object?> fact = _snapshot(audio, channel);
  while (elapsed.elapsed < timeout) {
    await _frame(tester);
    fact = _snapshot(audio, channel);
    if (fact['asset'] == asset &&
        (fact['durationMs'] as num? ?? 0) > 0 &&
        fact['playerPresent'] == true &&
        fact['processingState'] == 'ready' &&
        fact['playing'] == true &&
        (fact['positionMs'] as num? ?? 0) > 0) {
      return fact;
    }
  }
  fail('real audio channel $channel did not decode and progress: $fact');
}

Future<void> _setAudioLevel(
  WidgetTester tester,
  String prefix,
  String target,
) async {
  for (var attempt = 0; attempt < 6; attempt++) {
    final label = guest
        .texts(tester)
        .firstWhere((text) => text.startsWith(prefix), orElse: () => '');
    if (label == target) return;
    expect(label, isNotEmpty, reason: 'actual Lantern settings expose $prefix');
    await guest.tapGuest(tester, label, scroll: false);
  }
  expect(guest.texts(tester), contains(target));
}

Future<String> _savePng(
  WidgetTester tester,
  GlobalKey captureKey,
  Directory directory,
  String name,
) async {
  final boundary =
      captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(() => boundary.toImage());
  final data = await tester.runAsync(
    () => image!.toByteData(format: ui.ImageByteFormat.png),
  );
  final bytes = data!.buffer.asUint8List(
    data.offsetInBytes,
    data.lengthInBytes,
  );
  final path = '${directory.path}/$name.png';
  await tester.runAsync(() => File(path).writeAsBytes(bytes));
  image!.dispose();
  expect(File(path).existsSync(), isTrue);
  expect(File(path).lengthSync(), greaterThan(1000));
  expect(bytes.take(8).toList(), [137, 80, 78, 71, 13, 10, 26, 10]);
  return base64Encode(bytes);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.reportData = {
    'pocketAcceptance': {
      'required': [
        'novel-crossfade-gallery-entry',
        'novel-crossfade-two-decoded-scores',
        'novel-crossfade-inverse-music-gains',
        'novel-crossfade-music-not-effects-control',
        'novel-crossfade-player-release',
        'novel-crossfade-main-music-resumed',
        'novel-crossfade-normal-store-preserved',
        'novel-crossfade-real-png-captured',
      ],
      'completed': <String>[],
    },
  };

  testWidgets(
    'Lantern gallery score handoff decodes and crossfades two music players, releases them, resumes main BGM and captures a real PNG',
    (tester) async {
      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final beforeStore = await tester.runAsync(
        () async =>
            await normalStore.exists() ? normalStore.readAsBytes() : null,
      );
      final support = IsolatedNovelSupportDirectory();
      await support.install();
      final evidence = await Directory.systemTemp.createTemp(
        'pocket-crossfade-evidence-',
      );
      final captureKey = GlobalKey();
      final systemController = PocketSystemHostController();
      PocketAudioPlugin? audio;
      final readyFacts = <String, Map<String, Object?>>{};
      final gainTrace = <Map<String, Object?>>[];
      final overlap = <Map<String, Object?>>[];
      String? pngBase64;
      String? pngPath;
      final completed =
          (binding.reportData!['pocketAcceptance']
                  as Map<String, dynamic>)['completed']
              as List<String>;

      Future<void> captureOverlap() async {
        if (pngBase64 != null) return;
        pngBase64 = await _savePng(
          tester,
          captureKey,
          evidence,
          'score-handoff-overlap',
        );
        pngPath = '${evidence.path}/score-handoff-overlap.png';
      }

      try {
        await tester.pumpWidget(
          RepaintBoundary(
            key: captureKey,
            child: pocketHostApp(
              systemController: systemController,
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
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');

        // Set different music and effects gains through the real JS-owned
        // settings controls. The two timeline scores must follow music while
        // the bell stays under effects.
        await guest.tapGuest(tester, '阅读偏好');
        await guest.waitForContaining(tester, '总音量 · ');
        await _setAudioLevel(tester, '音乐 · ', '音乐 · 75%');
        await _setAudioLevel(tester, '音效 · ', '音效 · 25%');
        await guest.tapGuest(tester, '返回', scroll: false);
        await guest.waitFor(tester, '启程 · 开始新的故事');

        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        final mainBefore = await _waitReady(
          tester,
          audio!,
          'music',
          'audio/music_storm.wav',
        );
        readyFacts['main'] = mainBefore;

        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '雾港纪念');
        await guest.tapGuest(tester, '雾港纪念', scroll: false);
        const replayAction = '回看 · 风暴交给晨光';
        await guest.reveal(tester, replayAction);
        await guest.tapGuest(tester, replayAction, scroll: false);
        completed.add('novel-crossfade-gallery-entry');
        await guest.waitForContaining(tester, '雾退到海峡另一边');
        await _advance(tester);
        await guest.waitForContaining(tester, '我总写');
        await _advance(tester);

        final storm = await _waitReady(
          tester,
          audio!,
          'replay-score-storm',
          'audio/music_storm.wav',
        );
        readyFacts['storm'] = storm;
        final beforeReplay = _snapshot(audio!, 'music');
        expect(beforeReplay['playerPresent'], isTrue);
        expect(beforeReplay['playing'], isFalse);
        expect(beforeReplay['asset'], 'audio/music_storm.wav');

        final stopwatch = Stopwatch()..start();
        var sawStormRelease = false;
        var sawDawnRelease = false;
        var dawnReady = false;
        var effectReady = false;
        var positiveStormPosition = false;
        var positiveDawnPosition = false;
        var stormPeak = 0.0;
        var dawnPeak = 0.0;
        var effectVolume = -1.0;
        while (stopwatch.elapsed < const Duration(seconds: 24)) {
          await _frame(tester);
          final stormFact = _snapshot(audio!, 'replay-score-storm');
          final dawnFact = _snapshot(audio!, 'replay-score-dawn');
          final stormPresent = stormFact['playerPresent'] == true;
          final dawnPresent = dawnFact['playerPresent'] == true;
          final dawnDecoded =
              dawnPresent &&
              dawnFact['asset'] == 'audio/music_dawn.wav' &&
              dawnFact['processingState'] == 'ready' &&
              (dawnFact['durationMs'] as num? ?? 0) > 0;
          if (stormPresent) {
            expect(stormFact['asset'], 'audio/music_storm.wav');
            expect(stormFact['processingState'], 'ready');
            expect(stormFact['durationMs'] as num, greaterThan(0));
            expect(stormFact['playing'], isTrue);
            final volume = (stormFact['volume'] as num).toDouble();
            expect(volume, inInclusiveRange(0.0, 0.54));
            stormPeak = math.max(stormPeak, volume);
            positiveStormPosition |= (stormFact['positionMs'] as num? ?? 0) > 0;
          } else if (readyFacts.containsKey('storm')) {
            sawStormRelease = true;
            expect(stormFact['playing'], isFalse);
          }
          if (dawnDecoded) {
            expect(dawnFact['asset'], 'audio/music_dawn.wav');
            expect(dawnFact['processingState'], 'ready');
            expect(dawnFact['durationMs'] as num, greaterThan(0));
            expect(dawnFact['playing'], isTrue);
            final volume = (dawnFact['volume'] as num).toDouble();
            expect(volume, inInclusiveRange(0.0, 0.54));
            dawnPeak = math.max(dawnPeak, volume);
            positiveDawnPosition |= (dawnFact['positionMs'] as num? ?? 0) > 0;
            if (!dawnReady) {
              dawnReady = true;
              readyFacts['dawn'] = Map<String, Object?>.from(dawnFact);
            }
          } else if (dawnReady && !dawnPresent) {
            sawDawnRelease = true;
            expect(dawnFact['playing'], isFalse);
          }

          final bells = List.generate(
            4,
            (index) => _snapshot(audio!, 'effect-$index'),
          ).where((fact) => fact['asset'] == 'audio/station_bell.wav').toList();
          final bell = bells.isEmpty ? null : bells.first;
          if (bell != null &&
              bell['playerPresent'] == true &&
              bell['processingState'] == 'ready' &&
              (bell['durationMs'] as num? ?? 0) > 0) {
            effectVolume = (bell['volume'] as num).toDouble();
            effectReady = true;
          }

          if (stormPresent && dawnDecoded) {
            final point = {
              'elapsedMs': stopwatch.elapsedMilliseconds,
              'stormVolume': stormFact['volume'],
              'dawnVolume': dawnFact['volume'],
              'stormPositionMs': stormFact['positionMs'],
              'dawnPositionMs': dawnFact['positionMs'],
            };
            gainTrace.add(point);
            if ((stormFact['volume'] as num) > 0.1 &&
                (dawnFact['volume'] as num) > 0.1) {
              overlap.add(point);
              await captureOverlap();
            }
          }

          if (sawStormRelease && sawDawnRelease) break;
          await tester.pump(const Duration(milliseconds: 1));
        }

        expect(
          dawnReady,
          isTrue,
          reason: 'the actual gallery replay decodes the registered dawn WAV',
        );
        expect(
          effectReady,
          isTrue,
          reason: 'the replay bell uses the registered effects WAV',
        );
        expect(
          positiveStormPosition,
          isTrue,
          reason: 'the storm player reports positive real playback progress',
        );
        expect(
          positiveDawnPosition,
          isTrue,
          reason: 'the dawn player reports positive real playback progress',
        );
        expect(
          stormPeak,
          closeTo(0.525, 0.1),
          reason: 'custom score channels use the music preference',
        );
        expect(
          dawnPeak,
          closeTo(0.525, 0.1),
          reason: 'the new score uses the music preference as it rises',
        );
        expect(
          effectVolume,
          closeTo(0.175, 0.08),
          reason: 'the bell remains under the effects preference',
        );
        expect(
          overlap.length,
          greaterThan(2),
          reason:
              'both decoded score players are audible together during the crossfade',
        );
        expect(
          (overlap.first['stormVolume'] as num).toDouble(),
          greaterThan((overlap.last['stormVolume'] as num).toDouble()),
          reason: 'storm gain falls across the sampled overlap',
        );
        expect(
          (overlap.first['dawnVolume'] as num).toDouble(),
          lessThan((overlap.last['dawnVolume'] as num).toDouble()),
          reason: 'dawn gain rises across the same sampled overlap',
        );
        expect(
          sawStormRelease,
          isTrue,
          reason: 'the storm native player is released after its fade',
        );
        expect(
          sawDawnRelease,
          isTrue,
          reason: 'the dawn native player is released after its tail fade',
        );
        expect(
          pngBase64,
          isNotNull,
          reason: 'the crossfade overlap produced a screenshot PNG',
        );
        completed.addAll([
          'novel-crossfade-two-decoded-scores',
          'novel-crossfade-inverse-music-gains',
          'novel-crossfade-music-not-effects-control',
          'novel-crossfade-player-release',
          'novel-crossfade-real-png-captured',
        ]);

        await guest.waitForContaining(tester, '最后一笔落下');
        await _advance(tester);
        await guest.waitForContaining(tester, '有些告别很轻');
        await guest.tapGuest(tester, '返回原旅程');
        await guest.waitFor(tester, '雾港纪念');

        final resumeDeadline = Stopwatch()..start();
        Map<String, Object?> mainAfter = _snapshot(audio!, 'music');
        while ((mainAfter['playing'] != true ||
                (mainAfter['positionMs'] as num? ?? 0) <=
                    (beforeReplay['positionMs'] as num? ?? 0) + 150) &&
            resumeDeadline.elapsed < const Duration(seconds: 10)) {
          await _frame(tester);
          mainAfter = _snapshot(audio!, 'music');
        }
        expect(mainAfter['playerPresent'], isTrue);
        expect(mainAfter['playing'], isTrue);
        expect(mainAfter['asset'], 'audio/music_storm.wav');
        expect(
          mainAfter['positionMs'] as num,
          greaterThan((beforeReplay['positionMs'] as num) + 150),
          reason:
              'exiting the actual replay resumes the same parked main BGM player',
        );
        completed.add('novel-crossfade-main-music-resumed');

        binding.reportData!['novelCrossfade'] = {
          'platform': Platform.operatingSystem,
          'groupMix': {'master': 0.7, 'music': 0.75, 'effects': 0.25},
          'readyFacts': readyFacts,
          'gainTrace': gainTrace,
          'overlap': overlap,
          'mainBefore': mainBefore,
          'mainAfter': mainAfter,
          'sawStormRelease': sawStormRelease,
          'sawDawnRelease': sawDawnRelease,
          'pngPath': pngPath,
          'pngBase64': pngBase64,
          'factBoundary':
              'Flutter test pointer input and native PocketAudioPlugin snapshots; playback positions are checked for positive progress and are not required to be monotonic.',
        };
      } finally {
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        final sessions = systemController.instances
            .map((fact) => fact.session)
            .toList();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future.wait(sessions.map((session) => session.close())),
        );
        expect(audio?.activeChannelCount ?? 0, 0);
        systemController.dispose();
        await support.restore();
        final afterStore = await tester.runAsync(
          () async =>
              await normalStore.exists() ? normalStore.readAsBytes() : null,
        );
        expect(afterStore, equals(beforeStore));
        completed.add('novel-crossfade-normal-store-preserved');
        expect(tester.takeException(), isNull);
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}

Future<void> _advance(WidgetTester tester) async {
  if (!guest.texts(tester).contains('轻触继续  ›')) {
    await guest.tapGuest(tester, '轻触显全');
  }
  await guest.waitFor(tester, '轻触继续  ›');
  await guest.tapGuest(tester, '轻触继续  ›');
}
