import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart' show CustomPaint, CustomPainter;
import 'package:pocket_flutter/pocket_flutter.dart';

/// Reads the live CustomPaint sequence without inserting test widgets. Group
/// painters contribute their original source partitions at their current
/// position in the sequence.
final class NovelMeshPainterInventory {
  NovelMeshPainterInventory({
    required this.paintSequence,
    required this.sourcePartitions,
    required this.spanPainters,
  });

  final List<CustomPainter> paintSequence;
  final List<PocketCanvasPainter> sourcePartitions;
  final List<PocketMeshSpanPainter> spanPainters;
}

NovelMeshPainterInventory inspectNovelMeshPainters(
  Iterable<CustomPaint> widgets,
) {
  final paintSequence = <CustomPainter>[];
  final sourcePartitions = <PocketCanvasPainter>[];
  final spanPainters = <PocketMeshSpanPainter>[];
  for (final widget in widgets) {
    final painter = widget.painter;
    if (painter is PocketCanvasPainter) {
      paintSequence.add(painter);
      sourcePartitions.add(painter);
    } else if (painter is PocketMeshSpanPainter) {
      paintSequence.add(painter);
      spanPainters.add(painter);
      sourcePartitions.addAll(painter.partitions);
    }
  }
  return NovelMeshPainterInventory(
    paintSequence: List<CustomPainter>.unmodifiable(paintSequence),
    sourcePartitions: List<PocketCanvasPainter>.unmodifiable(sourcePartitions),
    spanPainters: List<PocketMeshSpanPainter>.unmodifiable(spanPainters),
  );
}

void resetNovelMeshSpanDiagnostics() =>
    PocketMeshSpanPainter.resetDiagnostics();

Map<String, Object?> snapshotNovelMeshSpanDiagnostics() => <String, Object?>{
  'spanPaintCount': PocketMeshSpanPainter.spanPaintCount,
  'snapshotCount': PocketMeshSpanPainter.snapshotCount,
  'disposedSnapshotCount': PocketMeshSpanPainter.disposedSnapshotCount,
  'snapshotDisposeCountMatches':
      PocketMeshSpanPainter.snapshotCount ==
      PocketMeshSpanPainter.disposedSnapshotCount,
  'snapshottedPixelCount': PocketMeshSpanPainter.snapshottedPixelCount,
  'budgetBypassCount': PocketMeshSpanPainter.budgetBypassCount,
  'ineligibleBypassCount': PocketMeshSpanPainter.ineligibleBypassCount,
  'snapshotFailureBypassCount':
      PocketMeshSpanPainter.snapshotFailureBypassCount,
  'imageHandlesDisposed':
      'Dart ui.Image handle disposal only; does not assert GPU in-flight completion',
};

