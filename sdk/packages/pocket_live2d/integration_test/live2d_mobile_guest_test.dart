import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('bundled Hiyori guest deforms and paints through the platform Core FFI', (
    tester,
  ) async {
    final live2d = PocketLive2dPlugin.fromBundledCatalog(
      catalogAsset: 'assets/novel.native-assets.json',
      assetPrefix: 'assets',
    );
    final observed = _ObservedCoreTransport(live2d);
    final config = PocketAppConfig(
      appId: 'test.live2d.hiyori.mobile',
      pluginFactories: <PocketPluginFactory>[(controller) => observed],
    );
    final session = PocketSession(config: config);
    final firstFrame = Completer<void>();
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PocketGuestSession(
              config: config,
              session: session,
              viewport: const Size(360, 640),
              onFirstFrame: () {
                if (!firstFrame.isCompleted) firstFrame.complete();
              },
            ),
          ),
        ),
      );
      await _pumpUntil(
        tester,
        () => _containsText(tester, '启程 · 开始新的故事'),
        timeoutFrames: 500,
        failure: () =>
            'Bundled Hiyori guest did not reach its title: '
            'ready=${session.ready}, stage=${session.stage}, '
            'error=${session.lastError ?? session.failure}, '
            'firstFrame=${firstFrame.isCompleted}, text=${_texts(tester)}',
      );
      expect(session.ready, isTrue);
      expect(session.lastError, isNull);

      await tester.tapAt(_findText(tester, '启程 · 开始新的故事'));
      await _pumpUntil(
        tester,
        () => _containsText(
          tester,
          'The official Core moves this mesh through the Pocket host.',
        ),
        timeoutFrames: 500,
        failure: () => 'Hiyori guest story did not start: ${_texts(tester)}',
      );
      await _pumpFor(tester, const Duration(milliseconds: 1000));

      final painters = _painters(tester);
      final modelOps = <PocketTextureTriangleOp>[
        for (final painter in painters)
          ...painter.ops.whereType<PocketTextureTriangleOp>().where(
            (op) => op.asset.contains('models/Hiyori/'),
          ),
      ];
      expect(
        live2d.activeModelCount,
        1,
        reason:
            'The bundled catalog must load one native Core model; '
            'session=${session.lastError ?? session.failure}, '
            'text=${_texts(tester)}',
      );
      expect(modelOps, hasLength(greaterThan(10)));
      final usedAssets = modelOps.map((op) => op.asset).toSet();
      expect(usedAssets, hasLength(2));
      for (final asset in usedAssets) {
        expect(
          painters.any((painter) => painter.images[asset] != null),
          isTrue,
          reason:
              'The model texture must be decoded from the bundled PAK: $asset',
        );
      }

      final allOps = painters.expand((painter) => painter.ops).toList();
      expect(allOps.whereType<PocketMeshMaskBeginOp>(), isNotEmpty);
      expect(allOps.whereType<PocketMeshLayerBeginOp>(), isNotEmpty);
      await _expectPaintedModelPixels(tester, painters);

      final before = _modelPoints(modelOps);
      await _pumpFor(tester, const Duration(milliseconds: 500));
      final after = _modelPoints(<PocketTextureTriangleOp>[
        for (final painter in _painters(tester))
          ...painter.ops.whereType<PocketTextureTriangleOp>().where(
            (op) => op.asset.contains('models/Hiyori/'),
          ),
      ]);
      expect(
        after,
        isNot(equals(before)),
        reason: 'The bundled Idle motion must deform Core output on device',
      );
      expect(observed.parameterMetadataCount, greaterThan(0));
      expect(observed.partCount, greaterThan(0));
      // Core responses are asynchronous and the shared animation driver
      // bounds accumulated deltas. Wait for observed physics, rather than
      // assuming a wall-clock pump equals an authored motion cycle.
      await _pumpUntil(
        tester,
        () => observed.hairMaximum - observed.hairMinimum > 0.001,
        timeoutFrames: 1500,
        failure: () =>
            'Physics output did not vary: updates=${observed.updates}, ranges=${observed.parameterRanges}, text=${_texts(tester)}',
      );
      expect(
        observed.hairMaximum - observed.hairMinimum,
        greaterThan(0.001),
        reason:
            'Official physics must vary a hair output absent from the Idle motion curves',
      );
      expect(
        observed.poseParts,
        containsAll(<String>['PartArmA', 'PartArmB']),
        reason:
            'Pose must supply real Core part opacities after virtual motion selection',
      );

      await tester.tapAt(_findText(tester, '手札'));
      await _pumpFor(tester, const Duration(milliseconds: 150));
      final pausedUpdates = observed.updates;
      await _pumpFor(tester, const Duration(milliseconds: 500));
      expect(
        observed.updates,
        pausedUpdates,
        reason: 'Menu pause must stop physics/Core work',
      );
      await tester.tapAt(_findText(tester, '继续阅读'));
      await _pumpFor(tester, const Duration(milliseconds: 500));
      expect(observed.updates, greaterThan(pausedUpdates));
      print(
        'Hiyori dynamics: metadata=${observed.parameterMetadataCount}, parts=${observed.partCount}, hairRange=${observed.hairMaximum - observed.hairMinimum}, poseParts=${observed.poseParts}, updates=${observed.updates}',
      );
    } finally {
      await tester.runAsync(session.close);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(live2d.activeModelCount, 0);
    }
  }, timeout: const Timeout(Duration(minutes: 4)));
}

