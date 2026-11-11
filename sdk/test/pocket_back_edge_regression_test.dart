import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show
        PocketBytecodeRuntime,
        PocketCompositorRuntime,
        PocketEvent,
        PocketFrame,
        PocketImageResource,
        PocketOp,
        PocketRectOp,
        PocketRuntime,
        debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';

final class _ProbeRuntime
    implements PocketRuntime, PocketCompositorRuntime, PocketBytecodeRuntime {
  final List<Map<String, dynamic>> sentMessages = <Map<String, dynamic>>[];

  static const PocketFrame _frame = PocketFrame(
    width: 390,
    height: 844,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 390, height: 844, color: 0xff101827),
    ],
    events: <PocketEvent>[],
    resources: <PocketImageResource>[],
  );

  @override
  void configureCompositor(Map<String, int> applications) {}

  @override
  String? get actualAbi => 'pocket-back-edge-regression-abi';

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) => _frame;

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) => _frame;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    sentMessages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const rootId = 'pocket.back-edge-regression.root';
  late Directory directory;

  setUp(() {
    directory = Directory.systemTemp.createTempSync('pocket-back-edge-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final Object content = requested.endsWith('metadata.json')
          ? <String, Object?>{
              'entryFormat': 'quickjs-bytecode',
              'formatVersion': 1,
              'kind': 'script',
              'bindingGeneration': 1,
              'tickHz': 60,
              'runtimeAbi': 'pocket-back-edge-regression-abi',
              'bytecodeBytes': 1,
              'version': '1.0.0',
              'build': 1,
            }
          : <String, Object?>{
              'capabilities': <String, Object?>{
                'requires': <String>['ui.compositor-surfaces'],
              },
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });
  });

  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (directory.existsSync()) directory.deleteSync(recursive: true);
  });

  testWidgets(
    'loaded host streams accepted gestures and explicitly falls back when declined',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final controller = PocketSystemHostController();
      final runtime = _ProbeRuntime();
      debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
      var closes = 0;
      late BuildContext homeContext;

      try {
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData.light(),
            home: Builder(
              builder: (context) {
                homeContext = context;
                return const Scaffold(body: Center(child: Text('Home')));
              },
            ),
          ),
        );
        unawaited(
          Navigator.of(homeContext).push<void>(
            MaterialPageRoute<void>(
              settings: const RouteSettings(
                name: 'pocket-back-edge-regression',
              ),
              builder: (_) => Scaffold(
                body: PocketSystemHost(
                  systemUI: const PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/back-edge-root.qjbc',
                    pakAsset: 'test/back-edge-root.pak',
                    metadataAsset: 'test/back-edge-root.metadata.json',
                    manifestAsset: 'test/back-edge-root.manifest.json',
                    additionalCapabilities: <String>{'ui.compositor-surfaces'},
                  ),
                  applications: const <String, PocketAppConfig>{},
                  controller: controller,
                  onClose: () => closes++,
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        final root = await _waitForRoot(tester, controller);
        // Let the MaterialPageRoute transition finish before introducing a
        // new touch sequence at the physical left edge.
        await tester.pump(const Duration(milliseconds: 500));

        final longSwipe = await tester.createGesture(pointer: 1);
        await longSwipe.down(const Offset(8, 200), timeStamp: Duration.zero);
        await tester.pump();
        final longStart = _lastBackGesture(runtime, phase: 'start');
        _replyToBackGesture(root, longStart, handled: false);
        await tester.pump();
        await longSwipe.moveTo(
          const Offset(50, 200),
          timeStamp: const Duration(milliseconds: 250),
        );
        await longSwipe.moveTo(
          const Offset(120, 200),
          timeStamp: const Duration(milliseconds: 600),
        );
        await longSwipe.up(timeStamp: const Duration(milliseconds: 700));
        await tester.pump();
        var requests = _backRequests(runtime);
        expect(
          requests,
          hasLength(1),
          reason: 'a slow 112px right swipe must pass the distance threshold',
        );
        expect(closes, 0);
        expect(find.byType(PocketSystemHost), findsOneWidget);
        final longRequestId = (requests.single['payload'] as Map)['requestId'];
        root.session.onEvent(
          PocketEvent(
            id: 'long-edge-back-response',
            method: 'platform.back.response',
            params: <String, Object?>{
              'requestId': longRequestId,
              'handled': true,
            },
          ),
        );
        await tester.pump();

        final cancelled = await tester.createGesture(pointer: 2);
        await cancelled.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 800),
        );
        await tester.pump();
        final cancelStart = _lastBackGesture(runtime, phase: 'start');
        _replyToBackGesture(root, cancelStart, handled: true);
        await tester.pump();
        await cancelled.moveTo(
          const Offset(24, 200),
          timeStamp: const Duration(milliseconds: 840),
        );
        await cancelled.cancel(timeStamp: const Duration(milliseconds: 850));
        await tester.pump();
        expect(
          _backRequests(runtime),
          hasLength(1),
          reason: 'a cancelled contact must not request guest Back',
        );
        expect(closes, 0);
        expect(find.byType(PocketSystemHost), findsOneWidget);
        expect(
          _backGestures(runtime).last['payload']['phase'],
          'cancel',
          reason: 'an accepted guest gesture must receive the native cancel',
        );

        // An accepted guest can track the native pointer. The end is delivered
        // as a gesture event and must not also become a discrete Back request.
        final acceptedStartIndex = _backGestures(runtime).length;
        final accepted = await tester.createGesture(pointer: 3);
        await accepted.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 880),
        );
        await tester.pump();
        final acceptedStart = _lastBackGesture(runtime, phase: 'start');
        _replyToBackGesture(root, acceptedStart, handled: true);
        await tester.pump();
        await accepted.moveTo(
          const Offset(34, 200),
          timeStamp: const Duration(milliseconds: 900),
        );
        await tester.pump();
        await accepted.moveTo(
          const Offset(74, 200),
          timeStamp: const Duration(milliseconds: 920),
        );
        await tester.pump();
        final acceptedUpdates = _backGestures(runtime)
            .skip(acceptedStartIndex)
            .where((message) => message['payload']['phase'] == 'update')
            .toList();
        expect(acceptedUpdates, isNotEmpty);
        final acceptedProgress =
            (acceptedUpdates.last['payload']['progress'] as num).toDouble();
        expect(acceptedProgress, greaterThan(0));
        expect(acceptedProgress, lessThanOrEqualTo(1));
        await accepted.up(timeStamp: const Duration(milliseconds: 930));
        await tester.pump();
        final acceptedPhases = _backGestures(runtime)
            .skip(acceptedStartIndex)
            .map((message) => message['payload']['phase'])
            .toList();
        expect(acceptedPhases.first, 'start');
        expect(acceptedPhases.last, 'end');
        expect(_backRequests(runtime), hasLength(1));
        expect(closes, 0);

        // If the pointer is released before start is acknowledged, hold the
        // final event until the guest accepts; do not fall back early.
        final pendingEndStartIndex = _backGestures(runtime).length;
        final pendingEnd = await tester.createGesture(pointer: 4);
        await pendingEnd.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 950),
        );
        await tester.pump();
        await pendingEnd.moveTo(
          const Offset(36, 200),
          timeStamp: const Duration(milliseconds: 970),
        );
        await pendingEnd.up(timeStamp: const Duration(milliseconds: 980));
        await tester.pump();
        expect(_backRequests(runtime), hasLength(1));
        expect(
          _backGestures(runtime)
              .skip(pendingEndStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start'],
        );
        final pendingEndStart = _lastBackGesture(runtime, phase: 'start');
        _replyToBackGesture(root, pendingEndStart, handled: true);
        await tester.pump();
        expect(
          _backGestures(runtime)
              .skip(pendingEndStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start', 'end'],
        );
        expect(_backRequests(runtime), hasLength(1));

        // The same pending handshake must preserve a cancel without creating
        // a discrete Back request, even if the response arrives afterwards.
        final pendingCancelStartIndex = _backGestures(runtime).length;
        final pendingCancel = await tester.createGesture(pointer: 5);
        await pendingCancel.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 1000),
        );
        await tester.pump();
        await pendingCancel.moveTo(
          const Offset(28, 200),
          timeStamp: const Duration(milliseconds: 1020),
        );
        await pendingCancel.cancel(
          timeStamp: const Duration(milliseconds: 1030),
        );
        await tester.pump();
        expect(_backRequests(runtime), hasLength(1));
        expect(
          _backGestures(runtime)
              .skip(pendingCancelStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start'],
        );
        final pendingCancelStart = _lastBackGesture(runtime, phase: 'start');
        _replyToBackGesture(root, pendingCancelStart, handled: true);
        await tester.pump();
        expect(
          _backGestures(runtime)
              .skip(pendingCancelStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start', 'cancel'],
        );
        expect(_backRequests(runtime), hasLength(1));
        expect(closes, 0);

        // 50 logical pixels is below the distance threshold. The explicit
        // timestamps make this a fast swipe, exercising velocity recognition.
        // Leave start pending until release to prove fallback waits for an
        // explicit handled:false response rather than timing out.
        final swipe = await tester.createGesture(pointer: 6);
        await swipe.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 1100),
        );
        await tester.pump();
        final velocityStart = _lastBackGesture(runtime, phase: 'start');
        await swipe.moveTo(
          const Offset(24, 200),
          timeStamp: const Duration(milliseconds: 1110),
        );
        await swipe.moveTo(
          const Offset(42, 200),
          timeStamp: const Duration(milliseconds: 1120),
        );
        await swipe.moveTo(
          const Offset(58, 200),
          timeStamp: const Duration(milliseconds: 1130),
        );
        await swipe.up(timeStamp: const Duration(milliseconds: 1131));
        await tester.pump();
        expect(
          _backRequests(runtime),
          hasLength(1),
          reason: 'Back fallback must wait for the pending gesture response',
        );
        _replyToBackGesture(root, velocityStart, handled: false);
        await tester.pump();

        requests = _backRequests(runtime);
        expect(
          requests,
          hasLength(2),
          reason: 'a fast short right swipe from the left edge must reach JS',
        );
        expect(closes, 0, reason: 'handled Back must keep the host route open');
        expect(find.byType(PocketSystemHost), findsOneWidget);

        final requestId = (requests.last['payload'] as Map)['requestId'];
        root.session.onEvent(
          PocketEvent(
            id: 'edge-back-response',
            method: 'platform.back.response',
            params: <String, Object?>{'requestId': requestId, 'handled': true},
          ),
        );
        await tester.pump();
        expect(closes, 0);
        expect(find.byType(PocketSystemHost), findsOneWidget);

        // A pending false response cannot pop the route after the app leaves
        // the foreground. Lifecycle interruption also retires the guest
        // gesture so a later timeout or response cannot create a phantom Back.
        final lifecycleStartIndex = _backGestures(runtime).length;
        final interrupted = await tester.createGesture(pointer: 7);
        await interrupted.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 1200),
        );
        await tester.pump();
        final lifecycleStart = _lastBackGesture(runtime, phase: 'start');
        await interrupted.moveTo(
          const Offset(120, 200),
          timeStamp: const Duration(milliseconds: 1400),
        );
        await interrupted.up(timeStamp: const Duration(milliseconds: 1450));
        await tester.pump();
        expect(_backRequests(runtime), hasLength(2));
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        await tester.pump();
        _replyToBackGesture(root, lifecycleStart, handled: false);
        await tester.pump();
        expect(_backRequests(runtime), hasLength(2));
        expect(closes, 0);
        expect(
          _backGestures(runtime)
              .skip(lifecycleStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start'],
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();

        final acceptedLifecycleStartIndex = _backGestures(runtime).length;
        final lifecycleAccepted = await tester.createGesture(pointer: 8);
        await lifecycleAccepted.down(
          const Offset(8, 200),
          timeStamp: const Duration(milliseconds: 1500),
        );
        await tester.pump();
        final acceptedLifecycleStart = _lastBackGesture(
          runtime,
          phase: 'start',
        );
        _replyToBackGesture(root, acceptedLifecycleStart, handled: true);
        await tester.pump();
        await lifecycleAccepted.moveTo(
          const Offset(48, 200),
          timeStamp: const Duration(milliseconds: 1540),
        );
        await tester.pump();
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        await tester.pump();
        expect(
          _backGestures(runtime)
              .skip(acceptedLifecycleStartIndex)
              .map((message) => message['payload']['phase'])
              .toList(),
          <Object?>['start', 'update', 'cancel'],
        );
        expect(_backRequests(runtime), hasLength(2));
        expect(closes, 0);
        await lifecycleAccepted.cancel(
          timeStamp: const Duration(milliseconds: 1550),
        );
        await tester.pump();
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        controller.dispose();
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        debugDefaultTargetPlatformOverride = null;
      }
    },
  );
}

