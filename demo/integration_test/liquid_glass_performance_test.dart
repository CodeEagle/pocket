import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'frame_timing_collector.dart';

final GlobalKey _captureKey = GlobalKey();

// This is intentionally the same raw ui/pocket contract as
// glass_optics_test.dart. It does not invoke buildGuest or introduce another
// layout/runtime implementation. The fixture keeps the background in JS so
// the measured glass phases exercise real SURFACE_QUAD frames while a pair of
// non-uniform surfaces samples moving pixels.
const String _performanceGuestSource = r'''
const ROOT = 1;

function argb(r, g, b) {
  return (((255 << 24) >>> 0) | (r << 16) | (g << 8) | b) >>> 0;
}

function rect(x, y, width, height, color, z) {
  const node = ui.createNode(0);
  ui.setProp(node, 1, width);
  ui.setProp(node, 2, height);
  ui.setProp(node, 24, 1); // absolute positioning
  ui.setProp(node, 25, y);
  ui.setProp(node, 28, x);
  ui.setProp(node, 31, z);
  ui.setProp(node, 64, color);
  ui.insertBefore(ROOT, node, 0);
  return node;
}

// Fixed bands plus two animated bars make the sampled backdrop spatially
// non-uniform and continuously changing without any screenshot/readback.
rect(0, 0, 390, 600, 0xff101827, 0);
rect(0, 0, 390, 100, 0xff19324d, 1);
rect(0, 100, 390, 100, 0xffd97742, 1);
rect(0, 200, 390, 100, 0xff2a9d8f, 1);
rect(0, 300, 390, 100, 0xfff6bd60, 1);
rect(0, 400, 390, 100, 0xff6d597a, 1);
rect(0, 500, 390, 100, 0xff264653, 1);
const movingA = rect(8, 82, 132, 224, 0xffe76f51, 2);
const movingB = rect(220, 300, 124, 196, 0xff457b9d, 2);

let phase = 0;
let animate = false;
let pressed = false;
let shape = 'rounded';
let glassA = ui.createNode(3);
let glassB = ui.createNode(3);

function glassPayload() {
  return JSON.stringify({
    radius: 24,
    blur: 7,
    edgeIntensity: 0.08,
    rimIntensity: 0.16,
    baseIntensity: 0.02,
    tintOpacity: 0.10,
    cornerBoost: 0.12,
    rippleEffect: 0.08,
    warp: true,
    materialStrength: 0.72,
    materialTint: 0xff1c1c1e,
    pressed: pressed,
    shape: shape,
  });
}

function registerGlass() {
  pocket.registerSurface('qa.glass.performance.a', 'glass', glassPayload());
  pocket.registerSurface('qa.glass.performance.b', 'glass', glassPayload());
}

function configureGlass(node, x, y, width, height, z) {
  ui.setProp(node, 1, width);
  ui.setProp(node, 2, height);
  ui.setProp(node, 24, 1);
  ui.setProp(node, 25, y);
  ui.setProp(node, 28, x);
  ui.setProp(node, 31, z);
}

configureGlass(glassA, 26, 178, 154, 194, 100);
configureGlass(glassB, 210, 206, 154, 194, 101);
const handleA = pocket.registerSurface(
  'qa.glass.performance.a', 'glass', glassPayload(),
);
const handleB = pocket.registerSurface(
  'qa.glass.performance.b', 'glass', glassPayload(),
);
ui.setCompositorSurface(glassA, handleA, 0);
ui.setCompositorSurface(glassB, handleB, 0);
ui.insertBefore(ROOT, glassA, 0);
ui.insertBefore(ROOT, glassB, 0);

globalThis.__pocketEvent = function(message) {
  const event = typeof message === 'string' ? JSON.parse(message) : message;
  if (event.name === 'qa.glass.performance.animate') {
    animate = true;
  }
  if (event.name === 'qa.glass.performance.pause') {
    animate = false;
  }
  if (event.name === 'qa.glass.performance.pressed') {
    pressed = event.payload && event.payload.pressed === true;
    shape = event.payload && event.payload.shape === 'pill' ? 'pill' : 'rounded';
    registerGlass();
  }
  if (event.name === 'qa.glass.performance.remove') {
    animate = false;
    if (glassA !== 0) {
      ui.destroyNode(glassA);
      glassA = 0;
    }
    if (glassB !== 0) {
      ui.destroyNode(glassB);
      glassB = 0;
    }
    pocket.releaseSurface('qa.glass.performance.a');
    pocket.releaseSurface('qa.glass.performance.b');
  }
};
globalThis.__pocketEvent.__binaryCapable = true;

globalThis.frame = function() {
  if (!animate) return;
  phase += 0.11;
  const ax = 8 + Math.round((Math.sin(phase) * 0.5 + 0.5) * 188);
  const by = 248 + Math.round((Math.cos(phase * 0.83) * 0.5 + 0.5) * 170);
  const warm = Math.round((Math.sin(phase * 0.71) * 0.5 + 0.5) * 180);
  const cool = Math.round((Math.cos(phase * 0.53) * 0.5 + 0.5) * 180);
  ui.setProp(movingA, 28, ax);
  ui.setProp(movingA, 64, argb(190 + Math.round(warm * 0.3), 55 + Math.round(warm * 0.3), 70));
  ui.setProp(movingB, 25, by);
  ui.setProp(movingB, 64, argb(42, 90 + Math.round(cool * 0.4), 120 + Math.round(cool * 0.4)));
};
''';

