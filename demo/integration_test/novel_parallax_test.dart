import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

const _dpr = 2.0;
const _logicalViewport = Size(390, 844);
const _lanternPath = 'art/fx/parallax-lantern.png';
const _mistPath = 'art/fx/sea-mist.png';
const _stationPath = 'art/station.png';
const _menuPrompt = <String>[
  '选择下一步镜头或图层动作。',
  'Choose a camera or layer change.',
];
const _panAction = <String>[
  '平移镜头，比较远近层。',
  'Pan the camera and compare the layers.',
];
const _zoomAction = <String>['推近灯塔，观察景深。', 'Move closer to the lighthouse.'];
const _clearAction = <String>['暂时收起叠层。', 'Clear the overlay layers.'];
const _restoreAction = <String>['恢复灯火与雾。', 'Restore the lantern and mist.'];
const _exitAction = <String>[
  '结束试映，返回原旅程。',
  'End the preview and return to the journey.',
];

final _isolatedSupport = IsolatedNovelSupportDirectory();
late String _normalSupportPath;
late List<int>? _normalStoreBefore;

final class _PaintedImage {
  const _PaintedImage({
    required this.widget,
    required this.painter,
    required this.op,
    required this.image,
  });

  final CustomPaint widget;
  final PocketCanvasPainter painter;
  final PocketImageOp op;
  final ui.Image image;
}

final class _AlphaBounds {
  const _AlphaBounds({
    required this.left,
    required this.top,
    required this.right,
    required this.bottom,
    required this.transparentPixels,
    required this.visiblePixels,
    required this.rgbaSha256,
  });

  final int left;
  final int top;
  final int right;
  final int bottom;
  final int transparentPixels;
  final int visiblePixels;
  final String rgbaSha256;
}

String _compact(String value) => value.replaceAll(RegExp(r'\s+'), ' ');

bool _paintsAny(Iterable<String> labels, Iterable<String> candidates) =>
    labels.any(
      (label) => candidates.any(
        (candidate) => _compact(label).contains(_compact(candidate)),
      ),
    );

String? _paintedCandidate(WidgetTester tester, Iterable<String> candidates) {
  final labels = guest.texts(tester);
  for (final candidate in candidates) {
    for (final label in labels) {
      if (_compact(label).contains(_compact(candidate))) return label;
    }
  }
  return null;
}

