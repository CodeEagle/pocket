import 'dart:convert';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

double percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  values.sort();
  return values[((values.length - 1) * fraction).round()];
}

Future<Map<String, Object>> sample(
  WidgetTester tester,
  String scene, {
  bool animate = false,
}) async {
  final controller = tester
      .widget<PocketView>(find.byType(PocketView))
      .controller!;
  Ticker? driver;
  if (animate) {
    driver = Ticker((_) => controller.send(method: 'demo.increment'))..start();
  }
  var nativeFrames = 0;
  final previousProbe = debugPocketFrameDeltaAtOverride;
  debugPocketFrameDeltaAtOverride = (runtime, delta) {
    nativeFrames++;
    return previousProbe == null
        ? pocketFrameDeltaAt(runtime, delta)
        : previousProbe(runtime, delta);
  };
  final timings = <FrameTiming>[];
  void collect(List<FrameTiming> values) => timings.addAll(values);
  SchedulerBinding.instance.addTimingsCallback(collect);
  PocketCanvasPainter.resetPaintInvocationCount();
  final clock = Stopwatch()..start();
  try {
    await Future<void>.delayed(
      const Duration(
        seconds: int.fromEnvironment('POCKET_PERF_SECONDS', defaultValue: 4),
      ),
    );
  } finally {
    clock.stop();
    driver?.dispose();
    debugPocketFrameDeltaAtOverride = previousProbe;
    SchedulerBinding.instance.removeTimingsCallback(collect);
  }
  final paints = PocketCanvasPainter.paintInvocationCount;
  final drawOps = PocketCanvasPainter.drawOpInvocationCount;
  if (animate) {
    expect(
      timings.length,
      greaterThan(10),
      reason: 'dynamic scene must render real engine frames',
    );
  }
  // An idle event-driven surface is allowed to emit no frames. Do not force a
  // ticker merely to make a static page report the display refresh rate.
  final elapsed = timings.length < 2
      ? 0.0
      : (timings.last.timestampInMicroseconds(FramePhase.vsyncStart) -
                timings.first.timestampInMicroseconds(FramePhase.vsyncStart)) /
            1000000;
  final build = timings
      .map((frame) => frame.buildDuration.inMicroseconds / 1000)
      .toList();
  final raster = timings
      .map((frame) => frame.rasterDuration.inMicroseconds / 1000)
      .toList();
  final refresh = tester.view.display.refreshRate;
  final budget = 1000 / refresh;
  return {
    'scene': scene,
    'mode': kProfileMode
        ? 'profile'
        : kReleaseMode
        ? 'release'
        : 'debug',
    'refreshHz': refresh,
    'frames': timings.length,
    'observedHz': elapsed <= 0 ? 0 : (timings.length - 1) / elapsed,
    'nativeFrameCalls': nativeFrames,
    'nativeFramesPerSecond':
        nativeFrames / (clock.elapsedMicroseconds / 1000000),
    'buildMsP50': percentile(build, .5),
    'buildMsP95': percentile(build, .95),
    'buildMsP99': percentile(build, .99),
    'rasterMsP50': percentile(raster, .5),
    'rasterMsP99': percentile(raster, .99),
    'rasterMsP95': percentile(raster, .95),
    'overBudgetFrames': timings
        .where(
          (frame) =>
              frame.buildDuration.inMicroseconds / 1000 > budget ||
              frame.rasterDuration.inMicroseconds / 1000 > budget,
        )
        .length,
    'canvasPaints': paints,
    'paintedOps': drawOps,
    'sampleMilliseconds': clock.elapsedMilliseconds,
  };
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('measure actual frame timings without synthetic pump cadence', (
    tester,
  ) async {
    await tester.pumpWidget(const PocketHostApp());
    await guest.waitFor(tester, '00');
    await Future<void>.delayed(const Duration(seconds: 2));
    final results = <Map<String, Object>>[];
    results.add(await sample(tester, 'home_idle'));
    results.add(await sample(tester, 'home_counter_each_vsync', animate: true));
    await guest.tapGuest(tester, 'Host');
    await guest.tapGuest(tester, 'Stress');
    await guest.tapGuest(tester, 'Run 500 nodes');
    await guest.waitForContaining(tester, '500 retained nodes');
    await Future<void>.delayed(const Duration(seconds: 1));
    results.add(await sample(tester, 'stress_500_idle'));
    // Machine-readable output is intentionally printed once, outside sampling.
    // ignore: avoid_print
    print('POCKET_PERF ${jsonEncode(results)}');
    binding.reportData = <String, dynamic>{
      ...?binding.reportData,
      'performance': results,
    };
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
