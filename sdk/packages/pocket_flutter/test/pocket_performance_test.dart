import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'performance sample is immutable and serializes wall-clock metadata',
    () {
      final timestamp = DateTime.utc(2026, 11, 2, 3, 4, 5, 6000);
      final longFrame = PocketLongFrameEvent(
        timestamp: timestamp,
        refreshHz: 144,
        budgetMs: 1000 / 144,
        buildMs: 12.5,
        rasterMs: 2.25,
        nativeMs: 4.75,
        activeGapMs: 14.0,
      );
      final sample = PocketPerformanceSample(
        timestamp: timestamp,
        fps: 144,
        frames: 144,
        durationMs: 1008.25,
        maxGapMs: 42.0,
        slowFrames: 2,
        nativeMsP95: 1.75,
        decodeMsP95: 0.5,
        diffMsP95: 0.25,
        buildMsP95: 0.75,
        paintMsP95: 3.5,
        nativeJsTickMsP95: 0.4,
        nativeLive2dUpdateMsP95: 0.1,
        nativeLive2dEmitMsP95: 0.3,
        nativeRelayoutMsP95: 0.05,
        nativeDrawDecodeMsP95: 0.35,
        nativeSpliceMsP95: 0.15,
        nativeEncodeMsP95: 0.2,
        nativeOtherMsP95: 0.2,
        refreshHz: 144,
        longFrameEvents: <PocketLongFrameEvent>[longFrame],
      );

      expect(sample.toJson(), <String, dynamic>{
        'timestamp': timestamp.toIso8601String(),
        'fps': 144,
        'frames': 144,
        'durationMs': 1008.25,
        'maxGapMs': 42.0,
        'slowFrames': 2,
        'nativeMsP95': 1.75,
        'decodeMsP95': 0.5,
        'diffMsP95': 0.25,
        'buildMsP95': 0.75,
        'paintMsP95': 3.5,
        'nativeJsTickMsP95': 0.4,
        'nativeLive2dUpdateMsP95': 0.1,
        'nativeLive2dEmitMsP95': 0.3,
        'nativeRelayoutMsP95': 0.05,
        'nativeDrawDecodeMsP95': 0.35,
        'nativeSpliceMsP95': 0.15,
        'nativeEncodeMsP95': 0.2,
        'nativeOtherMsP95': 0.2,
        'native.js_tickMsP95': 0.4,
        'native.live2d_updateMsP95': 0.1,
        'native.live2d_emitMsP95': 0.3,
        'native.relayoutMsP95': 0.05,
        'native.draw_decodeMsP95': 0.35,
        'native.spliceMsP95': 0.15,
        'native.encodeMsP95': 0.2,
        'native.otherMsP95': 0.2,
        'refreshHz': 144,
        'longFrameEvents': <Map<String, dynamic>>[
          <String, dynamic>{
            'timestamp': timestamp.toIso8601String(),
            'refreshHz': 144,
            'budgetMs': 1000 / 144,
            'buildMs': 12.5,
            'rasterMs': 2.25,
            'nativeMs': 4.75,
            'activeGapMs': 14.0,
            'active': true,
            'scope': 'pocketView',
          },
        ],
      });
    },
  );

  testWidgets('keeps a long gap crossing the sample boundary', (tester) async {
    final samples = <PocketPerformanceSample>[];
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: _PerformanceRuntime(),
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: false,
            onPerformanceSample: samples.add,
          ),
        ),
      ),
    );
    await tester.pump();

    // Establish the first ticker baseline, then drive a normal one-second
    // window without depending on wall-clock sleeps.
    for (var index = 0; index < 100 && samples.isEmpty; index++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(samples, hasLength(1));

    // The first tick in the next window is deliberately late. It must remain
    // part of the next sample even though the prior sample just emitted.
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(const Duration(milliseconds: 800));
    expect(samples, hasLength(2));
    expect(samples.last.maxGapMs, greaterThanOrEqualTo(190));
    expect(samples.last.slowFrames, greaterThan(0));
    expect(samples.last.longFrameEvents, isNotEmpty);
    final activeGapEvents = samples.last.longFrameEvents.where(
      (event) => event.activeGapMs != null && event.activeGapMs! >= 190,
    );
    // The 200ms pump and the following 800ms pump are two separate active
    // scheduler gaps in this synthetic window. They must both be retained;
    // duplicate delivery is still ruled out by the unique frame timestamps.
    expect(activeGapEvents, isNotEmpty);
    expect(
      activeGapEvents.map((event) => event.timestamp).toSet(),
      hasLength(activeGapEvents.length),
    );
    expect(activeGapEvents.first.active, isTrue);
    expect(activeGapEvents.first.activeGapMs, greaterThanOrEqualTo(190));
  });

  testWidgets('flushes an active long frame before demand-driven idle', (
    tester,
  ) async {
    final samples = <PocketPerformanceSample>[];
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: _IdleAfterLongFrameRuntime(),
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: false,
            onPerformanceSample: samples.add,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(samples, isNotEmpty);
    final events = samples.expand((sample) => sample.longFrameEvents).toList();
    expect(events, isNotEmpty);
    final activeGapEvents = events.where(
      (event) => event.activeGapMs != null && event.activeGapMs! >= 190,
    );
    expect(activeGapEvents, hasLength(1));
    expect(activeGapEvents.single.active, isTrue);
  });

  testWidgets('retains the parked frame context for delayed FrameTiming', (
    tester,
  ) async {
    final samples = <PocketPerformanceSample>[];
    final controller = PocketViewController();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            controller: controller,
            runtime: _IdleAfterLongFrameRuntime(),
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: false,
            onPerformanceSample: samples.add,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(samples, hasLength(1));

    final state = tester.state(find.byType(PocketView));
    final vsyncStart =
        tester.binding.currentSystemFrameTimeStamp.inMicroseconds;
    (state as dynamic).debugReportFrameTimings(<ui.FrameTiming>[
      ui.FrameTiming(
        vsyncStart: vsyncStart,
        buildStart: vsyncStart + 1000,
        buildFinish: vsyncStart + 41000,
        rasterStart: vsyncStart + 41000,
        rasterFinish: vsyncStart + 71000,
        rasterFinishWallTime: vsyncStart + 71000,
      ),
    ]);

    // Wake the same guest once. The next parked boundary should carry the
    // build/raster enrichment instead of dropping it or duplicating the
    // already-delivered active-gap event.
    controller.send(method: 'diagnostic');
    await tester.pump();
    expect(samples, hasLength(2));
    final enriched = samples.last.longFrameEvents;
    expect(enriched, hasLength(1));
    expect(enriched.single.buildMs, greaterThanOrEqualTo(40));
    expect(enriched.single.rasterMs, greaterThanOrEqualTo(30));
    expect(enriched.single.scope, 'flutterView');
  });

  testWidgets(
    'captures an unmatched parked Flutter long frame without native attribution',
    (tester) async {
      final samples = <PocketPerformanceSample>[];
      final runtime = _IdleAfterLongFrameRuntime();
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(samples, isNotEmpty);

      final frameCallsBeforeTiming = runtime.frameCalls;
      final samplesBeforeTiming = samples.length;
      // Deliberately do not match any retained PocketView context. This
      // models the first keyboard/IME frame arriving while the guest ticker
      // is parked and lets the global Flutter timing stand on its own.
      final vsyncStart =
          tester.binding.currentSystemFrameTimeStamp.inMicroseconds + 100000;
      final timing = ui.FrameTiming(
        vsyncStart: vsyncStart,
        buildStart: vsyncStart + 1000,
        buildFinish: vsyncStart + 80000,
        rasterStart: vsyncStart + 80000,
        rasterFinish: vsyncStart + 82000,
        rasterFinishWallTime: vsyncStart + 82000,
      );
      final state = tester.state(find.byType(PocketView));
      (state as dynamic).debugReportFrameTimings(<ui.FrameTiming>[timing]);

      expect(runtime.frameCalls, frameCallsBeforeTiming);
      expect(samples, hasLength(samplesBeforeTiming + 1));
      final event = samples.last.longFrameEvents.single;
      expect(event.scope, 'flutterView');
      expect(event.buildMs, greaterThanOrEqualTo(79));
      expect(event.rasterMs, greaterThanOrEqualTo(2));
      expect(event.nativeMs, isNull);
      expect(event.activeGapMs, isNull);

      // A duplicate timing callback must not broadcast the same global fact
      // twice or create another native frame.
      (state as dynamic).debugReportFrameTimings(<ui.FrameTiming>[timing]);
      expect(samples, hasLength(samplesBeforeTiming + 1));
      expect(runtime.frameCalls, frameCallsBeforeTiming);
    },
  );

  testWidgets(
    'does not arm the stale deadline after a parked diagnostic wake',
    (tester) async {
      final samples = <PocketPerformanceSample>[];
      final controller = PocketViewController();
      final runtime = _IdleDeadlineRuntime();
      var sentDiagnostic = false;
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: (sample) {
                samples.add(sample);
                if (!sentDiagnostic) {
                  sentDiagnostic = true;
                  controller.send(method: 'diagnostic');
                }
              },
            ),
          ),
        ),
      );
      await tester.pump();
      // This turn crosses the active-gap threshold and makes the runtime
      // report a one-second future deadline. The diagnostic callback sends
      // ingress while the view is being parked.
      await tester.pump(const Duration(milliseconds: 200));
      expect(samples, isNotEmpty);
      expect(runtime.diagnosticConsumed, isFalse);

      // The callback must have restarted the existing ticker for one prompt
      // guest turn, rather than leaving the stale one-second timer armed.
      await tester.pump();
      expect(runtime.diagnosticConsumed, isTrue);
      final frameCallsAfterDiagnostic = runtime.frameCalls;
      final state = tester.state(find.byType(PocketView));
      expect((state as dynamic).hasScheduledWake, isFalse);

      // The consumed message returns the guest to indefinite idle. No timer
      // loop or extra native frame should be introduced by the sampler.
      await tester.pump(const Duration(milliseconds: 1000));
      expect(runtime.frameCalls, frameCallsAfterDiagnostic);
    },
  );

  testWidgets(
    'slow wakeup tick stays in the resumed active window without premature burst',
    (tester) async {
      addTearDown(() {
        debugPocketNativeFrameDurationOverride = null;
      });
      final samples = <PocketPerformanceSample>[];
      final controller = PocketViewController();
      final runtime = _ControllableIdleRuntime(sleeping: true);
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(samples, isEmpty);

      // Resume from idle with a slow native frame while staying active.
      runtime.sleeping = false;
      debugPocketNativeFrameDurationOverride = () =>
          const Duration(milliseconds: 35);
      controller.send(method: 'wake');
      await tester.pump(const Duration(milliseconds: 16));
      expect(samples, isEmpty);

      debugPocketNativeFrameDurationOverride = () =>
          const Duration(milliseconds: 1);
      for (var index = 0; index < 100 && samples.isEmpty; index++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(samples, hasLength(1));
      expect(samples.single.frames, greaterThan(0));
      expect(samples.single.fps, greaterThan(0));
      expect(samples.single.longFrameEvents, hasLength(1));
      expect(
        samples.single.longFrameEvents.single.nativeMs,
        greaterThanOrEqualTo(35),
      );
      expect(samples.single.longFrameEvents.single.scope, 'pocketView');
    },
  );

  testWidgets(
    'unfocused PocketView does not claim unmatched FrameTimings while parked',
    (tester) async {
      final samples = <PocketPerformanceSample>[];
      final runtime = _IdleAfterLongFrameRuntime();
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: runtime,
              inputEnabled: false,
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(samples, hasLength(1));

      final vsyncStart =
          tester.binding.currentSystemFrameTimeStamp.inMicroseconds + 100000;
      final state = tester.state(find.byType(PocketView));
      (state as dynamic).debugReportFrameTimings(<ui.FrameTiming>[
        ui.FrameTiming(
          vsyncStart: vsyncStart,
          buildStart: vsyncStart + 1000,
          buildFinish: vsyncStart + 80000,
          rasterStart: vsyncStart + 80000,
          rasterFinish: vsyncStart + 82000,
          rasterFinishWallTime: vsyncStart + 82000,
        ),
      ]);

      expect(samples, hasLength(1));
    },
  );

  testWidgets(
    'FrameTiming arriving before its active tick context pairs instead of emitting as unmatched',
    (tester) async {
      addTearDown(() {
        debugPocketNativeFrameDurationOverride = null;
      });
      final samples = <PocketPerformanceSample>[];
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: _PerformanceRuntime(),
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));

      final state = tester.state(find.byType(PocketView));
      final nextVsync =
          (tester.binding.currentSystemFrameTimeStamp +
                  const Duration(milliseconds: 16))
              .inMicroseconds;
      (state as dynamic).debugReportFrameTimings(<ui.FrameTiming>[
        ui.FrameTiming(
          vsyncStart: nextVsync,
          buildStart: nextVsync + 1000,
          buildFinish: nextVsync + 41000,
          rasterStart: nextVsync + 41000,
          rasterFinish: nextVsync + 45000,
          rasterFinishWallTime: nextVsync + 45000,
        ),
      ]);

      debugPocketNativeFrameDurationOverride = () =>
          const Duration(milliseconds: 30);
      await tester.pump(const Duration(milliseconds: 16));
      debugPocketNativeFrameDurationOverride = null;

      for (var index = 0; index < 100 && samples.isEmpty; index++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(samples, hasLength(1));
      expect(samples.single.longFrameEvents, hasLength(1));
      final event = samples.single.longFrameEvents.single;
      expect(event.buildMs, greaterThanOrEqualTo(40));
      expect(event.nativeMs, greaterThanOrEqualTo(30));
      expect(event.scope, 'flutterView');
    },
  );

  testWidgets(
    'accumulates diff, build and paint P95 fields when performance sampling is enabled',
    (tester) async {
      final samples = <PocketPerformanceSample>[];
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              runtime: _AnimatedPerformanceRuntime(),
              jsSource: '',
              pakBytes: Uint8List(0),
              showDebugFps: false,
              onPerformanceSample: samples.add,
            ),
          ),
        ),
      );
      await tester.pump();
      for (var index = 0; index < 80 && samples.isEmpty; index++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(samples, hasLength(1));
      final sample = samples.single;
      expect(sample.diffMsP95, greaterThan(0));
      expect(sample.buildMsP95, greaterThan(0));
      expect(sample.paintMsP95, greaterThan(0));
      expect(sample.decodeMsP95, greaterThanOrEqualTo(0));
    },
  );
}

