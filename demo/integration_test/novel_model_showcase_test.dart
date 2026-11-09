import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_sdk/pocket_sdk.dart' show PocketSystemHostController;

import 'novel_mesh_lod_diagnostics.dart';
import 'novel_mesh_span_diagnostics.dart';
import 'guest_interaction_test.dart' as guest;

const _modelAsset = 'Hiyori.2048/texture_';
// These override Flutter test-view metrics only. They do not establish a real
// OS resize, physical-device DPI, or mobile lifecycle acceptance.
const _traceModelInputs = bool.fromEnvironment('POCKET_MODEL_TRACE_INPUTS');
const _modelLodDiagnostics = bool.fromEnvironment(
  'POCKET_MODEL_LOD_DIAGNOSTICS',
);
const _modelMeshSpanAblation = bool.fromEnvironment(
  'POCKET_MODEL_MESH_SPAN_ABLATION',
);
const _modelMeshLodAvailabilityAblation = bool.fromEnvironment(
  'POCKET_MODEL_MESH_LOD_AVAILABILITY_ABLATION',
);
const _modelMeshCoarsestLodPromotionAblation = bool.fromEnvironment(
  'POCKET_MODEL_MESH_COARSEST_LOD_PROMOTION_ABLATION',
);
const _modelMeshFilterAblation = bool.fromEnvironment(
  'POCKET_MODEL_MESH_FILTER_ABLATION',
);
const _captureWidth = int.fromEnvironment('POCKET_MODEL_WIDTH');
const _captureHeight = int.fromEnvironment('POCKET_MODEL_HEIGHT');
const _captureDpr = int.fromEnvironment('POCKET_MODEL_DPR', defaultValue: 1);

/// Keeps this integration test on the real path_provider API and filesystem
/// while redirecting the one persistent app-support root to a private temp
/// directory. Other path-provider requests still reach the registered plugin.
final class _IsolatedPathProvider extends PathProviderPlatform {
  _IsolatedPathProvider(this.delegate, this.supportPath);

  final PathProviderPlatform delegate;
  final String supportPath;
  int supportPathRequests = 0;

  @override
  Future<String?> getApplicationSupportPath() async {
    supportPathRequests++;
    return supportPath;
  }

  @override
  Future<String?> getTemporaryPath() => delegate.getTemporaryPath();

  @override
  Future<String?> getLibraryPath() => delegate.getLibraryPath();

  @override
  Future<String?> getApplicationDocumentsPath() =>
      delegate.getApplicationDocumentsPath();

  @override
  Future<String?> getApplicationCachePath() =>
      delegate.getApplicationCachePath();

  @override
  Future<String?> getExternalStoragePath() => delegate.getExternalStoragePath();

  @override
  Future<List<String>?> getExternalCachePaths() =>
      delegate.getExternalCachePaths();

  @override
  Future<List<String>?> getExternalStoragePaths({StorageDirectory? type}) =>
      delegate.getExternalStoragePaths(type: type);

  @override
  Future<String?> getDownloadsPath() => delegate.getDownloadsPath();
}

List<PocketTextureTriangleOp> _modelOps(WidgetTester tester) => [
  for (final painter in _painterInventory(tester).sourcePartitions)
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>())
      if (op.asset.contains(_modelAsset)) op,
];

NovelMeshPainterInventory _painterInventory(WidgetTester tester) =>
    inspectNovelMeshPainters(
      tester.widgetList<CustomPaint>(find.byType(CustomPaint)),
    );

List<double> _modelPositions(WidgetTester tester) => [
  for (final op in _modelOps(tester))
    for (final point in op.points) ...[point.x, point.y],
];

Map<String, List<List<double>>> _modelPositionsByTriangle(WidgetTester tester) {
  final result = <String, List<List<double>>>{};
  for (final op in _modelOps(tester)) {
    // The source UV triangle stays fixed as Cubism deforms its positions, so
    // texture page + UVs identify corresponding geometry across visible-op
    // count changes. Skip duplicate signatures during comparison because the
    // DrawOp stream does not expose a stronger drawable/triangle identifier.
    final uvKey = op.uvs.map((value) => value.toStringAsPrecision(9)).join(',');
    final key = '${op.asset}|$uvKey';
    result.putIfAbsent(key, () => <List<double>>[]).add([
      for (final point in op.points) ...[point.x, point.y],
    ]);
  }
  return result;
}

