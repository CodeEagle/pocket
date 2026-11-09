import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart' show CustomPainter;
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pocket_flutter/pocket_flutter.dart';

import 'novel_mesh_lod_diagnostics.dart';

/// Replays the real Pocket painter sequence captured from the widget tree.
/// The baseline expands each live group into its existing source partitions;
/// the group1 gate uses the SDK group painter at sampleScale 1; the candidate
/// calls the actual active group painters. No test widgets are inserted.
Future<Map<String, Object?>> captureNovelMeshSpanSameFrameAblation({
  required WidgetTester tester,
  required NovelMeshPainterInventory inventory,
  required String framing,
  required String outputTag,
}) async {
  if (inventory.spanPainters.isEmpty) {
    throw StateError('No live PocketMeshSpanPainter exists in this frame.');
  }
  if (inventory.sourcePartitions.isEmpty || inventory.paintSequence.isEmpty) {
    throw StateError('The live Pocket mesh painter sequence is empty.');
  }
  final first = inventory.sourcePartitions.first;
  final logicalSize = first.renderedSize ?? ui.Size(first.width, first.height);
  final dpr = first.devicePixelRatio;
  if (logicalSize.width <= 0 ||
      logicalSize.height <= 0 ||
      !dpr.isFinite ||
      dpr <= 0) {
    throw StateError('Invalid live Pocket canvas $logicalSize at DPR $dpr.');
  }
  for (final partition in inventory.sourcePartitions) {
    final size =
        partition.renderedSize ?? ui.Size(partition.width, partition.height);
    if (partition.width != first.width ||
        partition.height != first.height ||
        partition.devicePixelRatio != dpr ||
        size != logicalSize) {
      throw StateError(
        'Live Pocket partitions do not share one size and device DPR.',
      );
    }
  }

  final width = (logicalSize.width * dpr).ceil();
  final height = (logicalSize.height * dpr).ceil();
  final baseline = await _rasterPocketPainterSequence(
    tester,
    inventory,
    logicalSize: logicalSize,
    dpr: dpr,
    outputWidth: width,
    outputHeight: height,
    mode: _SpanReplayMode.expandedPartitions,
  );
  ui.Image? groupOne;
  ui.Image? candidate;
  try {
    groupOne = await _rasterPocketPainterSequence(
      tester,
      inventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: width,
      outputHeight: height,
      mode: _SpanReplayMode.groupPainterAtOne,
    );
    final groupOneDiff = await _compareSpanImages(tester, baseline, groupOne);
    expect(
      groupOneDiff['differingPixelCount'],
      0,
      reason:
          'The real group painter at sampleScale 1 must match its source partitions.',
    );

    candidate = await _rasterPocketPainterSequence(
      tester,
      inventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: width,
      outputHeight: height,
      mode: _SpanReplayMode.activeGroupPainters,
    );
    final candidateDiff = await _compareSpanImages(tester, baseline, candidate);
    final paths = <String, Object?>{
      'baselineExpandedPartitions': await _writeSpanPng(
        tester,
        baseline,
        'model-mesh-span-baseline-$framing-$outputTag.png',
      ),
      'activeGroupPainters': await _writeSpanPng(
        tester,
        candidate,
        'model-mesh-span-candidate-$framing-$outputTag.png',
      ),
    };
    return <String, Object?>{
      'framing': framing,
      'logicalSize': <double>[logicalSize.width, logicalSize.height],
      'devicePixelRatio': dpr,
      'testViewDevicePixelRatio': tester.view.devicePixelRatio,
      'painterDprMatchesTestView': dpr == tester.view.devicePixelRatio,
      'pixelSize': <int>[width, height],
      'pocketPainterSequenceCount': inventory.paintSequence.length,
      'productionPainterSequencePreserved': true,
      'liveSpanPainters': describeNovelMeshSpanPainters(inventory),
      'baselineStrategy':
          'paint every source PocketCanvasPainter directly; expand each actual span into its original ordered partitions',
      'groupOneGate': <String, Object?>{
        'strategy':
            'call PocketMeshSpanPainter.paint with the same original partitions and sampleScale 1',
        'pixelDifferenceFromBaseline': groupOneDiff,
        'pixelIdentical': groupOneDiff['differingPixelCount'] == 0,
      },
      'candidateStrategy':
          'call the active PocketMeshSpanPainter instances captured from the real CustomPaint widget tree',
      'candidateSpanSampleScales': inventory.spanPainters
          .map((span) => span.sampleScale)
          .toList(growable: false),
      'candidatePainterDiagnostics':
          _lastGroupReplayCounters ?? <String, Object?>{},
      'candidatePixelDifferenceFromBaseline': candidateDiff,
      'outputsAreOffscreenPainterReplays': true,
      'ordinaryWindowScreenshotIsSeparate': true,
      'unsupportedBlendPaintersStayInSequence': true,
      'paths': paths,
      'resources': <String, Object?>{
        'offscreenOutputImagesDisposed': 3,
        'offscreenPicturesDisposed': 3,
        'sourceAndMipImagesOwnedByPocketView': true,
        'spanSnapshotsDisposedByPainter': true,
      },
      'interpretation':
          'The group1 gate checks source partition equivalence. The candidate comparison is direct pixel data for the same captured Pocket painter sequence; it is not a perceived-quality percentage or a performance window.',
    };
  } finally {
    baseline.dispose();
    groupOne?.dispose();
    candidate?.dispose();
  }
}