Future<void> _waitForAny(
  WidgetTester tester,
  Iterable<String> candidates,
) async {
  for (var attempt = 0; attempt < 180; attempt++) {
    if (_paintsAny(guest.texts(tester), candidates)) return;
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail('None of $candidates was painted. Actual: ${guest.texts(tester)}');
}

Future<String> _tapAny(
  WidgetTester tester,
  Iterable<String> candidates, {
  bool scroll = true,
}) async {
  for (var attempt = 0; attempt < 180; attempt++) {
    final label = _paintedCandidate(tester, candidates);
    if (label != null) {
      await guest.tapGuest(tester, label, scroll: scroll);
      return label;
    }
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail(
    'Could not find a painted action in $candidates; ${guest.texts(tester)}',
  );
}

Future<void> _advanceToParallaxMenu(WidgetTester tester) async {
  for (var attempt = 0; attempt < 180; attempt++) {
    if (_paintsAny(guest.texts(tester), _menuPrompt)) return;
    final next = _paintedCandidate(tester, const [
      '轻触继续  ›',
      'Tap to continue  ›',
      '轻触显全',
      'Tap to reveal all',
    ]);
    if (next != null) {
      await guest.tapGuest(tester, next, scroll: false);
    } else {
      await tester.pump(const Duration(milliseconds: 40));
    }
  }
  fail('Parallax choice menu did not appear; actual=${guest.texts(tester)}');
}

Future<void> _advanceToLineAndMenu(
  WidgetTester tester,
  Iterable<String> line,
) async {
  await _waitForAny(tester, line);
  await _advanceToParallaxMenu(tester);
}

_PaintedImage _paintedImage(WidgetTester tester, String suffix) {
  for (final widget in guest.painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketImageOp>()) {
      if (!op.asset.endsWith(suffix)) continue;
      final image = painter.images[op.asset];
      if (image != null) {
        return _PaintedImage(
          widget: widget,
          painter: painter,
          op: op,
          image: image,
        );
      }
    }
  }
  fail('Guest did not paint and decode image asset ending in $suffix');
}

List<PocketImageOp> _stageImageOps(WidgetTester tester, String suffix) => [
  for (final widget in guest.painters(tester))
    for (final op
        in (widget.painter! as PocketCanvasPainter).ops
            .whereType<PocketImageOp>())
      if (op.asset.endsWith(suffix)) op,
];

String _stageGeometry(WidgetTester tester) {
  final paths = <String>[_stationPath, _lanternPath, _mistPath];
  final result = <Object?>[];
  for (final suffix in paths) {
    result.addAll([
      for (final op in _stageImageOps(tester, suffix))
        <String, Object?>{
          'asset': op.asset,
          'x': op.x.toStringAsFixed(4),
          'y': op.y.toStringAsFixed(4),
          'width': op.width.toStringAsFixed(4),
          'height': op.height.toStringAsFixed(4),
          'uv': op.uv?.map((value) => value.toStringAsFixed(6)).toList(),
        },
    ]);
  }
  return jsonEncode(result);
}

Future<String> _waitForStableGeometry(
  WidgetTester tester, {
  required bool expectLayers,
}) async {
  var previous = '';
  var stableSamples = 0;
  for (var attempt = 0; attempt < 180; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final layerCount =
        _stageImageOps(tester, _lanternPath).length +
        _stageImageOps(tester, _mistPath).length;
    final signature = _stageGeometry(tester);
    if (_stageImageOps(tester, _stationPath).isNotEmpty &&
        (expectLayers ? layerCount >= 2 : layerCount == 0)) {
      if (signature == previous) {
        stableSamples++;
      } else {
        stableSamples = 0;
        previous = signature;
      }
      if (stableSamples >= 3) return signature;
    } else {
      stableSamples = 0;
      previous = '';
    }
  }
  fail(
    'Parallax geometry did not settle (expectLayers=$expectLayers); '
    'lantern=${_stageImageOps(tester, _lanternPath).length}, '
    'mist=${_stageImageOps(tester, _mistPath).length}',
  );
}

Future<_AlphaBounds> _alphaBounds(WidgetTester tester, ui.Image image) async {
  final data = await tester.runAsync(
    () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
  );
  expect(data, isNotNull);
  final bytes = data!.buffer.asUint8List(
    data.offsetInBytes,
    data.lengthInBytes,
  );
  var left = image.width;
  var top = image.height;
  var right = -1;
  var bottom = -1;
  var transparent = 0;
  var visible = 0;
  for (var y = 0; y < image.height; y++) {
    for (var x = 0; x < image.width; x++) {
      final alpha = bytes[(y * image.width + x) * 4 + 3];
      if (alpha == 0) {
        transparent++;
      } else if (alpha >= 24) {
        visible++;
        left = math.min(left, x);
        top = math.min(top, y);
        right = math.max(right, x);
        bottom = math.max(bottom, y);
      }
    }
  }
  expect(transparent, greaterThan(0));
  expect(visible, greaterThan(0));
  expect(right, greaterThanOrEqualTo(left));
  expect(bottom, greaterThanOrEqualTo(top));
  return _AlphaBounds(
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    transparentPixels: transparent,
    visiblePixels: visible,
    rgbaSha256: pocketSha256(bytes),
  );
}

Future<Uint8List> _capture(
  WidgetTester tester,
  GlobalKey captureKey,
  Directory output,
  String name,
) async {
  await tester.pump(const Duration(milliseconds: 80));
  final boundary =
      captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(() => boundary.toImage(pixelRatio: _dpr));
  try {
    final data = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    final bytes = data!.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final file = File('${output.path}/$name.png');
    await tester.runAsync(() => file.writeAsBytes(bytes, flush: true));
    debugPrint(
      'LANTERN_PARALLAX_CAPTURE ${jsonEncode({'name': name, 'path': file.path, 'width': image!.width, 'height': image.height, 'sha256': pocketSha256(bytes)})}',
    );
    return Uint8List.fromList(bytes);
  } finally {
    image?.dispose();
  }
}

Rect _visibleAlphaScreenshotRect(
  WidgetTester tester,
  GlobalKey captureKey,
  _PaintedImage painted,
  _AlphaBounds alpha,
) {
  final op = painted.op;
  final uv = op.uv ?? const <double>[0, 0, 1, 1];
  expect(uv, hasLength(4));
  final uWidth = uv[2] - uv[0];
  final vHeight = uv[3] - uv[1];
  expect(uWidth, greaterThan(0));
  expect(vHeight, greaterThan(0));
  final sourceLeft = alpha.left / painted.image.width;
  final sourceTop = alpha.top / painted.image.height;
  final sourceRight = (alpha.right + 1) / painted.image.width;
  final sourceBottom = (alpha.bottom + 1) / painted.image.height;
  var stageRect =
      Rect.fromLTRB(
        op.x + (sourceLeft - uv[0]) / uWidth * op.width,
        op.y + (sourceTop - uv[1]) / vHeight * op.height,
        op.x + (sourceRight - uv[0]) / uWidth * op.width,
        op.y + (sourceBottom - uv[1]) / vHeight * op.height,
      ).intersect(
        Rect.fromLTWH(0, 0, painted.painter.width, painted.painter.height),
      );
  final clip = op.clip;
  if (clip != null) {
    stageRect = stageRect.intersect(
      Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
    );
  }
  expect(stageRect.isEmpty, isFalse, reason: 'Layer alpha is visible in stage');

  final painterBox = tester.renderObject<RenderBox>(
    find.byWidget(painted.widget),
  );
  final boundaryBox = tester.renderObject<RenderBox>(find.byKey(captureKey));
  final stageScaleX = painterBox.size.width / painted.painter.width;
  final stageScaleY = painterBox.size.height / painted.painter.height;
  final globalTopLeft = painterBox.localToGlobal(
    Offset(stageRect.left * stageScaleX, stageRect.top * stageScaleY),
  );
  final globalBottomRight = painterBox.localToGlobal(
    Offset(stageRect.right * stageScaleX, stageRect.bottom * stageScaleY),
  );
  final boundaryOrigin = boundaryBox.localToGlobal(Offset.zero);
  return Rect.fromPoints(
    (globalTopLeft - boundaryOrigin) * _dpr,
    (globalBottomRight - boundaryOrigin) * _dpr,
  );
}

Future<int> _countScreenshotDiff(
  WidgetTester tester,
  Uint8List beforePng,
  Uint8List afterPng,
  Rect crop,
) async {
  final decoded = await tester.runAsync(() async {
    final beforeCodec = await ui.instantiateImageCodec(beforePng);
    final afterCodec = await ui.instantiateImageCodec(afterPng);
    try {
      final before = (await beforeCodec.getNextFrame()).image;
      final after = (await afterCodec.getNextFrame()).image;
      if (before.width != after.width || before.height != after.height) {
        throw StateError('Captured screenshot dimensions changed');
      }
      final beforeData = await before.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      final afterData = await after.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      try {
        final a = beforeData!.buffer.asUint8List(
          beforeData.offsetInBytes,
          beforeData.lengthInBytes,
        );
        final b = afterData!.buffer.asUint8List(
          afterData.offsetInBytes,
          afterData.lengthInBytes,
        );
        final left = crop.left.floor().clamp(0, before.width).toInt();
        final top = crop.top.floor().clamp(0, before.height).toInt();
        final right = crop.right.ceil().clamp(0, before.width).toInt();
        final bottom = crop.bottom.ceil().clamp(0, before.height).toInt();
        var changed = 0;
        for (var y = top; y < bottom; y++) {
          for (var x = left; x < right; x++) {
            final index = (y * before.width + x) * 4;
            final delta =
                (a[index] - b[index]).abs() +
                (a[index + 1] - b[index + 1]).abs() +
                (a[index + 2] - b[index + 2]).abs() +
                (a[index + 3] - b[index + 3]).abs();
            if (delta > 32) changed++;
          }
        }
        return <int>[changed, right - left, bottom - top];
      } finally {
        before.dispose();
        after.dispose();
      }
    } finally {
      beforeCodec.dispose();
      afterCodec.dispose();
    }
  });
  debugPrint(
    'LANTERN_PARALLAX_PIXEL_DIFF ${jsonEncode({'pixels': decoded![0], 'cropWidth': decoded[1], 'cropHeight': decoded[2], 'threshold': 32})}',
  );
  return decoded[0];
}

Future<Map<String, dynamic>?> _readDiskAuto(String supportPath) async {
  final file = File(
    '$supportPath/pocket-platform-data/pocket_platform_data.json',
  );
  if (!await file.exists()) return null;
  try {
    final root = jsonDecode(await file.readAsString());
    if (root is! Map) return null;
    final private = root['private'];
    if (private is! Map) return null;
    final app = private['pocket.demo.lantern'];
    if (app is! Map) return null;
    final slot = app['lantern.slot.auto'];
    return slot is Map ? Map<String, dynamic>.from(slot) : null;
  } on Object {
    return null;
  }
}

Future<String> _waitForMainAuto(WidgetTester tester) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    final slot = await tester.runAsync(
      () => _readDiskAuto(_isolatedSupport.path),
    );
    if (slot?['state']?['active']?['id'] == 'arrival_01') {
      return jsonEncode(slot);
    }
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 5 == 4) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
    }
  }
  fail('The real main-story auto-save did not reach arrival_01.');
}

