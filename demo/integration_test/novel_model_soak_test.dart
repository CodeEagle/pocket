import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:path_provider/path_provider.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_mesh_lod_diagnostics.dart';
import 'novel_test_driver.dart';
import 'novel_performance_support.dart';

const _hiyoriTexturePath = 'Hiyori.2048/texture_';
const _soakWindow = Duration(seconds: 10);
const _profileAblationMode = bool.fromEnvironment(
  'POCKET_NOVEL_PROFILE_ABLATION',
  defaultValue: false,
);
const _meshSupersampleScale = int.fromEnvironment(
  'POCKET_MESH_SUPERSAMPLE',
  defaultValue: 1,
);
const _handleCycleTarget = _profileAblationMode ? 2 : 20;
const _stableRssSettleDelay = Duration(seconds: 1);
const _stableRssSampleInterval = Duration(seconds: 1);
const _stableRssSampleCount = 5;
const _stableRssAbsoluteRangeLimitBytes = 20 * 1024 * 1024;
const _stableRssRelativeRangeLimit = 0.10;
const _modelWindowNames = <String>[
  'hiyori_idle_0',
  'hiyori_idle_1',
  'hiyori_idle_1_closeup',
  'hiyori_idle_0_repeat',
  'hiyori_idle_1_repeat',
];
const _wholeWindowScenes = <String>{
  'game_title',
  'manual_reading',
  'journal_menu',
  'backlog',
  'settings',
  'gallery',
  'save_slots',
};

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final sorted = [...values]..sort();
  return sorted[((sorted.length - 1) * fraction).round()];
}

int _medianInt(List<int> values) {
  if (values.isEmpty) return 0;
  final sorted = [...values]..sort();
  return sorted[sorted.length ~/ 2];
}

Map<String, Object?> _imageResourceFacts(WidgetTester tester) {
  final images = _visibleImages(tester);
  final hiyoriOps = _hiyoriOps(tester);
  final meshLevels = <ui.Image>{
    for (final painter in _painters(tester))
      for (final levels in painter.meshImageLevels.values) ...levels,
  }..removeAll(images.values);
  final textureIds = hiyoriOps.map((op) => op.asset).toSet().toList()..sort();
  final decodedImageBytes = images.values.fold<int>(
    0,
    (sum, image) => sum + image.width * image.height * 4,
  );
  final meshLevelBytes = meshLevels.fold<int>(
    0,
    (sum, image) => sum + image.width * image.height * 4,
  );
  return {
    'decodedImageCount': images.length,
    'decodedImageRgbaBytesEstimate': decodedImageBytes,
    'meshLevelImageCount': meshLevels.length,
    'meshLevelRgbaBytesEstimate': meshLevelBytes,
    'totalDecodedRgbaBytesEstimate': decodedImageBytes + meshLevelBytes,
    'hiyoriTextureResourceIds': textureIds,
    'hiyoriTextureResourceCount': textureIds.length,
    'hiyoriTriangleOpCount': hiyoriOps.length,
    'meshSpanStructure': describeNovelMeshSpanPainters(
      _painterInventory(tester),
    ),
  };
}

Future<Map<String, Object?>> _sampleReleasedRss(WidgetTester tester) async {
  // Let the native handle and its last presented frame disappear before RSS
  // sampling. This is a bounded observation window; it does not request GC.
  await Future<void>.delayed(_stableRssSettleDelay);
  final samples = <int>[];
  final resourceObservations = <Map<String, Object?>>[];
  for (var index = 0; index < _stableRssSampleCount; index++) {
    await Future<void>.delayed(_stableRssSampleInterval);
    final rssBytes = ProcessInfo.currentRss;
    samples.add(rssBytes);
    resourceObservations.add({
      'sample': index + 1,
      'rssBytes': rssBytes,
      'imageResources': _imageResourceFacts(tester),
    });
  }

  final median = _medianInt(samples);
  final minimum = samples.reduce(math.min);
  final maximum = samples.reduce(math.max);
  final spread = maximum - minimum;
  final relativeRangeLimit = (median * _stableRssRelativeRangeLimit).floor();
  final allowedSpread = math
      .min(_stableRssAbsoluteRangeLimitBytes, relativeRangeLimit)
      .toInt();
  return {
    'settleDelayMs': _stableRssSettleDelay.inMilliseconds,
    'sampleIntervalMs': _stableRssSampleInterval.inMilliseconds,
    'samplesBytes': samples,
    'sampleResourceObservations': resourceObservations,
    'sampleCount': samples.length,
    'medianBytes': median,
    'minBytes': minimum,
    'maxBytes': maximum,
    'spreadBytes': spread,
    'allowedSpreadBytes': allowedSpread,
    'stable':
        samples.length == _stableRssSampleCount && spread <= allowedSpread,
  };
}