/// Compares the live Hiyori span with and without its derived texture levels.
/// Both replays use the actual PocketMeshSpanPainter at the captured sample
/// scale and keep the original painter partition, DrawOp, image and layer
/// order. The candidate only supplies an empty meshImageLevels map to copies
/// of the Hiyori span's source partitions.
Future<Map<String, Object?>> captureNovelMeshLodAvailabilityAblation({
  required WidgetTester tester,
  required NovelMeshPainterInventory inventory,
  required String framing,
  required String outputTag,
}) async {
  final hiyoriSpans = inventory.spanPainters
      .where(_spanContainsHiyoriTexture)
      .toList(growable: false);
  expect(
    hiyoriSpans,
    hasLength(1),
    reason: 'The LOD availability A/B requires one actual Hiyori span.',
  );
  final span = hiyoriSpans.single;
  expect(span.sampleScale, 2);
  final partitions = span.partitions;
  expect(partitions, isNotEmpty);
  final first = partitions.first;
  final logicalSize = first.renderedSize ?? ui.Size(first.width, first.height);
  final dpr = first.devicePixelRatio;
  expect(dpr, greaterThan(0));
  expect(dpr.isFinite, isTrue);
  expect(dpr, tester.view.devicePixelRatio);

  final hiyoriAssets = <String>{};
  var availableLevelImageCount = 0;
  for (final partition in partitions) {
    expect(partition.width, first.width);
    expect(partition.height, first.height);
    expect(partition.devicePixelRatio, dpr);
    expect(
      partition.renderedSize ?? ui.Size(partition.width, partition.height),
      logicalSize,
    );
    expect(identical(partition.images, first.images), isTrue);
    expect(identical(partition.meshImageLevels, first.meshImageLevels), isTrue);
    final textureOps = partition.ops.whereType<PocketTextureTriangleOp>();
    expect(
      textureOps.every((op) => op.asset.contains('Hiyori.2048/texture_')),
      isTrue,
      reason: 'The modified span must contain only Hiyori texture triangles.',
    );
    hiyoriAssets.addAll(textureOps.map((op) => op.asset));
  }
  expect(hiyoriAssets, isNotEmpty);
  for (final asset in hiyoriAssets) {
    expect(
      first.images[asset],
      isNotNull,
      reason: 'The original Hiyori image must be present for $asset.',
    );
    availableLevelImageCount += first.meshImageLevels[asset]?.length ?? 0;
  }
  expect(
    availableLevelImageCount,
    greaterThan(0),
    reason: 'The baseline must have generated Hiyori texture levels to use.',
  );

  final outputWidth = (logicalSize.width * dpr).ceil();
  final outputHeight = (logicalSize.height * dpr).ceil();
  ui.Image? baseline;
  ui.Image? noLevels;
  try {
    baseline = await _rasterPocketPainterSequence(
      tester,
      inventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: outputWidth,
      outputHeight: outputHeight,
      mode: _SpanReplayMode.activeGroupPainters,
    );
    final baselineCounters = _lastGroupReplayCounters;

    noLevels = await _rasterPocketPainterSequence(
      tester,
      inventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: outputWidth,
      outputHeight: outputHeight,
      mode: _SpanReplayMode.hiyoriMeshLevelsUnavailable,
    );
    final noLevelsCounters = _lastGroupReplayCounters;
    final difference = await _compareSpanImages(tester, baseline, noLevels);
    final paths = <String, Object?>{
      'aggregateLodWithGeneratedLevels': await _writeSpanPng(
        tester,
        baseline,
        'model-mesh-lod-availability-baseline-$framing-$outputTag.png',
      ),
      'sourceImageOnly': await _writeSpanPng(
        tester,
        noLevels,
        'model-mesh-lod-availability-no-levels-$framing-$outputTag.png',
      ),
    };
    final guestFingerprint = await readNovelBundledGuestIdentity();
    final testSource = File('integration_test/novel_model_showcase_test.dart');
    final testSourceSha256 = await tester.runAsync<String?>(() async {
      try {
        if (!await testSource.exists()) return null;
        return pocketSha256(await testSource.readAsBytes());
      } on FileSystemException {
        return null;
      }
    });
    final helperSource = File(
      'integration_test/novel_mesh_span_diagnostics.dart',
    );
    final helperSourceSha256 = await tester.runAsync<String?>(() async {
      try {
        if (!await helperSource.exists()) return null;
        return pocketSha256(await helperSource.readAsBytes());
      } on FileSystemException {
        return null;
      }
    });
    final report = <String, Object?>{
      'framing': framing,
      'guest': guestFingerprint,
      'testSourcePath': testSource.path,
      'testSourceSha256': testSourceSha256,
      'helperSourcePath': helperSource.path,
      'helperSourceSha256': helperSourceSha256,
      'logicalSize': <double>[logicalSize.width, logicalSize.height],
      'devicePixelRatio': dpr,
      'outputPixels': <int>[outputWidth, outputHeight],
      'sampleScale': span.sampleScale,
      'hiyoriSpanIndex': inventory.spanPainters.indexOf(span),
      'hiyoriPartitionCount': partitions.length,
      'hiyoriTextureAssets': hiyoriAssets.toList()..sort(),
      'availableGeneratedLevelImageCount': availableLevelImageCount,
      'baselineStrategy':
          'replay the captured painter sequence with its actual PocketMeshSpanPainter and existing aggregate-selected mesh levels',
      'candidateStrategy':
          'replay the same sequence and replace only the Hiyori span with PocketMeshSpanPainter over same-order copies whose meshImageLevels map is empty',
      'sameDrawOpListsAndSourceImageObjects': true,
      'sameOriginalSpanPartitionsAndOrder': true,
      'meshImageShaderFilterQuality': 'low in both arms',
      'spanCompositeFilterQuality': 'medium in both arms',
      'baselineGroupCounters': baselineCounters,
      'candidateGroupCounters': noLevelsCounters,
      'rawRgbaDifference': difference,
      'outputs': paths,
      'limitations': <String>[
        'This changes only derived mesh-image-level availability in the captured Hiyori span; it does not test physical Retina acceptance.',
        'The candidate uses the original decoded source image with the production low-filter ImageShader and the same SSAA sample scale.',
        'RGBA differences are raster counts, not a sharpness or perceived-quality score.',
        'Offscreen replay counters are diagnostic painter calls and are not window-frame performance measurements.',
      ],
    };
    final reportPath =
        '${Directory.systemTemp.path}/model-mesh-lod-availability-$framing-$outputTag.json';
    await tester.runAsync(
      () => File(reportPath).writeAsString(jsonEncode(report)),
    );
    return <String, Object?>{'reportPath': reportPath, ...report};
  } finally {
    baseline?.dispose();
    noLevels?.dispose();
  }
}

