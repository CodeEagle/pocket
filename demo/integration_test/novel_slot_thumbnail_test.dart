import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

// `pocket_sdk` owns the pinned crypto dependency used by PocketImageStore.
// ignore: depend_on_referenced_packages
import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show PocketCanvasPainter, PocketImageOp, PocketView;
import 'package:pocket_host/main.dart' show pocketHostApp;
import 'package:pocket_sdk/pocket_sdk.dart' show PocketSystemHostController;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';
import 'novel_test_driver.dart' as novel;

const _appId = 'pocket.demo.lantern';
const _slotKey = 'lantern.slot.1';
const _firstStoryLine = 'arrival_01';
const _secondStoryLine = 'arrival_02';
const _pngSignature = <int>[137, 80, 78, 71, 13, 10, 26, 10];
const _launchSettleBudget = Duration(seconds: 60);

final class _PaintedThumbnail {
  const _PaintedThumbnail({
    required this.asset,
    required this.image,
    required this.globalRect,
    required this.contentRect,
    required this.clipRect,
    required this.canvasWidth,
    required this.canvasHeight,
  });

  final String asset;
  final ui.Image image;

  /// The native texture's visible source crop after its PocketImageOp clip.
  final Rect globalRect;

  /// The full native PocketImageOp destination, including padded texels.
  final Rect contentRect;
  final Rect? clipRect;
  final double canvasWidth;
  final double canvasHeight;
}

final class _PreviewCapture {
  const _PreviewCapture({
    required this.pngBytes,
    required this.sampledColors,
    required this.path,
  });

  final Uint8List pngBytes;
  final int sampledColors;
  final String path;
}

String _activeId(Map<String, dynamic>? save) {
  final state = save?['state'];
  if (state is! Map) return '';
  final active = state['active'];
  return active is Map ? '${active['id'] ?? ''}' : '';
}

String _thumbnailId(Map<String, dynamic> save) {
  final raw = save['thumbnail'];
  if (raw is! Map) return '';
  return '${raw['id'] ?? ''}';
}

Future<void> _frame(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 30));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 10)),
  );
}

String _systemHostFacts(PocketSystemHostController host) => [
  for (final instance in host.instances)
    '${instance.appId}/${instance.instanceId}:ready=${instance.ready},'
        'firstFrame=${instance.firstFrameReady},presented=${instance.isPresented},'
        'foreground=${instance.foreground},failure=${instance.session.failure},'
        'lastError=${instance.session.lastError}',
].toString();

Future<int> _waitForLanternPage(
  WidgetTester tester,
  PocketSystemHostController host,
  String expectedText,
) async {
  final clock = Stopwatch()..start();
  while (clock.elapsed < _launchSettleBudget) {
    final painted = guest.texts(tester);
    if (painted.contains(expectedText)) return clock.elapsedMilliseconds;

    final lantern = host.instances
        .where((instance) => instance.appId == _appId)
        .toList();
    final failed = lantern.where(
      (instance) => instance.session.failure != null,
    );
    if (failed.isNotEmpty) {
      fail(
        'Lantern failed before painting "$expectedText"; '
        'hostFacts=${_systemHostFacts(host)}; painted=$painted',
      );
    }

    await _frame(tester);
    // Keep feeding real Flutter frames while allowing async bytecode/PAK and
    // native image loading to advance on wall time. This is a wait only: the
    // triggering app tile is never tapped a second time.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  }
  fail(
    'Timed out after ${_launchSettleBudget.inSeconds}s waiting for Lantern '
    'to paint "$expectedText"; hostFacts=${_systemHostFacts(host)}; '
    'painted=${guest.texts(tester)}',
  );
}

Future<Map<String, dynamic>?> _readSlot(
  WidgetTester tester,
  String supportPath,
  String slot,
) async {
  final file = File(
    '$supportPath/pocket-platform-data/pocket_platform_data.json',
  );
  return tester.runAsync<Map<String, dynamic>?>(() async {
    try {
      if (!await file.exists()) return null;
      final root = jsonDecode(await file.readAsString()) as Map;
      final private = root['private'] as Map;
      final app = private[_appId] as Map?;
      final value = app?['lantern.slot.$slot'];
      return value is Map ? Map<String, dynamic>.from(value) : null;
    } on Object {
      return null;
    }
  });
}

Future<Map<String, dynamic>> _waitForSlot(
  WidgetTester tester,
  String supportPath,
  String slot,
  bool Function(Map<String, dynamic>) matches,
) async {
  Map<String, dynamic>? last;
  for (var attempt = 0; attempt < 400; attempt++) {
    last = await _readSlot(tester, supportPath, slot);
    if (last != null && matches(last)) return last;
    await _frame(tester);
  }
  fail(
    'Native app-private storage did not reach slot=$slot; '
    'active=${_activeId(last)}, thumbnail=${last == null ? 'none' : _thumbnailId(last)}, '
    'painted=${guest.texts(tester)}',
  );
}

Future<void> _advanceUntil(WidgetTester tester, String fragment) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    if (guest.texts(tester).any((text) => text.contains(fragment))) return;
    final point =
        guest.pointFor(tester, '轻触继续  ›') ?? guest.pointFor(tester, '轻触显全');
    if (point != null) {
      final gesture = await tester.startGesture(point);
      await tester.pump(const Duration(milliseconds: 30));
      await gesture.up();
    }
    await _frame(tester);
  }
  fail('Lantern did not reach "$fragment": ${guest.texts(tester)}');
}

