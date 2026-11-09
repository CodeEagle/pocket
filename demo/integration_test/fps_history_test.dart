import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_host/flutter_frame_monitor.dart';

import 'guest_interaction_test.dart' as guest;
import 'showcase_mobile_test.dart' as showcase;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('independent Flutter FPS detects stalls; guest tick history persists', (
    tester,
  ) async {
    final support = await getApplicationSupportDirectory();
    final historyFile = File(
      '${support.path}/pocket-performance/pocket.host.demo/history.json',
    );
    final startedAt = DateTime.now().toUtc();
    final monitor = FlutterFrameMonitorController(autoStart: false);
    Timer? stallTimer;
    Timer? transitionTimer;

    try {
      await tester.pumpWidget(
        pocketHostApp(frameMonitorController: monitor, showFlutterFps: true),
      );
      await guest.waitFor(tester, '00');
      final controller = tester
          .widget<PocketView>(find.byType(PocketView))
          .controller!;
      // Guest tick history measures intervals while the guest requests continuous
      // frames. A discrete event that parks after its output has no FPS cadence
      // to measure, so keep the real JS route transition active throughout the
      // warm-up, stall, and recovery windows.
      controller.send(
        method: 'demo.navigate',
        params: const <String, dynamic>{'route': 'mobile'},
      );
      await guest.waitFor(tester, 'Flutter widgets');
      var nextRoute = 'transitions';
      transitionTimer = Timer.periodic(const Duration(milliseconds: 80), (_) {
        controller.send(
          method: 'demo.navigate',
          params: <String, dynamic>{'route': nextRoute},
        );
        nextRoute = nextRoute == 'mobile' ? 'transitions' : 'mobile';
      });
      await guest.waitFor(tester, 'Route motion');
      final before = await _waitForFlutterFps(tester, monitor);
      expect(before, greaterThan(0));
      expect(
        find.byKey(const ValueKey('flutter-frame-monitor-hud')),
        findsOneWidget,
      );

      // Leave the real renderer alive long enough to emit a warm-up sample.
      await Future<void>.delayed(const Duration(seconds: 2));
      final baselineFps = await _waitForFlutterFps(tester, monitor);
      final stallStartVsyncUs = monitor.latest.lastVsyncStartUs!;

      // This callback runs on the Flutter UI isolate. It intentionally keeps
      // that isolate busy for 45ms out of every 60ms period, producing real
      // scheduler gaps rather than synthetic PocketPerformanceSample values.
      stallTimer = Timer.periodic(const Duration(milliseconds: 60), (_) {
        final clock = Stopwatch()..start();
        while (clock.elapsedMilliseconds < 45) {
          // Deliberately busy; do not yield to the event loop.
        }
      });
      await Future<void>.delayed(const Duration(seconds: 3));
      stallTimer.cancel();
      stallTimer = null;

      await Future<void>.delayed(const Duration(seconds: 2));
      final stalled = await _waitForLowerFlutterFps(
        tester,
        monitor,
        baselineFps,
        stallStartVsyncUs,
      );
      expect(
        stalled,
        lessThan(baselineFps),
        reason: 'real UI stalls must lower independent engine cadence',
      );
      transitionTimer.cancel();
      transitionTimer = null;
      controller.send(
        method: 'demo.navigate',
        params: const <String, dynamic>{'route': 'home'},
      );
      await Future<void>.delayed(const Duration(milliseconds: 300));
      await guest.waitFor(tester, '00');

      // Frame diagnostics is a Runtime-page entry, not a bottom navigation item.
      await guest.tapGuest(tester, 'Host');
      await guest.waitFor(tester, 'Runtime');
      await showcase.tap(tester, 'Frame diagnostics');
      await _waitForGuestHistory(tester);
      // Route scroll offset may leave the intro above the viewport. Assert
      // the visible data section, then verify fresh persisted facts below.
      expect(guest.texts(tester), contains('Guest ticks/s'));
      expect(guest.texts(tester), isNot(contains('No guest tick samples')));

      // Replacing the real app triggers PocketSession.dispose(), which queues
      // the final history flush. Existing user history is never removed.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      final persisted = await _waitForPersistedSamples(historyFile, startedAt);
      final degraded = persisted.where(_isDegradedSample).toList();
      expect(
        degraded,
        isNotEmpty,
        reason: 'the guest history must retain a measured active scheduler gap',
      );
      final document = jsonDecode(await historyFile.readAsString()) as Map;
      final longFrames = (document['longFrameEvents'] as List? ?? const [])
          .whereType<Map>()
          .where((event) => _atOrAfter(event['timestamp'], startedAt))
          .toList();
      expect(
        longFrames,
        isNotEmpty,
        reason: 'real UI stalls must persist individual long-frame facts',
      );
      expect(
        longFrames.any((event) {
          final budget = event['budgetMs'] as num;
          return event['active'] == true &&
              ['buildMs', 'rasterMs', 'nativeMs', 'activeGapMs'].any(
                (field) =>
                    event[field] is num && (event[field] as num) > budget * 1.5,
              );
        }),
        isTrue,
      );

      // A fresh host instance must read the same on-disk history and expose it
      // through the real JS runtime.performance capability.
      await tester.pumpWidget(pocketHostApp());
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, 'Host');
      await guest.waitFor(tester, 'Runtime');
      await showcase.tap(tester, 'Frame diagnostics');
      await _waitForGuestHistory(tester);
      expect(guest.texts(tester), contains('Guest ticks/s'));
      expect(guest.texts(tester), isNot(contains('No guest tick samples')));
    } finally {
      stallTimer?.cancel();
      transitionTimer?.cancel();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      monitor.dispose();
    }
  });
}

