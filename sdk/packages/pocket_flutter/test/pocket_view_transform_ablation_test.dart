import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _viewport = Size(128, 64);
const _hostColor = Color(0xff0b1220);
const _offsets = <int>[0, 1, 2, 3];

/// The fixture deliberately emits 128 opaque rect DrawOps, which spans four
/// PocketView retained canvas blocks. The JS variant changes every node's x
/// coordinate on an input command; the Flutter variant keeps this exact frame
/// static and moves its ancestor Transform by the same integer offset.
const _movingGuestSource = r'''
const nodes = [];
const baseX = [];
const baseY = [];
for (let i = 0; i < 128; i++) {
  const node = ui.createNode(0);
  const x = (i % 16) * 8;
  const y = Math.floor(i / 16) * 8;
  ui.setProp(node, 1, 7);
  ui.setProp(node, 2, 7);
  ui.setProp(node, 24, 1);
  ui.setProp(node, 25, y);
  ui.setProp(node, 28, x);
  ui.setProp(node, 64, 0xff204060 + i);
  ui.insertBefore(1, node, 0);
  nodes.push(node);
  baseX.push(x);
  baseY.push(y);
}
globalThis.frame = function() {};
globalThis.__pocketEvent = function(message) {
  if (message.name !== 'transform.move') return;
  const offset = message.payload.offset;
  for (let i = 0; i < nodes.length; i++) {
    ui.setProp(nodes[i], 28, baseX[i] + offset);
    ui.setProp(nodes[i], 25, baseY[i]);
  }
};
__pocketEvent.__binaryCapable = true;
JSON.parse = JSON.stringify = () => { throw Error('JSON reached transform transport'); };
''';

const _staticGuestSource = r'''
for (let i = 0; i < 128; i++) {
  const node = ui.createNode(0);
  const x = (i % 16) * 8;
  const y = Math.floor(i / 16) * 8;
  ui.setProp(node, 1, 7);
  ui.setProp(node, 2, 7);
  ui.setProp(node, 24, 1);
  ui.setProp(node, 25, y);
  ui.setProp(node, 28, x);
  ui.setProp(node, 64, 0xff204060 + i);
  ui.insertBefore(1, node, 0);
}
globalThis.frame = function() {};
''';

final class _TransformAblationRun {
  const _TransformAblationRun({
    required this.images,
    required this.canvasPaints,
    required this.paintedOps,
  });

  final List<Uint8List> images;
  final List<int> canvasPaints;
  final List<int> paintedOps;
}

void main() {
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final nativeReady = nativeLibrary != null && File(nativeLibrary).existsSync();

  testWidgets(
    'JS geometry transform repaints retained blocks while Flutter ancestor transform retains them',
    (tester) async {
      final jsRun = await _runJsCoordinateVariant(tester);
      final flutterRun = await _runFlutterTransformVariant(tester);

      expect(jsRun.images, hasLength(_offsets.length));
      expect(flutterRun.images, hasLength(_offsets.length));
      for (var index = 0; index < _offsets.length; index++) {
        expect(
          jsRun.images[index],
          orderedEquals(flutterRun.images[index]),
          reason:
              'integer offset ${_offsets[index]} must produce identical pixels',
        );
      }

      // Every JS coordinate update changes all four retained blocks. The exact
      // block count is an implementation detail, but every DrawOp must be
      // visited by a repaint in this variant.
      expect(
        jsRun.canvasPaints,
        everyElement(greaterThan(0)),
        reason: 'JS geometry changes should invalidate every retained block',
      );
      expect(
        jsRun.paintedOps,
        everyElement(equals(128)),
        reason: 'the JS variant should repaint all 128 DrawOps per step',
      );

      // Transform.translate updates the compositor layer above the static
      // PocketView. Its retained CustomPaint blocks should not paint again.
      expect(
        flutterRun.canvasPaints,
        everyElement(equals(0)),
        reason: 'ancestor transforms should retain the static canvas blocks',
      );
      expect(
        flutterRun.paintedOps,
        everyElement(equals(0)),
        reason: 'ancestor transforms should not visit DrawOps again',
      );
    },
    skip: !nativeReady,
  );
}

