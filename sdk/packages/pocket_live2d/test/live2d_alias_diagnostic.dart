import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:pocket_flutter/pocket_flutter.dart';

/// Re-renders one frozen real-Core Hiyori draw-list at native and supersampled
/// sizes. This is an opt-in test diagnostic; it does not alter the live view.
Future<Map<String, Object?>> runHiyoriAliasDiagnostic({
  required List<PocketCanvasPainter> painters,
  required String highResolutionModelRoot,
  required String outputDirectory,
}) async {
  final blocks = _modelBlocks(painters);
  if (blocks.isEmpty) throw StateError('Hiyori has no captured mesh blocks');
  final modelAssets = <String>{
    for (final block in blocks)
      for (final op in block.ops.whereType<PocketTextureTriangleOp>()) op.asset,
  };
  if (modelAssets.length != 2) {
    throw StateError('Expected two Hiyori texture assets, got $modelAssets');
  }

  final sourceImages = <String, ui.Image>{};
  final sourcePaths = <String, String>{};
  final generated = <ui.Image>{};
  final output = Directory(outputDirectory);
  await output.create(recursive: true);

  Future<Uint8List> saveAndRead(String name, ui.Image image) async {
    await _writePng(image, File('${output.path}/$name'));
    final bytes = await _rgbaBytes(image);
    generated.remove(image);
    image.dispose();
    return bytes;
  }

  try {
    for (final asset in modelAssets) {
      final fileName = _basename(asset);
      if (fileName != 'texture_00.png' && fileName != 'texture_01.png') {
        throw StateError('Unexpected Hiyori texture asset: $asset');
      }
      final path = <String>[
        highResolutionModelRoot,
        'Hiyori.2048',
        fileName,
      ].join(Platform.pathSeparator);
      final file = File(path);
      if (!file.existsSync()) {
        throw StateError('Missing original 2048 texture: $path');
      }
      final image = await _decodeImage(await file.readAsBytes());
      if (image.width != 2048 || image.height != 2048) {
        final dimensions = '${image.width}x${image.height}';
        image.dispose();
        throw StateError(
          'Expected original 2048x2048 Hiyori texture at $path, '
          'got $dimensions',
        );
      }
      generated.add(image);
      sourceImages[asset] = image;
      sourcePaths[asset] = path;
    }

    final targetSize = _physicalTargetSize(blocks.first.painter);
    final targetWidth = targetSize.width;
    final targetHeight = targetSize.height;
    final actualLevels = <String, List<ui.Image>>{};
    for (final entry in sourceImages.entries) {
      actualLevels[entry.key] = await _buildLevelsFromOriginal(entry.value);
      generated.addAll(actualLevels[entry.key]!);
    }

    final visibleAssets = _visibleModelAssets(blocks);
    final opaque = await _solidImage(2048, 2048);
    generated.add(opaque);
    final geometryImages = Map<String, ui.Image>.of(sourceImages);
    for (final asset in visibleAssets) {
      geometryImages[asset] = opaque;
    }

    final actualTarget = await _renderModelBlocks(
      blocks,
      sourceImages,
      meshImageLevels: const <String, List<ui.Image>>{},
      supersample: 1,
    );
    generated.add(actualTarget);
    final actualBytes = await saveAndRead(
      'actual-target-no-lod.png',
      actualTarget,
    );
    final actualTargetLod = await _renderModelBlocks(
      blocks,
      sourceImages,
      meshImageLevels: actualLevels,
      supersample: 1,
    );
    generated.add(actualTargetLod);
    final actualLodBytes = await saveAndRead(
      'actual-target-lod.png',
      actualTargetLod,
    );
    final actualHigh = await _renderModelBlocks(
      blocks,
      sourceImages,
      meshImageLevels: const <String, List<ui.Image>>{},
      supersample: 4,
    );
    generated.add(actualHigh);
    await _writePng(
      actualHigh,
      File('${output.path}/actual-supersampled-reference-4x.png'),
    );
    final actualReference = await _downsample(
      actualHigh,
      targetWidth,
      targetHeight,
    );
    generated.add(actualReference);
    final actualReferenceBytes = await saveAndRead(
      'actual-reference-downsampled.png',
      actualReference,
    );
    generated.remove(actualHigh);
    actualHigh.dispose();

    final geometryTarget = await _renderModelBlocks(
      blocks,
      geometryImages,
      meshImageLevels: const <String, List<ui.Image>>{},
      supersample: 1,
    );
    generated.add(geometryTarget);
    final geometryBytes = await saveAndRead(
      'geometry-only-target.png',
      geometryTarget,
    );
    final geometryHigh = await _renderModelBlocks(
      blocks,
      geometryImages,
      meshImageLevels: const <String, List<ui.Image>>{},
      supersample: 4,
    );
    generated.add(geometryHigh);
    await _writePng(
      geometryHigh,
      File('${output.path}/geometry-only-reference-4x.png'),
    );
    final geometryReference = await _downsample(
      geometryHigh,
      targetWidth,
      targetHeight,
    );
    generated.add(geometryReference);
    final geometryReferenceBytes = await saveAndRead(
      'geometry-only-reference-downsampled.png',
      geometryReference,
    );
    generated.remove(geometryHigh);
    geometryHigh.dispose();

    final report = <String, Object?>{
      'scope': 'test-only frozen-frame offline render; not a Guest build',
      'sourceImages': <String, Object?>{
        for (final asset in modelAssets)
          asset: <String, Object?>{
            'path': sourcePaths[asset],
            'width': sourceImages[asset]!.width,
            'height': sourceImages[asset]!.height,
          },
      },
      'targetPhysicalSize': <String, int>{
        'width': targetWidth,
        'height': targetHeight,
      },
      'devicePixelRatio': blocks.first.painter.devicePixelRatio,
      'supersampling': 4,
      'generatedLodSizes': <String, Object?>{
        for (final entry in actualLevels.entries)
          entry.key: <String>[
            for (final image in entry.value) '${image.width}x${image.height}',
          ],
      },
      'geometryControl':
          'visible model textures replaced by solid opaque white; mask texture inputs retained',
      'metrics': <String, Object?>{
        'actualNoLodVs4xReference': _pixelMetrics(
          actualBytes,
          actualReferenceBytes,
        ),
        'actualLodVs4xReference': _pixelMetrics(
          actualLodBytes,
          actualReferenceBytes,
        ),
        'geometryNoLodVs4xReference': _pixelMetrics(
          geometryBytes,
          geometryReferenceBytes,
        ),
      },
    };
    await File('${output.path}/report.json').writeAsString(
      const JsonEncoder.withIndent('  ').convert(report),
      flush: true,
    );
    // ignore: avoid_print
    print('Hiyori alias diagnostic: ${jsonEncode(report)}');
    return report;
  } finally {
    for (final image in generated) {
      image.dispose();
    }
  }
}

