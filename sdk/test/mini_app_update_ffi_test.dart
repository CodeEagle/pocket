import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart' show PocketSignedManifest;

/// Real mini-app entry admission coverage.
///
/// The fixture contains a SystemUI root and a child mini-app. The child is
/// embedded at build 1 while signed build 1/build 2 packages are served by a
/// loopback HTTP server. This test intentionally skips without both the
/// generated fixture and a native library: a host stub cannot prove the
/// PocketSystemHost generation, first-visible-frame, or input boundaries.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixtureRoot =
      Platform.environment['POCKET_MINI_APP_UPDATE_FIXTURE_DIR'];
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skip = fixtureRoot == null || nativeLibrary == null;
  final savedHttpOverrides = HttpOverrides.current;
  HttpOverrides.global = null;

  late Directory supportDirectory;
  late HttpServer server;
  late _MiniUpdateServer updateServer;
  late Map<String, Uint8List> embeddedAssets;
  late Map<String, dynamic> fixture;
  final rootRecordings = <PocketRecordingController>[];
  final childRecordings = <PocketRecordingController>[];
  final signals = <Map<String, dynamic>>[];

  setUp(() async {
    if (fixtureRoot == null) return;
    fixture = Map<String, dynamic>.from(
      jsonDecode(await File('$fixtureRoot/fixture.json').readAsString()) as Map,
    );
    supportDirectory = await Directory.systemTemp.createTemp(
      'pocket-mini-app-update-ffi-',
    );
    final root = Directory('$fixtureRoot/root/assets');
    final child = Directory('$fixtureRoot/child-v1/assets');
    embeddedAssets = <String, Uint8List>{};
    for (final name in const <String>[
      'app.qjbc',
      'app.pak',
      'app.bytecode.json',
      'guest-manifest.json',
    ]) {
      embeddedAssets['root/$name'] = Uint8List.fromList(
        await File('${root.path}/$name').readAsBytes(),
      );
      embeddedAssets['child/$name'] = Uint8List.fromList(
        await File('${child.path}/$name').readAsBytes(),
      );
    }
    rootRecordings.clear();
    childRecordings.clear();
    signals.clear();
    updateServer = _MiniUpdateServer(fixtureRoot);
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen(updateServer.handle);

    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      if (message == null) return null;
      final requested = utf8.decode(message.buffer.asUint8List());
      final relative = requested.startsWith('assets/')
          ? requested.substring('assets/'.length)
          : requested;
      final bytes = embeddedAssets[relative] ?? embeddedAssets[requested];
      if (bytes == null) {
        throw StateError('Unexpected mini-app fixture asset: $requested');
      }
      return ByteData.sublistView(bytes);
    });
  });

  tearDown(() async {
    if (fixtureRoot == null) return;
    updateServer.releaseLatest();
    await server.close(force: true);
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (supportDirectory.existsSync()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  tearDownAll(() {
    HttpOverrides.global = savedHttpOverrides;
  });

  testWidgets(
    'prewarm gate holds root, promotes signed v2, and keeps child input live',
    (tester) async {
      // Download signed v1 during prewarm. Entry must recheck and reuse its blobs.
      updateServer.releaseBuild = 1;
      updateServer.holdLatest = false;
      final controller = PocketSystemHostController();
      final configs = _makeConfigs(
        fixture: fixture,
        server: server,
        rootRecordings: rootRecordings,
        childRecordings: childRecordings,
        signals: signals,
        downloadOnOpen: true,
      );
      try {
        await _pumpHost(tester, controller, configs);
        await _waitUntil(
          tester,
          () {
            final root = _findInstanceOrNull(controller, configs.rootId);
            final child = _findInstanceOrNull(controller, configs.childId);
            return root != null &&
                child != null &&
                root.firstFrameReady &&
                child.firstFrameReady &&
                childRecordings.isNotEmpty &&
                signals.any((event) => event['event'] == 'prewarmed');
          },
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final root = _findInstance(controller, configs.rootId);
        final childBefore = _findInstance(controller, configs.childId);
        expect(childBefore.isPresented, isFalse);
        expect(childBefore.session.active?.build, 1);
        final pathsBeforeOpen = updateServer.filePaths.length;
        final oldGeneration = childBefore.generation;
        final oldFrame = _frameDigests(childRecordings.first).first;
        final oldInstanceId = childBefore.instanceId;
        updateServer.releaseBuild = 2;
        updateServer.holdLatest = true;

        await _sendPointer(tester, root.session, x: 72);
        await _waitUntil(tester, () => updateServer.latestHeld);
        await tester.pump(const Duration(milliseconds: 50));

        // prepareOpen is before freeze/push/present: the root remains the
        // foreground caller and the resident child keeps its old generation.
        final heldRoot = _findInstance(controller, configs.rootId);
        final heldChild = _findInstance(controller, configs.childId);
        expect(heldRoot.foreground, isTrue);
        expect(heldRoot.isPresented, isTrue);
        expect(heldChild.instanceId, oldInstanceId);
        expect(heldChild.generation, oldGeneration);
        expect(heldChild.isPresented, isFalse);
        expect(childRecordings.length, 1);

        updateServer.releaseLatest();
        await _waitUntil(
          tester,
          () {
            final promoted = _findInstance(controller, configs.childId);
            return promoted.session.active?.build == 2 &&
                promoted.generation > oldGeneration &&
                promoted.firstFrameReady &&
                promoted.isPresented;
          },
          timeout: const Duration(seconds: 30),
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final promoted = _findInstance(controller, configs.childId);
        expect(promoted.instanceId, oldInstanceId);
        expect(promoted.session.active?.version, '2.0.0');
        await _waitUntil(
          tester,
          () => signals.any(
            (event) =>
                event['event'] == 'lifecycle' &&
                event['version'] == '2.0.0' &&
                event['state'] == 'onDidAppear',
          ),
        );
        final newLifecycle = signals
            .where(
              (event) =>
                  event['event'] == 'lifecycle' && event['version'] == '2.0.0',
            )
            .map((event) => event['state'])
            .toList();
        expect(newLifecycle, <String>[
          'onInit',
          'onLoad',
          'frozenInStack',
          'onWillAppear',
          'onDidAppear',
        ]);
        final reusedHashes = _sharedReleaseBlobs(fixtureRoot!);
        expect(reusedHashes, isNotEmpty);
        final updatePaths = updateServer.filePaths
            .skip(pathsBeforeOpen)
            .toList();
        expect(updatePaths.any((path) => path.startsWith('blobs/')), isTrue);
        expect(updatePaths.where((path) => path.contains('bundle.')), isEmpty);
        expect(
          updatePaths.where((path) => reusedHashes.contains(path)),
          isEmpty,
        );
        expect(childRecordings.length, greaterThanOrEqualTo(2));

        final promotedRecording = childRecordings.last;
        await _waitUntil(
          tester,
          () => _frameDigests(promotedRecording).isNotEmpty,
        );
        final beforeInput = _frameDigests(promotedRecording).last;
        expect(beforeInput, isNot(oldFrame));
        await _sendPointer(tester, promoted.session, x: 24);
        await _waitUntil(tester, () {
          final frames = _frameDigests(promotedRecording);
          return frames.length >= 2 &&
              frames.last != beforeInput &&
              signals.any(
                (event) =>
                    event['event'] == 'tap' &&
                    event['version'] == '2.0.0' &&
                    event['count'] == 1,
              );
        });
      } finally {
        await _closeHost(tester, controller);
      }
    },
    skip: skip,
  );

  testWidgets('same signed build during warm open does not remount the child', (
    tester,
  ) async {
    updateServer.releaseBuild = 1;
    final controller = PocketSystemHostController();
    final configs = _makeConfigs(
      fixture: fixture,
      server: server,
      rootRecordings: rootRecordings,
      childRecordings: childRecordings,
      signals: signals,
      downloadOnOpen: true,
    );
    try {
      await _pumpHost(tester, controller, configs);
      await _waitUntil(
        tester,
        () {
          final child = _findInstanceOrNull(controller, configs.childId);
          return child != null &&
              child.firstFrameReady &&
              childRecordings.isNotEmpty &&
              signals.any((event) => event['event'] == 'prewarmed');
        },
        diagnostic: () =>
            _hostDiagnostics(controller, updateServer, childRecordings),
      );
      final root = _findInstance(controller, configs.rootId);
      final childBefore = _findInstance(controller, configs.childId);
      final oldGeneration = childBefore.generation;
      final oldInstanceId = childBefore.instanceId;
      final oldRecordingCount = childRecordings.length;
      final checksBeforeOpen = updateServer.latestRequests;
      final pathsBeforeOpen = updateServer.filePaths.length;
      expect(childBefore.isPresented, isFalse);

      await _sendPointer(tester, root.session, x: 72);
      await _waitUntil(
        tester,
        () =>
            _findInstanceOrNull(controller, configs.childId)?.isPresented ==
            true,
        diagnostic: () =>
            _hostDiagnostics(controller, updateServer, childRecordings),
      );
      final childAfter = _findInstance(controller, configs.childId);
      expect(childAfter.instanceId, oldInstanceId);
      expect(childAfter.generation, oldGeneration);
      expect(childAfter.session.active?.build, 1);
      expect(childRecordings.length, oldRecordingCount);
      expect(updateServer.latestRequests, checksBeforeOpen + 1);
      expect(
        updateServer.filePaths.skip(pathsBeforeOpen).where((path) => path != 'latest.json'),
        isEmpty,
      );
    } finally {
      await _closeHost(tester, controller);
    }
  }, skip: skip);

  testWidgets(
    'failed warm admission leaves the caller visible and retries the same child',
    (tester) async {
      // Initial prewarm must establish the resident v1 before the failure is
      // injected at the warm-open boundary.
      updateServer.releaseBuild = 1;
      updateServer.failLatest = false;
      final controller = PocketSystemHostController();
      final configs = _makeConfigs(
        fixture: fixture,
        server: server,
        rootRecordings: rootRecordings,
        childRecordings: childRecordings,
        signals: signals,
      );
      try {
        await _pumpHost(tester, controller, configs);
        await _waitUntil(
          tester,
          () {
            final child = _findInstanceOrNull(controller, configs.childId);
            return child != null &&
                child.firstFrameReady &&
                signals.any((event) => event['event'] == 'prewarmed');
          },
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        updateServer.releaseBuild = 2;
        updateServer.failLatest = true;
        final root = _findInstance(controller, configs.rootId);
        final childBefore = _findInstance(controller, configs.childId);
        final oldGeneration = childBefore.generation;
        final oldInstanceId = childBefore.instanceId;

        await _sendPointer(tester, root.session, x: 72);
        await _waitUntil(
          tester,
          () => signals.any((event) => event['event'] == 'open-error'),
        );
        await tester.pump(const Duration(milliseconds: 100));
        final failedRoot = _findInstance(controller, configs.rootId);
        final failedChild = _findInstance(controller, configs.childId);
        expect(failedRoot.foreground, isTrue);
        expect(failedRoot.isPresented, isTrue);
        expect(failedChild.isPresented, isFalse);
        expect(failedChild.instanceId, oldInstanceId);
        expect(failedChild.generation, oldGeneration);

        updateServer.failLatest = false;
        await _sendPointer(tester, failedRoot.session, x: 72);
        await _waitUntil(tester, () {
          final retried = _findInstance(controller, configs.childId);
          return retried.session.active?.build == 2 &&
              retried.generation > oldGeneration &&
              retried.isPresented;
        }, timeout: const Duration(seconds: 30));
        expect(
          _findInstance(controller, configs.childId).instanceId,
          oldInstanceId,
        );
      } finally {
        await _closeHost(tester, controller);
      }
    },
    skip: skip,
  );
}

final class _MiniUpdateConfigs {
  const _MiniUpdateConfigs({
    required this.rootId,
    required this.childId,
    required this.systemUI,
    required this.child,
  });

  final String rootId;
  final String childId;
  final PocketAppConfig systemUI;
  final PocketAppConfig child;
}

_MiniUpdateConfigs _makeConfigs({
  required Map<String, dynamic> fixture,
  required HttpServer server,
  required List<PocketRecordingController> rootRecordings,
  required List<PocketRecordingController> childRecordings,
  required List<Map<String, dynamic>> signals,
  bool downloadOnOpen = false,
}) {
  final rootId = fixture['rootAppId'] as String;
  final childId = fixture['childAppId'] as String;
  final keyId = fixture['keyId'] as String;
  final publicKey = fixture['publicKeyBase64'] as String;
  final updates = PocketUpdateConfig(
    url: 'http://127.0.0.1:${server.port}/latest.json',
    keyId: keyId,
    publicKey: publicKey,
  );
  return _MiniUpdateConfigs(
    rootId: rootId,
    childId: childId,
    systemUI: PocketAppConfig(
      appId: rootId,
      pluginFactories: [(_) => _FixtureSignals(signals)],
      bytecodeAsset: 'root/app.qjbc',
      pakAsset: 'root/app.pak',
      metadataAsset: 'root/app.bytecode.json',
      manifestAsset: 'root/guest-manifest.json',
      compositorSurfaces: <String, int>{childId: 2},
      recordingFactory: () {
        final recording = PocketRecordingController();
        rootRecordings.add(recording);
        return recording;
      },
    ),
    child: PocketAppConfig(
      appId: childId,
      pluginFactories: [(_) => _FixtureSignals(signals)],
      bytecodeAsset: 'child/app.qjbc',
      pakAsset: 'child/app.pak',
      metadataAsset: 'child/app.bytecode.json',
      manifestAsset: 'child/guest-manifest.json',
      updates: updates,
      downloadOnOpen: downloadOnOpen,
      recordingFactory: () {
        final recording = PocketRecordingController();
        childRecordings.add(recording);
        return recording;
      },
    ),
  );
}

Future<void> _pumpHost(
  WidgetTester tester,
  PocketSystemHostController controller,
  _MiniUpdateConfigs configs,
) async {
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.ltr,
      child: PocketSystemHost(
        systemUI: configs.systemUI,
        applications: <String, PocketAppConfig>{configs.childId: configs.child},
        controller: controller,
      ),
    ),
  );
}

PocketSystemInstanceSnapshot _findInstance(
  PocketSystemHostController controller,
  String appId,
) {
  return controller.instances.firstWhere((item) => item.appId == appId);
}

PocketSystemInstanceSnapshot? _findInstanceOrNull(
  PocketSystemHostController controller,
  String appId,
) {
  for (final item in controller.instances) {
    if (item.appId == appId) return item;
  }
  return null;
}

Future<void> _sendPointer(
  WidgetTester tester,
  PocketSession session, {
  required double x,
}) async {
  expect(
    session.controller.send(
      method: 'input.pointer',
      params: <String, dynamic>{'phase': 'down', 'id': 0, 'x': x, 'y': 24.0},
    ),
    isTrue,
  );
  expect(
    session.controller.send(
      method: 'input.pointer',
      params: <String, dynamic>{'phase': 'up', 'id': 0, 'x': x, 'y': 24.0},
    ),
    isTrue,
  );
  await tester.pump(const Duration(milliseconds: 64));
}

Future<void> _waitUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 20),
  String Function()? diagnostic,
}) async {
  final elapsed = Stopwatch()..start();
  while (elapsed.elapsed < timeout) {
    if (condition()) return;
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  final detail = diagnostic == null ? '' : ': ${diagnostic()}';
  fail('Timed out waiting for mini-app update state$detail');
}

String _hostDiagnostics(
  PocketSystemHostController controller,
  _MiniUpdateServer server,
  List<PocketRecordingController> recordings,
) {
  return 'instances=${controller.instances.map((item) => '${item.appId}:ready=${item.ready}:first=${item.firstFrameReady}:gen=${item.generation}:active=${item.session.active?.build}:stage=${item.session.stage}:failure=${item.session.failure}').toList()}, childRecordings=${recordings.map((item) => 'started=${item.isStarted}:entries=${item.entryCount}:incomplete=${item.isIncomplete}:kinds=${item.snapshot().entries.map((entry) => entry.kind).toList()}').toList()}, requests=${server.latestRequests}, files=${server.fileRequests}, paths=${server.filePaths}, missing=${server.missingPaths}, responses=${server.openResponses}';
}

List<String> _frameDigests(PocketRecordingController recording) {
  if (!recording.isStarted) return const <String>[];
  return <String>[
    for (final entry in recording.snapshot().entries)
      if (entry.result['frame'] is Map &&
          (entry.result['frame'] as Map)['opsSha'] is String)
        (entry.result['frame'] as Map)['opsSha'] as String,
  ];
}

Future<void> _closeHost(
  WidgetTester tester,
  PocketSystemHostController controller,
) async {
  final sessions = controller.instances
      .map((instance) => instance.session)
      .toList(growable: false);
  // Unmount first so child compositor views cannot keep a close continuation
  // waiting on a frame that the test is no longer producing. Start all native
  // closes together, then alternate real-I/O turns with Flutter pumps; a
  // single runAsync(Future.wait(...)) can deadlock against FakeAsync.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  var completed = false;
  Object? failure;
  StackTrace? failureStack;
  final closeAll = Future.wait<void>(sessions.map((session) => session.close()))
      .then<void>(
        (_) => completed = true,
        onError: (Object error, StackTrace stack) {
          failure = error;
          failureStack = stack;
          completed = true;
        },
      );
  final deadline = DateTime.now().add(const Duration(seconds: 8));
  while (!completed && DateTime.now().isBefore(deadline)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  if (!completed) {
    throw StateError('Timed out closing mini-app host sessions');
  }
  await closeAll;
  if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
  controller.dispose();
}

final class _MiniUpdateServer {
  _MiniUpdateServer(this.fixtureRoot);

  final String fixtureRoot;
  int releaseBuild = 2;
  bool holdLatest = false;
  bool failLatest = false;
  int latestRequests = 0;
  int fileRequests = 0;
  final List<String> filePaths = <String>[];
  int openResponses = 0;
  final List<String> missingPaths = <String>[];
  Completer<void>? _release;

  bool get latestHeld => _release != null && !_release!.isCompleted;

  void releaseLatest() {
    final release = _release;
    if (release != null && !release.isCompleted) release.complete();
  }

  Future<void> handle(HttpRequest request) async {
    openResponses++;
    final path = request.uri.path;
    try {
      if (path.startsWith('/..') || path.contains('/../')) {
        request.response.statusCode = HttpStatus.badRequest;
        await request.response.close();
        return;
      }
      if (path == '/latest.json') {
        latestRequests++;
        if (holdLatest) {
          final release = Completer<void>();
          _release = release;
          await release.future;
        }
        if (failLatest) {
          request.response.statusCode = HttpStatus.serviceUnavailable;
          await request.response.close();
          return;
        }
      }
      final relative = path == '/latest.json'
          ? 'latest.json'
          : path.startsWith('/')
          ? path.substring(1)
          : path;
      final file = File('$fixtureRoot/child-v$releaseBuild/$relative');
      filePaths.add(relative);
      if (!file.existsSync()) {
        missingPaths.add(relative);
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      fileRequests++;
      final bytes = await file.readAsBytes();
      request.response.contentLength = bytes.length;
      request.response.add(bytes);
      await request.response.close();
    } finally {
      openResponses--;
    }
  }
}

/// Test-only observation through the official native capability boundary.
final class _FixtureSignals extends PocketPlugin {
  _FixtureSignals(this.signals);
  final List<Map<String, dynamic>> signals;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.mini-update.signals',
    version: '1.0.0',
    capabilities: {
      'fixture.signal': PocketPluginCapability(
        name: 'fixture.signal',
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('fixture.signal', (params) async {
      signals.add({...params, 'appId': context.appId});
      return const <String, Object?>{'received': true};
    });
  }
}

Set<String> _sharedReleaseBlobs(String root) {
  Set<String> blobs(int build) {
    final signed = PocketSignedManifest.fromBytes(
      File('$root/child-v$build/latest.json').readAsBytesSync(),
    );
    return {for (final file in signed.payload.files) 'blobs/${file.sha256}'};
  }

  return blobs(1).intersection(blobs(2));
}