List<PocketTextureTriangleOp> _miraOps(WidgetTester tester) => [
  for (final painter in _painterInventory(tester).sourcePartitions)
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>())
      if (op.asset.contains('mira-')) op,
];

bool _hasAnyText(WidgetTester tester, Iterable<String> parts) =>
    guest.texts(tester).any((text) => parts.any((part) => text.contains(part)));

String? _firstText(WidgetTester tester, Iterable<String> parts) {
  final labels = guest.texts(tester);
  String compact(String value) => value.replaceAll(RegExp(r'\s+'), '');
  // Prompts can quote or describe an action label. Prefer an actual painted
  // action text op over an earlier prompt that merely contains that phrase.
  for (final part in parts) {
    for (final text in labels) {
      if (compact(text) == compact(part)) return text;
    }
  }
  for (final part in parts) {
    for (final text in labels) {
      if (text.contains(part)) return text;
    }
  }
  return null;
}

Future<void> _waitForAny(
  WidgetTester tester,
  Iterable<String> parts,
  String reason,
) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    if (_hasAnyText(tester, parts)) return;
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 10 == 9) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
    }
  }
  fail('$reason; painted=${guest.texts(tester)}');
}

/// Waits for the stable continue hint before advancing dialogue. The reveal
/// hint can naturally disappear while the pointer driver settles its target.
Future<void> _tapAny(
  WidgetTester tester,
  List<String> parts, {
  bool scroll = true,
}) async {
  if (_traceModelInputs) debugPrint('model-input: seeking=$parts');
  var revealDrags = 0;
  for (var attempt = 0; attempt < 300; attempt++) {
    final action = _firstText(tester, parts);
    if (action != null) {
      if (_traceModelInputs) debugPrint('model-input: tapping=$action');
      await guest.tapGuest(tester, action, scroll: scroll);
      if (_traceModelInputs) debugPrint('model-input: tapped=$action');
      return;
    }
    final next = _firstText(tester, const ['轻触继续  ›', 'Tap to continue  ›']);
    if (next != null) {
      await guest.tapGuest(tester, next, scroll: false);
    } else if (scroll && attempt % 8 == 7 && revealDrags < 12) {
      // Offscreen labels are culled. Resolve the locale after a real scroll,
      // using the same input sequence as the retained guest reveal helper.
      final box = tester.renderObject<RenderBox>(
        guest.activePocketViewFinder(),
      );
      final gesture = await tester.startGesture(
        box.localToGlobal(Offset(box.size.width * .35, box.size.height * .72)),
      );
      final direction = revealDrags < 6 ? -23.0 : 23.0;
      for (var move = 0; move < 10; move++) {
        await gesture.moveBy(Offset(0, direction));
        await tester.pump(const Duration(milliseconds: 16));
        if (_firstText(tester, parts) != null) break;
      }
      for (var settle = 0; settle < 3; settle++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 100));
      revealDrags++;
    } else {
      await tester.pump(const Duration(milliseconds: 30));
    }
  }
  fail('Could not find $parts; painted=${guest.texts(tester)}');
}

Future<Map<String, dynamic>?> _readDiskAuto() async {
  try {
    final support = await getApplicationSupportDirectory();
    final file = File(
      '${support.path}/pocket-platform-data/pocket_platform_data.json',
    );
    if (!await file.exists()) return null;
    final root = jsonDecode(await file.readAsString()) as Map;
    final private = root['private'];
    if (private is! Map) return null;
    final app = private['pocket.demo.lantern'];
    if (app is! Map) return null;
    final slot = app['lantern.slot.auto'];
    return slot is Map ? Map<String, dynamic>.from(slot) : null;
  } on Object {
    // The platform file may be between atomic writes while autosave settles.
    return null;
  }
}

Future<Map<String, dynamic>> _waitForMainAuto(WidgetTester tester) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    final saved = await tester.runAsync(_readDiskAuto);
    if (saved?['state']?['active']?['id'] == 'arrival_01') return saved!;
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 10 == 9) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
    }
  }
  fail(
    'Main-game autosave did not reach arrival_01: ${await tester.runAsync(_readDiskAuto)}',
  );
}

Future<void> _waitForLive2d(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    final ops = _modelOps(tester);
    if (plugin.activeModelCount == 1 && ops.length > 10) return;
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 10 == 9) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
    }
  }
  fail(
    'Real Hiyori model did not load: activeModelCount=${plugin.activeModelCount}, '
    'triangles=${_modelOps(tester).length}, painted=${guest.texts(tester)}',
  );
}