Map<String, Object?> _stableRssGate(
  List<Map<String, Object?>> cycles, {
  required bool ablationMode,
}) {
  if (ablationMode) {
    return {
      'status': 'not-evaluated-ablation-mode',
      'eligibleCycleCount': cycles.length,
      'requiredCycleCount': 20,
    };
  }

  final sampledWindows = cycles
      .map((cycle) => cycle['postReleaseRss'])
      .whereType<Map>()
      .toList(growable: false);
  final medians = [
    for (final window in sampledWindows)
      if (window['medianBytes'] is int) window['medianBytes']! as int,
  ];
  final enoughCycles = cycles.length == 20 && medians.length == 20;
  final allWindowsStable =
      enoughCycles &&
      sampledWindows.every((window) => window['stable'] == true);
  if (!enoughCycles) {
    return {
      'status': 'unverified-incomplete-cycles',
      'cycleCount': cycles.length,
      'sampleWindowCount': sampledWindows.length,
      'stableWindowCount': sampledWindows
          .where((window) => window['stable'] == true)
          .length,
      'requiredCycleCount': 20,
      'allCycleWindowsStable': false,
      'gatePassed': false,
    };
  }

  final baselineMedian = _medianInt(medians.take(5).toList());
  final finalMedian = _medianInt(medians.skip(15).toList());
  final signedGrowth = finalMedian - baselineMedian;
  final positiveGrowth = math.max(0, signedGrowth).toInt();
  final growthPercent = baselineMedian == 0
      ? null
      : positiveGrowth * 100 / baselineMedian;
  final passesAbsolute = positiveGrowth <= _stableRssAbsoluteRangeLimitBytes;
  final passesRelative =
      growthPercent != null &&
      growthPercent <= _stableRssRelativeRangeLimit * 100;
  final gatePassed = allWindowsStable && passesAbsolute && passesRelative;

  return {
    'status': !allWindowsStable
        ? 'unverified-unstable-sample-window'
        : gatePassed
        ? 'passed'
        : 'failed-growth-threshold',
    'cycleCount': cycles.length,
    'sampleWindowCount': sampledWindows.length,
    'stableWindowCount': sampledWindows
        .where((window) => window['stable'] == true)
        .length,
    'baselineCycles': [1, 2, 3, 4, 5],
    'comparisonCycles': [16, 17, 18, 19, 20],
    'baselineFirstFiveMedianBytes': baselineMedian,
    'finalFiveMedianBytes': finalMedian,
    'signedGrowthBytes': signedGrowth,
    'positiveGrowthBytes': positiveGrowth,
    'growthPercent': growthPercent,
    'absoluteGrowthLimitBytes': _stableRssAbsoluteRangeLimitBytes,
    'relativeGrowthLimitPercent': _stableRssRelativeRangeLimit * 100,
    'passesAbsoluteGrowthLimit': passesAbsolute,
    'passesRelativeGrowthLimit': passesRelative,
    'allCycleWindowsStable': allWindowsStable,
    'gatePassed': gatePassed,
  };
}

NovelMeshPainterInventory _painterInventory(WidgetTester tester) =>
    inspectNovelMeshPainters(
      tester.widgetList<CustomPaint>(find.byType(CustomPaint)),
    );

Iterable<PocketCanvasPainter> _painters(WidgetTester tester) =>
    _painterInventory(tester).sourcePartitions;

List<String> _texts(WidgetTester tester) => [
  for (final painter in _painters(tester))
    for (final op in painter.ops)
      if (op is PocketTextOp) op.text,
];

List<PocketTextureTriangleOp> _hiyoriOps(WidgetTester tester) => [
  for (final painter in _painters(tester))
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>())
      if (op.asset.contains(_hiyoriTexturePath)) op,
];

Map<String, ui.Image> _visibleImages(WidgetTester tester) {
  final images = <String, ui.Image>{};
  for (final painter in _painters(tester)) {
    for (final entry in painter.images.entries) {
      images.putIfAbsent(entry.key, () => entry.value);
    }
  }
  return images;
}

Map<String, List<List<double>>> _hiyoriGeometry(WidgetTester tester) {
  final result = <String, List<List<double>>>{};
  for (final op in _hiyoriOps(tester)) {
    final uv = op.uvs.map((value) => value.toStringAsPrecision(9)).join(',');
    final key = '${op.asset}|$uv';
    result.putIfAbsent(key, () => <List<double>>[]).add([
      for (final point in op.points) ...[point.x, point.y],
    ]);
  }
  return result;
}

Map<String, Object?> _motionFacts(
  Map<String, List<List<double>>> before,
  Map<String, List<List<double>>> after,
) {
  var commonCoordinates = 0;
  var maximumDelta = 0.0;
  for (final entry in before.entries) {
    final beforeTriangles = entry.value;
    final afterTriangles = after[entry.key];
    if (beforeTriangles.length != 1 || afterTriangles?.length != 1) continue;
    final first = beforeTriangles.single;
    final second = afterTriangles!.single;
    final common = math.min(first.length, second.length).toInt();
    commonCoordinates += common;
    for (var index = 0; index < common; index++) {
      if (!first[index].isFinite || !second[index].isFinite) continue;
      maximumDelta = math.max(
        maximumDelta,
        (first[index] - second[index]).abs(),
      );
    }
  }
  return {
    'commonCoordinates': commonCoordinates,
    'maxCoordinateDelta': maximumDelta,
  };
}

