import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final GlobalKey _captureKey = GlobalKey();

// This source deliberately uses the raw ui/pocket contract.  The production
// host mounts signed QuickJS bytecode; this one test keeps the native surface
// path independently observable so it can distinguish a real SURFACE_QUAD
// from a Flutter widget that was merely placed in the tree.
const String _glassGuestSource = r'''
const ROOT = 1;

function rect(x, y, width, height, color, z) {
  const node = ui.createNode(0);
  ui.setProp(node, 1, width);       // PROP.width
  ui.setProp(node, 2, height);      // PROP.height
  ui.setProp(node, 24, 1);          // ENUMS.PosType.Absolute
  ui.setProp(node, 25, y);          // PROP.insetT
  ui.setProp(node, 28, x);          // PROP.insetL
  ui.setProp(node, 31, z);          // PROP.zIndex
  ui.setProp(node, 64, color);      // PROP.bgColor
  ui.insertBefore(ROOT, node, 0);
  return node;
}

// A set of opaque bands makes the backdrop sample spatially non-uniform.  A
// glass shader over a single flat fill can pass a false-positive pixel test.
rect(0, 0, 390, 600, 0xff101827, 0);
rect(0, 0, 390, 120, 0xff19324d, 1);
rect(0, 120, 390, 120, 0xffd97742, 1);
rect(0, 240, 390, 120, 0xff2a9d8f, 1);
rect(0, 360, 390, 120, 0xfff6bd60, 1);
rect(0, 480, 390, 120, 0xff6d597a, 1);
rect(0, 170, 180, 210, 0xff264653, 2);
rect(180, 170, 210, 210, 0xffe76f51, 2);

let warp = true;
function glassPayload(shape) {
  return JSON.stringify({
    radius: 24,
    blur: 7,
    edgeIntensity: 0.08,
    rimIntensity: 0.16,
    baseIntensity: 0.02,
    tintOpacity: 0.10,
    cornerBoost: 0.12,
    rippleEffect: 0.08,
    warp: warp,
    pressed: false,
    shape: shape,
  });
}

let glassNode = ui.createNode(3);
ui.setProp(glassNode, 1, 270);       // PROP.width
ui.setProp(glassNode, 2, 190);       // PROP.height
ui.setProp(glassNode, 24, 1);        // ENUMS.PosType.Absolute
ui.setProp(glassNode, 25, 180);      // PROP.insetT
ui.setProp(glassNode, 28, 60);       // PROP.insetL
ui.setProp(glassNode, 31, 100);      // PROP.zIndex
const glassHandle = pocket.registerSurface(
  'qa.glass',
  'glass',
  glassPayload('rounded'),
);
ui.setCompositorSurface(glassNode, glassHandle, 0);
ui.insertBefore(ROOT, glassNode, 0);

// Test control is sent through the same native event ingress used by hosts.
// The update and release therefore appear only on a subsequent native frame.
globalThis.__pocketEvent = function(message) {
  const event = typeof message === 'string' ? JSON.parse(message) : message;
  if (event.name === 'qa.glass.optics' && glassNode !== 0) {
    warp = false;
    pocket.registerSurface('qa.glass', 'glass', glassPayload('pill'));
  }
  if (event.name === 'qa.glass.shape' && glassNode !== 0) {
    const shape = event.payload && event.payload.shape === 'pill'
      ? 'pill'
      : 'rounded';
    pocket.registerSurface('qa.glass', 'glass', glassPayload(shape));
  }
  if (event.name === 'qa.glass.release' && glassNode !== 0) {
    ui.destroyNode(glassNode);
    glassNode = 0;
    pocket.releaseSurface('qa.glass');
  }
};
globalThis.__pocketEvent.__binaryCapable = true;

globalThis.frame = function() {};
''';

final class _CapturedImage {
  const _CapturedImage({
    required this.width,
    required this.height,
    required this.rgba,
    required this.png,
  });

  final int width;
  final int height;
  final Uint8List rgba;
  final Uint8List png;
}

Future<_CapturedImage> _capture(WidgetTester tester) async {
  await tester.pump();
  final image = await tester.runAsync(() async {
    final renderObject = _captureKey.currentContext?.findRenderObject();
    expect(renderObject, isA<RenderRepaintBoundary>());
    final boundary = renderObject! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final rgbaData = await image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      final pngData = await image.toByteData(format: ui.ImageByteFormat.png);
      return _CapturedImage(
        width: image.width,
        height: image.height,
        rgba: Uint8List.fromList(rgbaData!.buffer.asUint8List()),
        png: Uint8List.fromList(pngData!.buffer.asUint8List()),
      );
    } finally {
      image.dispose();
    }
  });
  return image!;
}

