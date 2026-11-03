import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';

import '../integration_test/frame_timing_collector.dart';

FrameTiming _timing({
  required int buildStartUs,
  required int rasterFinishUs,
  required int rasterFinishWallUs,
  int frameNumber = 1,
  int buildDurationUs = 1,
}) {
  return FrameTiming(
    vsyncStart: buildStartUs - 2000,
    buildStart: buildStartUs,
    buildFinish: buildStartUs + buildDurationUs,
    rasterStart: buildStartUs + buildDurationUs + 1,
    rasterFinish: rasterFinishUs,
    rasterFinishWallTime: rasterFinishWallUs,
    frameNumber: frameNumber,
  );
}

void main() {
  test('projects build start and includes exact window boundaries', () {
    final timing = _timing(
      buildStartUs: 10,
      rasterFinishUs: 18,
      rasterFinishWallUs: 1_008,
    );

    expect(FrameTimingCollector.projectedBuildStartWallTimeUs(timing), 1_000);
    expect(
      FrameTimingCollector.selectBuildWindow(
        <FrameTiming>[timing],
        startWallTimeUs: 1_000,
        endWallTimeUs: 1_000,
      ),
      hasLength(1),
    );
  });

  test('orders selected frames by source time, not callback batch order', () {
    final early = _timing(
      buildStartUs: 100,
      rasterFinishUs: 110,
      rasterFinishWallUs: 10_010,
      frameNumber: 1,
    );
    final middle = _timing(
      buildStartUs: 200,
      rasterFinishUs: 230,
      rasterFinishWallUs: 10_045,
      frameNumber: 2,
    );
    final late = _timing(
      buildStartUs: 300,
      rasterFinishUs: 305,
      rasterFinishWallUs: 10_035,
      frameNumber: 3,
    );

    final selected = FrameTimingCollector.selectBuildWindow(
      <FrameTiming>[middle, late, early],
      startWallTimeUs: 10_000,
      endWallTimeUs: 10_100,
    );

    expect(selected.map((timing) => timing.frameNumber), <int>[1, 2, 3]);
  });

  test(
    'uses recorded phase duration instead of a 16ms or refresh assumption',
    () {
      final shortFrame = _timing(
        buildStartUs: 1_000,
        rasterFinishUs: 1_003,
        rasterFinishWallUs: 20_003,
        frameNumber: 10,
      );
      final longFrame = _timing(
        buildStartUs: 2_000,
        rasterFinishUs: 2_027,
        rasterFinishWallUs: 20_027,
        frameNumber: 11,
      );

      final selected = FrameTimingCollector.selectBuildWindow(
        <FrameTiming>[longFrame, shortFrame],
        startWallTimeUs: 20_000,
        endWallTimeUs: 20_100,
      );

      expect(selected, hasLength(2));
      expect(
        FrameTimingCollector.projectedBuildStartWallTimeUs(longFrame),
        20_000,
      );
    },
  );

  test('rejects impossible raw phase or wall-clock values', () {
    final invalidDuration = _timing(
      buildStartUs: 100,
      rasterFinishUs: 90,
      rasterFinishWallUs: 10_000,
    );
    final invalidWall = _timing(
      buildStartUs: 100,
      rasterFinishUs: 110,
      rasterFinishWallUs: 0,
    );

    expect(FrameTimingCollector.hasSaneRawWallClock(invalidDuration), isFalse);
    expect(FrameTimingCollector.hasSaneRawWallClock(invalidWall), isFalse);
  });

  test('joins the slowest source frame to a complete Dart Frame span', () {
    final trace = <String, Object?>{
      'traceEvents': <Map<String, Object?>>[
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'b',
          'pid': 1,
          'tid': 2,
          'id': 'frame-1',
          'ts': 1_000,
        },
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'e',
          'pid': 1,
          'tid': 2,
          'id': 'frame-1',
          'ts': 2_000,
        },
        <String, Object?>{
          'cat': 'Other',
          'name': 'Frame',
          'ph': 'b',
          'pid': 1,
          'tid': 2,
          'id': 'other',
          'ts': 3_000,
        },
      ],
    };
    final slow = _timing(
      buildStartUs: 950,
      rasterFinishUs: 1_100,
      rasterFinishWallUs: 11_100,
      frameNumber: 2,
      buildDurationUs: 10,
    );
    final fast = _timing(
      buildStartUs: 4_000,
      rasterFinishUs: 4_100,
      rasterFinishWallUs: 14_100,
      frameNumber: 3,
    );

    final coverage = FrameTimingCollector.traceFrameCoverage(
      traceReport: trace,
      timings: <FrameTiming>[fast, slow],
    );

    expect(coverage.slowestFrameCovered, isTrue);
    expect(coverage.completeFrameCount, 1);
    expect(coverage.slowestBuildStartUs, 950);
    expect(coverage.matchedFrameStartUs, 1_000);
    expect(coverage.matchedFrameEndUs, 2_000);
  });

  test('does not treat an incomplete or unrelated Frame as coverage', () {
    final trace = <String, Object?>{
      'traceEvents': <Map<String, Object?>>[
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'b',
          'pid': 1,
          'tid': 2,
          'id': 'missing-end',
          'ts': 1_000,
        },
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'e',
          'pid': 9,
          'tid': 2,
          'id': 'missing-end',
          'ts': 2_000,
        },
        <String, Object?>{
          'cat': 'Flutter',
          'name': 'Flutter.Frame',
          'ph': 'X',
          'pid': 1,
          'tid': 2,
          'id': 'flutter-frame',
          'ts': 1_000,
          'dur': 5_000,
        },
      ],
    };
    final coverage = FrameTimingCollector.traceFrameCoverage(
      traceReport: trace,
      timings: <FrameTiming>[
        _timing(
          buildStartUs: 1_500,
          rasterFinishUs: 1_600,
          rasterFinishWallUs: 11_600,
        ),
      ],
    );

    expect(coverage.slowestFrameCovered, isFalse);
    expect(coverage.completeFrameCount, 0);
    expect(FrameTimingCollector.dartFrameIntervals(trace), isEmpty);
  });

  test('requires the slowest source frame, not merely any covered frame', () {
    final trace = <String, Object?>{
      'traceEvents': <Map<String, Object?>>[
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'b',
          'pid': 1,
          'tid': 2,
          'id': 'covered',
          'ts': 1_000,
        },
        <String, Object?>{
          'cat': 'Dart',
          'name': 'Frame',
          'ph': 'e',
          'pid': 1,
          'tid': 2,
          'id': 'covered',
          'ts': 2_000,
        },
      ],
    };
    final coveredFast = _timing(
      buildStartUs: 1_050,
      rasterFinishUs: 1_100,
      rasterFinishWallUs: 11_100,
      frameNumber: 1,
    );
    final missingSlow = _timing(
      buildStartUs: 10_000,
      rasterFinishUs: 10_200,
      rasterFinishWallUs: 20_200,
      frameNumber: 2,
      buildDurationUs: 10,
    );

    final coverage = FrameTimingCollector.traceFrameCoverage(
      traceReport: trace,
      timings: <FrameTiming>[coveredFast, missingSlow],
    );

    expect(coverage.slowestFrameCovered, isFalse);
    expect(coverage.slowestBuildStartUs, 10_000);
  });
}
