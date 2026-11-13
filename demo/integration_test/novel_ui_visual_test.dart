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
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';
import 'novel_test_driver.dart' as novel;

const _storyOpening = <String>['23点08分', '11:08 p.m.'];
const _readingAction = <String>['轻触继续  ›', 'Tap to continue  ›'];
const _menuAction = <String>['手札', 'Journal'];
const _titleStart = <String>['启程 · 开始新的故事', 'Begin · Start a new story'];
const _menuTitle = <String>['返回扉页', 'Return to title'];
const _menuSettings = <String>['阅读偏好', 'Reading preferences'];
const _menuGallery = <String>['雾港纪念', 'Memories'];
const _galleryTitle = <String>['雾港纪念', 'Harbor memories'];
const _panelBack = <String>['返回', 'Back'];
const _settingsSoundsOn = <String>['文字提示音 · 开启', 'Text reveal sounds · On'];
const _settingsSoundsOff = <String>['文字提示音 · 关闭', 'Text reveal sounds · Off'];
const _choiceOptions = <String>[
  '先不拆信，问 Mira 为什么赶来。',
  '问 Ren：那晚中继熄灭时发生了什么？',
  '核对邮戳、收件栏和蜡封，不打开信。',
  'Keep the seal closed and ask Mira why she came.',
  'Ask Ren what happened the night the relay went dark.',
  'Check the postmark, recipient, and wax without opening it.',
];
const _readingActions = <String>[
  '轻触显全',
  '轻触继续  ›',
  'Tap to reveal all',
  'Tap to continue  ›',
];

PocketCanvasPainter _gameFrame(WidgetTester tester) => guest
    .painters(tester)
    .map((widget) => widget.painter! as PocketCanvasPainter)
    .lastWhere(
      (painter) => painter.ops.whereType<PocketImageOp>().any(
        (op) => op.asset.endsWith('art/station.png'),
      ),
    );

Finder _gameViewFinder(WidgetTester tester) {
  final paint = guest.painters(tester).lastWhere((widget) {
    final painter = widget.painter! as PocketCanvasPainter;
    return painter.ops.whereType<PocketImageOp>().any(
      (op) => op.asset.endsWith('art/station.png'),
    );
  });
  return find
      .ancestor(of: find.byWidget(paint), matching: find.byType(PocketView))
      .first;
}

void _expectDecodedImageSkin(WidgetTester tester) {
  var triangleCount = 0;
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>()) {
      if (!op.asset.contains('art/ui/')) continue;
      triangleCount += 1;
      expect(painter.images[op.asset], isNotNull);
    }
  }
  expect(
    triangleCount,
    greaterThanOrEqualTo(18),
    reason: 'The real game chrome should paint its decoded image nine-slice.',
  );
}

Future<void> _waitForDecodedImageSkin(WidgetTester tester) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    var triangles = 0;
    var decoded = true;
    for (final widget in guest.painters(tester)) {
      final painter = widget.painter! as PocketCanvasPainter;
      for (final op in painter.ops.whereType<PocketTextureTriangleOp>()) {
        if (!op.asset.contains('art/ui/')) continue;
        triangles++;
        decoded = decoded && painter.images[op.asset] != null;
      }
    }
    if (triangles >= 18 && decoded) return;
  }
  _expectDecodedImageSkin(tester);
}

Future<void> _waitForAny(WidgetTester tester, List<String> candidates) async {
  String normalize(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    final painted = guest.texts(tester);
    if (candidates.any(painted.contains)) {
      return;
    }
    final normalizedPainted = painted.map(normalize).toList(growable: false);
    if (candidates.any((candidate) {
      final expected = normalize(candidate);
      return normalizedPainted.any((text) => text.contains(expected));
    })) {
      return;
    }
  }
  fail('None of $candidates was painted. Actual: ${guest.texts(tester)}');
}

