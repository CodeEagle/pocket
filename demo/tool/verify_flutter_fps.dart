import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pocket_host/flutter_frame_monitor.dart';

const _warmupDuration = Duration(seconds: 3);
const _stallDuration = Duration(seconds: 3);
const _idleDrainDuration = Duration(seconds: 2);
const _idleObservationDuration = Duration(seconds: 2);
const _firstFrameTimeout = Duration(seconds: 10);
const _activeHudOffDuration = Duration(seconds: 3);

/// A real Flutter animation workload shared by the standalone verifier and
/// the integration-test wrapper.
final class FlutterFpsWorkload extends StatefulWidget {
  const FlutterFpsWorkload({
    super.key,
    this.animationDuration = const Duration(seconds: 2),
  });

  final Duration animationDuration;

  @override
  FlutterFpsWorkloadState createState() => FlutterFpsWorkloadState();
}

/// State handle for [FlutterFpsWorkload].
///
/// The public [stall] setter is intentionally available to the integration
/// test, while [setStall] makes the state transition explicit to this tool.
final class FlutterFpsWorkloadState extends State<FlutterFpsWorkload>
    with SingleTickerProviderStateMixin {
  late final AnimationController _animation;
  bool _stall = false;

  bool get stall => _stall;

  set stall(bool value) => setStall(value);

  bool get isAnimating => _animation.isAnimating;

  @override
  void initState() {
    super.initState();
    _animation = AnimationController(
      vsync: this,
      duration: widget.animationDuration,
    )..repeat();
  }

  void setStall(bool value) {
    if (_stall == value) return;
    if (!mounted) {
      _stall = value;
      return;
    }
    setState(() {
      _stall = value;
    });
  }

  void start() {
    if (!_animation.isAnimating) _animation.repeat();
  }

  void stop() {
    _animation.stop();
  }

  @override
  Widget build(BuildContext context) => Center(
    child: AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        if (_stall) {
          final stopwatch = Stopwatch()..start();
          while (stopwatch.elapsedMilliseconds < 45) {
            // Deliberately occupy the Flutter UI isolate during build.
          }
        }
        return Transform.translate(
          offset: Offset(_animation.value * 100, 0),
          child: child,
        );
      },
      child: const SizedBox(
        width: 80,
        height: 80,
        child: ColoredBox(color: Colors.blue),
      ),
    ),
  );

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }
}

final class _VerificationHost extends StatefulWidget {
  const _VerificationHost({
    required this.controller,
    required this.workloadKey,
    super.key,
  });

  final FlutterFrameMonitorController controller;
  final GlobalKey<FlutterFpsWorkloadState> workloadKey;

  @override
  _VerificationHostState createState() => _VerificationHostState();
}

final class _VerificationHostState extends State<_VerificationHost> {
  bool _hudEnabled = true;

  bool get hudEnabled => _hudEnabled;

  void setHudEnabled(bool enabled) {
    if (_hudEnabled == enabled || !mounted) return;
    setState(() {
      _hudEnabled = enabled;
    });
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    home: FlutterFrameMonitor(
      enabled: _hudEnabled,
      controller: widget.controller,
      child: FlutterFpsWorkload(key: widget.workloadKey),
    ),
  );
}

Map<String, Object?> _describeWindow(FlutterFrameWindow window) => {
  'fps': window.fps,
  'frames': window.frameCount,
  'firstVsyncStartUs': window.firstVsyncStartUs,
  'lastVsyncStartUs': window.lastVsyncStartUs,
  'refreshHz': window.displayRefreshRateHz,
  'uiAvgMs': window.uiMs,
  'uiP95Ms': window.uiP95Ms,
  'rasterAvgMs': window.rasterMs,
  'rasterP95Ms': window.rasterP95Ms,
  'phaseJankFrames': window.jankCount,
};

String _buildMode() {
  if (kReleaseMode) return 'release';
  if (kProfileMode) return 'profile';
  return 'debug';
}

