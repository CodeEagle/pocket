import 'package:flutter/foundation.dart';

/// One bounded renderer performance window emitted by [PocketView].
///
/// The window starts after runtime startup has completed and is reset after a
/// lifecycle pause/resume. It contains no history beyond this sample; hosts
/// that need a persistent history should store [toJson] results themselves.
@immutable
final class PocketPerformanceSample {
  const PocketPerformanceSample({
    required this.timestamp,
    required this.fps,
    required this.frames,
    required this.durationMs,
    required this.maxGapMs,
    required this.slowFrames,
    required this.nativeMsP95,
    required this.refreshHz,
  });

  /// Wall-clock time at which this sample was emitted, in UTC.
  final DateTime timestamp;

  /// Frames per second measured over [durationMs].
  final double fps;

  /// Number of ticker/native frames included in this sample.
  final int frames;

  /// Monotonic ticker duration covered by this sample, in milliseconds.
  final double durationMs;

  /// Largest observed gap between consecutive ticker callbacks, in
  /// milliseconds.
  final double maxGapMs;

  /// Number of frame gaps greater than 1.5 times the display frame budget.
  final int slowFrames;

  /// 95th percentile duration of the renderer bridge path, in milliseconds.
  ///
  /// The compatibility field name is `nativeMsP95`, but the measured path
  /// includes the FFI call, returned-string copy, and frame JSON decode when
  /// the concrete runtime uses the JSON ABI. It is not a pure native-CPU
  /// sample.
  final double nativeMsP95;

  /// Display refresh rate used for the frame-budget and slow-frame decision.
  final double refreshHz;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'timestamp': timestamp.toUtc().toIso8601String(),
    'fps': fps,
    'frames': frames,
    'durationMs': durationMs,
    'maxGapMs': maxGapMs,
    'slowFrames': slowFrames,
    'nativeMsP95': nativeMsP95,
    'refreshHz': refreshHz,
  };
}

/// Called by [PocketView] approximately once per measured second.
typedef PocketPerformanceSampleCallback =
    void Function(PocketPerformanceSample sample);