Future<void> _waitForRelease(
  WidgetTester tester,
  PocketLive2dPlugin plugin,
) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    if (plugin.activeModelCount == 0) return;
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 2)),
    );
  }
  fail('Replay model handle remained loaded: ${plugin.activeModelCount}');
}

Future<void> _waitForModelMotion(
  WidgetTester tester,
  List<double> before,
  Map<String, List<List<double>>> beforeByTriangle,
  int beforeTriangleCount,
) async {
  var afterCoordinateCount = 0;
  var afterTriangleCount = 0;
  var commonCoordinateCount = 0;
  var maximumCommonCoordinateDelta = 0.0;
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 5 == 4) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 2)),
      );
    }
    final afterByTriangle = _modelPositionsByTriangle(tester);
    afterCoordinateCount = _modelPositions(tester).length;
    afterTriangleCount = _modelOps(tester).length;
    commonCoordinateCount = 0;
    maximumCommonCoordinateDelta = 0;
    for (final entry in beforeByTriangle.entries) {
      final beforeTriangles = entry.value;
      final afterTriangles = afterByTriangle[entry.key];
      if (beforeTriangles.length != 1 || afterTriangles?.length != 1) {
        continue;
      }
      final first = beforeTriangles.single;
      final second = afterTriangles!.single;
      final common = math.min(first.length, second.length).toInt();
      commonCoordinateCount += common;
      for (var index = 0; index < common; index++) {
        final firstCoordinate = first[index];
        final secondCoordinate = second[index];
        if (!firstCoordinate.isFinite || !secondCoordinate.isFinite) continue;
        maximumCommonCoordinateDelta = math.max(
          maximumCommonCoordinateDelta,
          (firstCoordinate - secondCoordinate).abs(),
        );
      }
    }
    // Cubism may add or remove visible triangles as drawable opacity changes.
    // A count change alone is not motion: require a coordinate difference on
    // one or more unambiguous texture-page/UV triangles shared by both frames.
    if (commonCoordinateCount >= 6 && maximumCommonCoordinateDelta > 0.001) {
      debugPrint(
        'novel-model-motion: '
        'triangleCount=$beforeTriangleCount->$afterTriangleCount, '
        'coordinateCount=${before.length}->$afterCoordinateCount, '
        'commonCoordinates=$commonCoordinateCount, '
        'maxCommonCoordinateDelta=$maximumCommonCoordinateDelta',
      );
      return;
    }
  }
  fail(
    'Hiyori geometry did not change over virtual time; '
    'triangleCount=$beforeTriangleCount->$afterTriangleCount, '
    'coordinateCount=${before.length}->$afterCoordinateCount, '
    'commonCoordinates=$commonCoordinateCount, '
    'maxCommonCoordinateDelta=$maximumCommonCoordinateDelta',
  );
}

