import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/material.dart'
    show SizedBox, RepaintBoundary, GlobalKey;
import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;
import 'package:pocket_flutter/pocket_flutter.dart'
    show PocketCanvasPainter, PocketTextOp, PocketImageOp;
import 'package:video_player/video_player.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

const _asset = 'assets/apps/lantern/videos/archive-route-reel.mp4';
final _captureKey = GlobalKey();
final _isolatedSupport = IsolatedNovelSupportDirectory();
late String _normalAppSupportPath;

Future<void> _expectIsolatedSupportPath() async {
  final support = await getApplicationSupportDirectory();
  expect(support.path, _isolatedSupport.path);
  expect(support.path, isNot(_normalAppSupportPath));
  expect(
    support.path.startsWith(
      '${Directory.systemTemp.path}${Platform.pathSeparator}',
    ),
    isTrue,
    reason: 'The real platform store must use a temporary test directory.',
  );
}

Future<void> _captureDial(WidgetTester tester) async {
  final images = guest
      .painters(tester)
      .map((widget) => widget.painter! as PocketCanvasPainter)
      .where(
        (painter) => painter.ops.whereType<PocketImageOp>().any(
          (op) =>
              op.asset.endsWith('art/ui/relay-dial.png') &&
              painter.images[op.asset] != null,
        ),
      );
  expect(
    images,
    isNotEmpty,
    reason: 'The actual image dial must be decoded and painted.',
  );
  final boundary =
      _captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(() => boundary.toImage());
  try {
    final bytes = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    final file = File('${Directory.systemTemp.path}/pocket-novel-dial.png');
    await tester.runAsync(() => file.writeAsBytes(bytes!.buffer.asUint8List()));
    debugPrint('novel-spatial-visual: capture=${file.path}');
  } finally {
    image?.dispose();
  }
}

VideoPlayerController? _player(WidgetTester tester) {
  final players = tester.widgetList<VideoPlayer>(
    find.byType(VideoPlayer, skipOffstage: false),
  );
  return players.isEmpty ? null : players.first.controller;
}

bool _containsAny(WidgetTester tester, Iterable<String> fragments) {
  final labels = guest.texts(tester);
  return fragments.any(
    (fragment) => labels.any((label) => label.contains(fragment)),
  );
}

Future<void> _waitForAny(
  WidgetTester tester,
  Iterable<String> fragments,
  String reason,
) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    if (_containsAny(tester, fragments)) return;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail('$reason; painted=${guest.texts(tester)}');
}

Future<void> _tapAny(
  WidgetTester tester,
  List<String> candidates, {
  bool scroll = true,
}) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    for (final candidate in candidates) {
      final painted = guest
          .texts(tester)
          .where((label) => label.contains(candidate));
      if (painted.isNotEmpty) {
        await guest.tapGuest(tester, painted.first, scroll: scroll);
        return;
      }
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Could not find any guest action in $candidates; painted=${guest.texts(tester)}',
  );
}

Future<void> _advanceVisibleDialogue(WidgetTester tester) async {
  final labels = guest.texts(tester);
  for (final reveal in const ['轻触显全', 'Tap to reveal all']) {
    final hint = _firstContaining(labels, reveal);
    if (hint.isNotEmpty) {
      await guest.tapGuest(tester, hint, scroll: false);
      return;
    }
  }
  for (final next in const ['轻触继续  ›', 'Tap to continue  ›']) {
    final hint = _firstContaining(labels, next);
    if (hint.isNotEmpty) {
      await guest.tapGuest(tester, hint, scroll: false);
      return;
    }
  }
  await tester.pump(const Duration(milliseconds: 40));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 20)),
  );
}

