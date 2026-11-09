import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const int _meshSupersampleScale = int.fromEnvironment(
  'POCKET_MESH_SUPERSAMPLE',
  defaultValue: 1,
);
final class _MeshGroupRuntime implements PocketRuntime {
  _MeshGroupRuntime(this.initialFrame);

  final PocketFrame initialFrame;

  @override
  PocketFrame eval(String source) => initialFrame;

  @override
  PocketFrame load(String source, Uint8List pak) => initialFrame;

  @override
  PocketFrame frame(int deltaMilliseconds) => initialFrame;

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
    'PocketView keeps a large masked mesh group atomic across painter blocks',
    (tester) async {
      final ready = Completer<void>();
      final boundaryKey = GlobalKey();
      final target = await _solidImage(tester, 0xffff0000);
      final mask = await _solidImage(tester, 0xffffffff);
      final frame = _maskedMeshFrame();
      final runtime = _MeshGroupRuntime(frame);
      final legacyCanvasOps = frame.ops
          .where((op) => op is! PocketHostSurfaceOp)
          .toList(growable: false);
      final legacyPixels = await _renderFixed32Blocks(
        tester,
        legacyCanvasOps,
        <String, ui.Image>{'target': target, 'mask': mask},
      );
      expect(
        _pixel(legacyPixels, 4, 1, 2),
        isNot(<int>[255, 0, 0, 255]),
        reason: 'The legacy fixed-32 split must demonstrate the mask break',
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Align(
            alignment: Alignment.topLeft,
            child: RepaintBoundary(
              key: boundaryKey,
              child: SizedBox(
                width: 4,
                height: 4,
                child: PocketView(
                  runtime: runtime,
                  active: false,
                  jsSource: '',
                  pakBytes: Uint8List(0),
                  showDebugFps: false,
                  imageResourceDecoder: (resource) async =>
                      switch (resource.asset) {
                        'target' => target,
                        'mask' => mask,
                        _ => throw StateError(
                          'Unexpected asset ${resource.asset}',
                        ),
                      },
                  hostSurfaceBuilder: (_) =>
                      const ColoredBox(color: Color(0xff00ff00)),
                  onReady: (_) => ready.complete(),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.runAsync(() => ready.future);
      await tester.pump();

      final customPaints = tester
          .widgetList<CustomPaint>(find.byType(CustomPaint))
          .toList();
      final painters = <PocketCanvasPainter>[];
      final spanPainters = <PocketMeshSpanPainter>[];
      for (final customPaint in customPaints) {
        final painter = customPaint.painter;
        if (painter is PocketCanvasPainter) painters.add(painter);
        if (painter is PocketMeshSpanPainter) {
          spanPainters.add(painter);
          painters.addAll(painter.partitions);
        }
      }
      final expectsMeshSpan = _meshSupersampleScale > 1;
      expect(spanPainters.isNotEmpty, expectsMeshSpan);
      expect(
        painters.any(
          (painter) =>
              painter.ops
                      .whereType<PocketTextureTriangleOp>()
                      .where((op) => op.asset == 'target')
                      .length >
                  64 &&
              painter.ops
                      .whereType<PocketTextureTriangleOp>()
                      .where((op) => op.asset == 'mask')
                      .length >
                  64,
        ),
        isTrue,
        reason: 'Both >64-triangle meshes must remain in one painter group',
      );
      if (_meshSupersampleScale > 1) {
        expect(
          spanPainters.any(
            (span) => span.partitions.any(
              (partition) =>
                  partition.ops.any((op) => op is PocketMeshLayerBeginOp) &&
                  partition.ops.any((op) => op is PocketMeshMaskBeginOp) &&
                  partition.ops.any((op) => op is PocketMeshLayerRestoreOp) &&
                  partition.ops
                          .whereType<PocketTextureTriangleOp>()
                          .where((op) => op.asset == 'target')
                          .length >
                      64 &&
                  partition.ops
                          .whereType<PocketTextureTriangleOp>()
                          .where((op) => op.asset == 'mask')
                          .length >
                      64,
            ),
          ),
          isTrue,
          reason:
              'The sampled wrapper must contain the complete large mask partition.',
        );
      }

      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(boundaryKey),
      );
      final image = (await tester.runAsync<ui.Image>(
        () => boundary.toImage(pixelRatio: 1),
      ))!;
      try {
        final data = (await tester.runAsync<ByteData?>(
          () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
        ))!;
        final pixels = data.buffer.asUint8List(
          data.offsetInBytes,
          data.lengthInBytes,
        );

        // The source DrawOp order places the host surface after the complete
        // masked mesh. Its top-right pixel must therefore cover the blue/red
        // canvas while the other pixels preserve the mask result.
        expect(_pixel(pixels, image.width, 0, 2), <int>[255, 0, 0, 255]);
        final maskedEdge = _pixel(pixels, image.width, 1, 2);
        if (_meshSupersampleScale > 1) {
          expect(maskedEdge[0], greaterThanOrEqualTo(240));
          expect(maskedEdge[1], 0);
          expect(maskedEdge[2], lessThanOrEqualTo(16));
          expect(maskedEdge[3], 255);
        } else {
          expect(maskedEdge, <int>[255, 0, 0, 255]);
        }
        expect(_pixel(pixels, image.width, 3, 2), <int>[0, 0, 255, 255]);
        expect(_pixel(pixels, image.width, 3, 0), <int>[0, 255, 0, 255]);
      } finally {
        image.dispose();
      }

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}

Future<Uint8List> _renderFixed32Blocks(
  WidgetTester tester,
  List<PocketOp> ops,
  Map<String, ui.Image> images,
) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  for (var start = 0; start < ops.length; start += 32) {
    final end = start + 32 < ops.length ? start + 32 : ops.length;
    PocketCanvasPainter(
      width: 4,
      height: 4,
      ops: ops.sublist(start, end),
      images: images,
    ).paint(canvas, const ui.Size(4, 4));
  }
  final picture = recorder.endRecording();
  final image = (await tester.runAsync<ui.Image>(() => picture.toImage(4, 4)))!;
  picture.dispose();
  try {
    final data = (await tester.runAsync<ByteData?>(
      () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
    ))!;
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  } finally {
    image.dispose();
  }
}

List<int> _pixel(Uint8List pixels, int width, int x, int y) {
  final offset = (y * width + x) * 4;
  return pixels.sublist(offset, offset + 4);
}

PocketFrame _maskedMeshFrame() {
  const clip = PocketClip(x: 0, y: 0, width: 4, height: 4);
  final ops = <PocketOp>[
    const PocketRectOp(
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      color: 0xff0000ff,
      clip: clip,
    ),
    // Thirty-one offscreen ordinary operations place MESH_LAYER_BEGIN after
    // one complete 32-op partition. The preserved mask group then occupies its
    // own mesh-only partition and remains indivisible across later blocks.
    for (var index = 0; index < 31; index++)
      const PocketRectOp(x: 10, y: 10, width: 1, height: 1, color: 0xffff00ff),
    PocketMeshLayerBeginOp(
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      blend: 0,
      multiplyRgb: const <double>[1, 1, 1],
      screenRgb: const <double>[0, 0, 0],
      clip: clip,
    ),
    for (var triangle = 0; triangle < 33; triangle++)
      ..._fullQuad('target', clip),
    PocketMeshMaskBeginOp(
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      inverted: false,
      clip: clip,
    ),
    for (var triangle = 0; triangle < 33; triangle++)
      ..._leftHalfQuad('mask', clip),
    const PocketMeshLayerRestoreOp(x: 0, y: 0, width: 0, height: 0, clip: clip),
    const PocketHostSurfaceOp(
      x: 3,
      y: 0,
      width: 1,
      height: 1,
      id: 'after-mesh',
      kind: 'application',
      parameters: <String, dynamic>{},
      surfaceHandle: 7,
      focused: false,
      clip: clip,
    ),
  ];
  return PocketFrame(
    width: 4,
    height: 4,
    ops: ops,
    events: const <PocketEvent>[],
    resources: <PocketImageResource>[
      PocketImageResource(
        asset: 'target',
        revision: 1,
        width: 1,
        height: 1,
        psm: 3,
        linear: false,
        pixels: Uint8List.fromList(<int>[255, 0, 0, 255]),
      ),
      PocketImageResource(
        asset: 'mask',
        revision: 1,
        width: 1,
        height: 1,
        psm: 3,
        linear: false,
        pixels: Uint8List.fromList(<int>[255, 255, 255, 255]),
      ),
    ],
  );
}

List<PocketOp> _fullQuad(String asset, PocketClip clip) => <PocketOp>[
  _triangle(
    asset,
    clip,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 4, y: 0),
      PocketPoint(x: 4, y: 4),
    ],
    const <double>[0, 0, 1, 0, 1, 1],
  ),
  _triangle(
    asset,
    clip,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 4, y: 4),
      PocketPoint(x: 0, y: 4),
    ],
    const <double>[0, 0, 1, 1, 0, 1],
  ),
];

List<PocketOp> _leftHalfQuad(String asset, PocketClip clip) => <PocketOp>[
  _triangle(
    asset,
    clip,
    const <PocketPoint>[
      PocketPoint(x: 0, y: 0),
      PocketPoint(x: 2, y: 0),
      PocketPoint(x: 2, y: 4),
    ],
    const <double>[0, 0, 1, 0, 1, 1],
  ),
  _triangle(
    asset,
    clip,
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
  PocketClip clip,
  List<PocketPoint> points,
  List<double> uvs,
) => PocketTextureTriangleOp(
  x: 0,
  y: 0,
  width: 4,
  height: 4,
  asset: asset,
  color: 0xffffffff,
  points: points,
  uvs: uvs,
  clip: clip,
);

Future<ui.Image> _solidImage(WidgetTester tester, int argb) async {
  final image = await tester.runAsync(() async {
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawColor(ui.Color(argb), ui.BlendMode.src);
    final picture = recorder.endRecording();
    final result = await picture.toImage(1, 1);
    picture.dispose();
    return result;
  });
  return image!;
}
