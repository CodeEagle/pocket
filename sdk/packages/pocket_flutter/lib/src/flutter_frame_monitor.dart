import 'dart:ui' show FramePhase, FrameTiming;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

double? _frameBudget(double? refreshRateHz) {
  if (refreshRateHz == null || !refreshRateHz.isFinite || refreshRateHz <= 0) {
    return null;
  }
  return 1000 / refreshRateHz;
}

/// A single engine frame retained by [FlutterFrameMonitorController].
///
/// [vsyncStartUs] is the source timestamp reported by the Flutter engine. It
/// is deliberately retained alongside the phase durations so a caller can
/// inspect the cadence window without reconstructing it from callback arrival
/// time.
final class FlutterFrameTimingSample {
  const FlutterFrameTimingSample({
    required this.vsyncStartUs,
    required this.uiMs,
    required this.rasterMs,
  });

  final int vsyncStartUs;
  final double uiMs;
  final double rasterMs;
}

/// A bounded source-time window of Flutter engine frame timings.
///
/// A window with fewer than two distinct source timestamps has no measurable
/// cadence, so [fps] is null. That is different from zero FPS: an idle app has
/// no frame sample to report, while a sparse app may have a deliberately low
/// measured cadence. Neither condition is converted into a jank event.
final class FlutterFrameWindow {
  FlutterFrameWindow._({
    required List<FlutterFrameTimingSample> samples,
    required this.displayRefreshRateHz,
  }) : samples = List<FlutterFrameTimingSample>.unmodifiable(samples),
       frameCount = samples.length,
       frameBudgetMs = _frameBudget(displayRefreshRateHz),
       firstVsyncStartUs = samples.isEmpty ? null : samples.first.vsyncStartUs,
       lastVsyncStartUs = samples.isEmpty ? null : samples.last.vsyncStartUs,
       uiMs = _average(samples.map((sample) => sample.uiMs)),
       rasterMs = _average(samples.map((sample) => sample.rasterMs)),
       latestUiMs = samples.isEmpty ? null : samples.last.uiMs,
       latestRasterMs = samples.isEmpty ? null : samples.last.rasterMs,
       uiP95Ms = _percentile(samples.map((sample) => sample.uiMs), .95),
       rasterP95Ms = _percentile(samples.map((sample) => sample.rasterMs), .95),
       jankCount = _countJank(samples, _frameBudget(displayRefreshRateHz)),
       fps = _fps(samples);

  /// Returns an empty window when the collector has not received a frame.
  factory FlutterFrameWindow.empty({double? displayRefreshRateHz}) {
    return FlutterFrameWindow._(
      samples: const <FlutterFrameTimingSample>[],
      displayRefreshRateHz: displayRefreshRateHz,
    );
  }

  /// Raw samples in ascending [FlutterFrameTimingSample.vsyncStartUs] order.
  final List<FlutterFrameTimingSample> samples;

  final int? firstVsyncStartUs;
  final int? lastVsyncStartUs;

  final int frameCount;
  final double? displayRefreshRateHz;
  final double? frameBudgetMs;

  /// Observed cadence: `(frameCount - 1) / source-time span`.
  ///
  /// This intentionally counts frame intervals instead of dividing the frame
  /// count by the total span, and it has no 60 FPS ceiling.
  final double? fps;

  /// Mean build and raster phase durations in this window.
  final double? uiMs;
  final double? rasterMs;

  /// The most recently received phase durations in this window.
  final double? latestUiMs;
  final double? latestRasterMs;

  /// Nearest-rank p95 phase durations in this window.
  final double? uiP95Ms;
  final double? rasterP95Ms;

  /// Number of frames whose build or raster phase exceeded the display budget.
  /// Source timestamp gaps are not considered jank.
  final int jankCount;

  bool get hasCadence => fps != null;

  bool get isEmpty => frameCount == 0;