Future<String> _paintedCandidate(
  WidgetTester tester,
  List<String> candidates, {
  bool scroll = true,
  bool traceScroll = false,
}) async {
  var drags = 0;
  final scrollTrace = <String>[];
  String titleScrollSnapshot() {
    const tracked = <String>[
      '启程 · 开始新的故事',
      'Begin · Start a new story',
      '5分钟能力巡演',
      '5-Minute Feature Tour',
      '灯火与雾的层次',
      'Lantern, Fog, and Distance',
      '立绘试映',
      'Model theater',
      '续写 · 继续旅程',
      'Continue · Resume your journey',
      '重读信笺',
      'Load a letter',
      '雾港纪念',
      'Harbor memories',
      '阅读偏好',
      'Reading preferences',
      '离开雾港',
      'Leave the harbor',
    ];
    final parts = <String>[];
    for (final widget in guest.painters(tester)) {
      final painter = widget.painter! as PocketCanvasPainter;
      final box = tester.renderObject<RenderBox>(find.byWidget(widget));
      for (final op in painter.ops.whereType<PocketTextOp>()) {
        if (!tracked.any(op.text.contains)) continue;
        final clip = op.clip;
        parts.add(
          '${op.text}@${op.x},${op.y},${op.width},${op.height}'
          ' clip=${clip == null ? 'none' : '${clip.x},${clip.y},${clip.width},${clip.height}'}'
          ' canvas=${painter.width}x${painter.height}'
          ' widget=${box.size.width}x${box.size.height}',
        );
      }
    }
    return parts.join(' | ');
  }

  for (var attempt = 0; attempt < 160; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    final painted = guest.texts(tester);
    for (final candidate in candidates) {
      if (painted.contains(candidate)) return candidate;
    }
    String normalize(String text) => text.replaceAll(RegExp(r'\s+'), ' ');
    for (final candidate in candidates) {
      final expected = normalize(candidate);
      for (final label in painted) {
        if (normalize(label).contains(expected)) return label;
      }
    }
    // The renderer culls offscreen text. Scroll before resolving its locale,
    // using the real guest gesture rather than assuming an unpainted label.
    if (scroll && attempt % 8 == 0 && drags < 12) {
      final box = tester.renderObject<RenderBox>(_gameViewFinder(tester));
      final start = box.localToGlobal(
        Offset(box.size.width * .35, box.size.height * .72),
      );
      if (traceScroll) {
        scrollTrace.add(
          'before drag $drags at (${start.dx},${start.dy}): ${titleScrollSnapshot()}',
        );
      }
      final gesture = await tester.startGesture(start);
      for (var move = 0; move < 10; move++) {
        await gesture.moveBy(const Offset(0, -23));
        await tester.pump(const Duration(milliseconds: 16));
      }
      for (var settle = 0; settle < 3; settle++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 100));
      drags++;
      if (traceScroll) {
        scrollTrace.add('after drag $drags: ${titleScrollSnapshot()}');
      }
    }
  }
  fail(
    'No action in $candidates became painted after $drags guest drags; '
    'actual=${guest.texts(tester)}; '
    '${traceScroll ? 'scrollTrace=$scrollTrace' : ''}',
  );
}

Future<void> _tapAny(
  WidgetTester tester,
  List<String> candidates, {
  bool scroll = true,
  bool traceScroll = false,
}) async {
  final label = await _paintedCandidate(
    tester,
    candidates,
    scroll: scroll,
    traceScroll: traceScroll,
  );
  await guest.tapGuest(tester, label, scroll: scroll);
}

Future<void> _waitForAnyContaining(
  WidgetTester tester,
  List<String> candidates,
) async {
  String normalized(String value) => value.replaceAll(RegExp(r'\s+'), ' ');
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    final painted = guest.texts(tester);
    if (candidates.any(
      (candidate) => painted.any(
        (text) => normalized(text).contains(normalized(candidate)),
      ),
    )) {
      return;
    }
  }
  fail('None of $candidates was painted. Actual: ${guest.texts(tester)}');
}

Future<void> _waitForCanvasResize(
  WidgetTester tester,
  double expectedWidth,
) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final box = tester.renderObject<RenderBox>(_gameViewFinder(tester));
    final frame = _gameFrame(tester);
    if ((frame.width - expectedWidth).abs() < .01 &&
        (frame.width - box.size.width).abs() < .01 &&
        (frame.height - box.size.height).abs() < .01) {
      return;
    }
  }
  final frame = _gameFrame(tester);
  fail(
    'The live child canvas did not resize: ${frame.width}x${frame.height}, '
    'expected width $expectedWidth',
  );
}