Future<void> _choose(
  WidgetTester tester,
  String choiceId,
  String optionId,
) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    final labels = guest.texts(tester);
    final hasAdvanceHint =
        _firstContaining(labels, '轻触显全').isNotEmpty ||
        _firstContaining(labels, 'Tap to reveal all').isNotEmpty ||
        _firstContaining(labels, '轻触继续  ›').isNotEmpty ||
        _firstContaining(labels, 'Tap to continue  ›').isNotEmpty;
    if (hasAdvanceHint) {
      await _advanceVisibleDialogue(tester);
      continue;
    }

    final active = await _readDiskActive(tester);
    if (active?['kind'] == 'choice') {
      final actualChoiceId = active?['id'];
      final rawOptions = active?['options'];
      final options = rawOptions is List
          ? rawOptions.whereType<Map>().toList(growable: false)
          : const <Map>[];
      final optionSummary = options
          .map((option) => '${option['id']}: ${option['text']}')
          .join(' | ');
      if (actualChoiceId != choiceId) {
        fail(
          'Expected choice $choiceId / option $optionId, but the real guest '
          'is at $actualChoiceId; options=$optionSummary; painted=$labels',
        );
      }

      Map? selected;
      for (final option in options) {
        if (option['id'] == optionId) {
          selected = option;
          break;
        }
      }
      if (selected == null) {
        fail(
          'Choice $choiceId does not offer option $optionId; '
          'actual options=$optionSummary; painted=$labels',
        );
      }
      final optionText = selected['text'];
      final target = optionText is String
          ? _firstExact(labels, optionText)
          : '';
      if (target.isEmpty) {
        // Storage may reach the choice before its first visible stage frame.
        await tester.pump(const Duration(milliseconds: 30));
        continue;
      }
      if (choiceId == 'dial_one') await _captureDial(tester);
      await guest.tapGuest(tester, target);
      return;
    }

    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail(
    'Expected choice $choiceId / option $optionId; '
    'actual=${await _readDiskActive(tester)}; painted=${guest.texts(tester)}',
  );
}

String _compact(String value) => value.replaceAll(RegExp(r'\s+'), '');

String _firstContaining(Iterable<String> labels, String text) {
  final target = _compact(text);
  for (final label in labels) {
    if (_compact(label).contains(target)) return label;
  }
  return '';
}

String _firstExact(Iterable<String> labels, String text) {
  final target = _compact(text);
  for (final label in labels) {
    if (_compact(label) == target) return label;
  }
  return '';
}

Future<void> _waitForVideo(WidgetTester tester) async {
  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < const Duration(seconds: 20)) {
    final player = _player(tester);
    if (player?.value.isInitialized == true &&
        player!.value.duration.inMilliseconds > 1000) {
      expect(player.dataSource, _asset);
      expect(player.dataSourceType, DataSourceType.asset);
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
  }
  fail(
    'The real Lantern MP4 did not initialize; painted=${guest.texts(tester)}',
  );
}

Future<void> _waitForPlayer(
  WidgetTester tester,
  bool Function(VideoPlayerValue) predicate,
  String reason, {
  Duration timeout = const Duration(seconds: 10),
}) async {
  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final player = _player(tester);
    if (player != null &&
        player.value.isInitialized &&
        predicate(player.value)) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
  }
  fail(
    '$reason; player=${_player(tester)?.value}; painted=${guest.texts(tester)}',
  );
}

bool _enabledAction(WidgetTester tester, Iterable<String> candidates) {
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (((op.color >> 24) & 0xff) == 255 &&
          candidates.any((label) => op.text.contains(label))) {
        return true;
      }
    }
  }
  return false;
}

Future<void> _waitForEnabledAction(
  WidgetTester tester,
  List<String> candidates,
) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    if (_enabledAction(tester, candidates)) return;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail(
    'Action did not become enabled: $candidates; painted=${guest.texts(tester)}',
  );
}

Future<void> _waitForNoPlayer(WidgetTester tester) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    if (_player(tester) == null) return;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail('Close did not release the retained video player');
}

