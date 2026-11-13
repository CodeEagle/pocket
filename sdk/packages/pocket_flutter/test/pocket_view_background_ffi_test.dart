import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _surfaceSize = Size(64, 64);
const _hostColor = Color(0xff5a1020);
const _initialBackground = Color(0xff102030);
const _updatedBackground = Color(0xff203040);
const _staticColor = Color(0xffff0000);
const _movingColor = Color(0xff00ff00);
const _deletedColor = Color(0xffffff00);

/// The fixture deliberately keeps the canvas sparse. There are 40 DrawOps,
/// with the moving op at index 34 and a deleted op at index 35, so the
/// retained renderer must cross the 32-op block boundary when the guest input
/// changes the frame.
const _movingGuestSource = r'''
const nodes = [];
for (let i = 0; i < 40; i++) {
  const node = ui.createNode(0);
  ui.setProp(node, 1, 6);
  ui.setProp(node, 2, 6);
  ui.setProp(node, 24, 1);
  let x = 2 + (i % 10) * 6;
  let y = 40 + Math.floor(i / 10) * 6;
  let color = 0xff204060 + i;
  if (i === 0) {
    x = 4;
    y = 4;
    color = 0xff0000ff;
  } else if (i === 34) {
    x = 20;
    y = 4;
    color = 0xff00ff00;
  } else if (i === 35) {
    x = 30;
    y = 4;
    color = 0xff00ffff;
  }
  ui.setProp(node, 25, y);
  ui.setProp(node, 28, x);
  ui.setProp(node, 64, color);
  ui.insertBefore(1, node, 0);
  nodes.push(node);
}
let deleted = false;
globalThis.frame = function() {};
globalThis.__pocketEvent = function(event) {
  if (event.name === 'input.pointer' && event.payload.phase === 'move') {
    ui.setProp(nodes[34], 28, 40);
  } else if (event.name === 'input.pointer' && event.payload.phase === 'up' && !deleted) {
    deleted = true;
    ui.destroyNode(nodes[35]);
  } else if (event.name === 'background.move') {
    ui.setProp(nodes[34], 28, event.payload.x);
  }
};
__pocketEvent.__binaryCapable = true;
JSON.parse = JSON.stringify = () => { throw Error('JSON reached render transport'); };
''';

