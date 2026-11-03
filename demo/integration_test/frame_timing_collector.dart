import 'dart:ui';

import 'package:flutter/scheduler.dart';

final class TraceFrameInterval {
  const TraceFrameInterval({required this.startUs, required this.endUs});

  final int startUs;
  final int endUs;
}

final class TraceFrameCoverage {
  const TraceFrameCoverage({
    required this.slowestFrameCovered,
    required this.completeFrameCount,
    this.slowestBuildStartUs,
    this.matchedFrameStartUs,
    this.matchedFrameEndUs,
  });

  final bool slowestFrameCovered;
  final int completeFrameCount;
  final int? slowestBuildStartUs;
  final int? matchedFrameStartUs;
  final int? matchedFrameEndUs;
}

/// Collects engine timings for the lifetime of an integration test.
///
/// Timings callbacks are delivery batches, not scene boundaries. Callers must
/// flush before starting a scene and use [timingsInBuildWindow] to assign
/// frames by a projected wall-clock build-start timestamp rather than by
/// callback arrival time.
final class FrameTimingCollector {
  /// The observed source-to-timeline offset is sub-millisecond. Keep this
  /// explicit rather than pretending the two event producers have identical
  /// dispatch points.
  static const int traceBuildStartOffsetAllowanceUs = 1000;

  FrameTimingCollector({SchedulerBinding? binding})
    : _binding = binding ?? SchedulerBinding.instance {
    _binding.addTimingsCallback(_onTimings);
  }

  final SchedulerBinding _binding;
  final List<FrameTiming> _timings = <FrameTiming>[];
  bool _disposed = false;

  void _onTimings(List<FrameTiming> timings) {
    if (!_disposed) {
      _timings.addAll(timings);
    }
  }

  /// Follows the same pre-action drain principle as
  /// `IntegrationTestWidgetsFlutterBinding.watchPerformance`.
  ///
  /// The callback stays installed, so frames delivered during the drain are
  /// retained only until this method clears them. The next scene is then
  /// assigned by each frame's source timestamp, not by callback delivery.
  Future<void> flushBeforeWindow() async {
    await Future<void>.delayed(const Duration(seconds: 2));
    _timings.clear();
  }

  /// Allows the engine's final delayed timing batch to arrive.
  ///
  /// Profile/debug delivery is normally much faster; 2s follows the
  /// approximately once-per-second release delivery and drain used by
  /// Flutter's official performance helper.
  Future<void> waitForDelayedBatch() async {
    await Future<void>.delayed(const Duration(seconds: 2));
  }

  List<FrameTiming> timingsInBuildWindow({
    required int startWallTimeUs,
    required int endWallTimeUs,
  }) {
    return selectBuildWindow(
      _timings,
      startWallTimeUs: startWallTimeUs,
      endWallTimeUs: endWallTimeUs,
    );
  }

  static List<FrameTiming> selectBuildWindow(
    Iterable<FrameTiming> timings, {
    required int startWallTimeUs,
    required int endWallTimeUs,
  }) {
    final selected = <FrameTiming>[
      for (final timing in timings)
        if (_buildStartedBetween(
          timing,
          startWallTimeUs: startWallTimeUs,
          endWallTimeUs: endWallTimeUs,
        ))
          timing,
    ];
    // A callback batch is sorted, but keep the result source-ordered even if
    // batches arrive in an unexpected order.
    selected.sort(
      (a, b) => projectedBuildStartWallTimeUs(
        a,
      )!.compareTo(projectedBuildStartWallTimeUs(b)!),
    );
    return selected;
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _binding.removeTimingsCallback(_onTimings);
  }

  static int? projectedBuildStartWallTimeUs(FrameTiming timing) {
    final buildStartUs = timing.timestampInMicroseconds(FramePhase.buildStart);
    final rasterFinishUs = timing.timestampInMicroseconds(
      FramePhase.rasterFinish,
    );
    final rasterFinishWallTimeUs = timing.timestampInMicroseconds(
      FramePhase.rasterFinishWallTime,
    );
    if (rasterFinishWallTimeUs <= 0 || rasterFinishUs < buildStartUs) {
      return null;
    }
    return rasterFinishWallTimeUs - (rasterFinishUs - buildStartUs);
  }