/// Promotes only batches that currently use the coarsest generated image for
/// their (original partition, asset) map. Finer/source batches remain intact.
/// Both arms use the actual PocketMeshSpanPainter at the captured SSAA scale.
Future<Map<String, Object?>> captureNovelMeshCoarsestLodPromotionAblation({
  required WidgetTester tester,
  required NovelMeshPainterInventory inventory,
  required String framing,
  required String outputTag,
}) async {
  final hiyoriSpans = inventory.spanPainters
      .where(_spanContainsHiyoriTexture)
      .toList(growable: false);
  expect(
    hiyoriSpans,
    hasLength(1),
    reason: 'The coarsest-LOD candidate requires one actual Hiyori span.',
  );
  final span = hiyoriSpans.single;
  expect(span.sampleScale, 2);
  final partitions = span.partitions;
  expect(partitions, isNotEmpty);
  final first = partitions.first;
  final logicalSize = first.renderedSize ?? ui.Size(first.width, first.height);
  final dpr = first.devicePixelRatio;
  expect(dpr, greaterThan(0));
  expect(dpr.isFinite, isTrue);
  expect(dpr, tester.view.devicePixelRatio);

  final hiyoriAssets = <String>{};
  for (final partition in partitions) {
    expect(partition.width, first.width);
    expect(partition.height, first.height);
    expect(partition.devicePixelRatio, dpr);
    expect(
      partition.renderedSize ?? ui.Size(partition.width, partition.height),
      logicalSize,
    );
    expect(identical(partition.images, first.images), isTrue);
    expect(identical(partition.meshImageLevels, first.meshImageLevels), isTrue);
    final textureOps = partition.ops.whereType<PocketTextureTriangleOp>();
    expect(
      textureOps.every((op) => op.asset.contains('Hiyori.2048/texture_')),
      isTrue,
      reason: 'The candidate span must contain only Hiyori texture triangles.',
    );
    hiyoriAssets.addAll(textureOps.map((op) => op.asset));
  }
  expect(hiyoriAssets, isNotEmpty);

  final effectiveDpr = dpr * span.sampleScale;
  final baselineDiagnosticPainters = <PocketCanvasPainter>[
    for (final partition in partitions)
      _copyPainterAtDpr(partition, effectiveDpr),
  ];
  final baselineLod = nameNovelMeshLodSelections(
    diagnoseNovelMeshLodBatches(baselineDiagnosticPainters),
  );
  final baselineBatches = _novelLodBatchRows(baselineLod);
  expect(baselineBatches, isNotEmpty);

  // The map is shared by all compatible batches for an asset within one
  // painter. Remove only the coarsest selected generated level for each
  // (production partition, asset) pair; any coarser levels are removed too.
  final coarsestSelectedWidths = <int, Map<String, int>>{};
  for (final batch in baselineBatches) {
    final selected = _novelLodDimensions(batch['selectedAggregate']);
    final source = _novelLodDimensions(batch['sourceDimensions']);
    if (selected == null || source == null) continue;
    final selectedWidth = selected['width']! as int;
    final sourceWidth = source['width']! as int;
    if (selectedWidth >= sourceWidth) continue;
    final painterIndex = batch['painterIndex']! as int;
    final asset = batch['asset']! as String;
    final widths = coarsestSelectedWidths.putIfAbsent(
      painterIndex,
      () => <String, int>{},
    );
    final existing = widths[asset];
    if (existing == null || selectedWidth < existing) {
      widths[asset] = selectedWidth;
    }
  }

  final removedLevelReports = <Map<String, Object?>>[];
  final candidatePartitions = <PocketCanvasPainter>[];
  for (
    var partitionIndex = 0;
    partitionIndex < partitions.length;
    partitionIndex++
  ) {
    final original = partitions[partitionIndex];
    final cutoffs = coarsestSelectedWidths[partitionIndex] ?? const {};
    final candidateLevels = <String, List<ui.Image>>{};
    for (final entry in original.meshImageLevels.entries) {
      final cutoff = cutoffs[entry.key];
      final removed = cutoff == null
          ? const <ui.Image>[]
          : entry.value.where((level) => level.width <= cutoff).toList();
      if (cutoff != null) {
        expect(
          removed.any((level) => level.width == cutoff),
          isTrue,
          reason:
              'The diagnosed coarsest selected level must exist in its painter map.',
        );
        removedLevelReports.add(<String, Object?>{
          'partitionIndex': partitionIndex,
          'asset': entry.key,
          'coarsestSelectedWidth': cutoff,
          'removedDimensions': <Map<String, int>>[
            for (final level in removed)
              <String, int>{'width': level.width, 'height': level.height},
          ],
        });
      }
      candidateLevels[entry.key] = List<ui.Image>.unmodifiable(
        entry.value.where((level) => cutoff == null || level.width > cutoff),
      );
    }
    final candidate = _copyPainterWithMeshImageLevels(
      original,
      Map<String, List<ui.Image>>.unmodifiable(candidateLevels),
    );
    expect(identical(candidate.ops, original.ops), isTrue);
    expect(identical(candidate.images, original.images), isTrue);
    expect(candidate.width, original.width);
    expect(candidate.height, original.height);
    expect(candidate.devicePixelRatio, original.devicePixelRatio);
    for (final op in original.ops.whereType<PocketTextureTriangleOp>()) {
      expect(
        identical(candidate.images[op.asset], original.images[op.asset]),
        isTrue,
      );
    }
    candidatePartitions.add(candidate);
  }

  final candidateDiagnosticPainters = <PocketCanvasPainter>[
    for (final partition in candidatePartitions)
      _copyPainterAtDpr(partition, effectiveDpr),
  ];
  final candidateLod = nameNovelMeshLodSelections(
    diagnoseNovelMeshLodBatches(candidateDiagnosticPainters),
  );
  final candidateBatches = _novelLodBatchRows(candidateLod);
  expect(candidateBatches, hasLength(baselineBatches.length));
  var promotedBatchCount = 0;
  var unchangedBatchCount = 0;
  final batchSelections = <Map<String, Object?>>[];
  for (var index = 0; index < baselineBatches.length; index++) {
    final before = baselineBatches[index];
    final after = candidateBatches[index];
    for (final key in const <String>[
      'painterIndex',
      'batchIndex',
      'asset',
      'drawOpCount',
      'triangleCount',
    ]) {
      expect(after[key], before[key], reason: 'Batch key $key changed.');
    }
    final beforeDimensions = _novelLodDimensions(before['selectedAggregate']);
    final afterDimensions = _novelLodDimensions(after['selectedAggregate']);
    int? promotionSteps;
    if (beforeDimensions != null && afterDimensions != null) {
      final beforeWidth = beforeDimensions['width']! as int;
      final afterWidth = afterDimensions['width']! as int;
      final beforeHeight = beforeDimensions['height']! as int;
      final afterHeight = afterDimensions['height']! as int;
      expect(afterWidth, greaterThanOrEqualTo(beforeWidth));
      expect(afterHeight, greaterThanOrEqualTo(beforeHeight));
      if (afterWidth > beforeWidth || afterHeight > beforeHeight) {
        expect(afterWidth, beforeWidth * 2);
        expect(afterHeight, beforeHeight * 2);
        promotedBatchCount++;
        promotionSteps = 1;
      } else {
        unchangedBatchCount++;
        promotionSteps = 0;
      }
    }
    batchSelections.add(<String, Object?>{
      'painterIndex': before['painterIndex'],
      'batchIndex': before['batchIndex'],
      'asset': before['asset'],
      'drawOpCount': before['drawOpCount'],
      'triangleCount': before['triangleCount'],
      'sourceDimensions': before['sourceDimensions'],
      'selectedBaseline': beforeDimensions,
      'selectedCandidate': afterDimensions,
      'promotionSteps': promotionSteps,
    });
  }

  final candidateSpan = PocketMeshSpanPainter(
    partitions: candidatePartitions,
    sampleScale: span.sampleScale,
  );
  final candidateSequence = <CustomPainter>[
    for (final painter in inventory.paintSequence)
      identical(painter, span) ? candidateSpan : painter,
  ];
  expect(candidateSequence, hasLength(inventory.paintSequence.length));
  var replacedSpanCount = 0;
  for (var index = 0; index < inventory.paintSequence.length; index++) {
    final original = inventory.paintSequence[index];
    if (identical(original, span)) {
      expect(identical(candidateSequence[index], candidateSpan), isTrue);
      replacedSpanCount++;
    } else {
      expect(identical(candidateSequence[index], original), isTrue);
    }
  }
  expect(replacedSpanCount, 1);
  expect(candidateSpan.sampleScale, span.sampleScale);
  final candidateSourcePartitions = <PocketCanvasPainter>[
    for (final painter in candidateSequence)
      if (painter is PocketCanvasPainter)
        painter
      else if (painter is PocketMeshSpanPainter)
        ...painter.partitions,
  ];
  final candidateInventory = NovelMeshPainterInventory(
    paintSequence: List<CustomPainter>.unmodifiable(candidateSequence),
    sourcePartitions: List<PocketCanvasPainter>.unmodifiable(
      candidateSourcePartitions,
    ),
    spanPainters:
        List<PocketMeshSpanPainter>.unmodifiable(<PocketMeshSpanPainter>[
          for (final painter in candidateSequence)
            if (painter is PocketMeshSpanPainter) painter,
        ]),
  );

  final outputWidth = (logicalSize.width * dpr).ceil();
  final outputHeight = (logicalSize.height * dpr).ceil();
  ui.Image? baseline;
  ui.Image? candidate;
  try {
    baseline = await _rasterPocketPainterSequence(
      tester,
      inventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: outputWidth,
      outputHeight: outputHeight,
      mode: _SpanReplayMode.activeGroupPainters,
    );
    final baselineCounters = _lastGroupReplayCounters;
    candidate = await _rasterPocketPainterSequence(
      tester,
      candidateInventory,
      logicalSize: logicalSize,
      dpr: dpr,
      outputWidth: outputWidth,
      outputHeight: outputHeight,
      mode: _SpanReplayMode.activeGroupPainters,
    );
    final candidateCounters = _lastGroupReplayCounters;
    final difference = await _compareSpanImages(tester, baseline, candidate);
    final outputs = <String, Object?>{
      'aggregateBaseline': await _writeSpanPng(
        tester,
        baseline,
        'model-mesh-coarsest-lod-baseline-$framing-$outputTag.png',
      ),
      'coarsestOnlyPromotion': await _writeSpanPng(
        tester,
        candidate,
        'model-mesh-coarsest-lod-candidate-$framing-$outputTag.png',
      ),
    };
    final guestFingerprint = await readNovelBundledGuestIdentity();
    final testSource = File('integration_test/novel_model_showcase_test.dart');
    final testSourceSha256 = await tester.runAsync<String?>(() async {
      try {
        if (!await testSource.exists()) return null;
        return pocketSha256(await testSource.readAsBytes());
      } on FileSystemException {
        return null;
      }
    });
    final helperSource = File(
      'integration_test/novel_mesh_span_diagnostics.dart',
    );
    final helperSourceSha256 = await tester.runAsync<String?>(() async {
      try {
        if (!await helperSource.exists()) return null;
        return pocketSha256(await helperSource.readAsBytes());
      } on FileSystemException {
        return null;
      }
    });
    final report = <String, Object?>{
      'framing': framing,
      'guest': guestFingerprint,
      'testSourcePath': testSource.path,
      'testSourceSha256': testSourceSha256,
      'helperSourcePath': helperSource.path,
      'helperSourceSha256': helperSourceSha256,
      'logicalSize': <double>[logicalSize.width, logicalSize.height],
      'devicePixelRatio': dpr,
      'effectiveSamplingDpr': effectiveDpr,
      'outputPixels': <int>[outputWidth, outputHeight],
      'sampleScale': span.sampleScale,
      'hiyoriSpanIndex': inventory.spanPainters.indexOf(span),
      'hiyoriPartitionCount': partitions.length,
      'hiyoriTextureAssets': hiyoriAssets.toList()..sort(),
      'baselineSelections': baselineBatches,
      'candidateSelections': candidateBatches,
      'batchSelectionComparisons': batchSelections,
      'coarsestSelectedLevelRemovedPerPartitionAsset': removedLevelReports,
      'promotedBatchCount': promotedBatchCount,
      'unchangedBatchCount': unchangedBatchCount,
      'drawBatchCountUnchanged': true,
      'sameDrawOpListsAndSourceImageObjects': true,
      'samePartitionOrderAndGroupPosition': true,
      'meshImageShaderFilterQuality': 'low in both arms',
      'spanCompositeFilterQuality': 'medium in both arms',
      'baselineGroupCounters': baselineCounters,
      'candidateGroupCounters': candidateCounters,
      'rawRgbaDifference': difference,
      'outputs': outputs,
      'candidateName': 'coarsest-only promotion',
      'limitations': <String>[
        'Only batches selecting their partition/asset coarsest generated level can promote; finer and source selections remain unchanged.',
        'This candidate guarantees at most one finer level, not exactly one finer level for every batch.',
        'RGBA counts are direct raster differences, not a sharpness or perceived-quality score.',
        'Offscreen replays are not window timing or physical Retina measurements.',
      ],
    };
    final reportPath =
        '${Directory.systemTemp.path}/model-mesh-coarsest-lod-$framing-$outputTag.json';
    await tester.runAsync(
      () => File(reportPath).writeAsString(jsonEncode(report)),
    );
    return <String, Object?>{'reportPath': reportPath, ...report};
  } finally {
    baseline?.dispose();
    candidate?.dispose();
  }
}

