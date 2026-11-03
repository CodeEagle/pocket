import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:io';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'frame_timing_collector.dart';
import 'guest_interaction_test.dart' as guest;

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  values.sort();
  return values[((values.length - 1) * fraction).round()];
}

String _flutterMode() {
  if (kReleaseMode) return 'release';
  if (kProfileMode) return 'profile';
  if (kDebugMode) return 'debug';
  return 'unknown';
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  final traceEnabled = const bool.fromEnvironment('POCKET_PERF_TRACE');
  final widgetTraceEnabled =
      traceEnabled &&
      const bool.fromEnvironment('POCKET_PERF_WIDGET_TRACE') &&
      !kReleaseMode;
  testWidgets('measure cold/warm real software keyboard transitions', (
    tester,
  ) async {
    final host = PocketSystemHostController();
    final recordings = const bool.fromEnvironment('POCKET_PERF_RECORD')
        ? PocketRecordingLibrary()
        : null;
    final results = <Map<String, Object?>>[];
    final timingCollector = FrameTimingCollector();
    final previousBuildProfiling = debugProfileBuildsEnabled;
    final previousLayoutProfiling = debugProfileLayoutsEnabled;
    final previousPaintProfiling = debugProfilePaintsEnabled;
    try {
      await tester.pumpWidget(
        PocketHostApp(systemController: host, recordings: recordings),
      );
      await guest.waitFor(tester, '00');
      await Future<void>.delayed(const Duration(seconds: 1));
      if (widgetTraceEnabled) {
        debugProfileBuildsEnabled = true;
        debugProfileLayoutsEnabled = true;
        debugProfilePaintsEnabled = true;
      }

      Future<void> measure(
        String name,
        String target, {
        bool? keyboard,
        bool includesNavigation = false,
      }) async {
        // Reveal before the measurement so preparatory page scrolling is not
        // confused with the requested transition. The actual tap stays inside.
        final point = await guest.reveal(tester, target);
        // FrameTiming callbacks are batched asynchronously. Drain the prior
        // batch, then assign frames by a projected wall-clock build phase.
        await timingCollector.flushBeforeWindow();
        final nativeMs = <double>[];
        final oldProbe = debugPocketFrameDeltaAtOverride;
        final started = DateTime.now().toUtc();
        final startedWallTimeUs = started.microsecondsSinceEpoch;
        final insetsBefore = tester.view.viewInsets.bottom;
        final operation = Stopwatch()..start();
        debugPocketFrameDeltaAtOverride = (runtime, delta) {
          if (!traceEnabled) {
            final watch = Stopwatch()..start();
            try {
              return oldProbe == null
                  ? pocketFrameDeltaAt(runtime, delta)
                  : oldProbe(runtime, delta);
            } finally {
              nativeMs.add(watch.elapsedMicroseconds / 1000);
            }
          }
          final watch = Stopwatch()..start();
          try {
            return developer.Timeline.timeSync(
              'Pocket.frameDeltaAt',
              () => oldProbe == null
                  ? pocketFrameDeltaAt(runtime, delta)
                  : oldProbe(runtime, delta),
              arguments: <String, Object?>{'scene': name},
            );
          } finally {
            nativeMs.add(watch.elapsedMicroseconds / 1000);
          }
        };
        Future<void> action() async {
          if (traceEnabled) {
            developer.Timeline.instantSync(
              'Pocket.interaction.start',
              arguments: <String, Object?>{'scene': name},
            );
          }
          await tester.tapAt(point);
          // Real wall-clock window: no synthetic 16ms pump or forced ticker.
          await Future<void>.delayed(const Duration(milliseconds: 1400));
        }

        try {
          if (traceEnabled) {
            await binding.traceAction(
              action,
              streams: const ['Dart', 'Compiler', 'GC', 'Embedder'],
              reportKey: 'timeline_$name',
            );
          } else {
            await action();
          }
        } finally {
          operation.stop();
          debugPocketFrameDeltaAtOverride = oldProbe;
        }
        final ended = DateTime.now().toUtc();
        final endedWallTimeUs = ended.microsecondsSinceEpoch;
        await timingCollector.waitForDelayedBatch();
        final timings = timingCollector.timingsInBuildWindow(
          startWallTimeUs: startedWallTimeUs,
          endWallTimeUs: endedWallTimeUs,
        );
        expect(
          timings,
          isNotEmpty,
          reason: '$name must produce at least one sane source frame timing',
        );
        TraceFrameCoverage? traceCoverage;
        if (traceEnabled) {
          traceCoverage = FrameTimingCollector.traceFrameCoverage(
            traceReport: binding.reportData?['timeline_$name'],
            timings: timings,
          );
          expect(
            traceCoverage.slowestFrameCovered,
            isTrue,
            reason:
                '$name trace must cover its slowest FrameTiming.buildStart '
                'in a complete Dart Frame; '
                'completeFrames=${traceCoverage.completeFrameCount}, '
                'buildStartUs=${traceCoverage.slowestBuildStartUs}',
          );
        }
        final build = timings
            .map((f) => f.buildDuration.inMicroseconds / 1000)
            .toList();
        final raster = timings
            .map((f) => f.rasterDuration.inMicroseconds / 1000)
            .toList();
        final stamps =
            timings
                .map((f) => f.timestampInMicroseconds(FramePhase.vsyncStart))
                .toList()
              ..sort();
        final gaps = <double>[
          for (var i = 1; i < stamps.length; i++)
            (stamps[i] - stamps[i - 1]) / 1000,
        ];
        final hz = tester.view.display.refreshRate;
        final budget = hz > 0 ? 1000 / hz : null;
        final history = host.instances
            .firstWhere((i) => i.isSystemUI)
            .session
            .performance
            .snapshot(eventLimit: 240);
        final events = (history['longFrameEvents'] as List)
            .where(
              (e) => DateTime.parse(
                (e as Map)['timestamp'] as String,
              ).isAfter(started),
            )
            .where(
              (e) => DateTime.parse(
                (e as Map)['timestamp'] as String,
              ).isBefore(ended),
            )
            .toList();
        results.add({
          'scene': name,
          'refreshHz': hz > 0 ? hz : null,
          'frameBudgetMs': budget,
          'engineFrames': timings.length,
          'mode': _flutterMode(),
          'traceEnabled': traceEnabled,
          'widgetTraceEnabled': widgetTraceEnabled,
          'traceSlowestFrameCovered': traceCoverage?.slowestFrameCovered,
          'recordingEnabled': recordings != null,
          'actionTarget': target,
          'includesNavigation': includesNavigation,
          'timingWindow': 'buildStartWallTimeProjectedFromRasterFinish',
          'timingWindowStartWallUs': startedWallTimeUs,
          'timingWindowEndWallUs': endedWallTimeUs,
          'rawWallSanity': timings.every(
            FrameTimingCollector.hasSaneRawWallClock,
          ),
          'wallClockMs': operation.elapsedMicroseconds / 1000.0,
          'frameTimings': [
            for (final frame in timings)
              {
                'frameNumber': frame.frameNumber,
                'buildStartUs': frame.timestampInMicroseconds(
                  FramePhase.buildStart,
                ),
                'vsyncUs': frame.timestampInMicroseconds(FramePhase.vsyncStart),
                'buildUs': frame.buildDuration.inMicroseconds,
                'rasterUs': frame.rasterDuration.inMicroseconds,
                'rasterFinishUs': frame.timestampInMicroseconds(
                  FramePhase.rasterFinish,
                ),
                'rasterFinishWallUs': frame.timestampInMicroseconds(
                  FramePhase.rasterFinishWallTime,
                ),
                'buildStartWallUs':
                    FrameTimingCollector.projectedBuildStartWallTimeUs(frame),
              },
          ],
          'engineSpanHzIncludesIdle':
              stamps.length < 2 || stamps.last == stamps.first
              ? null
              : (stamps.length - 1) * 1000000 / (stamps.last - stamps.first),
          'buildP95': _percentile(build, .95),
          'buildMax': _percentile(build, 1),
          'rasterP95': _percentile(raster, .95),
          'rasterMax': _percentile(raster, 1),
          'bridgeP95': _percentile(nativeMs, .95),
          'bridgeMax': _percentile(nativeMs, 1),
          'engineGapMax': _percentile(gaps, 1),
          'phaseOverBudget': budget == null
              ? null
              : timings
                    .where(
                      (f) =>
                          f.buildDuration.inMicroseconds / 1000 > budget ||
                          f.rasterDuration.inMicroseconds / 1000 > budget,
                    )
                    .length,
          'nativeCalls': nativeMs.length,
          'insetBefore': insetsBefore,
          'insetAfter': tester.view.viewInsets.bottom,
          'longFrames': events,
        });
        if (keyboard != null) {
          expect(
            tester.view.viewInsets.bottom > 0,
            keyboard,
            reason: '$name must exercise the real OS keyboard',
          );
        }
      }

      await measure('keyboard_first_open', 'Tap to type', keyboard: true);
      await measure('keyboard_first_close', 'Pocket Host Lab', keyboard: false);
      await guest.tapGuest(tester, 'Home', scroll: false);
      await guest.waitFor(tester, '00');
      await measure('keyboard_warm_open', 'Tap to type', keyboard: true);
      await measure('keyboard_warm_close', 'Pocket Host Lab', keyboard: false);
      // Print only after sampling; logging must not create the measured stalls.
      for (final result in results) {
        // ignore: avoid_print
        print(
          'POCKET_INTERACTION_SCENE ${jsonEncode({...result}
            ..remove('longFrames')
            ..remove('frameTimings'))}',
        );
      }
      final report = <String, dynamic>{
        'interactionPerformance': results,
        'traceEnabled': traceEnabled,
        'widgetTraceEnabled': widgetTraceEnabled,
        'mode': _flutterMode(),
      };
      if (recordings != null) {
        final tapes = recordings.stop();
        expect(tapes, isNotEmpty);
        expect(tapes.values.every((tape) => tape.replayable), isTrue);
        final output = await recordings.export(
          directory: Directory.systemTemp,
          inputTape: {
            'schema': 'pocket.interaction-scenario',
            'version': 1,
            'scenes': [for (final result in results) result['scene']],
            'device': 'iPhone Duo simulator',
          },
        );
        final manifest = File(output['path'] as String);
        try {
          report['recordingManifest'] = jsonDecode(
            await manifest.readAsString(),
          );
          report['recordingAssets'] = <String, String>{
            await for (final file in Directory(
              '${manifest.parent.path}/assets',
            ).list())
              if (file is File)
                file.uri.pathSegments.last: base64Encode(
                  await file.readAsBytes(),
                ),
          };
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
          final replay = await PocketRecordingLibrary.replayArchive(manifest);
          report['recordingReplay'] = replay;
          expect(replay['ok'], isTrue, reason: replay.toString());
        } finally {
          await manifest.parent.delete(recursive: true);
        }
      }
      binding.reportData = <String, dynamic>{...?binding.reportData, ...report};
    } finally {
      debugProfileBuildsEnabled = previousBuildProfiling;
      debugProfileLayoutsEnabled = previousLayoutProfiling;
      debugProfilePaintsEnabled = previousPaintProfiling;
      timingCollector.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