final class _CapturedImage {
  const _CapturedImage({
    required this.width,
    required this.height,
    required this.rgba,
  });

  final int width;
  final int height;
  final Uint8List rgba;
}

Future<_CapturedImage> _capture(WidgetTester tester) async {
  await tester.pump();
  final image = await tester.runAsync(() async {
    final renderObject = _captureKey.currentContext?.findRenderObject();
    expect(renderObject, isA<RenderRepaintBoundary>());
    final boundary = renderObject! as RenderRepaintBoundary;
    final rendered = await boundary.toImage(pixelRatio: 1);
    try {
      final data = await rendered.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      return _CapturedImage(
        width: rendered.width,
        height: rendered.height,
        rgba: Uint8List.fromList(data!.buffer.asUint8List()),
      );
    } finally {
      rendered.dispose();
    }
  });
  return image!;
}

Widget _scene(
  FfiPocketRuntime runtime, {
  void Function(Object error)? onError,
}) {
  return Directionality(
    textDirection: TextDirection.ltr,
    child: Align(
      alignment: Alignment.topLeft,
      child: RepaintBoundary(
        key: _captureKey,
        child: SizedBox(
          width: 390,
          height: 600,
          child: PocketView(
            runtime: runtime,
            jsSource: _performanceGuestSource,
            viewport: const Size(390, 600),
            showDebugFps: false,
            onError: onError,
          ),
        ),
      ),
    ),
  );
}

Future<void> _waitForRefractive(
  WidgetTester tester, {
  Object? Function()? readError,
}) async {
  for (var attempt = 0; attempt < 120; attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
    final error = readError?.call();
    if (error != null) fail('PocketView onError: $error');
    if (find
        .byKey(const ValueKey('pocket-glass-failed'))
        .evaluate()
        .isNotEmpty) {
      fail('liquid glass shader failed to load');
    }
    if (find
            .byKey(const ValueKey('pocket-glass-refractive'))
            .evaluate()
            .length >=
        2) {
      return;
    }
  }
  // ignore: avoid_print
  print(
    'LIQUID_GLASS_WAIT refractive=${find.byKey(const ValueKey('pocket-glass-refractive')).evaluate().length} '
    'loading=${find.byKey(const ValueKey('pocket-glass-loading')).evaluate().length} '
    'failed=${find.byKey(const ValueKey('pocket-glass-failed')).evaluate().length} '
    'frosted=${find.byKey(const ValueKey('pocket-glass-frosted')).evaluate().length} '
    'backdrop=${find.byType(BackdropFilter).evaluate().length}',
  );
  fail('both native glass surfaces did not reach refractive BackdropFilters');
}

Future<void> _waitForNoGlass(
  WidgetTester tester, {
  Object? Function()? readError,
}) async {
  for (var attempt = 0; attempt < 80; attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
    final error = readError?.call();
    if (error != null) fail('PocketView onError: $error');
    if (find.byType(BackdropFilter).evaluate().isEmpty) return;
  }
  fail('native glass surfaces remained after release');
}