Future<double> _waitForFlutterFps(
  WidgetTester tester,
  FlutterFrameMonitorController monitor,
) async {
  for (var index = 0; index < 160; index++) {
    final fps = monitor.latest.fps;
    if (fps != null && fps > 0) return fps;
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('Independent Flutter engine monitor has no cadence sample');
}

Future<void> _waitForGuestHistory(WidgetTester tester) async {
  for (var index = 0; index < 200; index++) {
    final painted = guest.texts(tester);
    if (painted.contains('Guest ticks/s') &&
        !painted.contains('No guest tick samples')) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('Guest FPS history page has no real samples: ${guest.texts(tester)}');
}

Future<double> _waitForLowerFlutterFps(
  WidgetTester tester,
  FlutterFrameMonitorController monitor,
  double baselineFps,
  int stallStartVsyncUs,
) async {
  for (var index = 0; index < 160; index++) {
    for (final window in monitor.history) {
      if ((window.firstVsyncStartUs ?? -1) < stallStartVsyncUs) continue;
      final fps = window.fps;
      if (fps != null && fps < baselineFps * .75) return fps;
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('Flutter engine cadence did not decrease below $baselineFps');
}

Future<List<Map<String, dynamic>>> _waitForPersistedSamples(
  File file,
  DateTime start,
) async {
  for (var index = 0; index < 120; index++) {
    final records = await _readRecentSamples(file, start);
    if (records.isNotEmpty) return records;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  fail('No performance history sample persisted after $start at ${file.path}');
}

Future<List<Map<String, dynamic>>> _readRecentSamples(
  File file,
  DateTime start,
) async {
  if (!await file.exists()) return const <Map<String, dynamic>>[];
  try {
    final decoded = jsonDecode(await file.readAsString());
    final raw = decoded is Map ? decoded['history'] : decoded;
    if (raw is! List) return const <Map<String, dynamic>>[];
    return [
      for (final value in raw)
        if (value is Map && _atOrAfter(value['timestamp'], start))
          Map<String, dynamic>.from(value),
    ];
  } on FormatException {
    return const <Map<String, dynamic>>[];
  } on FileSystemException {
    return const <Map<String, dynamic>>[];
  }
}

bool _atOrAfter(Object? value, DateTime start) {
  if (value is! String) return false;
  final timestamp = DateTime.tryParse(value);
  return timestamp != null && !timestamp.isBefore(start);
}

bool _isDegradedSample(Map<String, dynamic> sample) {
  final fps = sample['fps'];
  final slowFrames = sample['slowFrames'];
  final maxGapMs = sample['maxGapMs'];
  return fps is num &&
      slowFrames is num &&
      maxGapMs is num &&
      (fps < 45 || slowFrames > 0) &&
      maxGapMs >= 40;
}