Future<void> _scrollToGalleryReplay(
  WidgetTester tester,
  List<String> labels,
) async {
  final initialLabel = _paintedCandidate(tester, labels);
  expect(
    initialLabel,
    isNotNull,
    reason: 'The gallery paints the replay entry.',
  );
  final initialPoint = initialLabel == null
      ? null
      : guest.pointFor(tester, initialLabel);
  expect(
    initialPoint,
    isNotNull,
    reason: 'The replay title is visible inside the real gallery list.',
  );
  final label = initialLabel!;
  final start = initialPoint!;
  final gesture = await tester.startGesture(start);
  for (var step = 0; step < 6; step++) {
    await gesture.moveBy(const Offset(0, -14));
    await tester.pump(const Duration(milliseconds: 16));
  }
  await gesture.up();
  await tester.pump(const Duration(milliseconds: 140));
  final scrolledPoint = guest.pointFor(tester, label);
  final scrollDelta = scrolledPoint == null
      ? null
      : (scrolledPoint - start).distance;
  expect(
    scrollDelta == null || scrollDelta > 8,
    isTrue,
    reason:
        'A real list drag must move the replay entry or clip it out of view.',
  );
  final stablePoint = await guest.reveal(tester, label, scroll: true);
  await guest.tapGuest(tester, label, scroll: false);
  debugPrint(
    'LANTERN_PARALLAX_GALLERY_SCROLL ${jsonEncode({
      'drags': 1,
      'label': label,
      'start': [start.dx, start.dy],
      'afterDrag': scrolledPoint == null ? null : [scrolledPoint.dx, scrolledPoint.dy],
      'stableBeforeTap': [stablePoint.dx, stablePoint.dy],
    })}',
  );
}