Future<Map<String, Object?>> _capture(
  WidgetTester tester,
  GlobalKey captureKey,
  Directory output,
  String name, {
  double pixelRatio = 1,
}) async {
  await _waitForStableGuestLayout(tester);
  final boundary =
      captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(
    () => boundary.toImage(pixelRatio: pixelRatio),
  );
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
    final fingerprint = <String, Object?>{
      'name': name,
      'path': file.path,
      'width': image!.width,
      'height': image.height,
      'sha256': pocketSha256(bytes),
    };
    debugPrint('LANTERN_UI_PIXEL_CAPTURE ${jsonEncode(fingerprint)}');
    return fingerprint;
  } finally {
    image?.dispose();
  }
}

String _guestLayoutSignature(WidgetTester tester) => jsonEncode([
  () {
    final painter = _gameFrame(tester);
    return [
      painter.width,
      painter.height,
      for (final op in painter.ops)
        if (op is PocketTextOp)
          [
            'text',
            op.text,
            op.x,
            op.y,
            op.width,
            op.height,
            op.clip == null
                ? null
                : [op.clip!.x, op.clip!.y, op.clip!.width, op.clip!.height],
            op.color,
          ]
        else if (op is PocketTextureTriangleOp && op.asset.contains('art/ui/'))
          [
            'skin',
            op.asset,
            op.points.map((point) => [point.x, point.y]).toList(),
            op.uvs,
            op.color,
            op.clip == null
                ? null
                : [op.clip!.x, op.clip!.y, op.clip!.width, op.clip!.height],
          ],
    ];
  }(),
]);

Future<void> _waitForStableGuestLayout(WidgetTester tester) async {
  String? previous;
  String? lastDiff;
  var consecutiveStableSamples = 0;
  for (var attempt = 0; attempt < 120; attempt++) {
    await tester.pump(const Duration(milliseconds: 40));
    final current = _guestLayoutSignature(tester);
    if (current == previous) {
      consecutiveStableSamples++;
      if (consecutiveStableSamples >= 2) return;
    } else {
      consecutiveStableSamples = 0;
      if (previous != null) {
        var index = 0;
        final limit = math.min(previous.length, current.length);
        while (index < limit &&
            previous.codeUnitAt(index) == current.codeUnitAt(index)) {
          index++;
        }
        final start = math.max(0, index - 100);
        final oldEnd = math.min(previous.length, index + 160);
        final newEnd = math.min(current.length, index + 160);
        lastDiff =
            'first changed signature window: old=${previous.substring(start, oldEnd)} new=${current.substring(start, newEnd)}';
      }
      previous = current;
    }
  }
  fail(
    'Active game text/skin geometry did not stabilize before capture. $lastDiff',
  );
}

List<Map<String, Object?>> _visibleTextFacts(WidgetTester tester) {
  final facts = <Map<String, Object?>>[];
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (((op.color >>> 24) & 0xff) == 0) continue;
      var visible = ui.Rect.fromLTWH(op.x, op.y, op.width, op.height);
      if (op.clip != null) {
        visible = visible.intersect(
          ui.Rect.fromLTWH(
            op.clip!.x,
            op.clip!.y,
            op.clip!.width,
            op.clip!.height,
          ),
        );
      }
      visible = visible.intersect(
        ui.Rect.fromLTWH(0, 0, painter.width, painter.height),
      );
      if (visible.isEmpty) continue;
      final topLeft = box.localToGlobal(
        Offset(
          visible.left * box.size.width / painter.width,
          visible.top * box.size.height / painter.height,
        ),
      );
      final bottomRight = box.localToGlobal(
        Offset(
          visible.right * box.size.width / painter.width,
          visible.bottom * box.size.height / painter.height,
        ),
      );
      facts.add({
        'text': op.text,
        'visibleGlobalRect': [
          topLeft.dx,
          topLeft.dy,
          bottomRight.dx,
          bottomRight.dy,
        ],
        'alpha': (op.color >>> 24) & 0xff,
      });
    }
  }
  return facts;
}

List<PocketTextOp> _gameTextOps(WidgetTester tester) =>
    _gameFrame(tester).ops.whereType<PocketTextOp>().toList();

String _normalizedText(String value) =>
    value.replaceAll(RegExp(r'\s+'), ' ').trim();

