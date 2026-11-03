import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pocket_host/flutter_frame_monitor.dart';

void main() {
  group('FlutterFrameMonitorController', () {
    test('uses source intervals and keeps 120Hz above the old 60 cap', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );

      controller.debugReportTimings(<FrameTiming>[
        _timing(vsyncStartUs: 0),
        _timing(vsyncStartUs: 8333),
        _timing(vsyncStartUs: 16666),
      ]);

      expect(controller.totalFrames, 3);
      expect(controller.latest.frameCount, 3);
      expect(controller.latest.fps, closeTo(120, .1));
      expect(controller.latest.frameBudgetMs, closeTo(1000 / 120, .001));
      expect(controller.latest.jankCount, 0);
      expect(_sourceStarts(controller.latest), <int>[0, 8333, 16666]);
    });

    test(
      'one callback batch and split callback batches have the same window',
      () {
        final frames = <FrameTiming>[
          _timing(vsyncStartUs: 0, buildUs: 1000, rasterUs: 2000),
          _timing(vsyncStartUs: 8333, buildUs: 2000, rasterUs: 1000),
          _timing(vsyncStartUs: 16666, buildUs: 3000, rasterUs: 1000),
        ];
        final oneBatch = FlutterFrameMonitorController(
          autoStart: false,
          displayRefreshRateHz: 120,
        );
        final splitBatch = FlutterFrameMonitorController(
          autoStart: false,
          displayRefreshRateHz: 120,
        );

        oneBatch.debugReportTimings(frames);
        splitBatch.debugReportTimings(<FrameTiming>[frames[0]]);
        splitBatch.debugReportTimings(<FrameTiming>[frames[1]]);
        splitBatch.debugReportTimings(<FrameTiming>[frames[2]]);

        expect(
          _sourceStarts(splitBatch.latest),
          _sourceStarts(oneBatch.latest),
        );
        expect(splitBatch.latest.fps, closeTo(oneBatch.latest.fps!, .001));
        expect(splitBatch.latest.uiMs, closeTo(oneBatch.latest.uiMs!, .001));
        expect(
          splitBatch.latest.rasterMs,
          closeTo(oneBatch.latest.rasterMs!, .001),
        );
        expect(splitBatch.latest.jankCount, oneBatch.latest.jankCount);
      },
    );

    test(
      'counts slow UI and raster phases against the injected display budget',
      () {
        final controller = FlutterFrameMonitorController(
          autoStart: false,
          displayRefreshRateHz: 120,
        );

        controller.debugReportTimings(<FrameTiming>[
          _timing(vsyncStartUs: 0, buildUs: 9000, rasterUs: 1000),
          _timing(vsyncStartUs: 8333, buildUs: 1000, rasterUs: 9000),
        ]);

        expect(controller.longFrameCount, 2);
        expect(controller.latest.jankCount, 2);
        expect(controller.latest.latestUiMs, 1);
        expect(controller.latest.latestRasterMs, 9);
        expect(controller.latest.uiP95Ms, 9);
        expect(controller.latest.rasterP95Ms, 9);
      },
    );

    test('uses true nearest-rank p95 for a small sample window', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );

      controller.debugReportTimings(<FrameTiming>[
        for (var index = 1; index <= 12; index++)
          _timing(vsyncStartUs: index * 8333, buildUs: index * 1000),
      ]);

      // ceil(0.95 * 12) is rank 12; the old round((n - 1) * p) formula
      // selected rank 11 for this deliberately small sample set.
      expect(controller.latest.uiP95Ms, 12);
    });

    test('does not turn a sparse idle gap into jank', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );

      controller.debugReportTimings(<FrameTiming>[
        _timing(vsyncStartUs: 0),
        _timing(vsyncStartUs: 1_000_000),
      ]);

      expect(controller.latest.fps, closeTo(1, .001));
      expect(controller.latest.jankCount, 0);
      expect(controller.longFrameCount, 0);
    });

    test('keeps a UI stall in the one-second cadence window', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );

      controller.debugReportTimings(<FrameTiming>[
        _timing(vsyncStartUs: 0),
        _timing(vsyncStartUs: 8333),
        _timing(vsyncStartUs: 500000, buildUs: 20000),
      ]);

      expect(controller.latest.frameCount, 3);
      expect(controller.latest.fps, closeTo(4, .01));
      expect(controller.latest.firstVsyncStartUs, 0);
      expect(controller.latest.lastVsyncStartUs, 500000);
      expect(controller.latest.jankCount, 1);
      expect(controller.longFrameCount, 1);
    });

    test(
      'drops source samples older than the one-second window after idle',
      () {
        final controller = FlutterFrameMonitorController(
          autoStart: false,
          displayRefreshRateHz: 120,
        );

        controller.debugReportTimings(<FrameTiming>[
          _timing(vsyncStartUs: 0),
          _timing(vsyncStartUs: 8333),
        ]);
        controller.debugReportTimings(<FrameTiming>[
          _timing(vsyncStartUs: 5_000_000),
          _timing(vsyncStartUs: 5_008_333),
          _timing(vsyncStartUs: 5_016_666),
        ]);

        expect(controller.latest.frameCount, 3);
        expect(controller.latest.firstVsyncStartUs, 5_000_000);
        expect(controller.latest.lastVsyncStartUs, 5_016_666);
        expect(controller.latest.fps, closeTo(120, .1));
      },
    );

    test('keeps empty and single-frame windows honest', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );

      expect(controller.latest.isEmpty, isTrue);
      expect(controller.latest.fps, isNull);
      expect(controller.latest.jankCount, 0);

      controller.debugReportTimings(<FrameTiming>[_timing(vsyncStartUs: 0)]);

      expect(controller.latest.isEmpty, isFalse);
      expect(controller.latest.frameCount, 1);
      expect(controller.latest.fps, isNull);
    });

    test('deduplicates repeated delivery and bounds raw source samples', () {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        maxSamples: 2,
        maxHistory: 2,
        displayRefreshRateHz: 120,
      );
      final first = _timing(vsyncStartUs: 0);
      final second = _timing(vsyncStartUs: 8333);
      final third = _timing(vsyncStartUs: 16666);

      controller.debugReportTimings(<FrameTiming>[first, second, third]);
      // The first sample has already fallen out of the hard sample bound; the
      // source watermark must still reject a late duplicate.
      controller.debugReportTimings(<FrameTiming>[first]);

      expect(controller.totalFrames, 3);
      expect(_sourceStarts(controller.latest), <int>[8333, 16666]);
      expect(controller.history, hasLength(1));
    });

    test('dispose detaches and ignores later timing delivery', () {
      final controller = FlutterFrameMonitorController(autoStart: false);
      controller.attach();
      expect(controller.isAttached, isTrue);
      controller.dispose();
      expect(controller.isAttached, isFalse);

      controller.debugReportTimings(<FrameTiming>[_timing(vsyncStartUs: 0)]);

      expect(controller.totalFrames, 0);
      expect(controller.latest.isEmpty, isTrue);
    });
  });

  testWidgets('disabled mode is transparent and toggles attachment cleanly', (
    tester,
  ) async {
    final controller = FlutterFrameMonitorController(autoStart: false);
    const childKey = ValueKey<String>('monitor-child');
    const child = SizedBox(key: childKey);
    final baselineSubscribers = FlutterFrameMonitor.debugSubscriberCount;

    Future<void> pumpMonitor(bool enabled) async {
      await tester.pumpWidget(
        MaterialApp(
          home: FlutterFrameMonitor(
            controller: controller,
            enabled: enabled,
            child: child,
          ),
        ),
      );
    }

    // MaterialApp's route already owns repaint boundaries. Compare with the
    // same child without a monitor instead of treating those as HUD layers.
    await tester.pumpWidget(const MaterialApp(home: child));
    await tester.pumpAndSettle();
    final baselineBoundaryCount = find
        .ancestor(
          of: find.byKey(childKey),
          matching: find.byType(RepaintBoundary),
        )
        .evaluate()
        .length;
    await pumpMonitor(false);
    expect(controller.isAttached, isFalse);
    expect(FlutterFrameMonitor.debugSubscriberCount, baselineSubscribers);
    final disabledBoundaryCount = find
        .ancestor(
          of: find.byKey(childKey),
          matching: find.byType(RepaintBoundary),
        )
        .evaluate()
        .length;
    expect(
      disabledBoundaryCount,
      baselineBoundaryCount,
      reason: 'the transparent disabled monitor must add no boundary',
    );

    await pumpMonitor(true);
    expect(controller.isAttached, isTrue);
    expect(FlutterFrameMonitor.debugSubscriberCount, baselineSubscribers + 1);
    final enabledBoundaryCount = find
        .ancestor(
          of: find.byKey(childKey),
          matching: find.byType(RepaintBoundary),
        )
        .evaluate()
        .length;
    expect(enabledBoundaryCount, disabledBoundaryCount);
    expect(
      find.byKey(const ValueKey<String>('flutter-frame-monitor-hud')),
      findsOneWidget,
    );

    await pumpMonitor(false);
    await tester.pump();
    expect(controller.isAttached, isFalse);
    expect(FlutterFrameMonitor.debugSubscriberCount, baselineSubscribers);
    expect(
      find
          .ancestor(
            of: find.byKey(childKey),
            matching: find.byType(RepaintBoundary),
          )
          .evaluate()
          .length,
      disabledBoundaryCount,
    );
    expect(
      find.byKey(const ValueKey<String>('flutter-frame-monitor-hud')),
      findsNothing,
    );
  });

  testWidgets(
    'HUD subscribes weakly, does not rebuild its child, or self-drive',
    (tester) async {
      final controller = FlutterFrameMonitorController(
        autoStart: false,
        displayRefreshRateHz: 120,
      );
      var childBuilds = 0;
      final baselineSubscribers = FlutterFrameMonitor.debugSubscriberCount;

      await tester.pumpWidget(
        MaterialApp(
          home: FlutterFrameMonitor(
            controller: controller,
            child: _BuildProbe(onBuild: () => childBuilds++),
          ),
        ),
      );
      // MaterialApp may leave an initialization frame pending. Settle that
      // external work before checking whether the monitor itself schedules one.
      await tester.pumpAndSettle();
      controller.reset();
      final initialChildBuilds = childBuilds;
      expect(FlutterFrameMonitor.debugSubscriberCount, baselineSubscribers + 1);
      expect(
        find.byKey(const ValueKey<String>('flutter-frame-monitor-hud')),
        findsOneWidget,
      );
      expect(tester.binding.hasScheduledFrame, isFalse);

      controller.debugReportTimings(<FrameTiming>[
        _timing(vsyncStartUs: 1_000_000),
        _timing(vsyncStartUs: 1_008_333),
      ]);
      // A timing callback is passive: reporting data alone cannot rebuild the
      // HUD or request a frame.
      expect(childBuilds, initialChildBuilds);
      expect(tester.binding.hasScheduledFrame, isFalse);

      // The persistent dispatcher may observe the new version only while a real
      // frame is already being pumped. A second pump renders that dirty HUD;
      // neither pump should rebuild the stable child widget.
      await tester.pump();
      await tester.pump();
      expect(childBuilds, initialChildBuilds);
      expect(
        find.byKey(const ValueKey<String>('flutter-frame-monitor-hud')),
        findsOneWidget,
      );
      expect(tester.binding.hasScheduledFrame, isFalse);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(FlutterFrameMonitor.debugSubscriberCount, baselineSubscribers);
      expect(controller.isAttached, isFalse);
    },
  );

  testWidgets(
    'HUD paint invalidation does not poison a later parent setState',
    (tester) async {
      final controller = FlutterFrameMonitorController(autoStart: false);
      final parentKey = GlobalKey<_MonitorParentState>();

      await tester.pumpWidget(
        MaterialApp(
          home: _MonitorParent(key: parentKey, controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      controller.reset();
      controller.debugReportTimings(<FrameTiming>[
        _timing(vsyncStartUs: 1_000_000),
        _timing(vsyncStartUs: 1_008_333),
      ]);

      expect(tester.binding.hasScheduledFrame, isFalse);
      await tester.pump();
      expect(tester.binding.hasScheduledFrame, isFalse);

      parentKey.currentState!.bump();
      expect(tester.binding.hasScheduledFrame, isTrue);
      await tester.pump();
      expect(find.text('parent rebuild 1'), findsOneWidget);

      parentKey.currentState!.disableMonitor();
      expect(tester.binding.hasScheduledFrame, isTrue);
      await tester.pump();
      expect(
        find.byKey(const ValueKey<String>('flutter-frame-monitor-hud')),
        findsNothing,
      );
      expect(controller.isAttached, isFalse);
    },
  );
}

FrameTiming _timing({
  required int vsyncStartUs,
  int buildUs = 1000,
  int rasterUs = 1000,
}) {
  final buildStartUs = vsyncStartUs + 100;
  final buildFinishUs = buildStartUs + buildUs;
  final rasterStartUs = buildFinishUs;
  final rasterFinishUs = rasterStartUs + rasterUs;
  return FrameTiming(
    vsyncStart: vsyncStartUs,
    buildStart: buildStartUs,
    buildFinish: buildFinishUs,
    rasterStart: rasterStartUs,
    rasterFinish: rasterFinishUs,
    rasterFinishWallTime: rasterFinishUs,
  );
}

List<int> _sourceStarts(FlutterFrameWindow window) =>
    window.samples.map((sample) => sample.vsyncStartUs).toList();

final class _BuildProbe extends StatelessWidget {
  const _BuildProbe({required this.onBuild});

  final VoidCallback onBuild;

  @override
  Widget build(BuildContext context) {
    onBuild();
    return const ColoredBox(color: Colors.transparent);
  }
}

final class _MonitorParent extends StatefulWidget {
  const _MonitorParent({super.key, required this.controller});

  final FlutterFrameMonitorController controller;

  @override
  State<_MonitorParent> createState() => _MonitorParentState();
}

final class _MonitorParentState extends State<_MonitorParent> {
  int _rebuilds = 0;
  bool _enabled = true;

  void bump() => setState(() => _rebuilds++);

  void disableMonitor() => setState(() => _enabled = false);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: <Widget>[
          Text('parent rebuild $_rebuilds'),
          Expanded(
            child: FlutterFrameMonitor(
              controller: widget.controller,
              enabled: _enabled,
              child: const ColoredBox(color: Colors.transparent),
            ),
          ),
        ],
      ),
    );
  }
}