Future<Uint8List> _encodeRgbaPng(Uint8List rgba, int width, int height) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(rgba);
  final descriptor = ui.ImageDescriptor.raw(
    buffer,
    width: width,
    height: height,
    pixelFormat: ui.PixelFormat.rgba8888,
  );
  final codec = await descriptor.instantiateCodec();
  try {
    final frame = await codec.getNextFrame();
    try {
      final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
      return Uint8List.fromList(data!.buffer.asUint8List());
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
    descriptor.dispose();
    buffer.dispose();
  }
}

Future<_CapturedImage> _crop(_CapturedImage source, Rect region) async {
  final left = region.left.round();
  final top = region.top.round();
  final width = region.width.round();
  final height = region.height.round();
  expect(left, greaterThanOrEqualTo(0));
  expect(top, greaterThanOrEqualTo(0));
  expect(left + width, lessThanOrEqualTo(source.width));
  expect(top + height, lessThanOrEqualTo(source.height));
  final rgba = Uint8List(width * height * 4);
  for (var y = 0; y < height; y++) {
    final sourceStart = ((top + y) * source.width + left) * 4;
    final targetStart = y * width * 4;
    rgba.setRange(
      targetStart,
      targetStart + width * 4,
      source.rgba,
      sourceStart,
    );
  }
  return _CapturedImage(
    width: width,
    height: height,
    rgba: rgba,
    png: await _encodeRgbaPng(rgba, width, height),
  );
}

void _recordCapture(String name, Uint8List png) {
  final binding = IntegrationTestWidgetsFlutterBinding.instance;
  binding.reportData ??= <String, dynamic>{};
  final captures = binding.reportData!.putIfAbsent(
    'captures',
    () => <String, dynamic>{},
  );
  (captures as Map<String, dynamic>)[name] = base64Encode(png);
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
        .isNotEmpty) {
      return;
    }
  }
  fail('native glass surface did not reach a refractive BackdropFilter');
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
  fail('released native glass surface remained in the Flutter scene');
}

