import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';

final class _FakeVideoPlayerPlatform extends VideoPlayerPlatform {
  int _nextPlayerId = 1;
  final Map<int, StreamController<VideoEvent>> _events =
      <int, StreamController<VideoEvent>>{};
  final Set<int> _initializedEvents = <int>{};
  final List<String> calls = <String>[];
  final List<Completer<int?>> pendingCreates = <Completer<int?>>[];
  final List<int> pendingCreateIds = <int>[];
  final List<Completer<void>> pendingPlays = <Completer<void>>[];
  final List<Completer<void>> pendingPauses = <Completer<void>>[];
  bool failCreate = false;
  bool holdCreate = false;
  bool holdPlay = false;
  bool holdPause = false;

  int count(String call) => calls.where((value) => value == call).length;

  void emit(int playerId, VideoEvent event) {
    _events[playerId]?.add(event);
  }

  void completeNextPlay() {
    pendingPlays.removeAt(0).complete();
  }

  void completeNextCreate() {
    final id = pendingCreateIds.removeAt(0);
    pendingCreates.removeAt(0).complete(id);
  }

  void completeNextPause() {
    pendingPauses.removeAt(0).complete();
  }

  @override
  Future<void> init() async {
    calls.add('init');
  }

  @override
  Future<int?> create(DataSource dataSource) async {
    if (failCreate) throw StateError('fake video create failed');
    final id = _nextPlayerId++;
    _events[id] = StreamController<VideoEvent>();
    calls.add('create:$id:${dataSource.asset ?? dataSource.uri}');
    if (holdCreate) {
      final pending = Completer<int?>();
      pendingCreateIds.add(id);
      pendingCreates.add(pending);
      return pending.future;
    }
    return id;
  }

  @override
  Stream<VideoEvent> videoEventsFor(int playerId) {
    final events = _events[playerId]!;
    if (_initializedEvents.add(playerId)) {
      scheduleMicrotask(() {
        if (!events.isClosed) {
          events.add(
            VideoEvent(
              eventType: VideoEventType.initialized,
              duration: const Duration(seconds: 10),
              size: const Size(320, 180),
              rotationCorrection: 0,
            ),
          );
        }
      });
    }
    return events.stream;
  }

  @override
  Future<void> setLooping(int playerId, bool looping) async {
    calls.add('loop:$playerId:$looping');
  }

  @override
  Future<void> setVolume(int playerId, double volume) async {
    calls.add('volume:$playerId:$volume');
  }

  @override
  Future<void> setPlaybackSpeed(int playerId, double speed) async {
    calls.add('speed:$playerId:$speed');
  }

  @override
  Future<void> play(int playerId) {
    calls.add('play:$playerId');
    final completer = Completer<void>();
    if (holdPlay) {
      pendingPlays.add(completer);
    } else {
      completer.complete();
    }
    return completer.future;
  }

  @override
  Future<void> pause(int playerId) {
    calls.add('pause:$playerId');
    final completer = Completer<void>();
    if (holdPause) {
      pendingPauses.add(completer);
    } else {
      completer.complete();
    }
    return completer.future;
  }

  @override
  Future<Duration> getPosition(int playerId) async => Duration.zero;

  @override
  Future<void> dispose(int playerId) {
    calls.add('dispose:$playerId');
    final events = _events.remove(playerId);
    return events?.close() ?? Future<void>.value();
  }

  @override
  Widget buildView(int playerId) => const SizedBox.shrink();
}

final class _VideoRuntime implements PocketRuntime, PocketRuntimeScheduling {
  _VideoRuntime(this.frameValue, {this.nextWakeDelayMilliseconds = 0});

  PocketFrame frameValue;
  final double nextWakeDelayMilliseconds;

  @override
  PocketFrame eval(String source) => frameValue;

  @override
  PocketFrame load(String source, Uint8List pak) => frameValue;

  @override
  PocketFrame frame(int deltaMilliseconds) => frameValue;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    messages.add(Map<String, dynamic>.from(message));
  }

  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