  static double? _fps(List<FlutterFrameTimingSample> samples) {
    if (samples.length < 2) return null;
    final sourceSpanUs = samples.last.vsyncStartUs - samples.first.vsyncStartUs;
    if (sourceSpanUs <= 0) return null;
    return (samples.length - 1) * 1000000 / sourceSpanUs;
  }

  static int _countJank(
    List<FlutterFrameTimingSample> samples,
    double? budgetMs,
  ) {
    if (budgetMs == null) return 0;
    return samples
        .where((sample) => sample.uiMs > budgetMs || sample.rasterMs > budgetMs)
        .length;
  }

  static double? _average(Iterable<double> values) {
    final list = values.toList(growable: false);
    if (list.isEmpty) return null;
    return list.reduce((a, b) => a + b) / list.length;
  }

  static double? _percentile(Iterable<double> values, double fraction) {
    final list = values.toList()..sort();
    if (list.isEmpty) return null;
    final rank = (list.length * fraction).ceil();
    final boundedRank = rank < 1
        ? 1
        : rank > list.length
        ? list.length
        : rank;
    return list[boundedRank - 1];
  }
}

/// Owns a passive Flutter engine timing collector.
///
/// The collector only receives [FrameTiming] batches and updates immutable
/// snapshots. It does not notify widgets, schedule frames, start a ticker, or
/// run a timer. A widget can observe [version] from a persistent-frame
/// callback, while integration tests can call [debugReportTimings] with
/// deterministic source timestamps.
final class FlutterFrameMonitorController {
  FlutterFrameMonitorController({
    SchedulerBinding? binding,
    Duration windowDuration = const Duration(seconds: 1),
    int maxSamples = 1024,
    int maxHistory = 60,
    bool autoStart = true,
    double? displayRefreshRateHz,
  }) : assert(windowDuration > Duration.zero),
       assert(maxSamples >= 2 && maxSamples <= 1024),
       assert(maxHistory >= 1),
       _binding = binding,
       _windowDurationUs = windowDuration.inMicroseconds,
       _maxSamples = maxSamples,
       _maxHistory = maxHistory,
       _displayRefreshRateHz = _sanitizeRefreshRate(displayRefreshRateHz),
       _latest = FlutterFrameWindow.empty(
         displayRefreshRateHz: _sanitizeRefreshRate(displayRefreshRateHz),
       ) {
    if (autoStart) attach();
  }

  final SchedulerBinding? _binding;
  final int _windowDurationUs;
  final int _maxSamples;
  final int _maxHistory;
  final List<FlutterFrameTimingSample> _samples = <FlutterFrameTimingSample>[];
  final List<FlutterFrameWindow> _history = <FlutterFrameWindow>[];
  int? _sourceWatermarkUs;

  SchedulerBinding? _attachedBinding;
  FlutterFrameWindow _latest;
  double? _displayRefreshRateHz;
  int _version = 0;
  int _totalFrames = 0;
  int _longFrameCount = 0;
  int _windowGeneration = 0;
  bool _disposed = false;

  /// Number of accepted source frames since the controller was reset.
  int get totalFrames => _totalFrames;

  /// Number of over-budget frames accepted since the controller was reset.
  ///
  /// [FlutterFrameWindow.jankCount] remains the current bounded-window count;
  /// this value is cumulative for integration probes.
  int get longFrameCount => _longFrameCount;

  /// Monotonically increases whenever a timing or display-budget snapshot
  /// changes.
  int get version => _version;

  bool get isAttached => _attachedBinding != null;

  bool get isDisposed => _disposed;

  Duration get windowDuration => Duration(microseconds: _windowDurationUs);

  double? get displayRefreshRateHz => _displayRefreshRateHz;

  FlutterFrameWindow get latest => _latest;

  /// Bounded snapshots, newest last. Each snapshot covers only the recent
  /// source-time window; there is no minimum-FPS aggregate, so an idle
  /// interval cannot poison a persistent minimum value.
  List<FlutterFrameWindow> get history =>
      List<FlutterFrameWindow>.unmodifiable(_history);

