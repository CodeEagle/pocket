import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'one snapshot preserves partitions and uses physical sampling density',
    () async {
      final images = <ui.Image>[
        await _solid(64, 0xffff0000),
        await _solid(32, 0xff00ff00),
        await _solid(16, 0xff0000ff),
        await _solid(8, 0xffffff00),
        await _solid(8, 0xffffffff),
      ];
      try {
        final partitions = [
          _painter(
            [_quad('color', 0, 0, 8, 8)],
            images: {'color': images[0]},
            levels: {'color': images.sublist(1, 4)},
          ),
          _painter(
            [_quad('color', 16, 0, 32, 32)],
            images: {'color': images[0]},
            levels: {'color': images.sublist(1, 4)},
          ),
          _painter(
            [_quad('overlay', 0, 0, 2, 8)],
            images: {'overlay': images[4]},
          ),
        ];
        PocketMeshSpanPainter.resetDiagnostics();
        final ordinary = await _raster(
          PocketMeshSpanPainter(partitions: partitions),
          const ui.Size(64, 64),
        );
        expect(_pixel(ordinary, 64, 4, 4), [255, 255, 0, 255]);
        expect(_pixel(ordinary, 64, 24, 8), [0, 255, 0, 255]);
        expect(_pixel(ordinary, 64, 1, 4), [255, 255, 255, 255]);
        expect(PocketMeshSpanPainter.snapshotCount, 0);
        expect(PocketMeshSpanPainter.disposedSnapshotCount, 0);

        final sampled = await _raster(
          PocketMeshSpanPainter(partitions: partitions, sampleScale: 2),
          const ui.Size(64, 64),
        );
        expect(_pixel(sampled, 64, 4, 4), [0, 0, 255, 255]);
        expect(_pixel(sampled, 64, 24, 8), [255, 0, 0, 255]);
        expect(_pixel(sampled, 64, 1, 4), [255, 255, 255, 255]);
        expect(PocketMeshSpanPainter.snapshotCount, 1);
        expect(PocketMeshSpanPainter.disposedSnapshotCount, 1);
        expect(
          PocketMeshSpanPainter.snapshottedPixelCount,
          lessThanOrEqualTo(64 * 64 * 4),
        );
      } finally {
        for (final image in images) {
          image.dispose();
        }
      }
    },
  );

  test('a complete normal mask stays isolated in one sampled span', () async {
    final color = await _solid(8, 0xffff0000);
    final mask = await _solid(8, 0xffffffff);
    try {
      final partition = _painter(
        [
          _layer(0),
          _quad('color', 0, 0, 8, 8),
          const PocketMeshMaskBeginOp(
            x: 0,
            y: 0,
            width: 8,
            height: 8,
            inverted: false,
          ),
          _quad('mask', 0, 0, 4, 8),
          const PocketMeshLayerRestoreOp(x: 0, y: 0, width: 8, height: 8),
        ],
        images: {'color': color, 'mask': mask},
        side: 8,
      );
      PocketMeshSpanPainter.resetDiagnostics();
      final raster = await _raster(
        PocketMeshSpanPainter(partitions: [partition], sampleScale: 2),
        const ui.Size(8, 8),
      );
      expect(_pixel(raster, 8, 1, 4), [255, 0, 0, 255]);
      expect(_pixel(raster, 8, 6, 4)[3], 0);
      expect(PocketMeshSpanPainter.snapshotCount, 1);
      expect(PocketMeshSpanPainter.disposedSnapshotCount, 1);
    } finally {
      color.dispose();
      mask.dispose();
    }
  });

  test(
    'background blends and oversized targets use the existing direct path',
    () async {
      final color = await _solid(8, 0xffff0000);
      try {
        for (final entry in <int, List<int>>{
          1: [255, 0, 255, 255], // plus
          2: [0, 0, 0, 255], // multiply
          3: [255, 0, 255, 255], // screen
        }.entries) {
          final blended = _painter(
            [
              _layer(entry.key),
              _quad('color', 0, 0, 8, 8),
              const PocketMeshLayerRestoreOp(x: 0, y: 0, width: 8, height: 8),
            ],
            images: {'color': color},
            side: 8,
          );
          PocketMeshSpanPainter.resetDiagnostics();
          final raster = await _raster(
            PocketMeshSpanPainter(partitions: [blended], sampleScale: 2),
            const ui.Size(8, 8),
            background: 0xff0000ff,
          );
          expect(
            _pixel(raster, 8, 4, 4),
            entry.value,
            reason: 'blend ${entry.key} must retain the blue destination',
          );
          expect(PocketMeshSpanPainter.snapshotCount, 0);
          expect(PocketMeshSpanPainter.disposedSnapshotCount, 0);
          expect(PocketMeshSpanPainter.ineligibleBypassCount, 1);
        }

        final huge = _painter(
          [_quad('color', 0, 0, 1024, 1024)],
          images: {'color': color},
          side: 1024,
        );
        PocketMeshSpanPainter.resetDiagnostics();
        final clipped = await _raster(
          PocketMeshSpanPainter(partitions: [huge], sampleScale: 2),
          const ui.Size(1024, 1024),
          outputSide: 8,
        );
        expect(_pixel(clipped, 8, 4, 4), [255, 0, 0, 255]);
        expect(PocketMeshSpanPainter.snapshotCount, 0);
        expect(PocketMeshSpanPainter.disposedSnapshotCount, 0);
        expect(PocketMeshSpanPainter.budgetBypassCount, 1);
      } finally {
        color.dispose();
      }
    },
  );
}