String _appImageDirectory(String supportPath) {
  final appKey = crypto.sha256.convert(utf8.encode(_appId)).toString();
  return '$supportPath/pocket-images${Platform.pathSeparator}$appKey';
}

File _imageFile(String supportPath, String id) =>
    File('${_appImageDirectory(supportPath)}${Platform.pathSeparator}$id.png');

Future<Uint8List> _waitForImageBytes(
  WidgetTester tester,
  String supportPath,
  String id,
) async {
  final file = _imageFile(supportPath, id);
  for (var attempt = 0; attempt < 200; attempt++) {
    final bytes = await tester.runAsync<Uint8List?>(() async {
      try {
        return await file.readAsBytes();
      } on FileSystemException {
        return null;
      }
    });
    if (bytes != null) return bytes;
    await _frame(tester);
  }
  fail('PocketImageStore did not create its app-private PNG for $id');
}

Future<(int, int)> _verifyStoredPng(
  WidgetTester tester,
  Uint8List bytes,
  String id,
) async {
  expect(bytes.length, greaterThan(100));
  expect(bytes.take(_pngSignature.length).toList(), _pngSignature);
  expect(crypto.sha256.convert(bytes).toString(), id);
  final dimensions = await tester.runAsync(() async {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final frame = await codec.getNextFrame();
      try {
        return (frame.image.width, frame.image.height);
      } finally {
        frame.image.dispose();
      }
    } finally {
      codec.dispose();
    }
  });
  expect(dimensions, isNotNull);
  return dimensions!;
}

_PaintedThumbnail? _findPaintedThumbnail(WidgetTester tester) {
  for (final widget in guest.painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    if (painter.width <= 0 || painter.height <= 0) continue;
    final scaleX = box.size.width / painter.width;
    final scaleY = box.size.height / painter.height;
    Rect toGlobal(Rect rect) => Rect.fromPoints(
      box.localToGlobal(Offset(rect.left * scaleX, rect.top * scaleY)),
      box.localToGlobal(Offset(rect.right * scaleX, rect.bottom * scaleY)),
    );
    for (final op in painter.ops.whereType<PocketImageOp>()) {
      // Dynamic PocketJS texture uploads use the native synthetic texture key.
      // The texture key excludes baked glyph pages; keep the dimension floor
      // low enough for portrait crops in a 48px mobile preview column.
      if (!op.asset.startsWith('pocket.texture.') ||
          op.width < 16 ||
          op.height < 16) {
        continue;
      }
      final image = painter.images[op.asset];
      if (image == null) continue;
      var visible = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      Rect? clip;
      if (op.clip != null) {
        clip = Rect.fromLTWH(
          op.clip!.x,
          op.clip!.y,
          op.clip!.width,
          op.clip!.height,
        );
        visible = visible.intersect(clip);
      }
      visible = visible.intersect(
        Rect.fromLTWH(0, 0, painter.width, painter.height),
      );
      if (visible.width < 20 || visible.height < 20) continue;
      return _PaintedThumbnail(
        asset: op.asset,
        image: image,
        globalRect: toGlobal(visible),
        contentRect: toGlobal(Rect.fromLTWH(op.x, op.y, op.width, op.height)),
        clipRect: clip == null ? null : toGlobal(clip),
        canvasWidth: painter.width,
        canvasHeight: painter.height,
      );
    }
  }
  return null;
}