List<PocketTextOp> _consecutiveTextFor(
  List<PocketTextOp> ops,
  String expectedText,
) {
  final expected = _normalizedText(expectedText);
  for (var start = 0; start < ops.length; start++) {
    var combined = '';
    final lines = <PocketTextOp>[];
    for (var index = start; index < ops.length; index++) {
      final part = _normalizedText(ops[index].text);
      if (part.isEmpty) continue;
      final next = combined.isEmpty ? part : '$combined $part';
      if (!expected.startsWith(next)) break;
      combined = next;
      lines.add(ops[index]);
      if (combined == expected) return lines;
    }
  }
  return const [];
}

ui.Rect _textOpsRect(List<PocketTextOp> ops) {
  expect(ops, isNotEmpty);
  return ops.map((op) => ui.Rect.fromLTWH(op.x, op.y, op.width, op.height)).reduce((left, right) => left.expandToInclude(right));
}

void _expectEnglishLogHeaderFits(WidgetTester tester) {
  final frame = _gameFrame(tester);
  final ops = _gameTextOps(tester);
  final headingOps = _consecutiveTextFor(
    ops,
    'Echoes along the way',
  );
  final back = ops.firstWhere((op) => _normalizedText(op.text) == 'Back');
  expect(
    headingOps.length,
    greaterThan(1),
    reason: 'The long log heading must wrap into its allocated title area.',
  );
  expect(_textOpsRect(headingOps).right, lessThanOrEqualTo(back.x + 0.5));
  expect(back.x + back.width, lessThanOrEqualTo(frame.width + 0.5));
}

void _expectEnglishReplayLabelWraps(WidgetTester tester) {
  final frame = _gameFrame(tester);
  final replayOps = _consecutiveTextFor(
    _gameTextOps(tester),
    'Replay · A reply crosses twenty years, but the way back closes.',
  );
  expect(
    replayOps.length,
    greaterThan(1),
    reason: 'Long replay labels must wrap within their skinned action.',
  );
  final replay = _textOpsRect(replayOps);
  expect(replay.left, greaterThanOrEqualTo(0));
  expect(replay.right, lessThanOrEqualTo(frame.width + 0.5));
}

Map<String, Map<String, int>> _decodedSkinImageFacts(WidgetTester tester) {
  final images = <String, Map<String, int>>{};
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>()) {
      if (!op.asset.contains('art/ui/')) continue;
      final image = painter.images[op.asset];
      if (image == null) continue;
      images[op.asset] = {'width': image.width, 'height': image.height};
    }
  }
  return images;
}

Future<Map<String, Object?>> _guestFingerprint() async {
  final qjbcData = await rootBundle.load('assets/apps/lantern/app.qjbc');
  final pakData = await rootBundle.load('assets/apps/lantern/app.pak');
  final metadataText = await rootBundle.loadString(
    'assets/apps/lantern/app.bytecode.json',
  );
  final metadataData = await rootBundle.load(
    'assets/apps/lantern/app.bytecode.json',
  );
  final qjbc = qjbcData.buffer.asUint8List(
    qjbcData.offsetInBytes,
    qjbcData.lengthInBytes,
  );
  final pak = pakData.buffer.asUint8List(
    pakData.offsetInBytes,
    pakData.lengthInBytes,
  );
  final metadataBytes = metadataData.buffer.asUint8List(
    metadataData.offsetInBytes,
    metadataData.lengthInBytes,
  );
  final metadata = jsonDecode(metadataText) as Map<String, dynamic>;
  final headerBytes = metadata['headerBytes'] as int;
  expect(qjbc.length, metadata['bytecodeBytes']);
  expect(pocketSha256(qjbc.sublist(headerBytes)), metadata['payloadSha256']);
  return {
    'qjbcBytes': qjbc.length,
    'qjbcSha256': pocketSha256(qjbc),
    'pakBytes': pak.length,
    'pakSha256': pocketSha256(pak),
    'metadataSha256': pocketSha256(metadataBytes),
    'sourceSha256': metadata['sourceSha256'],
    'payloadSha256': metadata['payloadSha256'],
  };
}

