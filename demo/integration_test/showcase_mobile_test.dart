import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

final captureKey = GlobalKey();

Map<String, double> _offsetJson(Offset value) => <String, double>{
  'x': value.dx,
  'y': value.dy,
};

Map<String, double> _rectJson(Rect value) => <String, double>{
  'left': value.left,
  'top': value.top,
  'right': value.right,
  'bottom': value.bottom,
};

Map<String, Object?> _textGeometry(WidgetTester tester, String label) {
  final entries = <Map<String, Object?>>[];
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    final origin = box.localToGlobal(Offset.zero);
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (op.text != label) continue;
      entries.add(<String, Object?>{
        'rawRect': _rectJson(Rect.fromLTWH(op.x, op.y, op.width, op.height)),
        'clip': op.clip == null
            ? null
            : _rectJson(
                Rect.fromLTWH(
                  op.clip!.x,
                  op.clip!.y,
                  op.clip!.width,
                  op.clip!.height,
                ),
              ),
        'painterSize': <String, double>{
          'width': painter.width,
          'height': painter.height,
        },
        'renderBoxSize': <String, double>{
          'width': box.size.width,
          'height': box.size.height,
        },
        'globalOrigin': _offsetJson(origin),
      });
    }
  }
  final point = guest.pointFor(tester, label);
  return <String, Object?>{
    'pointFor': point == null ? null : _offsetJson(point),
    'entries': entries,
  };
}

void _recordDarkTap(
  IntegrationTestWidgetsFlutterBinding binding,
  WidgetTester tester,
  String phase, {
  List<Map<String, Object?>> pointerTrace = const <Map<String, Object?>>[],
  Object? error,
  StackTrace? stackTrace,
}) {
  binding.reportData ??= <String, dynamic>{};
  final report =
      binding.reportData!.putIfAbsent(
            'showcaseDarkTap',
            () => <String, Object?>{},
          )
          as Map<String, Object?>;
  report[phase] = <String, Object?>{
    'dark': _textGeometry(tester, 'Dark'),
    'light': _textGeometry(tester, 'Light'),
    'allTexts': guest.texts(tester),
    'pointerTrace': List<Map<String, Object?>>.from(pointerTrace),
    if (error != null) 'error': error.toString(),
    if (stackTrace != null) 'stackTrace': stackTrace.toString(),
  };
}

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
      final geometry =
          binding.reportData!.putIfAbsent(
                'captureGeometry',
                () => <String, dynamic>{},
              )
              as Map<String, dynamic>;
      geometry[name] = <String, Object?>{
        for (final label in ['Home', 'UI', 'Host', 'Settings'])
          label: _textGeometry(tester, label),
      };
    } finally {
      image.dispose();
    }
  });
}

Future<void> tap(WidgetTester tester, String label, {bool scroll = true}) =>
    guest.tapGuest(tester, label, scroll: scroll);

