import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/flutter_frame_monitor.dart';
import 'package:pocket_host/main.dart';

import '../tool/verify_flutter_fps.dart';
import 'guest_interaction_test.dart' as guest;

Map<String, Object?> _describe(FlutterFrameWindow window) => {
  'fps': window.fps,
  'frames': window.frameCount,
  'firstVsyncStartUs': window.firstVsyncStartUs,
  'lastVsyncStartUs': window.lastVsyncStartUs,
  'refreshHz': window.displayRefreshRateHz,
  'uiP95Ms': window.uiP95Ms,
  'rasterP95Ms': window.rasterP95Ms,
  'jankFrames': window.jankCount,
};

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('Flutter-only FPS detects real build stalls', (tester) async {
    final monitor = FlutterFrameMonitorController(autoStart: false);
    final workloadKey = GlobalKey<FlutterFpsWorkloadState>();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: FlutterFrameMonitor(
            controller: monitor,
            child: FlutterFpsWorkload(key: workloadKey),
          ),
        ),
      );
      // Wait in real time; no 16ms tester.pump loop or Pocket runtime drives
      // the reported cadence. Drop startup from the settled baseline.
      await Future<void>.delayed(const Duration(seconds: 3));
      final baseline = monitor.latest;
      expect(baseline.hasCadence, isTrue);
      expect(baseline.fps, greaterThan(0));
      final jankBefore = monitor.longFrameCount;

      workloadKey.currentState!.stall = true;
      await Future<void>.delayed(const Duration(seconds: 3));
      final stalled = monitor.latest;
      expect(stalled.fps, lessThan(baseline.fps! * .75));
      expect(stalled.uiP95Ms, greaterThanOrEqualTo(40));
      expect(monitor.longFrameCount, greaterThan(jankBefore));

      workloadKey.currentState!.stall = false;
      workloadKey.currentState!.stop();
      // LiveTestWidgetsFlutterBinding schedules its own heartbeat frames.
      // Idle/no-self-drive is verified in tool/verify_flutter_fps.dart under
      // ordinary WidgetsFlutterBinding, never inferred from this harness.
      binding.reportData ??= <String, dynamic>{};
      binding.reportData!['flutterOnlyFps'] = {
        'baseline': _describe(baseline),
        'stalled': _describe(stalled),
        'testBindingHeartbeat': true,
      };
      // ignore: avoid_print
      print(
        'Flutter-only FPS verification: '
        '${jsonEncode(binding.reportData!['flutterOnlyFps'])}',
      );
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(monitor.isAttached, isFalse);
      monitor.dispose();
    }
  });

  testWidgets('Showcase uses the independent engine monitor', (tester) async {
    final monitor = FlutterFrameMonitorController(autoStart: false);
    try {
      await tester.pumpWidget(PocketHostApp(frameMonitorController: monitor));
      await guest.waitFor(tester, '00');
      expect(find.byKey(const ValueKey('flutter-frame-monitor-hud')), findsOneWidget);
      expect(find.textContaining('Guest ticks/s'), findsNothing);
      final before = monitor.totalFrames;
      await guest.tapGuest(tester, '+1');
      await guest.waitFor(tester, '01');
      await guest.tapGuest(tester, 'Tap to type');
      await Future<void>.delayed(const Duration(seconds: 2));
      expect(monitor.totalFrames, greaterThan(before));
      expect(
        View.of(
          tester.element(find.byType(FlutterFrameMonitor)),
        ).viewInsets.bottom,
        greaterThan(0),
      );
      expect(monitor.latest.samples, isNotEmpty);
      expect(monitor.latest.displayRefreshRateHz, greaterThan(0));
      binding.reportData ??= <String, dynamic>{};
      binding.reportData!['showcaseFlutterFps'] = _describe(monitor.latest);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      monitor.dispose();
    }
  });
}