Future<void> _waitForFirstChoice(WidgetTester tester) async {
  const fragments = _choiceOptions;
  for (var attempt = 0; attempt < 500; attempt++) {
    final painted = guest.texts(tester);
    if (painted.any((text) {
      final normalized = text.replaceAll(RegExp(r'\s+'), ' ');
      return fragments.any((fragment) => normalized.contains(fragment));
    })) {
      return;
    }
    final action = painted.firstWhere((text) {
      final normalized = text.replaceAll(RegExp(r'\s+'), ' ');
      return _readingActions.any(
        (hint) => normalized.contains(hint.replaceAll(RegExp(r'\s+'), ' ')),
      );
    }, orElse: () => '');
    if (action.isNotEmpty) {
      await guest.tapGuest(tester, action, scroll: false);
    } else {
      await tester.pump(const Duration(milliseconds: 40));
    }
  }
  fail('The first real story choice did not appear: ${guest.texts(tester)}');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'real game screens remain usable and capture across viewport constraints',
    (tester) async {
      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final normalStoreBefore = await normalStore.exists()
          ? await normalStore.readAsBytes()
          : null;
      final isolatedSupport = IsolatedNovelSupportDirectory();
      await isolatedSupport.install();

      // Use explicit test constraints even when the user's saved desktop window
      // is narrow. The scenarios below then shrink this same live game surface.
      tester.view.physicalSize = Size(
        800 * tester.view.devicePixelRatio,
        600 * tester.view.devicePixelRatio,
      );
      addTearDown(tester.view.resetPhysicalSize);
      final window = tester.view.physicalSize / tester.view.devicePixelRatio;
      expect(window.width, greaterThanOrEqualTo(600));
      expect(window.height, greaterThanOrEqualTo(340));
      final output = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-novel-ui-visual-'),
      );
      expect(output, isNotNull);
      final captureDirectory = output!;
      debugPrint('novel-ui-visual: output=${captureDirectory.path}');

      var available = window;
      final captureKey = GlobalKey();
      final application = pocketHostApp();
      late StateSetter resize;
      try {
        await tester.pumpWidget(
          StatefulBuilder(
            builder: (context, setState) {
              resize = setState;
              return Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: available.width,
                  height: available.height,
                  child: RepaintBoundary(key: captureKey, child: application),
                ),
              );
            },
          ),
        );

        // Use the actual running Showcase app. Only the first launcher label is
        // app-shell text; all VN controls below are selected from live paint.
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await _waitForAnyContaining(tester, <String>[
          '雾港末班信',
          'The Last Letter of Mist Harbor',
        ]);
        await _waitForDecodedImageSkin(tester);

        // Establish Chinese through the in-game preferences route. The title
        // menu can place preferences below the fold at 800x600, while the
        // in-game menu remains the real, reachable route at every viewport.
        await _tapAny(tester, _titleStart, scroll: false);
        await _waitForAnyContaining(tester, _storyOpening);
        await _tapAny(tester, _menuAction, scroll: false);
        await _waitForAnyContaining(tester, const ['旅途手札', 'Journey journal']);
        await _tapAny(tester, _menuSettings);
        await _waitForAnyContaining(tester, _menuSettings);
        final initialLanguage = await _paintedCandidate(tester, const [
          '游戏语言 · 中文',
          'Game language · English',
        ]);
        if (initialLanguage == 'Game language · English') {
          await guest.tapGuest(tester, initialLanguage);
          await _waitForAnyContaining(tester, const ['游戏语言 · 中文']);
        }
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForAny(tester, _readingActions);
        await _tapAny(tester, _menuAction, scroll: false);
        await _tapAny(tester, _menuTitle);
        await _waitForAny(tester, _titleStart);
        final controller = tester
            .widget<PocketView>(_gameViewFinder(tester))
            .controller;
        expect(
          tester.widget<PocketView>(_gameViewFinder(tester)).fontFamilyFallback,
          isEmpty,
        );

        Future<void> captureScreen(String layout, String screen) async {
          await _waitForDecodedImageSkin(tester);
          _expectDecodedImageSkin(tester);
          await _capture(
            tester,
            captureKey,
            captureDirectory,
            '$layout-$screen',
          );
        }

        Future<void> assertControllerRetained() async {
          expect(
            identical(
              tester.widget<PocketView>(_gameViewFinder(tester)).controller,
              controller,
            ),
            isTrue,
            reason: 'Constraint changes keep the same live PocketView.',
          );
        }

        Future<void> setViewport(String name, Size size) async {
          available = size;
          resize(() {});
          await tester.pump(const Duration(milliseconds: 600));
          await _waitForCanvasResize(tester, size.width);
          await assertControllerRetained();
          debugPrint(
            'novel-ui-visual: viewport=$name ${size.width}x${size.height} '
            '(Flutter constraints inside the existing OS window)',
          );
        }

        Future<void> captureTitle(String layout) async {
          await _waitForAny(tester, _titleStart);
          expect(
            guest.pointFor(tester, 'MIST HARBOR'),
            isNotNull,
            reason: 'Returning to the title restores its opening position.',
          );
          await captureScreen(layout, 'title');
        }

        Future<void> captureReading(String layout) async {
          await _tapAny(tester, _titleStart);
          await _waitForAnyContaining(tester, _storyOpening);
          const reveal = <String>['轻触显全', 'Tap to reveal all'];
          await _waitForAny(tester, <String>[...reveal, ..._readingAction]);
          if (reveal.any(guest.texts(tester).contains)) {
            await _tapAny(tester, reveal, scroll: false);
          }
          await _waitForAny(tester, _readingAction);
          await captureScreen(layout, 'reading');
        }

        Future<void> openMenu() async {
          await _tapAny(tester, _menuAction, scroll: false);
          await _waitForAny(tester, <String>['旅途手札', 'Journey journal']);
        }

        Future<void> capturePanels(String layout) async {
          await openMenu();
          await captureScreen(layout, 'menu');

          await _tapAny(tester, _menuSettings);
          await _waitForAny(tester, _menuSettings);
          await captureScreen(layout, 'settings');
          await _tapAny(tester, _panelBack);
          await _waitForAny(tester, _readingAction);

          await openMenu();
          await _tapAny(tester, _menuGallery);
          await _waitForAny(tester, _galleryTitle);
          await captureScreen(layout, 'gallery');
          await _tapAny(tester, _panelBack);
          await _waitForAny(tester, _readingAction);

          await openMenu();
          await _tapAny(tester, _menuTitle);
          await captureTitle(layout);
        }

        // Desktop window: title, story, menu, settings, and gallery are all
        // real JS guest frames painted by the native Flutter surface.
        await captureTitle('desktop');
        // Keep the desktop title's lower controls reachable by real guest
        // scrolling. This guards against using the in-game settings route to
        // hide a title-page overflow regression.
        await _tapAny(tester, _titleSettings, traceScroll: true);
        await _waitForAnyContaining(tester, _menuSettings);
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForAny(tester, _titleStart);
        await captureReading('desktop');
        await capturePanels('desktop');

        // Keep the same PocketView and native controller while narrowing its
        // Flutter constraints to a phone-like width inside this desktop OS
        // window. This does not resize or make claims about the OS window.
        final narrow = Size(math.min(390, window.width), window.height);
        await setViewport('phone-like', narrow);
        await captureTitle('phone-like');
        await captureReading('phone-like');
        await capturePanels('phone-like');

        // A short phone-like frame exercises real ScrollablePage drags. Reach
        // and activate the lower settings toggle using the same guest pointer
        // bridge, then save the resulting painted screen.
        final short = Size(narrow.width, math.min(340, window.height));
        await setViewport('short', short);
        await captureTitle('short');
        await _tapAny(tester, _titleSettings, scroll: true, traceScroll: true);
        await _waitForAny(tester, _menuSettings);
        await captureScreen('short', 'settings-before-scroll');
        final soundLabel = await _paintedCandidate(tester, <String>[
          ..._settingsSoundsOn,
          ..._settingsSoundsOff,
        ]);
        final nextSoundLabels = _settingsSoundsOn.contains(soundLabel)
            ? _settingsSoundsOff
            : _settingsSoundsOn;
        await guest.tapGuest(tester, soundLabel, scroll: true);
        await _waitForAny(tester, nextSoundLabels);
        await captureScreen('short', 'settings-after-scroll-toggle');
        await assertControllerRetained();

        // The host font fallback must also remain usable with longer English
        // labels and dialogue; inspect actual localized paint at phone width.
        await setViewport('phone-like-en', narrow);
        await _tapAny(tester, const ['游戏语言 · 中文']);
        await _waitForAny(tester, const ['Game language · English']);
        await captureScreen('phone-like-en', 'settings');
        await _tapAny(tester, _panelBack);
        await captureTitle('phone-like-en');
        await captureReading('phone-like-en');
        await capturePanels('phone-like-en');
        await _tapAny(tester, _titleSettings);
        await _tapAny(tester, const ['Game language · English']);
        await _waitForAny(tester, const ['游戏语言 · 中文']);
        await _tapAny(tester, _panelBack);
        await assertControllerRetained();
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await isolatedSupport.restore();
        final normalStoreAfter = await normalStore.exists()
            ? await normalStore.readAsBytes()
            : null;
        expect(
          normalStoreAfter,
          equals(normalStoreBefore),
          reason: 'Viewport acceptance writes only to isolated app support.',
        );
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );

  testWidgets(
    'Lantern captures eight real UI classes in Chinese and English at 390x844 DPR2',
    (tester) async {
      const dpr = 2.0;
      tester.view.devicePixelRatio = dpr;
      tester.view.physicalSize = const Size(780, 1688);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final normalStoreBefore = await normalStore.exists()
          ? await normalStore.readAsBytes()
          : null;
      final isolatedSupport = IsolatedNovelSupportDirectory();
      await isolatedSupport.install();
      expect(
        isolatedSupport.path.startsWith(
          '${Directory.systemTemp.path}${Platform.pathSeparator}',
        ),
        isTrue,
      );
      expect(isolatedSupport.path, isNot(normalSupport.path));

      final captureDirectory = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-lantern-ui-matrix-'),
      );
      expect(captureDirectory, isNotNull);
      final output = captureDirectory!;
      final captureKey = GlobalKey();
      final fingerprint = await _guestFingerprint();
      final captured = <String>[];

      Future<void> captureScreen(String locale, String screen) async {
        await _waitForDecodedImageSkin(tester);
        _expectDecodedImageSkin(tester);
        if (locale == 'en' && screen == 'log') {
          _expectEnglishLogHeaderFits(tester);
        }
        if (locale == 'en' && screen == 'gallery') {
          _expectEnglishReplayLabelWraps(tester);
        }
        final skinImages = _decodedSkinImageFacts(tester);
        expect(
          skinImages,
          isNotEmpty,
          reason: 'Each capture must use a decoded, registered game UI skin.',
        );
        final visibleTexts = _visibleTextFacts(tester);
        final name = '$locale-$screen';
        final capture = await _capture(
          tester,
          captureKey,
          output,
          name,
          pixelRatio: dpr,
        );
        captured.add(name);
        debugPrint(
          'LANTERN_UI_PIXEL_SCREEN ${jsonEncode({
            ...fingerprint,
            ...capture,
            'locale': locale,
            'screen': screen,
            'logicalViewport': [390, 844],
            'devicePixelRatio': dpr,
            'visibleText': visibleTexts,
            'decodedSkinImages': skinImages,
          })}',
        );
      }

      Future<void> openMenu() async {
        await _tapAny(tester, _menuAction, scroll: false);
        await _waitForAnyContaining(tester, const ['旅途手札', 'Journey journal']);
      }

      Future<void> returnToStory() async {
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForAny(tester, _readingActions);
      }

      Future<void> switchCurrentLocaleTo(String locale) async {
        final isChinese = locale == 'zh';
        final expected = isChinese ? '游戏语言 · 中文' : 'Game language · English';
        if (guest.texts(tester).any((text) => text.contains(expected))) return;
        final current = isChinese
            ? const ['Game language · English']
            : const ['游戏语言 · 中文'];
        await _tapAny(tester, current);
        await _waitForAnyContaining(tester, [expected]);
      }

      Future<void> openPanelFromMenu(
        List<String> labels,
        List<String> headings,
      ) async {
        await openMenu();
        await _tapAny(tester, labels);
        await _waitForAnyContaining(tester, headings);
      }

      Future<void> revealCurrentDialogue() async {
        for (var attempt = 0; attempt < 240; attempt++) {
          final painted = guest.texts(tester);
          if (painted.any(
            (text) => text.contains('轻触继续') || text.contains('Tap to continue'),
          )) {
            return;
          }
          final reveal = painted.firstWhere(
            (text) =>
                text.contains('轻触显全') || text.contains('Tap to reveal all'),
            orElse: () => '',
          );
          if (reveal.isNotEmpty) {
            await guest.tapGuest(tester, reveal, scroll: false);
          } else {
            await tester.pump(const Duration(milliseconds: 40));
          }
        }
        fail('Dialogue did not finish revealing: ${guest.texts(tester)}');
      }

      try {
        await tester.pumpWidget(
          RepaintBoundary(key: captureKey, child: pocketHostApp()),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await _waitForAnyContaining(tester, const [
          '雾港末班信',
          'The Last Letter of Mist Harbor',
        ]);
        await _waitForDecodedImageSkin(tester);

        await _tapAny(tester, _titleSettings, scroll: false);
        await _waitForAnyContaining(tester, const [
          '游戏语言 · 中文',
          'Game language · English',
        ]);
        await switchCurrentLocaleTo('zh');
        await captureScreen('zh', 'settings');
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForAny(tester, _titleStart);
        await captureScreen('zh', 'title');

        await _tapAny(tester, _titleStart, scroll: false);
        await _waitForAnyContaining(tester, _storyOpening);
        await revealCurrentDialogue();
        await captureScreen('zh', 'dialogue');

        await openMenu();
        await captureScreen('zh', 'menu');
        await _tapAny(tester, const ['封存此刻', 'Save this moment']);
        await novel.waitForNovelSlotPage(tester);
        await novel.saveNovelSlot(tester, '1');
        await guest.waitForContaining(tester, '信笺 1 已封存');
        final isolatedStore = File(
          '${isolatedSupport.path}/pocket-platform-data/pocket_platform_data.json',
        );
        final savedSlotExists = await tester.runAsync(() async {
          if (!await isolatedStore.exists()) return false;
          final decoded = jsonDecode(await isolatedStore.readAsString()) as Map;
          final private = decoded['private'] as Map?;
          final app = private?['pocket.demo.lantern'] as Map?;
          return app?['lantern.slot.1'] is Map;
        });
        expect(savedSlotExists, isTrue, reason: 'Save UI must write slot 1.');
        await captureScreen('zh', 'save-load');
        await returnToStory();

        await openPanelFromMenu(
          const ['沿途回声', 'Reading log'],
          const ['沿途回声', 'Echoes along the way'],
        );
        await _waitForAnyContaining(tester, _storyOpening);
        await captureScreen('zh', 'log');
        await returnToStory();

        await openPanelFromMenu(_menuGallery, _galleryTitle);
        await captureScreen('zh', 'gallery');
        await returnToStory();

        await _waitForFirstChoice(tester);
        await captureScreen('zh', 'choice');

        await openPanelFromMenu(_menuSettings, _menuSettings);
        await switchCurrentLocaleTo('en');
        await captureScreen('en', 'settings');
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForFirstChoice(tester);
        await captureScreen('en', 'choice');

        await openMenu();
        await captureScreen('en', 'menu');
        await _tapAny(tester, const ['Reading log', '沿途回声']);
        await _waitForAnyContaining(tester, const [
          'Echoes along the way',
          '沿途回声',
        ]);
        await captureScreen('en', 'log');
        await _tapAny(tester, _panelBack, scroll: false);
        await _waitForFirstChoice(tester);

        await openPanelFromMenu(
          const ['Load a letter', '重读信笺'],
          const ['Load a letter', '重读信笺'],
        );
        await novel.waitForNovelSlotPage(tester);
        await captureScreen('en', 'save-load');
        await _tapAny(tester, const ['Letter 1', '信笺 1']);
        await _waitForAnyContaining(tester, const ['11:08 p.m.']);
        await revealCurrentDialogue();
        await captureScreen('en', 'dialogue');

        await openPanelFromMenu(_menuGallery, _galleryTitle);
        await captureScreen('en', 'gallery');
        await returnToStory();
        await openMenu();
        await _tapAny(tester, _menuTitle);
        await _waitForAnyContaining(tester, const ['MIST HARBOR']);
        await captureScreen('en', 'title');

        expect(captured, hasLength(16));
        debugPrint(
          'LANTERN_UI_PIXEL_MATRIX ${jsonEncode({'output': output.path, 'screens': captured, 'guest': fingerprint, 'supportIsolation': isolatedSupport.path})}',
        );
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await isolatedSupport.restore();
        final normalStoreAfter = await normalStore.exists()
            ? await normalStore.readAsBytes()
            : null;
        expect(
          normalStoreAfter,
          equals(normalStoreBefore),
          reason: 'UI acceptance writes only to isolated app-support storage.',
        );
      }
    },
    timeout: const Timeout(Duration(minutes: 6)),
  );
}

const _titleSettings = <String>['阅读偏好', 'Reading preferences'];
