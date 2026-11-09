import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'repeated texture triangles sample beyond the image edge periodically',
    () async {
      final stripes = await _twoColorImage(0xffff0000, 0xff00ff00);
      try {
        final repeated = await _render(
          _wideUvQuad('stripes', repeatTexture: true),
          <String, ui.Image>{'stripes': stripes},
        );
        final clamped = await _render(
          _wideUvQuad('stripes'),
          <String, ui.Image>{'stripes': stripes},
        );

        // UVs span two image widths across the four-pixel target. Repeat
        // returns to the first texel in the second period; clamp stays at the
        // last texel after crossing the image edge.
        _expectNear(repeated.pixel(0, 1), repeated.pixel(2, 1));
        _expectNear(repeated.pixel(1, 1), repeated.pixel(3, 1));
        _expectNear(clamped.pixel(2, 1), clamped.pixel(3, 1));
        expect(repeated.pixel(0, 1), isNot(equals(clamped.pixel(2, 1))));
      } finally {
        stripes.dispose();
      }
    },
  );

  test('repeat sampler is retained for hidden mesh mask geometry', () async {
    final target = await _solidImage(0xffff0000);
    final alphaStripes = await _twoColorImage(0xffffffff, 0x00ffffff);
    try {
      PocketCanvasPainter.resetPaintInvocationCount();
      final raster = await _render(
        <PocketOp>[
          _layer(),
          ..._quad('target', 0xffffffff),
          PocketMeshMaskBeginOp(
            x: 0,
            y: 0,
            width: 4,
            height: 4,
            inverted: false,
            clip: _clip,
          ),
          ..._wideUvQuad('mask', repeatTexture: true),
          _restore(),
        ],
        <String, ui.Image>{'target': target, 'mask': alphaStripes},
      );

      expect(raster.pixel(0, 1)[3], greaterThan(240));
      expect(raster.pixel(1, 1)[3], lessThan(16));
      expect(raster.pixel(0, 1)[3], closeTo(raster.pixel(2, 1)[3], 3));
      expect(raster.pixel(1, 1)[3], closeTo(raster.pixel(3, 1)[3], 3));
      // Target triangles clamp while the hidden mask triangles repeat. The
      // two groups must remain separate shader batches.
      expect(PocketCanvasPainter.textureTriangleBatchDrawCount, 2);
    } finally {
      target.dispose();
      alphaStripes.dispose();
    }
  });

  test(
    'downsampled repeated mask keeps alpha coverage and texture seam periodic',
    () async {
      final target = await _solidImage(0xffff0000);
      final source = await _periodicAlphaTile();
      final level = await _downsample(source, 8, 2);
      try {
        final levelData = await level.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        );
        final levelAlpha = [
          for (var y = 0; y < level.height; y++)
            for (var x = 0; x < level.width; x++)
              levelData!.getUint8((y * level.width + x) * 4 + 3),
        ];
        final expectedMaskAlpha = levelAlpha[level.width + 2];
        expect(
          levelAlpha.reduce((a, b) => a < b ? a : b),
          closeTo(expectedMaskAlpha, 2),
          reason: 'The real drawImageRect reduction should preserve tile alpha',
        );
        expect(
          levelAlpha.reduce((a, b) => a > b ? a : b),
          closeTo(expectedMaskAlpha, 2),
          reason: 'Each downsampled pixel covers the same periodic alpha tile',
        );
        expect(
          expectedMaskAlpha,
          lessThan(240),
          reason:
              'The reduced image must contain filtered transparent coverage',
        );

        final ops = <PocketOp>[
          _layer(),
          ..._quad('target', 0xffffffff),
          PocketMeshMaskBeginOp(
            x: 0,
            y: 0,
            width: 4,
            height: 4,
            inverted: false,
            clip: _clip,
          ),
          ..._wideUvQuad('mask', repeatTexture: true),
          _restore(),
        ];
        final unfiltered = await _render(ops, <String, ui.Image>{
          'target': target,
          'mask': source,
        });
        final lod = await _render(
          ops,
          <String, ui.Image>{'target': target, 'mask': source},
          meshImageLevels: <String, List<ui.Image>>{
            'mask': <ui.Image>[level],
          },
        );

        expect(
          unfiltered.pixel(0, 1)[3],
          greaterThan(240),
          reason: 'The original high-frequency mask aliases at this footprint',
        );
        expect(
          lod.pixel(0, 1)[3],
          closeTo(expectedMaskAlpha, 3),
          reason: 'The selected real LOD controls the mask alpha',
        );
        expect(
          lod.pixel(0, 1)[3],
          lessThan(unfiltered.pixel(0, 1)[3] - 30),
          reason: 'The fixture proves that the downsampled LOD was selected',
        );

        // The mask repeats twice across the physical output. The reduced tile
        // must preserve both the repeated period and the join between tiles.
        for (var y = 0; y < 4; y++) {
          expect(lod.pixel(0, y)[3], closeTo(lod.pixel(2, y)[3], 3));
          expect(lod.pixel(1, y)[3], closeTo(lod.pixel(3, y)[3], 3));
          expect(
            lod.pixel(1, y)[3],
            closeTo(lod.pixel(2, y)[3], 3),
            reason: 'No alpha seam appears at the repeated tile boundary',
          );
        }

        final opaqueBackground = await _render(
          ops,
          <String, ui.Image>{'target': target, 'mask': source},
          background: 0xff0000ff,
          meshImageLevels: <String, List<ui.Image>>{
            'mask': <ui.Image>[level],
          },
        );
        final composited = opaqueBackground.pixel(1, 1);
        expect(composited[3], 255);
        _expectNear(composited, <int>[
          expectedMaskAlpha,
          0,
          255 - expectedMaskAlpha,
          255,
        ], tolerance: 4);
        _expectNear(
          opaqueBackground.pixel(1, 1),
          opaqueBackground.pixel(2, 1),
          tolerance: 3,
        );
      } finally {
        target.dispose();
        source.dispose();
        level.dispose();
      }
    },
  );

  test(
    'mesh masks preserve alpha on transparent and opaque backgrounds',
    () async {
      final red = await _solidImage(0xffff0000);
      final white = await _solidImage(0xffffffff);
      try {
        for (final inverted in <bool>[false, true]) {
          for (final background in <int?>[null, 0xff0000ff]) {
            final raster = await _render(
              _maskedOps(inverted: inverted),
              <String, ui.Image>{'target': red, 'mask': white},
              background: background,
            );
            final left = raster.pixel(0, 1);
            final right = raster.pixel(3, 1);
            if (inverted) {
              expect(
                left,
                background == null ? <int>[0, 0, 0, 0] : <int>[0, 0, 255, 255],
              );
              expect(right, <int>[255, 0, 0, 255]);
            } else {
              expect(left, <int>[255, 0, 0, 255]);
              expect(
                right,
                background == null ? <int>[0, 0, 0, 0] : <int>[0, 0, 255, 255],
              );
            }
          }
        }
      } finally {
        red.dispose();
        white.dispose();
      }
    },
  );

  test(
    'isolated mesh layers apply all normalized blends and RGB tints',
    () async {
      PocketCanvasPainter.resetPaintInvocationCount();
      final source = await _solidImage(0xff4080c0);
      final tintedSource = await _solidImage(0xff336699);
      try {
        final expected = <int, List<int>>{
          0: <int>[64, 128, 192],
          1: <int>[192, 192, 224],
          2: <int>[32, 32, 24],
          3: <int>[160, 160, 200],
        };
        for (final blend in expected.keys) {
          final raster = await _render(
            _singleMeshOps(blend: blend),
            <String, ui.Image>{'target': source},
            background: 0xff804020,
          );
          _expectNear(raster.pixel(1, 1), <int>[...expected[blend]!, 255]);
          final transparent = await _render(
            _singleMeshOps(blend: blend),
            <String, ui.Image>{'target': source},
          );
          _expectNear(transparent.pixel(1, 1), <int>[64, 128, 192, 255]);
        }

        PocketCanvasPainter.resetPaintInvocationCount();
        final tinted = await _render(
          _singleMeshOps(
            multiply: const <double>[0.5, 1, 0.8],
            screen: const <double>[0.2, 0, 0.1],
          ),
          <String, ui.Image>{'target': tintedSource},
        );
        _expectNear(tinted.pixel(1, 1), <int>[46, 102, 131, 255]);

        // The two target triangles and two mask triangles form two compatible
        // runs. Each run allocates one Vertices and one ImageShader, regardless
        // of how many triangles it contains.
        PocketCanvasPainter.resetPaintInvocationCount();
        final masked = await _render(
          _maskedOps(inverted: false),
          <String, ui.Image>{'target': source, 'mask': source},
        );
        expect(masked.pixel(0, 1)[3], 255);
        expect(PocketCanvasPainter.textureTriangleBatchDrawCount, 2);
      } finally {
        source.dispose();
        tintedSource.dispose();
      }
    },
  );
}

