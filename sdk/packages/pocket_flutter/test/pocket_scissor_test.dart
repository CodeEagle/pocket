import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('fractional scissor edges are hard and do not bleed', (
    tester,
  ) async {
    final raster = await _rasterize(
      tester,
      width: 12,
      height: 12,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 12, height: 12, color: 0xff102030),
        PocketRectOp(
          x: 0,
          y: 0,
          width: 12,
          height: 12,
          color: 0xffe04050,
          // The clip intentionally starts and ends between device pixels.
          // A hard scissor must still produce whole pixels at x=2 and x=9,
          // with no coverage blended into the adjacent background pixels.
          clip: PocketClip(x: 2.25, y: 2.25, width: 7.5, height: 7.5),
        ),
      ],
    );
    expect(raster.pixel(1, 5), <int>[16, 32, 48, 255]);
    expect(raster.pixel(2, 5), <int>[224, 64, 80, 255]);
    expect(raster.pixel(9, 5), <int>[224, 64, 80, 255]);
    expect(raster.pixel(10, 5), <int>[16, 32, 48, 255]);
    expect(raster.pixel(5, 1), <int>[16, 32, 48, 255]);
    expect(raster.pixel(5, 2), <int>[224, 64, 80, 255]);
    expect(raster.pixel(5, 9), <int>[224, 64, 80, 255]);
    expect(raster.pixel(5, 10), <int>[16, 32, 48, 255]);
  });

  testWidgets(
    'intersected per-op clips stay isolated and restore canvas state',
    (tester) async {
      final raster = await _rasterize(
        tester,
        width: 12,
        height: 12,
        ops: const <PocketOp>[
          PocketRectOp(x: 0, y: 0, width: 12, height: 12, color: 0xff101820),
          PocketRectOp(
            x: 2,
            y: 2,
            width: 8,
            height: 8,
            color: 0xffd06020,
            clip: PocketClip(x: 1.25, y: 1.25, width: 9.5, height: 9.5),
          ),
          PocketRectOp(
            x: 0,
            y: 0,
            width: 12,
            height: 12,
            color: 0xff30b060,
            clip: PocketClip(x: 4.25, y: 4.25, width: 3.5, height: 3.5),
          ),
          // The painter does not calculate a nested intersection itself. It
          // saves/restores each op's scissor, so an unclipped later op must not
          // inherit either of the preceding clipped states.
          PocketRectOp(x: 10, y: 0, width: 2, height: 12, color: 0xffd0c020),
        ],
      );

      expect(raster.pixel(1, 1), <int>[16, 24, 32, 255]);
      expect(raster.pixel(2, 2), <int>[208, 96, 32, 255]);
      expect(raster.pixel(3, 3), <int>[208, 96, 32, 255]);
      expect(raster.pixel(4, 4), <int>[48, 176, 96, 255]);
      expect(raster.pixel(7, 7), <int>[48, 176, 96, 255]);
      expect(raster.pixel(8, 8), <int>[208, 96, 32, 255]);
      expect(raster.pixel(9, 9), <int>[208, 96, 32, 255]);
      expect(raster.pixel(10, 10), <int>[208, 192, 32, 255]);
      expect(raster.pixel(11, 5), <int>[208, 192, 32, 255]);
    },
  );

  testWidgets('rounded and image primitives retain their own antialiasing', (
    tester,
  ) async {
    final rounded = await _rasterize(
      tester,
      width: 10,
      height: 10,
      ops: const <PocketOp>[
        PocketRoundedOp(
          x: 1.25,
          y: 1.25,
          width: 6.5,
          height: 6.5,
          color: 0xffe04050,
          radius: 2.5,
          clip: PocketClip(x: 0.25, y: 0.25, width: 9.5, height: 9.5),
        ),
      ],
    );
    final source = await _splitImage(tester);
    try {
      final image = await _rasterize(
        tester,
        width: 10,
        height: 10,
        images: <String, ui.Image>{'solid': source},
        ops: const <PocketOp>[
          PocketImageOp(
            x: 1.25,
            y: 1.25,
            width: 6.5,
            height: 3.5,
            asset: 'solid',
            clip: PocketClip(x: 0.25, y: 0.25, width: 8.5, height: 8.5),
          ),
        ],
      );
      expect(rounded.pixel(4, 4), <int>[224, 64, 80, 255]);
      final roundedEdge = rounded.pixel(3, 1);
      expect(roundedEdge[3], greaterThan(0));
      expect(roundedEdge[3], lessThan(255));

      expect(image.pixel(2, 2)[0], greaterThan(0));
      expect(image.pixel(2, 2)[2], lessThan(255));
      final imageBlend = image.pixel(4, 2);
      expect(imageBlend[0], greaterThan(0));
      expect(imageBlend[2], greaterThan(0));
      expect(imageBlend[3], 255);
    } finally {
      source.dispose();
    }
  });

  testWidgets('rounded rings honor clips and fill when their hole collapses', (
    tester,
  ) async {
    final ring = await _rasterize(
      tester,
      width: 12,
      height: 12,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 12, height: 12, color: 0xff102030),
        PocketRoundedOp(
          x: 2,
          y: 2,
          width: 8,
          height: 8,
          color: 0xffe04050,
          radius: 3,
          borderWidth: 2,
          clip: PocketClip(x: 3, y: 3, width: 6, height: 6),
        ),
      ],
    );
    expect(ring.pixel(5, 5), <int>[16, 32, 48, 255]);
    expect(ring.pixel(3, 5), <int>[224, 64, 80, 255]);
    expect(ring.pixel(2, 5), <int>[16, 32, 48, 255]);

    final fractionalRing = await _rasterize(
      tester,
      width: 12,
      height: 12,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 12, height: 12, color: 0xff102030),
        PocketRoundedOp(
          x: 1.25,
          y: 1.25,
          width: 8.5,
          height: 8.5,
          color: 0xffe04050,
          radius: 4.5,
          borderWidth: 2.5,
        ),
      ],
    );
    final curvedEdge = fractionalRing.pixel(4, 1);
    expect(curvedEdge[0], greaterThan(16));
    expect(curvedEdge[0], lessThan(224));
    expect(curvedEdge[1], greaterThan(32));
    expect(curvedEdge[1], lessThan(64));

    final collapsed = await _rasterize(
      tester,
      width: 10,
      height: 10,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 10, height: 10, color: 0xff102030),
        PocketRoundedOp(
          x: 1,
          y: 3,
          width: 8,
          height: 4,
          color: 0xffe04050,
          radius: 2,
          borderWidth: 10,
        ),
      ],
    );
    expect(collapsed.pixel(4, 4), <int>[224, 64, 80, 255]);
  });

  testWidgets(
    'native arcs retain clockwise sweep, round caps, AA and hard clips',
    (tester) async {
      const background = 0xff102030;
      const foreground = 0xffe04050;
      const arc = PocketArcOp(
        x: 3.25,
        y: 3.5,
        width: 14,
        height: 14,
        color: foreground,
        radius: 6,
        strokeWidth: 2,
        startAngle: 0,
        sweepAngle: 90,
      );
      final raster = await _rasterize(
        tester,
        width: 20,
        height: 20,
        ops: const <PocketOp>[
          PocketRectOp(x: 0, y: 0, width: 20, height: 20, color: background),
          arc,
        ],
      );

      // 0° starts at the top and a positive sweep proceeds clockwise to the
      // right. The endpoint pixels include the round caps.
      expect(raster.pixel(10, 4), <int>[224, 64, 80, 255]);
      expect(raster.pixel(15, 10)[0], greaterThan(16));
      expect(raster.pixel(9, 4)[0], greaterThan(16));
      expect(raster.pixel(9, 4)[0], lessThan(224));
      expect(raster.pixel(10, 15), <int>[16, 32, 48, 255]);
      expect(raster.pixel(5, 10), <int>[16, 32, 48, 255]);
      final antialiased = raster.pixel(10, 3);
      expect(antialiased[0], greaterThan(16));
      expect(antialiased[0], lessThan(224));

      final clipped = await _rasterize(
        tester,
        width: 20,
        height: 20,
        ops: const <PocketOp>[
          PocketRectOp(x: 0, y: 0, width: 20, height: 20, color: background),
          PocketArcOp(
            x: 3.25,
            y: 3.5,
            width: 14,
            height: 14,
            color: foreground,
            radius: 6,
            strokeWidth: 2,
            startAngle: 0,
            sweepAngle: 90,
            clip: PocketClip(x: 13.25, y: 0, width: 6.75, height: 20),
          ),
        ],
      );
      expect(clipped.pixel(12, 5), <int>[16, 32, 48, 255]);
      expect(clipped.pixel(13, 5)[0], greaterThan(16));
    },
  );

  testWidgets('full native arc is a closed ring with a transparent center', (
    tester,
  ) async {
    final raster = await _rasterize(
      tester,
      width: 20,
      height: 20,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 20, height: 20, color: 0xff102030),
        PocketArcOp(
          x: 3.25,
          y: 3.5,
          width: 14,
          height: 14,
          color: 0xffe04050,
          radius: 6,
          strokeWidth: 2,
          startAngle: 15,
          sweepAngle: -360,
        ),
      ],
    );
    expect(raster.pixel(10, 10), <int>[16, 32, 48, 255]);
    expect(raster.pixel(16, 10), <int>[224, 64, 80, 255]);
  });

  testWidgets(
    'rounded gradient keeps full bounds and alpha interpolation under clip',
    (tester) async {
      const gradient = PocketRoundedGradientOp(
        x: 0,
        y: 0,
        width: 80,
        height: 40,
        radius: 8,
        fromColor: 0x00000000,
        viaColor: 0x80808080,
        viaPosition: 0.25,
        toColor: 0xffffffff,
        direction: 3,
        clip: PocketClip(x: 0.25, y: 0.25, width: 39.5, height: 39.5),
      );
      final raster = await _rasterize(
        tester,
        width: 80,
        height: 40,
        ops: const <PocketOp>[
          PocketRectOp(x: 0, y: 0, width: 80, height: 40, color: 0xff204060),
          gradient,
        ],
      );
      // At x=10 the full 80px gradient is just over halfway to its first
      // middle stop. Straight RGBA interpolation over this colored backdrop
      // yields about [41, 65, 88]; rebasing to the 39.5px clip yields roughly
      // [82, 98, 114] instead.
      final towardMiddle = raster.pixel(10, 20);
      expect(towardMiddle[0], inInclusiveRange(38, 44));
      expect(towardMiddle[1], inInclusiveRange(62, 68));
      expect(towardMiddle[2], inInclusiveRange(85, 91));
      expect(raster.pixel(40, 20), <int>[32, 64, 96, 255]);
      expect(raster.pixel(1, 1), <int>[32, 64, 96, 255]);
    },
  );
}