/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  requireReal(nativeLibrary == null ? 'POCKET_NATIVE_LIBRARY is not set' : null);

  testWidgets(
    'real JS move/delete across retained canvas blocks clears old pixels',
    (tester) async {
      expect(
        nativeLibrary,
        isNotNull,
        reason: 'the real FFI regression requires POCKET_NATIVE_LIBRARY',
      );
      expect(
        File(nativeLibrary!).existsSync(),
        isTrue,
        reason: 'native library does not exist: $nativeLibrary',
      );

      final runtime = FfiPocketRuntime.open(
        width: _surfaceSize.width,
        height: _surfaceSize.height,
      );
      final controller = PocketViewController();
      final boundaryKey = GlobalKey();
      try {
        await _pumpHost(
          tester,
          boundaryKey: boundaryKey,
          runtime: runtime,
          controller: controller,
          backgroundColor: null,
        );

        final initialPainters = _canvasPainters(tester);
        expect(initialPainters.length, greaterThanOrEqualTo(2));
        expect(
          initialPainters.fold<int>(
            0,
            (count, painter) => count + painter.ops.length,
          ),
          40,
          reason: 'the real QuickJS frame must span more than one 32-op block',
        );
        expect(
          _blockIndexForColor(initialPainters, _movingColor),
          greaterThan(0),
          reason:
              'the moving guest op must live in a retained block after block 0',
        );

        // With no SDK backing color, an uncovered point still shows the host
        // color. This is the intentional transparent/embedded-surface mode.
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(2, 2)),
          _hostColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(22, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(32, 6)),
          _deletedColor,
        );

        final gesture = await tester.startGesture(const Offset(22, 6));
        await tester.pump(const Duration(milliseconds: 16));
        await gesture.moveTo(const Offset(42, 6));
        await _pumpGuestFrame(tester);
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(22, 6)),
          _hostColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(42, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );

        await gesture.up();
        await _pumpGuestFrame(tester);
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(32, 6)),
          _hostColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(42, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );
        expect(
          _canvasPainters(
            tester,
          ).fold<int>(0, (count, painter) => count + painter.ops.length),
          39,
          reason: 'the real JS destroyNode must remove one DrawOp',
        );

        // Add one opaque SDK backing layer. It must cover only uncovered
        // pixels; painting this color inside every retained block would erase
        // the static foreground from block 0 when block 1 is composited.
        await _pumpHost(
          tester,
          boundaryKey: boundaryKey,
          runtime: runtime,
          controller: controller,
          backgroundColor: _initialBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(2, 2)),
          _initialBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(42, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(32, 6)),
          _initialBackground,
        );

        expect(
          controller.send(
            method: 'background.move',
            params: const <String, dynamic>{'x': 48},
          ),
          isTrue,
        );
        await _pumpGuestFrame(tester);
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(42, 6)),
          _initialBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(50, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );

        // Changing the one outer backing layer is a widget update, not a
        // second per-block background state machine. Foreground pixels and
        // the cleared old location must both follow the new color.
        await _pumpHost(
          tester,
          boundaryKey: boundaryKey,
          runtime: runtime,
          controller: controller,
          backgroundColor: _updatedBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(2, 2)),
          _updatedBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(42, 6)),
          _updatedBackground,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(50, 6)),
          _movingColor,
        );
        expect(
          await _pixelAt(tester, boundaryKey, const Offset(6, 6)),
          _staticColor,
        );
      } finally {
        runtime.dispose();
      }
    },
    skip: nativeLibrary == null,
  );
}

Future<void> _pumpHost(
  WidgetTester tester, {
  required GlobalKey boundaryKey,
  required FfiPocketRuntime runtime,
  required PocketViewController controller,
  required Color? backgroundColor,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: _surfaceSize.width,
          height: _surfaceSize.height,
          child: RepaintBoundary(
            key: boundaryKey,
            child: ColoredBox(
              color: _hostColor,
              child: PocketView(
                runtime: runtime,
                controller: controller,
                jsSource: _movingGuestSource,
                backgroundColor: backgroundColor,
                enableDuplexPointerInput: false,
                showDebugFps: false,
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
  await tester.pump(const Duration(milliseconds: 16));
  await tester.pump();
}

List<PocketCanvasPainter> _canvasPainters(WidgetTester tester) {
  return tester
      .widgetList<CustomPaint>(find.byType(CustomPaint))
      .map((paint) => paint.painter)
      .whereType<PocketCanvasPainter>()
      .toList(growable: false);
}

int _blockIndexForColor(List<PocketCanvasPainter> painters, Color color) {
  final value = color.toARGB32();
  for (var block = 0; block < painters.length; block++) {
    if (painters[block].ops.any(
      (op) => op is PocketRectOp && op.color == value,
    )) {
      return block;
    }
  }
  return -1;
}

Future<Color> _pixelAt(
  WidgetTester tester,
  GlobalKey boundaryKey,
  Offset point,
) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(boundaryKey),
  );
  final image = (await tester.runAsync<ui.Image>(
    () => boundary.toImage(pixelRatio: 1),
  ))!;
  try {
    final data = (await tester.runAsync<ByteData?>(
      () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
    ))!;
    final x = point.dx.round();
    final y = point.dy.round();
    final offset = (y * image.width + x) * 4;
    return Color.fromARGB(
      data.getUint8(offset + 3),
      data.getUint8(offset),
      data.getUint8(offset + 1),
      data.getUint8(offset + 2),
    );
  } finally {
    image.dispose();
  }
}