/// Captures one actual Hiyori span at its production SSAA sampling DPR, then
/// varies only the final filter applied to that exact snapshot image.
Future<Map<String, Object?>> captureNovelMeshSpanFilterAblation({
  required WidgetTester tester,
  required NovelMeshPainterInventory inventory,
  required String framing,
  required String outputTag,
}) async {
  final hiyoriSpans = inventory.spanPainters
      .where(
        (span) => span.partitions.any(
          (partition) => partition.ops.whereType<PocketTextureTriangleOp>().any(
            (op) => op.asset.contains('Hiyori.2048/texture_'),
          ),
        ),
      )
      .toList(growable: false);
  expect(
    hiyoriSpans,
    hasLength(1),
    reason: 'The filter ablation requires one actual Hiyori span.',
  );
  final span = hiyoriSpans.single;
  expect(span.sampleScale, 2);
  final partitions = span.partitions;
  expect(partitions, isNotEmpty);
  final first = partitions.first;
  final logicalSize = first.renderedSize ?? ui.Size(first.width, first.height);
  final dpr = first.devicePixelRatio;
  expect(dpr, greaterThan(0));
  expect(dpr.isFinite, isTrue);
  expect(dpr, tester.view.devicePixelRatio);
  for (final partition in partitions) {
    expect(partition.width, first.width);
    expect(partition.height, first.height);
    expect(partition.devicePixelRatio, dpr);
    expect(
      partition.renderedSize ?? ui.Size(partition.width, partition.height),
      logicalSize,
    );
    expect(identical(partition.images, first.images), isTrue);
    expect(identical(partition.meshImageLevels, first.meshImageLevels), isTrue);
    expect(
      partition.ops.whereType<PocketTextureTriangleOp>().every(
        (op) => op.asset.contains('Hiyori.2048/texture_'),
      ),
      isTrue,
      reason: 'This output must contain only the current Hiyori model span.',
    );
  }

  final bounds = _hiyoriBounds(partitions, logicalSize);
  expect(bounds, isNotNull);
  final outputWidth = (logicalSize.width * dpr).ceil();
  final outputHeight = (logicalSize.height * dpr).ceil();
  final sampleDpr = dpr * span.sampleScale;
  final sampleWidth = (logicalSize.width * sampleDpr).ceil();
  final sampleHeight = (logicalSize.height * sampleDpr).ceil();
  expect(
    sampleWidth * sampleHeight,
    lessThanOrEqualTo(2097152),
    reason: 'The diagnostic snapshot must stay within the span pixel budget.',
  );
  final sampledPartitions = <PocketCanvasPainter>[
    for (final partition in partitions) _copyPainterAtDpr(partition, sampleDpr),
  ];
  final lodReport = nameNovelMeshLodSelections(
    diagnoseNovelMeshLodBatches(sampledPartitions),
  );
  final guestFingerprint = await readNovelBundledGuestIdentity();
  final testSource = File('integration_test/novel_model_showcase_test.dart');
  final testSourceSha256 = await tester.runAsync<String?>(() async {
    try {
      if (!await testSource.exists()) return null;
      return pocketSha256(await testSource.readAsBytes());
    } on FileSystemException {
      return null;
    }
  });

  ui.Image? snapshot;
  ui.Image? directOneX;
  final filtered = <String, ui.Image>{};
  try {
    // Render the captured partitions exactly once at effective DPR × 2.
    snapshot = await _rasterPartitions(
      tester,
      sampledPartitions,
      dpr: sampleDpr,
      pixelWidth: sampleWidth,
      pixelHeight: sampleHeight,
    );
    final snapshotFile = await _writeSpanPng(
      tester,
      snapshot,
      'model-filter-snapshot-$framing-$outputTag.png',
    );

    for (final entry in const <(String, ui.FilterQuality)>[
      ('low', ui.FilterQuality.low),
      ('medium', ui.FilterQuality.medium),
      ('high', ui.FilterQuality.high),
    ]) {
      filtered[entry.$1] = await _downsampleSpanSnapshot(
        tester,
        snapshot,
        logicalSize: logicalSize,
        dpr: dpr,
        pixelWidth: outputWidth,
        pixelHeight: outputHeight,
        filterQuality: entry.$2,
      );
    }

    // This separate 1× result is the direct source-partition reference. Its
    // effective DPR and LOD selection intentionally differ from the 2× input.
    directOneX = await _rasterPartitions(
      tester,
      partitions,
      dpr: dpr,
      pixelWidth: outputWidth,
      pixelHeight: outputHeight,
    );

    final outputFiles = <String, Object?>{
      'snapshot2x': snapshotFile,
      for (final entry in filtered.entries)
        entry.key: <String, Object?>{
          ...await _writeSpanPng(
            tester,
            entry.value,
            'model-filter-${entry.key}-$framing-$outputTag.png',
          ),
          'filterQuality': entry.key,
          'snapshotPngFnv1a32': snapshotFile['pngFnv1a32'],
          'sameSnapshotImage': true,
        },
      'direct1xReference': await _writeSpanPng(
        tester,
        directOneX,
        'model-filter-direct-1x-$framing-$outputTag.png',
      ),
    };
    final report = <String, Object?>{
      'framing': framing,
      'guest': guestFingerprint,
      'testSourcePath': testSource.path,
      'testSourceSha256': testSourceSha256,
      'logicalSize': <double>[logicalSize.width, logicalSize.height],
      'devicePixelRatio': dpr,
      'effectiveSnapshotDpr': sampleDpr,
      'productionSampleScale': span.sampleScale,
      'outputPixels': <int>[outputWidth, outputHeight],
      'snapshotPixels': <int>[sampleWidth, sampleHeight],
      'snapshotRenderCount': 1,
      'sameSnapshotImageForLowMediumHigh': true,
      'sourcePartitionCount': partitions.length,
      'hiyoriTriangleOpCount': partitions.fold<int>(
        0,
        (count, painter) =>
            count +
            painter.ops.whereType<PocketTextureTriangleOp>().fold<int>(
              0,
              (sum, op) => sum + op.points.length ~/ 3,
            ),
      ),
      'modelBoundsLogical': <double>[
        bounds!.left,
        bounds.top,
        bounds.width,
        bounds.height,
      ],
      'twoXSnapshotLodSelection': lodReport,
      'outputs': outputFiles,
      'limitations': <String>[
        'The direct 1x reference uses its own DPR and LOD selection; it is not part of the fixed-snapshot filter comparison.',
        'Root can derive eye, hair, and clothing crops from modelBoundsLogical; this helper does not crop or enlarge them.',
        'PNG images are transparent painter replays, not a physical Retina capture or a quality score.',
        'The diagnostic uses a full-surface async picture snapshot; production uses a cropped toImageSync snapshot. This experiment isolates filters within the diagnostic and does not assert pixel identity to the production span.',
      ],
    };
    final reportPath =
        '${Directory.systemTemp.path}/model-filter-$framing-$outputTag.json';
    await tester.runAsync(
      () => File(reportPath).writeAsString(jsonEncode(report)),
    );
    return <String, Object?>{'reportPath': reportPath, ...report};
  } finally {
    snapshot?.dispose();
    directOneX?.dispose();
    for (final image in filtered.values) {
      image.dispose();
    }
  }
}