  static bool hasSaneRawWallClock(FrameTiming timing) {
    return projectedBuildStartWallTimeUs(timing) != null;
  }

  /// Checks whether the slowest source frame has a complete Dart Frame span
  /// in a trace report. FrameTiming callbacks and timeline events are
  /// separate delivery streams, so this is a source-time join, not a callback
  /// arrival join.
  static TraceFrameCoverage traceFrameCoverage({
    required Object? traceReport,
    required Iterable<FrameTiming> timings,
    int allowedBuildStartOffsetUs = traceBuildStartOffsetAllowanceUs,
  }) {
    final sourceFrames = timings.toList(growable: false)
      ..sort(
        (a, b) => b.buildDuration.inMicroseconds.compareTo(
          a.buildDuration.inMicroseconds,
        ),
      );
    final slowest = sourceFrames.isEmpty ? null : sourceFrames.first;
    final slowestBuildStartUs = slowest?.timestampInMicroseconds(
      FramePhase.buildStart,
    );
    final intervals = dartFrameIntervals(traceReport);

    if (slowestBuildStartUs == null || intervals.isEmpty) {
      return TraceFrameCoverage(
        slowestFrameCovered: false,
        completeFrameCount: intervals.length,
        slowestBuildStartUs: slowestBuildStartUs,
      );
    }

    TraceFrameInterval? matched;
    var matchedDistance = 1 << 62;
    for (final interval in intervals) {
      final lower = interval.startUs - allowedBuildStartOffsetUs;
      final upper = interval.endUs + allowedBuildStartOffsetUs;
      if (slowestBuildStartUs < lower || slowestBuildStartUs > upper) {
        continue;
      }
      final distance = (slowestBuildStartUs - interval.startUs).abs();
      if (matched?.startUs == null || distance < matchedDistance) {
        matched = interval;
        matchedDistance = distance;
      }
    }

    return TraceFrameCoverage(
      slowestFrameCovered: matched != null,
      completeFrameCount: intervals.length,
      slowestBuildStartUs: slowestBuildStartUs,
      matchedFrameStartUs: matched?.startUs,
      matchedFrameEndUs: matched?.endUs,
    );
  }

  /// Returns complete `cat=Dart,name=Frame` b/e intervals from a trace report.
  /// The key deliberately includes pid, tid, id, and name so unrelated spans
  /// cannot close each other when events are batched or interleaved.
  static List<TraceFrameInterval> dartFrameIntervals(Object? traceReport) {
    if (traceReport is! Map) return const <TraceFrameInterval>[];
    final rawEvents = traceReport['traceEvents'];
    if (rawEvents is! Iterable) return const <TraceFrameInterval>[];

    final open = <String, List<int>>{};
    final intervals = <TraceFrameInterval>[];
    for (final rawEvent in rawEvents) {
      if (rawEvent is! Map ||
          rawEvent['cat'] != 'Dart' ||
          rawEvent['name'] != 'Frame') {
        continue;
      }
      final timestamp = _traceTimestamp(rawEvent['ts']);
      if (timestamp == null) continue;
      final phase = rawEvent['ph'];
      final key = _traceEventKey(rawEvent);
      if (phase == 'b' || phase == 'B') {
        (open[key] ??= <int>[]).add(timestamp);
      } else if (phase == 'e' || phase == 'E') {
        final starts = open[key];
        if (starts == null || starts.isEmpty) continue;
        final start = starts.removeLast();
        if (timestamp > start) {
          intervals.add(TraceFrameInterval(startUs: start, endUs: timestamp));
        }
      }
    }
    intervals.sort((a, b) => a.startUs.compareTo(b.startUs));
    return intervals;
  }

  static String _traceEventKey(Map event) {
    return '${event['pid']}|${event['tid']}|${event['id']}|${event['name']}';
  }

  static int? _traceTimestamp(Object? value) {
    if (value is num) return value.toInt();
    return int.tryParse('$value');
  }

  static bool _buildStartedBetween(
    FrameTiming timing, {
    required int startWallTimeUs,
    required int endWallTimeUs,
  }) {
    final buildStartWallTimeUs = projectedBuildStartWallTimeUs(timing);
    return buildStartWallTimeUs != null &&
        buildStartWallTimeUs >= startWallTimeUs &&
        buildStartWallTimeUs <= endWallTimeUs;
  }
}
