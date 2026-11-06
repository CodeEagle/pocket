import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

/// Real SystemUI promotion coverage.
///
/// The fixture is produced by `system_update_fixture.ts`, so this test is
/// intentionally skipped unless a built native library and the generated
/// signed package are supplied. A host stub would not exercise the
/// PocketSystemHost generation key, package admission, or Flutter input lane.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixtureRoot = Platform.environment['POCKET_SYSTEM_UPDATE_FIXTURE_DIR'];
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skip = fixtureRoot == null || nativeLibrary == null;
  final savedHttpOverrides = HttpOverrides.current;
  HttpOverrides.global = null;

  late Directory supportDirectory;
  late HttpServer server;
  late Map<String, Uint8List> embeddedAssets;
  final requestCounts = <String, int>{};
  var openResponses = 0;

  setUp(() async {
    if (fixtureRoot == null) return;
    supportDirectory = await Directory.systemTemp.createTemp('pocket-system-update-ffi-');
    final root = Directory('$fixtureRoot/v1/assets');
    embeddedAssets = <String, Uint8List>{
      'system/app.qjbc': Uint8List.fromList(await File('${root.path}/app.qjbc').readAsBytes()),
      'system/app.pak': Uint8List.fromList(await File('${root.path}/app.pak').readAsBytes()),
      'system/app.bytecode.json': Uint8List.fromList(await File('${root.path}/app.bytecode.json').readAsBytes()),
      'system/guest-manifest.json': Uint8List.fromList(await File('${root.path}/guest-manifest.json').readAsBytes()),
    };
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (message) async {
      if (message == null) return null;
      final requested = utf8.decode(message.buffer.asUint8List());
      final relative = requested.startsWith('assets/') ? requested.substring('assets/'.length) : requested;
      final bytes = embeddedAssets[relative];
      if (bytes == null) {
        throw StateError('Unexpected SystemUI fixture asset: $requested');
      }
      return ByteData.sublistView(bytes);
    });

    requestCounts.clear();
    openResponses = 0;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final path = request.uri.path;
      requestCounts[path] = (requestCounts[path] ?? 0) + 1;
      openResponses++;
      try {
        if (path.startsWith('/..') || path.contains('/../')) {
          request.response.statusCode = HttpStatus.badRequest;
          await request.response.close();
          return;
        }
        final relative = path == '/latest.json'
            ? 'latest.json'
            : path.startsWith('/')
            ? path.substring(1)
            : path;
        final file = File('$fixtureRoot/v2/$relative');
        if (!file.existsSync()) {
          request.response.statusCode = HttpStatus.notFound;
          await request.response.close();
          return;
        }
        final bytes = file.readAsBytesSync();
        request.response.contentLength = bytes.length;
        request.response.add(bytes);
        await request.response.close();
      } finally {
        openResponses--;
      }
    });
  });

  tearDown(() async {
    if (fixtureRoot != null) {
      await server.close(force: true);
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        null,
      );
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', null);
      rootBundle.clear();
      if (supportDirectory.existsSync()) {
        await supportDirectory.delete(recursive: true);
      }
    }
  });

  tearDownAll(() {
    HttpOverrides.global = savedHttpOverrides;
  });

  testWidgets('signed SystemUI promotion remounts once, keeps pointer input live, and same-package refresh is a no-op', (
    tester,
  ) async {
    final fixture = Map<String, dynamic>.from(jsonDecode(File('$fixtureRoot/fixture.json').readAsStringSync()) as Map);
    final appId = fixture['appId'] as String;
    final keyId = fixture['keyId'] as String;
    final publicKey = fixture['publicKeyBase64'] as String;
    final controller = PocketSystemHostController();
    final recordings = <PocketRecordingController>[];

    final config = PocketAppConfig(
      appId: appId,
      bytecodeAsset: 'system/app.qjbc',
      pakAsset: 'system/app.pak',
      metadataAsset: 'system/app.bytecode.json',
      manifestAsset: 'system/guest-manifest.json',
      updates: PocketUpdateConfig(
        url: 'http://127.0.0.1:${server.port}/latest.json',
        keyId: keyId,
        publicKey: publicKey,
      ),
      recordingFactory: () {
        final recording = PocketRecordingController();
        recordings.add(recording);
        return recording;
      },
    );

    Future<void> pumpUntil(bool Function() predicate, {Duration timeout = const Duration(seconds: 20)}) async {
      final steps = (timeout.inMilliseconds / 16).ceil();
      for (var index = 0; index < steps; index++) {
        if (predicate()) return;
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump(const Duration(milliseconds: 16));
      }
      fail(
        'Timed out waiting for SystemUI state: '
        'instances=${controller.instances.map((item) => '${item.appId}:${item.ready}:${item.firstFrameReady}:${item.generation}:${item.session.stage}:${item.session.active?.build}:${item.session.lastError}').toList()}, '
        'requests=$requestCounts recordings=${recordings.map((item) => '${item.isStarted}:${item.entryCount}:${item.isIncomplete}').toList()}',
      );
    }

    List<String> frameDigests(PocketRecordingController recording) {
      if (!recording.isStarted) return const <String>[];
      final entries = recording.snapshot().entries;
      return <String>[
        for (final entry in entries)
          if ((entry.kind == 'frame' || entry.kind == 'frameDelta') && entry.result['frame'] is Map)
            if ((entry.result['frame'] as Map)['opsSha'] is String) (entry.result['frame'] as Map)['opsSha'] as String,
      ];
    }

    Future<void> sendTap(PocketSession session) async {
      expect(
        session.controller.send(
          method: 'input.pointer',
          params: <String, dynamic>{'phase': 'down', 'id': 0, 'x': 24.0, 'y': 24.0},
        ),
        isTrue,
      );
      expect(
        session.controller.send(
          method: 'input.pointer',
          params: <String, dynamic>{'phase': 'up', 'id': 0, 'x': 24.0, 'y': 24.0},
        ),
        isTrue,
      );
      await tester.pump(const Duration(milliseconds: 64));
    }

    try {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: PocketSystemHost(
            systemUI: config,
            applications: const <String, PocketAppConfig>{},
            controller: controller,
          ),
        ),
      );

      await pumpUntil(
        () =>
            controller.instances.length == 1 &&
            controller.instances.single.isSystemUI &&
            controller.instances.single.firstFrameReady,
      );
      final first = controller.instances.single;
      final firstGeneration = first.generation;
      await pumpUntil(() => recordings.isNotEmpty && frameDigests(recordings.first).isNotEmpty);
      final firstBeforeInput = frameDigests(recordings.first).last;
      await sendTap(first.session);
      await pumpUntil(() {
        final frames = frameDigests(recordings.first);
        return frames.length >= 2 && frames.last != firstBeforeInput;
      });
      final firstAfterOneTap = frameDigests(recordings.first).last;
      await sendTap(first.session);
      await pumpUntil(() {
        final frames = frameDigests(recordings.first);
        return frames.length >= 3 && frames.last != firstAfterOneTap;
      });
      final firstAfterTwoTaps = frameDigests(recordings.first).last;
      expect(controller.instances.single.generation, firstGeneration);
      expect(recordings.length, 1);

      // The handoff source is intentionally changed before the lifecycle
      // resume event. The update state helper must capture this live value,
      // rather than a stale construction-time snapshot.
      expect(
        first.session.controller.send(method: 'platform.lifecycle', params: <String, dynamic>{'state': 'onResume'}),
        isTrue,
      );

      await pumpUntil(
        () =>
            controller.instances.length == 1 &&
            controller.instances.single.session.active?.build == 2 &&
            controller.instances.single.generation > firstGeneration &&
            controller.instances.single.firstFrameReady,
      );
      final promoted = controller.instances.single;
      expect(promoted.session.active?.version, '2.0.0');
      expect(recordings.length, greaterThanOrEqualTo(2));
      await pumpUntil(() {
        final newFrames = frameDigests(recordings.last);
        return newFrames.contains(firstAfterTwoTaps);
      });

      final promotedGeneration = promoted.generation;
      final promotedRecording = recordings.last;
      final promotedBeforeInput = frameDigests(promotedRecording).last;
      expect(promotedBeforeInput, firstAfterTwoTaps, reason: 'v2 must restore the v1 count-two recording state');
      await sendTap(promoted.session);
      await pumpUntil(() {
        final frames = frameDigests(promotedRecording);
        return frames.length >= 2 && frames.last != promotedBeforeInput;
      });

      // The v2 guest becomes healthy and emits updates.changed. Its
      // automatic client checks the same signed package again; apply must
      // return scheduled:false without creating another PocketView key.
      await pumpUntil(() => promoted.session.stage == 'ready');
      for (var index = 0; index < 100; index++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump(const Duration(milliseconds: 16));
      }
      // Let the loopback response and the same-package apply no-op finish
      // in the real async zone before Flutter's fake-timer invariant runs.
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 250)));
      await pumpUntil(
        () => (requestCounts['/latest.json'] ?? 0) >= 2 && openResponses == 0,
        timeout: const Duration(seconds: 5),
      );
      final afterNoop = controller.instances.single;
      expect(afterNoop.generation, promotedGeneration);
      expect(afterNoop.session.active?.build, 2);
      expect(recordings.length, 2);
      expect(requestCounts['/latest.json'], greaterThanOrEqualTo(2));
      expect(
        requestCounts.keys.any((path) => path.startsWith('/blobs/')),
        isTrue,
        reason: 'v2 must be admitted from signed content-addressed blobs',
      );
    } finally {
      final sessions = controller.instances.map((instance) => instance.session).toList(growable: false);
      await tester.runAsync(() async {
        for (final session in sessions) {
          await session.close();
        }
      });
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      // HttpPocketUpdateTransport's bounded guards are fake timers under
      // testWidgets. Advance the clock after disposal so a cancelled
      // loopback request cannot trip Flutter's pending-timer invariant.
      await tester.pump(const Duration(seconds: 21));
      controller.dispose();
    }
  }, skip: skip);
}
