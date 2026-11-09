import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test(
    'separates textured alpha minification from triangle edge coverage',
    () async {
      final solid = await _solidTexture(4, 4);
      final alphaPattern = await _diagonalAlphaPattern(256, cell: 4, phase: 2);
      final alphaLevel = await _downsample(alphaPattern, 32);
      try {
        final geometryRaster = await _render(
          <PocketOp>[
            PocketTextureTriangleOp(
              x: 0,
              y: 0,
              width: 32,
              height: 32,
              asset: 'solid',
              color: 0xffffffff,
              points: const <PocketPoint>[
                PocketPoint(x: 1.25, y: 1.25),
                PocketPoint(x: 30.75, y: 3.5),
                PocketPoint(x: 4.5, y: 30.75),
              ],
              uvs: const <double>[0, 0, 1, 0, 0, 1],
              repeatTexture: true,
            ),
          ],
          <String, ui.Image>{'solid': solid},
        );
        final geometryEdgeAlpha = _intermediateAlphaPixels(geometryRaster);
        final solidVertices = ui.Vertices(
          ui.VertexMode.triangles,
          const <ui.Offset>[
            ui.Offset(1.25, 1.25),
            ui.Offset(30.75, 3.5),
            ui.Offset(4.5, 30.75),
          ],
          colors: const <ui.Color>[
            ui.Color(0xffffffff),
            ui.Color(0xffffffff),
            ui.Color(0xffffffff),
          ],
        );
        final geometricNoAa = await _renderVertices(
          solidVertices,
          antiAlias: false,
        );
        final geometricAa = await _renderVertices(
          solidVertices,
          antiAlias: true,
        );

        final alphaOps = _fullQuad('alpha');
        final unfilteredAlpha = await _render(alphaOps, <String, ui.Image>{
          'alpha': alphaPattern,
        });
        final filteredAlpha = await _render(
          alphaOps,
          <String, ui.Image>{'alpha': alphaPattern},
          meshImageLevels: <String, List<ui.Image>>{
            'alpha': <ui.Image>[alphaLevel],
          },
        );
        final originalStats = _alphaStats(unfilteredAlpha);
        final lodStats = _alphaStats(filteredAlpha);

        // A constant, fully opaque source isolates polygon coverage from texture
        // alpha. Current drawVertices coverage leaves no partially covered edge
        // samples, even with fractional geometry.
        expect(geometryEdgeAlpha, 0);
        expect(
          geometricAa.bytes,
          orderedEquals(geometricNoAa.bytes),
          reason:
              'drawVertices ignores Paint.isAntiAlias on this Flutter engine',
        );
        expect(
          originalStats.unique.where((alpha) => alpha > 0),
          hasLength(1),
          reason:
              'the selected source phase must alias to one opaque texel class',
        );
        expect(
          lodStats.mean,
          closeTo(128, 4),
          reason: 'filtered texture alpha should converge to half coverage',
        );
        expect(
          lodStats.intermediatePixels,
          greaterThan(originalStats.intermediatePixels),
          reason:
              'the LOD should smooth texture-alpha variation inside the quad',
        );

        // Keep the actual measurements in the test log so a future sampler or
        // engine change can distinguish texture improvements from geometry AA.
        // ignore: avoid_print
        print(
          'mesh alias sources: geometry-intermediate-alpha=$geometryEdgeAlpha; '
          'drawVertices-aa-identical=${_sameBytes(geometricAa, geometricNoAa)}; '
          'texture-alpha-original=${originalStats.summary}; '
          'texture-alpha-lod=${lodStats.summary}',
        );
      } finally {
        solid.dispose();
        alphaPattern.dispose();
        alphaLevel.dispose();
      }
    },
  );
}

