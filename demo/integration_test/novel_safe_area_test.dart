import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart' show PocketSystemHostController;
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

const _lanternGuestSourceSha256 =
    '3fffb14cf9f35da8d37b98421ef2a39eca93b460f1f45521a1038ba26ac15267';
const _embedScreenshotEvidence = bool.fromEnvironment(
  'POCKET_SAFE_AREA_EMBED_SCREENSHOTS',
);

List<CustomPaint> _activePainters(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
      find.descendant(
        of: guest.activePocketViewFinder(),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is PocketCanvasPainter,
        ),
      ),
    )
    .toList(growable: false);

List<PocketTextOp> _activeTextOps(WidgetTester tester) => [
  for (final widget in _activePainters(tester))
    for (final op in (widget.painter! as PocketCanvasPainter).ops)
      if (op is PocketTextOp) op,
];

PocketCanvasPainter _activeGameFrame(WidgetTester tester) =>
    _activePainters(tester)
        .map((widget) => widget.painter! as PocketCanvasPainter)
        .lastWhere(
          (painter) => painter.ops.whereType<PocketTextOp>().any(
            (op) => op.text.contains('23点08分'),
          ),
        );

PocketTextOp _requiredTextOp(WidgetTester tester, String label) =>
    _activeTextOps(tester).firstWhere(
      (op) => op.text == label,
      orElse: () => throw TestFailure(
        'Missing exact active Guest text "$label"; '
        'painted=${_activeTextOps(tester).map((op) => op.text).toList()}',
      ),
    );

Map<String, double> _insets(EdgeInsets value) => <String, double>{
  'top': value.top,
  'right': value.right,
  'bottom': value.bottom,
  'left': value.left,
};

void _expectTextWithinSafeBounds(
  PocketTextOp op,
  PocketCanvasPainter painter,
  RenderBox viewBox,
  Rect osSafeBounds,
) {
  final scaleX = viewBox.size.width / painter.width;
  final scaleY = viewBox.size.height / painter.height;
  final origin = viewBox.localToGlobal(Offset.zero);
  final globalRect = Rect.fromLTWH(
    origin.dx + op.x * scaleX,
    origin.dy + op.y * scaleY,
    op.width * scaleX,
    op.height * scaleY,
  );
  expect(globalRect.left, greaterThanOrEqualTo(osSafeBounds.left - 1));
  expect(globalRect.top, greaterThanOrEqualTo(osSafeBounds.top - 1));
  expect(globalRect.right, lessThanOrEqualTo(osSafeBounds.right + 1));
  expect(globalRect.bottom, lessThanOrEqualTo(osSafeBounds.bottom + 1));
}

bool _textWithinSafeBounds(
  PocketTextOp op,
  PocketCanvasPainter painter,
  RenderBox viewBox,
  Rect osSafeBounds,
) {
  final rect = _globalTextRect(op, painter, viewBox);
  return rect.left >= osSafeBounds.left - 1 &&
      rect.top >= osSafeBounds.top - 1 &&
      rect.right <= osSafeBounds.right + 1 &&
      rect.bottom <= osSafeBounds.bottom + 1;
}

Rect _globalTextRect(
  PocketTextOp op,
  PocketCanvasPainter painter,
  RenderBox viewBox,
) {
  final scaleX = viewBox.size.width / painter.width;
  final scaleY = viewBox.size.height / painter.height;
  final origin = viewBox.localToGlobal(Offset.zero);
  return Rect.fromLTWH(
    origin.dx + op.x * scaleX,
    origin.dy + op.y * scaleY,
    op.width * scaleX,
    op.height * scaleY,
  );
}