List<Map<String, dynamic>> _backRequests(_ProbeRuntime runtime) => runtime
    .sentMessages
    .where((message) => message['name'] == 'platform.back.request')
    .toList();

List<Map<String, dynamic>> _backGestures(_ProbeRuntime runtime) => runtime
    .sentMessages
    .where((message) => message['name'] == 'platform.back.gesture')
    .toList();

Map<String, dynamic> _lastBackGesture(
  _ProbeRuntime runtime, {
  required String phase,
}) {
  for (final message in _backGestures(runtime).reversed) {
    final payload = (message['payload'] as Map).cast<String, dynamic>();
    if (payload['phase'] == phase) return payload;
  }
  fail('No platform.back.gesture $phase message was sent');
}

void _replyToBackGesture(
  PocketSystemInstanceSnapshot root,
  Map<String, dynamic> gesture, {
  required bool handled,
}) {
  root.session.onEvent(
    PocketEvent(
      id: 'gesture-response-${gesture['gestureId']}',
      method: 'platform.back.gesture.response',
      params: <String, Object?>{
        'gestureId': gesture['gestureId'],
        'handled': handled,
      },
    ),
  );
}

Future<PocketSystemInstanceSnapshot> _waitForRoot(
  WidgetTester tester,
  PocketSystemHostController controller,
) async {
  for (var attempt = 0; attempt < 60; attempt++) {
    for (final instance in controller.instances) {
      if (instance.isSystemUI && instance.firstFrameReady) return instance;
    }
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 1)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail('Timed out waiting for the Pocket SystemUI first frame');
}