List<PocketOp> _fullQuad(String asset) => <PocketOp>[
  PocketTextureTriangleOp(
    x: 0,
    y: 0,
    width: 32,
    height: 32,
    asset: asset,
    color: 0xffffffff,
    points: const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 32, y: 0),
      PocketPoint(x: 32, y: 32),
    ],
    uvs: const <double>[0, 0, 1, 0, 1, 1],
    repeatTexture: true,
  ),
  PocketTextureTriangleOp(
    x: 0,
    y: 0,
    width: 32,
    height: 32,
    asset: asset,
    color: 0xffffffff,
    points: const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 32, y: 32),
      PocketPoint(x: 0, y: 32),
    ],
    uvs: const <double>[0, 0, 1, 1, 0, 1],
    repeatTexture: true,
  ),
];

Future<_Raster> _render(
  List<PocketOp> ops,
  Map<String, ui.Image> images, {
  Map<String, List<ui.Image>> meshImageLevels =
      const <String, List<ui.Image>>{},
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  PocketCanvasPainter(
    width: 32,
    height: 32,
    ops: ops,
    images: images,
    meshImageLevels: meshImageLevels,
  ).paint(canvas, const ui.Size(32, 32));
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(32, 32);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      return _Raster(Uint8List.fromList(data!.buffer.asUint8List()));
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}

Future<_Raster> _renderVertices(
  ui.Vertices vertices, {
  required bool antiAlias,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawVertices(
    vertices,
    ui.BlendMode.srcOver,
    ui.Paint()..isAntiAlias = antiAlias,
  );
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(32, 32);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      return _Raster(Uint8List.fromList(data!.buffer.asUint8List()));
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}

Future<ui.Image> _solidTexture(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder)
    ..drawColor(const ui.Color(0xffffffff), ui.BlendMode.src);
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(width, height);
  } finally {
    picture.dispose();
  }
}

Future<ui.Image> _diagonalAlphaPattern(
  int size, {
  required int cell,
  required int phase,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  final paint = ui.Paint()..color = const ui.Color(0xffffffff);
  final cells = size ~/ cell;
  for (var y = -1; y <= cells; y++) {
    final top = (y * cell - phase).clamp(0, size);
    final bottom = ((y + 1) * cell - phase).clamp(0, size);
    if (top >= bottom) continue;
    for (var x = -1; x <= cells; x++) {
      final left = (x * cell - phase).clamp(0, size);
      final right = ((x + 1) * cell - phase).clamp(0, size);
      if (left < right && (x + y).isEven) {
        canvas.drawRect(
          ui.Rect.fromLTWH(
            left.toDouble(),
            top.toDouble(),
            (right - left).toDouble(),
            (bottom - top).toDouble(),
          ),
          paint,
        );
      }
    }
  }
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(size, size);
  } finally {
    picture.dispose();
  }
}

Future<ui.Image> _downsample(ui.Image source, int size) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawImageRect(
    source,
    ui.Rect.fromLTWH(0, 0, source.width.toDouble(), source.height.toDouble()),
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

int _intermediateAlphaPixels(_Raster raster) =>
    raster.alpha.where((alpha) => alpha > 0 && alpha < 255).length;

bool _sameBytes(_Raster first, _Raster second) {
  if (first.bytes.length != second.bytes.length) return false;
  for (var index = 0; index < first.bytes.length; index++) {
    if (first.bytes[index] != second.bytes[index]) return false;
  }
  return true;
}

_AlphaStats _alphaStats(_Raster raster) {
  final alpha = raster.alpha;
  final unique = alpha.toSet().toList()..sort();
  final mean = alpha.reduce((sum, value) => sum + value) / alpha.length;
  return _AlphaStats(
    unique: unique,
    mean: mean,
    intermediatePixels: _intermediateAlphaPixels(raster),
  );
}

final class _AlphaStats {
  const _AlphaStats({
    required this.unique,
    required this.mean,
    required this.intermediatePixels,
  });

  final List<int> unique;
  final double mean;
  final int intermediatePixels;

  String get summary =>
      'unique=$unique mean=${mean.toStringAsFixed(2)} '
      'intermediate=$intermediatePixels';
}

final class _Raster {
  const _Raster(this.bytes);

  final Uint8List bytes;

  List<int> get alpha => <int>[
    for (var offset = 3; offset < bytes.length; offset += 4) bytes[offset],
  ];
}