  /// Attaches the passive [FrameTiming] callback exactly once.
  void attach() {
    if (_disposed || isAttached) return;
    final binding = _binding ?? SchedulerBinding.instance;
    binding.addTimingsCallback(_onTimings);
    _attachedBinding = binding;
  }

  /// Detaches the passive callback. The controller's samples remain readable.
  void detach() {
    final binding = _attachedBinding;
    if (binding == null) return;
    binding.removeTimingsCallback(_onTimings);
    _attachedBinding = null;
  }

  /// Releases the binding callback without clearing the last snapshot.
  void dispose() {
    if (_disposed) return;
    detach();
    _disposed = true;
  }

  /// Clears the current bounded timing window and its history.
  ///
  /// This is explicit rather than time-based: there is no idle timer and no
  /// automatic rewrite of an idle interval into a synthetic 60 FPS sample.
  void reset() {
    if (_disposed) return;
    _samples.clear();
    _history.clear();
    _sourceWatermarkUs = null;
    _totalFrames = 0;
    _longFrameCount = 0;
    _windowGeneration++;
    _latest = FlutterFrameWindow.empty(
      displayRefreshRateHz: _displayRefreshRateHz,
    );
    _version++;
  }

  /// Updates the display budget source used for phase jank classification.
  ///
  /// The widget supplies `View.of(context).display.refreshRate`; an
  /// integration test may inject a known display rate before reporting
  /// timings. This does not manufacture an FPS value.
  void setDisplayRefreshRateHz(double? refreshRateHz) {
    final next = _sanitizeRefreshRate(refreshRateHz);
    if (next == _displayRefreshRateHz) return;
    _displayRefreshRateHz = next;
    _latest = _snapshot();
    _version++;
  }

  /// Test/integration seam for a real [FrameTiming] batch.
  ///
  /// Production delivery enters through [SchedulerBinding.addTimingsCallback].
  /// This method intentionally has no widget side effects and exists so tests
  /// can cover split callback batches without synthesizing a ticker or timer.
  @visibleForTesting
  void debugReportTimings(Iterable<FrameTiming> timings) {
    _onTimings(timings.toList(growable: false));
  }

  void _onTimings(List<FrameTiming> timings) {
    if (_disposed || timings.isEmpty) return;

    final orderedTimings = List<FrameTiming>.of(timings)
      ..sort((a, b) => _vsyncStartUs(a).compareTo(_vsyncStartUs(b)));
    var accepted = false;
    for (final timing in orderedTimings) {
      final vsyncStartUs = _vsyncStartUs(timing);
      // FrameTiming batches are source ordered, but delivery can be split or
      // duplicated. Keep a monotonic source watermark so a sample evicted from
      // the one-second window cannot be counted again later.
      if (_sourceWatermarkUs != null && vsyncStartUs <= _sourceWatermarkUs!) {
        continue;
      }

      final uiMs = timing.buildDuration.inMicroseconds / 1000;
      final rasterMs = timing.rasterDuration.inMicroseconds / 1000;
      _samples.add(
        FlutterFrameTimingSample(
          vsyncStartUs: vsyncStartUs,
          uiMs: uiMs,
          rasterMs: rasterMs,
        ),
      );
      _sourceWatermarkUs = vsyncStartUs;
      _totalFrames++;
      final budgetMs = _frameBudget(_displayRefreshRateHz);
      if (budgetMs != null && (uiMs > budgetMs || rasterMs > budgetMs)) {
        _longFrameCount++;
      }
      accepted = true;
    }
    if (!accepted) return;

    final latestVsyncStartUs = _samples.last.vsyncStartUs;
    final firstVsyncStartUs = latestVsyncStartUs - _windowDurationUs;
    _samples.removeWhere((sample) {
      return sample.vsyncStartUs < firstVsyncStartUs;
    });
    while (_samples.length > _maxSamples) {
      _samples.removeAt(0);
    }

    _latest = _snapshot();
    _history.add(_latest);
    while (_history.length > _maxHistory) {
      _history.removeAt(0);
    }
    _version++;
  }

