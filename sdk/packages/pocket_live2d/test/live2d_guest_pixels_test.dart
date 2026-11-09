import 'dart:async';
import 'dart:convert';
import 'dart:ffi' show DynamicLibrary;
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_live2d/src/pocket_live2d_ffi.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;

import 'live2d_alias_diagnostic.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixtureRoot = Platform.environment['POCKET_LIVE2D_GUEST_ASSETS'];
  final corePath = Platform.environment['POCKET_LIVE2D_CORE_LIBRARY'];
  final nativePath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final prerequisitesAvailable =
      fixtureRoot != null &&
      Directory(fixtureRoot).existsSync() &&
      corePath != null &&
      File(corePath).existsSync() &&
      nativePath != null &&
      File(nativePath).existsSync();

  late Directory storage;
  late List<String> assetRequests;
  setUp(() async {
    assetRequests = <String>[];
    storage = await Directory.systemTemp.createTemp('pocket-live2d-guest-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => storage.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      final key = utf8.decode(message!.buffer.asUint8List());
      assetRequests.add(key);
      final relative = key.replaceFirst(RegExp(r'^assets/'), '');
      if (relative.isEmpty || relative.split('/').contains('..')) {
        throw StateError('Unexpected unsafe fixture asset key: $key');
      }
      final path = <String>[
        fixtureRoot!,
        ...relative.split('/'),
      ].join(Platform.pathSeparator);
      final file = File(path);
      if (!file.existsSync()) {
        throw StateError('Fixture asset does not exist: $key ($path)');
      }
      return ByteData.sublistView(file.readAsBytesSync());
    });
  });

  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (await storage.exists()) await storage.delete(recursive: true);
  });

  testWidgets(
    'compiled Hiyori guest reaches real Core deformation and Flutter pixels',
    (tester) async {
      final core = DynamicLibrary.open(corePath!);
      final live2d = PocketLive2dPlugin.fromBundledCatalog(
        catalogAsset: 'assets/novel.native-assets.json',
        assetPrefix: 'assets',
        coreFactory: (bytes) =>
            PocketLive2dFfiCore.createModel(bytes, library: core),
      );
      final config = PocketAppConfig(
        appId: 'test.live2d.hiyori.pixels',
        pluginFactories: <PocketPluginFactory>[(_) => live2d],
      );
      final session = PocketSession(config: config);
      final firstFrame = Completer<void>();
      final previousRuntimeFactory = debugPocketSelfOwnedRuntimeFactory;
      var runtimeFactoryCalls = 0;
      debugPocketSelfOwnedRuntimeFactory = (viewport) {
        runtimeFactoryCalls++;
        return FfiPocketRuntime.open(
          width: viewport.width,
          height: viewport.height,
        );
      };
      try {
        await _probeRawHiyoriFrame(core);
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
          () => _texts(tester).contains('启程 · 开始新的故事'),
          timeoutFrames: 300,
          failure: () =>
              'Hiyori guest startup failed: stage=${session.stage}, ready=${session.ready}, '
              'runtime=${session.controller.isReady}, firstFrame=${firstFrame.isCompleted}, '
              'error=${session.lastError ?? session.failure}, models=${live2d.activeModelCount}, '
              'runtimeFactoryCalls=$runtimeFactoryCalls, '
              'pocketViews=${find.byType(PocketView).evaluate().length}, '
              'pocketViewSize=${tester.getSize(find.byType(PocketView))}, '
              'customPainters=${_painters(tester).length}, assets=$assetRequests, '
              'texts=${_texts(tester)}, flutterText=${tester.widgetList<Text>(find.byType(Text)).map((widget) => widget.data).toList()}, '
              'selectable=${tester.widgetList<SelectableText>(find.byType(SelectableText)).map((widget) => widget.data).toList()}',
        );
        expect(session.ready, isTrue);
        expect(session.lastError, isNull);

        final start = _findText(tester, '启程 · 开始新的故事');
        await tester.tapAt(start);
        await _pumpUntil(
          tester,
          () => _containsNormalized(
            tester,
            'The official Core moves this mesh through the Pocket host.',
          ),
          timeoutFrames: 300,
          failure: () => 'Novel story did not begin: ${_texts(tester)}',
        );

        await _pumpFor(tester, const Duration(milliseconds: 900));
        final painters = _painters(tester);
        final textureOps = <PocketTextureTriangleOp>[
          for (final painter in painters)
            ...painter.ops.whereType<PocketTextureTriangleOp>().where(
              (op) => op.asset.contains('models/Hiyori/'),
            ),
        ];
        final allTextureOps = <PocketTextureTriangleOp>[
          for (final painter in painters)
            ...painter.ops.whereType<PocketTextureTriangleOp>(),
        ];
        expect(
          textureOps,
          hasLength(greaterThan(10)),
          reason:
              'activeModels=${live2d.activeModelCount}, '
              'painterCount=${painters.length}, textureOps=${allTextureOps.length}, '
              'textureAssets=${allTextureOps.map((op) => op.asset).toSet().toList()}, '
              'modelTextureOps=${textureOps.length}, '
              'ops=${painters.expand((painter) => painter.ops).map((op) => op.runtimeType).toSet()}, '
              'texts=${_texts(tester)}',
        );
        final usedAssets = textureOps.map((op) => op.asset).toSet();
        expect(usedAssets, hasLength(2));
        for (final asset in usedAssets) {
          expect(
            painters.any((painter) => painter.images[asset] != null),
            isTrue,
            reason:
                'Core mesh texture must be decoded from the generated PAK: $asset',
          );
        }
        final allOps = painters.expand((painter) => painter.ops).toList();
        expect(
          allOps.whereType<PocketMeshMaskBeginOp>(),
          isNotEmpty,
          reason: 'The real Hiyori draw list contains masked ArtMeshes',
        );
        expect(
          allOps.whereType<PocketMeshLayerBeginOp>(),
          isNotEmpty,
          reason:
              'The existing canvas renderer must composite model mesh layers',
        );

        final before = _modelPoints(textureOps);
        await _expectPaintedModelPixels(tester, painters, fixtureRoot!);
        if (Platform.environment['POCKET_LIVE2D_ALIAS_DIAGNOSTIC'] == '1') {
          final highResolutionRoot =
              Platform.environment['POCKET_LIVE2D_HIGHRES_TEXTURE_ROOT'];
          final outputDirectory =
              Platform.environment['POCKET_LIVE2D_ALIAS_OUTPUT'];
          if (highResolutionRoot == null || outputDirectory == null) {
            throw StateError(
              'Alias diagnosis requires POCKET_LIVE2D_HIGHRES_TEXTURE_ROOT '
              'and POCKET_LIVE2D_ALIAS_OUTPUT.',
            );
          }
          final report = await tester.runAsync(
            () => runHiyoriAliasDiagnostic(
              painters: painters,
              highResolutionModelRoot: highResolutionRoot,
              outputDirectory: outputDirectory,
            ),
          );
          expect(report, isNotNull, reason: 'Hiyori alias diagnosis failed');
        }
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
          reason:
              'The compiled Idle motion must change Core-deformed screen vertices',
        );
      } finally {
        debugPocketSelfOwnedRuntimeFactory = previousRuntimeFactory;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(session.close);
        expect(live2d.activeModelCount, 0);
      }
    },
    skip: !prerequisitesAvailable,
    timeout: const Timeout(Duration(minutes: 3)),
  );
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