List<({PocketCanvasPainter painter, List<PocketOp> ops})> _modelBlocks(
  List<PocketCanvasPainter> painters,
) => <({PocketCanvasPainter painter, List<PocketOp> ops})>[
  for (final painter in painters)
    (
      painter: painter,
      ops: <PocketOp>[
        for (final op in painter.ops)
          if ((op is PocketTextureTriangleOp &&
                  op.asset.contains('models/Hiyori/')) ||
              op is PocketMeshLayerBeginOp ||
              op is PocketMeshMaskBeginOp ||
              op is PocketMeshLayerRestoreOp)
            op,
      ],
    ),
].where((block) => block.ops.isNotEmpty).toList();

Set<String> _visibleModelAssets(
  List<({PocketCanvasPainter painter, List<PocketOp> ops})> blocks,
) {
  final assets = <String>{};
  for (final block in blocks) {
    var inMask = false;
    for (final op in block.ops) {
      if (op is PocketMeshMaskBeginOp) {
        inMask = true;
      } else if (op is PocketMeshLayerRestoreOp) {
        inMask = false;
      } else if (!inMask && op is PocketTextureTriangleOp) {
        assets.add(op.asset);
      }
    }
  }
  return assets;
}

Future<ui.Image> _decodeImage(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    return (await codec.getNextFrame()).image;
  } finally {
    codec.dispose();
  }
}

Future<ui.Image> _solidImage(int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawColor(const ui.Color(0xffffffff), ui.BlendMode.src);
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(width, height);
  } finally {
    picture.dispose();
  }
}