const _thumbnailCheckpoints = <String>[
  'novel-thumbnail-save-and-pixels',
  'novel-thumbnail-resize-same-resource',
  'novel-thumbnail-overwrite-and-cleanup',
  'novel-thumbnail-recreate-and-load',
  'novel-thumbnail-lifecycle',
  'novel-thumbnail-normal-store-preserved',
];

void _declareThumbnailAcceptance(IntegrationTestWidgetsFlutterBinding binding) {
  final report = binding.reportData ?? <String, Object?>{};
  final rawAcceptance = report['pocketAcceptance'];
  final acceptance = rawAcceptance is Map
      ? Map<String, Object?>.from(rawAcceptance)
      : <String, Object?>{};
  final required = acceptance['required'] is List
      ? (acceptance['required'] as List).whereType<String>().toList()
      : <String>[];
  for (final checkpoint in _thumbnailCheckpoints) {
    if (!required.contains(checkpoint)) required.add(checkpoint);
  }
  final completed = acceptance['completed'] is List
      ? (acceptance['completed'] as List).whereType<String>().toList()
      : <String>[];
  acceptance['required'] = required;
  acceptance['completed'] = completed;
  report['pocketAcceptance'] = acceptance;
  binding.reportData = report;
}

void _completeThumbnailCheckpoint(
  IntegrationTestWidgetsFlutterBinding binding,
  String checkpoint,
) {
  final report = binding.reportData!;
  final acceptance = Map<String, Object?>.from(
    report['pocketAcceptance'] as Map,
  );
  final completed = (acceptance['completed'] as List)
      .whereType<String>()
      .toList();
  if (!completed.contains(checkpoint)) completed.add(checkpoint);
  acceptance['completed'] = completed;
  report['pocketAcceptance'] = acceptance;
  binding.reportData = report;
}

void _updateThumbnailReport(
  IntegrationTestWidgetsFlutterBinding binding,
  Map<String, Object?> update,
) {
  final report = binding.reportData ?? <String, Object?>{};
  final rawDetails = report['novelSlotThumbnail'];
  final details = rawDetails is Map
      ? Map<String, Object?>.from(rawDetails)
      : <String, Object?>{};
  details.addAll(update);
  report['novelSlotThumbnail'] = details;
  binding.reportData = report;
}

Rect _globalRectForBox(RenderBox box) => Rect.fromPoints(
  box.localToGlobal(Offset.zero),
  box.localToGlobal(Offset(box.size.width, box.size.height)),
);

void _expectRectInside(Rect rect, Rect bounds, String reason) {
  expect(rect.left, greaterThanOrEqualTo(bounds.left - 1), reason: reason);
  expect(rect.top, greaterThanOrEqualTo(bounds.top - 1), reason: reason);
  expect(rect.right, lessThanOrEqualTo(bounds.right + 1), reason: reason);
  expect(rect.bottom, lessThanOrEqualTo(bounds.bottom + 1), reason: reason);
}

bool _sameGeometry(_PaintedThumbnail a, _PaintedThumbnail b) =>
    (a.globalRect.left - b.globalRect.left).abs() < .5 &&
    (a.globalRect.top - b.globalRect.top).abs() < .5 &&
    (a.globalRect.width - b.globalRect.width).abs() < .5 &&
    (a.globalRect.height - b.globalRect.height).abs() < .5 &&
    (a.canvasWidth - b.canvasWidth).abs() < .5 &&
    (a.canvasHeight - b.canvasHeight).abs() < .5;

Future<_PaintedThumbnail> _waitForResponsiveThumbnail(
  WidgetTester tester, {
  required double expectedWidth,
  required ui.Image expectedImage,
  required String expectedAsset,
}) async {
  _PaintedThumbnail? previous;
  Size? lastViewSize;
  double? lastCanvasWidth;
  for (var attempt = 0; attempt < 200; attempt++) {
    await _frame(tester);
    final viewBox = tester.renderObject<RenderBox>(
      guest.activePocketViewFinder(),
    );
    final painted = _findPaintedThumbnail(tester);
    lastViewSize = viewBox.size;
    lastCanvasWidth = painted?.canvasWidth;
    if (painted == null ||
        (viewBox.size.width - expectedWidth).abs() >= 1.5 ||
        (painted.canvasWidth - expectedWidth).abs() >= 1.5 ||
        painted.asset != expectedAsset ||
        !identical(painted.image, expectedImage)) {
      previous = null;
      continue;
    }
    if (previous != null && _sameGeometry(previous, painted)) return painted;
    previous = painted;
  }
  fail(
    'The live PocketView did not settle its mounted thumbnail at width '
    '$expectedWidth; view=$lastViewSize canvasWidth=$lastCanvasWidth '
    'asset=${_findPaintedThumbnail(tester)?.asset}',
  );
}