bool _containsNormalized(WidgetTester tester, String expected) {
  String normalize(String value) => value.replaceAll(RegExp(r'\s+'), ' ');
  final actual = normalize(_texts(tester).join(' '));
  return actual.contains(normalize(expected));
}

Future<void> _probeRawHiyoriFrame(DynamicLibrary core) async {
  final probe = PocketLive2dPlugin.fromBundledCatalog(
    catalogAsset: 'assets/novel.native-assets.json',
    assetPrefix: 'assets',
    coreFactory: (bytes) =>
        PocketLive2dFfiCore.createModel(bytes, library: core),
  );
  try {
    final info =
        await probe.load(<String, Object?>{
              'id': 'hiyori-fact-probe',
              'mocAsset': 'models/Hiyori/Hiyori.moc3',
              'textures': <String>[
                'models/Hiyori/Hiyori.2048/texture_00.png',
                'models/Hiyori/Hiyori.2048/texture_01.png',
              ],
            })
            as Map<String, Object?>;
    final modelId = info['modelId']! as String;
    final frame =
        await probe.update(<String, Object?>{
              'modelId': modelId,
              'parameters': const <Object?>[],
              'partOpacities': const <Object?>[],
            })
            as Map<String, Object?>;
    final outliers = <Map<String, Object?>>[];
    for (final raw in frame['drawables']! as List<Object?>) {
      final drawable = raw! as Map<String, Object?>;
      final positionRange = _floatRange(
        drawable['positionsXYPixels']! as Uint8List,
      );
      final uvRange = _floatRange(drawable['uvs']! as Uint8List);
      if (positionRange.$1 < -1000000 ||
          positionRange.$2 > 1000000 ||
          uvRange.$1 < 0 ||
          uvRange.$2 > 1) {
        outliers.add(<String, Object?>{
          'id': drawable['id'],
          'positionMinMax': <double>[positionRange.$1, positionRange.$2],
          'uvMinMax': <double>[uvRange.$1, uvRange.$2],
        });
      }
    }
    print('Hiyori raw Core position/UV outliers: ${jsonEncode(outliers)}');
    await probe.release(<String, Object?>{'modelId': modelId});
  } finally {
    await probe.dispose();
  }
}

(double, double) _floatRange(Uint8List bytes) {
  if (bytes.isEmpty) return (double.nan, double.nan);
  final data = ByteData.sublistView(bytes);
  var minimum = double.infinity;
  var maximum = double.negativeInfinity;
  for (var offset = 0; offset < bytes.length; offset += 4) {
    final value = data.getFloat32(offset, Endian.little);
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return (minimum, maximum);
}

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
  String fixtureRoot,
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
  final pixels = await tester.runAsync(() async {
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
      () => pixels!.toByteData(format: ui.ImageByteFormat.rawRgba),
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
    final png = await tester.runAsync(
      () => pixels!.toByteData(format: ui.ImageByteFormat.png),
    );
    expect(png, isNotNull);
    final imageFile = File(
      <String>[
        Directory(fixtureRoot).parent.path,
        'hiyori-model.png',
      ].join(Platform.pathSeparator),
    );
    await tester.runAsync(
      () => imageFile.writeAsBytes(
        png!.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes),
        flush: true,
      ),
    );
    print('Model-only Hiyori pixels: ${imageFile.path}');
  } finally {
    pixels?.dispose();
  }
}
