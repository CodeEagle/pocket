import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'performance sample is immutable and serializes wall-clock metadata',
    () {
      final timestamp = DateTime.utc(2026, 11, 2, 3, 4, 5, 6000);
      final sample = PocketPerformanceSample(
        timestamp: timestamp,
        fps: 144,
        frames: 144,
        durationMs: 1008.25,
        maxGapMs: 42.0,
        slowFrames: 2,
        nativeMsP95: 1.75,
        refreshHz: 144,
      );

      expect(sample.toJson(), <String, dynamic>{
        'timestamp': timestamp.toIso8601String(),
        'fps': 144,
        'frames': 144,
        'durationMs': 1008.25,
        'maxGapMs': 42.0,
        'slowFrames': 2,
        'nativeMsP95': 1.75,
        'refreshHz': 144,
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
  });
}

final class _PerformanceRuntime implements PocketRuntime {
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
  PocketFrame frame(int deltaMilliseconds) => _frame;

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
