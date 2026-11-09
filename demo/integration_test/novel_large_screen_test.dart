import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

PocketCanvasPainter _gameFrame(WidgetTester tester) => guest
    .painters(tester)
    .map((widget) => widget.painter! as PocketCanvasPainter)
    .lastWhere(
      (painter) => painter.ops.whereType<PocketImageOp>().any(
        (op) => op.asset.endsWith('art/station.png'),
      ),
    );

void _expectDecodedSkin(WidgetTester tester) {
  var triangleCount = 0;
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>()) {
      if (!op.asset.endsWith('art/ui/harbor-frame-refined.png')) continue;
      triangleCount += 1;
      expect(painter.images[op.asset], isNotNull);
    }
  }
  expect(
    triangleCount,
    greaterThanOrEqualTo(18),
    reason: 'Game decoration must render its actual registered image skin',
  );
}

Future<void> _waitForCanvasResize(
  WidgetTester tester,
  double expectedWidth,
) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
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

Future<void> _capture(
  WidgetTester tester,
  GlobalKey captureKey,
  String name,
) async {
  await tester.pump(const Duration(milliseconds: 100));
  final boundary =
      captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(() => boundary.toImage());
  try {
    final png = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    final path = '${Directory.systemTemp.path}/pocket-novel-$name.png';
    await tester.runAsync(
      () => File(path).writeAsBytes(png!.buffer.asUint8List()),
    );
    debugPrint('novel-large-screen: capture=$path');
  } finally {
    image?.dispose();
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'the real game reflows within a desktop window without remounting',
    (tester) async {
      final window = tester.view.physicalSize / tester.view.devicePixelRatio;
      expect(window.width, greaterThan(600), reason: 'Run on a desktop window');
      var available = Size(math.min(390, window.width), window.height);
      final captureKey = GlobalKey();
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
                  child: RepaintBoundary(
                    key: captureKey,
                    child: pocketHostApp(),
                  ),
                ),
              );
            },
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        if (guest.texts(tester).contains('轻触显全')) {
          await guest.tapGuest(tester, '轻触显全', scroll: false);
        }
        await guest.waitFor(tester, '轻触继续  ›');
        final controller = tester
            .widget<PocketView>(guest.activePocketViewFinder())
            .controller;

        // These are real Flutter layout-constraint changes within the actual
        // desktop window, not a claim that the OS window itself was resized.
        for (final entry in <String, Size>{
          'wide': window,
          'short': Size(window.width, math.min(340, window.height)),
          'narrow': Size(math.min(390, window.width), window.height),
        }.entries) {
          resize(() => available = entry.value);
          await tester.pump(const Duration(milliseconds: 600));
          // Root compositor and child each commit a post-layout native resize.
          // A retained old line can paint throughout that handoff; wait for
          // the actual child frame dimensions rather than text presence alone.
          await _waitForCanvasResize(tester, available.width);
          await guest.waitForContaining(tester, '23点08分');
          final view = tester.widget<PocketView>(
            guest.activePocketViewFinder(),
          );
          expect(identical(view.controller, controller), isTrue);
          final box = tester.renderObject<RenderBox>(
            guest.activePocketViewFinder(),
          );
          final frame = _gameFrame(tester);
          expect(frame.width, closeTo(box.size.width, .01));
          expect(frame.height, closeTo(box.size.height, .01));
          expect(frame.width, closeTo(available.width, .01));
          final background = frame.ops.whereType<PocketImageOp>().firstWhere(
            (op) => op.asset.endsWith('art/station.png'),
          );
          // Scene art covers the complete canvas; only controls consume the
          // status-bar and home-indicator safe insets.
          expect(background.x, lessThanOrEqualTo(1));
          expect(background.y, lessThanOrEqualTo(1));
          expect(
            background.x + background.width,
            greaterThanOrEqualTo(frame.width - 1),
          );
          expect(
            background.y + background.height,
            greaterThanOrEqualTo(frame.height - 1),
          );
          expect(frame.images[background.asset], isNotNull);
          final dialogue = guest
              .painters(tester)
              .expand((widget) => (widget.painter! as PocketCanvasPainter).ops)
              .whereType<PocketTextOp>()
              .firstWhere((op) => op.text.contains('23点08分'));
          expect(dialogue.width, lessThanOrEqualTo(960));
          expect(dialogue.size, lessThanOrEqualTo(24));
          if (entry.key == 'wide') {
            expect(dialogue.width, greaterThan(360));
          }
          _expectDecodedSkin(tester);
          await _capture(tester, captureKey, entry.key);
          await guest.tapGuest(tester, '手札', scroll: false);
          await guest.waitFor(tester, '旅途手札');
          _expectDecodedSkin(tester);
          await guest.tapGuest(tester, '继续阅读');
          await guest.waitForContaining(tester, '23点08分');
          debugPrint(
            'novel-large-screen: ${entry.key} '
            '${frame.width}x${frame.height}, dialogue=${dialogue.width}',
          );
        }
        await guest.tapGuest(tester, '轻触继续  ›', scroll: false);
        await guest.waitForContaining(tester, '我送一封信');
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