Future<_TransformAblationRun> _runJsCoordinateVariant(
  WidgetTester tester,
) async {
  final runtime = FfiPocketRuntime.open(
    width: _viewport.width,
    height: _viewport.height,
  );
  final controller = PocketViewController();
  final boundaryKey = GlobalKey();
  try {
    await _pumpHost(
      tester,
      boundaryKey: boundaryKey,
      runtime: runtime,
      controller: controller,
      jsSource: _movingGuestSource,
    );
    _assert128Ops(tester);
    final images = <Uint8List>[await _capture(tester, boundaryKey)];
    final canvasPaints = <int>[];
    final paintedOps = <int>[];
    for (final offset in _offsets.skip(1)) {
      expect(
        controller.send(
          method: 'transform.move',
          params: <String, dynamic>{'offset': offset},
        ),
        isTrue,
      );
      await _pumpGuestFrame(tester);
      canvasPaints.add(PocketCanvasPainter.paintInvocationCount);
      paintedOps.add(PocketCanvasPainter.drawOpInvocationCount);
      images.add(await _capture(tester, boundaryKey));
      PocketCanvasPainter.resetPaintInvocationCount();
    }
    return _TransformAblationRun(
      images: images,
      canvasPaints: canvasPaints,
      paintedOps: paintedOps,
    );
  } finally {
    await _unmount(tester);
    runtime.dispose();
  }
}

Future<_TransformAblationRun> _runFlutterTransformVariant(
  WidgetTester tester,
) async {
  final runtime = FfiPocketRuntime.open(
    width: _viewport.width,
    height: _viewport.height,
  );
  final offset = ValueNotifier<double>(0);
  final boundaryKey = GlobalKey();
  try {
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: _viewport.width,
            height: _viewport.height,
            child: RepaintBoundary(
              key: boundaryKey,
              child: ColoredBox(
                color: _hostColor,
                child: ValueListenableBuilder<double>(
                  valueListenable: offset,
                  child: SizedBox(
                    width: _viewport.width,
                    height: _viewport.height,
                    child: PocketView(
                      runtime: runtime,
                      jsSource: _staticGuestSource,
                      inputEnabled: false,
                      enableDuplexPointerInput: false,
                      showDebugFps: false,
                    ),
                  ),
                  builder: (context, value, child) => ClipRect(
                    child: Transform.translate(
                      offset: Offset(value, 0),
                      child: child,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    _assert128Ops(tester);
    final images = <Uint8List>[await _capture(tester, boundaryKey)];
    final canvasPaints = <int>[];
    final paintedOps = <int>[];
    PocketCanvasPainter.resetPaintInvocationCount();
    for (final value in _offsets.skip(1)) {
      offset.value = value.toDouble();
      await tester.pump();
      canvasPaints.add(PocketCanvasPainter.paintInvocationCount);
      paintedOps.add(PocketCanvasPainter.drawOpInvocationCount);
      images.add(await _capture(tester, boundaryKey));
      PocketCanvasPainter.resetPaintInvocationCount();
    }
    return _TransformAblationRun(
      images: images,
      canvasPaints: canvasPaints,
      paintedOps: paintedOps,
    );
  } finally {
    await _unmount(tester);
    offset.dispose();
    runtime.dispose();
  }
}

Future<void> _pumpHost(
  WidgetTester tester, {
  required GlobalKey boundaryKey,
  required FfiPocketRuntime runtime,
  required PocketViewController controller,
  required String jsSource,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: _viewport.width,
          height: _viewport.height,
          child: RepaintBoundary(
            key: boundaryKey,
            child: ColoredBox(
              color: _hostColor,
              child: ClipRect(
                child: SizedBox(
                  width: _viewport.width,
                  height: _viewport.height,
                  child: PocketView(
                    runtime: runtime,
                    controller: controller,
                    jsSource: jsSource,
                    inputEnabled: false,
                    enableDuplexPointerInput: false,
                    showDebugFps: false,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

Future<void> _pumpGuestFrame(WidgetTester tester) async {
  PocketCanvasPainter.resetPaintInvocationCount();
  await tester.pump(const Duration(milliseconds: 16));
  await tester.pump();
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

void _assert128Ops(WidgetTester tester) {
  final painters = _canvasPainters(tester);
  expect(painters, isNotEmpty);
  expect(
    painters.fold<int>(0, (count, painter) => count + painter.ops.length),
    128,
  );
}

List<PocketCanvasPainter> _canvasPainters(WidgetTester tester) {
  return tester
      .widgetList<CustomPaint>(find.byType(CustomPaint))
      .map((widget) => widget.painter)
      .whereType<PocketCanvasPainter>()
      .toList(growable: false);
}

Future<Uint8List> _capture(WidgetTester tester, GlobalKey key) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(key));
  final image = (await tester.runAsync<ui.Image>(
    () => boundary.toImage(pixelRatio: 1),
  ))!;
  try {
    expect(image.width, _viewport.width.toInt());
    expect(image.height, _viewport.height.toInt());
    final bytes = (await tester.runAsync<ByteData?>(
      () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
    ))!;
    return Uint8List.fromList(
      bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
    );
  } finally {
    image.dispose();
  }
}
