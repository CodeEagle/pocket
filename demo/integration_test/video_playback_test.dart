import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:video_player/video_player.dart';

import 'guest_interaction_test.dart' as guest;

/// This suite deliberately uses the installed platform decoder, not the fake
/// VideoPlayerPlatform from SDK widget tests. Run on an iOS/Android device:
/// `flutter test integration_test/video_playback_test.dart -d DEVICE_ID`
Future<void> _eventually(
  WidgetTester tester,
  bool Function() condition,
  String description,
) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    if (condition()) return;
  }
  fail('$description; guest texts: ${guest.texts(tester)}');
}

VideoPlayerController? _firstPlayer(WidgetTester tester) {
  final widgets = tester.widgetList<VideoPlayer>(
    find.byType(VideoPlayer, skipOffstage: false),
  );
  return widgets.isEmpty ? null : widgets.first.controller;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'Video Lab decodes real MP4, obeys intent, and releases on removal',
    (tester) async {
      final system = PocketSystemHostController();
      try {
        await tester.pumpWidget(
          pocketHostApp(systemController: system, showFlutterFps: false),
        );
        await guest.waitFor(tester, '00');
        final root = system.instances.singleWhere((item) => item.isSystemUI);
        final controller = root.session.controller;
        expect(
          controller.send(
            method: 'demo.navigate',
            params: const {'route': 'video'},
          ),
          isTrue,
        );
        await guest.waitFor(tester, 'Video Lab');
        await guest.reveal(tester, 'Play');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isInitialized == true,
          'The bundled MP4 must initialize through the real native decoder',
        );
        final first = _firstPlayer(tester)!;
        expect(first.dataSource, 'assets/videos/clip-a.mp4');
        expect(
          first.value.isPlaying,
          isFalse,
          reason: 'Registration starts paused',
        );
        expect(first.value.hasError, isFalse);

        await guest.tapGuest(tester, 'Play');
        await _eventually(
          tester,
          () => first.value.isPlaying,
          'A real JS press must start the decoder',
        );
        await _eventually(
          tester,
          () => first.value.position > Duration.zero,
          'Native playback position must advance; button state alone is insufficient',
        );
        await guest.tapGuest(tester, 'Explicit pause');
        await _eventually(
          tester,
          () => !first.value.isPlaying,
          'Explicit pause must reach the real native decoder',
        );

        await guest.tapGuest(tester, 'Swap to clip B');
        await _eventually(
          tester,
          () =>
              _firstPlayer(tester)?.dataSource == 'assets/videos/clip-b.mp4' &&
              _firstPlayer(tester)?.value.isInitialized == true,
          'Same-id asset replacement must initialize the second bundled MP4',
        );
        final replacement = _firstPlayer(tester)!;
        expect(identical(first, replacement), isFalse);
        expect(
          replacement.value.isPlaying,
          isFalse,
          reason: 'Replacing the source must preserve an explicit pause',
        );
        expect(replacement.value.hasError, isFalse);

        await guest.tapGuest(tester, 'Remove Video');
        await guest.waitForContaining(tester, 'Hero Video disposed');
        await guest.tapGuest(tester, 'Rebuild Video');
        await _eventually(
          tester,
          () =>
              _firstPlayer(tester)?.dataSource == 'assets/videos/clip-b.mp4' &&
              _firstPlayer(tester)?.value.isInitialized == true &&
              !identical(_firstPlayer(tester), replacement),
          'Rebuild must create a fresh decoder for the retained JS asset',
        );
        expect(_firstPlayer(tester)!.value.isPlaying, isFalse);

        // A real missing-file decoder failure must stay local to its Video;
        // changing to the admitted bundled asset must recover without reload.
        await guest.reveal(tester, 'Retry with clip A');
        await guest.waitForContaining(tester, 'video-lab-retry · error');
        expect(root.session.failure, isNull);
        await guest.tapGuest(tester, 'Retry with clip A');
        await _eventually(
          tester,
          () => guest
              .texts(tester)
              .any(
                (text) =>
                    text.contains('video-lab-retry · ready') ||
                    text.contains('video-lab-retry · paused'),
              ),
          'Changing the bad asset must recover through a native ready state',
        );
        final recovered = tester
            .widgetList<VideoPlayer>(
              find.byType(VideoPlayer, skipOffstage: false),
            )
            .last
            .controller;
        expect(recovered.dataSource, 'assets/videos/clip-a.mp4');
        expect(recovered.value.isInitialized, isTrue);
        expect(recovered.value.hasError, isFalse);
        // This item registered while entirely outside the first DrawList.
        // Recovery is not sufficient: a lost initial pause can initialize it
        // and then incorrectly autoplay. Exercise the real decoder, too.
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(
          recovered.value.isPlaying,
          isFalse,
          reason: 'An initially offscreen paused registration must stay paused',
        );
        await guest.tapGuest(tester, 'Play retry');
        await _eventually(
          tester,
          () => recovered.value.isPlaying,
          'An initially offscreen registration must also accept explicit play',
        );
        await guest.tapGuest(tester, 'Pause retry');
        await _eventually(
          tester,
          () => !recovered.value.isPlaying,
          'Explicit pause must still reach the recovered player',
        );

        // Route policy runs in JS. Navigating away must remove the actual draw
        // node and leave no decoder texture mounted on the other page.
        controller.send(
          method: 'demo.navigate',
          params: const {'route': 'home'},
        );
        await guest.waitFor(tester, '00');
        await _eventually(
          tester,
          () =>
              find.byType(VideoPlayer, skipOffstage: false).evaluate().isEmpty,
          'Leaving Video Lab must release its native video surfaces',
        );
        controller.send(
          method: 'demo.navigate',
          params: const {'route': 'video'},
        );
        await guest.waitFor(tester, 'Video Lab');
        await guest.reveal(tester, 'Play');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isInitialized == true,
          'Returning to Video Lab must initialize a fresh node',
        );
        expect(
          _firstPlayer(tester)!.value.isPlaying,
          isFalse,
          reason: 'Explicit pause intent survives route rebuild',
        );

        // Exercise the actual JS SystemUI and child runtime, not a synthetic
        // lifecycle packet. The root video must still be visible and playing
        // immediately before launch, so offscreen pausing cannot pass this.
        await guest.tapGuest(tester, 'Coverage');
        await guest.tapGuest(tester, 'Play');
        final covered = _firstPlayer(tester)!;
        await _eventually(
          tester,
          () => covered.value.isPlaying,
          'Root video must play before the MiniApp opens',
        );
        await guest.reveal(tester, 'Open Profile MiniApp');
        expect(
          covered.value.isPlaying,
          isTrue,
          reason: 'Coverage test must not start with an offscreen video',
        );
        await guest.tapGuest(tester, 'Open Profile MiniApp');
        await guest.waitFor(tester, 'Pocket Profile');
        await _eventually(
          tester,
          () =>
              !covered.value.isPlaying ||
              (tester
                      .widgetList<VideoPlayer>(
                        find.byType(VideoPlayer, skipOffstage: false),
                      )
                      .every(
                        (widget) => !identical(widget.controller, covered),
                      ) &&
                  guest
                      .texts(tester)
                      .any(
                        (text) => text.contains('video-lab-hero · disposed'),
                      )),
          'A real child must pause or release the fully covered root video',
        );
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.waitFor(tester, 'Video Lab');
        // Full compositor occlusion may release the decoder. Retired
        // controllers keep their last value; inspect the current player.
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isPlaying == true,
          'Returning the child result must restore the root play intent',
        );
        final returned = _firstPlayer(tester)!;
        await guest.tapGuest(tester, 'Explicit pause');
        await _eventually(
          tester,
          () => !returned.value.isPlaying,
          'Explicit pause must remain authoritative after a child result',
        );

        await guest.tapGuest(tester, 'Open Profile MiniApp');
        await guest.waitFor(tester, 'Pocket Profile');
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.waitFor(tester, 'Video Lab');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isInitialized == true,
          'A paused video must be available again after coverage ends',
        );
        // Allow the asynchronous native playback pump to finish; observing
        // initialization alone could miss a late, erroneous autoplay call.
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(
          _firstPlayer(tester)!.value.isPlaying,
          isFalse,
          reason: 'Decoder recreation must not override an explicit pause',
        );

        // A fresh Scroll registration starts below a 420px spacer. No
        // VideoOp exists for it when its initial JS pause is emitted.
        controller.send(
          method: 'demo.navigate',
          params: const {'route': 'home'},
        );
        await guest.waitFor(tester, '00');
        controller.send(
          method: 'demo.navigate',
          params: const {'route': 'video'},
        );
        await guest.waitFor(tester, 'Video Lab');
        await guest.tapGuest(tester, 'Scroll');
        await guest.reveal(tester, 'Play scroll clip');
        await _eventually(
          tester,
          () =>
              _firstPlayer(tester)?.dataSource == 'assets/videos/clip-b.mp4' &&
              _firstPlayer(tester)?.value.isInitialized == true,
          'The initially offscreen clip must decode on first appearance',
        );
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(
          _firstPlayer(tester)!.value.isPlaying,
          isFalse,
          reason: 'Scrolling into view must not invent autoplay',
        );
        await guest.tapGuest(tester, 'Play scroll clip');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isPlaying == true,
          'The scroll clip must accept explicit play',
        );
        // The shared reveal helper deliberately scrolls forward only. Return
        // through real downward drags rather than asking it to find an item
        // above the viewport (which would just scroll farther away).
        for (
          var attempt = 0;
          attempt < 8 && guest.pointFor(tester, 'Scroll') == null;
          attempt++
        ) {
          final box = tester.renderObject<RenderBox>(
            guest.activePocketViewFinder(),
          );
          final gesture = await tester.startGesture(
            box.localToGlobal(
              Offset(box.size.width * .35, box.size.height * .30),
            ),
          );
          for (var step = 0; step < 10; step++) {
            await gesture.moveBy(const Offset(0, 28));
            await tester.pump(const Duration(milliseconds: 16));
          }
          await gesture.up();
          await tester.pump(const Duration(milliseconds: 120));
        }
        await guest.reveal(tester, 'Scroll', scroll: false);
        await _eventually(
          tester,
          () => tester
              .widgetList<VideoPlayer>(
                find.byType(VideoPlayer, skipOffstage: false),
              )
              .every(
                (widget) =>
                    widget.controller.dataSource != 'assets/videos/clip-b.mp4',
              ),
          'Scrolling away must release the absent native VideoOp',
        );
        await guest.reveal(tester, 'Pause scroll clip');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isPlaying == true,
          'Returning to the clip must retain its explicit playing intent',
        );
        await guest.tapGuest(tester, 'Pause scroll clip');
        await _eventually(
          tester,
          () => _firstPlayer(tester)?.value.isPlaying == false,
          'The recreated scroll decoder must still accept pause',
        );
        expect(root.session.failure, isNull);
        binding.reportData = {
          'videoPlayback': {
            'decoder': 'real installed VideoPlayerPlatform',
            'assets': ['clip-a.mp4', 'clip-b.mp4'],
            'verified': [
              'initial pause',
              'real decode and advancing position',
              'explicit pause',
              'same-id asset replacement',
              'remove/recreate',
              'local missing-asset failure and decoder retry',
              'offscreen initial pause survives first appearance and retry',
              'real scrolling releases and restores a playing decoder',
              'route release and paused return',
              'real MiniApp coverage pause and result-driven resume',
              'explicit pause survives a second real MiniApp round trip',
            ],
            'notMeasured': ['physical-device FPS/power', 'Duo hinge motion'],
          },
        };
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(milliseconds: 100));
        system.dispose();
      }
    },
  );
}