final class _AnimatedPerformanceRuntime extends _PerformanceRuntime {
  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls++;
    return PocketFrame(
      width: 320,
      height: 480,
      ops: <PocketOp>[
        PocketRectOp(
          x: (frameCalls % 32).toDouble(),
          y: 0,
          width: 280,
          height: 480,
          color: 0xff101827 + (frameCalls & 0xff),
        ),
      ],
      events: const <PocketEvent>[],
    );
  }
}

class _PerformanceRuntime implements PocketRuntime {
  int frameCalls = 0;

  static const PocketFrame _frame = PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls++;
    return _frame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _IdleAfterLongFrameRuntime extends _PerformanceRuntime
    implements PocketRuntimeScheduling {
  bool _sleeping = false;

  @override
  double get nextWakeDelayMilliseconds => _sleeping ? -1 : 0;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    if (deltaMilliseconds >= 100) _sleeping = true;
    return super.frame(deltaMilliseconds);
  }
}

final class _ControllableIdleRuntime extends _PerformanceRuntime
    implements PocketRuntimeScheduling {
  _ControllableIdleRuntime({required this.sleeping});

  bool sleeping;

  @override
  double get nextWakeDelayMilliseconds => sleeping ? -1 : 0;
}

final class _IdleDeadlineRuntime extends _PerformanceRuntime
    implements PocketRuntimeScheduling {
  bool _sleeping = false;
  bool _diagnosticPending = false;
  bool diagnosticConsumed = false;

  @override
  double get nextWakeDelayMilliseconds {
    if (!_sleeping) return 0;
    return diagnosticConsumed ? -1 : 1000;
  }

  @override
  void send(Map<String, dynamic> message) {
    if (message['name'] == 'diagnostic') _diagnosticPending = true;
  }

  @override
  PocketFrame frame(int deltaMilliseconds) {
    if (_diagnosticPending) {
      _diagnosticPending = false;
      diagnosticConsumed = true;
      _sleeping = true;
    } else if (deltaMilliseconds >= 100) {
      _sleeping = true;
    }
    return super.frame(deltaMilliseconds);
  }
}