Future<Map<String, Object?>> _assetFingerprint(WidgetTester tester) async {
  final qjbcData = await rootBundle.load('assets/apps/lantern/app.qjbc');
  final metadataText = await rootBundle.loadString(
    'assets/apps/lantern/app.bytecode.json',
  );
  final metadataBytes = await rootBundle.load(
    'assets/apps/lantern/app.bytecode.json',
  );
  final qjbc = qjbcData.buffer.asUint8List(
    qjbcData.offsetInBytes,
    qjbcData.lengthInBytes,
  );
  final metadataRaw = metadataBytes.buffer.asUint8List(
    metadataBytes.offsetInBytes,
    metadataBytes.lengthInBytes,
  );
  final metadata = jsonDecode(metadataText) as Map<String, dynamic>;
  final headerBytes = metadata['headerBytes'] as int;
  expect(qjbc.length, metadata['bytecodeBytes']);
  expect(headerBytes, greaterThan(0));
  expect(
    pocketSha256(qjbc.sublist(headerBytes)),
    metadata['payloadSha256'],
    reason: 'Bundled Guest QJBC must match its actual bytecode metadata.',
  );
  final result = <String, Object?>{
    'qjbcBytes': qjbc.length,
    'qjbcSha256': pocketSha256(qjbc),
    'metadataSha256': pocketSha256(metadataRaw),
    'sourceSha256': metadata['sourceSha256'],
    'payloadSha256': metadata['payloadSha256'],
  };
  debugPrint('LANTERN_PARALLAX_FINGERPRINT ${jsonEncode(result)}');
  return result;
}

