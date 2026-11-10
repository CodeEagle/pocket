import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('raster density is integral and bounded', () {
    expect(pocketRasterDensity(1.0), 1);
    expect(pocketRasterDensity(2.01), 3);
    expect(pocketRasterDensity(double.nan), 1);
    expect(pocketRasterDensity(99), 4);
  });

  test('text layout cache reuses identical guest text styles', () {
    final cache = PocketTextLayoutCache(capacity: 2);
    final first = cache.obtain(
      text: 'hello',
      style: const TextStyle(fontSize: 16),
    );
    final second = cache.obtain(
      text: 'hello',
      style: const TextStyle(fontSize: 16),
    );
    expect(identical(first, second), isTrue);
    expect(cache.layoutCount, 1);
    expect(cache.hitCount, 1);
    cache.dispose();
  });

  test('canvas painter draws the retained operation types', () {
    final painter = PocketCanvasPainter(
      width: 100,
      height: 100,
      ops: const <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 100, height: 100, color: 0xff102030),
        PocketRoundedOp(
          x: 8,
          y: 8,
          width: 40,
          height: 24,
          color: 0xff405060,
          radius: 4,
        ),
        PocketGradientOp(
          x: 12,
          y: 40,
          width: 60,
          height: 20,
          fromColor: 0xff000000,
          toColor: 0xffffffff,
          direction: 3,
        ),
        PocketRoundedGradientOp(
          x: 60,
          y: 8,
          width: 30,
          height: 20,
          radius: 5,
          fromColor: 0xff000000,
          viaColor: 0xff808080,
          viaPosition: 0.35,
          toColor: 0xffffffff,
          direction: 2,
        ),
        PocketTextOp(
          x: 4,
          y: 68,
          width: 80,
          height: 20,
          text: 'guest',
          size: 14,
          color: 0xffffffff,
        ),
      ],
      images: const <String, ui.Image>{},
    );
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    painter.paint(canvas, const ui.Size(100, 100));
    recorder.endRecording().dispose();
  });

  test(
    'rounded gradient hit testing and repaint equality include all stops',
    () {
      PocketCanvasPainter painter({double viaPosition = 0.35}) =>
          PocketCanvasPainter(
            width: 40,
            height: 30,
            ops: <PocketOp>[
              PocketRoundedGradientOp(
                x: 4,
                y: 4,
                width: 32,
                height: 22,
                radius: 8,
                fromColor: 0xff000000,
                viaColor: 0xff808080,
                viaPosition: viaPosition,
                toColor: 0xffffffff,
                direction: 3,
              ),
            ],
            images: const <String, ui.Image>{},
          );

      final first = painter();
      expect(first.hitTest(const ui.Offset(5, 5)), isFalse);
      expect(first.hitTest(const ui.Offset(20, 15)), isTrue);
      expect(first.shouldRepaint(painter(viaPosition: 0.4)), isTrue);
    },
  );

  test(
    'rounded ring preserves a transparent hit-test center and invalidates',
    () {
      PocketCanvasPainter painter(double borderWidth) => PocketCanvasPainter(
        width: 20,
        height: 20,
        ops: <PocketOp>[
          PocketRoundedOp(
            x: 2,
            y: 2,
            width: 16,
            height: 16,
            color: 0xff405060,
            radius: 4,
            borderWidth: borderWidth,
          ),
        ],
        images: const <String, ui.Image>{},
      );

      final thick = painter(4);
      expect(thick.hitTest(const ui.Offset(10, 10)), isFalse);
      expect(thick.hitTest(const ui.Offset(3, 10)), isTrue);
      expect(thick.shouldRepaint(painter(3)), isTrue);
    },
  );

  test(
    'arc hit testing follows signed sweeps and preserves the ring center',
    () {
      PocketCanvasPainter painter(double sweep) => PocketCanvasPainter(
        width: 20,
        height: 20,
        ops: <PocketOp>[
          PocketArcOp(
            x: 3,
            y: 3,
            width: 14,
            height: 14,
            color: 0xff405060,
            radius: 6,
            strokeWidth: 2,
            startAngle: 0,
            sweepAngle: sweep,
          ),
        ],
        images: const <String, ui.Image>{},
      );

      final clockwise = painter(90);
      expect(clockwise.hitTest(const ui.Offset(10, 4)), isTrue);
      expect(clockwise.hitTest(const ui.Offset(16, 10)), isTrue);
      expect(clockwise.hitTest(const ui.Offset(10, 16)), isFalse);
      expect(clockwise.hitTest(const ui.Offset(10, 10)), isFalse);
      final counterclockwise = painter(-90);
      expect(counterclockwise.hitTest(const ui.Offset(4, 10)), isTrue);
      expect(counterclockwise.hitTest(const ui.Offset(16, 10)), isFalse);
      expect(clockwise.shouldRepaint(counterclockwise), isTrue);
    },
  );
}