void _expectResponsiveThumbnail(
  WidgetTester tester, {
  required _PaintedThumbnail painted,
  required double expectedWidth,
  required double sourceAspectRatio,
}) {
  final viewBox = tester.renderObject<RenderBox>(
    guest.activePocketViewFinder(),
  );
  final viewRect = _globalRectForBox(viewBox);
  expect(viewBox.size.width, closeTo(expectedWidth, 1.5));
  expect(painted.canvasWidth, closeTo(expectedWidth, 1.5));
  expect(painted.globalRect.width, greaterThan(20));
  expect(painted.globalRect.height, greaterThan(20));
  _expectRectInside(
    painted.globalRect,
    painted.contentRect,
    'The source crop must remain inside the native PocketImageOp destination.',
  );
  _expectRectInside(
    painted.globalRect,
    viewRect,
    'The native painted thumbnail crop must remain inside the visible PocketView slot.',
  );
  if (painted.clipRect != null) {
    _expectRectInside(
      painted.globalRect,
      painted.clipRect!,
      'The visible thumbnail crop must remain inside its native PocketImageOp clip.',
    );
  }
  expect(
    painted.globalRect.width / painted.globalRect.height,
    closeTo(sourceAspectRatio, .05),
    reason: 'The visible source crop must preserve the saved PNG aspect ratio.',
  );
}

Future<_PaintedThumbnail> _waitForPaintedThumbnail(
  WidgetTester tester, {
  ui.Image? excludingImage,
}) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    final painted = _findPaintedThumbnail(tester);
    if (painted != null && !identical(painted.image, excludingImage)) {
      return painted;
    }
    await _frame(tester);
  }
  fail(
    'The saved slot preview did not upload and paint as a dynamic image; '
    'painted=${guest.texts(tester)}; '
    'imageOps=${[for (final widget in guest.painters(tester))
      for (final op in (widget.painter! as PocketCanvasPainter).ops.whereType<PocketImageOp>()) op.asset]}',
  );
}

bool _imageIsPresented(WidgetTester tester, ui.Image image) {
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    if (painter.images.values.any((candidate) => identical(candidate, image))) {
      return true;
    }
  }
  return false;
}

Future<void> _waitUntilImageReleased(
  WidgetTester tester,
  ui.Image image,
) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    if (!_imageIsPresented(tester, image)) return;
    await _frame(tester);
  }
  fail('Unmounted slot preview still appears in the live PocketView images');
}