// A frozen production model frame: only coordinate rounding varies. This
// avoids attributing different animation poses to a clarity improvement.
Future<void> _captureCoordinateAblation(
  WidgetTester tester,
  String framing,
) async {
  const enabled = bool.fromEnvironment('POCKET_MODEL_SUBPIXEL_ABLATION');
  if (!enabled || framing != 'full') return;
  final painters = _painterInventory(tester).sourcePartitions
      .where(
        (painter) => painter.ops.whereType<PocketTextureTriangleOp>().any(
          (op) => op.asset.contains(_modelAsset),
        ),
      )
      .toList();
  expect(painters, isNotEmpty);
  final painter = painters.first;
  for (final block in painters) {
    expect(block.width, painter.width);
    expect(block.height, painter.height);
    expect(identical(block.images, painter.images), isTrue);
  }
  // PocketView splits at complete mesh-layer boundaries. Preserve every
  // model block in painter order; inspecting just one drops most drawables.
  final modelFrameOps = <PocketOp>[for (final block in painters) ...block.ops];
  var fractionalCoordinates = 0;
  var modelTriangles = 0;
  var minX = double.infinity, minY = double.infinity;
  var maxX = double.negativeInfinity, maxY = double.negativeInfinity;
  final roundedOps = <PocketOp>[];
  for (final op in modelFrameOps) {
    if (op is! PocketTextureTriangleOp || !op.asset.contains(_modelAsset)) {
      roundedOps.add(op);
      continue;
    }
    modelTriangles++;
    final points = <PocketPoint>[];
    for (final point in op.points) {
      minX = math.min(minX, point.x);
      minY = math.min(minY, point.y);
      maxX = math.max(maxX, point.x);
      maxY = math.max(maxY, point.y);
      for (final value in [point.x, point.y]) {
        if ((value - value.roundToDouble()).abs() > 0.00001) {
          fractionalCoordinates++;
        }
      }
      points.add(
        PocketPoint(x: point.x.roundToDouble(), y: point.y.roundToDouble()),
      );
    }
    roundedOps.add(
      PocketTextureTriangleOp(
        x: op.x,
        y: op.y,
        width: op.width,
        height: op.height,
        asset: op.asset,
        color: op.color,
        points: points,
        uvs: op.uvs,
        repeatTexture: op.repeatTexture,
        clip: op.clip,
      ),
    );
  }
  expect(
    fractionalCoordinates,
    greaterThan(0),
    reason:
        'Real Core -> DrawList -> PFB must preserve subpixel model positions.',
  );
  final ratio = tester.view.devicePixelRatio;
  Future<ui.Image> render(List<PocketOp> ops, double dpr) async {
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder)..scale(dpr);
    PocketCanvasPainter(
      width: painter.width,
      height: painter.height,
      ops: ops,
      images: painter.images,
      meshImageLevels: painter.meshImageLevels,
      devicePixelRatio: dpr,
      fontFamilyFallback: painter.fontFamilyFallback,
    ).paint(canvas, Size(painter.width, painter.height));
    final picture = recorder.endRecording();
    try {
      return await picture.toImage(
        (painter.width * dpr).ceil(),
        (painter.height * dpr).ceil(),
      );
    } finally {
      picture.dispose();
    }
  }

  final tag = '${_captureWidth}x$_captureHeight-dpr$_captureDpr';
  final images = <String, ui.Image>{};
  try {
    images['float'] = (await tester.runAsync(
      () => render(modelFrameOps, ratio),
    ))!;
    images['rounded'] = (await tester.runAsync(
      () => render(roundedOps, ratio),
    ))!;
    final large = (await tester.runAsync(
      () => render(modelFrameOps, ratio * 4),
    ))!;
    try {
      final recorder = ui.PictureRecorder();
      final canvas = ui.Canvas(recorder);
      canvas.drawImageRect(
        large,
        Rect.fromLTWH(0, 0, large.width.toDouble(), large.height.toDouble()),
        Rect.fromLTWH(
          0,
          0,
          images['float']!.width.toDouble(),
          images['float']!.height.toDouble(),
        ),
        Paint()..filterQuality = FilterQuality.medium,
      );
      final picture = recorder.endRecording();
      try {
        images['reference4x'] = (await tester.runAsync(
          () =>
              picture.toImage(images['float']!.width, images['float']!.height),
        ))!;
      } finally {
        picture.dispose();
      }
    } finally {
      large.dispose();
    }
    final paths = <String, String>{};
    for (final entry in images.entries) {
      final bytes = await tester.runAsync(
        () => entry.value.toByteData(format: ui.ImageByteFormat.png),
      );
      final path =
          '${Directory.systemTemp.path}/model-coordinate-${entry.key}-$tag.png';
      await tester.runAsync(
        () => File(path).writeAsBytes(bytes!.buffer.asUint8List()),
      );
      paths[entry.key] = path;
    }
    debugPrint(
      'POCKET_MODEL_COORDINATE_ABLATION ${jsonEncode({
        'modelPainterBlocks': painters.length,
        'modelBounds': [minX, minY, maxX, maxY],
        'modelTriangles': modelTriangles,
        'fractionalCoordinates': fractionalCoordinates,
        'devicePixelRatio': ratio,
        'logicalWidth': painter.width,
        'logicalHeight': painter.height,
        'paths': paths,
        'reference': 'same frozen production frame at 4x DPR then medium downsample; diagnostic, not platform acceptance',
      })}',
    );
  } finally {
    for (final image in images.values) {
      image.dispose();
    }
  }
}