Future<void> _assertNormalStoreUnchanged() async {
  final file = File(
    '$_normalSupportPath/pocket-platform-data/pocket_platform_data.json',
  );
  final after = await file.exists() ? await file.readAsBytes() : null;
  expect(
    after,
    equals(_normalStoreBefore),
    reason: 'Lantern test writes only inside its isolated support directory.',
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  setUp(() async {
    _normalSupportPath = (await getApplicationSupportDirectory()).path;
    final normalStore = File(
      '$_normalSupportPath/pocket-platform-data/pocket_platform_data.json',
    );
    _normalStoreBefore = await normalStore.exists()
        ? await normalStore.readAsBytes()
        : null;
    await _isolatedSupport.install();
    final activeSupport = await getApplicationSupportDirectory();
    expect(activeSupport.path, _isolatedSupport.path);
    expect(activeSupport.path, isNot(_normalSupportPath));
    expect(
      activeSupport.path.startsWith(
        '${Directory.systemTemp.path}${Platform.pathSeparator}',
      ),
      isTrue,
    );
  });

  tearDown(() async => _isolatedSupport.restore());

  testWidgets(
    'real 390 logical px DPR2 parallax replay decodes, moves, clears and restores its image layers',
    (tester) async {
      tester.view.physicalSize = const Size(780, 1688);
      tester.view.devicePixelRatio = _dpr;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final captureDirectory = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-lantern-parallax-'),
      );
      expect(captureDirectory, isNotNull);
      final output = captureDirectory!;
      final captureKey = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(key: captureKey, child: pocketHostApp()),
      );
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      });
      expect(
        tester.renderObject<RenderBox>(find.byKey(captureKey)).size,
        _logicalViewport,
      );
      final fingerprint = await _assetFingerprint(tester);

      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
      await _waitForAny(tester, const [
        '启程 · 开始新的故事',
        'Begin · Start a new story',
      ]);
      await _tapAny(tester, const [
        '启程 · 开始新的故事',
        'Begin · Start a new story',
      ], scroll: false);
      final autoStarted = await _waitForMainAuto(tester);
      expect(jsonDecode(autoStarted)['state']['active']['id'], 'arrival_01');
      final supportFile = File(
        '${_isolatedSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      expect(await supportFile.exists(), isTrue);

      await _tapAny(tester, const ['手札', 'Journal'], scroll: false);
      await _waitForAny(tester, const ['旅途手札', 'Journey journal']);
      await _tapAny(tester, const ['返回扉页', 'Return to title'], scroll: false);
      await _waitForAny(tester, const [
        '启程 · 开始新的故事',
        'Begin · Start a new story',
      ]);
      await _tapAny(tester, const ['雾港纪念', 'Harbor memories'], scroll: false);
      await _waitForAny(tester, const [
        '已收集',
        'Collected',
        '结局回看',
        'Story replays',
      ]);
      // The long gallery is traversed with the actual guest drag bridge; this
      // is not a direct replay-state injection or a host-side route shortcut.
      final replayCandidates = <String>[
        '回看 · 灯火与雾的层次',
        'Replay · Lantern, Fog, and Distance',
      ];
      await _scrollToGalleryReplay(tester, replayCandidates);

      final autoBeforeReplay = await _readDiskAuto(_isolatedSupport.path);
      expect(autoBeforeReplay, isNotNull);
      expect(autoBeforeReplay!['state']?['active']?['id'], 'arrival_01');
      final autoBeforeReplayBytes = jsonEncode(autoBeforeReplay);

      await _advanceToParallaxMenu(tester);
      final identityGeometry = await _waitForStableGeometry(
        tester,
        expectLayers: true,
      );
      final lantern = _paintedImage(tester, _lanternPath);
      final mist = _paintedImage(tester, _mistPath);
      expect(lantern.image.width, 2048);
      expect(lantern.image.height, 1024);
      final lanternAlpha = await _alphaBounds(tester, lantern.image);
      final mistAlpha = await _alphaBounds(tester, mist.image);
      fingerprint['lanternDecodedRgbaSha256'] = lanternAlpha.rgbaSha256;
      fingerprint['mistDecodedRgbaSha256'] = mistAlpha.rgbaSha256;
      expect(lanternAlpha.transparentPixels, greaterThan(0));
      expect(mistAlpha.transparentPixels, greaterThan(0));
      expect(_stageImageOps(tester, _stationPath), isNotEmpty);
      expect(_stageImageOps(tester, _lanternPath), isNotEmpty);
      expect(_stageImageOps(tester, _mistPath), isNotEmpty);
      final initialLanternRegion = _visibleAlphaScreenshotRect(
        tester,
        captureKey,
        lantern,
        lanternAlpha,
      );
      final initialMistRegion = _visibleAlphaScreenshotRect(
        tester,
        captureKey,
        mist,
        mistAlpha,
      );
      final initialScreenshot = await _capture(
        tester,
        captureKey,
        output,
        'layers-visible',
      );

      await _tapAny(tester, _panAction);
      await _waitForAny(tester, const ['镜头向左掠过', 'The camera sweeps left']);
      final pannedGeometry = await _waitForStableGeometry(
        tester,
        expectLayers: true,
      );
      expect(
        pannedGeometry,
        isNot(identityGeometry),
        reason: 'The real pan option changes painted image-plane geometry.',
      );
      await _advanceToLineAndMenu(tester, const [
        '镜头向左掠过',
        'The camera sweeps left',
      ]);

      await _tapAny(tester, _zoomAction);
      await _waitForAny(tester, const ['镜头慢慢推近', 'The camera pushes in']);
      final zoomGeometry = await _waitForStableGeometry(
        tester,
        expectLayers: true,
      );
      expect(
        zoomGeometry,
        isNot(pannedGeometry),
        reason: 'The real zoom option changes painted image-plane geometry.',
      );
      final zoomScreenshot = await _capture(
        tester,
        captureKey,
        output,
        'camera-zoom',
      );
      expect(zoomScreenshot, isNotEmpty);
      await _advanceToLineAndMenu(tester, const [
        '镜头慢慢推近',
        'The camera pushes in',
      ]);

      await _tapAny(tester, _clearAction);
      await _waitForAny(tester, const [
        '灯火与雾暂时收起',
        'The lantern and fog recede',
      ]);
      await _advanceToParallaxMenu(tester);
      final clearedGeometry = await _waitForStableGeometry(
        tester,
        expectLayers: false,
      );
      expect(clearedGeometry, isNot(identityGeometry));
      expect(_stageImageOps(tester, _stationPath), isNotEmpty);
      expect(_stageImageOps(tester, _lanternPath), isEmpty);
      expect(_stageImageOps(tester, _mistPath), isEmpty);
      final clearedScreenshot = await _capture(
        tester,
        captureKey,
        output,
        'layers-cleared',
      );
      final lanternPixelDiff = await _countScreenshotDiff(
        tester,
        initialScreenshot,
        clearedScreenshot,
        initialLanternRegion,
      );
      final mistPixelDiff = await _countScreenshotDiff(
        tester,
        initialScreenshot,
        clearedScreenshot,
        initialMistRegion,
      );
      expect(
        lanternPixelDiff,
        greaterThan(100),
        reason:
            'Clearing removes actual lamp pixels from the rendered capture.',
      );
      expect(
        mistPixelDiff,
        greaterThan(100),
        reason:
            'Clearing removes actual mist pixels from the rendered capture.',
      );

      await _tapAny(tester, _restoreAction);
      await _waitForAny(tester, const [
        '雾与灯火回到画面',
        'The mist and lantern return',
      ]);
      await _advanceToParallaxMenu(tester);
      await _waitForStableGeometry(tester, expectLayers: true);
      expect(_stageImageOps(tester, _lanternPath), isNotEmpty);
      expect(_stageImageOps(tester, _mistPath), isNotEmpty);

      await _tapAny(tester, _exitAction);
      await _waitForAny(tester, const ['试映结束。点击右上角', 'Preview ended. Choose']);
      await _tapAny(tester, const [
        '返回原旅程',
        'Return to journey',
      ], scroll: false);
      await _waitForAny(tester, const ['已收集', 'Collected']);
      await tester.pump(const Duration(milliseconds: 400));
      final autoAfterReplay = await _readDiskAuto(_isolatedSupport.path);
      expect(autoAfterReplay, isNotNull);
      expect(jsonEncode(autoAfterReplay), autoBeforeReplayBytes);
      await _assertNormalStoreUnchanged();

      final captureFiles = await output
          .list()
          .where((entry) => entry is File && entry.path.endsWith('.png'))
          .toList();
      expect(captureFiles, hasLength(3));
      debugPrint(
        'LANTERN_PARALLAX_FLUTTER_ACCEPTANCE ${jsonEncode({
          'testViewLogical': [_logicalViewport.width, _logicalViewport.height],
          'testViewDpr': _dpr,
          'capturePhysicalPixels': [780, 1688],
          'physicalPhoneOrOsRotationTested': false,
          'supportDirectory': _isolatedSupport.path,
          'mainAutoSaveActiveId': 'arrival_01',
          'mainAutoSaveUnchangedAfterReplay': true,
          'cameraChangedGeometry': identityGeometry != pannedGeometry && pannedGeometry != zoomGeometry,
          'lampDecoded': [lantern.image.width, lantern.image.height],
          'lampAlpha': {'transparent': lanternAlpha.transparentPixels, 'visible': lanternAlpha.visiblePixels},
          'mistAlpha': {'transparent': mistAlpha.transparentPixels, 'visible': mistAlpha.visiblePixels},
          'layerPixelDiff': {'lamp': lanternPixelDiff, 'mist': mistPixelDiff},
          'captureDirectory': output.path,
          'captures': captureFiles.map((file) => file.path).toList(),
          'artifact': fingerprint,
        })}',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
