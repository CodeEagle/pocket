import 'dart:io' show Platform;
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];

  test('PocketHostFontMetrics pre-warms all 21 slots and measures lazy scalars', () {
    PocketHostFontMetrics.clearCache();
    final metrics = PocketHostFontMetrics.forFallback();
    expect(metrics.lineHeights.length, pocketHostFontSlotCount);
    expect(metrics.cjkAdvances.length, pocketHostFontSlotCount);
    expect(
      metrics.asciiAdvances.length,
      pocketHostFontSlotCount * pocketHostAsciiCount,
    );

    for (var slot = 0; slot < pocketHostFontSlotCount; slot++) {
      expect(metrics.lineHeights[slot], greaterThan(0));
      expect(metrics.cjkAdvances[slot], greaterThan(0));
      final mIndex = slot * pocketHostAsciiCount + ('M'.codeUnitAt(0) - 0x20);
      expect(metrics.asciiAdvances[mIndex], greaterThan(0));
    }

    // Slot 6 (36px) must be strictly wider than Slot 0 (12px).
    final slot0M = metrics.asciiAdvances['M'.codeUnitAt(0) - 0x20];
    final slot6M =
        metrics.asciiAdvances[6 * pocketHostAsciiCount + ('M'.codeUnitAt(0) - 0x20)];
    expect(slot6M, greaterThan(slot0M));

    // Lazy scalar callback returns positive width for non-ASCII symbols and
    // rejects out-of-range slots or UTF-16 surrogates.
    expect(measurePocketHostScalarAdvance(2, '★'.runes.first), greaterThan(0));
    expect(measurePocketHostScalarAdvance(2, 'é'.runes.first), greaterThan(0));
    expect(measurePocketHostScalarAdvance(-1, 0x41), -1.0);
    expect(measurePocketHostScalarAdvance(99, 0x41), -1.0);
    expect(measurePocketHostScalarAdvance(2, 0xd800), -1.0);
    expect(measurePocketHostScalarAdvance(2, 0x0a), 0.0);

    // Same fallback stack hits the bounded cache.
    expect(identical(PocketHostFontMetrics.forFallback(), metrics), isTrue);
  });

  test(
    'FfiPocketRuntime syncs host fonts and emits PFB1 v6 vector TEXT_RUN for tracking and transforms',
    () {
      final runtime = FfiPocketRuntime.open(width: 360, height: 240);
      addTearDown(runtime.dispose);

      expect(syncPocketHostFonts(runtime), isTrue);

      final frame = runtime.eval('''
        if (ui.__hostFonts !== true) {
          throw new Error('expected ui.__hostFonts === true');
        }
        const measuredStar = ui.measureText('★', 4);
        if (!(measuredStar > 0)) {
          throw new Error('expected positive lazy host measure for ★');
        }

        const tracked = ui.createNode(1);
        ui.setProp(tracked, 24, 1); // absolute
        ui.setProp(tracked, 28, 12); // left
        ui.setProp(tracked, 25, 16); // top
        ui.setProp(tracked, 97, 4); // FONT_SLOT = 4 (20px)
        ui.setProp(tracked, 96, 0xff22aaee); // TEXT_COLOR
        ui.setProp(tracked, 100, 3.5); // TRACKING
        ui.setText(tracked, 'Host 宿主 ★ 123');
        ui.insertBefore(1, tracked, 0);

        const rotated = ui.createNode(1);
        ui.setProp(rotated, 24, 1); // absolute
        ui.setProp(rotated, 28, 60); // left
        ui.setProp(rotated, 25, 80); // top
        ui.setProp(rotated, 97, 3); // FONT_SLOT = 3 (18px)
        ui.setProp(rotated, 96, 0xffee5522); // TEXT_COLOR
        ui.setProp(rotated, 100, 1.5); // TRACKING
        ui.setProp(rotated, 131, 30); // ROTATE (deg)
        ui.setText(rotated, 'Rotated 旋转矢量');
        ui.insertBefore(1, rotated, 0);

        globalThis.frame = () => {};
      ''');

      final textOps = frame.ops.whereType<PocketTextOp>().toList();
      expect(textOps.length, 2);
      // Transformed and tracked text must NOT fall back to software GLYPH_RUN
      // texture quads when host fonts are synchronized.
      expect(frame.ops.whereType<PocketImageOp>(), isEmpty);
      expect(frame.ops.whereType<PocketTextureTriangleOp>(), isEmpty);
      expect(frame.resources, isEmpty);

      final trackedOp = textOps.firstWhere((op) => op.text.contains('★'));
      expect(trackedOp.tracking, closeTo(3.5, 1e-4));
      expect(trackedOp.affine, isNull);
      expect(trackedOp.width, greaterThan(60));

      final rotatedOp = textOps.firstWhere((op) => op.text.contains('Rotated'));
      expect(rotatedOp.tracking, closeTo(1.5, 1e-4));
      expect(rotatedOp.affine, isNotNull);
      expect(rotatedOp.affine!.length, 4);
      final cos30 = math.cos(30 * math.pi / 180.0);
      final sin30 = math.sin(30 * math.pi / 180.0);
      expect(rotatedOp.affine![0], closeTo(cos30, 1e-3));
      expect(rotatedOp.affine![1], closeTo(sin30, 1e-3));
      expect(rotatedOp.affine![2], closeTo(-sin30, 1e-3));
      expect(rotatedOp.affine![3], closeTo(cos30, 1e-3));
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test('PocketCanvasPainter paints and hit-tests rotated + tracked PocketTextOp', () {
    final angle = 45 * math.pi / 180.0;
    final c = math.cos(angle);
    final s = math.sin(angle);
    final rotatedText = PocketTextOp(
      x: 100,
      y: 50,
      width: 120,
      height: 24,
      text: 'Vector Text 矢量',
      size: 18,
      color: 0xffff3366,
      fontSlot: 3,
      align: 1,
      tracking: 2.0,
      affine: <double>[c, s, -s, c],
    );
    final cache = PocketTextLayoutCache();
    addTearDown(cache.dispose);

    final painter = PocketCanvasPainter(
      width: 300,
      height: 300,
      ops: <PocketOp>[rotatedText],
      images: const <String, ui.Image>{},
      textLayoutCache: cache,
    );

    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    painter.paint(canvas, const Size(300, 300));
    final picture = recorder.endRecording();
    addTearDown(picture.dispose);

    // Local point (60, 12) rotated by +45 deg around (100, 50):
    final hitX = 100 + 60 * c - 12 * s;
    final hitY = 50 + 60 * s + 12 * c;
    expect(painter.hitTest(Offset(hitX, hitY)), isTrue);
    // Unrotated AABB point (210, 60) lies outside the +45 deg rotated box:
    expect(painter.hitTest(const Offset(210, 60)), isFalse);
  });

  test(
    'Recording mode skips host OS font metrics to preserve deterministic replay',
    () async {
      final controller = PocketRecordingController();
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 180,
        recording: controller,
      );
      expect(syncPocketHostFonts(runtime), isFalse);
      const source = '''
        const n = ui.createNode(1);
        ui.setProp(n, 97, 2);
        ui.setProp(n, 96, 0xffffffff);
        ui.setText(n, "Deterministic Replay");
        ui.insertBefore(1, n, 0);
        globalThis.frame = () => {};
      ''';
      runtime.eval(source);
      runtime.frameAt(16.0);
      runtime.dispose();

      final recording = controller.recording!;
      final replay = await replayPocketRecording(
        recording,
        assets: PocketReplayAssets(source: source),
      );
      expect(replay.matched, isTrue, reason: replay.firstMismatch?.reason);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