Future<void> _captureHiyori(
  WidgetTester tester,
  GlobalKey key, {
  String framing = 'full',
}) async {
  await _captureCoordinateAblation(tester, framing);
  final inventory = _painterInventory(tester);
  if (_modelMeshSpanAblation) {
    expect(
      inventory.spanPainters,
      isNotEmpty,
      reason: 'The SSAA A/B requires actual span painters in the widget tree.',
    );
    final ablation = await captureNovelMeshSpanSameFrameAblation(
      tester: tester,
      inventory: inventory,
      framing: framing,
      outputTag: _captureWidth > 0
          ? '${_captureWidth}x$_captureHeight-dpr$_captureDpr'
          : 'view',
    );
    debugPrint('POCKET_MESH_SPAN_AB ${jsonEncode(ablation)}');
  }
  if (_modelMeshLodAvailabilityAblation) {
    final ablation = await captureNovelMeshLodAvailabilityAblation(
      tester: tester,
      inventory: inventory,
      framing: framing,
      outputTag: _captureWidth > 0
          ? '${_captureWidth}x$_captureHeight-dpr$_captureDpr'
          : 'view',
    );
    debugPrint('POCKET_MESH_LOD_AVAILABILITY_AB ${jsonEncode(ablation)}');
  }
  if (_modelMeshCoarsestLodPromotionAblation) {
    final ablation = await captureNovelMeshCoarsestLodPromotionAblation(
      tester: tester,
      inventory: inventory,
      framing: framing,
      outputTag: _captureWidth > 0
          ? '${_captureWidth}x$_captureHeight-dpr$_captureDpr'
          : 'view',
    );
    debugPrint('POCKET_MESH_COARSEST_LOD_PROMOTION_AB ${jsonEncode(ablation)}');
  }
  if (_modelMeshFilterAblation && (framing == 'full' || framing == 'closeup')) {
    final ablation = await captureNovelMeshSpanFilterAblation(
      tester: tester,
      inventory: inventory,
      framing: framing,
      outputTag: _captureWidth > 0
          ? '${_captureWidth}x$_captureHeight-dpr$_captureDpr'
          : 'view',
    );
    debugPrint('POCKET_MODEL_MESH_FILTER_AB ${jsonEncode(ablation)}');
  }
  if (_modelLodDiagnostics) {
    // Pass every production painter in its original order. The helper reads
    // each painter independently, so 32-op boundaries and batch/LOD choices
    // remain the ones used by the just-captured frame.
    final capturedPainters = inventory.sourcePartitions;
    final lodReport = nameNovelMeshLodSelections(
      diagnoseNovelMeshLodBatches(capturedPainters),
    );
    debugPrint(
      'NOVEL_MESH_LOD_DIAGNOSTICS ${jsonEncode({'framing': framing, 'devicePixelRatio': tester.view.devicePixelRatio, 'painterCount': capturedPainters.length, 'productionPartitionPreserved': true, 'spanStructure': describeNovelMeshSpanPainters(inventory), ...lodReport})}',
    );
  }
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final ratio = tester.view.devicePixelRatio;
  final image = await tester.runAsync(
    () => boundary.toImage(pixelRatio: ratio),
  );
  try {
    final data = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    final tag = _captureWidth > 0
        ? '-${_captureWidth}x$_captureHeight-dpr$_captureDpr'
        : '';
    final path = '${Directory.systemTemp.path}/model-Hiyori-$framing$tag.png';
    await tester.runAsync(
      () => File(path).writeAsBytes(data!.buffer.asUint8List()),
    );
    debugPrint('novel-model-showcase: capture=$path');
    debugPrint(
      'novel-model-showcase: viewport=${boundary.size}, '
      'devicePixelRatio=${tester.view.devicePixelRatio}, '
      'capturePixelRatio=$ratio, pixels=${image!.width}x${image.height}, '
      'framing=$framing, testViewMetrics=${_captureWidth > 0}',
    );
    final modelCanvases = {
      for (final painter in inventory.sourcePartitions)
        if (painter.ops.whereType<PocketTextureTriangleOp>().any(
          (op) => op.asset.contains(_modelAsset),
        ))
          '${painter.width}x${painter.height}',
    };
    debugPrint('novel-model-showcase: modelCanvases=$modelCanvases');
    final meshLevels = <String, List<String>>{
      for (final painter in inventory.sourcePartitions)
        for (final entry in painter.meshImageLevels.entries)
          if (entry.key.contains(_modelAsset))
            entry.key: [
              for (final level in entry.value) '${level.width}x${level.height}',
            ],
    };
    const meshLevelsEnabled = bool.fromEnvironment(
      'POCKET_MESH_IMAGE_LEVELS',
      defaultValue: true,
    );
    if (meshLevelsEnabled) {
      expect(
        meshLevels.length,
        2,
        reason:
            'Both real Hiyori pages must have decoded minification variants.',
      );
      expect(meshLevels.values.every((levels) => levels.isNotEmpty), isTrue);
    } else {
      expect(meshLevels, isEmpty);
    }

    final metadata =
        jsonDecode(
              await rootBundle.loadString(
                'assets/apps/lantern/app.bytecode.json',
              ),
            )
            as Map<String, dynamic>;
    debugPrint(
      'POCKET_MODEL_CAPTURE ${jsonEncode({'path': path, 'logicalWidth': boundary.size.width, 'logicalHeight': boundary.size.height, 'devicePixelRatio': ratio, 'pixelWidth': image.width, 'pixelHeight': image.height, 'modelCanvases': modelCanvases.toList(), 'testViewMetrics': _captureWidth > 0, 'sourceSha256': metadata['sourceSha256'], 'payloadSha256': metadata['payloadSha256'], 'bytecodeBytes': metadata['bytecodeBytes'], 'meshImageLevelsEnabled': meshLevelsEnabled, 'meshImageLevels': meshLevels})}',
    );
  } finally {
    image?.dispose();
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.reportData = <String, dynamic>{
    'pocketAcceptance': {
      'required': ['model-showcase'],
      'completed': <String>[],
    },
  };
  late PathProviderPlatform originalPathProvider;
  late Directory isolatedSupportDirectory;
  late _IsolatedPathProvider isolatedPathProvider;

  setUp(() async {
    originalPathProvider = PathProviderPlatform.instance;
    isolatedSupportDirectory = await Directory.systemTemp.createTemp(
      'pocket-model-showcase-support-',
    );
    isolatedPathProvider = _IsolatedPathProvider(
      originalPathProvider,
      isolatedSupportDirectory.path,
    );
    PathProviderPlatform.instance = isolatedPathProvider;
  });

  tearDown(() async {
    PathProviderPlatform.instance = originalPathProvider;
    if (await isolatedSupportDirectory.exists()) {
      await isolatedSupportDirectory.delete(recursive: true);
    }
  });

  testWidgets(
    'Lantern model theater reuses replay, shared motion clock and releases real Live2D handles',
    (tester) async {
      if (_captureWidth > 0 || _captureHeight > 0) {
        expect(_captureWidth, greaterThan(0));
        expect(_captureHeight, greaterThan(0));
        expect(_captureDpr, anyOf(1, 2));
        tester.view.devicePixelRatio = _captureDpr.toDouble();
        tester.view.physicalSize = Size(
          (_captureWidth * _captureDpr).toDouble(),
          (_captureHeight * _captureDpr).toDouble(),
        );
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
      }
      final captureKey = GlobalKey();
      final system = PocketSystemHostController();
      final reportedStartupFailures = <String>{};
      system.addListener(() {
        for (final instance in system.instances) {
          final failure = instance.session.failure;
          if (failure == null) continue;
          final detail = '${instance.appId}: $failure';
          if (reportedStartupFailures.add(detail)) {
            debugPrint('POCKET_MODEL_STARTUP_FAILURE $detail');
          }
        }
      });
      addTearDown(system.dispose);
      PocketLive2dPlugin? live2d;
      final lantern = showcaseNativePolicies['pocket.demo.lantern']!;
      final policies = {
        ...showcaseNativePolicies,
        'pocket.demo.lantern': lantern.copyWith(
          pluginFactories: [
            createLanternAudioPlugin,
            (_) {
              final plugin = PocketLive2dPlugin.fromBundledCatalog(
                catalogAsset: 'assets/apps/lantern/novel.native-assets.json',
                assetPrefix: 'assets/apps/lantern/',
              );
              live2d = plugin;
              return plugin;
            },
          ],
        ),
      };

      try {
        await tester.pumpWidget(
          RepaintBoundary(
            key: captureKey,
            child: pocketHostApp(
              nativePolicies: policies,
              systemController: system,
            ),
          ),
        );
        // Another normal Demo can remain open while this test process starts.
        // Establish the tested foreground lifecycle explicitly, as the Profile
        // workload does, rather than depending on macOS window activation.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await _waitForAny(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ], 'Lantern title page');
        // Title shortcuts may be below the fold as the catalog grows. Their
        // real pointer accessibility is checked below; culled text is not a
        // declaration check.

        // The gallery row and title shortcut are two presentations of the
        // same StoryDefinition.replayEntries entry.
        await _tapAny(tester, const ['雾港纪念', 'Harbor memories']);
        await _waitForAny(tester, const [
          '回看 · 立绘试映',
          'Replay · Model theater',
        ], 'The model replay should also appear in the existing gallery');
        await _tapAny(tester, const ['返回', 'Back'], scroll: false);

        await _tapAny(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ]);
        await _waitForAny(tester, const [
          '23点08分',
          '11:08 p.m.',
          '23:08',
        ], 'A new main game should begin');
        final mainAutoBefore = await _waitForMainAuto(tester);
        expect(isolatedPathProvider.supportPathRequests, greaterThan(0));
        expect(
          await File(
            '${isolatedSupportDirectory.path}/pocket-platform-data/pocket_platform_data.json',
          ).exists(),
          isTrue,
          reason:
              'The test must inspect an actual platform-data file in its private directory',
        );
        expect(mainAutoBefore['state']['active']['id'], 'arrival_01');
        expect(live2d, isNotNull);
        expect(
          live2d!.activeModelCount,
          0,
          reason: 'The normal story uses its existing Spine actor',
        );

        await _tapAny(tester, const ['手札', 'Journal'], scroll: false);
        await _waitForAny(tester, const [
          '旅途手札',
          'Journey journal',
        ], 'The main journal should open');
        await _tapAny(tester, const ['返回扉页', 'Return to title']);
        await _waitForAny(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ], 'The title page should return');
        await _tapAny(tester, const ['立绘试映', 'Model theater']);

        await _waitForAny(tester, const [
          '独立的角色试映',
          'standalone character showcase',
        ], 'The replay should explain that it is isolated from the main story');
        await _tapAny(tester, const [
          '原创 Mira · Spine',
          'Original Mira · Spine',
        ]);
        await guest.waitForContaining(tester, 'Mira Spine');
        for (
          var attempt = 0;
          attempt < 100 && _miraOps(tester).length <= 10;
          attempt++
        ) {
          await tester.pump(const Duration(milliseconds: 30));
          if (attempt % 10 == 9) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 1)),
            );
          }
        }
        expect(_miraOps(tester), hasLength(greaterThan(10)));
        expect(live2d!.activeModelCount, 0);
        await _tapAny(tester, const ['alert · Alert', 'alert · 警觉']);
        await _tapAny(tester, const ['返回试映目录', 'Return to showcase catalog']);

        await _tapAny(tester, const [
          '官方 Hiyori · Live2D',
          'Official Hiyori · Live2D',
        ]);
        await _waitForAny(tester, const [
          'Live2D 官方 Hiyori',
          'Live2D Hiyori',
        ], 'The Hiyori source notice should be painted');
        await _tapAny(tester, const ['Idle 1 · Sway', 'Idle 1 · 摆动']);
        await _waitForAny(tester, const [
          '听，雾里有回声',
          'Listen, an echo stirs',
        ], 'Selecting a motion must show the actor without the action menu');
        expect(
          _firstText(tester, const ['Idle 0 · Breathing', 'Idle 0 · 呼吸']),
          isNull,
        );
        await _waitForLive2d(tester, live2d!);
        final initialOps = _modelOps(tester);
        expect(initialOps.map((op) => op.asset).toSet(), hasLength(2));
        final initialPainters = _painterInventory(tester).sourcePartitions;
        for (final asset in initialOps.map((op) => op.asset).toSet()) {
          final image = initialPainters
              .map((painter) => painter.images[asset])
              .whereType<ui.Image>()
              .first;
          expect(
            image.width,
            2048,
            reason: 'The real atlas must retain source detail: $asset',
          );
          expect(
            image.height,
            2048,
            reason: 'The real atlas must retain source detail: $asset',
          );
        }
        final allOps = initialPainters.expand((painter) => painter.ops);
        expect(allOps.whereType<PocketMeshMaskBeginOp>(), isNotEmpty);
        expect(allOps.whereType<PocketMeshLayerBeginOp>(), isNotEmpty);
        final beforeMotion = _modelPositions(tester);
        expect(beforeMotion, isNotEmpty);
        await _waitForModelMotion(
          tester,
          beforeMotion,
          _modelPositionsByTriangle(tester),
          initialOps.length,
        );
        await _captureHiyori(tester, captureKey);

        // Real host lifecycle pause freezes the existing shared actor without
        // releasing its handle. Resume advances the same model instance.
        final binding = tester.binding;
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        // Let a native update that was already in flight when pause arrived
        // finish, then establish the stable paused baseline.
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 150)),
        );
        final pausedPositions = _modelPositions(tester);
        final pausedPositionsByTriangle = _modelPositionsByTriangle(tester);
        final pausedTriangleCount = _modelOps(tester).length;
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 450)),
        );
        expect(live2d!.activeModelCount, 1);
        expect(_modelPositions(tester), pausedPositions);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await _waitForModelMotion(
          tester,
          pausedPositions,
          pausedPositionsByTriangle,
          pausedTriangleCount,
        );
        expect(live2d!.activeModelCount, 1);

        await _tapAny(tester, const [
          'Idle 1 · 面部近景',
          'Idle 1 · Face close-up',
        ]);
        await _waitForAny(tester, const [
          '听，雾里有回声',
          'Listen, an echo stirs',
        ], 'The face close-up must enter the unobstructed wait scene');
        await _waitForLive2d(tester, live2d!);
        expect(live2d!.activeModelCount, 1);
        await _captureHiyori(tester, captureKey, framing: 'closeup');
        await _tapAny(tester, const ['返回动作目录', 'Return to action menu']);
        // Each authored full-body scene must render; checking only one motion
        // would miss an independently misplaced action or its transient pose.
        for (final motion in const [
          (['Idle 0 · Breathing', 'Idle 0 · 呼吸'], 'full-idle0'),
          (['TapBody · Touch reaction', 'TapBody · 触碰反应'], 'full-tapbody'),
        ]) {
          await _tapAny(tester, motion.$1);
          await _waitForAny(tester, const [
            '听，雾里有回声',
            'Listen, an echo stirs',
          ], 'Each full-body motion must reach the unobstructed wait scene');
          await _waitForLive2d(tester, live2d!);
          await _captureHiyori(tester, captureKey, framing: motion.$2);
          await _tapAny(tester, const ['返回动作目录', 'Return to action menu']);
        }

        // Returning to the catalog removes the stage actor and releases the
        // actual Cubism handle; selecting Live2D again must load a new handle.
        await _tapAny(tester, const ['返回试映目录', 'Return to showcase catalog']);
        await _waitForRelease(tester, live2d!);
        await _tapAny(tester, const [
          '原创 Mira · Spine',
          'Original Mira · Spine',
        ]);
        await guest.waitForContaining(tester, 'Mira Spine');
        expect(live2d!.activeModelCount, 0);
        await _tapAny(tester, const ['返回试映目录', 'Return to showcase catalog']);
        await _tapAny(tester, const [
          '官方 Hiyori · Live2D',
          'Official Hiyori · Live2D',
        ]);
        await _waitForAny(tester, const [
          'Live2D 官方 Hiyori',
          'Live2D Hiyori',
        ], 'The Hiyori source notice should be painted again after reentry');
        await _tapAny(tester, const ['Idle 0 · Breathing', 'Idle 0 · 呼吸']);
        await _waitForLive2d(tester, live2d!);
        await _tapAny(tester, const [
          '返回原旅程',
          'Return to journey',
        ], scroll: false);
        await _waitForRelease(tester, live2d!);

        final mainAutoAfter = await tester.runAsync(_readDiskAuto);
        expect(
          mainAutoAfter,
          equals(mainAutoBefore),
          reason:
              'An isolated showcase replay must not overwrite the disk main-game autosave',
        );
        await _waitForAny(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ], 'Replay should return to its title');
        await _tapAny(tester, const [
          '续写 · 继续旅程',
          'Continue · Resume your journey',
        ]);
        await _waitForAny(tester, const [
          '23点08分',
          '11:08 p.m.',
          '23:08',
        ], 'The main story should still resume');
        debugPrint(
          'novel-model-showcase: Spine and two-page masked Hiyori rendered; '
          'background resumed, replay handles released, main autosave unchanged',
        );
      } finally {
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 150)),
        );
      }
      binding.reportData!['pocketAcceptance'] = {
        'required': ['model-showcase'],
        'completed': ['model-showcase'],
      };
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