Future<List<ui.Image>> _buildLevelsFromOriginal(ui.Image source) async {
  final levels = <ui.Image>[];
  try {
    for (final divisor in const <int>[2, 4, 8]) {
      final width = source.width ~/ divisor;
      final height = source.height ~/ divisor;
      if (width < 64 || height < 64) continue;
      levels.add(await _downsample(source, width, height));
    }
    return List<ui.Image>.unmodifiable(levels);
  } on Object {
    for (final image in levels) {
      image.dispose();
    }
    rethrow;
  }
}

Future<ui.Image> _renderModelBlocks(
  List<({PocketCanvasPainter painter, List<PocketOp> ops})> blocks,
  Map<String, ui.Image> images, {
  required Map<String, List<ui.Image>> meshImageLevels,
  required int supersample,
}) async {
  final first = blocks.first.painter;
  final devicePixelRatio = first.devicePixelRatio > 0
      ? first.devicePixelRatio
      : 1.0;
  final scale = devicePixelRatio * supersample;
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  for (final block in blocks) {
    final painter = block.painter;
    final renderedSize =
        painter.renderedSize ?? ui.Size(painter.width, painter.height);
    PocketCanvasPainter(
      width: painter.width,
      height: painter.height,
      ops: block.ops,
      images: images,
      meshImageLevels: meshImageLevels,
      renderedSize: ui.Size(
        renderedSize.width * scale,
        renderedSize.height * scale,
      ),
      // The explicit paint size below includes the actual host DPR and the
      // supersampling factor. Fold both into sx/sy so the painter's own
      // pixelScale and LOD selection match the target raster density.
      devicePixelRatio: 1,
      fontFamilyFallback: painter.fontFamilyFallback,
    ).paint(
      canvas,
      ui.Size(renderedSize.width * scale, renderedSize.height * scale),
    );
  }
  final picture = recorder.endRecording();
  try {
    final renderedSize =
        first.renderedSize ?? ui.Size(first.width, first.height);
    return await picture.toImage(
      (renderedSize.width * scale).ceil(),
      (renderedSize.height * scale).ceil(),
    );
  } finally {
    picture.dispose();
  }
}

Future<ui.Image> _downsample(ui.Image source, int width, int height) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawImageRect(
    source,
    ui.Rect.fromLTWH(0, 0, source.width.toDouble(), source.height.toDouble()),
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..filterQuality = ui.FilterQuality.medium,
  );
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(width, height);
  } finally {
    picture.dispose();
  }
}

({int width, int height}) _physicalTargetSize(PocketCanvasPainter painter) {
  final size = painter.renderedSize ?? ui.Size(painter.width, painter.height);
  final dpr = painter.devicePixelRatio > 0 ? painter.devicePixelRatio : 1.0;
  return (width: (size.width * dpr).ceil(), height: (size.height * dpr).ceil());
}

Future<Uint8List> _rgbaBytes(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  if (data == null) throw StateError('Could not read rendered image pixels');
  return Uint8List.fromList(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
  );
}

Map<String, Object?> _pixelMetrics(Uint8List actual, Uint8List reference) {
  if (actual.length != reference.length || actual.length % 4 != 0) {
    throw StateError('Pixel images have incompatible RGBA byte lengths');
  }
  var total = 0;
  var alphaTotal = 0;
  var partialAlpha = 0;
  var differentAlphaPixels = 0;
  for (var offset = 0; offset < actual.length; offset += 4) {
    for (var channel = 0; channel < 4; channel++) {
      total += (actual[offset + channel] - reference[offset + channel]).abs();
    }
    final alpha = actual[offset + 3];
    if (alpha > 0 && alpha < 255) partialAlpha++;
    final alphaDifference = (alpha - reference[offset + 3]).abs();
    alphaTotal += alphaDifference;
    if (alphaDifference > 16) differentAlphaPixels++;
  }
  final pixels = actual.length ~/ 4;
  return <String, Object?>{
    'meanAbsRgba': total / actual.length,
    'meanAbsAlpha': alphaTotal / pixels,
    'partialAlphaPixels': partialAlpha,
    'alphaPixelsDifferingByMoreThan16': differentAlphaPixels,
  };
}

Future<void> _writePng(ui.Image image, File path) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  if (data == null) throw StateError('Could not encode ${path.path}');
  await path.writeAsBytes(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    flush: true,
  );
}

String _basename(String path) =>
    path.split(RegExp(r'[/\\]')).where((part) => part.isNotEmpty).last;