Map<String, Object?> describeNovelMeshSpanPainters(
  NovelMeshPainterInventory inventory,
) {
  final allSourceImages = <ui.Image>{
    for (final partition in inventory.sourcePartitions)
      ...partition.images.values,
  };
  final allMeshLevelImages = <ui.Image>{
    for (final partition in inventory.sourcePartitions)
      for (final levels in partition.meshImageLevels.values) ...levels,
  }..removeAll(allSourceImages);
  final spans = <Map<String, Object?>>[];
  for (
    var spanIndex = 0;
    spanIndex < inventory.spanPainters.length;
    spanIndex++
  ) {
    final span = inventory.spanPainters[spanIndex];
    final partitions = span.partitions;
    final sourceImages = <ui.Image>{
      for (final partition in partitions) ...partition.images.values,
    };
    final mipImages = <ui.Image>{
      for (final partition in partitions)
        for (final levels in partition.meshImageLevels.values) ...levels,
    }..removeAll(sourceImages);
    final hiyoriOps = <PocketTextureTriangleOp>[
      for (final partition in partitions)
        for (final op in partition.ops.whereType<PocketTextureTriangleOp>())
          if (op.asset.contains('Hiyori.2048/texture_')) op,
    ];
    final hiyoriAssets = hiyoriOps.map((op) => op.asset).toSet().toList()
      ..sort();
    final first = partitions.isEmpty ? null : partitions.first;
    spans.add(<String, Object?>{
      'spanIndex': spanIndex,
      'sampleScale': span.sampleScale,
      'sourcePartitionCount': partitions.length,
      'logicalSize': first == null
          ? null
          : <double>[
              first.renderedSize?.width ?? first.width,
              first.renderedSize?.height ?? first.height,
            ],
      'devicePixelRatio': first?.devicePixelRatio,
      'hiyoriTriangleOpCount': hiyoriOps.length,
      'hiyoriTextureAssets': hiyoriAssets,
      'sourceImageCount': sourceImages.length,
      'sourceImagePixels': sourceImages.fold<int>(
        0,
        (sum, image) => sum + image.width * image.height,
      ),
      'meshLevelImageCount': mipImages.length,
      'meshLevelImagePixels': mipImages.fold<int>(
        0,
        (sum, image) => sum + image.width * image.height,
      ),
      'snapshotImagesIncludedInSourceResourceCounts': false,
    });
  }
  final hiyoriPartitionCount = inventory.spanPainters.fold<int>(
    0,
    (sum, span) =>
        sum +
        span.partitions
            .where((partition) => _hasHiyoriOps(partition.ops))
            .length,
  );
  final hiyoriTriangleOpCount = spans.fold<int>(
    0,
    (sum, span) => sum + (span['hiyoriTriangleOpCount']! as int),
  );
  return <String, Object?>{
    'spanPainterCount': inventory.spanPainters.length,
    'pocketPainterSequenceCount': inventory.paintSequence.length,
    'pocketCanvasSourcePartitionCount': inventory.sourcePartitions.length,
    'spanSourcePartitionCount': inventory.spanPainters.fold<int>(
      0,
      (sum, span) => sum + span.partitions.length,
    ),
    'hiyoriSpanCount': spans
        .where((span) => (span['hiyoriTriangleOpCount'] as int) > 0)
        .length,
    'hiyoriSourcePartitionCount': hiyoriPartitionCount,
    'hiyoriTriangleOpCount': hiyoriTriangleOpCount,
    'spanPainters': spans,
    'sourceImageCount': allSourceImages.length,
    'meshLevelImageCount': allMeshLevelImages.length,
    'sourceDecodedImagesExcludeSnapshots': true,
  };
}

bool _hasHiyoriOps(List<PocketOp> ops) => ops
    .whereType<PocketTextureTriangleOp>()
    .any((op) => op.asset.contains('Hiyori.2048/texture_'));

/// Names the production aggregate selection and keeps the minimum-density
/// result explicit as a diagnostic only. Historical archived JSON is left as
/// originally recorded.
Map<String, Object?> nameNovelMeshLodSelections(Map<String, Object?> report) {
  final raw = report['batches'];
  if (raw is! List) throw StateError('LOD report has no batches list.');
  return <String, Object?>{
    ...report,
    'selectionNaming': <String, String>{
      'selectedAggregate': 'old aggregate UV-area / screen-area policy',
      'selectedMinDensityDiagnostic':
          'diagnostic bound only; not an adopted sampling policy',
    },
    'batches': <Map<String, Object?>>[
      for (final item in raw)
        if (item is Map)
          <String, Object?>{
            for (final entry in item.entries)
              if (entry.key != 'selectedCurrent' &&
                  entry.key != 'selectedAggregate' &&
                  entry.key != 'selectedUsingMinDensity' &&
                  entry.key != 'selectedMinDensity')
                entry.key.toString(): entry.value,
            'selectedAggregate':
                item['selectedAggregate'] ?? item['selectedCurrent'],
            'selectedMinDensityDiagnostic':
                item['selectedMinDensity'] ?? item['selectedUsingMinDensity'],
          },
    ],
  };
}

