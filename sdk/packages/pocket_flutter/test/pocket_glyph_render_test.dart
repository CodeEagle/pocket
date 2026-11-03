import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _GlyphRuntime implements PocketRuntime, PocketRuntimeScheduling {
  _GlyphRuntime(this.frameResult);

  final PocketFrame frameResult;

  @override
  double get nextWakeDelayMilliseconds => -1;

  @override
  PocketFrame eval(String source) => frameResult;

  @override
  PocketFrame load(String source, Uint8List pak) => frameResult;

  @override
  PocketFrame frame(int deltaMilliseconds) => frameResult;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'T8 glyph pages paint UV cells with tint, coverage, and clip',
    (tester) async {
      final resource = _t8CoverageResource();
      final frame = PocketFrame(
        width: 32,
        height: 16,
        ops: <PocketOp>[
          const PocketRectOp(
            x: 0,
            y: 0,
            width: 32,
            height: 16,
            color: 0xff102040,
          ),
          const PocketImageOp(
            x: 4,
            y: 4,
            width: 4,
            height: 4,
            asset: 'glyph-page-0',
            uv: <double>[0, 0, 0.5, 1],
            tint: 0x80ff0000,
            clip: PocketClip(x: 4, y: 4, width: 4, height: 2),
          ),
          const PocketImageOp(
            x: 12,
            y: 4,
            width: 4,
            height: 4,
            asset: 'glyph-page-0',
            uv: <double>[0.5, 0, 1, 1],
            tint: 0xff00ff00,
            clip: PocketClip(x: 12, y: 4, width: 4, height: 4),
          ),
        ],
        events: const <PocketEvent>[],
        resources: <PocketImageResource>[resource],
      );
      final runtime = _GlyphRuntime(frame);
      final boundaryKey = GlobalKey();
      final t8Page = PocketPakImages.fromResource(resource);
      expect(t8Page, isNotNull);
      expect(t8Page!.rgba[3], 255);
      expect(t8Page.rgba[7], 255);
      expect(t8Page.rgba[(8 * 4) + 3], 128);
      final pageImage = await tester.runAsync(
        () async => await t8Page.decode(),
      );
      expect(pageImage, isNotNull);
      var decodeCount = 0;
      PocketImageResource? decodedResource;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 32,
                height: 16,
                child: RepaintBoundary(
                  key: boundaryKey,
                  child: PocketView(
                    runtime: runtime,
                    viewport: const Size(32, 16),
                    jsSource: '',
                    pakBytes: Uint8List(0),
                    showDebugFps: false,
                    imageResourceDecoder: (imageResource) {
                      decodeCount++;
                      decodedResource = imageResource;
                      return Future<ui.Image>.value(pageImage!);
                    },
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(find.byType(TextField), findsNothing);
      expect(
        frame.resources,
        hasLength(1),
        reason: 'both glyph cells share one page',
      );
      expect(resource.psm, 5, reason: 'native glyph pages use PSM_T8');
      expect((resource.width, resource.height), (16, 8));
      final imageOps = frame.ops.whereType<PocketImageOp>().toList();
      expect(imageOps, hasLength(2));
      expect(
        imageOps.map((op) => (op.width, op.height)),
        <(double, double)>[(4, 4), (4, 4)],
        reason: '2x raster coverage keeps the logical glyph cell size',
      );
      expect(imageOps[0].uv, <double>[0, 0, 0.5, 1]);
      expect(imageOps[1].uv, <double>[0.5, 0, 1, 1]);

      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(boundaryKey),
      );
      expect(boundary.size, const Size(32, 16));
      expect(decodeCount, 1, reason: 'two UV cells reuse one decoded page');
      expect(decodedResource, same(resource));
      final screenshot = await tester.runAsync(
        () async => await boundary.toImage(pixelRatio: 1),
      );
      expect(screenshot, isNotNull);
      final byteData = await tester.runAsync(
        () async =>
            await screenshot!.toByteData(format: ui.ImageByteFormat.rawRgba),
      );
      final rgba = byteData?.buffer.asUint8List();
      List<int> pixelAt(int x, int y) {
        final offset = (y * screenshot!.width + x) * 4;
        return rgba!.sublist(offset, offset + 4);
      }

      final pixels = rgba == null
          ? null
          : <List<int>>[
              pixelAt(5, 5),
              pixelAt(13, 5),
              pixelAt(5, 7),
              pixelAt(10, 5),
            ];
      screenshot?.dispose();
      await tester.pumpWidget(const SizedBox.shrink());

      expect(byteData, isNotNull, reason: 'captured image exposes raw pixels');
      expect(decodedResource, same(resource));
      expect(pixels, isNotNull);
      final firstGlyph = pixels![0];
      final secondGlyph = pixels[1];
      final clippedGlyph = pixels[2];
      final gap = pixels[3];

      _expectPixelNear(firstGlyph, const <int>[136, 16, 32, 255]);
      _expectPixelNear(secondGlyph, const <int>[8, 144, 32, 255]);
      expect(clippedGlyph, <int>[
        16,
        32,
        64,
        255,
      ], reason: 'clip hides the lower half');
      expect(gap, <int>[16, 32, 64, 255], reason: 'UV cells stay in place');
    },
    timeout: const Timeout(Duration(seconds: 20)),
  );
}

PocketImageResource _t8CoverageResource() {
  const width = 16;
  const height = 8;
  final pixels = Uint8List(width * height);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      // Each 8x8 high-density cell maps to a 4x4 logical glyph. Uniform
      // coverage gives stable interior pixel assertions after filtering.
      pixels[y * width + x] = x < width ~/ 2 ? 255 : 128;
    }
  }
  final palette = Uint8List(256 * 4);
  for (var coverage = 0; coverage < 256; coverage++) {
    final offset = coverage * 4;
    // ABGR u32 little-endian: opaque white RGB and coverage in alpha.
    palette[offset] = 255;
    palette[offset + 1] = 255;
    palette[offset + 2] = 255;
    palette[offset + 3] = coverage;
  }
  return PocketImageResource(
    asset: 'glyph-page-0',
    revision: 1,
    width: width,
    height: height,
    psm: 5,
    linear: true,
    pixels: pixels,
    palette: palette,
  );
}

void _expectPixelNear(List<int> actual, List<int> expected) {
  if (actual.length != 4) {
    throw StateError('expected RGBA pixel, got $actual');
  }
  for (var channel = 0; channel < 4; channel++) {
    if ((actual[channel] - expected[channel]).abs() > 2) {
      throw StateError(
        'pixel mismatch at channel $channel: $actual vs $expected',
      );
    }
  }
}