Future<_Raster> _rasterize(
  WidgetTester tester, {
  required double width,
  required double height,
  required List<PocketOp> ops,
  Map<String, ui.Image> images = const <String, ui.Image>{},
}) async {
  final boundaryKey = GlobalKey();
  await tester.pumpWidget(
    Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: width,
        height: height,
        child: RepaintBoundary(
          key: boundaryKey,
          child: CustomPaint(
            size: Size(width, height),
            painter: PocketCanvasPainter(
              width: width,
              height: height,
              ops: ops,
              images: images,
              devicePixelRatio: 1,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(boundaryKey),
  );
  final screenshot = (await tester.runAsync<ui.Image>(
    () => boundary.toImage(pixelRatio: 1),
  ))!;
  try {
    final bytes = (await tester.runAsync<ByteData?>(
      () => screenshot.toByteData(format: ui.ImageByteFormat.rawRgba),
    ))!;
    return _Raster(
      screenshot.width,
      screenshot.height,
      List<int>.from(bytes.buffer.asUint8List()),
    );
  } finally {
    screenshot.dispose();
    await tester.pumpWidget(const SizedBox.shrink());
  }
}

Future<ui.Image> _splitImage(WidgetTester tester) async {
  return (await tester.runAsync<ui.Image>(() async {
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawRect(
      const ui.Rect.fromLTWH(0, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xffff0000),
    );
    canvas.drawRect(
      const ui.Rect.fromLTWH(1, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xff0000ff),
    );
    final picture = recorder.endRecording();
    final image = await picture.toImage(2, 1);
    picture.dispose();
    return image;
  }))!;
}

final class _Raster {
  const _Raster(this.width, this.height, this.bytes);

  final int width;
  final int height;
  final List<int> bytes;

  List<int> pixel(int x, int y) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw RangeError('pixel ($x, $y) outside $width x $height');
    }
    final offset = (y * width + x) * 4;
    return bytes.sublist(offset, offset + 4);
  }
}
