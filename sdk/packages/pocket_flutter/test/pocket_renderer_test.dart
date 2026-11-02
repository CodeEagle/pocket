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
}