String? _findText(WidgetTester tester, Iterable<String> parts) {
  final labels = _texts(tester);
  String compact(String value) => value.replaceAll(RegExp(r'\s+'), '');
  for (final part in parts) {
    for (final label in labels) {
      if (compact(label) == compact(part)) return label;
    }
  }
  for (final part in parts) {
    for (final label in labels) {
      if (compact(label).contains(compact(part))) return label;
    }
  }
  return null;
}

Future<void> _waitForText(
  WidgetTester tester,
  Iterable<String> parts, {
  required String reason,
  Duration timeout = const Duration(seconds: 12),
}) async {
  final clock = Stopwatch()..start();
  while (clock.elapsed < timeout) {
    if (_findText(tester, parts) != null) return;
    await tester.pump(const Duration(milliseconds: 30));
    if (clock.elapsedMilliseconds % 300 < 30) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
    }
  }
  fail('$reason; painted=${_texts(tester)}');
}

Future<void> _tapAction(
  WidgetTester tester,
  List<String> parts, {
  bool scroll = true,
}) async {
  final clock = Stopwatch()..start();
  while (clock.elapsed < const Duration(seconds: 15)) {
    final action = _findText(tester, parts);
    if (action != null) {
      await guest.tapGuest(tester, action, scroll: scroll);
      return;
    }
    final continueHint = _findText(tester, const [
      '轻触显全',
      'Tap to reveal',
      '轻触继续  ›',
      'Tap to continue  ›',
    ]);
    if (continueHint != null) {
      await guest.tapGuest(tester, continueHint, scroll: false);
    } else {
      await tester.pump(const Duration(milliseconds: 30));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
    }
  }
  fail('Could not reach action $parts; painted=${_texts(tester)}');
}

Future<void> _waitForLive2d(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  final clock = Stopwatch()..start();
  while (clock.elapsed < const Duration(seconds: 20)) {
    if (plugin.activeModelCount == 1 && _hiyoriOps(tester).length > 10) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 2)),
    );
  }
  fail(
    'Real Hiyori model did not become active: handles=${plugin.activeModelCount}, '
    'triangles=${_hiyoriOps(tester).length}, painted=${_texts(tester)}',
  );
}

Future<void> _waitForLive2dRelease(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  final clock = Stopwatch()..start();
  while (clock.elapsed < const Duration(seconds: 12)) {
    if (plugin.activeModelCount == 0 && _hiyoriOps(tester).isEmpty) return;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 2)),
    );
  }
  fail(
    'The actual model handle did not release: handles=${plugin.activeModelCount}, '
    'triangles=${_hiyoriOps(tester).length}, painted=${_texts(tester)}',
  );
}

Future<void> _enterHiyoriIdle0(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  await _tapAction(tester, const [
    '官方 Hiyori · Live2D',
    'Official Hiyori · Live2D',
  ]);
  await _tapAction(tester, const ['Idle 0 · 呼吸', 'Idle 0 · Breathing']);
  await _waitForText(
    tester,
    const ['选择取景', 'Choose framing'],
    reason: 'The 2.6-second idle scene should reach its actual framing choice',
  );
  await _waitForLive2d(tester, plugin);
  _assertRealHiyoriTextures(tester);
}

void _assertRealHiyoriTextures(WidgetTester tester) {
  final ops = _hiyoriOps(tester);
  final assets = ops.map((op) => op.asset).toSet();
  expect(ops.length, greaterThan(10));
  expect(assets, hasLength(2), reason: 'Both real Hiyori texture pages render');
  final images = _visibleImages(tester);
  for (final asset in assets) {
    final image = images[asset];
    expect(image, isNotNull, reason: 'The PAK texture must be decoded: $asset');
    expect(
      image!.width,
      2048,
      reason: 'Preserve original texture width: $asset',
    );
    expect(
      image.height,
      2048,
      reason: 'Preserve original texture height: $asset',
    );
  }
}

Future<void> _returnToModelCatalog(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  await _tapAction(tester, const ['返回动作目录', 'Return to action menu']);
  await _tapAction(tester, const ['返回试映目录', 'Return to showcase catalog']);
  await _waitForLive2dRelease(tester, plugin);
}

Future<void> _enterReplay(WidgetTester tester) async {
  await guest.tapGuest(
    tester,
    _findText(tester, const ['启程 · 开始新的故事']) != null ? '立绘试映' : 'Model theater',
  );
  await _waitForText(tester, const [
    '独立的角色试映',
    'standalone character showcase',
  ], reason: 'The featured replay should begin at its authored opening');
}