List<PocketOp> _maskedOps({required bool inverted}) => <PocketOp>[
  _layer(),
  ..._quad('target', 0xffffffff),
  PocketMeshMaskBeginOp(
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    inverted: inverted,
    clip: _clip,
  ),
  ..._halfQuad('mask', 0xffffffff),
  _restore(),
];

List<PocketOp> _singleMeshOps({
  int blend = 0,
  List<double> multiply = const <double>[1, 1, 1],
  List<double> screen = const <double>[0, 0, 0],
}) => <PocketOp>[
  _layer(blend: blend, multiply: multiply, screen: screen),
  ..._quad('target', 0xffffffff),
  _restore(),
];

PocketMeshLayerBeginOp _layer({
  int blend = 0,
  List<double> multiply = const <double>[1, 1, 1],
  List<double> screen = const <double>[0, 0, 0],
}) => PocketMeshLayerBeginOp(
  x: 0,
  y: 0,
  width: 4,
  height: 4,
  blend: blend,
  multiplyRgb: multiply,
  screenRgb: screen,
  clip: _clip,
);

const _clip = PocketClip(x: 0, y: 0, width: 4, height: 4);

PocketMeshLayerRestoreOp _restore() => const PocketMeshLayerRestoreOp(
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  clip: _clip,
);

