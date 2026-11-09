import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:video_player/video_player.dart';

import 'guest_interaction_test.dart' as guest;

VideoPlayerController? _player(WidgetTester tester) {
  final players = tester.widgetList<VideoPlayer>(
    find.byType(VideoPlayer, skipOffstage: false),
  );
  return players.isEmpty ? null : players.first.controller;
}

Future<void> _until(
  WidgetTester tester,
  bool Function() condition,
  String message,
) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (condition()) return;
  }
  fail('$message; actual guest labels: ${guest.texts(tester)}');
}

String _labels(WidgetTester tester) =>
    guest.texts(tester).join(' ').replaceAll(RegExp(r'\s+'), ' ');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('JS inspect and seek return actual decoder facts', (
    tester,
  ) async {
    final system = PocketSystemHostController();
    try {
      await tester.pumpWidget(
        pocketHostApp(systemController: system, showFlutterFps: false),
      );
      await guest.waitFor(tester, '00');
      final root = system.instances.singleWhere((item) => item.isSystemUI);
      root.session.controller.send(
        method: 'demo.navigate',
        params: const {'route': 'video'},
      );
      await guest.waitFor(tester, 'Video Lab');
      await guest.tapGuest(tester, 'Coverage');
      await guest.reveal(tester, 'Inspect progress');
      await _until(
        tester,
        () => _player(tester)?.value.isInitialized == true,
        'The installed platform decoder must initialize the real MP4',
      );
      final first = _player(tester)!;
      expect(first.value.duration.inMilliseconds, greaterThan(1000));
      expect(first.value.isPlaying, isFalse);
      await guest.tapGuest(tester, 'Inspect progress');
      await _until(
        tester,
        () => _labels(tester).contains('Native time ·'),
        'The correlated JS inspect promise must resolve',
      );
      expect(
        _labels(tester),
        contains('0 / ${first.value.duration.inMilliseconds} ms'),
      );
      await guest.tapGuest(tester, 'Seek to 1s');
      await _until(
        tester,
        () => _labels(tester).contains('Seek complete ·'),
        'The correlated JS seek promise must resolve after native seekTo',
      );
      expect(first.value.position.inMilliseconds, closeTo(1000, 150));
      expect(first.value.isPlaying, isFalse);
      final seek = RegExp(
        r'Seek complete · (\d+) / (\d+) ms',
      ).firstMatch(_labels(tester));
      expect(seek, isNotNull);
      expect(int.parse(seek!.group(1)!), closeTo(1000, 150));
      expect(int.parse(seek.group(2)!), first.value.duration.inMilliseconds);

      await guest.tapGuest(tester, 'Play');
      await _until(
        tester,
        () => first.value.position.inMilliseconds > 1200,
        'Playback must continue from the actual seek position',
      );
      await guest.tapGuest(tester, 'Explicit pause');
      await _until(
        tester,
        () => !first.value.isPlaying,
        'Pause must reach decoder',
      );
      await guest.tapGuest(tester, 'Inspect progress');
      await _until(
        tester,
        () => _labels(tester).contains('Native time ·'),
        'Inspect must return the paused decoder position',
      );
      final paused = RegExp(
        r'Native time · (\d+) / (\d+) ms',
      ).firstMatch(_labels(tester));
      expect(paused, isNotNull);
      expect(
        int.parse(paused!.group(1)!),
        closeTo(first.value.position.inMilliseconds, 150),
      );
      expect(int.parse(paused.group(2)!), first.value.duration.inMilliseconds);
      expect(root.session.failure, isNull);
      debugPrint(
        'video-media-facts: duration=${first.value.duration.inMilliseconds}, '
        'paused=${first.value.position.inMilliseconds}, '
        'JS=${paused.group(0)}',
      );
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      system.dispose();
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