Future<Map<String, Object?>> _sampleWindow(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding, {
  required String scope,
  required String scene,
  required PocketLive2dPlugin live2d,
  Duration duration = _soakWindow,
}) async {
  binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await tester.pump();

  final spanInventoryAtEntry = _painterInventory(tester);

  final frameTimings = <FrameTiming>[];
  final nativeCallMs = <double>[];
  final maxOps = <double>[];
  final rssSamples = <int>[];
  final originalFrameDelta = debugPocketFrameDeltaAtOverride;
  void collectFrames(List<FrameTiming> timings) => frameTimings.addAll(timings);
  debugPocketFrameDeltaAtOverride = (runtime, delta) {
    final clock = Stopwatch()..start();
    final result = originalFrameDelta == null
        ? pocketFrameDeltaAt(runtime, delta)
        : originalFrameDelta(runtime, delta);
    clock.stop();
    nativeCallMs.add(clock.elapsedMicroseconds / 1000);
    if (result != null) maxOps.add(result.ops.length.toDouble());
    return result;
  };
  SchedulerBinding.instance.addTimingsCallback(collectFrames);
  PocketCanvasPainter.resetPaintInvocationCount();
  resetNovelMeshSpanDiagnostics();
  final elapsed = Stopwatch()..start();
  var nextMemorySample = Duration.zero;
  try {
    while (elapsed.elapsed < duration) {
      if (elapsed.elapsed >= nextMemorySample) {
        rssSamples.add(ProcessInfo.currentRss);
        nextMemorySample += const Duration(seconds: 1);
      }
      final remaining = duration - elapsed.elapsed;
      await Future<void>.delayed(
        remaining > const Duration(seconds: 1)
            ? const Duration(seconds: 1)
            : remaining,
      );
    }
    rssSamples.add(ProcessInfo.currentRss);
  } finally {
    elapsed.stop();
    SchedulerBinding.instance.removeTimingsCallback(collectFrames);
    debugPocketFrameDeltaAtOverride = originalFrameDelta;
  }
  final spanCountersForWindow = snapshotNovelMeshSpanDiagnostics();
  final spanInventoryAtExit = _painterInventory(tester);

  final buildMs = [
    for (final timing in frameTimings)
      timing.buildDuration.inMicroseconds / 1000,
  ];
  final rasterMs = [
    for (final timing in frameTimings)
      timing.rasterDuration.inMicroseconds / 1000,
  ];
  final totalSpanMs = [
    for (final timing in frameTimings) timing.totalSpan.inMicroseconds / 1000,
  ];
  final vsyncOverheadMs = [
    for (final timing in frameTimings)
      timing.vsyncOverhead.inMicroseconds / 1000,
  ];
  final rasterQueueMs = [
    for (final timing in frameTimings)
      (timing.timestampInMicroseconds(ui.FramePhase.rasterStart) -
              timing.timestampInMicroseconds(ui.FramePhase.buildFinish)) /
          1000,
  ];
  final orderedVsyncStarts =
      frameTimings
          .map(
            (timing) =>
                timing.timestampInMicroseconds(ui.FramePhase.vsyncStart),
          )
          .toList()
        ..sort();
  final adjacentVsyncStartIntervalsMs = [
    for (var index = 1; index < orderedVsyncStarts.length; index++)
      (orderedVsyncStarts[index] - orderedVsyncStarts[index - 1]) / 1000,
  ];
  final displayBudgetMs = 1000 / tester.view.display.refreshRate;
  final images = _visibleImages(tester);
  final meshLevels = <ui.Image>{
    for (final painter in _painters(tester))
      for (final levels in painter.meshImageLevels.values) ...levels,
  }..removeAll(images.values);
  final meshLevelBytesEstimate = meshLevels.fold<int>(
    0,
    (sum, image) => sum + image.width * image.height * 4,
  );
  final decodedBytesEstimate = images.values.fold<int>(
    meshLevelBytesEstimate,
    (sum, image) => sum + image.width * image.height * 4,
  );
  final modelOps = _hiyoriOps(tester);
  final window = <String, Object?>{
    'scope': scope,
    'scene': scene,
    'pid': pid,
    'platform': defaultTargetPlatform.name,
    'mode': kProfileMode
        ? 'profile'
        : kReleaseMode
        ? 'release'
        : 'debug',
    'refreshHz': tester.view.display.refreshRate,
    'elapsedMs': elapsed.elapsedMilliseconds,
    'frameTimingCount': frameTimings.length,
    'nativeCalls': nativeCallMs.length,
    'nativeTotalMs': nativeCallMs.fold<double>(0, (sum, value) => sum + value),
    'nativeP50Ms': _percentile(nativeCallMs, .50),
    'nativeP95Ms': _percentile(nativeCallMs, .95),
    'nativeMaxMs': _percentile(nativeCallMs, 1),
    'buildP95Ms': _percentile(buildMs, .95),
    'buildMaxMs': _percentile(buildMs, 1),
    'rasterP95Ms': _percentile(rasterMs, .95),
    'rasterMaxMs': _percentile(rasterMs, 1),
    'totalSpanP95Ms': _percentile(totalSpanMs, .95),
    'vsyncOverheadP95Ms': _percentile(vsyncOverheadMs, .95),
    'rasterQueueP95Ms': _percentile(rasterQueueMs, .95),
    'adjacentVsyncStartIntervalP95Ms': _percentile(
      adjacentVsyncStartIntervalsMs,
      .95,
    ),
    'adjacentVsyncStartIntervalSampleCount':
        adjacentVsyncStartIntervalsMs.length,
    'timingLimits':
        'totalSpan is end-to-end and UI/raster work can overlap, so it is not used as a jank gate; adjacent vsync-start intervals describe delivered timing samples, not presented FPS. Existing overBudget remains build/raster-duration based and may miss toImageSync snapshot task cost. GPU completion and memory bandwidth are not measured.',
    'overBudget': frameTimings
        .where(
          (timing) =>
              timing.buildDuration.inMicroseconds / 1000 > displayBudgetMs ||
              timing.rasterDuration.inMicroseconds / 1000 > displayBudgetMs,
        )
        .length,
    'opsMax': _percentile(maxOps, 1),
    'canvasPaints': PocketCanvasPainter.paintInvocationCount,
    'meshSpanStructureAtWindowEntry': describeNovelMeshSpanPainters(
      spanInventoryAtEntry,
    ),
    'meshSpanStructureAtWindowExit': describeNovelMeshSpanPainters(
      spanInventoryAtExit,
    ),
    'meshSpanWindowCounters': spanCountersForWindow,
    'paintedOps': PocketCanvasPainter.drawOpInvocationCount,
    'textureTriangleBatches': PocketCanvasPainter.textureTriangleBatchDrawCount,
    'hiyoriTriangleOps': modelOps.length,
    'hiyoriTextureAssets': modelOps.map((op) => op.asset).toSet().toList(),
    'decodedImageCount': images.length,
    'meshLevelImageCount': meshLevels.length,
    'meshLevelRgbaBytesEstimate': meshLevelBytesEstimate,
    'decodedRgbaBytesEstimate': decodedBytesEstimate,
    'activeModelCount': live2d.activeModelCount,
    'rssCurrentBytes': rssSamples.isEmpty
        ? ProcessInfo.currentRss
        : rssSamples.last,
    'rssObservedPeakBytes': rssSamples.isEmpty
        ? ProcessInfo.currentRss
        : rssSamples.reduce(math.max),
    'rssSamplesBytes': rssSamples,
    'processMaxRssBytes': ProcessInfo.maxRss,
  };
  expect(
    elapsed.elapsed,
    greaterThanOrEqualTo(duration),
    reason: 'The sample must last for its declared wall-clock window',
  );
  expect(tester.takeException(), isNull);
  // ignore: avoid_print
  print('POCKET_NOVEL_SOAK_WINDOW ${jsonEncode(window)}');
  return window;
}

