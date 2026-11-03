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
        for (final label in ['Home', 'Gallery', 'Host'])
          label: _textGeometry(tester, label),
      };
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
              child: const SizedBox(
                width: 390,
                height: 780,
                child: PocketHostApp(),
              ),
            ),
          ),
        ),
      );
      await guest.waitFor(tester, '00');
      await capture(tester, '01-home');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
      await tap(tester, 'Mobile UI');
      await guest.waitFor(tester, 'Scaffold + AppBar');
      expect(
        guest.pointFor(tester, 'Gallery'),
        isNotNull,
        reason: 'secondary page content must leave the fixed navigation usable',
      );
      await capture(tester, '02-mobile-light');
      _recordDarkTap(binding, tester, 'before');
      darkPointerTrace.clear();
      captureDarkPointer = true;
      try {
        await tap(tester, 'Dark');
        await guest.waitFor(tester, 'Light');
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
      _recordDarkTap(
        binding,
        tester,
        'afterSuccess',
        pointerTrace: darkPointerTrace,
      );
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
      expect(guest.texts(tester), isNot(contains('Glass morph')));
      await capture(tester, '05-transitions');
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });

  testWidgets('Home and Gallery omit the deferred Glass entry', (tester) async {
    try {
      await tester.pumpWidget(
        const Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: 390, height: 780, child: PocketHostApp()),
        ),
      );
      await guest.waitFor(tester, '00');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
      await tap(tester, 'Gallery');
      await guest.waitFor(tester, 'Official building blocks');
      expect(guest.texts(tester), isNot(contains('Liquid Glass')));
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