Future<Map<String, dynamic>?> _readDiskSlot(String slot) async {
  await _expectIsolatedSupportPath();
  final support = await getApplicationSupportDirectory();
  final file = File(
    '${support.path}/pocket-platform-data/pocket_platform_data.json',
  );
  try {
    final root = jsonDecode(await file.readAsString()) as Map;
    final app = (root['private'] as Map)['pocket.demo.lantern'] as Map?;
    final value = app?['lantern.slot.$slot'];
    return value is Map ? Map<String, dynamic>.from(value) : null;
  } on Object {
    return null;
  }
}

Future<Map<String, dynamic>?> _readDiskActive(WidgetTester tester) async {
  return tester.runAsync<Map<String, dynamic>?>(() async {
    final save = await _readDiskSlot('auto');
    final active = save?['state']?['active'];
    return active is Map ? Map<String, dynamic>.from(active) : null;
  });
}

Future<Map<String, dynamic>> _waitForDiskSlot(
  WidgetTester tester,
  String slot,
  bool Function(Map<String, dynamic>) matches,
) async {
  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < const Duration(seconds: 20)) {
    final value = await tester.runAsync<Map<String, dynamic>?>(
      () => _readDiskSlot(slot),
    );
    if (value != null && matches(value)) return value;
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  fail('Platform save $slot did not reach the expected state');
}

Future<void> _enterArchiveReel(WidgetTester tester) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: _captureKey,
      child: pocketHostApp(showFlutterFps: false),
    ),
  );
  await guest.waitFor(tester, '00');
  await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
  await _tapAny(tester, const ['启程 · 开始新的故事', 'Begin · Start a new story']);
  await _waitForAny(tester, const [
    '23点08分',
    '23:08',
  ], 'a fresh game must start before entering the archive branch');
  await _waitForDiskSlot(
    tester,
    'auto',
    // A previous visual acceptance may already have saved this exact opening.
    // New-game saves are deterministic; equality is not evidence of staleness.
    (value) => value['state']?['active']?['id'] == 'arrival_01',
  );
  await _choose(tester, 'arrival_approach', 'ask_ren');
  await _choose(tester, 'investigation_hub', 'archive');
  await _choose(tester, 'archive_read', 'watch_archive_reel');
  await _waitForAny(tester, const [
    '七号线巡夜',
    'Route 7 night watch',
  ], 'the authored archive reel introduction must be reached');
  await _advanceUntilAny(tester, const ['镜头慢慢靠近', 'camera drifts toward']);
  await _waitForVideo(tester);
}

Future<void> _advanceUntilAny(
  WidgetTester tester,
  List<String> fragments,
) async {
  for (var attempt = 0; attempt < 300; attempt++) {
    if (_containsAny(tester, fragments)) return;
    await _advanceVisibleDialogue(tester);
  }
  fail('Story did not reach $fragments; painted=${guest.texts(tester)}');
}