PocketCanvasPainter _copyPainterAtDpr(PocketCanvasPainter source, double dpr) =>
    PocketCanvasPainter(
      width: source.width,
      height: source.height,
      ops: source.ops,
      images: source.images,
      meshImageLevels: source.meshImageLevels,
      renderedSize: source.renderedSize,
      devicePixelRatio: dpr,
      fontFamilyFallback: source.fontFamilyFallback,
      textLayoutCache: source.textLayoutCache,
    );

Future<ui.Image> _rasterPartitions(
  WidgetTester tester,
  List<PocketCanvasPainter> partitions, {
  required double dpr,
  required int pixelWidth,
  required int pixelHeight,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder)..scale(dpr);
  for (final painter in partitions) {
    painter.paint(
      canvas,
      painter.renderedSize ?? ui.Size(painter.width, painter.height),
    );
  }
  final picture = recorder.endRecording();
  try {
    return (await tester.runAsync<ui.Image>(
      () => picture.toImage(pixelWidth, pixelHeight),
    ))!;
  } finally {
    picture.dispose();
  }
}

Future<ui.Image> _downsampleSpanSnapshot(
  WidgetTester tester,
  ui.Image snapshot, {
  required ui.Size logicalSize,
  required double dpr,
  required int pixelWidth,
  required int pixelHeight,
  required ui.FilterQuality filterQuality,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder)..scale(dpr);
  canvas.drawImageRect(
    snapshot,
    ui.Rect.fromLTWH(
      0,
      0,
      snapshot.width.toDouble(),
      snapshot.height.toDouble(),
    ),
    ui.Rect.fromLTWH(0, 0, logicalSize.width, logicalSize.height),
    ui.Paint()..filterQuality = filterQuality,
  );
  final picture = recorder.endRecording();
  try {
    return (await tester.runAsync<ui.Image>(
      () => picture.toImage(pixelWidth, pixelHeight),
    ))!;
  } finally {
    picture.dispose();
  }
}