List<PocketOp> _quad(String asset, int color) => <PocketOp>[
  _triangle(
    asset,
    color,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 4, y: 0),
      PocketPoint(x: 4, y: 4),
    ],
    const <double>[0, 0, 1, 0, 1, 1],
  ),
  _triangle(
    asset,
    color,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 4, y: 4),
      PocketPoint(x: 0, y: 4),
    ],
    const <double>[0, 0, 1, 1, 0, 1],
  ),
];

List<PocketOp> _wideUvQuad(String asset, {bool repeatTexture = false}) =>
    <PocketOp>[
      _triangle(
        asset,
        0xffffffff,
        const <PocketPoint>[
          PocketPoint(x: 0, y: 0),
          PocketPoint(x: 4, y: 0),
          PocketPoint(x: 4, y: 4),
        ],
        const <double>[0, 0, 2, 0, 2, 1],
        repeatTexture: repeatTexture,
      ),
      _triangle(
        asset,
        0xffffffff,
        const <PocketPoint>[
          PocketPoint(x: 0, y: 0),
          PocketPoint(x: 4, y: 4),
          PocketPoint(x: 0, y: 4),
        ],
        const <double>[0, 0, 2, 1, 0, 1],
        repeatTexture: repeatTexture,
      ),
    ];

List<PocketOp> _halfQuad(String asset, int color) => <PocketOp>[
  _triangle(
    asset,
    color,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 2, y: 0),
      PocketPoint(x: 2, y: 4),
    ],
    const <double>[0, 0, 1, 0, 1, 1],
  ),
  _triangle(
    asset,
    color,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 2, y: 4),
      PocketPoint(x: 0, y: 4),
    ],
    const <double>[0, 0, 1, 1, 0, 1],
  ),
];

PocketTextureTriangleOp _triangle(
  String asset,
  int color,
  List<PocketPoint> points,
  List<double> uvs, {
  bool repeatTexture = false,
}) => PocketTextureTriangleOp(
  x: 0,
  y: 0,
  width: 4,
  height: 4,
  asset: asset,
  color: color,
  points: points,
  uvs: uvs,
  repeatTexture: repeatTexture,
  clip: _clip,
);

Future<_Raster> _render(
  List<PocketOp> ops,
  Map<String, ui.Image> images, {
  int? background,
  Map<String, List<ui.Image>> meshImageLevels =
      const <String, List<ui.Image>>{},
}) async {
  final painter = PocketCanvasPainter(
    width: 4,
    height: 4,
    ops: ops,
    images: images,
    meshImageLevels: meshImageLevels,
  );
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  if (background != null) {
    canvas.drawColor(ui.Color(background), ui.BlendMode.src);
  }
  painter.paint(canvas, const ui.Size(4, 4));
  final picture = recorder.endRecording();
  final image = await picture.toImage(4, 4);
  picture.dispose();
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  image.dispose();
  return _Raster(Uint8List.fromList(data!.buffer.asUint8List()));
}

Future<ui.Image> _solidImage(int argb) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawColor(ui.Color(argb), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(1, 1);
  picture.dispose();
  return image;
}

Future<ui.Image> _twoColorImage(int left, int right) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas
    ..drawRect(
      const ui.Rect.fromLTWH(0, 0, 1, 1),
      ui.Paint()..color = ui.Color(left),
    )
    ..drawRect(
      const ui.Rect.fromLTWH(1, 0, 1, 1),
      ui.Paint()..color = ui.Color(right),
    );
  final picture = recorder.endRecording();
  final image = await picture.toImage(2, 1);
  picture.dispose();
  return image;
}

Future<ui.Image> _periodicAlphaTile() async {
  const width = 64;
  const height = 16;
  const alphaCycle = <int>[255, 128, 0, 0, 0, 0, 128, 255];
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  for (var x = 0; x < width; x++) {
    canvas.drawRect(
      ui.Rect.fromLTWH(x.toDouble(), 0, 1, height.toDouble()),
      ui.Paint()
        ..color = ui.Color.fromARGB(
          alphaCycle[x % alphaCycle.length],
          255,
          255,
          255,
        ),
    );
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  return image;
}

Future<ui.Image> _downsample(ui.Image source, int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawImageRect(
    source,
    ui.Rect.fromLTWH(0, 0, source.width.toDouble(), source.height.toDouble()),
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..filterQuality = ui.FilterQuality.medium,
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  return image;
}

void _expectNear(List<int> actual, List<int> expected, {int tolerance = 2}) {
  expect(actual, hasLength(expected.length));
  for (var channel = 0; channel < expected.length; channel++) {
    expect(
      actual[channel],
      closeTo(expected[channel], tolerance),
      reason: 'channel $channel differs: $actual vs $expected',
    );
  }
}

final class _Raster {
  const _Raster(this.bytes);

  final Uint8List bytes;

  List<int> pixel(int x, int y) {
    final offset = (y * 4 + x) * 4;
    return bytes.sublist(offset, offset + 4);
  }
}