Future<_PreviewCapture> _capturePreviewCrop(
  WidgetTester tester,
  GlobalKey captureKey,
  _PaintedThumbnail thumbnail,
  String id,
  String evidenceDirectory,
) async {
  await tester.pump(const Duration(milliseconds: 50));
  final boundary =
      captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final capturedScreenshot = await tester.runAsync(
    () => boundary.toImage(pixelRatio: 1),
  );
  expect(capturedScreenshot, isNotNull);
  final screenshot = capturedScreenshot!;
  try {
    final boundaryBox = tester.renderObject<RenderBox>(find.byKey(captureKey));
    final boundaryOrigin = boundaryBox.localToGlobal(Offset.zero);
    final bounds = thumbnail.globalRect
        .shift(-boundaryOrigin)
        .intersect(
          Rect.fromLTWH(
            0,
            0,
            screenshot.width.toDouble(),
            screenshot.height.toDouble(),
          ),
        );
    final left = bounds.left.floor().clamp(0, screenshot.width - 1) as int;
    final top = bounds.top.floor().clamp(0, screenshot.height - 1) as int;
    final right = bounds.right.ceil().clamp(left + 1, screenshot.width) as int;
    final bottom =
        bounds.bottom.ceil().clamp(top + 1, screenshot.height) as int;
    final width = right - left;
    final height = bottom - top;
    final raw = await tester.runAsync(
      () => screenshot.toByteData(format: ui.ImageByteFormat.rawRgba),
    );
    expect(raw, isNotNull);
    final pixels = raw!.buffer.asUint8List(
      raw.offsetInBytes,
      raw.lengthInBytes,
    );
    final sampledColors = <int>{};
    for (var y = 0; y < 7; y++) {
      for (var x = 0; x < 7; x++) {
        final sampleX =
            ((x + .5) * width / 7).floor().clamp(0, width - 1) as int;
        final sampleY =
            ((y + .5) * height / 7).floor().clamp(0, height - 1) as int;
        final pixelX = left + sampleX;
        final pixelY = top + sampleY;
        final offset = (pixelY * screenshot.width + pixelX) * 4;
        if (pixels[offset + 3] == 0) continue;
        sampledColors.add(
          (pixels[offset] << 16) |
              (pixels[offset + 1] << 8) |
              pixels[offset + 2],
        );
      }
    }

    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawImageRect(
      screenshot,
      Rect.fromLTWH(
        left.toDouble(),
        top.toDouble(),
        width.toDouble(),
        height.toDouble(),
      ),
      Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
      Paint(),
    );
    final picture = recorder.endRecording();
    final crop = await tester.runAsync(() => picture.toImage(width, height));
    try {
      final png = await tester.runAsync(
        () => crop!.toByteData(format: ui.ImageByteFormat.png),
      );
      expect(png, isNotNull);
      final bytes = Uint8List.fromList(
        png!.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes),
      );
      final file = File('$evidenceDirectory/$id.png');
      await tester.runAsync(() => file.parent.create(recursive: true));
      await tester.runAsync(() => file.writeAsBytes(bytes));
      debugPrint(
        'novel-slot-thumbnail: preview=$id crop=${file.path} '
        'rect=${width}x$height sampledColors=${sampledColors.length}',
      );
      return _PreviewCapture(
        pngBytes: bytes,
        sampledColors: sampledColors.length,
        path: file.path,
      );
    } finally {
      crop?.dispose();
      picture.dispose();
    }
  } finally {
    screenshot.dispose();
  }
}