/// Reports the real repeated-texture Hiyori batches that PocketCanvasPainter
/// would select for the supplied frozen painters. This helper only reads
/// DrawOps and image dimensions; it does not render or mutate painter state.
///
/// The batch walk and aggregate density intentionally mirror
/// `pocket_view_painter.dart::_drawTextureTriangleBatch`. Per-triangle density
/// is added only as a diagnostic so the current average can be compared with
/// the most conservative member of each actual contiguous batch.
Map<String, Object?> diagnoseNovelMeshLodBatches(
  List<PocketCanvasPainter> painters,
) {
  final reports = <Map<String, Object?>>[];
  var reportedBatchCount = 0;

  for (var painterIndex = 0; painterIndex < painters.length; painterIndex++) {
    final painter = painters[painterIndex];
    if (painter.width <= 0 || painter.height <= 0) continue;

    final scaleX =
        (painter.renderedSize?.width ?? painter.width) / painter.width;
    final scaleY =
        (painter.renderedSize?.height ?? painter.height) / painter.height;
    final pixelScale =
        (scaleX * scaleY).abs() *
        painter.devicePixelRatio *
        painter.devicePixelRatio;

    var opIndex = 0;
    var batchIndex = 0;
    while (opIndex < painter.ops.length) {
      final op = painter.ops[opIndex];
      if (op is! PocketTextureTriangleOp) {
        opIndex++;
        continue;
      }

      final first = op;
      final batch = <PocketTextureTriangleOp>[first];
      var end = opIndex + 1;
      while (end < painter.ops.length) {
        final candidate = painter.ops[end];
        if (candidate is! PocketTextureTriangleOp ||
            candidate.asset != first.asset ||
            candidate.color != first.color ||
            candidate.repeatTexture != first.repeatTexture ||
            !_sameClip(candidate.clip, first.clip)) {
          break;
        }
        batch.add(candidate);
        end++;
      }

      final actualBatchIndex = batchIndex++;
      // Walk every batch before filtering so the index and the run boundaries
      // match production, including any non-Hiyori ops between model batches.
      if (first.repeatTexture && first.asset.contains('Hiyori.2048/texture_')) {
        final source = painter.images[first.asset];
        final levels =
            painter.meshImageLevels[first.asset] ?? const <ui.Image>[];
        final triangleDensities = <double>[];
        var invalidTriangleDensityCount = 0;
        var textureArea = 0.0;
        var screenArea = 0.0;
        var triangleCount = 0;

        if (source != null) {
          for (final triangleOp in batch) {
            for (
              var pointIndex = 0;
              pointIndex + 2 < triangleOp.points.length;
              pointIndex += 3
            ) {
              final a = triangleOp.points[pointIndex];
              final b = triangleOp.points[pointIndex + 1];
              final c = triangleOp.points[pointIndex + 2];
              final area =
                  ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs();
              // Match the production painter's degenerate-screen-triangle
              // exclusion exactly.
              if (area <= 1e-9) continue;

              final uvIndex = pointIndex * 2;
              final du1 = triangleOp.uvs[uvIndex + 2] - triangleOp.uvs[uvIndex];
              final dv1 =
                  triangleOp.uvs[uvIndex + 3] - triangleOp.uvs[uvIndex + 1];
              final du2 = triangleOp.uvs[uvIndex + 4] - triangleOp.uvs[uvIndex];
              final dv2 =
                  triangleOp.uvs[uvIndex + 5] - triangleOp.uvs[uvIndex + 1];
              final triangleTextureArea =
                  (du1 * dv2 - dv1 * du2).abs() * source.width * source.height;
              final triangleScreenArea = area * pixelScale;
              textureArea += triangleTextureArea;
              screenArea += triangleScreenArea;
              triangleCount++;

              final density = math.sqrt(
                triangleTextureArea / triangleScreenArea,
              );
              if (density.isFinite && density >= 0) {
                triangleDensities.add(density);
              } else {
                invalidTriangleDensityCount++;
              }
            }
          }
        }

        final aggregateDensity =
            source != null && screenArea > 0 && textureArea.isFinite
            ? math.sqrt(textureArea / screenArea)
            : null;
        final sortedDensities = List<double>.of(triangleDensities)..sort();
        final minDensity = sortedDensities.isEmpty
            ? null
            : sortedDensities.first;
        final currentSelection = source == null
            ? null
            : _selectImage(
                source: source,
                levels: levels,
                repeatTexture: first.repeatTexture,
                pixelScale: pixelScale,
                density: aggregateDensity,
              );
        final conservativeSelection = source == null
            ? null
            : _selectImage(
                source: source,
                levels: levels,
                repeatTexture: first.repeatTexture,
                pixelScale: pixelScale,
                density: minDensity,
              );

        final currentPixels = currentSelection == null
            ? null
            : currentSelection.width * currentSelection.height;
        final conservativePixels = conservativeSelection == null
            ? null
            : conservativeSelection.width * conservativeSelection.height;
        reports.add(<String, Object?>{
          'painterIndex': painterIndex,
          'batchIndex': actualBatchIndex,
          'asset': first.asset,
          'color': first.color,
          'repeatTexture': first.repeatTexture,
          'clip': _clipJson(first.clip),
          'drawOpCount': batch.length,
          'triangleCount': triangleCount,
          'sourceDimensions': source == null
              ? null
              : <String, int>{'width': source.width, 'height': source.height},
          'availableLevelDimensions': <Map<String, int>>[
            for (final level in levels)
              <String, int>{'width': level.width, 'height': level.height},
          ],
          'pixelScale': pixelScale,
          'aggregateDensityTexelsPerPixel': _jsonNumber(aggregateDensity),
          'triangleDensityTexelsPerPixel': <String, Object?>{
            'min': _jsonNumber(minDensity),
            'p50': _jsonNumber(_percentile50(sortedDensities)),
            'max': _jsonNumber(
              sortedDensities.isEmpty ? null : sortedDensities.last,
            ),
            'sampleCount': sortedDensities.length,
            'invalidCount': invalidTriangleDensityCount,
          },
          'selectedCurrent': _selectionJson(source, currentSelection),
          'selectedUsingMinDensity': _selectionJson(
            source,
            conservativeSelection,
          ),
          'minDensitySelectsHigherResolution':
              currentPixels != null &&
              conservativePixels != null &&
              conservativePixels > currentPixels,
        });
        reportedBatchCount++;
      }

      opIndex = end;
    }
  }

  return <String, Object?>{
    'scope': 'read-only actual-frame DrawOp density diagnostic; no rendering',
    'batching': 'same painter block; contiguous asset/color/repeat/clip match',
    'densityFormula':
        'sqrt(abs(UV determinant)*sourceWidth*sourceHeight/(abs(XY determinant)*pixelScale))',
    'currentDensityFormula':
        'sqrt(sum texture area / sum physical screen area)',
    'conservativeSelection':
        'run current LOD thresholds with the minimum valid per-triangle density',
    'reportedBatchCount': reportedBatchCount,
    'batches': reports,
  };
}