void _require(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> _delay(Duration duration) => Future<void>.delayed(duration);

Future<void> _waitUntil(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('Timed out waiting for Flutter state transition');
    }
    await _delay(const Duration(milliseconds: 20));
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final monitor = FlutterFrameMonitorController(autoStart: false);
  // This observer has no widget and is used to prove that HUD-off idle is
  // quiet even after the visible monitor detaches.
  final rawCollector = FlutterFrameMonitorController();
  final workloadKey = GlobalKey<FlutterFpsWorkloadState>();
  final hostKey = GlobalKey<_VerificationHostState>();

  Map<String, Object?>? baselineData;
  Map<String, Object?>? stallData;
  Map<String, Object?>? idleOnData;
  Map<String, Object?>? idleOffData;
  Map<String, Object?>? activeHudOffData;
  Map<String, Object?>? activeHudOnAgainData;
  final errors = <String>[];

  try {
    runApp(
      _VerificationHost(
        key: hostKey,
        controller: monitor,
        workloadKey: workloadKey,
      ),
    );
    await WidgetsBinding.instance.waitUntilFirstFrameRasterized.timeout(
      _firstFrameTimeout,
      onTimeout: () => throw StateError(
        'Timed out waiting for the first rasterized Flutter frame',
      ),
    );

    await _delay(_warmupDuration);
    final baseline = monitor.latest;
    baselineData = _describeWindow(baseline);
    _require(
      baseline.hasCadence && baseline.fps != null && baseline.fps! > 0,
      'baseline has no positive Flutter cadence',
    );
    _require(
      baseline.displayRefreshRateHz != null &&
          baseline.displayRefreshRateHz! > 0,
      'baseline has no display refresh rate',
    );
    final baselineLongFrames = monitor.longFrameCount;

    final workload = workloadKey.currentState;
    _require(workload != null, 'Flutter FPS workload did not mount');
    workload!.setStall(true);
    await _delay(_stallDuration);
    final stalled = monitor.latest;
    stallData = _describeWindow(stalled);
    _require(
      stalled.fps != null &&
          baseline.fps != null &&
          stalled.fps! < baseline.fps! * .75,
      'stall cadence did not fall below 75% of baseline',
    );
    _require(
      stalled.uiP95Ms != null && stalled.uiP95Ms! >= 40,
      'stall UI p95 did not reach 40ms',
    );
    _require(
      monitor.longFrameCount > baselineLongFrames,
      'stall did not add a phase long-frame fact',
    );

    workload.setStall(false);
    workload.stop();
    await _delay(_idleDrainDuration);
    final idleOnMonitorStart = monitor.totalFrames;
    final idleOnRawStart = rawCollector.totalFrames;
    await _delay(_idleObservationDuration);
    final idleOnMonitorExtra = monitor.totalFrames - idleOnMonitorStart;
    final idleOnRawExtra = rawCollector.totalFrames - idleOnRawStart;
    idleOnData = {
      'drainSeconds': _idleDrainDuration.inSeconds,
      'observationSeconds': _idleObservationDuration.inSeconds,
      'monitorExtraFrames': idleOnMonitorExtra,
      'rawCollectorExtraFrames': idleOnRawExtra,
      'monitorAttached': monitor.isAttached,
    };
    _require(
      idleOnRawExtra == 0 && idleOnMonitorExtra == 0,
      'HUD-on idle generated additional engine timings',
    );

    final host = hostKey.currentState;
    _require(host != null, 'verification host did not mount');
    host!.setHudEnabled(false);
    await _waitUntil(() => !monitor.isAttached);
    await _delay(_idleDrainDuration);
    final idleOffRawStart = rawCollector.totalFrames;
    await _delay(_idleObservationDuration);
    final idleOffRawExtra = rawCollector.totalFrames - idleOffRawStart;
    idleOffData = {
      'drainSeconds': _idleDrainDuration.inSeconds,
      'observationSeconds': _idleObservationDuration.inSeconds,
      'rawCollectorExtraFrames': idleOffRawExtra,
      'monitorAttached': monitor.isAttached,
    };
    _require(
      idleOffRawExtra == 0,
      'HUD-off idle generated additional engine timings',
    );
    _require(!monitor.isAttached, 'HUD-off monitor listener remained attached');

    // Measure the same real animation with the visible HUD disabled. The raw
    // collector remains attached, so this isolates HUD rendering/observation
    // from the active Flutter cadence without imposing a guessed FPS delta.
    rawCollector.setDisplayRefreshRateHz(baseline.displayRefreshRateHz);
    workload.start();
    await _delay(_activeHudOffDuration);
    final activeHudOff = rawCollector.latest;
    activeHudOffData = _describeWindow(activeHudOff)
      ..['monitorAttached'] = monitor.isAttached;
    _require(
      activeHudOff.hasCadence,
      'HUD-off active workload has no Flutter cadence',
    );
    workload.stop();

    // Reverse the ablation: re-enable the HUD, then run the same real
    // animation for the same duration and read the same raw collector/budget.
    // This prevents a later warm-up or simulator fluctuation from being
    // mistaken for an HUD-off improvement.
    host.setHudEnabled(true);
    await _waitUntil(() => monitor.isAttached);
    workload.start();
    await _delay(_activeHudOffDuration);
    final activeHudOnAgain = rawCollector.latest;
    activeHudOnAgainData = _describeWindow(activeHudOnAgain)
      ..['monitorAttached'] = monitor.isAttached;
    _require(
      activeHudOnAgain.hasCadence,
      'HUD-on-again active workload has no Flutter cadence',
    );
    workload.stop();
  } catch (error) {
    errors.add(error.toString());
  } finally {
    workloadKey.currentState?.stop();
    monitor.dispose();
    rawCollector.dispose();
  }

  final report = <String, Object?>{
    'mode': _buildMode(),
    'debug': kDebugMode,
    'profile': kProfileMode,
    'release': kReleaseMode,
    'refreshHz': monitor.displayRefreshRateHz,
    'baseline': baselineData,
    'stall': stallData,
    'idleOn': idleOnData,
    'idleOff': idleOffData,
    'activeHudOff': activeHudOffData,
    'activeHudOnAgain': activeHudOnAgainData,
    'passed': errors.isEmpty,
    'errors': errors,
  };
  // iOS device log lines can be truncated. Keep the full report even when
  // the console transport clips the combined on/off/on experiment.
  final reportFile = File(
    '${Directory.systemTemp.path}/pocket-flutter-fps-verification.json',
  );
  await reportFile.writeAsString('${jsonEncode(report)}\n', flush: true);
  // ignore: avoid_print
  print('POCKET_FLUTTER_FPS_REPORT=${reportFile.path}');
  // ignore: avoid_print
  print('POCKET_FLUTTER_FPS_VERIFICATION=${jsonEncode(report)}');

  if (errors.isNotEmpty) {
    throw StateError(errors.join('; '));
  }
}