PocketCanvasPainter _painter(
  List<PocketOp> ops, {
  required Map<String, ui.Image> images,
  Map<String, List<ui.Image>> levels = const {},
  double side = 64,
}) => PocketCanvasPainter(
  width: side,
  height: side,
  ops: ops,
  images: images,
  meshImageLevels: levels,
  renderedSize: ui.Size(side, side),
  devicePixelRatio: 1,
);

PocketMeshLayerBeginOp _layer(int blend) => PocketMeshLayerBeginOp(
  x: 0,
  y: 0,
  width: 8,
  height: 8,
  blend: blend,
  multiplyRgb: const [1, 1, 1],
  screenRgb: const [0, 0, 0],
);

PocketTextureTriangleOp _quad(
  String asset,
  double x,
  double y,
  double width,
  double height,
) => PocketTextureTriangleOp(
  x: x,
  y: y,
  width: width,
  height: height,
  asset: asset,
  color: 0xffffffff,
  repeatTexture: true,
  points: [
    PocketPoint(x: x, y: y),
    PocketPoint(x: x + width, y: y),
    PocketPoint(x: x, y: y + height),
    PocketPoint(x: x + width, y: y),
    PocketPoint(x: x + width, y: y + height),
    PocketPoint(x: x, y: y + height),
  ],
  uvs: const [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1],
);

Future<ui.Image> _solid(int side, int color) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(ui.Color(color), ui.BlendMode.src);
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(side, side);
  } finally {
    picture.dispose();
  }
}

Future<Uint8List> _raster(
  CustomPainter painter,
  ui.Size size, {
  int? outputSide,
  int? background,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  if (background != null)
    canvas.drawColor(ui.Color(background), ui.BlendMode.src);
  painter.paint(canvas, size);
  final picture = recorder.endRecording();
  final image = await picture.toImage(
    outputSide ?? size.width.toInt(),
    outputSide ?? size.height.toInt(),
  );
  try {
    return Uint8List.fromList(
      (await image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      ))!.buffer.asUint8List(),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

List<int> _pixel(Uint8List bytes, int width, int x, int y) =>
    bytes.sublist((y * width + x) * 4, (y * width + x + 1) * 4);