  static int _vsyncStartUs(FrameTiming timing) =>
      timing.timestampInMicroseconds(FramePhase.vsyncStart);

  FlutterFrameWindow _snapshot() {
    return FlutterFrameWindow._(
      samples: _samples,
      displayRefreshRateHz: _displayRefreshRateHz,
    );
  }

  static double? _sanitizeRefreshRate(double? refreshRateHz) {
    if (refreshRateHz == null ||
        !refreshRateHz.isFinite ||
        refreshRateHz <= 0) {
      return null;
    }
    return refreshRateHz;
  }
}

/// A Flutter-only HUD that observes [FlutterFrameMonitorController] without
/// driving the engine.
///
/// The persistent callback is installed once per process by a weak-reference
/// dispatcher. Flutter 3.35 documents that persistent callbacks are observers
/// of an already-running frame and that [SchedulerBinding.ensureVisualUpdate]
/// is a no-op during the persistent phase. Consequently, the HUD may mark
/// itself dirty for the next real app frame, but it never schedules one from a
/// timing callback or from its own update.
final class FlutterFrameMonitor extends StatefulWidget {
  const FlutterFrameMonitor({
    super.key,
    required this.child,
    this.controller,
    this.enabled = true,
  });

  final Widget child;
  final FlutterFrameMonitorController? controller;
  final bool enabled;

  @override
  State<FlutterFrameMonitor> createState() => _FlutterFrameMonitorState();

  /// Visible only for widget tests that verify weak subscription cleanup.
  @visibleForTesting
  static int get debugSubscriberCount =>
      _FlutterFrameMonitorDispatcher.instance.liveSubscriberCount;
}

final class _FlutterFrameMonitorState extends State<FlutterFrameMonitor> {
  late FlutterFrameMonitorController _controller;
  late _FlutterFrameMonitorPainter _hudPainter;
  FlutterFrameMonitorController? _ownedController;
  final GlobalKey _hudPaintKey = GlobalKey();
  bool _detachControllerOnDispose = false;
  bool _subscribed = false;
  bool _disposed = false;
  int _paintedVersion = -1;
  int? _lastHudPaintSourceUs;
  int _paintedWindowGeneration = -1;

  static const int _hudPaintIntervalUs = 500000;

  bool get mountedForDispatcher => mounted && !_disposed && widget.enabled;

  @override
  void initState() {
    super.initState();
    _selectController(widget.controller);
    _hudPainter = _FlutterFrameMonitorPainter(controller: _controller);
    _syncAttachment();
    _syncSubscription();
  }

