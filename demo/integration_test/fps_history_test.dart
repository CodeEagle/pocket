import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;
import 'showcase_mobile_test.dart' as showcase;

final _fpsLabel = RegExp(
  r'^FPS\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+min\s+([0-9]+(?:\.[0-9]+)?)$',
);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('records real UI stalls in persistent FPS history', (
    tester,
  ) async {
    final support = await getApplicationSupportDirectory();
    final historyFile = File(
      '${support.path}/pocket-performance/pocket.host.demo/history.json',
    );
    final startedAt = DateTime.now().toUtc();
    Timer? stallTimer;
    Timer? transitionTimer;

    try {
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitFor(tester, '00');
      final controller = tester
          .widget<PocketView>(find.byType(PocketView))
          .controller!;
      // FPS history measures intervals while the guest requests continuous
      // frames. A discrete event that parks after its output has no FPS cadence
      // to measure, so keep the real JS route transition active throughout the
      // warm-up, stall, and recovery windows.
      controller.send(
        method: 'demo.navigate',
        params: const <String, dynamic>{'route': 'mobile'},
      );
      await guest.waitFor(tester, 'Flutter widget vocabulary');
      var nextRoute = 'transitions';
      transitionTimer = Timer.periodic(const Duration(milliseconds: 80), (_) {
        controller.send(
          method: 'demo.navigate',
          params: <String, dynamic>{'route': nextRoute},
        );
        nextRoute = nextRoute == 'mobile' ? 'transitions' : 'mobile';
      });
      await guest.waitFor(tester, 'Route motion');
      final before = await _waitForFpsLabel(tester);
      expect(before.minFps, greaterThan(0));

      // Leave the real renderer alive long enough to emit a warm-up sample.
      await Future<void>.delayed(const Duration(seconds: 2));
      final warmed = await _waitForFpsLabel(tester);
      final baselineMin = warmed.minFps;

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
      final stalled = await _waitForLowerFpsLabel(tester, baselineMin);
      expect(
        stalled.minFps,
        lessThan(baselineMin),
        reason: 'real UI stalls should lower the renderer minimum FPS',
      );
      transitionTimer.cancel();
      transitionTimer = null;
      controller.send(
        method: 'demo.navigate',
        params: const <String, dynamic>{'route': 'home'},
      );
      await Future<void>.delayed(const Duration(milliseconds: 300));
      await guest.waitFor(tester, '00');

      // FPS history is a Runtime-page entry, not a bottom navigation item.
      await guest.tapGuest(tester, 'Host');
      await guest.waitFor(tester, 'Runtime');
      await showcase.tap(tester, 'FPS history');
      await _waitForGuestHistory(tester);
      // Route scroll offset may leave the intro above the viewport. Assert
      // the visible data section, then verify fresh persisted facts below.
      expect(guest.texts(tester), contains('Latest FPS'));
      expect(guest.texts(tester), isNot(contains('No FPS samples')));

      // Replacing the real app triggers PocketSession.dispose(), which queues
      // the final history flush. Existing user history is never removed.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      final persisted = await _waitForPersistedSamples(historyFile, startedAt);
      final degraded = persisted.where(_isDegradedSample).toList();
      expect(
        degraded,
        isNotEmpty,
        reason:
            'the persisted window must contain a real low-FPS/slow-frame sample with a large gap',
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
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, 'Host');
      await guest.waitFor(tester, 'Runtime');
      await showcase.tap(tester, 'FPS history');
      await _waitForGuestHistory(tester);
      expect(guest.texts(tester), contains('Latest FPS'));
      expect(guest.texts(tester), isNot(contains('No FPS samples')));
    } finally {
      stallTimer?.cancel();
      transitionTimer?.cancel();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}

Future<_FpsLabel> _waitForFpsLabel(WidgetTester tester) async {
  for (var index = 0; index < 160; index++) {
    final match = _readFpsLabel(tester);
    if (match != null) return match;
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('Flutter FPS overlay did not become numeric: ${_flutterTexts(tester)}');
}

_FpsLabel? _readFpsLabel(WidgetTester tester) {
  for (final widget in tester.widgetList<Text>(find.byType(Text))) {
    final match = _fpsLabel.firstMatch(widget.data ?? '');
    if (match == null) continue;
    return _FpsLabel(
      fps: double.parse(match.group(1)!),
      minFps: double.parse(match.group(2)!),
    );
  }
  return null;
}

Future<void> _waitForGuestHistory(WidgetTester tester) async {
  for (var index = 0; index < 200; index++) {
    final painted = guest.texts(tester);
    if (painted.contains('Latest FPS') && !painted.contains('No FPS samples')) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail('Guest FPS history page has no real samples: ${guest.texts(tester)}');
}

Future<_FpsLabel> _waitForLowerFpsLabel(
  WidgetTester tester,
  double baselineMin,
) async {
  for (var index = 0; index < 160; index++) {
    final current = _readFpsLabel(tester);
    if (current != null && current.minFps < baselineMin) return current;
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail(
    'Flutter FPS minimum did not decrease below $baselineMin: ${_flutterTexts(tester)}',
  );
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

List<String?> _flutterTexts(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((widget) => widget.data)
    .toList();

final class _FpsLabel {
  const _FpsLabel({required this.fps, required this.minFps});

  final double fps;
  final double minFps;
}