void _send(
  FfiPocketRuntime runtime,
  String name, [
  Map<String, dynamic>? payload,
]) {
  runtime.send(<String, dynamic>{
    'type': 'event',
    'name': name,
    'payload': payload ?? const <String, dynamic>{},
  });
}

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final ordered = [...values]..sort();
  return ordered[((ordered.length - 1) * fraction).round()];
}

Future<Map<String, dynamic>> _measurePhase(
  FrameTimingCollector collector,
  WidgetTester tester, {
  required String name,
  required Duration duration,
}) async {
  // Drain delayed callback batches before every window. The timing window is
  // source-time projected from FrameTiming, not pump cadence or screenshot
  // wall time.
  await collector.flushBeforeWindow();
  final startedWallTimeUs = DateTime.now().microsecondsSinceEpoch;
  await Future<void>.delayed(duration);
  final endedWallTimeUs = DateTime.now().microsecondsSinceEpoch;
  await collector.waitForDelayedBatch();
  final timings = collector.timingsInBuildWindow(
    startWallTimeUs: startedWallTimeUs,
    endWallTimeUs: endedWallTimeUs,
  );
  expect(
    timings.length,
    greaterThan(10),
    reason: '$name must produce real engine timings',
  );

  final build = timings
      .map((frame) => frame.buildDuration.inMicroseconds / 1000)
      .toList();
  final raster = timings
      .map((frame) => frame.rasterDuration.inMicroseconds / 1000)
      .toList();
  final stamps =
      timings
          .map(
            (frame) => frame.timestampInMicroseconds(ui.FramePhase.vsyncStart),
          )
          .where((stamp) => stamp > 0)
          .toList()
        ..sort();
  final gaps = <double>[];
  for (var index = 1; index < stamps.length; index++) {
    gaps.add((stamps[index] - stamps[index - 1]) / 1000);
  }
  final refreshHz = tester.view.display.refreshRate;
  return <String, dynamic>{
    'name': name,
    'frames': timings.length,
    'refreshHz': refreshHz,
    'observedHz': stamps.length < 2 || stamps.last == stamps.first
        ? null
        : (stamps.length - 1) * 1000000 / (stamps.last - stamps.first),
    'buildP50Ms': _percentile(build, .50),
    'buildP95Ms': _percentile(build, .95),
    'rasterP50Ms': _percentile(raster, .50),
    'rasterP95Ms': _percentile(raster, .95),
    'activeGapP50Ms': _percentile(gaps, .50),
    'activeGapP95Ms': _percentile(gaps, .95),
    'activeGapMaxMs': _percentile(gaps, 1),
    'durationMs': duration.inMilliseconds,
  };
}

bool _insideAny(int x, int y, List<Rect> regions) {
  return regions.any(
    (region) => region.contains(Offset(x.toDouble(), y.toDouble())),
  );
}