Future<Map<String, Object?>> readNovelBundledGuestIdentity() async {
  final qjbcData = await rootBundle.load('assets/apps/lantern/app.qjbc');
  final pakData = await rootBundle.load('assets/apps/lantern/app.pak');
  final metadataData = await rootBundle.load(
    'assets/apps/lantern/app.bytecode.json',
  );
  final qjbc = qjbcData.buffer.asUint8List(
    qjbcData.offsetInBytes,
    qjbcData.lengthInBytes,
  );
  final pak = pakData.buffer.asUint8List(
    pakData.offsetInBytes,
    pakData.lengthInBytes,
  );
  final metadataBytes = metadataData.buffer.asUint8List(
    metadataData.offsetInBytes,
    metadataData.lengthInBytes,
  );
  final metadata = jsonDecode(utf8.decode(metadataBytes)) as Map;
  expect(qjbc.length, metadata['bytecodeBytes']);
  expect(
    pocketSha256(qjbc.sublist(metadata['headerBytes'] as int)),
    metadata['payloadSha256'],
  );
  return <String, Object?>{
    'qjbcBytes': qjbc.length,
    'qjbcSha256': pocketSha256(qjbc),
    'pakBytes': pak.length,
    'pakSha256': pocketSha256(pak),
    'metadataSha256': pocketSha256(metadataBytes),
    'sourceSha256': metadata['sourceSha256'],
    'payloadSha256': metadata['payloadSha256'],
  };
}