Future<void> _expectCaptureSceneStableAcrossLifecycle(
  WidgetTester tester,
  IntegrationTestWidgetsFlutterBinding binding,
) async {
  final before = tester.widget<PocketView>(guest.activePocketViewFinder());
  expect(
    before.enableSceneCapture,
    isTrue,
    reason: 'The running Lantern guest declared platform.images.capture.',
  );
  final controller = before.controller;
  expect(controller, isNotNull);

  binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 100)),
  );
  expect(controller!.appActive, isFalse);
  binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  for (var attempt = 0; attempt < 200 && !controller!.appActive; attempt++) {
    await _frame(tester);
  }
  expect(controller!.appActive, isTrue);
  final after = tester.widget<PocketView>(guest.activePocketViewFinder());
  expect(after.enableSceneCapture, isTrue);
  expect(after.controller, same(controller));
  expect(
    tester.takeException(),
    isNull,
    reason:
        'Lifecycle resume must not remount PocketView with changed capture options.',
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  _declareThumbnailAcceptance(binding);

  testWidgets(
    'Lantern captures, persists, displays, and reloads a real slot thumbnail',
    (tester) async {
      final naturalWidth =
          tester.view.physicalSize.width / tester.view.devicePixelRatio;
      expect(naturalWidth, greaterThan(0));
      final narrowedWidth = naturalWidth > 329 ? 329.0 : naturalWidth * .84;
      expect(narrowedWidth, lessThan(naturalWidth - 10));
      final hostWidth = ValueNotifier<double>(naturalWidth);
      var systemHost = PocketSystemHostController();
      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final normalStoreBefore = await tester.runAsync<Uint8List?>(() async {
        if (!await normalStore.exists()) return null;
        return normalStore.readAsBytes();
      });
      final isolatedSupport = IsolatedNovelSupportDirectory();
      await isolatedSupport.install();
      final supportPath = (await getApplicationSupportDirectory()).path;
      final evidenceDirectory =
          '${normalSupport.path}${Platform.pathSeparator}thumbnail-acceptance';
      final captureKey = GlobalKey();
      Widget hostAtCurrentWidth() => RepaintBoundary(
        key: captureKey,
        child: ValueListenableBuilder<double>(
          valueListenable: hostWidth,
          child: pocketHostApp(systemController: systemHost),
          builder: (context, width, child) => Center(
            child: SizedBox(width: width, child: child),
          ),
        ),
      );

      _updateThumbnailReport(binding, {
        'nativePlatform': Platform.operatingSystem,
        'flutterPlatform': defaultTargetPlatform.name,
        'naturalWidth': naturalWidth,
        'narrowedWidth': narrowedWidth,
        'evidenceDirectory': evidenceDirectory,
      });

      try {
        await tester.pumpWidget(hostAtCurrentWidth());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        final firstLaunchWaitMs = await _waitForLanternPage(
          tester,
          systemHost,
          '启程 · 开始新的故事',
        );
        _updateThumbnailReport(binding, {
          'firstLaunchWaitMs': firstLaunchWaitMs,
          'firstLaunchHostFacts': _systemHostFacts(systemHost),
        });
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');

        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.tapGuest(tester, '封存此刻', scroll: false);
        await novel.saveNovelSlot(tester, '1');
        final firstSave = await _waitForSlot(
          tester,
          supportPath,
          '1',
          (save) =>
              _activeId(save) == _firstStoryLine &&
              RegExp(r'^[0-9a-f]{64}$').hasMatch(_thumbnailId(save)),
        );
        final firstThumb = Map<String, dynamic>.from(
          firstSave['thumbnail'] as Map,
        );
        final firstId = firstThumb['id'] as String;
        expect(firstThumb['version'], 1);
        expect(firstThumb['width'], inInclusiveRange(1, 192));
        expect(firstThumb['height'], inInclusiveRange(1, 108));
        expect(
          (firstThumb['width'] as int) * (firstThumb['height'] as int),
          lessThanOrEqualTo(20_736),
        );

        final appImageDirectory = Directory(_appImageDirectory(supportPath));
        expect(
          appImageDirectory.path.split(Platform.pathSeparator).last,
          crypto.sha256.convert(utf8.encode(_appId)).toString(),
        );
        final firstFile = _imageFile(supportPath, firstId);
        final firstPng = await _waitForImageBytes(tester, supportPath, firstId);
        final firstDimensions = await _verifyStoredPng(
          tester,
          firstPng,
          firstId,
        );
        expect(firstDimensions, (firstThumb['width'], firstThumb['height']));
        expect(firstFile.path, endsWith('$firstId.png'));

        await guest.reveal(tester, '信笺 1');
        final firstPaint = await _waitForPaintedThumbnail(tester);
        expect(firstPaint.asset, startsWith('pocket.texture.'));
        expect(firstPaint.image.width, greaterThan(0));
        expect(firstPaint.image.height, greaterThan(0));
        final firstPreview = await _capturePreviewCrop(
          tester,
          captureKey,
          firstPaint,
          firstId,
          evidenceDirectory,
        );
        expect(
          firstPreview.sampledColors,
          greaterThan(3),
          reason:
              'The dynamic image must contribute varied pixels to the visible save row.',
        );

        final sourceAspectRatio =
            (firstThumb['width'] as int) / (firstThumb['height'] as int);
        final initialViewBox = tester.renderObject<RenderBox>(
          guest.activePocketViewFinder(),
        );
        expect(initialViewBox.size.width, closeTo(naturalWidth, 1.5));
        expect(firstPaint.canvasWidth, closeTo(naturalWidth, 1.5));
        _expectResponsiveThumbnail(
          tester,
          painted: firstPaint,
          expectedWidth: naturalWidth,
          sourceAspectRatio: sourceAspectRatio,
        );
        _completeThumbnailCheckpoint(
          binding,
          'novel-thumbnail-save-and-pixels',
        );
        _updateThumbnailReport(binding, {
          'firstThumbnailId': firstId,
          'firstPngDimensions': [firstDimensions.$1, firstDimensions.$2],
          'firstTextureAsset': firstPaint.asset,
          'firstPreviewPath': firstPreview.path,
          'firstPreviewPngBase64': base64Encode(firstPreview.pngBytes),
          'firstPocketViewWidth': initialViewBox.size.width,
          'firstNativeCanvasWidth': firstPaint.canvasWidth,
        });

        // Constrain the actual host while the JS save panel and image preview
        // remain mounted. PocketView must resize its native viewport and
        // reflow only the image geometry, retaining the same uploaded image.
        hostWidth.value = narrowedWidth;
        final narrowedPaint = await _waitForResponsiveThumbnail(
          tester,
          expectedWidth: narrowedWidth,
          expectedImage: firstPaint.image,
          expectedAsset: firstPaint.asset,
        );
        expect(guest.texts(tester), contains('信笺 1'));
        _expectResponsiveThumbnail(
          tester,
          painted: narrowedPaint,
          expectedWidth: narrowedWidth,
          sourceAspectRatio: sourceAspectRatio,
        );
        expect(narrowedPaint.asset, firstPaint.asset);
        expect(narrowedPaint.image, same(firstPaint.image));
        expect(_imageIsPresented(tester, firstPaint.image), isTrue);
        _updateThumbnailReport(binding, {
          'narrowedPocketViewWidth': tester
              .renderObject<RenderBox>(guest.activePocketViewFinder())
              .size
              .width,
          'narrowedNativeCanvasWidth': narrowedPaint.canvasWidth,
          'narrowedVisibleThumbnailRect': [
            narrowedPaint.globalRect.left,
            narrowedPaint.globalRect.top,
            narrowedPaint.globalRect.width,
            narrowedPaint.globalRect.height,
          ],
        });

        hostWidth.value = naturalWidth;
        final restoredPaint = await _waitForResponsiveThumbnail(
          tester,
          expectedWidth: naturalWidth,
          expectedImage: firstPaint.image,
          expectedAsset: firstPaint.asset,
        );
        _expectResponsiveThumbnail(
          tester,
          painted: restoredPaint,
          expectedWidth: naturalWidth,
          sourceAspectRatio: sourceAspectRatio,
        );
        expect(restoredPaint.image, same(firstPaint.image));
        expect(restoredPaint.asset, firstPaint.asset);
        _completeThumbnailCheckpoint(
          binding,
          'novel-thumbnail-resize-same-resource',
        );
        _updateThumbnailReport(binding, {
          'restoredPocketViewWidth': tester
              .renderObject<RenderBox>(guest.activePocketViewFinder())
              .size
              .width,
          'restoredNativeCanvasWidth': restoredPaint.canvasWidth,
          'resizeRetainedTextureAsset': restoredPaint.asset,
        });

        await _expectCaptureSceneStableAcrossLifecycle(tester, binding);
        _completeThumbnailCheckpoint(binding, 'novel-thumbnail-lifecycle');

        // Move the real story to a later authored line, then replace the same
        // slot through the player's visible overwrite confirmation.
        await guest.tapGuest(tester, '返回', scroll: false);
        await _advanceUntil(tester, '我送一封信');
        final secondProgress = await _waitForSlot(
          tester,
          supportPath,
          'auto',
          (save) => _activeId(save) == _secondStoryLine,
        );
        expect(secondProgress['state']['stage']['background'], 'station');
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.tapGuest(tester, '封存此刻', scroll: false);
        await novel.saveNovelSlot(tester, '1');
        final secondSave = await _waitForSlot(
          tester,
          supportPath,
          '1',
          (save) =>
              _activeId(save) == _secondStoryLine &&
              RegExp(r'^[0-9a-f]{64}$').hasMatch(_thumbnailId(save)) &&
              _thumbnailId(save) != firstId,
        );
        final secondThumb = Map<String, dynamic>.from(
          secondSave['thumbnail'] as Map,
        );
        final secondId = secondThumb['id'] as String;
        final secondPng = await _waitForImageBytes(
          tester,
          supportPath,
          secondId,
        );
        final secondDimensions = await _verifyStoredPng(
          tester,
          secondPng,
          secondId,
        );
        expect(secondDimensions, (secondThumb['width'], secondThumb['height']));
        await guest.reveal(tester, '信笺 1');
        final secondPaint = await _waitForPaintedThumbnail(
          tester,
          excludingImage: firstPaint.image,
        );
        expect(secondPaint.image, isNot(same(firstPaint.image)));
        expect(
          _imageIsPresented(tester, firstPaint.image),
          isFalse,
          reason:
              'Replacing image A must retire the old texture from active paint resources.',
        );
        final secondPreview = await _capturePreviewCrop(
          tester,
          captureKey,
          secondPaint,
          secondId,
          evidenceDirectory,
        );
        expect(secondPreview.sampledColors, greaterThan(3));
        expect(
          crypto.sha256.convert(secondPreview.pngBytes).toString(),
          isNot(crypto.sha256.convert(firstPreview.pngBytes).toString()),
          reason:
              'The actual preview pixels must change with the later story checkpoint.',
        );
        _updateThumbnailReport(binding, {
          'secondThumbnailId': secondId,
          'secondPngDimensions': [secondDimensions.$1, secondDimensions.$2],
          'secondTextureAsset': secondPaint.asset,
          'secondPreviewPath': secondPreview.path,
          'secondPreviewPngBase64': base64Encode(secondPreview.pngBytes),
        });

        for (var attempt = 0; attempt < 200; attempt++) {
          final exists =
              await tester.runAsync(() => firstFile.exists()) ?? false;
          if (!exists) break;
          await _frame(tester);
        }
        expect(
          await tester.runAsync(() => firstFile.exists()) ?? false,
          isFalse,
          reason:
              'The replaced PNG should be collected after slot 1 stops referencing it.',
        );
        expect(
          await tester.runAsync(
                () => _imageFile(supportPath, secondId).exists(),
              ) ??
              false,
          isTrue,
        );
        _completeThumbnailCheckpoint(
          binding,
          'novel-thumbnail-overwrite-and-cleanup',
        );
        _updateThumbnailReport(binding, {'overwrittenPngRemoved': true});

        // Dispose the entire native SystemHost and reopen it. The load panel
        // must read the committed PNG again and upload a fresh native texture.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        systemHost.dispose();
        systemHost = PocketSystemHostController();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pumpWidget(hostAtCurrentWidth());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        final reloadLaunchWaitMs = await _waitForLanternPage(
          tester,
          systemHost,
          '续写 · 继续旅程',
        );
        _updateThumbnailReport(binding, {
          'reloadLaunchWaitMs': reloadLaunchWaitMs,
          'reloadLaunchHostFacts': _systemHostFacts(systemHost),
        });
        await guest.tapGuest(tester, '重读信笺');
        await novel.waitForNovelSlotPage(tester);
        await guest.reveal(tester, '信笺 1');
        final reopenedPaint = await _waitForPaintedThumbnail(
          tester,
          excludingImage: secondPaint.image,
        );
        expect(reopenedPaint.asset, startsWith('pocket.texture.'));
        expect(_imageIsPresented(tester, secondPaint.image), isFalse);

        final reopenedSave = await _waitForSlot(
          tester,
          supportPath,
          '1',
          (save) =>
              _activeId(save) == _secondStoryLine &&
              _thumbnailId(save) == secondId,
        );
        expect(reopenedSave['state']['stage']['background'], 'station');
        expect(
          await tester.runAsync(
                () => _imageFile(supportPath, secondId).exists(),
              ) ??
              false,
          isTrue,
        );
        _updateThumbnailReport(binding, {
          'reopenedTextureAsset': reopenedPaint.asset,
          'reopenedImageDimensions': [
            reopenedPaint.image.width,
            reopenedPaint.image.height,
          ],
        });
        await guest.tapGuest(tester, '信笺 1', scroll: false);
        await guest.waitForContaining(tester, '我送一封信');
        final loadedSave = await _waitForSlot(
          tester,
          supportPath,
          '1',
          (save) => _activeId(save) == _secondStoryLine,
        );
        expect(loadedSave['state']['stage']['background'], 'station');
        await _waitUntilImageReleased(tester, reopenedPaint.image);
        _completeThumbnailCheckpoint(
          binding,
          'novel-thumbnail-recreate-and-load',
        );
        expect(tester.takeException(), isNull);
        debugPrint(
          'novel-slot-thumbnail: first=$firstId second=$secondId '
          'reopened+rendered+loaded checkpoint=$_secondStoryLine; '
          'cropA=${firstPreview.path} cropB=${secondPreview.path}',
        );
      } finally {
        try {
          binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
          systemHost.dispose();
          await isolatedSupport.restore();
          final normalStoreAfter = await tester.runAsync<Uint8List?>(() async {
            if (!await normalStore.exists()) return null;
            return normalStore.readAsBytes();
          });
          expect(
            normalStoreAfter,
            equals(normalStoreBefore),
            reason:
                'Thumbnail acceptance writes only to a test-owned support directory.',
          );
          _completeThumbnailCheckpoint(
            binding,
            'novel-thumbnail-normal-store-preserved',
          );
          _updateThumbnailReport(binding, {'normalStorePreserved': true});
        } finally {
          hostWidth.dispose();
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 6)),
  );
}