Future<void> tapBackIcon(WidgetTester tester) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    for (final widget in guest.painters(tester)) {
      final painter = widget.painter! as PocketCanvasPainter;
      final textOps = painter.ops.whereType<PocketTextOp>().toList();
      expect(textOps.any((op) => op.text == 'Back'), isFalse);
      if (textOps.isEmpty) continue;
      final titleY = textOps.map((op) => op.y).reduce((a, b) => a < b ? a : b);
      final points = <PocketPoint>[];
      var triangles = 0;
      for (final op in painter.ops) {
        final vertices = switch (op) {
          PocketTriangleOp() => op.points,
          PocketTextureTriangleOp() => op.points,
          _ => <PocketPoint>[],
        };
        if (vertices.length == 3 &&
            vertices.every(
              (point) =>
                  point.x > 0 &&
                  point.x < 88 &&
                  point.y >= titleY - 24 &&
                  point.y <= titleY + 40,
            )) {
          triangles++;
          points.addAll(vertices);
        }
      }
      if (triangles < 4) continue;
      final left = points
          .map((point) => point.x)
          .reduce((a, b) => a < b ? a : b);
      final right = points
          .map((point) => point.x)
          .reduce((a, b) => a > b ? a : b);
      final top = points
          .map((point) => point.y)
          .reduce((a, b) => a < b ? a : b);
      final bottom = points
          .map((point) => point.y)
          .reduce((a, b) => a > b ? a : b);
      expect(right - left, inExclusiveRange(5, 32));
      expect(bottom - top, inExclusiveRange(10, 36));
      final box = tester.renderObject<RenderBox>(find.byWidget(widget));
      await tester.tapAt(
        box.localToGlobal(
          Offset(
            (left + right) / 2 * box.size.width / painter.width,
            (top + bottom) / 2 * box.size.height / painter.height,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      return;
    }
    await tester.pump(const Duration(milliseconds: 20));
  }
  fail('Secondary app bar did not paint a back arrow icon');
}

void expectPrimaryNavigationHidden(WidgetTester tester) {
  for (final label in ['Home', 'UI', 'Host', 'Settings']) {
    final point = guest.pointFor(tester, label);
    expect(
      point == null || point.dy < 700,
      isTrue,
      reason: 'secondary pages must hide the bottom $label navigation item',
    );
  }
}

Future<void> waitForPaintColor(WidgetTester tester, int color) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    for (final widget in guest.painters(tester)) {
      final painter = widget.painter! as PocketCanvasPainter;
      if (painter.ops.whereType<PocketRectOp>().any(
        (op) => op.color == color,
      )) {
        return;
      }
    }
    await tester.pump(const Duration(milliseconds: 20));
  }
  fail('The real guest did not paint color 0x${color.toRadixString(16)}');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('portrait showcase: mobile controls and navigation', (
    tester,
  ) async {
    var captureDarkPointer = false;
    final darkPointerTrace = <Map<String, Object?>>[];
    void recordDarkPointer(PointerEvent event) {
      if (!captureDarkPointer) return;
      darkPointerTrace.add(<String, Object?>{
        'type': event.runtimeType.toString(),
        'pointer': event.pointer,
        'kind': event.kind.name,
        'position': _offsetJson(event.position),
        'localPosition': _offsetJson(event.localPosition),
        'buttons': event.buttons,
        'timeStampUs': event.timeStamp.inMicroseconds,
      });
    }

    try {
      await tester.pumpWidget(
        Align(
          alignment: Alignment.topLeft,
          child: Listener(
            behavior: HitTestBehavior.translucent,
            onPointerDown: recordDarkPointer,
            onPointerMove: recordDarkPointer,
            onPointerUp: recordDarkPointer,
            onPointerCancel: recordDarkPointer,
            child: RepaintBoundary(
              key: captureKey,
              child: SizedBox(
                width: 390,
                height: 780,
                child: pocketHostApp(),
              ),
            ),
          ),
        ),
      );
      await guest.waitFor(tester, '00');
      await tap(tester, 'Settings', scroll: false);
      await guest.waitFor(tester, 'Appearance');
      await tap(tester, 'Light');
      await tap(tester, 'Blue');
      await capture(tester, '00-settings-light');
      await tap(tester, 'Home', scroll: false);
      await guest.waitFor(tester, '00');
      await capture(tester, '01-home');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
      await tap(tester, 'Mobile UI');
      await guest.waitFor(tester, 'Scaffold + AppBar');
      expectPrimaryNavigationHidden(tester);
      await capture(tester, '02-mobile-light');

      // Theme changes are owned by the primary Settings route. Return from
      // the secondary Mobile page first, mutate the persisted JS preference,
      // then use the primary tab again to verify the new theme on Mobile.
      await tapBackIcon(tester);
      await guest.waitFor(tester, 'Pocket');
      await tap(tester, 'Settings', scroll: false);
      await guest.waitFor(tester, 'Appearance');
      _recordDarkTap(binding, tester, 'before');
      darkPointerTrace.clear();
      captureDarkPointer = true;
      try {
        await tap(tester, 'Dark');
        await waitForPaintColor(tester, 0xff0e1728);
      } catch (error, stackTrace) {
        captureDarkPointer = false;
        _recordDarkTap(
          binding,
          tester,
          'afterFailure',
          pointerTrace: darkPointerTrace,
          error: error,
          stackTrace: stackTrace,
        );
        rethrow;
      }
      captureDarkPointer = false;
      await tap(tester, 'Violet');
      await waitForPaintColor(tester, 0xff8b5cf6);
      await capture(tester, '03-settings-dark-violet');
      _recordDarkTap(
        binding,
        tester,
        'afterSuccess',
        pointerTrace: darkPointerTrace,
      );
      await tap(tester, 'Home', scroll: false);
      await guest.waitFor(tester, 'Pocket');
      await tap(tester, 'Mobile UI');
      await guest.waitFor(tester, 'Scaffold + AppBar');
      await waitForPaintColor(tester, 0xff0e1728);
      expectPrimaryNavigationHidden(tester);
      await capture(tester, '03-mobile-dark');
      await tap(tester, 'Controls');
      await tap(tester, 'Enabled');
      await guest.waitFor(tester, 'Disabled');
      await tap(tester, 'Async off');
      await guest.waitFor(tester, 'Complete change');
      await tester.pump(const Duration(milliseconds: 400));
      await capture(tester, '04-toggle-loading');
      await tap(tester, 'Complete change');
      await guest.waitFor(tester, 'Async on');
      await tester.pump(const Duration(milliseconds: 350));
      await tap(tester, 'Async on');
      await guest.waitFor(tester, 'Reject change');
      await tester.pump(const Duration(milliseconds: 350));
      await tap(tester, 'Reject change');
      for (
        var attempt = 0;
        attempt < 50 && guest.texts(tester).contains('Complete change');
        attempt++
      ) {
        await tester.pump(const Duration(milliseconds: 20));
      }
      expect(guest.texts(tester), isNot(contains('Complete change')));
      await guest.waitFor(tester, 'Async on');
      await tester.pump(const Duration(milliseconds: 350));
      await capture(tester, '04-toggle-rollback');
      await tap(tester, '+');
      await guest.waitFor(tester, '4');
      await guest.waitFor(tester, '40%');
      await tester.pump(const Duration(milliseconds: 300));
      await tap(tester, 'Show dialog');
      await guest.waitFor(tester, 'Confirm action');
      await capture(tester, '04-dialog');
      await tap(tester, 'Close');
      // Controls scrolls below its section selector. Reveal the selector by
      // dragging toward the top through actual pointer input.
      for (
        var attempt = 0;
        attempt < 6 && guest.pointFor(tester, 'Overview') == null;
        attempt++
      ) {
        final box = tester.renderObject<RenderBox>(
          guest.activePocketViewFinder(),
        );
        await tester.dragFrom(
          box.localToGlobal(Offset(box.size.width * .35, box.size.height * .3)),
          Offset(0, box.size.height * .55),
        );
        await tester.pump(const Duration(milliseconds: 300));
      }
      await tap(tester, 'Overview', scroll: false);
      await tap(tester, 'Transitions');
      await guest.waitFor(tester, 'Push Mobile');
      expect(guest.texts(tester), isNot(contains('Glass morph')));
      expectPrimaryNavigationHidden(tester);
      await capture(tester, '05-transitions');

      // Secondary routes leave through their own Back controls; primary tabs
      // are only used after returning to the root navigation shell.
      await tapBackIcon(tester);
      await guest.waitFor(tester, 'Mobile UI');
      await tapBackIcon(tester);
      await guest.waitFor(tester, 'Pocket');
      await tap(tester, 'UI', scroll: false);
      await guest.waitFor(tester, 'Official building blocks');
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });

  testWidgets('Home and UI omit the deferred Glass entry', (tester) async {
    try {
      await tester.pumpWidget(
        Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: 390, height: 780, child: pocketHostApp()),
        ),
      );
      await guest.waitFor(tester, '00');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
      await tap(tester, 'UI');
      await guest.waitFor(tester, 'Official building blocks');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