Future<void> _measureModelWindow(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
  PocketLive2dPlugin live2d,
  List<Map<String, Object?>> windows,
  String scene,
) async {
  await _waitForLive2d(tester, live2d);
  _assertRealHiyoriTextures(tester);
  final before = _hiyoriGeometry(tester);
  expect(before, isNotEmpty);
  final result = await _sampleWindow(
    tester,
    binding,
    scope: 'model',
    scene: scene,
    live2d: live2d,
  );
  final after = _hiyoriGeometry(tester);
  final motion = _motionFacts(before, after);
  expect(
    motion['commonCoordinates'],
    greaterThanOrEqualTo(6),
    reason: 'Compare actual shared texture/UV triangles across the window',
  );
  expect(
    motion['maxCoordinateDelta'],
    greaterThan(0.001),
    reason: 'The FFI model animation should change real drawn geometry',
  );
  windows.add({...result, 'motion': motion});
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  final completionCheckpoint = _profileAblationMode
      ? 'model-soak-ablation'
      : 'model-stable-rss';
  binding.reportData = {
    ...?binding.reportData,
    'pocketAcceptance': {
      'required': [completionCheckpoint],
      'completed': <String>[],
    },
  };
  final isolatedSupport = IsolatedNovelSupportDirectory();

  File? normalStore;
  List<int>? normalStoreBefore;
  setUp(() async {
    final support = await getApplicationSupportDirectory();
    normalStore = File(
      '${support.path}/pocket-platform-data/pocket_platform_data.json',
    );
    normalStoreBefore = await normalStore!.exists()
        ? await normalStore!.readAsBytes()
        : null;
    await isolatedSupport.install();
  });
  tearDown(() async {
    await isolatedSupport.restore();
    final after = await normalStore!.exists()
        ? await normalStore!.readAsBytes()
        : null;
    expect(
      after,
      equals(normalStoreBefore),
      reason: 'Performance runs must preserve ordinary user storage',
    );
    binding.reportData = {...?binding.reportData, 'normalStorePreserved': true};
  });

  testWidgets(
    _profileAblationMode
        ? 'topology ablation: five real model windows and two handle cycles'
        : 'profile five real 10-second model windows, whole-game windows and 20 handle cycles',
    (tester) async {
      final windows = <Map<String, Object?>>[];
      final cycles = <Map<String, Object?>>[];
      PocketLive2dPlugin? live2d;
      PocketAudioPlugin? audio;
      final systemController = PocketSystemHostController();
      Future<void> openJournal() async {
        await _tapAction(tester, const ['手札', 'Journal'], scroll: false);
        await _waitForText(tester, const [
          '旅途手札',
          'Journey journal',
        ], reason: 'Open the game journal');
      }

      Future<void> sampleWholeWindow(String scene) async {
        if (_profileAblationMode) return;
        windows.add(
          await _sampleWindow(
            tester,
            binding,
            scope: 'whole',
            scene: scene,
            live2d: live2d!,
          ),
        );
      }

      final lantern = showcaseNativePolicies['pocket.demo.lantern']!;
      final policies = {
        ...showcaseNativePolicies,
        'pocket.demo.lantern': lantern.copyWith(
          pluginFactories: [
            (controller) {
              final plugin = createLanternAudioPlugin(controller);
              if (plugin is! PocketAudioPlugin) {
                throw StateError(
                  'Lantern audio factory returned ${plugin.runtimeType}',
                );
              }
              audio = plugin;
              return plugin;
            },
            (_) {
              final plugin = PocketLive2dPlugin.fromBundledCatalog(
                catalogAsset: 'assets/apps/lantern/novel.native-assets.json',
                assetPrefix: 'assets/apps/lantern/',
              );
              live2d = plugin;
              return plugin;
            },
          ],
        ),
      };

      try {
        await tester.pumpWidget(
          pocketHostApp(
            systemController: systemController,
            nativePolicies: policies,
            showFlutterFps: false,
          ),
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await _waitForText(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ], reason: 'Lantern title page');
        expect(live2d, isNotNull);
        expect(audio, isNotNull);
        expect(live2d!.activeModelCount, 0);

        await sampleWholeWindow('game_title');
        await _tapAction(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ]);
        await _waitForText(tester, const [
          '23点08分',
          '11:08 p.m.',
          '23:08',
        ], reason: 'The main story should start from its original opening');
        await sampleWholeWindow('manual_reading');

        await openJournal();
        await sampleWholeWindow('journal_menu');

        await _tapAction(tester, const ['沿途回声', 'Journey echoes']);
        await _waitForText(tester, const [
          '沿途回声',
          'Journey echoes',
        ], reason: 'Open the actual backlog panel');
        await sampleWholeWindow('backlog');
        await _tapAction(tester, const ['返回', 'Back'], scroll: false);
        await openJournal();
        await _tapAction(tester, const ['阅读偏好', 'Reading preferences']);
        await _waitForText(tester, const [
          '阅读偏好',
          'Reading preferences',
        ], reason: 'Open the actual reading settings panel');
        await sampleWholeWindow('settings');
        await _tapAction(tester, const ['返回', 'Back'], scroll: false);
        await openJournal();
        await _tapAction(tester, const ['雾港纪念', 'Harbor memories']);
        await _waitForText(tester, const [
          '雾港纪念',
          'Harbor memories',
        ], reason: 'Open the actual gallery panel');
        await sampleWholeWindow('gallery');
        await _tapAction(tester, const ['返回', 'Back'], scroll: false);
        await openJournal();
        await _tapAction(tester, const ['重读信笺', 'Reread letters']);
        await waitForNovelSlotPage(tester);
        await sampleWholeWindow('save_slots');
        await _tapAction(tester, const ['返回', 'Back'], scroll: false);
        await openJournal();
        // This menu action is below the fold at 800x600. Search through
        // actual page drags rather than waiting for an unpainted label.
        await guest.tapGuest(
          tester,
          _findText(tester, const ['旅途手札']) != null
              ? '返回扉页'
              : 'Return to title',
        );
        await _waitForText(
          tester,
          const ['启程 · 开始新的故事', 'Begin · Start a new story'],
          reason:
              'Return to the actual title page before revealing its model action',
        );
        await _enterReplay(tester);

        await _enterHiyoriIdle0(tester, live2d!);
        await _measureModelWindow(
          tester,
          binding,
          live2d!,
          windows,
          _modelWindowNames[0],
        );

        await _tapAction(tester, const ['返回动作目录', 'Return to action menu']);
        await _tapAction(tester, const ['Idle 1 · 摆动', 'Idle 1 · Sway']);
        await _waitForText(
          tester,
          const ['选择取景', 'Choose framing'],
          reason: 'Idle 1 should reach the framing menu after its actual wait',
        );
        await _waitForLive2d(tester, live2d!);
        await _measureModelWindow(
          tester,
          binding,
          live2d!,
          windows,
          _modelWindowNames[1],
        );

        await _tapAction(tester, const [
          'Idle 1 · 面部近景',
          'Idle 1 · Face close-up',
        ]);
        await _waitForText(tester, const [
          '选择取景',
          'Choose framing',
        ], reason: 'The close-up should remain in the authored wait scene');
        await _waitForLive2d(tester, live2d!);
        await _measureModelWindow(
          tester,
          binding,
          live2d!,
          windows,
          _modelWindowNames[2],
        );

        await _tapAction(tester, const ['返回动作目录', 'Return to action menu']);
        await _tapAction(tester, const ['Idle 0 · 呼吸', 'Idle 0 · Breathing']);
        await _waitForText(tester, const [
          '选择取景',
          'Choose framing',
        ], reason: 'The repeated Idle 0 should reach the framing choice');
        await _waitForLive2d(tester, live2d!);
        await _measureModelWindow(
          tester,
          binding,
          live2d!,
          windows,
          _modelWindowNames[3],
        );

        await _tapAction(tester, const ['返回动作目录', 'Return to action menu']);
        await _tapAction(tester, const ['Idle 1 · 摆动', 'Idle 1 · Sway']);
        await _waitForText(tester, const [
          '选择取景',
          'Choose framing',
        ], reason: 'The final Idle 1 should reach the framing choice');
        await _waitForLive2d(tester, live2d!);
        await _measureModelWindow(
          tester,
          binding,
          live2d!,
          windows,
          _modelWindowNames[4],
        );

        // Start cycles from a real zero-handle catalog state. Every cycle
        // re-enters through authored choices and waits for the actual FFI model
        // plus decoded 2048px texture pages, then returns through two authored
        // choices until the native handle is released.
        await _returnToModelCatalog(tester, live2d!);
        for (var index = 1; index <= _handleCycleTarget; index++) {
          expect(live2d!.activeModelCount, 0);
          // The five timed windows have ended. Reset before this real model
          // re-entry so the counters below prove this handle cycle's paints.
          resetNovelMeshSpanDiagnostics();
          await _enterHiyoriIdle0(tester, live2d!);
          final meshSpanInventoryAtEntry = _painterInventory(tester);
          final meshSpanCountersAtEntry = snapshotNovelMeshSpanDiagnostics();
          if (_meshSupersampleScale > 1) {
            expect(
              meshSpanInventoryAtEntry.spanPainters,
              isNotEmpty,
              reason: 'Cycle $index entered without a live mesh span.',
            );
            expect(
              meshSpanInventoryAtEntry.spanPainters.every(
                (span) => span.sampleScale == _meshSupersampleScale,
              ),
              isTrue,
              reason: 'Cycle $index did not use the requested sample scale.',
            );
            expect(
              meshSpanCountersAtEntry['spanPaintCount'],
              greaterThan(0),
              reason: 'Cycle $index entered without painting its mesh span.',
            );
            expect(
              meshSpanCountersAtEntry['snapshotCount'],
              greaterThan(0),
              reason: 'Cycle $index entered without an SSAA snapshot.',
            );
            expect(
              meshSpanCountersAtEntry['snapshotCount'],
              meshSpanCountersAtEntry['disposedSnapshotCount'],
              reason:
                  'Cycle $index has an undisposed snapshot handle at entry.',
            );
            expect(
              meshSpanCountersAtEntry['ineligibleBypassCount'],
              0,
              reason: 'Cycle $index bypassed an ineligible production span.',
            );
            expect(
              meshSpanCountersAtEntry['snapshotFailureBypassCount'],
              0,
              reason: 'Cycle $index had a failed snapshot.',
            );
          }
          final audioChannelsAtEntry = audio!.activeChannelCount;
          final rssAtEntry = ProcessInfo.currentRss;
          final imageResourcesAtEntry = _imageResourceFacts(tester);
          final loadedOps = _hiyoriOps(tester).length;
          expect(live2d!.activeModelCount, 1);
          expect(loadedOps, greaterThan(10));
          await _returnToModelCatalog(tester, live2d!);
          final meshSpanCountersAtExit = snapshotNovelMeshSpanDiagnostics();
          if (_meshSupersampleScale > 1) {
            expect(
              meshSpanCountersAtExit['snapshotCount'],
              greaterThan(0),
              reason: 'Cycle $index recorded no SSAA snapshots.',
            );
            expect(
              meshSpanCountersAtExit['snapshotCount'],
              meshSpanCountersAtExit['disposedSnapshotCount'],
              reason: 'Cycle $index has an undisposed snapshot handle at exit.',
            );
            expect(
              meshSpanCountersAtExit['ineligibleBypassCount'],
              0,
              reason: 'Cycle $index bypassed an ineligible production span.',
            );
            expect(
              meshSpanCountersAtExit['snapshotFailureBypassCount'],
              0,
              reason: 'Cycle $index had a failed snapshot.',
            );
          }
          final audioChannelsAtExit = audio!.activeChannelCount;
          final rssAtExit = ProcessInfo.currentRss;
          final imageResourcesAtExit = _imageResourceFacts(tester);
          final postReleaseRss = _profileAblationMode
              ? null
              : await _sampleReleasedRss(tester);
          final activeAfterStableSample = live2d!.activeModelCount;
          final trianglesAfterStableSample = _hiyoriOps(tester).length;
          final cycle = <String, Object?>{
            'ablationMode': _profileAblationMode,
            'cycle': index,
            'activeAfterEntry': 1,
            'activeAfterExit': live2d!.activeModelCount,
            'trianglesAfterEntry': loadedOps,
            'trianglesAfterExit': _hiyoriOps(tester).length,
            'audioActiveChannelCountAtEntry': audioChannelsAtEntry,
            'audioActiveChannelCountAtExit': audioChannelsAtExit,
            'rssBytesAtEntry': rssAtEntry,
            'rssBytesAtExit': rssAtExit,
            'meshSupersampleScaleRequested': _meshSupersampleScale,
            'meshSpanSnapshotCountersAtEntry': meshSpanCountersAtEntry,
            'meshSpanSnapshotCountersAtExit': meshSpanCountersAtExit,
            'meshSpanSnapshotCountAtEntry':
                meshSpanCountersAtEntry['snapshotCount'],
            'meshSpanSnapshotCountAtExit':
                meshSpanCountersAtExit['snapshotCount'],
            'meshSpanSnapshotCountDuringReturn':
                (meshSpanCountersAtExit['snapshotCount']! as int) -
                (meshSpanCountersAtEntry['snapshotCount']! as int),
            'imageResourcesAtEntry': imageResourcesAtEntry,
            'imageResourcesAtExit': imageResourcesAtExit,
            if (postReleaseRss != null) 'postReleaseRss': postReleaseRss,
            if (postReleaseRss != null)
              'activeAfterStableSample': activeAfterStableSample,
            if (postReleaseRss != null)
              'trianglesAfterStableSample': trianglesAfterStableSample,
          };
          cycles.add(cycle);
          // ignore: avoid_print
          print('POCKET_NOVEL_SOAK_CYCLE ${jsonEncode(cycle)}');
          binding.reportData = {
            ...?binding.reportData,
            'novelModelSoak': {
              'ablationMode': _profileAblationMode,
              'handleCycleCount': cycles.length,
              'handleCycles': cycles,
              'processMaxRssBytes': ProcessInfo.maxRss,
            },
          };
          expect(activeAfterStableSample, 0);
          expect(trianglesAfterStableSample, 0);
        }
        await _tapAction(tester, const [
          '返回原旅程',
          'Return to journey',
        ], scroll: false);
        await _waitForLive2dRelease(tester, live2d!);

        expect(
          windows.where((window) => window['scope'] == 'model'),
          hasLength(5),
        );
        if (_profileAblationMode) {
          expect(
            windows.where((window) => window['scope'] == 'whole'),
            isEmpty,
            reason: 'Topology ablation skips the seven whole-game samples',
          );
          expect(cycles, hasLength(2));
        } else {
          final wholeWindows = windows
              .where((window) => window['scope'] == 'whole')
              .toList(growable: false);
          expect(wholeWindows, hasLength(_wholeWindowScenes.length));
          expect(
            wholeWindows.map((window) => window['scene']),
            unorderedEquals(_wholeWindowScenes),
          );
          expect(cycles, hasLength(20));
        }
        expect(cycles.every((cycle) => cycle['activeAfterExit'] == 0), isTrue);
        final stableRssGate = _stableRssGate(
          cycles,
          ablationMode: _profileAblationMode,
        );
        final supportData = File(
          '${isolatedSupport.path}/pocket-platform-data/pocket_platform_data.json',
        );
        expect(
          await supportData.exists(),
          isTrue,
          reason:
              'The test host must have written only to isolated app support',
        );
        expect(live2d!.activeModelCount, 0);

        final bytecodeMetadata =
            jsonDecode(
                  await rootBundle.loadString(
                    'assets/apps/lantern/app.bytecode.json',
                  ),
                )
                as Map<String, dynamic>;
        final report = <String, Object?>{
          'guestBytecodeMetadata': <String, Object?>{
            'sourceSha256': bytecodeMetadata['sourceSha256'],
            'payloadSha256': bytecodeMetadata['payloadSha256'],
            'bytecodeBytes': bytecodeMetadata['bytecodeBytes'],
          },
          'ablationMode': _profileAblationMode,
          'pid': pid,
          'supportPath': isolatedSupport.path,
          'wholeWindowCount': windows
              .where((w) => w['scope'] == 'whole')
              .length,
          'modelWindowCount': windows
              .where((w) => w['scope'] == 'model')
              .length,
          'modelWindowSeconds': _soakWindow.inSeconds,
          'modelWindowNames': _modelWindowNames,
          'handleCycleTarget': _handleCycleTarget,
          'handleCycleCount': cycles.length,
          'resourceReleaseObservability': <String, String>{
            'live2d': 'verified by activeModelCount and Hiyori draw-op count',
            'audio':
                'native activeChannelCount recorded at cycle entry and exit; zero is not required',
            'clock':
                'unverified; no Guest clock actor count is exposed to this Flutter harness',
          },
          'processMaxRssBytes': ProcessInfo.maxRss,
          'stableRssGate': stableRssGate,
          'windows': windows,
          'handleCycles': cycles,
        };
        binding.reportData = {...?binding.reportData, 'novelModelSoak': report};
        // ignore: avoid_print
        print('POCKET_NOVEL_MODEL_SOAK ${jsonEncode(report)}');
        if (!_profileAblationMode) {
          expect(
            stableRssGate['allCycleWindowsStable'],
            isTrue,
            reason:
                'Each bounded post-release RSS window must be stable; an '
                'unstable observation is unverified, not a memory-gate pass',
          );
          expect(
            stableRssGate['gatePassed'],
            isTrue,
            reason:
                'Stable RSS growth must satisfy both the 10% and 20 MiB limits',
          );
        }
      } finally {
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        final sessions = systemController.instances
            .map((fact) => fact.session)
            .toList();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        // Await actual native/storage closure before isolated support deletion.
        await tester.runAsync(
          () => Future.wait(sessions.map((session) => session.close())),
        );
        systemController.dispose();
      }
      binding.reportData = {
        ...?binding.reportData,
        'pocketAcceptance': {
          'required': [completionCheckpoint],
          'completed': [completionCheckpoint],
        },
      };
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
}
