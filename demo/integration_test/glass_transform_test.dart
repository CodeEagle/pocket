import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'frame_timing_collector.dart';

const _viewport = Size(390, 600);
const _surfaceId = 'qa.glass.transform';
// Native binary u32 colors are decoded in byte order, so PocketRectOp exposes
// the guest literal with its RGB bytes reversed.
const _foregroundFlutterColor = 0xffa8e500;
final GlobalKey _captureKey = GlobalKey();

// This is the same raw ui/pocket contract used by the existing glass optics
// and performance fixtures.  The transform belongs to one JS parent, so the
// host surface and its foreground child must receive the same world matrix.
// No buildGuest output or Flutter-owned interaction state is involved.
const String _transformGuestSource = r'''
const ROOT = 1;
const group = ui.createNode(0);
const glass = ui.createNode(3);
const foreground = ui.createNode(0);
let animate = false;
let localAnimate = false;
let phase = 0;
let localPhase = 0;

function box(node, x, y, width, height, color, z) {
  ui.setProp(node, 1, width);   // PROP.width
  ui.setProp(node, 2, height);  // PROP.height
  ui.setProp(node, 24, 1);      // ENUMS.PosType.Absolute
  ui.setProp(node, 25, y);      // PROP.insetT
  ui.setProp(node, 28, x);      // PROP.insetL
  ui.setProp(node, 31, z);      // PROP.zIndex
  if (color !== 0) ui.setProp(node, 64, color); // PROP.bgColor
}

// A non-uniform backdrop makes a glass pixel test observable without a
// screenshot/readback in the JS guest.
const backdrop = ui.createNode(0);
box(backdrop, 0, 0, 390, 600, 0xff101827, 0);
ui.insertBefore(ROOT, backdrop, 0);
const bandA = ui.createNode(0);
box(bandA, 0, 0, 390, 120, 0xff19324d, 1);
ui.insertBefore(ROOT, bandA, 0);
const bandB = ui.createNode(0);
box(bandB, 0, 120, 390, 120, 0xffd97742, 1);
ui.insertBefore(ROOT, bandB, 0);
const bandC = ui.createNode(0);
box(bandC, 0, 240, 390, 120, 0xff2a9d8f, 1);
ui.insertBefore(ROOT, bandC, 0);
const bandD = ui.createNode(0);
box(bandD, 0, 360, 390, 120, 0xfff6bd60, 1);
ui.insertBefore(ROOT, bandD, 0);
const bandE = ui.createNode(0);
box(bandE, 0, 480, 390, 120, 0xff6d597a, 1);
ui.insertBefore(ROOT, bandE, 0);
const backdropAccent = ui.createNode(0);
box(backdropAccent, 16, 82, 132, 224, 0xffe76f51, 2);
ui.insertBefore(ROOT, backdropAccent, 0);

// Top-left origin makes the expected world rect deterministic:
// x' = x * scaleX + translateX, y' = y * scaleY + translateY.
box(group, 0, 0, 390, 600, 0, 100);
ui.setProp(group, 134, -0.5); // PROP.originX
ui.setProp(group, 135, -0.5); // PROP.originY
ui.insertBefore(ROOT, group, 0);

box(glass, 140, 160, 200, 180, 0, 0);
ui.insertBefore(group, glass, 0);
box(foreground, 178, 220, 72, 48, 0xff00e5a8, 10);
ui.insertBefore(group, foreground, 0);

function payload() {
  return JSON.stringify({
    radius: 24,
    blur: 12,
    edgeIntensity: 0.08,
    rimIntensity: 0.16,
    baseIntensity: 0.02,
    tintOpacity: 0.10,
    cornerBoost: 0.12,
    rippleEffect: 0.08,
    warp: true,
    materialStrength: 0.24,
    material: 'regular',
    materialTint: 0xff1c1c1e,
    pressed: false,
    shape: 'rounded',
  });
}

function localPayload(data) {
  const next = JSON.parse(payload());
  next.opticalInset = 36;
  next.deformation = data && data.deformation ? data.deformation : {
    anchorX: 0, anchorY: 0, offsetX: 0, offsetY: 0, radius: 0,
  };
  next.magnification = data && data.magnification ? Number(data.magnification) : 1;
  return JSON.stringify(next);
}

const handle = pocket.registerSurface('qa.glass.transform', 'glass', payload());
ui.setCompositorSurface(glass, handle, 0);

function setTransform(tx, ty, sx, sy) {
  ui.setProp(group, 128, tx); // PROP.translateX
  ui.setProp(group, 129, ty); // PROP.translateY
  ui.setProp(group, 132, sx); // PROP.scaleX
  ui.setProp(group, 133, sy); // PROP.scaleY
}
setTransform(0, 0, 1, 1);

globalThis.__pocketEvent = function(message) {
  const event = typeof message === 'string' ? JSON.parse(message) : message;
  const data = event.payload || {};
  if (event.name === 'qa.glass.transform.set') {
    animate = false;
    setTransform(
      Number(data.translateX || 0),
      Number(data.translateY || 0),
      Number(data.scaleX || 1),
      Number(data.scaleY || 1),
    );
  }
  if (event.name === 'qa.glass.transform.animate') {
    animate = true;
  }
  if (event.name === 'qa.glass.transform.restore') {
    animate = false;
    localAnimate = false;
    setTransform(0, 0, 1, 1);
  }
  if (event.name === 'qa.glass.transform.local') {
    // Expand only the compositor paint quad. The opticalInset sent in the
    // descriptor tells the renderer where the original shape lives; layout
    // and hit testing remain owned by the original shell node.
    box(glass, 104, 124, 272, 252, 0, 0);
    pocket.registerSurface('qa.glass.transform', 'glass', localPayload(data));
  }
  if (event.name === 'qa.glass.transform.local.animate') {
    animate = false;
    localAnimate = true;
    localPhase = 0;
    box(glass, 104, 124, 272, 252, 0, 0);
    pocket.registerSurface('qa.glass.transform', 'glass', localPayload({
      deformation: { anchorX: 84, anchorY: 0, offsetX: 0, offsetY: 0, radius: 128 },
    }));
  }
  if (event.name === 'qa.glass.transform.stretch') {
    animate = false;
    const scaleX = Number(data.scaleX || 1);
    const scaleY = Number(data.scaleY || 1);
    // Keep the glass center fixed while the existing paint transform stretches
    // its two axes. This is the native-side equivalent of the draggable
    // control's jelly response: the control does not travel with the finger.
    const anchorX = Number(data.anchorX || 240);
    const anchorY = Number(data.anchorY || 250);
    setTransform(anchorX * (1 - scaleX), anchorY * (1 - scaleY), scaleX, scaleY);
  }
};
globalThis.__pocketEvent.__binaryCapable = true;

globalThis.frame = function() {
  if (localAnimate) {
    localPhase += 0.12;
    pocket.registerSurface('qa.glass.transform', 'glass', localPayload({
      deformation: {
        anchorX: 84,
        anchorY: 0,
        offsetX: Math.sin(localPhase) * 12,
        offsetY: Math.cos(localPhase * 0.73) * 4,
        radius: 128,
      },
    }));
    return;
  }
  if (!animate) return;
  phase += 0.12;
  setTransform(
    40 + Math.sin(phase) * 18,
    Math.cos(phase * 0.73) * 8,
    1.06 + Math.sin(phase * 0.91) * 0.06,
    0.96 + Math.cos(phase * 0.67) * 0.05,
  );
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

final class _ColorBounds {
  const _ColorBounds(this.left, this.top, this.right, this.bottom, this.count);

  final int left;
  final int top;
  final int right;
  final int bottom;
  final int count;

  double get width => right - left + 1;
  double get height => bottom - top + 1;
}

Future<_CapturedImage> _capture(WidgetTester tester) async {
  await tester.pump();
  final captured = await tester.runAsync(() async {
    final object = _captureKey.currentContext?.findRenderObject();
    expect(object, isA<RenderRepaintBoundary>());
    final image = await (object! as RenderRepaintBoundary).toImage(
      pixelRatio: 1,
    );
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      return _CapturedImage(
        width: image.width,
        height: image.height,
        rgba: Uint8List.fromList(data!.buffer.asUint8List()),
      );
    } finally {
      image.dispose();
    }
  });
  return captured!;
}

Widget _scene(
  FfiPocketRuntime runtime, {
  required PocketViewController controller,
  void Function(Object error)? onError,
}) {
  return Directionality(
    textDirection: TextDirection.ltr,
    child: Align(
      alignment: Alignment.topLeft,
      child: RepaintBoundary(
        key: _captureKey,
        child: SizedBox(
          width: _viewport.width,
          height: _viewport.height,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            jsSource: _transformGuestSource,
            viewport: _viewport,
            showDebugFps: false,
            onError: onError,
          ),
        ),
      ),
    ),
  );
}

void _send(
  PocketViewController controller,
  String name, [
  Map<String, dynamic>? payload,
]) {
  expect(
    controller.send(method: name, params: payload ?? const <String, dynamic>{}),
    isTrue,
    reason: 'PocketView controller must deliver the transform event',
  );
}

PocketHostSurfaceOp _surface(PocketFrame frame) {
  return frame.ops.whereType<PocketHostSurfaceOp>().singleWhere(
    (op) => op.id == _surfaceId,
  );
}

PocketRectOp _foreground(PocketFrame frame) {
  return frame.ops.whereType<PocketRectOp>().singleWhere(
    (op) => op.color == _foregroundFlutterColor,
  );
}

Future<void> _waitForShader(
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
        .isNotEmpty) {
      return;
    }
  }
  fail('native glass surface did not reach a refractive BackdropFilter');
}

Future<PocketFrame> _waitForFrame(
  WidgetTester tester,
  PocketFrame? Function() readFrame, {
  required bool Function(PocketFrame frame) ready,
  Object? Function()? readError,
}) async {
  for (var attempt = 0; attempt < 120; attempt++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
    final error = readError?.call();
    if (error != null) fail('PocketView onError: $error');
    final frame = readFrame();
    if (frame != null && ready(frame)) return frame;
  }
  final frame = readFrame();
  if (frame != null) {
    // ignore: avoid_print
    print(
      'LIQUID_GLASS_TRANSFORM_FRAME_TIMEOUT ops=${frame.ops.map((op) => '${op.runtimeType}:${op is PocketHostSurfaceOp
          ? op.id
          : op is PocketRectOp
          ? op.color.toRadixString(16)
          : ''}:${op.x},${op.y},${op.width},${op.height}').join('|')}',
    );
  }
  fail('timed out waiting for the transformed SURFACE_QUAD frame');
}

_ColorBounds? _colorBounds(
  _CapturedImage image,
  int color, {
  int tolerance = 3,
}) {
  final red = color >> 16 & 0xff;
  final green = color >> 8 & 0xff;
  final blue = color & 0xff;
  var left = image.width;
  var top = image.height;
  var right = -1;
  var bottom = -1;
  var count = 0;
  for (var y = 0; y < image.height; y++) {
    for (var x = 0; x < image.width; x++) {
      final offset = (y * image.width + x) * 4;
      if ((image.rgba[offset] - red).abs() > tolerance ||
          (image.rgba[offset + 1] - green).abs() > tolerance ||
          (image.rgba[offset + 2] - blue).abs() > tolerance ||
          image.rgba[offset + 3] < 240) {
        continue;
      }
      left = math.min(left, x);
      top = math.min(top, y);
      right = math.max(right, x);
      bottom = math.max(bottom, y);
      count++;
    }
  }
  return count == 0 ? null : _ColorBounds(left, top, right, bottom, count);
}

int _changedPixels(
  _CapturedImage first,
  _CapturedImage second, {
  Rect? include,
  Rect? exclude,
  int threshold = 2,
}) {
  expect(first.width, second.width);
  expect(first.height, second.height);
  var changed = 0;
  for (var y = 0; y < first.height; y++) {
    for (var x = 0; x < first.width; x++) {
      final point = Offset(x.toDouble(), y.toDouble());
      if (include != null && !include.contains(point)) continue;
      if (exclude != null && exclude.contains(point)) continue;
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

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final ordered = [...values]..sort();
  return ordered[((ordered.length - 1) * fraction).round()];
}

Future<Map<String, dynamic>> _measureTransform(
  FrameTimingCollector collector,
  WidgetTester tester,
  int Function() nativeFrameCount,
) async {
  await collector.flushBeforeWindow();
  final startWallTimeUs = DateTime.now().microsecondsSinceEpoch;
  await Future<void>.delayed(const Duration(seconds: 1));
  final endWallTimeUs = DateTime.now().microsecondsSinceEpoch;
  await collector.waitForDelayedBatch();
  final timings = collector.timingsInBuildWindow(
    startWallTimeUs: startWallTimeUs,
    endWallTimeUs: endWallTimeUs,
  );
  expect(
    timings.length,
    greaterThan(10),
    reason: 'transform must produce real engine timings',
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
  return <String, dynamic>{
    'frames': timings.length,
    'nativeFrameCalls': nativeFrameCount(),
    'refreshHz': tester.view.display.refreshRate,
    'observedHz': stamps.length < 2 || stamps.last == stamps.first
        ? null
        : (stamps.length - 1) * 1000000 / (stamps.last - stamps.first),
    'buildP50Ms': _percentile(build, .5),
    'buildP95Ms': _percentile(build, .95),
    'rasterP50Ms': _percentile(raster, .5),
    'rasterP95Ms': _percentile(raster, .95),
    'activeGapP50Ms': _percentile(gaps, .5),
    'activeGapP95Ms': _percentile(gaps, .95),
    'activeGapMaxMs': _percentile(gaps, 1),
    'durationMs': 1000,
  };
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'axis-aligned glass transform keeps surface, content and clip in sync',
    (tester) async {
      if (!ui.ImageFilter.isShaderFilterSupported) {
        final report = <String, dynamic>{
          'status': 'unsupported',
          'shaderFilterSupported': false,
          'deviceRefreshHz': tester.view.display.refreshRate,
          'reason':
              'host does not expose Flutter shader filters; no glass pixels claimed',
        };
        // ignore: avoid_print
        print('LIQUID_GLASS_TRANSFORM ${jsonEncode(report)}');
        binding.reportData = <String, dynamic>{
          ...?binding.reportData,
          'liquidGlassTransform': report,
        };
        return;
      }

      FfiPocketRuntime? runtime;
      final controller = PocketViewController();
      FrameTimingCollector? collector;
      Object? viewError;
      PocketFrame? latestFrame;
      var collecting = false;
      var dynamicNativeFrames = 0;
      final previousProbe = debugPocketFrameDeltaAtOverride;
      debugPocketFrameDeltaAtOverride = (currentRuntime, delta) {
        final frame = previousProbe == null
            ? pocketFrameDeltaAt(currentRuntime, delta)
            : previousProbe(currentRuntime, delta);
        if (frame != null) {
          latestFrame = frame;
          if (collecting) dynamicNativeFrames++;
        }
        return frame;
      };

      try {
        runtime = FfiPocketRuntime.open(
          width: _viewport.width,
          height: _viewport.height,
          tickHz: 60,
        );
        await tester.pumpWidget(
          _scene(
            runtime,
            controller: controller,
            onError: (error) => viewError = error,
          ),
        );
        await _waitForShader(tester, readError: () => viewError);
        // PocketView applies the startup frame directly from `load/eval`,
        // before the frame-delta testing seam is active. Read one authoritative
        // full frame for the geometry baseline; later event frames are observed
        // through debugPocketFrameDeltaAtOverride.
        latestFrame = runtime.frameAt(0);
        final baseFrame = await _waitForFrame(
          tester,
          () => latestFrame,
          readError: () => viewError,
          ready: (frame) {
            try {
              _surface(frame);
              _foreground(frame);
              return true;
            } catch (_) {
              return false;
            }
          },
        );
        final baseSurface = _surface(baseFrame);
        final baseForeground = _foreground(baseFrame);
        final baseCapture = await _capture(tester);
        final baseForegroundPixels = _colorBounds(
          baseCapture,
          _foregroundFlutterColor,
        );
        expect(baseForegroundPixels, isNotNull);

        const translateX = 40.0;
        const translateY = 0.0;
        const scaleX = 1.12;
        const scaleY = 0.94;
        _send(controller, 'qa.glass.transform.set', <String, dynamic>{
          'translateX': translateX,
          'translateY': translateY,
          'scaleX': scaleX,
          'scaleY': scaleY,
        });
        await tester.pump(const Duration(milliseconds: 100));
        final transformedFrame = await _waitForFrame(
          tester,
          () => latestFrame,
          readError: () => viewError,
          ready: (frame) {
            try {
              final surface = _surface(frame);
              return (surface.x - (baseSurface.x * scaleX + translateX)).abs() <
                      1.0 &&
                  (surface.width - baseSurface.width * scaleX).abs() < 1.0;
            } catch (_) {
              return false;
            }
          },
        );
        final transformedSurface = _surface(transformedFrame);
        final transformedForeground = _foreground(transformedFrame);
        final transformedCapture = await _capture(tester);

        expect(
          transformedSurface.x,
          closeTo(baseSurface.x * scaleX + translateX, 1),
        );
        expect(
          transformedSurface.y,
          closeTo(baseSurface.y * scaleY + translateY, 1),
        );
        expect(
          transformedSurface.width,
          closeTo(baseSurface.width * scaleX, 1),
        );
        expect(
          transformedSurface.height,
          closeTo(baseSurface.height * scaleY, 1),
        );
        expect(
          transformedForeground.x,
          closeTo(baseForeground.x * scaleX + translateX, 1),
        );
        expect(
          transformedForeground.y,
          closeTo(baseForeground.y * scaleY + translateY, 1),
        );
        expect(
          transformedForeground.width,
          closeTo(baseForeground.width * scaleX, 1),
        );
        expect(
          transformedForeground.height,
          closeTo(baseForeground.height * scaleY, 1),
        );

        final clip = transformedSurface.clip;
        expect(
          clip,
          isNotNull,
          reason: 'SURFACE_QUAD must retain a visible host clip',
        );
        // The transformed right edge is 420.8, so the viewport intersection must
        // reach the viewport edge. A stale identity clip ending near x=340 would
        // truncate the expanded glass surface.
        expect(clip!.x, lessThanOrEqualTo(transformedSurface.x + 1));
        expect(
          clip.x + clip.width,
          greaterThanOrEqualTo(
            math.min(
                  _viewport.width,
                  transformedSurface.x + transformedSurface.width,
                ) -
                1,
          ),
        );
        expect(
          clip.y + clip.height,
          greaterThanOrEqualTo(
            transformedSurface.y + transformedSurface.height - 1,
          ),
        );

        final transformedForegroundPixels = _colorBounds(
          transformedCapture,
          _foregroundFlutterColor,
        );
        expect(transformedForegroundPixels, isNotNull);
        expect(
          transformedForegroundPixels!.left,
          closeTo(baseForegroundPixels!.left * scaleX + translateX, 2),
        );
        expect(
          transformedForegroundPixels.top,
          closeTo(baseForegroundPixels.top * scaleY + translateY, 2),
        );
        expect(
          transformedForegroundPixels.width,
          closeTo(baseForegroundPixels.width * scaleX, 3),
        );
        expect(
          transformedForegroundPixels.height,
          closeTo(baseForegroundPixels.height * scaleY, 3),
        );

        final affected = Rect.fromLTRB(
          math.min(baseSurface.x, transformedSurface.x) - 3,
          math.min(baseSurface.y, transformedSurface.y) - 3,
          math.max(
                baseSurface.x + baseSurface.width,
                transformedSurface.x + transformedSurface.width,
              ) +
              3,
          math.max(
                baseSurface.y + baseSurface.height,
                transformedSurface.y + transformedSurface.height,
              ) +
              3,
        );
        final outsideChanged = _changedPixels(
          baseCapture,
          transformedCapture,
          exclude: affected,
        );
        final expandedGlassChanged = _changedPixels(
          baseCapture,
          transformedCapture,
          include: const Rect.fromLTWH(342, 160, 48, 170),
        );
        expect(
          expandedGlassChanged,
          greaterThan(100),
          reason: 'expanded glass edge must reach beyond its old right edge',
        );
        expect(
          outsideChanged,
          lessThanOrEqualTo(128),
          reason: 'transform must not alter pixels outside the glass union',
        );

        // A draggable glass control keeps its anchor in place while its own
        // body stretches and cross-axis squashes. Exercise that transform
        // through the same JS -> FFI -> Flutter path, compensating translation
        // around the measured surface center rather than moving the control.
        final anchorX = baseSurface.x + baseSurface.width / 2;
        final anchorY = baseSurface.y + baseSurface.height / 2;
        const stretchScaleX = 1.14;
        const stretchScaleY = 0.86;
        _send(controller, 'qa.glass.transform.stretch', <String, dynamic>{
          'anchorX': anchorX,
          'anchorY': anchorY,
          'scaleX': stretchScaleX,
          'scaleY': stretchScaleY,
        });
        await tester.pump(const Duration(milliseconds: 100));
        final stretchedFrame = await _waitForFrame(
          tester,
          () => latestFrame,
          readError: () => viewError,
          ready: (frame) {
            try {
              final surface = _surface(frame);
              final centerX = surface.x + surface.width / 2;
              final centerY = surface.y + surface.height / 2;
              return (centerX - anchorX).abs() < 1.0 &&
                  (centerY - anchorY).abs() < 1.0 &&
                  (surface.width - baseSurface.width * stretchScaleX).abs() <
                      1.0 &&
                  (surface.height - baseSurface.height * stretchScaleY).abs() <
                      1.0;
            } catch (_) {
              return false;
            }
          },
        );
        final stretchedSurface = _surface(stretchedFrame);
        final stretchedForeground = _foreground(stretchedFrame);
        final stretchedCapture = await _capture(tester);
        final stretchTranslateX = anchorX * (1 - stretchScaleX);
        final stretchTranslateY = anchorY * (1 - stretchScaleY);
        expect(
          stretchedSurface.x,
          closeTo(baseSurface.x * stretchScaleX + stretchTranslateX, 1),
        );
        expect(
          stretchedSurface.y,
          closeTo(baseSurface.y * stretchScaleY + stretchTranslateY, 1),
        );
        expect(
          stretchedSurface.width,
          closeTo(baseSurface.width * stretchScaleX, 1),
        );
        expect(
          stretchedSurface.height,
          closeTo(baseSurface.height * stretchScaleY, 1),
        );
        expect(
          stretchedSurface.x + stretchedSurface.width / 2,
          closeTo(anchorX, 1),
          reason: 'jelly stretch must keep the glass center stationary',
        );
        expect(
          stretchedSurface.y + stretchedSurface.height / 2,
          closeTo(anchorY, 1),
          reason: 'jelly stretch must keep the glass center stationary',
        );
        expect(
          stretchedForeground.x,
          closeTo(baseForeground.x * stretchScaleX + stretchTranslateX, 1),
        );
        expect(
          stretchedForeground.y,
          closeTo(baseForeground.y * stretchScaleY + stretchTranslateY, 1),
        );
        expect(
          stretchedForeground.width,
          closeTo(baseForeground.width * stretchScaleX, 1),
        );
        expect(
          stretchedForeground.height,
          closeTo(baseForeground.height * stretchScaleY, 1),
        );
        final stretchClip = stretchedSurface.clip;
        expect(stretchClip, isNotNull);
        expect(stretchClip!.x, lessThanOrEqualTo(stretchedSurface.x + 1));
        expect(
          stretchClip.x + stretchClip.width,
          greaterThanOrEqualTo(
            math.min(
                  _viewport.width,
                  stretchedSurface.x + stretchedSurface.width,
                ) -
                1,
          ),
        );
        expect(
          stretchClip.y + stretchClip.height,
          greaterThanOrEqualTo(
            stretchedSurface.y + stretchedSurface.height - 1,
          ),
        );
        final stretchedForegroundPixels = _colorBounds(
          stretchedCapture,
          _foregroundFlutterColor,
        );
        expect(stretchedForegroundPixels, isNotNull);
        expect(
          stretchedForegroundPixels!.left,
          closeTo(
            baseForegroundPixels!.left * stretchScaleX + stretchTranslateX,
            2,
          ),
        );
        expect(
          stretchedForegroundPixels.top,
          closeTo(
            baseForegroundPixels.top * stretchScaleY + stretchTranslateY,
            2,
          ),
        );
        expect(
          stretchedForegroundPixels.width,
          closeTo(baseForegroundPixels.width * stretchScaleX, 3),
        );
        expect(
          stretchedForegroundPixels.height,
          closeTo(baseForegroundPixels.height * stretchScaleY, 3),
        );
        final stretchAffected = Rect.fromLTRB(
          math.min(baseSurface.x, stretchedSurface.x) - 3,
          math.min(baseSurface.y, stretchedSurface.y) - 3,
          math.max(
                baseSurface.x + baseSurface.width,
                stretchedSurface.x + stretchedSurface.width,
              ) +
              3,
          math.max(
                baseSurface.y + baseSurface.height,
                stretchedSurface.y + stretchedSurface.height,
              ) +
              3,
        );
        final stretchOutsideChanged = _changedPixels(
          baseCapture,
          stretchedCapture,
          exclude: stretchAffected,
        );
        final stretchChanged = _changedPixels(
          baseCapture,
          stretchedCapture,
          include: stretchAffected,
        );
        expect(stretchChanged, greaterThan(100));
        expect(
          stretchOutsideChanged,
          lessThanOrEqualTo(128),
          reason: 'stationary stretch must not paint outside its fixed anchor',
        );

        _send(controller, 'qa.glass.transform.restore');
        await tester.pump(const Duration(milliseconds: 100));

        collector = FrameTimingCollector();
        collecting = true;
        _send(controller, 'qa.glass.transform.animate');
        await tester.pump(const Duration(milliseconds: 100));
        final timing = await _measureTransform(
          collector,
          tester,
          () => dynamicNativeFrames,
        );
        collecting = false;

        _send(controller, 'qa.glass.transform.restore');
        await tester.pump(const Duration(milliseconds: 100));
        final restoredFrame = await _waitForFrame(
          tester,
          () => latestFrame,
          readError: () => viewError,
          ready: (frame) {
            try {
              final surface = _surface(frame);
              return (surface.x - baseSurface.x).abs() < 1.0 &&
                  (surface.width - baseSurface.width).abs() < 1.0;
            } catch (_) {
              return false;
            }
          },
        );
        final restoredSurface = _surface(restoredFrame);
        final restoredForeground = _foreground(restoredFrame);
        final restoredCapture = await _capture(tester);
        expect(restoredSurface.x, closeTo(baseSurface.x, 1));
        expect(restoredSurface.y, closeTo(baseSurface.y, 1));
        expect(restoredSurface.width, closeTo(baseSurface.width, 1));
        expect(restoredSurface.height, closeTo(baseSurface.height, 1));
        expect(restoredForeground.x, closeTo(baseForeground.x, 1));
        expect(restoredForeground.y, closeTo(baseForeground.y, 1));
        expect(restoredForeground.width, closeTo(baseForeground.width, 1));
        expect(restoredForeground.height, closeTo(baseForeground.height, 1));
        final restoredChanged = _changedPixels(baseCapture, restoredCapture);
        expect(
          restoredChanged,
          lessThanOrEqualTo(512),
          reason: 'identity restore must return to the base pixels',
        );

        final report = <String, dynamic>{
          'status': 'measured',
          'shaderFilterSupported': true,
          'surface': <String, dynamic>{
            'base': <String, double>{
              'x': baseSurface.x,
              'y': baseSurface.y,
              'w': baseSurface.width,
              'h': baseSurface.height,
            },
            'transformed': <String, double>{
              'x': transformedSurface.x,
              'y': transformedSurface.y,
              'w': transformedSurface.width,
              'h': transformedSurface.height,
            },
            'restored': <String, double>{
              'x': restoredSurface.x,
              'y': restoredSurface.y,
              'w': restoredSurface.width,
              'h': restoredSurface.height,
            },
          },
          'foreground': <String, double>{
            'baseX': baseForeground.x,
            'baseY': baseForeground.y,
            'transformedX': transformedForeground.x,
            'transformedY': transformedForeground.y,
          },
          'expandedGlassChangedPixels': expandedGlassChanged,
          'outsideChangedPixels': outsideChanged,
          'stationaryStretch': <String, dynamic>{
            'anchorX': anchorX,
            'anchorY': anchorY,
            'scaleX': stretchScaleX,
            'scaleY': stretchScaleY,
            'changedPixels': stretchChanged,
            'outsideChangedPixels': stretchOutsideChanged,
          },
          'restoredChangedPixels': restoredChanged,
          'timing': timing,
          'screenshotTiming':
              'before/after FrameTiming window; toImage excluded',
        };
        // ignore: avoid_print
        print('LIQUID_GLASS_TRANSFORM ${jsonEncode(report)}');
        binding.reportData = <String, dynamic>{
          ...?binding.reportData,
          'liquidGlassTransform': report,
        };
      } finally {
        collecting = false;
        collector?.dispose();
        debugPocketFrameDeltaAtOverride = previousProbe;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        runtime?.dispose();
      }
    },
  );

  testWidgets(
    'local glass deformation paints an edge shoulder without moving its layout quad',
    (tester) async {
      if (!ui.ImageFilter.isShaderFilterSupported) {
        final report = <String, dynamic>{
          'status': 'unsupported',
          'shaderFilterSupported': false,
          'reason':
              'host does not expose Flutter shader filters; no local deformation pixels claimed',
        };
        // ignore: avoid_print
        print('LIQUID_GLASS_LOCAL_DEFORMATION ${jsonEncode(report)}');
        binding.reportData = <String, dynamic>{
          ...?binding.reportData,
          'liquidGlassLocalDeformation': report,
        };
        return;
      }

      FfiPocketRuntime? runtime;
      final controller = PocketViewController();
      FrameTimingCollector? collector;
      Object? viewError;
      var collecting = false;
      var localNativeFrames = 0;
      final previousProbe = debugPocketFrameDeltaAtOverride;
      debugPocketFrameDeltaAtOverride = (currentRuntime, delta) {
        final frame = previousProbe == null
            ? pocketFrameDeltaAt(currentRuntime, delta)
            : previousProbe(currentRuntime, delta);
        if (frame != null && collecting) localNativeFrames++;
        return frame;
      };
      try {
        runtime = FfiPocketRuntime.open(
          width: _viewport.width,
          height: _viewport.height,
          tickHz: 60,
        );
        await tester.pumpWidget(
          _scene(
            runtime,
            controller: controller,
            onError: (error) => viewError = error,
          ),
        );
        await _waitForShader(tester, readError: () => viewError);
        final baseFrame = await _waitForFrame(
          tester,
          () => runtime!.frameAt(0),
          readError: () => viewError,
          ready: (frame) {
            try {
              _surface(frame);
              return true;
            } catch (_) {
              return false;
            }
          },
        );
        final baseSurface = _surface(baseFrame);

        _send(controller, 'qa.glass.transform.local', <String, dynamic>{
          'deformation': <String, double>{
            'anchorX': 0,
            'anchorY': 0,
            'offsetX': 0,
            'offsetY': 0,
            'radius': 84,
          },
        });
        await tester.pump(const Duration(milliseconds: 100));
        final zeroFrame = await _waitForFrame(
          tester,
          () => runtime!.frameAt(0),
          readError: () => viewError,
          ready: (frame) => _surface(frame).parameters['opticalInset'] == 36,
        );
        final zeroSurface = _surface(zeroFrame);
        final zeroCapture = await _capture(tester);

        _send(controller, 'qa.glass.transform.local', <String, dynamic>{
          'deformation': <String, double>{
            'anchorX': 84,
            'anchorY': 0,
            'offsetX': 12,
            'offsetY': 0,
            'radius': 128,
          },
        });
        await tester.pump(const Duration(milliseconds: 100));
        final pulledFrame = await _waitForFrame(
          tester,
          () => runtime!.frameAt(0),
          readError: () => viewError,
          ready: (frame) =>
              ((_surface(frame).parameters['deformation'] as Map?)?['offsetX']
                      as num?) ==
                  12,
        );
        final pulledSurface = _surface(pulledFrame);
        final pulledCapture = await _capture(tester);
        expect(pulledSurface.x, zeroSurface.x);
        expect(pulledSurface.y, zeroSurface.y);
        expect(pulledSurface.width, zeroSurface.width);
        expect(pulledSurface.height, zeroSurface.height);

        _send(controller, 'qa.glass.transform.local', <String, dynamic>{
          'deformation': <String, double>{
            'anchorX': 84,
            'anchorY': 0,
            'offsetX': 0,
            'offsetY': 0,
            'radius': 84,
          },
        });
        await tester.pump(const Duration(milliseconds: 100));
        final restoredFrame = await _waitForFrame(
          tester,
          () => runtime!.frameAt(0),
          readError: () => viewError,
          ready: (frame) =>
              ((_surface(frame).parameters['deformation'] as Map?)?['offsetX']
                      as num?) ==
                  0,
        );
        final restoredCapture = await _capture(tester);

        final visualRect = Rect.fromLTWH(
          zeroSurface.x,
          zeroSurface.y,
          zeroSurface.width,
          zeroSurface.height,
        );
        final originalRect = visualRect.deflate(36);
        final shoulder = Rect.fromLTWH(
          originalRect.right,
          originalRect.top + 20,
          36,
          originalRect.height - 40,
        );
        final untouched = Rect.fromLTWH(
          originalRect.left,
          originalRect.top + 20,
          40,
          originalRect.height - 40,
        );
        final localChanged = _changedPixels(
          zeroCapture,
          pulledCapture,
          include: visualRect,
        );
        final shoulderChanged = _changedPixels(
          zeroCapture,
          pulledCapture,
          include: shoulder,
        );
        final untouchedChanged = _changedPixels(
          zeroCapture,
          pulledCapture,
          include: untouched,
        );
        final outsideChanged = _changedPixels(
          zeroCapture,
          pulledCapture,
          exclude: visualRect,
        );
        final restoredChanged = _changedPixels(zeroCapture, restoredCapture);
        expect(
          localChanged,
          greaterThan(100),
          reason: 'local pull must change real native shader pixels',
        );
        expect(
          shoulderChanged,
          greaterThan(20),
          reason: 'local pull must paint beyond the original right edge',
        );
        expect(
          untouchedChanged,
          lessThanOrEqualTo(8),
          reason: 'remote part of the same control must remain unchanged',
        );
        expect(
          outsideChanged,
          lessThanOrEqualTo(128),
          reason: 'local deformation must remain inside its padded visual halo',
        );
        expect(
          restoredChanged,
          lessThanOrEqualTo(512),
          reason: 'zero offset must restore the native source pixels',
        );

        collector = FrameTimingCollector();
        collecting = true;
        _send(controller, 'qa.glass.transform.local.animate');
        await tester.pump(const Duration(milliseconds: 100));
        final timing = await _measureTransform(
          collector,
          tester,
          () => localNativeFrames,
        );
        collecting = false;
        _send(controller, 'qa.glass.transform.restore');
        await tester.pump(const Duration(milliseconds: 100));

        final report = <String, dynamic>{
          'status': 'measured',
          'shaderFilterSupported': true,
          'layoutQuad': <String, double>{
            'x': baseSurface.x,
            'y': baseSurface.y,
            'w': baseSurface.width,
            'h': baseSurface.height,
          },
          'opticalInset': 36,
          'localChangedPixels': localChanged,
          'shoulderChangedPixels': shoulderChanged,
          'untouchedChangedPixels': untouchedChanged,
          'outsideChangedPixels': outsideChanged,
          'restoredChangedPixels': restoredChanged,
          'timing': timing,
          'timingWindow': 'continuous local deformation; toImage sampling outside window',
        };
        // ignore: avoid_print
        print('LIQUID_GLASS_LOCAL_DEFORMATION ${jsonEncode(report)}');
        binding.reportData = <String, dynamic>{
          ...?binding.reportData,
          'liquidGlassLocalDeformation': report,
        };
      } finally {
        collecting = false;
        collector?.dispose();
        debugPocketFrameDeltaAtOverride = previousProbe;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        runtime?.dispose();
      }
    },
  );
}