PocketFrame _frameWithVideo({
  String id = 'hero',
  String asset = 'video-a.mp4',
  bool autoplay = true,
  PocketClip? clip,
  List<PocketEvent> events = const <PocketEvent>[],
}) {
  return PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      const PocketRectOp(
        x: 0,
        y: 0,
        width: 320,
        height: 480,
        color: 0xff101827,
      ),
      PocketVideoOp(
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        id: id,
        asset: asset,
        autoplay: autoplay,
        clip: clip,
      ),
    ],
    events: events,
  );
}

PocketFrame _frameWithoutVideo() {
  return const PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );
}

Future<PocketViewController> _mountVideoView(
  WidgetTester tester,
  _VideoRuntime runtime, {
  ValueChanged<Object>? onError,
}) async {
  final controller = PocketViewController();
  await tester.pumpWidget(
    MaterialApp(
      home: SizedBox(
        width: 320,
        height: 480,
        child: PocketView(
          controller: controller,
          runtime: runtime,
          jsSource: '',
          pakBytes: Uint8List(0),
          showDebugFps: false,
          onError: onError,
        ),
      ),
    ),
  );
  await tester.pump();
  return controller;
}

Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  String reason = 'condition was not reached',
}) async {
  for (var index = 0; index < 80; index++) {
    if (condition()) return;
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail(reason);
}

Future<void> _yieldPlatformCleanup(WidgetTester tester) async {
  // StreamSubscription.cancel() in video_player can complete on the real
  // event loop even inside a widget test. Yield that loop, then flush the
  // widget zone; advancing fake frame time alone does not prove disposal.
  // This also reproduces with a standalone controller, without PocketView.
  await tester.runAsync(() async {
    await Future<void>.delayed(Duration.zero);
  });
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late VideoPlayerPlatform previousPlatform;

  setUp(() {
    previousPlatform = VideoPlayerPlatform.instance;
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
  });

  tearDown(() {
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
    VideoPlayerPlatform.instance = previousPlatform;
  });

  testWidgets('offscreen video pauses once and resumes without frame churn', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.calls.any((call) => call.startsWith('play:')),
      reason: 'initial autoplay did not reach the platform',
    );
    expect(platform.count('play:1'), 1);
    final initialPauses = platform.count('pause:1');
    await tester.pump(const Duration(milliseconds: 16));

    await tester.pump(const Duration(milliseconds: 32));
    expect(platform.count('play:1'), 1);

    runtime.frameValue = _frameWithVideo(
      clip: const PocketClip(x: 400, y: 400, width: 20, height: 20),
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'offscreen video did not pause',
    );
    await tester.pump(const Duration(milliseconds: 32));
    expect(platform.count('pause:1'), initialPauses + 1);

    runtime.frameValue = _frameWithVideo();
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 2,
      reason: 'visible video did not resume',
    );
    await tester.pump(const Duration(milliseconds: 32));
    expect(platform.count('play:1'), 2);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('disappearing DrawOp disposes its player', (tester) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.calls.any((call) => call.startsWith('create:')),
      reason: 'video controller was not created',
    );
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'video controller did not finish initialization',
    );
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithoutVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'removed DrawOp did not dispose its player',
    );
    expect(platform.count('dispose:1'), 1);
    expect(
      runtime.messages.any(
        (message) =>
            message['name'] == 'video.state' &&
            (message['payload'] as Map)['state'] == 'disposed',
      ),
      isTrue,
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('temporary DrawOp eviction preserves an explicit pause intent', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );
    final initialPauses = platform.count('pause:1');

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'pause-before-eviction',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'explicit pause did not reach the first asset',
    );

    runtime.frameValue = _frameWithoutVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'temporary DrawOp eviction did not dispose the decoder',
    );

    runtime.frameValue = _frameWithVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:2:video-a.mp4'),
      reason: 'same video did not recreate after DrawOp reappearance',
    );
    await tester.pump(const Duration(milliseconds: 32));
    expect(
      platform.count('play:2'),
      0,
      reason: 'temporary DrawOp eviction must retain the explicit pause',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('temporary DrawOp eviction resumes a retained playing intent', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );

    runtime.frameValue = _frameWithoutVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'temporary DrawOp eviction did not dispose the decoder',
    );

    runtime.frameValue = _frameWithVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _pumpUntil(
      tester,
      () => platform.count('play:2') == 1,
      reason: 'playing intent did not resume after DrawOp reappearance',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('video.release clears intent until a new play/pause command', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-1',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    // Stop replaying the same event batch before the next demand wake. The
    // real runtime emits this command batch once; the fake runtime returns its
    // current frame until the harness replaces it.
    runtime.frameValue = _frameWithVideo(autoplay: false);
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'video.release did not dispose the decoder',
    );
    runtime.frameValue = _frameWithoutVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    runtime.frameValue = _frameWithVideo();
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 64));
    expect(
      platform.calls.where((call) => call.startsWith('create:2:')),
      isEmpty,
      reason: 'released id must not autoplay when only its DrawOp reappears',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'reregister-1',
          method: 'video.play',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    runtime.frameValue = _frameWithVideo(autoplay: false);
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await _pumpUntil(
      tester,
      () => platform.count('play:2') == 1,
      reason: 'new play command did not re-admit the released id',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same-turn release then reregister applies the new command', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'video did not finish initialization',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-then-play',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
        PocketEvent(
          id: 'reregister-play',
          method: 'video.play',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    // Stop replaying the same event batch before the next demand wake. The
    // real runtime emits this command batch once; the fake runtime returns its
    // current frame until the harness replaces it.
    runtime.frameValue = _frameWithVideo(autoplay: false);
    controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'same-turn release did not retire the old decoder',
    );

    await _pumpUntil(
      tester,
      () => platform.count('play:2') == 1,
      reason: 'same-turn re-register play was lost after release',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'a new command recreates a released id in the same visual frame',
    (tester) async {
      final platform = _FakeVideoPlayerPlatform();
      VideoPlayerPlatform.instance = platform;
      final runtime = _VideoRuntime(
        _frameWithVideo(autoplay: false),
        nextWakeDelayMilliseconds: -1,
      );
      final controller = await _mountVideoView(tester, runtime);
      await _pumpUntil(
        tester,
        () => platform.count('pause:1') == 1,
        reason: 'video did not finish initialization',
      );

      runtime.frameValue = _frameWithVideo(
        autoplay: false,
        events: const <PocketEvent>[
          PocketEvent(
            id: 'release-before-rebuild',
            method: 'video.release',
            params: <String, dynamic>{'id': 'hero'},
          ),
        ],
      );
      controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
      await tester.pump(const Duration(milliseconds: 16));
      runtime.frameValue = _frameWithVideo(autoplay: false);
      controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
      await tester.pump(const Duration(milliseconds: 16));
      await _yieldPlatformCleanup(tester);
      await _pumpUntil(
        tester,
        () => platform.count('dispose:1') == 1,
        reason: 'release did not retire the old decoder',
      );

      // The re-registration command is the only wake after the release. The
      // fake runtime remains idle, so a second visual frame cannot accidentally
      // make this pass.
      runtime.frameValue = _frameWithVideo(
        autoplay: false,
        events: const <PocketEvent>[
          PocketEvent(
            id: 'pause-after-rebuild',
            method: 'video.pause',
            params: <String, dynamic>{'id': 'hero'},
          ),
        ],
      );
      controller.sendRaw(<String, dynamic>{'type': 'test.wake'});
      await tester.pump(const Duration(milliseconds: 16));
      await _pumpUntil(
        tester,
        () => platform.calls.contains('create:2:video-a.mp4'),
        reason:
            'new registration command did not recreate the released decoder',
      );
      expect(platform.count('play:2'), 0);

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('video inspect reports real controller state without polling', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['state'] == 'ready';
      }),
      reason: 'video ready diagnostic was not emitted',
    );
    final stateCount = runtime.messages
        .where((message) => message['name'] == 'video.state')
        .length;

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(id: 'inspect-1', method: 'video.inspect', params: {}),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => runtime.messages.any(
        (message) => message['name'] == 'video.snapshot',
      ),
      reason: 'video.inspect did not receive a snapshot',
    );
    final snapshot = runtime.messages.lastWhere(
      (message) => message['name'] == 'video.snapshot',
    );
    final payload = snapshot['payload'] as Map;
    expect(payload['controllers'], 1);
    expect(payload['loading'], 0);
    expect((payload['items'] as List).single['id'], 'hero');
    expect(
      runtime.messages
          .where((message) => message['name'] == 'video.state')
          .length,
      stateCount,
      reason: 'inspection must not create a polling state stream',
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('position or buffering updates do not emit duplicate state', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['state'] == 'ready';
      }),
      reason: 'video ready diagnostic was not emitted',
    );
    final stateCount = runtime.messages
        .where((message) => message['name'] == 'video.state')
        .length;
    for (var index = 0; index < 5; index++) {
      platform.emit(
        1,
        VideoEvent(
          eventType: VideoEventType.bufferingUpdate,
          buffered: <DurationRange>[
            DurationRange(
              Duration(milliseconds: index * 100),
              Duration(milliseconds: (index + 1) * 100),
            ),
          ],
        ),
      );
      await tester.pump();
    }
    expect(
      runtime.messages
          .where((message) => message['name'] == 'video.state')
          .length,
      stateCount,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('video decoder failure is local video.state error', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform()..failCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    var hostErrors = 0;
    await _mountVideoView(tester, runtime, onError: (_) => hostErrors++);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['state'] == 'error';
      }),
      reason: 'video decoder failure did not emit a local error state',
    );
    final errorMessage = runtime.messages.lastWhere(
      (message) =>
          message['name'] == 'video.state' &&
          (message['payload'] as Map)['state'] == 'error',
    );
    expect((errorMessage['payload'] as Map)['error'], isNotEmpty);
    expect(hostErrors, 0);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('late play converges to a hidden pause', (tester) async {
    final platform = _FakeVideoPlayerPlatform()..holdPlay = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.pendingPlays.length == 1,
      reason: 'play command was not held by the fake platform',
    );
    final initialPauses = platform.count('pause:1');
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(
      clip: const PocketClip(x: 400, y: 400, width: 20, height: 20),
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    platform.completeNextPlay();
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'late play did not converge to a compensating pause',
    );
    expect(
      platform.calls.lastIndexOf('play:1'),
      lessThan(platform.calls.lastIndexOf('pause:1')),
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('late play converges to an explicit video.pause event', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform()..holdPlay = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.pendingPlays.length == 1,
      reason: 'play command was not held by the fake platform',
    );
    final initialPauses = platform.count('pause:1');
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'pause-1',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    platform.completeNextPlay();
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'explicit pause did not supersede the late play',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same batch play then pause does not lose the pause', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );
    final initialPauses = platform.count('pause:1');
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'play-1',
          method: 'video.play',
          params: <String, dynamic>{'id': 'hero'},
        ),
        PocketEvent(
          id: 'pause-1',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'same-batch play/pause lost the final pause',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same batch pause then play does not lose the play', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo(autoplay: false));
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'video did not finish initialization',
    );
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'pause-1',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
        PocketEvent(
          id: 'play-1',
          method: 'video.play',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'same-batch pause/play lost the final play',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('inactive pauses and resumed activity restarts playback', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );
    final initialPauses = platform.count('pause:1');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'inactive lifecycle did not pause playback',
    );
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 2,
      reason: 'resumed lifecycle did not restart playback',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('asset replacement preserves an explicit pause intent', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('play:1') == 1,
      reason: 'initial autoplay did not reach the platform',
    );
    final initialPauses = platform.count('pause:1');
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'pause-1',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == initialPauses + 1,
      reason: 'explicit pause did not reach the first asset',
    );
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(asset: 'video-b.mp4');
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () =>
          platform.calls.contains('dispose:1') &&
          platform.calls.contains('create:2:video-b.mp4'),
      reason: 'asset replacement did not retire the paused player',
    );
    await tester.pump(const Duration(milliseconds: 32));
    expect(platform.count('play:2'), 0);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('asset replacement disposes the old player before creating new', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:video-a.mp4'),
      reason: 'initial asset was not created',
    );
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'initial asset did not finish initialization',
    );
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(asset: 'video-b.mp4', autoplay: false);
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () =>
          platform.calls.contains('dispose:1') &&
          platform.calls.contains('create:2:video-b.mp4'),
      reason: 'asset replacement did not retire the old player',
    );
    expect(platform.count('dispose:1'), 1);
    expect(platform.count('create:2:video-b.mp4'), 1);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('offscreen initial pause is admitted before its first DrawOp', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final empty = _frameWithoutVideo();
    final runtime = _VideoRuntime(
      PocketFrame(
        width: empty.width,
        height: empty.height,
        ops: empty.ops,
        events: const <PocketEvent>[
          PocketEvent(
            id: 'initial-pause',
            method: 'video.pause',
            params: <String, dynamic>{'id': 'hero'},
          ),
        ],
      ),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);

    runtime.frameValue = _frameWithVideo();
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:video-a.mp4'),
      reason: 'the first visible DrawOp did not create its player',
    );
    await tester.pump(const Duration(milliseconds: 32));
    expect(
      platform.count('play:1'),
      0,
      reason: 'an offscreen initial pause must not fall back to autoplay',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same-batch play then pause emits no intermediate play', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'the initial player did not finish initialization',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'play-then-pause',
          method: 'video.play',
          params: <String, dynamic>{'id': 'hero'},
        ),
        PocketEvent(
          id: 'pause-final',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    runtime.frameValue = _frameWithVideo(autoplay: false);
    await tester.pump(const Duration(milliseconds: 64));
    expect(
      platform.count('play:1'),
      0,
      reason: 'the final pause must be applied before platform sync',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('permanent release clears a failed source for retry', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform()..failCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['state'] == 'error';
      }),
      reason: 'the failed source did not reach the video error state',
    );

    final empty = _frameWithoutVideo();
    runtime.frameValue = PocketFrame(
      width: empty.width,
      height: empty.height,
      ops: empty.ops,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-failed',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    platform.failCreate = false;
    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'retry-failed',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.any((call) => call.startsWith('create:')),
      reason: 'a released failed source was not retried',
    );
    expect(
      platform.calls.where((call) => call.startsWith('create:')),
      isNotEmpty,
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('permanently released ids return admission capacity', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithoutVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);

    for (var index = 0; index < 129; index++) {
      final id = 'capacity-$index';
      runtime.frameValue = PocketFrame(
        width: 320,
        height: 480,
        ops: <PocketOp>[
          PocketVideoOp(
            x: 0,
            y: 0,
            width: 320,
            height: 180,
            id: id,
            asset: 'video-a.mp4',
            autoplay: false,
          ),
        ],
        events: <PocketEvent>[
          PocketEvent(
            id: 'pause-$index',
            method: 'video.pause',
            params: <String, dynamic>{'id': id},
          ),
        ],
      );
      controller.notifyWork();
      await _pumpUntil(
        tester,
        () =>
            platform.calls.where((call) => call.startsWith('create:')).length >=
            index + 1,
        reason: 'video $index did not reach the platform',
      );
      final empty = _frameWithoutVideo();
      runtime.frameValue = PocketFrame(
        width: empty.width,
        height: empty.height,
        ops: empty.ops,
        events: <PocketEvent>[
          PocketEvent(
            id: 'release-$index',
            method: 'video.release',
            params: <String, dynamic>{'id': id},
          ),
        ],
      );
      controller.notifyWork();
      await tester.pump();
    }
    expect(
      platform.calls.where((call) => call.startsWith('create:')).length,
      129,
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same-frame final release does not create a replacement', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.count('pause:1') == 1,
      reason: 'the initial player did not finish initialization',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: true,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-final',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    runtime.frameValue = _frameWithoutVideo();
    await _yieldPlatformCleanup(tester);
    await tester.pump(const Duration(milliseconds: 64));
    expect(platform.count('create:2:video-a.mp4'), 0);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('same-frame release of a first registration does not create', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(
        autoplay: true,
        events: const <PocketEvent>[
          PocketEvent(
            id: 'release-first',
            method: 'video.release',
            params: <String, dynamic>{'id': 'hero'},
          ),
        ],
      ),
      nextWakeDelayMilliseconds: -1,
    );
    await _mountVideoView(tester, runtime);
    await tester.pump(const Duration(milliseconds: 64));
    expect(platform.calls.where((call) => call.startsWith('create:')), isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('retired DrawOp tombstone stays pinned under release pressure', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:video-a.mp4'),
      reason: 'the retained video did not create',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-retained',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    // Keep the old hero DrawOp in the current frame while filling and
    // trimming the bounded retired-id history with unrelated registrations.
    for (var index = 0; index < 128; index++) {
      final id = 'retired-$index';
      runtime.frameValue = _frameWithVideo(
        autoplay: false,
        events: <PocketEvent>[
          PocketEvent(
            id: 'pause-$index',
            method: 'video.pause',
            params: <String, dynamic>{'id': id},
          ),
          PocketEvent(
            id: 'release-$index',
            method: 'video.release',
            params: <String, dynamic>{'id': id},
          ),
        ],
      );
      controller.notifyWork();
      await tester.pump();
    }

    runtime.frameValue = _frameWithVideo(autoplay: false);
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 64));
    expect(
      platform.count('create:2:video-a.mp4'),
      0,
      reason: 'a retained released DrawOp must stay tombstoned',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('stale initialize cannot install after epoch history eviction', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform()..holdCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.pendingCreates.length == 1,
      reason: 'the first initialize did not become pending',
    );

    final empty = _frameWithoutVideo();
    runtime.frameValue = PocketFrame(
      width: empty.width,
      height: empty.height,
      ops: empty.ops,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-pending',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump();

    // Retire enough unrelated ids to evict the hero tombstone and its idle
    // epoch entry while the original platform create remains in flight.
    for (var index = 0; index < 128; index++) {
      final id = 'pending-retired-$index';
      runtime.frameValue = PocketFrame(
        width: empty.width,
        height: empty.height,
        ops: empty.ops,
        events: <PocketEvent>[
          PocketEvent(
            id: 'pause-$index',
            method: 'video.pause',
            params: <String, dynamic>{'id': id},
          ),
          PocketEvent(
            id: 'release-$index',
            method: 'video.release',
            params: <String, dynamic>{'id': id},
          ),
        ],
      );
      controller.notifyWork();
      await tester.pump();
    }

    platform.completeNextCreate();
    await _yieldPlatformCleanup(tester);
    await _pumpUntil(
      tester,
      () => platform.count('dispose:1') == 1,
      reason: 'the stale initialize installed after its epoch was evicted',
    );
    expect(
      runtime.messages.where((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['id'] == 'hero' &&
            const {'ready', 'playing'}.contains(payload['state']);
      }),
      isEmpty,
      reason: 'a stale load must never install even briefly before disposal',
    );

    runtime.frameValue = _frameWithVideo(
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'reregister-pending',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.pendingCreates.length == 1,
      reason: 'the re-registered video did not start a fresh initialize',
    );
    platform.completeNextCreate();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('loop:2:false'),
      reason: 'the fresh initialize did not finish',
    );

    await tester.pumpWidget(const SizedBox.shrink());
    await _yieldPlatformCleanup(tester);
  });

  testWidgets('source swap clears a failed source cache', (tester) async {
    final platform = _FakeVideoPlayerPlatform()..failCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['state'] == 'error';
      }),
      reason: 'the initial failed source did not settle',
    );

    platform.failCreate = false;
    runtime.frameValue = _frameWithVideo(asset: 'video-b.mp4', autoplay: false);
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:video-b.mp4'),
      reason: 'the source swap did not create the replacement',
    );

    runtime.frameValue = _frameWithVideo(asset: 'video-a.mp4', autoplay: false);
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:2:video-a.mp4'),
      reason: 'switching back did not retry the failed source',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('NUL-bearing ids keep failed resources independent', (
    tester,
  ) async {
    const firstId = 'a';
    const firstAsset = 'b\u0000c';
    const secondId = 'a\u0000b';
    const secondAsset = 'c';
    final platform = _FakeVideoPlayerPlatform()..failCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(id: firstId, asset: firstAsset, autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['id'] == firstId &&
            payload['state'] == 'error';
      }),
      reason: 'the first NUL-bearing resource did not fail locally',
    );

    platform.failCreate = false;
    runtime.frameValue = _frameWithVideo(
      id: secondId,
      asset: secondAsset,
      autoplay: false,
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:$secondAsset'),
      reason: 'a distinct NUL-bearing id/resource was blocked by a collision',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('NUL-bearing release cleanup does not clear a sibling failure', (
    tester,
  ) async {
    const firstId = 'a';
    const firstAsset = 'b\u0000c';
    const secondId = 'a\u0000b';
    const secondAsset = 'c';
    final platform = _FakeVideoPlayerPlatform()..failCreate = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithVideo(id: firstId, asset: firstAsset, autoplay: false),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['id'] == firstId &&
            payload['state'] == 'error';
      }),
      reason: 'the first sibling failure did not settle',
    );

    runtime.frameValue = _frameWithVideo(
      id: secondId,
      asset: secondAsset,
      autoplay: false,
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => runtime.messages.any((message) {
        final payload = message['payload'];
        return message['name'] == 'video.state' &&
            payload is Map &&
            payload['id'] == secondId &&
            payload['state'] == 'error';
      }),
      reason: 'the second sibling failure did not settle',
    );

    final empty = _frameWithoutVideo();
    runtime.frameValue = PocketFrame(
      width: empty.width,
      height: empty.height,
      ops: empty.ops,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-first-nul',
          method: 'video.release',
          params: <String, dynamic>{'id': firstId},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump();

    platform.failCreate = false;
    runtime.frameValue = _frameWithVideo(
      id: secondId,
      asset: secondAsset,
      autoplay: false,
      events: const <PocketEvent>[
        PocketEvent(
          id: 'retry-second-nul',
          method: 'video.pause',
          params: <String, dynamic>{'id': secondId},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 64));
    expect(
      platform.calls.where((call) => call.startsWith('create:')),
      isEmpty,
      reason: 'releasing one NUL-bearing id cleared its sibling failure',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('full admission rejects an unknown DrawOp until release', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform();
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(
      _frameWithoutVideo(),
      nextWakeDelayMilliseconds: -1,
    );
    final controller = await _mountVideoView(tester, runtime);
    final registrations = <PocketEvent>[];
    for (var index = 0; index < 128; index++) {
      registrations.add(
        PocketEvent(
          id: 'register-$index',
          method: 'video.pause',
          params: <String, dynamic>{'id': 'registered-$index'},
        ),
      );
    }
    runtime.frameValue = PocketFrame(
      width: 320,
      height: 480,
      ops: const <PocketOp>[],
      events: registrations,
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    runtime.frameValue = _frameWithVideo(asset: 'video-b.mp4', autoplay: true);
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 64));
    expect(
      platform.calls.where((call) => call.startsWith('create:')),
      isEmpty,
      reason: 'an unknown DrawOp must fail closed at full capacity',
    );

    runtime.frameValue = PocketFrame(
      width: 320,
      height: 480,
      ops: <PocketOp>[
        const PocketVideoOp(
          x: 0,
          y: 0,
          width: 320,
          height: 180,
          id: 'overflow',
          asset: 'video-b.mp4',
          autoplay: false,
        ),
      ],
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-one',
          method: 'video.release',
          params: <String, dynamic>{'id': 'registered-0'},
        ),
      ],
    );
    controller.notifyWork();
    await _pumpUntil(
      tester,
      () => platform.calls.contains('create:1:video-b.mp4'),
      reason: 'released capacity was not reusable for a new DrawOp',
    );

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a release invalidates an in-flight playback pump', (
    tester,
  ) async {
    final platform = _FakeVideoPlayerPlatform()..holdPlay = true;
    VideoPlayerPlatform.instance = platform;
    final runtime = _VideoRuntime(_frameWithVideo());
    final controller = await _mountVideoView(tester, runtime);
    await _pumpUntil(
      tester,
      () => platform.pendingPlays.length == 1,
      reason: 'the play operation was not held by the fake platform',
    );

    runtime.frameValue = _frameWithVideo(
      events: const <PocketEvent>[
        PocketEvent(
          id: 'release-in-flight',
          method: 'video.release',
          params: <String, dynamic>{'id': 'hero'},
        ),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));
    runtime.frameValue = _frameWithoutVideo();
    platform.completeNextPlay();
    await _yieldPlatformCleanup(tester);
    await tester.pump(const Duration(milliseconds: 200));
    expect(platform.count('create:2:video-a.mp4'), 0);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
