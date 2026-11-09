import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

Rect _expanded(PocketDisplayRegion region) => Rect.fromLTRB(
  region.frame.left - region.margins.left,
  region.frame.top - region.margins.top,
  region.frame.right + region.margins.right,
  region.frame.bottom + region.margins.bottom,
);

Future<void> _waitProfile(WidgetTester tester, PocketSystemHostController host, bool presented) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final instances = host.instances.where((item) => item.appId == 'pocket.demo.profile');
    if (presented
        ? instances.any((item) => item.firstFrameReady && item.isPresented)
        : instances.every((item) => !item.isPresented)) {
      return;
    }
  }
  fail('Profile presented=$presented was not reached; ${guest.texts(tester)}');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('real Duo close hit target clears native occlusions on both opens', (tester) async {
    final host = PocketSystemHostController();
    final geometry = PocketDisplayGeometryChannel();
    PocketDisplayGeometrySnapshot? latest;
    void receive(PocketDisplayGeometrySnapshot value) => latest = value;
    final cycles = <Map<String, Object?>>[];
    try {
      await tester.pumpWidget(pocketHostApp(systemController: host, showFlutterFps: false));
      await guest.waitFor(tester, '00');
      latest = await geometry.start(onUpdate: receive);
      expect(latest!.supported, isTrue);
      final root = host.instances.singleWhere((item) => item.isSystemUI);
      for (var cycle = 0; cycle < 2; cycle++) {
        await guest.tapGuest(tester, 'Open profile app');
        await _waitProfile(tester, host, true);
        await guest.waitFor(tester, 'Pocket Profile');
        for (var frame = 0; frame < 40; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        final native = latest!;
        final viewport = native.viewport!;
        final contours = native.regions
            .where((region) => region.active && region.kind == 'occlusion')
            .map(_expanded)
            .where(
              (rect) =>
                  rect.top <= 1 &&
                  rect.right >= viewport.width - 1 &&
                  rect.width < viewport.width * .6 &&
                  rect.height < viewport.height * .6,
            )
            .toList();
        expect(contours, isNotEmpty, reason: 'Use the actual Duo status contour; do not invent geometry');
        contours.sort((a, b) => b.bottom.compareTo(a.bottom));
        final contour = contours.first;
        final hasDivision = native.regions.any(
          (region) => region.kind == 'division' && region.frame.height > viewport.height * .5,
        );
        // The public UI contract is a 44px target, 8px edge spacing. Both
        // postures keep close in the top app-bar slot immediately left of
        // the measured top-right contour; folded Duo must not place it in
        // the rail below the status icons.
        final point = Offset(contour.left - 30, 30);
        final hit = Rect.fromCenter(center: point, width: 44, height: 44);
        expect((Offset.zero & viewport).contains(hit.topLeft), isTrue);
        expect((Offset.zero & viewport).contains(hit.bottomRight), isTrue);
        for (final region in native.regions.where((region) => region.active && region.kind == 'occlusion')) {
          expect(hit.overlaps(_expanded(region)), isFalse);
        }
        final finder = find.byWidgetPredicate(
          (widget) => widget is PocketView && identical(widget.controller, root.session.controller),
        );
        final box = tester.renderObject<RenderBox>(finder);
        expect(box.size.width, closeTo(viewport.width, 1));
        expect(box.size.height, closeTo(viewport.height, 1));
        // This is an actual input test: if the late-mounted close control
        // still uses EMPTY or stale geometry, this safe target will not close
        // the child. Do not infer success from a computed coordinate alone.
        debugPrint(
          'DUO_MINIAPP_CLOSE_ATTEMPT cycle=$cycle viewport=${viewport.width}x${viewport.height} '
          'division=$hasDivision contour=$contour point=$point box=${box.size} '
          'origin=${box.localToGlobal(Offset.zero)} regions=${native.regions.map((region) => region.toJson()).toList()}',
        );
        final gesture = await tester.startGesture(box.localToGlobal(point));
        await tester.pump(const Duration(milliseconds: 50));
        await gesture.up();
        await _waitProfile(tester, host, false);
        cycles.add({
          'cycle': cycle,
          'viewport': [viewport.width, viewport.height],
          'hit': [hit.left, hit.top, hit.width, hit.height],
          'regions': [for (final region in native.regions) region.toJson()],
          'closedByRealPointer': true,
        });
        debugPrint('DUO_MINIAPP_CLOSE ${jsonEncode(cycles.last)}');
        await guest.waitFor(tester, 'Open profile app');
      }
      binding.reportData = {
        'duoMiniAppClose': cycles,
        'notMeasured': ['physical hinge movement / open posture in this run'],
      };
    } finally {
      await geometry.stop(onUpdate: receive);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      host.dispose();
    }
  });
}