  @override
  void didUpdateWidget(covariant FlutterFrameMonitor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _hudPainter.dispose();
      _releaseController(oldWidget.controller);
      _selectController(widget.controller);
      _hudPainter = _FlutterFrameMonitorPainter(controller: _controller);
      _paintedVersion = -1;
      _lastHudPaintSourceUs = null;
      _paintedWindowGeneration = -1;
    }
    _syncAttachment();
    _syncSubscription();
  }

  @override
  void dispose() {
    _disposed = true;
    _unsubscribe();
    _releaseController(widget.controller);
    _hudPainter.dispose();
    super.dispose();
  }

  void _selectController(FlutterFrameMonitorController? supplied) {
    if (supplied != null) {
      _controller = supplied;
      return;
    }
    final owned = FlutterFrameMonitorController(autoStart: false);
    _ownedController = owned;
    _controller = owned;
  }

  void _syncAttachment() {
    if (!widget.enabled) {
      if (_detachControllerOnDispose) {
        _controller.detach();
        _detachControllerOnDispose = false;
      }
      return;
    }
    if (_controller.isAttached) return;
    _controller.attach();
    _detachControllerOnDispose = true;
  }

  void _releaseController(FlutterFrameMonitorController? supplied) {
    if (_detachControllerOnDispose) {
      _controller.detach();
      _detachControllerOnDispose = false;
    }
    if (supplied == null && _ownedController != null) {
      _ownedController!.dispose();
      _ownedController = null;
    }
  }

  void _syncSubscription() {
    if (widget.enabled && !_subscribed) {
      _paintedVersion = -1;
      _lastHudPaintSourceUs = null;
      _paintedWindowGeneration = -1;
      _FlutterFrameMonitorDispatcher.instance.subscribe(this);
      _subscribed = true;
    } else if (!widget.enabled && _subscribed) {
      _unsubscribe();
    }
  }

  void _unsubscribe() {
    if (!_subscribed) return;
    _FlutterFrameMonitorDispatcher.instance.unsubscribe(this);
    _subscribed = false;
  }

  void _onPersistentFrame() {
    if (!mountedForDispatcher) return;
    final nextVersion = _controller.version;
    if (nextVersion == _paintedVersion) return;
    if (_paintedWindowGeneration != _controller._windowGeneration) {
      _lastHudPaintSourceUs = null;
      _paintedWindowGeneration = _controller._windowGeneration;
    }
    final window = _controller.latest;
    if (window.isEmpty) {
      _lastHudPaintSourceUs = null;
    }
    final renderObject = _hudPaintKey.currentContext?.findRenderObject();
    if (renderObject == null) return;
    // This callback runs during SchedulerPhase.persistentCallbacks. In Flutter
    // 3.35, ensureVisualUpdate() is a no-op in this phase. Marking only the
    // independent HUD render layer dirty avoids leaving BuildOwner dirty while
    // still painting the latest sample in the next real frame.
    _paintedVersion = nextVersion;
    final sourceUs = window.lastVsyncStartUs;
    if (sourceUs != null &&
        _lastHudPaintSourceUs != null &&
        sourceUs - _lastHudPaintSourceUs! < _hudPaintIntervalUs) {
      return;
    }
    _lastHudPaintSourceUs = sourceUs;
    renderObject.markNeedsPaint();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled) return widget.child;
    _controller.setDisplayRefreshRateHz(View.of(context).display.refreshRate);

    final mediaQuery = MediaQuery.of(context);
    final viewSize = mediaQuery.size;

    return LayoutBuilder(
      builder: (context, constraints) {
        final layoutSize = constraints.biggest;
        // An embedded preview can inherit the physical view's bottom inset
        // while ending above that view's bottom edge. Keep the badge out of
        // the preview content unless this layer actually fills the view.
        final coversFullView =
            layoutSize.width.isFinite &&
            layoutSize.height.isFinite &&
            (layoutSize.width - viewSize.width).abs() <= 0.5 &&
            (layoutSize.height - viewSize.height).abs() <= 0.5;
        final useBottomBadge =
            coversFullView && mediaQuery.viewPadding.bottom > 0;
        final hudAlignment = useBottomBadge
            ? Alignment.bottomLeft
            : Alignment.topRight;
        final hudPadding = useBottomBadge
            ? const EdgeInsets.only(left: 12, bottom: 6)
            : const EdgeInsets.only(top: 6, right: 6);

        return Stack(
          fit: StackFit.expand,
          children: <Widget>[
            widget.child,
            Positioned.fill(
              child: IgnorePointer(
                child: SafeArea(
                  top: !useBottomBadge,
                  right: !useBottomBadge,
                  bottom: useBottomBadge,
                  left: false,
                  child: Align(
                    alignment: hudAlignment,
                    child: Padding(
                      padding: hudPadding,
                      child: RepaintBoundary(
                        key: const ValueKey<String>(
                          'flutter-frame-monitor-hud',
                        ),
                        child: CustomPaint(
                          key: _hudPaintKey,
                          size: const Size(106, 22),
                          painter: _hudPainter,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

final class _FlutterFrameMonitorPainter extends CustomPainter {
  _FlutterFrameMonitorPainter({required this.controller})
    : _textPainter = _makeTextPainter(_textStyle);

  final FlutterFrameMonitorController controller;
  final TextPainter _textPainter;
  String? _text;
  double _lastTextWidth = -1;
  bool _disposed = false;

  static const TextStyle _textStyle = TextStyle(
    color: Color(0xff334155),
    fontSize: 10,
    fontWeight: FontWeight.w600,
    fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
  );

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _textPainter.dispose();
  }

  @override
  void paint(Canvas canvas, Size size) {
    if (_disposed) return;
    final window = controller.latest;
    final fps = window.fps?.toStringAsFixed(0);
    final text = fps == null ? 'Flutter idle' : 'Flutter $fps FPS';
    final textWidth = size.width > 26 ? size.width - 26 : 0.0;

    final textWidthChanged = _lastTextWidth != textWidth;
    final textChanged = _text != text;
    if (textChanged) {
      _text = text;
      _textPainter.text = TextSpan(text: text, style: _textStyle);
    }
    _lastTextWidth = textWidth;
    if (textChanged || textWidthChanged) {
      _textPainter.layout(maxWidth: textWidth);
    }

    final shape = RRect.fromRectAndRadius(
      Offset.zero & size,
      Radius.circular(size.height / 2),
    );
    final background = Paint()..color = const Color(0xfff8fafc);
    canvas.drawRRect(shape, background);
    final border = Paint()
      ..color = const Color(0xffcbd5e1)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    canvas.drawRRect(shape.deflate(0.5), border);

    final dot = Paint()
      ..color = window.fps == null
          ? const Color(0xff16a34a)
          : const Color(0xff2563eb);
    canvas.drawCircle(Offset(10, size.height / 2), 3, dot);
    _textPainter.paint(
      canvas,
      Offset(18, (size.height - _textPainter.height) / 2),
    );
  }

  @override
  bool shouldRepaint(covariant _FlutterFrameMonitorPainter oldPainter) {
    return oldPainter.controller != controller;
  }

  static TextPainter _makeTextPainter(TextStyle style) {
    return TextPainter(
      text: TextSpan(style: style),
      textDirection: TextDirection.ltr,
      maxLines: 1,
      ellipsis: '…',
    );
  }
}

final class _FlutterFrameMonitorDispatcher {
  _FlutterFrameMonitorDispatcher._();

  static final _FlutterFrameMonitorDispatcher instance =
      _FlutterFrameMonitorDispatcher._();

  final List<WeakReference<_FlutterFrameMonitorState>> _subscribers =
      <WeakReference<_FlutterFrameMonitorState>>[];
  bool _installed = false;

  int get liveSubscriberCount {
    _prune();
    return _subscribers.length;
  }

  void subscribe(_FlutterFrameMonitorState state) {
    _prune();
    for (final reference in _subscribers) {
      if (identical(reference.target, state)) return;
    }
    if (!_installed) {
      SchedulerBinding.instance.addPersistentFrameCallback(_onPersistentFrame);
      _installed = true;
    }
    _subscribers.add(WeakReference<_FlutterFrameMonitorState>(state));
  }

  void unsubscribe(_FlutterFrameMonitorState state) {
    _subscribers.removeWhere(
      (reference) =>
          reference.target == null || identical(reference.target, state),
    );
  }

  void _onPersistentFrame(Duration _) {
    if (_subscribers.isEmpty) return;
    _prune();
    if (_subscribers.isEmpty) return;
    for (final reference in _subscribers) {
      reference.target?._onPersistentFrame();
    }
  }

  void _prune() {
    _subscribers.removeWhere((reference) => reference.target == null);
  }
}