Future<Map<String, Object?>> _captureScreen(
  WidgetTester tester,
  GlobalKey key,
  Directory output,
  String name,
  double devicePixelRatio,
) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(
    () => boundary.toImage(pixelRatio: devicePixelRatio),
  );
  try {
    final data = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    expect(data, isNotNull);
    final bytes = data!.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final file = File('${output.path}/$name.png');
    await tester.runAsync(() => file.writeAsBytes(bytes, flush: true));
    debugPrint('NOVEL_SAFE_AREA_SCREEN ${file.path} ${bytes.length} bytes');
    if (_embedScreenshotEvidence) {
      final encoded = base64Encode(bytes);
      const chunkLength = 700;
      final chunkCount = (encoded.length + chunkLength - 1) ~/ chunkLength;
      for (var index = 0; index < chunkCount; index++) {
        final start = index * chunkLength;
        debugPrint(
          'NOVEL_SAFE_AREA_PNG_CHUNK $name $index/$chunkCount '
          '${encoded.substring(start, math.min(start + chunkLength, encoded.length))}',
        );
      }
    }
    return <String, Object?>{
      'name': name,
      'path': file.path,
      'pngBytes': bytes.length,
      'pixelSize': [image!.width, image.height],
      'embeddedBase64InLog': _embedScreenshotEvidence,
    };
  } finally {
    image?.dispose();
  }
}