ui.Image? _selectImage({
  required ui.Image source,
  required List<ui.Image> levels,
  required bool repeatTexture,
  required double pixelScale,
  required double? density,
}) {
  var selected = source;
  if (!repeatTexture || levels.isEmpty || pixelScale <= 0 || density == null) {
    return selected;
  }

  for (final level in levels) {
    if (level.width < source.width &&
        level.height < source.height &&
        level.width * source.height == level.height * source.width &&
        level.width <= selected.width &&
        level.width * density + 1e-6 >= source.width &&
        level.height * density + 1e-6 >= source.height) {
      selected = level;
    }
  }
  return selected;
}

double? _percentile50(List<double> sorted) {
  if (sorted.isEmpty) return null;
  final middle = sorted.length ~/ 2;
  if (sorted.length.isOdd) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

Object? _jsonNumber(double? value) =>
    value == null || !value.isFinite ? null : value;

Map<String, Object?>? _selectionJson(ui.Image? source, ui.Image? selected) {
  if (source == null || selected == null) return null;
  return <String, Object?>{
    'width': selected.width,
    'height': selected.height,
    'sourceWidthDivisor': source.width / selected.width,
  };
}

Map<String, Object?>? _clipJson(PocketClip? clip) => clip == null
    ? null
    : <String, Object?>{
        'x': clip.x,
        'y': clip.y,
        'width': clip.width,
        'height': clip.height,
      };

bool _sameClip(PocketClip? first, PocketClip? second) {
  if (identical(first, second)) return true;
  if (first == null || second == null) return false;
  return first.x == second.x &&
      first.y == second.y &&
      first.width == second.width &&
      first.height == second.height;
}
