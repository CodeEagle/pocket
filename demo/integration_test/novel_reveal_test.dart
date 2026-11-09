import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

Iterable<PocketCanvasPainter> _activePainters(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
      find.descendant(
        of: guest.activePocketViewFinder(),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is PocketCanvasPainter,
        ),
      ),
    )
    .map((widget) => widget.painter! as PocketCanvasPainter);

Future<void> _frame(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 20));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 5)),
  );
}

Future<void> _tap(WidgetTester tester, String label) async {
  final point = await guest.reveal(tester, label, scroll: false);
  final gesture = await tester.startGesture(point);
  await _frame(tester);
  await gesture.up();
  await _frame(tester);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.reportData = {
    'pocketAcceptance': {
      'required': [
        'novel-reveal-four-directions',
        'novel-reveal-decoded-pixels',
        'novel-reveal-disposal',
      ],
      'completed': <String>[],
    },
  };
  testWidgets(
    'the shipped scene theater clips decoded art while keeping its HUD fixed',
    (tester) async {
      final support = IsolatedNovelSupportDirectory();
      await support.install();
      final captureKey = GlobalKey();
      final evidence = await Directory.systemTemp.createTemp(
        'pocket-reveal-evidence-',
      );
      final captures = <Map<String, Object>>[];
      try {
        await tester.pumpWidget(
          RepaintBoundary(key: captureKey, child: pocketHostApp()),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        for (
          var i = 0;
          i < 1000 && !guest.texts(tester).contains('启程 · 开始新的故事');
          i++
        ) {
          await _frame(tester);
        }
        await guest.tapGuest(tester, '穿雾换景');
        const directions = ['left', 'right', 'up', 'down'];
        const backgrounds = ['station', 'archive', 'roof', 'dawn'];
        for (var index = 0; index < directions.length; index++) {
          PocketCanvasPainter? observed;
          PocketImageOp? incoming;
          for (var i = 0; i < 200; i++) {
            await _frame(tester);
            for (final painter in _activePainters(tester)) {
              for (final op in painter.ops.whereType<PocketImageOp>()) {
                if (!op.asset.endsWith('art/${backgrounds[index]}.png') ||
                    op.clip == null) {
                  continue;
                }
                final clip = op.clip!;
                final fraction = index < 2
                    ? clip.width / painter.width
                    : clip.height / painter.height;
                if (fraction > .40 && fraction < .75) {
                  observed = painter;
                  incoming = op;
                }
              }
            }
            if (incoming != null) break;
          }
          expect(
            incoming,
            isNotNull,
            reason: 'Observe a real mid-reveal ${directions[index]} clip',
          );
          final painter = observed!;
          final op = incoming!;
          expect(
            painter.images[op.asset],
            isNotNull,
            reason: 'The registered scene PNG is decoded',
          );
          final clip = op.clip!;
          if (index == 0) expect(clip.x, closeTo(0, 1));
          if (index == 1) {
            expect(clip.x + clip.width, closeTo(painter.width, 1));
          }
          if (index == 2) expect(clip.y, closeTo(0, 1));
          if (index == 3) {
            expect(clip.y + clip.height, closeTo(painter.height, 1));
          }
          final hud = _activePainters(tester)
              .expand((part) => part.ops)
              .whereType<PocketTextOp>()
              .where((item) => item.text == '返回原旅程')
              .toList();
          expect(
            hud,
            isNotEmpty,
            reason:
                'The fixed HUD must be present in the same active child surface.',
          );
          expect(
            hud.every(
              (item) =>
                  item.clip == null ||
                  (item.clip!.x <= item.x + 1 &&
                      item.clip!.x + item.clip!.width >=
                          item.x + item.width - 1),
            ),
            isTrue,
            reason: 'Scene reveal must not clip the fixed player HUD',
          );
          final boundary =
              captureKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await tester.runAsync(() => boundary.toImage());
          final png = await tester.runAsync(
            () => image!.toByteData(format: ui.ImageByteFormat.png),
          );
          final path = '${evidence.path}/${directions[index]}.png';
          await tester.runAsync(
            () => File(path).writeAsBytes(png!.buffer.asUint8List()),
          );
          image!.dispose();
          captures.add({
            'direction': directions[index],
            'clip': [clip.x, clip.y, clip.width, clip.height],
            'asset': op.asset,
            'capture': path,
          });
          // Reveal the current dialogue, then advance using the same painted pointer target.
          for (var i = 0; i < 90; i++) {
            await _frame(tester);
          }
          if (index < 3) {
            if (!guest.texts(tester).contains('轻触继续  ›')) {
              await _tap(tester, '轻触显全');
            }
            await guest.waitFor(tester, '轻触继续  ›');
            await _tap(tester, '轻触继续  ›');
          }
        }
        final contract =
            binding.reportData!['pocketAcceptance'] as Map<String, dynamic>;
        contract['completed'] = [
          'novel-reveal-four-directions',
          'novel-reveal-decoded-pixels',
        ];
        binding.reportData!['novelReveal'] = {
          'platform': Platform.operatingSystem,
          'captures': captures,
        };
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        expect(tester.takeException(), isNull);
        (contract['completed'] as List<String>).add('novel-reveal-disposal');
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await support.restore();
      }
    },
  );
}