Future<void> _waitForCanvas(WidgetTester tester) async {
  for (var attempt = 0; attempt < 120; attempt++) {
    if (_activePainters(tester).any(
      (widget) => (widget.painter! as PocketCanvasPainter).ops
          .whereType<PocketTextOp>()
          .any((op) => op.text.contains('23点08分')),
    )) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail('Lantern did not paint a live dialogue frame: ${guest.texts(tester)}');
}

Future<List<int>?> _storeBytes(File file) async =>
    await file.exists() ? file.readAsBytes() : null;

Map<String, Object?> _drawOpFact(PocketOp op) {
  final fact = <String, Object?>{
    'type': op.runtimeType.toString(),
    'rect': [op.x, op.y, op.x + op.width, op.y + op.height],
  };
  if (op is PocketTextOp) fact['text'] = op.text;
  if (op is PocketRectOp) fact['color'] = op.color;
  if (op is PocketRoundedOp) {
    fact['color'] = op.color;
    fact['radius'] = op.radius;
  }
  if (op is PocketGradientOp) {
    fact['fromColor'] = op.fromColor;
    fact['toColor'] = op.toColor;
    fact['direction'] = op.direction;
  }
  if (op is PocketImageOp) fact['asset'] = op.asset;
  if (op is PocketTextureTriangleOp) fact['asset'] = op.asset;
  if (op.clip != null) {
    fact['clip'] = [
      op.clip!.x,
      op.clip!.y,
      op.clip!.x + op.clip!.width,
      op.clip!.y + op.clip!.height,
    ];
  }
  return fact;
}

List<Map<String, Object?>> _menuNeighborhoodOps(
  PocketCanvasPainter painter,
  PocketTextOp menu,
) {
  final region = Rect.fromLTWH(menu.x + menu.width / 2 - 70, 0, 140, 88);
  return <Map<String, Object?>>[
    for (final op in painter.ops)
      if (Rect.fromLTWH(op.x, op.y, op.width, op.height).overlaps(region))
        _drawOpFact(op),
  ];
}

List<Map<String, Object?>> _pocketSemanticBounds(WidgetTester tester) {
  final finder = find.byWidgetPredicate(
    (widget) =>
        widget is Semantics &&
        (widget.properties.label == '手札' || widget.properties.label == '回声'),
  );
  final result = <Map<String, Object?>>[];
  for (final element in finder.evaluate()) {
    final widget = element.widget as Semantics;
    final renderObject = element.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) continue;
    final origin = renderObject.localToGlobal(Offset.zero);
    final rect = Rect.fromLTWH(
      origin.dx,
      origin.dy,
      renderObject.size.width,
      renderObject.size.height,
    );
    result.add(<String, Object?>{
      'label': widget.properties.label,
      'button': widget.properties.button,
      'enabled': widget.properties.enabled,
      'globalRect': [rect.left, rect.top, rect.right, rect.bottom],
    });
  }
  return result;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  binding.reportData = <String, Object?>{
    'mobileSafeArea': <String, Object?>{
      'required': <String>[
        'actual-platform-view-padding',
        'lantern-child-menu-safe-bounds',
        'flutter-pointer-menu-cycle',
        'emulator-screen-capture',
        'scratch-support-isolation',
      ],
      'completed': <String>[],
    },
  };

  testWidgets(
    'Android OS viewPadding reaches the actual Lantern child before its safe menu and pointer input',
    (tester) async {
      final platformView =
          WidgetsBinding.instance.platformDispatcher.views.first;
      final platformFacts = MediaQueryData.fromView(platformView);
      final osSafe = platformFacts.viewPadding;
      expect(
        osSafe.top,
        greaterThan(0),
        reason:
            'This acceptance runs on an Android emulator with a status bar.',
      );

      final metadataData = await rootBundle.load(
        'assets/apps/lantern/app.bytecode.json',
      );
      final metadataBytes = metadataData.buffer.asUint8List(
        metadataData.offsetInBytes,
        metadataData.lengthInBytes,
      );
      final metadata = jsonDecode(utf8.decode(metadataBytes)) as Map;
      expect(metadata['sourceSha256'], _lanternGuestSourceSha256);

      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final normalStoreBefore = await tester.runAsync<List<int>?>(
        () => _storeBytes(normalStore),
      );
      final isolatedSupport = IsolatedNovelSupportDirectory();
      await isolatedSupport.install();
      final isolatedSupportPath = isolatedSupport.path;
      final output = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-mobile-safe-area-'),
      );
      expect(output, isNotNull);

      final hostController = PocketSystemHostController();
      final screenshotKey = GlobalKey();
      final app = pocketHostApp(systemController: hostController);
      final completed =
          (binding.reportData!['mobileSafeArea']
                  as Map<String, dynamic>)['completed']
              as List<String>;
      final screenshots = <Map<String, Object?>>[];

      try {
        await tester.pumpWidget(
          RepaintBoundary(key: screenshotKey, child: app),
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        await _waitForCanvas(tester);

        final lanternInstance = hostController.instances.firstWhere(
          (instance) =>
              instance.appId == 'pocket.demo.lantern' && !instance.isSystemUI,
        );
        expect(lanternInstance.ready, isTrue);
        final activeViewFinder = guest.activePocketViewFinder();
        final childSafe = MediaQuery.viewPaddingOf(
          tester.element(activeViewFinder),
        );
        expect(childSafe.top, closeTo(osSafe.top, 1));
        expect(childSafe.right, closeTo(osSafe.right, 1));
        expect(childSafe.bottom, closeTo(osSafe.bottom, 1));
        expect(childSafe.left, closeTo(osSafe.left, 1));

        final activeView = tester.widget<PocketView>(activeViewFinder);
        expect(activeView.inputEnabled, isTrue);
        final viewBox = tester.renderObject<RenderBox>(activeViewFinder);
        final painter = _activeGameFrame(tester);
        expect(painter.width, closeTo(viewBox.size.width, 1));
        expect(painter.height, closeTo(viewBox.size.height, 1));
        final menuOp = _requiredTextOp(tester, '手札');
        final echoOp = _requiredTextOp(tester, '回声');
        final childMedia = MediaQuery.of(tester.element(activeViewFinder));
        final viewOrigin = viewBox.localToGlobal(Offset.zero);
        final viewGlobalBounds = Rect.fromPoints(
          viewOrigin,
          viewBox.localToGlobal(
            Offset(viewBox.size.width, viewBox.size.height),
          ),
        );
        final osSafeBounds = Rect.fromLTRB(
          osSafe.left,
          osSafe.top,
          platformFacts.size.width - osSafe.right,
          platformFacts.size.height - osSafe.bottom,
        );
        final menuGlobalRect = _globalTextRect(menuOp, painter, viewBox);
        final echoGlobalRect = _globalTextRect(echoOp, painter, viewBox);
        final menuPoint = guest.pointFor(tester, '手札');
        expect(menuPoint, isNotNull);

        final hostFacts = <String, Object?>{
          'platform': Platform.operatingSystem,
          'viewSizeLogical': [
            platformFacts.size.width,
            platformFacts.size.height,
          ],
          'devicePixelRatio': platformFacts.devicePixelRatio,
          'hostViewPadding': _insets(osSafe),
          'childViewPadding': _insets(childSafe),
          'childMediaPadding': _insets(childMedia.padding),
          'childMediaViewInsets': _insets(childMedia.viewInsets),
          'flutterViewGlobalBounds': [
            0,
            0,
            platformFacts.size.width,
            platformFacts.size.height,
          ],
          'osSafeGlobalBounds': [
            osSafeBounds.left,
            osSafeBounds.top,
            osSafeBounds.right,
            osSafeBounds.bottom,
          ],
          'pocketViewOriginGlobal': [viewOrigin.dx, viewOrigin.dy],
          'pocketViewGlobalBounds': [
            viewGlobalBounds.left,
            viewGlobalBounds.top,
            viewGlobalBounds.right,
            viewGlobalBounds.bottom,
          ],
          'pocketViewLogicalSize': [viewBox.size.width, viewBox.size.height],
          'guestCanvasLogical': [painter.width, painter.height],
          'menuRect': [menuOp.x, menuOp.y, menuOp.width, menuOp.height],
          'menuGlobalRect': [
            menuGlobalRect.left,
            menuGlobalRect.top,
            menuGlobalRect.right,
            menuGlobalRect.bottom,
          ],
          'echoRect': [echoOp.x, echoOp.y, echoOp.width, echoOp.height],
          'echoGlobalRect': [
            echoGlobalRect.left,
            echoGlobalRect.top,
            echoGlobalRect.right,
            echoGlobalRect.bottom,
          ],
          'menuPointerGlobal': [menuPoint!.dx, menuPoint.dy],
          'menuNeighborhoodOps': _menuNeighborhoodOps(painter, menuOp),
          'semanticBounds': _pocketSemanticBounds(tester),
          'pocketViewControllerIdentity': identityHashCode(
            activeView.controller,
          ),
          'lanternGuestSourceSha256': metadata['sourceSha256'],
          'lanternGuestPayloadSha256': metadata['payloadSha256'],
          'isolatedSupportPath': isolatedSupportPath,
          'normalSupportPath': normalSupport.path,
          'displayFactsSource': 'FlutterView -> MediaQueryData.fromView',
          'scope':
              'Real Android emulator OS viewPadding and Flutter pointer input; not physical hardware.',
        };
        debugPrint('NOVEL_SAFE_AREA_FACTS ${jsonEncode(hostFacts)}');
        binding.reportData!['mobileSafeAreaFacts'] = hostFacts;
        screenshots.add(
          await _captureScreen(
            tester,
            screenshotKey,
            output!,
            'lantern-safe-menu-before',
            platformFacts.devicePixelRatio,
          ),
        );

        // Capture and report the real host/Guest measurements before the
        // assertions, so a genuine layout miss still leaves inspectable facts.
        _expectTextWithinSafeBounds(menuOp, painter, viewBox, osSafeBounds);
        _expectTextWithinSafeBounds(echoOp, painter, viewBox, osSafeBounds);
        expect(menuPoint.dx, greaterThanOrEqualTo(osSafeBounds.left - 1));
        expect(menuPoint.dy, greaterThanOrEqualTo(osSafeBounds.top - 1));
        expect(menuPoint.dx, lessThanOrEqualTo(osSafeBounds.right + 1));
        expect(menuPoint.dy, lessThanOrEqualTo(osSafeBounds.bottom + 1));
        completed.addAll([
          'actual-platform-view-padding',
          'lantern-child-menu-safe-bounds',
        ]);

        final menuPointer = guest.pointFor(tester, '手札')!;
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '旅途手札');
        expect(tester.takeException(), isNull);
        screenshots.add(
          await _captureScreen(
            tester,
            screenshotKey,
            output,
            'lantern-safe-menu-open',
            platformFacts.devicePixelRatio,
          ),
        );
        expect(menuPointer, isNotNull);
        expect(guest.texts(tester), contains('继续阅读'));
        await guest.tapGuest(tester, '继续阅读', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        expect(guest.texts(tester), isNot(contains('旅途手札')));
        expect(tester.takeException(), isNull);
        completed.addAll([
          'flutter-pointer-menu-cycle',
          'emulator-screen-capture',
          'scratch-support-isolation',
        ]);
        binding.reportData!['mobileSafeAreaScreenshots'] = screenshots;
        binding.reportData!['mobileSafeAreaGuest'] = <String, Object?>{
          'sourceSha256': metadata['sourceSha256'],
          'payloadSha256': metadata['payloadSha256'],
          'runtimeAbi': metadata['runtimeAbi'],
        };
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await isolatedSupport.restore();
        hostController.dispose();
        final normalStoreAfter = await tester.runAsync<List<int>?>(
          () => _storeBytes(normalStore),
        );
        expect(
          normalStoreAfter,
          equals(normalStoreBefore),
          reason:
              'This acceptance must not modify the ordinary app-support store.',
        );
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
