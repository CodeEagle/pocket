import 'dart:convert' show jsonEncode;
import 'dart:io' show Platform;
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];

  test(
    'PocketHostFontMetrics pre-warms all 21 slots, includes Linux mono fallback, and shapes grapheme clusters',
    () {
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

      // Mono slots include DejaVu Sans Mono in default fallback chain.
      final monoStyle = pocketTextStyleForSlot(slot: 16, fontSize: 12);
      expect(monoStyle.fontFamilyFallback, contains('DejaVu Sans Mono'));

      // Slot 6 (36px) must be strictly wider than Slot 0 (12px).
      final slot0M = metrics.asciiAdvances['M'.codeUnitAt(0) - 0x20];
      final slot6M =
          metrics.asciiAdvances[6 * pocketHostAsciiCount + ('M'.codeUnitAt(0) - 0x20)];
      expect(slot6M, greaterThan(slot0M));

      // Shaped UTF-8 run measurer handles ZWJ emoji & combining marks seamlessly
      // without summing standalone ZWJ or combining accent widths.
      final baseE = measurePocketHostTextRunString(2, 'e');
      final combiningE = measurePocketHostTextRunString(2, 'e\u0301');
      final separateMark = measurePocketHostTextRunString(2, '\u0301');
      expect(baseE, greaterThan(0));
      expect(combiningE, greaterThan(0));
      if (separateMark > 0) {
        expect(combiningE, lessThanOrEqualTo(baseE + separateMark + 0.01));
      }

      final zwjFamily = measurePocketHostTextRunString(
        4,
        '👨\u200d👩\u200d👧\u200d👦',
      );
      final fourAdults =
          measurePocketHostTextRunString(4, '👨') +
          measurePocketHostTextRunString(4, '👩') +
          measurePocketHostTextRunString(4, '👧') +
          measurePocketHostTextRunString(4, '👦');
      expect(zwjFamily, greaterThan(0));
      expect(zwjFamily, lessThanOrEqualTo(fourAdults + 0.01));

      expect(measurePocketHostScalarAdvance(2, '★'.runes.first), greaterThan(0));
      expect(measurePocketHostScalarAdvance(-1, 0x41), -1.0);
      expect(measurePocketHostScalarAdvance(99, 0x41), -1.0);
      expect(measurePocketHostScalarAdvance(2, 0xd800), -1.0);
      expect(measurePocketHostScalarAdvance(2, 0x0a), 0.0);

      // Same fallback stack hits the bounded cache.
      expect(identical(PocketHostFontMetrics.forFallback(), metrics), isTrue);
    },
  );

  test('PocketBytecodeMetadata validates optional fonts delivery field', () {
    Map<String, Object?> baseMeta([Object? fonts]) => <String, Object?>{
      'entryFormat': 'quickjs-bytecode',
      'formatVersion': 1,
      'kind': 'script',
      'bindingGeneration': 1,
      'tickHz': 60,
      'runtimeAbi': 'qjs-test',
      'bytecodeBytes': 16,
      if (fonts != null) 'fonts': fonts,
    };

    expect(
      PocketBytecodeMetadata.fromJsonString(jsonEncode(baseMeta())).fonts,
      isNull,
    );
    expect(
      PocketBytecodeMetadata.fromJsonString(jsonEncode(baseMeta('host'))).fonts,
      'host',
    );
    expect(
      PocketBytecodeMetadata.fromJsonString(
        jsonEncode(baseMeta('baked')),
      ).fonts,
      'baked',
    );
    expect(
      () => PocketBytecodeMetadata.fromJsonString(
        jsonEncode(baseMeta('invalid')),
      ),
      throwsA(isA<PocketRuntimeException>()),
    );
  });

  test(
    'FfiPocketRuntime syncs host fonts, shapes grapheme clusters, and emits PFB1 v6 vector TEXT_RUN',
    () {
      final runtime = FfiPocketRuntime.open(width: 360, height: 240);
      addTearDown(runtime.dispose);

      expect(runtime.hasHostFonts, isFalse);
      expect(syncPocketHostFonts(runtime), isTrue);
      expect(runtime.hasHostFonts, isTrue);

      final expectedZwj = measurePocketHostTextRunString(
        4,
        '👨\u200d👩\u200d👧\u200d👦',
      );
      final frame = runtime.eval('''
        if (ui.__hostFonts !== true) {
          throw new Error('expected ui.__hostFonts === true');
        }
        const zwjWidth = ui.measureText('👨\\u200d👩\\u200d👧\\u200d👦', 4);
        if (Math.abs(zwjWidth - $expectedZwj) > 1e-2) {
          throw new Error('expected shaped ZWJ width $expectedZwj, got ' + zwjWidth);
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

    final hitX = 100 + 60 * c - 12 * s;
    final hitY = 50 + 60 * s + 12 * c;
    expect(painter.hitTest(Offset(hitX, hitY)), isTrue);
    expect(painter.hitTest(const Offset(210, 60)), isFalse);
  });

  test(
    'Recording mode captures host font snapshot and hostTextAdvance scalars for deterministic replay',
    () async {
      final controller = PocketRecordingController();
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 180,
        recording: controller,
      );
      expect(syncPocketHostFonts(runtime), isTrue);

      // Build a minimal valid font-less DCPK header (0 entries) to verify
      // font-less packages record and replay deterministically!
      final fontlessPak = Uint8List(32);
      final pakView = ByteData.sublistView(fontlessPak);
      pakView.setUint32(0, 0x4b504344, Endian.little);
      pakView.setUint16(4, 1, Endian.little);
      pakView.setUint32(8, 0, Endian.little);
      pakView.setUint32(12, 32, Endian.little);
      pakView.setUint32(16, 32, Endian.little);
      pakView.setUint32(20, 32, Endian.little);
      pakView.setUint32(24, 32, Endian.little);

      const source = '''
        const n = ui.createNode(1);
        ui.setProp(n, 97, 2);
        ui.setProp(n, 96, 0xffffffff);
        ui.setProp(n, 100, 1.5);
        ui.setText(n, "Deterministic 宿主字体 👨\\u200d👩\\u200d👧\\u200d👦");
        ui.insertBefore(1, n, 0);
        globalThis.frame = () => {};
      ''';
      runtime.load(source, fontlessPak);
      runtime.frameAt(16.0);
      runtime.dispose();

      final serialized = jsonEncode(controller.recording!.toJson());
      final recording = PocketRecording.fromJsonString(serialized);
      expect(recording.metadata.hostFonts, isNotNull);
      final replay = await replayPocketRecording(
        recording,
        assets: PocketReplayAssets(source: source, pak: fontlessPak),
      );
      expect(replay.matched, isTrue, reason: replay.firstMismatch?.reason);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  testWidgets(
    'PocketView invalidates host font caches on systemFonts notification and controller.refreshHostFonts()',
    (WidgetTester tester) async {
      final controller = PocketViewController();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 240,
              height: 160,
              child: PocketView(
                controller: controller,
                jsSource: '''
                  const n = ui.createNode(1);
                  ui.setProp(n, 97, 2);
                  ui.setProp(n, 96, 0xffffffff);
                  ui.setText(n, "Dynamic Font Refresh");
                  ui.insertBefore(1, n, 0);
                  globalThis.frame = () => {};
                ''',
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 32));

      final initialMetrics = PocketHostFontMetrics.forFallback();
      expect(
        identical(PocketHostFontMetrics.forFallback(), initialMetrics),
        isTrue,
      );

      // Simulate runtime dynamic font load notification via PaintingBinding.systemFonts.
      await PaintingBinding.instance.handleSystemMessage(<String, dynamic>{
        'type': 'fontsChange',
      });
      await tester.pump();

      final refreshedMetrics = PocketHostFontMetrics.forFallback();
      expect(identical(refreshedMetrics, initialMetrics), isFalse);

      // Explicit controller.refreshHostFonts() also clears and re-warms metrics.
      expect(controller.refreshHostFonts(), isTrue);
    },
    skip: libraryPath == null,
  );

  test(
    'FfiPocketRuntime rejects font-less PAK until syncPocketHostFonts installs host metrics',
    () {
      final runtime = FfiPocketRuntime.open(width: 200, height: 120);
      addTearDown(runtime.dispose);
      final fontlessPak = Uint8List(32);
      final pakView = ByteData.sublistView(fontlessPak);
      pakView.setUint32(0, 0x4b504344, Endian.little);
      pakView.setUint16(4, 1, Endian.little);
      pakView.setUint32(12, 32, Endian.little);
      pakView.setUint32(16, 32, Endian.little);
      pakView.setUint32(20, 32, Endian.little);
      pakView.setUint32(24, 32, Endian.little);

      expect(
        () => runtime.load('globalThis.frame = () => {};', fontlessPak),
        throwsA(
          isA<PocketRuntimeException>().having(
            (e) => e.message,
            'message',
            contains('no baked ui:font.* atlases'),
          ),
        ),
      );

      expect(syncPocketHostFonts(runtime), isTrue);
      final frame = runtime.load('globalThis.frame = () => {};', fontlessPak);
      expect(frame.width, 200);
    },
    skip: libraryPath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );
}