/// Test-only observation at the official transport boundary. Every request is
/// executed by the bundled plugin's default FFI provider, without a fake Core.
final class _ObservedCoreTransport extends PocketPlugin {
  _ObservedCoreTransport(this.delegate);
  final PocketLive2dPlugin delegate;
  int parameterMetadataCount = 0;
  int partCount = 0;
  int updates = 0;
  final Map<String, List<double>> parameterRanges = <String, List<double>>{};
  double get hairMinimum =>
      parameterRanges['ParamHairFront']?[0] ?? double.infinity;
  double get hairMaximum =>
      parameterRanges['ParamHairFront']?[1] ?? double.negativeInfinity;
  final Set<String> poseParts = <String>{};

  @override
  PocketPluginDescriptor get descriptor => delegate.descriptor;
  @override
  void register(PocketPluginContext context) {
    context.registerRequest(pocketLive2dLoadCapability, (params) async {
      final result = await delegate.load(params);
      final facts = result! as Map;
      parameterMetadataCount =
          (facts['parameterMetadata'] as List?)?.length ?? 0;
      partCount = (facts['parts'] as List?)?.length ?? 0;
      return result;
    });
    context.registerRequest(pocketLive2dUpdateCapability, (params) async {
      final result = await delegate.update(params);
      updates++;
      for (final parameter in params['parameters']! as List) {
        final id = (parameter as Map)['id'];
        if (id == 'ParamHairFront' ||
            id == 'ParamAngleX' ||
            id == 'ParamBodyAngleZ') {
          final value = (parameter['value']! as num).toDouble();
          final range = parameterRanges.putIfAbsent(
            id! as String,
            () => <double>[value, value],
          );
          if (value < range[0]) range[0] = value;
          if (value > range[1]) range[1] = value;
        }
      }
      for (final part in params['partOpacities']! as List) {
        poseParts.add((part as Map)['id']! as String);
      }
      return result;
    });
    context.registerRequest(pocketLive2dReleaseCapability, delegate.release);
  }

  @override
  Future<void> activate(PocketPluginContext context) =>
      delegate.activate(context);
  @override
  Future<void> deactivate(PocketPluginContext context) =>
      delegate.deactivate(context);
  @override
  Future<void> dispose() => delegate.dispose();
}

Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  required int timeoutFrames,
  required String Function() failure,
}) async {
  for (var frame = 0; frame < timeoutFrames; frame++) {
    await tester.pump(const Duration(milliseconds: 16));
    if (condition()) return;
    if (frame % 20 == 19) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
    }
  }
  fail(failure());
}

Future<void> _pumpFor(WidgetTester tester, Duration duration) async {
  for (var elapsed = 0; elapsed < duration.inMilliseconds; elapsed += 16) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

List<PocketCanvasPainter> _painters(WidgetTester tester) => [
  for (final widget in tester.widgetList<CustomPaint>(
    find.byWidgetPredicate(
      (widget) =>
          widget is CustomPaint && widget.painter is PocketCanvasPainter,
    ),
  ))
    widget.painter! as PocketCanvasPainter,
];

List<String> _texts(WidgetTester tester) => [
  for (final painter in _painters(tester))
    for (final op in painter.ops.whereType<PocketTextOp>()) op.text,
];

bool _containsText(WidgetTester tester, String expected) =>
    _normalize(_texts(tester).join(' ')).contains(_normalize(expected));

String _normalize(String value) => value.replaceAll(RegExp(r'\s+'), ' ');

Offset _findText(WidgetTester tester, String text) {
  for (final widget in tester.widgetList<CustomPaint>(
    find.byWidgetPredicate(
      (widget) =>
          widget is CustomPaint && widget.painter is PocketCanvasPainter,
    ),
  )) {
    final painter = widget.painter! as PocketCanvasPainter;
    final matches = painter.ops.whereType<PocketTextOp>().where(
      (op) => op.text == text,
    );
    if (matches.isEmpty) continue;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    final op = matches.first;
    return box.localToGlobal(
      Offset(
        (op.x + op.width / 2) * box.size.width / painter.width,
        (op.y + op.height / 2) * box.size.height / painter.height,
      ),
    );
  }
  throw StateError('Text draw op not found: $text');
}

List<double> _modelPoints(Iterable<PocketTextureTriangleOp> ops) => [
  for (final op in ops)
    for (final point in op.points) ...<double>[point.x, point.y],
];

Future<void> _expectPaintedModelPixels(
  WidgetTester tester,
  List<PocketCanvasPainter> painters,
) async {
  final first = painters.first;
  final modelBlocks = <({PocketCanvasPainter painter, List<PocketOp> ops})>[
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
  expect(modelBlocks, isNotEmpty);
  final images = <String, ui.Image>{
    for (final painter in painters) ...painter.images,
  };
  final image = await tester.runAsync(() async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    for (final block in modelBlocks) {
      PocketCanvasPainter(
        width: block.painter.width,
        height: block.painter.height,
        ops: block.ops,
        images: images,
        renderedSize: block.painter.renderedSize,
        devicePixelRatio: block.painter.devicePixelRatio,
      ).paint(canvas, Size(block.painter.width, block.painter.height));
    }
    final picture = recorder.endRecording();
    try {
      return await picture.toImage(first.width.ceil(), first.height.ceil());
    } finally {
      picture.dispose();
    }
  });
  try {
    final rgba = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.rawRgba),
    );
    expect(rgba, isNotNull);
    var opaquePixels = 0;
    final colors = <int>{};
    for (var offset = 0; offset < rgba!.lengthInBytes; offset += 4) {
      if (rgba.getUint8(offset + 3) > 24) {
        opaquePixels++;
        if (colors.length < 64) colors.add(rgba.getUint32(offset));
      }
    }
    expect(opaquePixels, greaterThan(500));
    expect(colors.length, greaterThan(12));
    print(
      'Hiyori mobile model pixels: opaque=$opaquePixels, '
      'sampledColors=${colors.length}',
    );
  } finally {
    image?.dispose();
  }
}