int _changedPixels(
  _CapturedImage first,
  _CapturedImage second, {
  List<Rect>? include,
  List<Rect>? exclude,
  int threshold = 2,
}) {
  expect(first.width, second.width);
  expect(first.height, second.height);
  var changed = 0;
  for (var y = 0; y < first.height; y++) {
    for (var x = 0; x < first.width; x++) {
      if (include != null && !_insideAny(x, y, include)) continue;
      if (exclude != null && _insideAny(x, y, exclude)) continue;
      final offset = (y * first.width + x) * 4;
      var delta = 0;
      for (var channel = 0; channel < 4; channel++) {
        delta += (first.rgba[offset + channel] - second.rgba[offset + channel])
            .abs();
      }
      if (delta > threshold) changed++;
    }
  }
  return changed;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('profile native liquid glass with two moving surfaces', (
    tester,
  ) async {
    final shaderSupported = ui.ImageFilter.isShaderFilterSupported;
    if (!shaderSupported) {
      final report = <String, dynamic>{
        'status': 'unsupported',
        'shaderFilterSupported': false,
        'refreshHz': tester.view.display.refreshRate,
        'reason':
            'host does not expose Flutter shader filters; no native glass FPS was claimed',
      };
      // ignore: avoid_print
      print('LIQUID_GLASS_PERF ${jsonEncode(report)}');
      binding.reportData = <String, dynamic>{
        ...?(binding.reportData),
        'liquidGlassPerformance': report,
      };
      return;
    }

    FfiPocketRuntime? runtime;
    final collector = FrameTimingCollector();
    try {
      runtime = FfiPocketRuntime.open(width: 390, height: 600, tickHz: 60);
      Object? viewError;
      await tester.pumpWidget(
        _scene(runtime, onError: (error) => viewError = error),
      );
      await _waitForRefractive(tester, readError: () => viewError);
      expect(find.byType(BackdropFilter), findsNWidgets(2));

      // Shape and pressed changes are sampled while the background is frozen,
      // so the pixel assertion does not confuse moving backdrop pixels with
      // optical parameter changes. These captures happen before measurement.
      final roundedIdle = await _capture(tester);
      _send(runtime, 'qa.glass.performance.pressed', <String, dynamic>{
        'pressed': true,
        'shape': 'pill',
      });
      await tester.pump(const Duration(milliseconds: 350));
      await _waitForRefractive(tester, readError: () => viewError);
      final pressedPillIdle = await _capture(tester);
      const glassRegions = <Rect>[
        Rect.fromLTWH(26, 178, 154, 194),
        Rect.fromLTWH(210, 206, 154, 194),
      ];
      final shapePressedChanged = _changedPixels(
        roundedIdle,
        pressedPillIdle,
        include: glassRegions,
      );
      final outsideShapePressedChanged = _changedPixels(
        roundedIdle,
        pressedPillIdle,
        exclude: glassRegions,
      );
      expect(
        shapePressedChanged,
        greaterThan(100),
        reason: 'shape/pressed update must alter both glass surfaces',
      );
      expect(
        outsideShapePressedChanged,
        lessThanOrEqualTo(128),
        reason: 'shape/pressed update must stay inside glass bounds',
      );

      _send(runtime, 'qa.glass.performance.animate');
      await tester.pump(const Duration(milliseconds: 100));
      final glass = await _measurePhase(
        collector,
        tester,
        name: 'two_glass_dynamic_background',
        duration: const Duration(seconds: 2),
      );

      // Stop the moving background before the removal capture. This makes the
      // negative-control pixel check independent from timing-window work.
      _send(runtime, 'qa.glass.performance.pause');
      await tester.pump(const Duration(milliseconds: 250));
      final withGlassFrozen = await _capture(tester);
      _send(runtime, 'qa.glass.performance.remove');
      await _waitForNoGlass(tester, readError: () => viewError);
      final withoutGlassFrozen = await _capture(tester);
      final removedGlassChanged = _changedPixels(
        withGlassFrozen,
        withoutGlassFrozen,
        include: glassRegions,
      );
      final outsideRemovedChanged = _changedPixels(
        withGlassFrozen,
        withoutGlassFrozen,
        exclude: glassRegions,
      );
      expect(
        removedGlassChanged,
        greaterThan(500),
        reason: 'release must remove both glass surfaces from sampled pixels',
      );
      expect(
        outsideRemovedChanged,
        lessThanOrEqualTo(128),
        reason: 'release must not repaint outside glass bounds',
      );

      _send(runtime, 'qa.glass.performance.animate');
      await tester.pump(const Duration(milliseconds: 100));
      final noGlass = await _measurePhase(
        collector,
        tester,
        name: 'same_dynamic_background_without_glass',
        duration: const Duration(seconds: 2),
      );

      final report = <String, dynamic>{
        'status': 'measured',
        'shaderFilterSupported': shaderSupported,
        'refreshHz': tester.view.display.refreshRate,
        'glassSurfaceCount': 2,
        'shapePressedChangedPixels': shapePressedChanged,
        'outsideShapePressedChangedPixels': outsideShapePressedChanged,
        'removedGlassChangedPixels': removedGlassChanged,
        'outsideRemovedChangedPixels': outsideRemovedChanged,
        'phases': <Map<String, dynamic>>[glass, noGlass],
        'screenshotTiming': 'after_each_FrameTiming_window',
      };
      // ignore: avoid_print
      print('LIQUID_GLASS_PERF ${jsonEncode(report)}');
      binding.reportData = <String, dynamic>{
        ...?(binding.reportData),
        'liquidGlassPerformance': report,
      };
    } finally {
      collector.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      runtime?.dispose();
    }
  });
}