ui.Rect? _hiyoriBounds(
  List<PocketCanvasPainter> partitions,
  ui.Size logicalSize,
) {
  var left = double.infinity;
  var top = double.infinity;
  var right = double.negativeInfinity;
  var bottom = double.negativeInfinity;
  final first = partitions.first;
  final sx = logicalSize.width / first.width;
  final sy = logicalSize.height / first.height;
  for (final partition in partitions) {
    for (final op in partition.ops.whereType<PocketTextureTriangleOp>()) {
      if (!op.asset.contains('Hiyori.2048/texture_')) continue;
      for (final point in op.points) {
        left = math.min(left, point.x * sx);
        top = math.min(top, point.y * sy);
        right = math.max(right, point.x * sx);
        bottom = math.max(bottom, point.y * sy);
      }
    }
  }
  if (!left.isFinite || !top.isFinite || !right.isFinite || !bottom.isFinite) {
    return null;
  }
  return ui.Rect.fromLTRB(
    left,
    top,
    right,
    bottom,
  ).intersect(ui.Rect.fromLTWH(0, 0, logicalSize.width, logicalSize.height));
}

Map<String, Object?>? _lastGroupReplayCounters;

enum _SpanReplayMode {
  expandedPartitions,
  groupPainterAtOne,
  activeGroupPainters,
  hiyoriMeshLevelsUnavailable,
}

bool _spanContainsHiyoriTexture(PocketMeshSpanPainter span) =>
    span.partitions.any(
      (partition) => partition.ops.whereType<PocketTextureTriangleOp>().any(
        (op) => op.asset.contains('Hiyori.2048/texture_'),
      ),
    );

PocketCanvasPainter _copyPainterWithoutMeshImageLevels(
  PocketCanvasPainter source,
) => _copyPainterWithMeshImageLevels(source, const <String, List<ui.Image>>{});

PocketCanvasPainter _copyPainterWithMeshImageLevels(
  PocketCanvasPainter source,
  Map<String, List<ui.Image>> meshImageLevels,
) => PocketCanvasPainter(
  width: source.width,
  height: source.height,
  ops: source.ops,
  images: source.images,
  meshImageLevels: meshImageLevels,
  renderedSize: source.renderedSize,
  devicePixelRatio: source.devicePixelRatio,
  fontFamilyFallback: source.fontFamilyFallback,
  textLayoutCache: source.textLayoutCache,
);

List<Map<String, Object?>> _novelLodBatchRows(Map<String, Object?> report) {
  final raw = report['batches'];
  if (raw is! List) {
    throw StateError('LOD diagnostic has no batches list.');
  }
  return <Map<String, Object?>>[
    for (final value in raw)
      if (value is Map)
        <String, Object?>{
          for (final entry in value.entries) entry.key.toString(): entry.value,
        },
  ];
}

Map<String, Object?>? _novelLodDimensions(Object? value) {
  if (value is! Map) return null;
  final width = value['width'];
  final height = value['height'];
  if (width is! int || height is! int) return null;
  return <String, Object?>{
    'width': width,
    'height': height,
    if (value['sourceWidthDivisor'] is num)
      'sourceWidthDivisor': value['sourceWidthDivisor'],
  };
}