Future<void> _routeToTruthEnding(WidgetTester tester) async {
  await _choose(tester, 'investigation_hub', 'archive');
  await _choose(tester, 'archive_read', 'ask_mira_archive');
  await _choose(tester, 'memory_response', 'trust_mira');
  await _choose(tester, 'investigation_hub', 'clock');
  await _choose(tester, 'clock_test', 'single_pulse');
  await _choose(tester, 'investigation_hub', 'roof');
  await _choose(tester, 'roof_inspection', 'read_log');
  await _choose(tester, 'investigation_hub', 'relay');
  await _choose(tester, 'relay_open', 'open_dial');
  await _choose(tester, 'dial_one', 'route_7');
  await _choose(tester, 'dial_two', 'pulse_1');
  await _choose(tester, 'dial_three', 'minute_4');
  await _choose(tester, 'memory_repeat_response', 'affirm_mira');
  await _choose(tester, 'signal_window', 'send_truth');
  await _advanceUntilAny(tester, const [
    '灯亮过，信也抵达了。',
    'A reply crosses twenty years, but the way back closes.',
  ]);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUp(() async {
    _normalAppSupportPath = (await getApplicationSupportDirectory()).path;
    await _isolatedSupport.install();
    await _expectIsolatedSupportPath();
  });
  tearDown(() async => _isolatedSupport.restore());

  testWidgets(
    'Lantern archive film decodes, seeks, saves, rolls back and replays in isolation',
    (tester) async {
      try {
        await _enterArchiveReel(tester);
        var player = _player(tester)!;
        expect(player.value.duration.inMilliseconds, closeTo(3000, 200));
        expect(player.value.isLooping, isFalse);
        await _waitForPlayer(
          tester,
          (value) => value.volume == 0,
          'the VN video boundary must mute the actual decoder',
        );
        await _waitForPlayer(
          tester,
          (value) => value.position.inMilliseconds >= 1200,
          'the bundled film must advance from its decoded start position',
        );

        await _tapAny(tester, const ['暂停视频', 'Pause video'], scroll: false);
        await _waitForPlayer(
          tester,
          (value) => !value.isPlaying,
          'Pause must reach the real VideoPlayerController',
        );
        final pausedAt = player.value.position.inMilliseconds;
        expect(pausedAt, greaterThanOrEqualTo(1000));
        await _waitForEnabledAction(tester, const ['后退 1 秒', 'Back 1s']);
        await _tapAny(tester, const ['后退 1 秒', 'Back 1s'], scroll: false);
        await _waitForPlayer(
          tester,
          (value) => value.position.inMilliseconds < pausedAt - 700,
          'the backward control must seek the native player by one second',
        );
        final afterBack = player.value.position.inMilliseconds;
        await _waitForEnabledAction(tester, const ['前进 1 秒', 'Forward 1s']);
        await _tapAny(tester, const ['前进 1 秒', 'Forward 1s'], scroll: false);
        await _waitForPlayer(
          tester,
          (value) => value.position.inMilliseconds > afterBack + 700,
          'the forward control must seek the native player by one second',
        );

        // Quick save is a real UI action. Read the host-owned disk value to
        // prove that JS captured the actual decoder position and duration.
        final expectedSavePosition = player.value.position.inMilliseconds;
        await _tapAny(tester, const ['手札', 'Journal'], scroll: false);
        await _tapAny(tester, const ['快速保存此刻', 'Quick save now']);
        await _waitForAny(
          tester,
          const ['快速存档已更新', 'Quick save updated'],
          'the game must finish its save action before reading platform storage',
        );
        final saved = await _waitForDiskSlot(tester, 'quick', (value) {
          final video = value['state']?['stage']?['video'];
          return value['state']?['active']?['id'] == 'archive_reel_02' &&
              video?['cue'] == 'archive_route_reel' &&
              video?['positionMs'] is num &&
              ((video['positionMs'] as num) - expectedSavePosition).abs() < 250;
        });
        final savedVideo = Map<String, dynamic>.from(
          saved['state']['stage']['video'] as Map,
        );
        expect(savedVideo['cue'], 'archive_route_reel');
        expect(savedVideo['durationMs'], closeTo(3000, 200));
        expect(
          savedVideo['positionMs'],
          closeTo(player.value.position.inMilliseconds, 250),
        );

        await _tapAny(tester, const [
          '继续阅读',
          'Continue reading',
        ], scroll: false);
        await _tapAny(tester, const ['继续视频', 'Resume video'], scroll: false);
        final savedPosition = savedVideo['positionMs'] as int;
        await _waitForPlayer(
          tester,
          (value) => value.position.inMilliseconds > savedPosition + 450,
          'the decoded player must advance after resume',
        );
        await _tapAny(tester, const ['暂停视频', 'Pause video'], scroll: false);
        await _waitForPlayer(
          tester,
          (value) => !value.isPlaying,
          'the later position must be paused before loading the earlier save',
        );
        await _tapAny(tester, const ['手札', 'Journal'], scroll: false);
        await _tapAny(tester, const ['重读信笺', 'Load a letter']);
        await _waitForEnabledAction(tester, const ['快速存档', 'Quick save']);
        await _tapAny(tester, const ['快速存档', 'Quick save']);
        await _waitForPlayer(
          tester,
          (value) =>
              (value.position.inMilliseconds - savedPosition).abs() < 300,
          'loading the saved overlay must restore its actual native playhead',
        );
        player = _player(tester)!;
        expect(player.value.isPlaying, isFalse);

        // Rollback returns to the instruction before video.play, removing the
        // overlay through the ordinary story history.
        await _tapAny(tester, const ['回溯', 'Rewind'], scroll: false);
        await _waitForAny(tester, const [
          '米拉从柜底抽出',
          'Mira pulls a silent reel',
        ], 'rollback must restore the preceding authored dialogue');
        await _waitForNoPlayer(tester);

        // Advance the same real story instruction again and wait for the
        // actual non-loop decoder completion. Completion must not advance the
        // dialogue or silently take a route choice away from the player.
        await _advanceUntilAny(tester, const [
          '镜头慢慢靠近',
          'camera drifts toward',
        ]);
        await _waitForVideo(tester);
        await _waitForPlayer(
          tester,
          (value) => value.isCompleted,
          'a non-loop reel must report its real ended state',
          timeout: const Duration(seconds: 12),
        );
        await _waitForAny(tester, const [
          '从头播放',
          'Replay',
        ], 'the decoder completion must reach the VN ended-state control');
        expect(
          _containsAny(tester, const ['镜头慢慢靠近', 'camera drifts toward']),
          isTrue,
          reason:
              'native completion must leave story progression to the player',
        );
        await _tapAny(tester, const ['关闭视频', 'Close video'], scroll: false);
        await _waitForNoPlayer(tester);

        await _routeToTruthEnding(tester);
        await _waitForDiskSlot(
          tester,
          'auto',
          (value) => value['state']?['active']?['id'] == 'truth_letter',
        );
        await _tapAny(tester, const ['返回扉页', 'Return to title'], scroll: false);
        await _tapAny(tester, const ['雾港纪念', 'Harbor memories']);
        final mainSave = await _waitForDiskSlot(
          tester,
          'auto',
          (value) => value['state']?['active']?['id'] == 'truth_letter',
        );
        final beforeReplay = jsonEncode(mainSave);
        await _tapAny(tester, const ['七号邮路的旧胶片', 'old Route 7 reel']);
        await _waitForAny(tester, const [
          '米拉从柜底抽出',
          'Mira pulls a silent reel',
        ], 'the unlocked film must run in the isolated replay engine');
        // Advance only the replay's visible line to the video cue. The main
        // autosave remains the actual ending journey throughout this segment.
        await _advanceUntilAny(tester, const [
          '镜头慢慢靠近',
          'camera drifts toward',
        ]);
        await _waitForVideo(tester);
        final afterReplay = await tester.runAsync<Map<String, dynamic>?>(
          () => _readDiskSlot('auto'),
        );
        expect(afterReplay, isNotNull);
        expect(jsonEncode(afterReplay), beforeReplay);
        await _tapAny(tester, const ['关闭视频', 'Close video'], scroll: false);
        await _tapAny(tester, const [
          '返回原旅程',
          'Return to journey',
        ], scroll: false);
        await _waitForAny(tester, const [
          '雾港纪念',
          'Harbor memories',
        ], 'exiting replay must restore the gallery from which it was opened');
        await _tapAny(tester, const ['返回', 'Back'], scroll: false);
        await _waitForAny(
          tester,
          const ['启程 · 开始新的故事', 'Begin · Start a new story'],
          'closing the restored gallery must return to the original title page',
        );
        expect(
          jsonEncode(
            await tester.runAsync<Map<String, dynamic>?>(
              () => _readDiskSlot('auto'),
            ),
          ),
          beforeReplay,
        );
        debugPrint(
          'novel-video: real ${player.dataSourceType.name} decoder completed '
          '${player.value.duration.inMilliseconds}ms; seek, disk restore, rollback, '
          'close and replay isolation passed',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
