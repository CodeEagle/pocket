import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

final captureKey = GlobalKey();

Future<void> capture(WidgetTester tester, String name) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.runAsync(() async {
    final boundary =
        captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final binding = IntegrationTestWidgetsFlutterBinding.instance;
      binding.reportData ??= <String, dynamic>{};
      final captures =
          binding.reportData!.putIfAbsent('captures', () => <String, dynamic>{})
              as Map<String, dynamic>;
      captures[name] = base64Encode(data!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

Future<void> tap(WidgetTester tester, String label, {bool scroll = true}) =>
    guest.tapGuest(tester, label, scroll: scroll);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets(
    'portrait showcase: mobile controls, navigation and optical surfaces',
    (tester) async {
      try {
        await tester.pumpWidget(
          Align(
            alignment: Alignment.topLeft,
            child: RepaintBoundary(
              key: captureKey,
              child: const SizedBox(
                width: 390,
                height: 780,
                child: PocketHostApp(),
              ),
            ),
          ),
        );
        await guest.waitFor(tester, '00');
        await capture(tester, '01-home');
        await tap(tester, 'Mobile UI');
        await guest.waitFor(tester, 'Scaffold + AppBar');
        await capture(tester, '02-mobile-light');
        await tap(tester, 'Dark');
        await guest.waitFor(tester, 'Light');
        await capture(tester, '03-mobile-dark');
        await tap(tester, 'Controls');
        await tap(tester, 'Enabled');
        await guest.waitFor(tester, 'Disabled');
        await tap(tester, 'Show dialog');
        await guest.waitFor(tester, 'JS-owned dialog');
        await capture(tester, '04-dialog');
        await tap(tester, 'Close');
        await tap(tester, 'Overview');
        await tap(tester, 'Transitions');
        await guest.waitFor(tester, 'Push Mobile');
        await capture(tester, '05-transitions');
        await tap(tester, 'Push Mobile');
        await guest.waitFor(tester, 'Scaffold + AppBar');
        await tap(tester, 'Gallery', scroll: false);
        await tap(tester, 'Liquid Glass');
        await guest.waitFor(tester, 'Glass region');
        for (
          var i = 0;
          i < 60 && find.byType(BackdropFilter).evaluate().isEmpty;
          i++
        ) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(
          find.byType(BackdropFilter),
          findsWidgets,
          reason:
              'JS glass must reach native SURFACE_QUAD and actual Flutter backdrop',
        );
        if (ui.ImageFilter.isShaderFilterSupported) {
          for (
            var i = 0;
            i < 60 &&
                find
                    .byKey(const ValueKey('pocket-glass-refractive'))
                    .evaluate()
                    .isEmpty;
            i++
          ) {
            await tester.pump(const Duration(milliseconds: 50));
          }
          expect(
            find.byKey(const ValueKey('pocket-glass-refractive')),
            findsWidgets,
          );
        }
        expect(find.byKey(const ValueKey('pocket-glass-failed')), findsNothing);
        await capture(tester, '06-liquid-glass');
        await tap(tester, 'pill');
        await capture(tester, '07-liquid-pill');
        await tap(tester, 'Home', scroll: false);
        await guest.waitFor(tester, '00');
        expect(
          find.byType(BackdropFilter),
          findsNothing,
          reason:
              'leaving a JS glass component releases its compositor surface',
        );
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