Future<ui.Image> _rasterPocketPainterSequence(
  WidgetTester tester,
  NovelMeshPainterInventory inventory, {
  required ui.Size logicalSize,
  required double dpr,
  required int outputWidth,
  required int outputHeight,
  required _SpanReplayMode mode,
}) async {
  if (mode == _SpanReplayMode.activeGroupPainters ||
      mode == _SpanReplayMode.hiyoriMeshLevelsUnavailable) {
    resetNovelMeshSpanDiagnostics();
  }
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder)..scale(dpr);
  final perSpanCounters = <Map<String, Object?>>[];
  var hiyoriReplacementCount = 0;
  for (
    var sequenceIndex = 0;
    sequenceIndex < inventory.paintSequence.length;
    sequenceIndex++
  ) {
    final painter = inventory.paintSequence[sequenceIndex];
    if (painter is PocketCanvasPainter) {
      painter.paint(
        canvas,
        painter.renderedSize ?? ui.Size(painter.width, painter.height),
      );
      continue;
    }
    if (painter is! PocketMeshSpanPainter) continue;
    final size = painter.partitions.isEmpty
        ? logicalSize
        : painter.partitions.first.renderedSize ??
              ui.Size(
                painter.partitions.first.width,
                painter.partitions.first.height,
              );
    switch (mode) {
      case _SpanReplayMode.expandedPartitions:
        for (final partition in painter.partitions) {
          partition.paint(
            canvas,
            partition.renderedSize ??
                ui.Size(partition.width, partition.height),
          );
        }
      case _SpanReplayMode.groupPainterAtOne:
        PocketMeshSpanPainter(
          partitions: painter.partitions,
          sampleScale: 1,
        ).paint(canvas, size);
      case _SpanReplayMode.activeGroupPainters:
        final before = snapshotNovelMeshSpanDiagnostics();
        painter.paint(canvas, size);
        final after = snapshotNovelMeshSpanDiagnostics();
        perSpanCounters.add(<String, Object?>{
          'painterSequenceIndex': sequenceIndex,
          'partitionCount': painter.partitions.length,
          'sampleScale': painter.sampleScale,
          'hiyoriLevelsSuppressed': false,
          'counterDelta': _counterDifference(before, after),
        });
      case _SpanReplayMode.hiyoriMeshLevelsUnavailable:
        final suppressLevels = _spanContainsHiyoriTexture(painter);
        late final PocketMeshSpanPainter replayPainter;
        if (suppressLevels) {
          final candidatePartitions = painter.partitions
              .map(_copyPainterWithoutMeshImageLevels)
              .toList(growable: false);
          expect(candidatePartitions, hasLength(painter.partitions.length));
          for (var index = 0; index < painter.partitions.length; index++) {
            final original = painter.partitions[index];
            final candidate = candidatePartitions[index];
            expect(identical(candidate.ops, original.ops), isTrue);
            expect(identical(candidate.images, original.images), isTrue);
            expect(candidate.meshImageLevels, isEmpty);
            for (final op
                in original.ops.whereType<PocketTextureTriangleOp>()) {
              expect(
                identical(
                  candidate.images[op.asset],
                  original.images[op.asset],
                ),
                isTrue,
              );
            }
          }
          replayPainter = PocketMeshSpanPainter(
            partitions: candidatePartitions,
            sampleScale: painter.sampleScale,
          );
        } else {
          replayPainter = painter;
        }
        if (suppressLevels) hiyoriReplacementCount++;
        final before = snapshotNovelMeshSpanDiagnostics();
        replayPainter.paint(canvas, size);
        final after = snapshotNovelMeshSpanDiagnostics();
        perSpanCounters.add(<String, Object?>{
          'painterSequenceIndex': sequenceIndex,
          'partitionCount': painter.partitions.length,
          'sampleScale': painter.sampleScale,
          'hiyoriLevelsSuppressed': suppressLevels,
          'counterDelta': _counterDifference(before, after),
        });
    }
  }
  if (mode == _SpanReplayMode.activeGroupPainters ||
      mode == _SpanReplayMode.hiyoriMeshLevelsUnavailable) {
    if (mode == _SpanReplayMode.hiyoriMeshLevelsUnavailable) {
      expect(
        hiyoriReplacementCount,
        1,
        reason: 'Only the one captured Hiyori span should lose mesh levels.',
      );
    }
    // Snapshot static counters immediately after the synchronous group paints,
    // before Picture.toImage or byte conversion yields to the ticker.
    _lastGroupReplayCounters = <String, Object?>{
      ...snapshotNovelMeshSpanDiagnostics(),
      'perSpan': perSpanCounters,
      'hiyoriSpanReplacementCount': hiyoriReplacementCount,
      'scope': 'diagnostic offscreen replay; exclude from real window counts',
    };
  }
  final picture = recorder.endRecording();
  try {
    return (await tester.runAsync<ui.Image>(
      () => picture.toImage(outputWidth, outputHeight),
    ))!;
  } finally {
    picture.dispose();
  }
}

Map<String, Object?> _counterDifference(
  Map<String, Object?> before,
  Map<String, Object?> after,
) => <String, Object?>{
  for (final key in const <String>[
    'spanPaintCount',
    'snapshotCount',
    'disposedSnapshotCount',
    'snapshottedPixelCount',
    'budgetBypassCount',
    'ineligibleBypassCount',
    'snapshotFailureBypassCount',
  ])
    key: (after[key]! as int) - (before[key]! as int),
};

Future<Map<String, Object?>> _compareSpanImages(
  WidgetTester tester,
  ui.Image first,
  ui.Image second,
) async {
  if (first.width != second.width || first.height != second.height) {
    throw StateError('Painter replay image dimensions differ.');
  }
  final firstRgba = await _spanRgba(tester, first);
  final secondRgba = await _spanRgba(tester, second);
  var differingPixels = 0;
  var maximumChannelDelta = 0;
  var totalAbsoluteChannelDelta = 0;
  for (var offset = 0; offset < firstRgba.length; offset += 4) {
    var pixelChanged = false;
    for (var channel = 0; channel < 4; channel++) {
      final delta = (firstRgba[offset + channel] - secondRgba[offset + channel])
          .abs();
      if (delta > 0) pixelChanged = true;
      if (delta > maximumChannelDelta) maximumChannelDelta = delta;
      totalAbsoluteChannelDelta += delta;
    }
    if (pixelChanged) differingPixels++;
  }
  return <String, Object?>{
    'width': first.width,
    'height': first.height,
    'differingPixelCount': differingPixels,
    'maxChannelDelta': maximumChannelDelta,
    'sumAbsoluteChannelDelta': totalAbsoluteChannelDelta,
    'firstRgbaFnv1a32': _spanFnv1a32(firstRgba),
    'secondRgbaFnv1a32': _spanFnv1a32(secondRgba),
  };
}

Future<Uint8List> _spanRgba(WidgetTester tester, ui.Image image) async {
  final data = (await tester.runAsync<ByteData?>(
    () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
  ))!;
  return Uint8List.fromList(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
  );
}

Future<Map<String, Object?>> _writeSpanPng(
  WidgetTester tester,
  ui.Image image,
  String filename,
) async {
  final data = (await tester.runAsync<ByteData?>(
    () => image.toByteData(format: ui.ImageByteFormat.png),
  ))!;
  final bytes = Uint8List.fromList(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
  );
  final path = '${Directory.systemTemp.path}/$filename';
  await tester.runAsync(() => File(path).writeAsBytes(bytes));
  return <String, Object?>{
    'path': path,
    'width': image.width,
    'height': image.height,
    'bytes': bytes.length,
    'pngFnv1a32': _spanFnv1a32(bytes),
  };
}

String _spanFnv1a32(List<int> bytes) {
  var hash = 0x811c9dc5;
  for (final byte in bytes) {
    hash = ((hash ^ byte) * 0x01000193) & 0xffffffff;
  }
  return hash.toRadixString(16).padLeft(8, '0');
}
