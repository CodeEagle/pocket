import 'package:flutter/foundation.dart';

/// A single active long-frame diagnostic emitted by [PocketView].
///
/// The event is deliberately a flat transport record rather than a Dart
/// page/action model. A host can attach the latest JS-owned diagnostic
/// context when it persists the record. Optional phase fields are omitted
/// when Flutter/native did not provide that measurement for the frame.
@immutable
final class PocketLongFrameEvent {
  const PocketLongFrameEvent({
    required this.timestamp,
    required this.refreshHz,
    required this.budgetMs,
    this.buildMs,
    this.rasterMs,
    this.nativeMs,
    this.activeGapMs,
    this.active = true,
    this.context,
    this.scope = 'pocketView',
  });

  /// Wall-clock time associated with the active scheduler frame.
  final DateTime timestamp;

  /// Display refresh rate used to derive [budgetMs].
  final double refreshHz;

  /// One display frame budget (`1000 / refreshHz`) in milliseconds.
  final double budgetMs;

  /// Flutter UI-thread build duration, when a [FrameTiming] was available.
  final double? buildMs;

  /// Flutter raster-thread duration, when a [FrameTiming] was available.
  final double? rasterMs;

  /// PocketJS/native bridge duration measured around the active frame call.
  final double? nativeMs;

  /// Gap between active PocketView ticker callbacks. Intentional idle sleep is
  /// excluded and therefore cannot become a false jank event.
  final double? activeGapMs;

  /// Always true for events emitted by PocketView. Keeping the marker in the
  /// record makes the idle-vs-active contract explicit to persisted consumers.
  final bool active;

  /// Optional JS-owned route/action diagnostic context.
  final String? context;

  /// Attribution scope for the measurements. `pocketView` is local bridge /
  /// active-gap data; `flutterView` marks global FrameTiming UI/raster data.
  final String scope;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'timestamp': timestamp.toUtc().toIso8601String(),
    'refreshHz': refreshHz,
    'budgetMs': budgetMs,
    if (buildMs != null) 'buildMs': buildMs,
    if (rasterMs != null) 'rasterMs': rasterMs,
    if (nativeMs != null) 'nativeMs': nativeMs,
    if (activeGapMs != null) 'activeGapMs': activeGapMs,
    'active': active,
    if (context != null && context!.isNotEmpty) 'context': context,
    'scope': scope,
  };

  PocketLongFrameEvent copyWith({
    double? buildMs,
    double? rasterMs,
    double? nativeMs,
    double? activeGapMs,
    String? context,
  }) => PocketLongFrameEvent(
    timestamp: timestamp,
    refreshHz: refreshHz,
    budgetMs: budgetMs,
    buildMs: buildMs ?? this.buildMs,
    rasterMs: rasterMs ?? this.rasterMs,
    nativeMs: nativeMs ?? this.nativeMs,
    activeGapMs: activeGapMs ?? this.activeGapMs,
    active: active,
    context: context ?? this.context,
    scope: scope,
  );
}

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
    this.longFrameEvents = const <PocketLongFrameEvent>[],
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

  /// Active long-frame events observed during this measurement window.
  ///
  /// This list is intentionally bounded by PocketView and copied by the
  /// transport serializer. Idle ticker parking never contributes an event.
  final List<PocketLongFrameEvent> longFrameEvents;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'timestamp': timestamp.toUtc().toIso8601String(),
    'fps': fps,
    'frames': frames,
    'durationMs': durationMs,
    'maxGapMs': maxGapMs,
    'slowFrames': slowFrames,
    'nativeMsP95': nativeMsP95,
    'refreshHz': refreshHz,
    if (longFrameEvents.isNotEmpty)
      'longFrameEvents': longFrameEvents
          .map((event) => event.toJson())
          .toList(growable: false),
  };
}

/// Called by [PocketView] approximately once per measured second.
typedef PocketPerformanceSampleCallback =
    void Function(PocketPerformanceSample sample);
