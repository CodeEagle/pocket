import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'mesh texture sampling bilinearly filters the same fractional UV mesh',
    () async {
      final texture = await _checkerTexture();
      try {
        final ops = _fractionalMesh();
        final filtered = await _renderPocket(ops, texture);
        final nearest = await _renderNearestReference(ops, texture);
        final tiny = await _downsample(texture, 1);
        try {
          final repeatedOps = <PocketOp>[
            for (final op in ops.whereType<PocketTextureTriangleOp>())
              _triangle(op.points, op.uvs, repeatTexture: true),
          ];
          final repeated = await _renderPocket(repeatedOps, texture);
          final zoomed = await _renderPocket(
            repeatedOps,
            texture,
            meshImageLevels: {
              'checker': [tiny],
            },
          );
          expect(
            zoomed.bytes,
            orderedEquals(repeated.bytes),
            reason: 'Magnified meshes must retain their original texture.',
          );
        } finally {
          tiny.dispose();
        }

        var changedPixels = 0;
        var interpolatedPixels = 0;
        for (var y = 1; y < 7; y++) {
          for (var x = 1; x < 7; x++) {
            final filteredPixel = filtered.pixel(x, y);
            final nearestPixel = nearest.pixel(x, y);
            if (!_samePixel(filteredPixel, nearestPixel)) changedPixels++;
            if (filteredPixel[0] == filteredPixel[1] &&
                filteredPixel[1] == filteredPixel[2] &&
                filteredPixel[0] > 0 &&
                filteredPixel[0] < 255) {
              interpolatedPixels++;
            }
          }
        }

        expect(
          changedPixels,
          greaterThan(0),
          reason:
              'The production bilinear sampler must differ from nearest on fractional UVs.',
        );
        expect(
          interpolatedPixels,
          greaterThan(0),
          reason: 'Bilinear samples between the black and white texels.',
        );
        expect(
          nearest.uniqueRgb,
          containsAll(<int>{0x000000, 0xffffff}),
          reason:
              'The nearest reference must sample the original checker texels.',
        );
      } finally {
        texture.dispose();
      }
    },
  );

  test('minified mesh avoids single-texel aliasing', () async {
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    for (var y = 0; y < 64; y++) {
      for (var x = 0; x < 64; x++) {
        canvas.drawRect(
          ui.Rect.fromLTWH(x.toDouble(), y.toDouble(), 1, 1),
          ui.Paint()
            ..color = ui.Color((x + y).isEven ? 0xff000000 : 0xffffffff),
        );
      }
    }
    final picture = recorder.endRecording();
    final texture = await picture.toImage(64, 64);
    picture.dispose();
    try {
      const lo = 0.5 / 64;
      const hi = 1 + lo;
      final ops = <PocketOp>[
        _triangle(
          const [
            PocketPoint(x: 0, y: 0),
            PocketPoint(x: 4, y: 0),
            PocketPoint(x: 4, y: 4),
          ],
          const [lo, lo, hi, lo, hi, hi],
          repeatTexture: true,
        ),
        _triangle(
          const [
            PocketPoint(x: 0, y: 0),
            PocketPoint(x: 4, y: 4),
            PocketPoint(x: 0, y: 4),
          ],
          const [lo, lo, hi, hi, lo, hi],
          repeatTexture: true,
        ),
      ];
      final unfiltered = await _renderPocket(ops, texture);
      final level = await _downsample(texture, 8);
      final finer = await _downsample(texture, 16);
      final _Raster raster;
      try {
        raster = await _renderPocket(
          ops,
          texture,
          meshImageLevels: {
            'checker': [level],
          },
        );
        final clampedOps = <PocketOp>[
          for (final op in ops.whereType<PocketTextureTriangleOp>())
            _triangle(op.points, op.uvs),
        ];
        final clamped = await _renderPocket(clampedOps, texture);
        final clampedWithLevel = await _renderPocket(
          clampedOps,
          texture,
          meshImageLevels: {
            'checker': [level],
          },
        );
        expect(
          clampedWithLevel.bytes,
          orderedEquals(clamped.bytes),
          reason: 'Out-of-range clamped UVs retain original sampling.',
        );
        const insideLo = 0.5 / 64;
        const insideHi = 48.5 / 64;
        final skinOps = <PocketOp>[
          _triangle(
            const [
              PocketPoint(x: 0, y: 0),
              PocketPoint(x: 4, y: 0),
              PocketPoint(x: 4, y: 4),
            ],
            const [insideLo, insideLo, insideHi, insideLo, insideHi, insideHi],
          ),
          _triangle(
            const [
              PocketPoint(x: 0, y: 0),
              PocketPoint(x: 4, y: 4),
              PocketPoint(x: 0, y: 4),
            ],
            const [insideLo, insideLo, insideHi, insideHi, insideLo, insideHi],
          ),
        ];
        final skin = await _renderPocket(skinOps, texture);
        final skinWithLevels = await _renderPocket(
          skinOps,
          texture,
          meshImageLevels: {
            'checker': [finer, level],
          },
        );
        expect(skin.pixel(3, 3), [0, 0, 0, 255]);
        expect(
          skinWithLevels.bytes,
          orderedEquals(skin.bytes),
          reason:
              'Clamped UI sharing a model atlas keeps its original sampling, including in-range UVs.',
        );
      } finally {
        level.dispose();
        finer.dispose();
      }
      expect(
        unfiltered.pixel(3, 3),
        [0, 0, 0, 255],
        reason: 'The original mesh sampler aliases this 8:1 minification.',
      );
      final interior = <int>[
        for (var y = 1; y < 7; y++)
          for (var x = 1; x < 7; x++) raster.pixel(x, y)[0],
      ];
      final error =
          interior.fold<int>(0, (sum, value) => sum + (value - 128).abs()) /
          interior.length;
      // The 8:1 reduction must integrate both colors rather than repeatedly
      // selecting the same texel. A black/white checker averages to mid-gray.
      expect(
        error,
        lessThan(12),
        reason: 'minification mean absolute gray error=$error',
      );
    } finally {
      texture.dispose();
    }
  });
}