int _changedPixels(
  _CapturedImage first,
  _CapturedImage second, {
  required Rect region,
  bool skipGlassBounds = false,
  int threshold = 2,
}) {
  expect(first.width, second.width);
  expect(first.height, second.height);
  final left = math.max(0, region.left.floor());
  final top = math.max(0, region.top.floor());
  final right = math.min(first.width, region.right.ceil());
  final bottom = math.min(first.height, region.bottom.ceil());
  const glassLeft = 60;
  const glassTop = 180;
  const glassRight = 330;
  const glassBottom = 370;
  var changed = 0;
  for (var y = top; y < bottom; y++) {
    for (var x = left; x < right; x++) {
      if (skipGlassBounds &&
          x >= glassLeft &&
          x < glassRight &&
          y >= glassTop &&
          y < glassBottom) {
        continue;
      }
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

Widget _glassScene(
  FfiPocketRuntime runtime, {
  required bool offset,
  void Function(Object error)? onError,
}) {
  final guest = SizedBox(
    width: 390,
    height: 600,
    child: PocketView(
      runtime: runtime,
      jsSource: _glassGuestSource,
      viewport: const Size(390, 600),
      showDebugFps: false,
      onError: onError,
    ),
  );
  final boundary = RepaintBoundary(
    key: _captureKey,
    child: offset
        ? SizedBox(
            width: 550,
            height: 680,
            child: Padding(
              padding: const EdgeInsets.only(left: 80, top: 30),
              child: Align(alignment: Alignment.topLeft, child: guest),
            ),
          )
        : guest,
  );
  return Directionality(
    textDirection: TextDirection.ltr,
    child: Align(
      alignment: Alignment.topLeft,
      child: offset
          ? OverflowBox(
              alignment: Alignment.topLeft,
              minWidth: 550,
              maxWidth: 550,
              minHeight: 680,
              maxHeight: 680,
              child: boundary,
            )
          : boundary,
    ),
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('native glass surface reaches the real Flutter shader', (
    tester,
  ) async {
    expect(
      ui.ImageFilter.isShaderFilterSupported,
      isTrue,
      reason: 'glass optics requires the Impeller shader filter path',
    );

    FfiPocketRuntime? runtime;
    Object? viewError;
    void onViewError(Object error) {
      viewError = error;
    }

    try {
      runtime = FfiPocketRuntime.open(width: 390, height: 600, tickHz: 60);
      await tester.pumpWidget(
        _glassScene(runtime, offset: false, onError: onViewError),
      );

      // A native SURFACE_QUAD is materialized by PocketView as this actual
      // compositor child.  Require the Impeller shader, not the frosted
      // fallback, so this test cannot pass by merely adding a widget.
      await _waitForRefractive(tester, readError: () => viewError);
      expect(find.byType(BackdropFilter), findsWidgets);
      expect(find.byKey(const ValueKey('pocket-glass-failed')), findsNothing);
      final rounded = await _capture(tester);

      runtime.send(<String, dynamic>{
        'type': 'event',
        'id': 'qa-glass-shape',
        'name': 'qa.glass.shape',
        'payload': <String, dynamic>{'shape': 'pill'},
      });
      await tester.pump(const Duration(milliseconds: 350));
      await _waitForRefractive(tester, readError: () => viewError);
      final pill = await _capture(tester);
      runtime.send(<String, dynamic>{
        'type': 'event',
        'name': 'qa.glass.optics',
        'payload': <String, dynamic>{},
      });
      await tester.pump(const Duration(milliseconds: 350));
      final noWarp = await _capture(tester);

      runtime.send(<String, dynamic>{
        'type': 'event',
        'id': 'qa-glass-release',
        'name': 'qa.glass.release',
        'payload': <String, dynamic>{},
      });
      await _waitForNoGlass(tester, readError: () => viewError);
      final released = await _capture(tester);

      const glassBounds = Rect.fromLTWH(60, 180, 270, 190);
      final glassChanged = _changedPixels(
        rounded,
        released,
        region: glassBounds,
      );
      final outsideChanged = _changedPixels(
        rounded,
        released,
        region: Rect.fromLTWH(0, 0, 390, 600),
        skipGlassBounds: true,
      );
      final shapeChanged = _changedPixels(rounded, pill, region: glassBounds);
      final warpChanged = _changedPixels(
        pill,
        noWarp,
        region: const Rect.fromLTWH(100, 220, 190, 110),
      );
      expect(
        warpChanged,
        greaterThan(50),
        reason:
            'Disabling JS optical warp must alter interior backdrop samples, not just a tinted silhouette',
      );
      _recordCapture('glass-rounded', rounded.png);
      _recordCapture('glass-no-warp', noWarp.png);

      expect(
        glassChanged,
        greaterThan(500),
        reason: 'glass pixels must change when the native surface is removed',
      );
      expect(
        shapeChanged,
        greaterThan(50),
        reason: 'glassshape parameter update must change the rendered frame',
      );
      expect(
        outsideChanged,
        lessThanOrEqualTo(64),
        reason: 'BackdropFilter must not repaint pixels outside its surface',
      );

      _recordCapture('glass-optics', pill.png);

      // Recreate the same guest in a larger, offset canvas. The cropped
      // pixels must remain equivalent to the origin scene; otherwise the
      // BackdropFilter/shader is using Flutter-view coordinates instead of
      // the compositor surface's local geometry.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      runtime.dispose();
      runtime = null;
      final offsetRuntime = FfiPocketRuntime.open(
        width: 390,
        height: 600,
        tickHz: 60,
      );
      runtime = offsetRuntime;
      viewError = null;
      await tester.pumpWidget(
        _glassScene(offsetRuntime, offset: true, onError: onViewError),
      );
      await _waitForRefractive(tester, readError: () => viewError);
      final offsetFrame = await _capture(tester);
      final offsetCrop = await _crop(
        offsetFrame,
        const Rect.fromLTWH(80, 30, 390, 600),
      );
      final offsetDiff = _changedPixels(
        rounded,
        offsetCrop,
        region: const Rect.fromLTWH(0, 0, 390, 600),
        threshold: 8,
      );
      _recordCapture('glass-offset-cropped', offsetCrop.png);
      expect(
        offsetDiff,
        lessThanOrEqualTo(512),
        reason:
            'an offset compositor canvas must preserve local glass optics after cropping back to guest coordinates',
      );
      _recordCapture('glass-offset-cropped', offsetCrop.png);
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      runtime?.dispose();
    }
  });
}
