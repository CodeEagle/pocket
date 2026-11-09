import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  binding.reportData = <String, dynamic>{
    'pocketAcceptance': <String, dynamic>{
      'required': <String>['desktop-scroll'],
      'completed': <String>[],
    },
  };

  testWidgets('desktop signals scroll the real guest without clicking', (
    tester,
  ) async {
    try {
      await tester.pumpWidget(
        Align(
          alignment: Alignment.topLeft,
          child: Padding(
            padding: const EdgeInsets.only(left: 40, top: 20),
            child: SizedBox(width: 390, height: 560, child: pocketHostApp()),
          ),
        ),
      );
      await guest.waitFor(tester, 'Input round-trip');
      await _settle(tester);
      final intro = _text(tester, 'Made to feel native.')!;
      final header = _text(tester, 'Pocket')!;
      final navigation = _text(tester, 'Home')!;
      final counter = guest
          .texts(tester)
          .where((s) => RegExp(r'^\d{2}$').hasMatch(s))
          .toList();
      expect(counter, isNotEmpty);

      final view = tester.renderObject<RenderBox>(find.byType(PocketView));
      final body = view.localToGlobal(
        Offset(view.size.width * .85, view.size.height * .55),
      );
      await _wheel(tester, body, 150);
      final afterWheel = _text(tester, 'Made to feel native.');
      expect(afterWheel == null || afterWheel.dy < intro.dy - 30, isTrue);
      expect(_text(tester, 'Pocket')!.dy, closeTo(header.dy, 2));
      expect(_text(tester, 'Home')!.dy, closeTo(navigation.dy, 2));

      await _wheel(tester, body, -1000);
      await guest.waitFor(tester, 'Made to feel native.');
      final restored = _text(tester, 'Made to feel native.')!;
      expect(restored.dy, closeTo(intro.dy, 2));
      // The header is fixed chrome, outside the actual JS page scroller.
      final headerPoint = guest.pointFor(tester, 'Pocket');
      expect(headerPoint, isNotNull);
      await _wheel(tester, headerPoint!, 180);
      expect(
        _text(tester, 'Made to feel native.')!.dy,
        closeTo(restored.dy, 2),
      );

      const pointer = 42001;
      await tester.sendEventToBinding(
        PointerPanZoomStartEvent(pointer: pointer, position: body),
      );
      await tester.pump(const Duration(milliseconds: 16));
      for (var i = 1; i <= 4; i++) {
        await tester.sendEventToBinding(
          PointerPanZoomUpdateEvent(
            pointer: pointer,
            position: body,
            pan: Offset(0, -40.0 * i),
            panDelta: const Offset(0, -40),
          ),
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.sendEventToBinding(
        PointerPanZoomEndEvent(pointer: pointer, position: body),
      );
      await _settle(tester);
      final afterTrackpad = _text(tester, 'Made to feel native.');
      expect(
        afterTrackpad == null || afterTrackpad.dy < restored.dy - 30,
        isTrue,
      );
      expect(_text(tester, 'Home')!.dy, closeTo(navigation.dy, 2));

      await _wheel(tester, body, -1000);
      await guest.waitFor(tester, 'Made to feel native.');
      for (final value in counter) {
        expect(
          guest.texts(tester),
          contains(value),
          reason: 'scroll must not activate a counter control',
        );
      }
      // Also reach the actual game entry through wheel events, not fake drags.
      const game = '雾港末班信 · Visual Novel';
      for (var i = 0; i < 12 && guest.pointFor(tester, game) == null; i++) {
        await _wheel(tester, body, 160);
      }
      expect(guest.pointFor(tester, game), isNotNull);
      await guest.tapGuest(tester, game, scroll: false);
      await guest.waitFor(tester, '启程 · 开始新的故事');
      final titlePoint = guest.pointFor(tester, '启程 · 开始新的故事');
      expect(titlePoint, isNotNull);
      final titleBefore = _text(tester, '启程 · 开始新的故事')!;
      await _wheel(tester, titlePoint!, 120);
      final titleAfter = _text(tester, '启程 · 开始新的故事');
      expect(titleAfter == null || titleAfter.dy < titleBefore.dy - 20, isTrue);
      // The menu remains a menu; a scroll over its start control is no click.
      expect(guest.texts(tester).any((s) => s.contains('轻触继续')), isFalse);

      binding.reportData!['desktopScroll'] = <String, dynamic>{
        'kind':
            'Flutter pointer signal and panZoom -> native transport -> real bytecode -> JS-rendered frame',
        'wheelIntroBefore': intro.dy,
        'wheelIntroAfter': afterWheel?.dy,
        'trackpadIntroAfter': afterTrackpad?.dy,
        'titleStartBefore': titleBefore.dy,
        'titleStartAfter': titleAfter?.dy,
        'physicalHardwareInput': false,
      };
      (binding.reportData!['pocketAcceptance']
          as Map<String, dynamic>)['completed'] = <String>[
        'desktop-scroll',
      ];
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}

Future<void> _wheel(WidgetTester tester, Offset position, double delta) async {
  await tester.sendEventToBinding(
    PointerScrollEvent(
      position: position,
      scrollDelta: Offset(0, delta),
      kind: PointerDeviceKind.mouse,
    ),
  );
  await _settle(tester);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

Offset? _text(WidgetTester tester, String label) {
  for (final widget in guest.painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (op.text == label) return Offset(op.x, op.y);
    }
  }
  return null;
}