List<PocketOp> _fractionalMesh() => <PocketOp>[
  _triangle(
    const <PocketPoint>[
      PocketPoint(x: 0.25, y: 0.25),
      PocketPoint(x: 3.75, y: 0.25),
      PocketPoint(x: 3.75, y: 3.75),
    ],
    const <double>[0.125, 0.125, 0.875, 0.125, 0.875, 0.875],
  ),
  _triangle(
    const <PocketPoint>[
      PocketPoint(x: 0.25, y: 0.25),
      PocketPoint(x: 3.75, y: 3.75),
      PocketPoint(x: 0.25, y: 3.75),
    ],
    const <double>[0.125, 0.125, 0.875, 0.875, 0.125, 0.875],
  ),
];

PocketTextureTriangleOp _triangle(
  List<PocketPoint> points,
  List<double> uvs, {
  bool repeatTexture = false,
}) => PocketTextureTriangleOp(
  x: 0,
  y: 0,
  width: 4,
  height: 4,
  asset: 'checker',
  color: 0xffffffff,
  points: points,
  uvs: uvs,
  repeatTexture: repeatTexture,
);

Future<_Raster> _renderPocket(
  List<PocketOp> ops,
  ui.Image texture, {
  Map<String, List<ui.Image>> meshImageLevels = const {},
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  PocketCanvasPainter(
    width: 4,
    height: 4,
    ops: ops,
    images: <String, ui.Image>{'checker': texture},
    meshImageLevels: meshImageLevels,
  ).paint(canvas, const ui.Size(8, 8));
  return _finishPicture(recorder);
}

Future<_Raster> _renderNearestReference(
  List<PocketOp> ops,
  ui.Image texture,
) async {
  final positions = <ui.Offset>[];
  final textureCoordinates = <ui.Offset>[];
  final colors = <ui.Color>[];
  for (final op in ops.whereType<PocketTextureTriangleOp>()) {
    for (var index = 0; index < op.points.length; index++) {
      positions.add(ui.Offset(op.points[index].x, op.points[index].y));
      textureCoordinates.add(
        ui.Offset(
          op.uvs[index * 2] * texture.width,
          op.uvs[index * 2 + 1] * texture.height,
        ),
      );
      colors.add(ui.Color(op.color));
    }
  }
  final vertices = ui.Vertices(
    ui.VertexMode.triangles,
    positions,
    colors: colors,
    textureCoordinates: textureCoordinates,
  );
  final shader = ui.ImageShader(
    texture,
    ui.TileMode.clamp,
    ui.TileMode.clamp,
    Float64List.fromList(<double>[
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    ]),
  );
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder)..scale(2, 2);
  try {
    canvas.drawVertices(
      vertices,
      ui.BlendMode.modulate,
      ui.Paint()..shader = shader,
    );
  } finally {
    shader.dispose();
  }
  return _finishPicture(recorder);
}

Future<_Raster> _finishPicture(ui.PictureRecorder recorder) async {
  final picture = recorder.endRecording();
  final image = await picture.toImage(8, 8);
  picture.dispose();
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  image.dispose();
  return _Raster(Uint8List.fromList(data!.buffer.asUint8List()));
}

Future<ui.Image> _checkerTexture() async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas
    ..drawRect(
      const ui.Rect.fromLTWH(0, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xff000000),
    )
    ..drawRect(
      const ui.Rect.fromLTWH(1, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xffffffff),
    )
    ..drawRect(
      const ui.Rect.fromLTWH(0, 1, 1, 1),
      ui.Paint()..color = const ui.Color(0xffffffff),
    )
    ..drawRect(
      const ui.Rect.fromLTWH(1, 1, 1, 1),
      ui.Paint()..color = const ui.Color(0xff000000),
    );
  final picture = recorder.endRecording();
  final image = await picture.toImage(2, 2);
  picture.dispose();
  return image;
}

bool _samePixel(List<int> first, List<int> second) {
  for (var channel = 0; channel < first.length; channel++) {
    if (first[channel] != second[channel]) return false;
  }
  return true;
}

final class _Raster {
  const _Raster(this.bytes);

  final Uint8List bytes;

  List<int> pixel(int x, int y) =>
      bytes.sublist((y * 8 + x) * 4, (y * 8 + x) * 4 + 4);

  Set<int> get uniqueRgb => <int>{
    for (var index = 0; index < bytes.length; index += 4)
      (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2],
  };
}

Future<ui.Image> _downsample(ui.Image texture, int size) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawImageRect(
    texture,
    ui.Rect.fromLTWH(0, 0, texture.width.toDouble(), texture.height.toDouble()),
    ui.Rect.fromLTWH(0, 0, size.toDouble(), size.toDouble()),
    ui.Paint()..filterQuality = ui.FilterQuality.medium,
  );
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(size, size);
  } finally {
    picture.dispose();
  }
}
