import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:crypto/crypto.dart';
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
      final rootId = fixture['rootAppId'] as String;
      final childId = fixture['childAppId'] as String;
      final hostRelative =
          relative == 'app.qjbc' ||
              relative == 'app.pak' ||
              relative == 'app.bytecode.json' ||
              relative == 'guest-manifest.json'
          ? 'root/$relative'
          : relative.startsWith('apps/$childId/')
          ? 'child/${relative.substring('apps/$childId/'.length)}'
          : relative.startsWith('apps/$rootId/')
          ? 'root/${relative.substring('apps/$rootId/'.length)}'
          : relative;
      final bytes = embeddedAssets[hostRelative] ?? embeddedAssets[relative];
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
    'a resident child checks a newly published same-version build before its next open',
    (tester) async {
      // Download signed v1 during prewarm. Entry must recheck and reuse its blobs.
      updateServer.releaseBuild = 1;
      updateServer.holdLatest = false;
      updateServer.configureHostConfig(server.port);
      final hostConfig = (await tester.runAsync(
        () => PocketHostConfig.load(
          Uri.parse(
            'http://127.0.0.1:${server.port}/test/pocket/0.1.0/${Uri.encodeComponent(fixture['rootAppId'] as String)}/latest.json',
          ),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          trustAnchorDirectory: supportDirectory,
        ),
      ))!;
      final controller = PocketSystemHostController();
      final configs = _makeConfigs(
        fixture: fixture,
        server: server,
        hostConfig: hostConfig,
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
        expect(root.session.active?.build, 1);
        expect(childBefore.isPresented, isFalse);
        expect(childBefore.session.active?.build, 1);
        await _waitUntil(
          tester,
          () =>
              updateServer.latestRequests > 0 &&
              updateServer.openResponses == 0 &&
              childBefore.session.active?.build == 1,
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final pathsBeforeOpen = updateServer.filePaths.length;
        final oldGeneration = childBefore.generation;
        final oldFrame = _frameDigests(childRecordings.first).first;
        final oldInstanceId = childBefore.instanceId;
        updateServer.releaseBuild = 2;
        updateServer.holdLatest = true;
        final checksBeforeOpen = updateServer.latestRequests;

        // The earlier signed check completed before build 2 was published.
        // Re-entering the resident child must do a fresh check and keep it
        // hidden until the signed build-only update is admitted and mounted.
        await _sendPointer(tester, root.session, x: 72);
        await _waitUntil(
          tester,
          () =>
              updateServer.latestHeld &&
              updateServer.latestRequests > checksBeforeOpen &&
              _findInstanceOrNull(controller, configs.childId)?.isPresented ==
                  false,
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final openedRoot = _findInstance(controller, configs.rootId);
        final openedChild = _findInstance(controller, configs.childId);
        expect(openedChild.instanceId, oldInstanceId);
        expect(openedChild.generation, oldGeneration);
        expect(openedChild.session.active?.build, 1);
        expect(openedChild.isPresented, isFalse);
        expect(openedRoot.isPresented, isTrue);
        expect(_frameDigests(rootRecordings.first), isNotEmpty);
        expect(childRecordings.length, 1);

        updateServer.releaseLatest();
        updateServer.holdLatest = false;
        await _waitUntil(
          tester,
          () =>
              _findInstanceOrNull(controller, configs.childId)?.generation !=
                  oldGeneration &&
              _findInstanceOrNull(controller, configs.childId)?.isPresented ==
                  true &&
              _findInstanceOrNull(
                    controller,
                    configs.childId,
                  )?.session.active?.build ==
                  2,
          timeout: const Duration(seconds: 30),
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final updatedChild = _findInstance(controller, configs.childId);
        expect(updatedChild.instanceId, oldInstanceId);
        expect(updatedChild.generation, isNot(oldGeneration));
        expect(updatedChild.session.active?.version, '1.0.0');
        expect(updatedChild.session.active?.build, 2);
        expect(updatedChild.isPresented, isTrue);

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
        final v2Recording = childRecordings.last;
        await _waitUntil(tester, () => _frameDigests(v2Recording).isNotEmpty);
        final beforeV2Input = _frameDigests(v2Recording).first;
        expect(beforeV2Input, isNot(oldFrame));
        await _sendPointer(tester, updatedChild.session, x: 24);
        await _waitUntil(tester, () {
          final frames = _frameDigests(v2Recording);
          return frames.length >= 2 && frames.last != beforeV2Input;
        });
      } finally {
        await _closeHost(tester, controller);
      }
    },
    skip: skip,
  );

  testWidgets('package management stages an update without activating it', (
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
        () => signals.any((event) => event['event'] == 'prewarmed'),
      );
      final root = _findInstance(controller, configs.rootId);
      PocketSystemInstanceSnapshot child() =>
          _findInstance(controller, configs.childId);
      await _sendPointer(tester, root.session, x: 72);
      await _waitUntil(
        tester,
        () => child().isPresented && child().session.stage == 'ready',
      );
      await _sendPointer(tester, child().session, x: 200);
      await _waitUntil(
        tester,
        () =>
            !child().isPresented &&
            signals.any((event) => event['event'] == 'open-settled'),
      );
      await _waitUntil(
        tester,
        () => _findInstanceOrNull(controller, configs.childId) == null,
      );
      updateServer.releaseBuild = 2;
      final blobsBeforeCheck = updateServer.filePaths
          .where((path) => path.startsWith('blobs/'))
          .length;
      await _sendPointer(tester, root.session, x: 52);
      await _waitUntil(
        tester,
        () => signals.any((event) => event['event'] == 'update-status'),
      );
      final status = signals.lastWhere(
        (event) => event['event'] == 'update-status',
      );
      expect(status['installedBuild'], 1, reason: '$status');
      expect(status['activeBuild'], 1);
      expect(status['latestBuild'], 2, reason: '$status');
      expect(status['updateAvailable'], isTrue);
      expect(
        updateServer.filePaths
            .where((path) => path.startsWith('blobs/'))
            .length,
        blobsBeforeCheck,
      );

      await _sendPointer(tester, root.session, x: 36);
      await _waitUntil(
        tester,
        () => signals.any((event) => event['event'] == 'update-prepared'),
      );
      final prepared = signals.lastWhere(
        (event) => event['event'] == 'update-prepared',
      );
      expect(prepared['stagedBuild'], 2);
      expect(_findInstanceOrNull(controller, configs.childId), isNull);
      signals.removeWhere((event) => event['event'] == 'update-status');
      await _sendPointer(tester, root.session, x: 52);
      await _waitUntil(
        tester,
        () => signals.any((event) => event['event'] == 'update-status'),
      );
      final stagedStatus = signals.lastWhere(
        (event) => event['event'] == 'update-status',
      );
      expect(stagedStatus['installedBuild'], 1);
      expect(stagedStatus['activeBuild'], 1);
      expect(stagedStatus['stagedBuild'], 2);

      await _sendPointer(tester, root.session, x: 72);
      await _waitUntil(
        tester,
        () =>
            _findInstanceOrNull(
                  controller,
                  configs.childId,
                )?.session.active?.build ==
                2 &&
            _findInstanceOrNull(controller, configs.childId)?.isPresented ==
                true,
      );
      expect(child().session.active?.build, 2);
    } finally {
      await _closeHost(tester, controller);
    }
  }, skip: skip);

  testWidgets('same signed build in background does not remount the child', (
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
        () => updateServer.latestRequests > checksBeforeOpen,
      );
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
        updateServer.filePaths
            .skip(pathsBeforeOpen)
            .where((path) => path != 'latest.json'),
        isEmpty,
      );
    } finally {
      await _closeHost(tester, controller);
    }
  }, skip: skip);

  testWidgets(
    'root update selects matching catalog before the new compositor generation',
    (tester) async {
      updateServer.releaseBuild = 1;
      updateServer.rootReleaseBuild = 1;
      updateServer.configureHostConfig(server.port);
      final hostConfig = (await tester.runAsync(
        () => PocketHostConfig.load(
          Uri.parse(
            'http://127.0.0.1:${server.port}/test/pocket/0.1.0/${Uri.encodeComponent(fixture['rootAppId'] as String)}/latest.json',
          ),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          trustAnchorDirectory: supportDirectory,
        ),
      ))!;
      final controller = PocketSystemHostController();
      final configs = _makeConfigs(
        fixture: fixture,
        server: server,
        hostConfig: hostConfig,
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
            return root != null &&
                root.firstFrameReady &&
                root.session.active?.build == 1 &&
                signals.any((event) => event['event'] == 'prewarmed');
          },
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final root = _findInstance(controller, configs.rootId);
        final childBefore = _findInstance(controller, configs.childId);
        final oldRootGeneration = root.generation;
        final oldChildInstanceId = childBefore.instanceId;
        updateServer.rootReleaseBuild = 2;

        // Keep pumping Flutter while the root bridge tears down and remounts;
        // awaiting the whole operation inside runAsync would starve the
        // first-frame continuation that completes the mount.
        final prepare = root.session.prepareForOpen();

        await _waitUntil(
          tester,
          () {
            final currentRoot = _findInstanceOrNull(controller, configs.rootId);
            return currentRoot != null &&
                currentRoot.generation > oldRootGeneration &&
                currentRoot.firstFrameReady &&
                currentRoot.session.active?.build == 2;
          },
          timeout: const Duration(seconds: 30),
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final result = await tester.runAsync(() => prepare);
        expect(result?['configured'], isTrue);
        expect(result?['updated'], isTrue);
        final promotedRoot = _findInstance(controller, configs.rootId);
        expect(promotedRoot.session.failure, isNull);
        expect(
          updateServer.servedPackageDirectories.contains('root-v2'),
          isTrue,
        );

        // The old child belongs to the retired root generation. The freshly
        // evaluated root must discover the same child through the matching
        // release-2 catalog, whose compositor handle is 3 rather than 2.
        await _waitUntil(
          tester,
          () {
            final child = _findInstanceOrNull(controller, configs.childId);
            return child != null &&
                child.instanceId != oldChildInstanceId &&
                child.firstFrameReady &&
                signals.any((event) => event['event'] == 'prewarmed');
          },
          timeout: const Duration(seconds: 30),
          diagnostic: () =>
              _hostDiagnostics(controller, updateServer, childRecordings),
        );
        final promotedChild = _findInstance(controller, configs.childId);
        expect(promotedChild.generation, 0);
        expect(promotedChild.session.failure, isNull);
      } finally {
        await _closeHost(tester, controller);
      }
    },
    skip: skip,
  );

  testWidgets('cache-first background failure keeps the cached child active', (
    tester,
  ) async {
    // Initial prewarm establishes v1. A failed background check must not
    // undo the cache-first open or retire its active compositor generation.
    updateServer.releaseBuild = 1;
    updateServer.failLatest = false;
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
        () =>
            _findInstance(controller, configs.childId).isPresented &&
            _findInstance(controller, configs.childId).firstFrameReady,
      );
      final failedStatus = await _waitForStatus(
        tester,
        _findInstance(controller, configs.childId).session,
        (status) => status['lastError'] != null,
      );
      expect(failedStatus['activeBuild'], 1);
      expect(failedStatus['availableVersion'], isNull);
      final failedRoot = _findInstance(controller, configs.rootId);
      final failedChild = _findInstance(controller, configs.childId);
      expect(failedRoot.isPresented, isTrue);
      expect(_frameDigests(rootRecordings.first), isNotEmpty);
      expect(failedChild.isPresented, isTrue);
      expect(failedChild.instanceId, oldInstanceId);
      expect(failedChild.generation, oldGeneration);
      expect(failedChild.session.active?.build, 1);
      expect(signals.any((event) => event['event'] == 'open-error'), isFalse);
    } finally {
      await _closeHost(tester, controller);
    }
  }, skip: skip);
}

final class _MiniUpdateConfigs {
  const _MiniUpdateConfigs({
    required this.rootId,
    required this.childId,
    required this.systemUI,
    required this.child,
    this.hostConfig,
  });

  final String rootId;
  final String childId;
  final PocketAppConfig systemUI;
  final PocketAppConfig child;
  final PocketHostConfig? hostConfig;
}

_MiniUpdateConfigs _makeConfigs({
  required Map<String, dynamic> fixture,
  required HttpServer server,
  PocketHostConfig? hostConfig,
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
  final remoteRoot = hostConfig?.systemUI;
  final remoteChild = hostConfig?.applications[childId];
  if (hostConfig != null && remoteChild == null) {
    throw StateError('single host config omitted fixture child $childId');
  }
  final childUpdates = remoteChild?.updates ?? updates;
  final rootRecording = () {
    final recording = PocketRecordingController();
    rootRecordings.add(recording);
    return recording;
  };
  final childRecording = () {
    final recording = PocketRecordingController();
    childRecordings.add(recording);
    return recording;
  };
  final systemUI = remoteRoot == null
      ? PocketAppConfig(
          appId: rootId,
          pluginFactories: [(_) => _FixtureSignals(signals)],
          bytecodeAsset: 'root/app.qjbc',
          pakAsset: 'root/app.pak',
          metadataAsset: 'root/app.bytecode.json',
          manifestAsset: 'root/guest-manifest.json',
          compositorSurfaces: <String, int>{childId: 2},
          recordingFactory: rootRecording,
        )
      : remoteRoot.copyWith(
          pluginFactories: [(_) => _FixtureSignals(signals)],
          recordingFactory: rootRecording,
          additionalCapabilities: <String>{'ui.compositor-surfaces'},
        );
  final child = remoteChild == null
      ? PocketAppConfig(
          appId: childId,
          pluginFactories: [(_) => _FixtureSignals(signals)],
          bytecodeAsset: 'child/app.qjbc',
          pakAsset: 'child/app.pak',
          metadataAsset: 'child/app.bytecode.json',
          manifestAsset: 'child/guest-manifest.json',
          updates: childUpdates,
          downloadOnOpen: downloadOnOpen,
          recordingFactory: childRecording,
        )
      : remoteChild.copyWith(
          pluginFactories: [(_) => _FixtureSignals(signals)],
          recordingFactory: childRecording,
        );
  return _MiniUpdateConfigs(
    rootId: rootId,
    childId: childId,
    systemUI: systemUI,
    child: child,
    hostConfig: hostConfig,
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
      child: configs.hostConfig == null
          ? PocketSystemHost(
              systemUI: configs.systemUI,
              applications: <String, PocketAppConfig>{
                configs.childId: configs.child,
              },
              controller: controller,
            )
          : PocketSystemHost.fromHostConfig(
              config: configs.hostConfig!,
              controller: controller,
              approveSystemUI: (config) =>
                  config.withNativePolicy(configs.systemUI),
              approveApplication: (appId, config) =>
                  config.withNativePolicy(configs.child),
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

Future<Map<String, dynamic>> _waitForAvailableVersion(
  WidgetTester tester,
  PocketSession session,
  String version,
) => _waitForStatus(
  tester,
  session,
  (status) => status['availableVersion'] == version,
);

Future<Map<String, dynamic>> _waitForStatus(
  WidgetTester tester,
  PocketSession session,
  bool Function(Map<String, dynamic>) condition, {
  Duration timeout = const Duration(seconds: 30),
}) async {
  final elapsed = Stopwatch()..start();
  while (elapsed.elapsed < timeout) {
    final status = await tester.runAsync(session.status);
    if (status != null && condition(status)) return status;
    await tester.pump(const Duration(milliseconds: 16));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  fail('Timed out waiting for mini-app session status');
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
  Map<String, dynamic>? hostConfig;
  final Map<String, Map<String, dynamic>> hostIndexes =
      <String, Map<String, dynamic>>{};
  final Map<String, Uint8List> hostBootstrap = <String, Uint8List>{};
  final Map<String, Map<String, dynamic>> hostConfigs =
      <String, Map<String, dynamic>>{};
  String? rootAppId;
  String? childAppId;
  int rootReleaseBuild = 1;
  int releaseBuild = 2;
  bool holdLatest = false;
  bool failLatest = false;
  int latestRequests = 0;
  int fileRequests = 0;
  final List<String> filePaths = <String>[];
  final List<String> servedPackageDirectories = <String>[];
  int openResponses = 0;
  final List<String> missingPaths = <String>[];
  Completer<void>? _release;

  bool get latestHeld => _release != null && !_release!.isCompleted;

  void releaseLatest() {
    final release = _release;
    if (release != null && !release.isCompleted) release.complete();
  }

  void configureHostConfig(int port) {
    final fixture =
        jsonDecode(File('$fixtureRoot/fixture.json').readAsStringSync()) as Map;
    final rootId = fixture['rootAppId'] as String;
    final childId = fixture['childAppId'] as String;
    rootAppId = rootId;
    childAppId = childId;
    final keyId = fixture['keyId'] as String;
    final publicKey = fixture['publicKeyBase64'] as String;
    final base = 'http://127.0.0.1:$port/test';
    String payloadHash(String directory) => sha256
        .convert(
          PocketSignedManifest.fromBytes(
            File(
              '$fixtureRoot/$directory/signed-manifest.json',
            ).readAsBytesSync(),
          ).payloadBytes,
        )
        .toString();

    Map<String, dynamic> package(
      String appId,
      String assetDirectory, {
      String? signedDirectory,
    }) {
      final metadata = Uint8List.fromList(
        File(
          '$fixtureRoot/$assetDirectory/assets/app.bytecode.json',
        ).readAsBytesSync(),
      );
      final manifest = Uint8List.fromList(
        File(
          '$fixtureRoot/$assetDirectory/assets/guest-manifest.json',
        ).readAsBytesSync(),
      );
      final metadataMap =
          jsonDecode(utf8.decode(metadata)) as Map<String, dynamic>;
      hostBootstrap['$appId/app.bytecode.json'] = metadata;
      hostBootstrap['$appId/guest-manifest.json'] = manifest;
      Map<String, dynamic> asset(String name, Uint8List bytes) =>
          <String, dynamic>{
            'url': '$base/bootstrap/$appId/$name',
            'sha256': sha256.convert(bytes).toString(),
            'size': bytes.length,
          };
      final rootPayloadSha256 = signedDirectory == null
          ? null
          : payloadHash(signedDirectory);
      return <String, dynamic>{
        'appId': appId,
        'version': metadataMap['version'],
        'build': metadataMap['build'],
        'packageVersion': '0.1.0',
        if (rootPayloadSha256 != null) ...<String, String>{
          'payloadSha256': rootPayloadSha256,
          'rootPayloadSha256': rootPayloadSha256,
        },
        'bootstrapAssets': <String, dynamic>{
          'assets/apps/$appId/app.bytecode.json': asset(
            'app.bytecode.json',
            metadata,
          ),
          'assets/apps/$appId/guest-manifest.json': asset(
            'guest-manifest.json',
            manifest,
          ),
        },
      };
    }

    hostConfig = <String, dynamic>{
      'kind': 'pocket-editor-app-host',
      'schemaVersion': 1,
      'systemUI': rootId,
      'updates': <String, dynamic>{
        'baseUrl': base,
        'hostVersion': '0.1.0',
        'packageVersion': '0.1.0',
        'keyId': keyId,
        'publicKey': publicKey,
        'namespace': 'ffi-single-host',
        'debugHttpHosts': <String>['127.0.0.1'],
      },
      'release': <String, dynamic>{
        'appId': rootId,
        'version': '1.0.0-test.1',
        'build': 1,
        'channel': 'test',
        'routeVersion': '1.0.0-test.1',
      },
      'compositorSurfaces': <String, int>{childId: 2},
      'applications': <String, dynamic>{
        rootId: package(rootId, 'root', signedDirectory: 'root-v1'),
        childId: package(childId, 'child-v1'),
      },
    };
    final indexHostPath =
        '/test/pocket/0.1.0/${Uri.encodeComponent(rootId)}/release-1/host.json';
    final indexHostPathV2 =
        '/test/pocket/0.1.0/${Uri.encodeComponent(rootId)}/release-2/host.json';
    hostConfigs[indexHostPath] = hostConfig!;
    final hostConfigV2 =
        jsonDecode(jsonEncode(hostConfig)) as Map<String, dynamic>;
    final rootV2 = hostConfigV2['applications'] as Map<String, dynamic>;
    final rootV2Package = rootV2[rootId] as Map<String, dynamic>;
    rootV2Package['payloadSha256'] = payloadHash('root-v2');
    rootV2Package['rootPayloadSha256'] = payloadHash('root-v2');
    (hostConfigV2['release'] as Map<String, dynamic>)
      ..['version'] = '2.0.0-test.2'
      ..['build'] = 2
      ..['routeVersion'] = '2.0.0-test.2';
    (hostConfigV2['compositorSurfaces'] as Map<String, dynamic>)[childId] = 3;
    hostConfigs[indexHostPathV2] = hostConfigV2;
    hostIndexes[rootId] = <String, dynamic>{
      'schemaVersion': 1,
      'kind': 'pocket-editor-package-index',
      'systemUI': rootId,
      'rootAppId': rootId,
      'packageId': rootId,
      'latest': <String, dynamic>{
        'releaseId': 'release-1',
        'id': rootId,
        'packageId': rootId,
        'version': '1.0.0',
        'build': 1,
        'payloadSha256': payloadHash('root-v1'),
        'rootPayloadSha256': payloadHash('root-v1'),
        'hostConfigUrl': indexHostPath,
        'manifestUrl':
            '$base/pocket/0.1.0/${Uri.encodeComponent(rootId)}/release-1/latest.json',
      },
      'versions': <dynamic>[
        <String, dynamic>{
          'releaseId': 'release-2',
          'id': rootId,
          'packageId': rootId,
          'version': '2.0.0',
          'build': 2,
          'payloadSha256': payloadHash('root-v2'),
          'rootPayloadSha256': payloadHash('root-v2'),
          'hostConfigUrl': indexHostPathV2,
          'manifestUrl':
              '$base/pocket/0.1.0/${Uri.encodeComponent(rootId)}/release-2/latest.json',
        },
      ],
    };
    hostIndexes[childId] = <String, dynamic>{
      'schemaVersion': 1,
      'kind': 'pocket-editor-package-index',
      'systemUI': rootId,
      'rootAppId': rootId,
      'packageId': childId,
      'latest': <String, dynamic>{
        'releaseId': 'release-1',
        'id': childId,
        'version': '1.0.0',
        'build': 1,
        'manifestUrl':
            '$base/pocket/0.1.0/${Uri.encodeComponent(childId)}/release-1/latest.json',
      },
      'versions': <dynamic>[],
    };
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
      final descriptor = hostConfigs[path];
      if (descriptor != null) {
        request.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(descriptor))
          ..close();
        return;
      }
      final bootstrapPrefix = path.startsWith('/test/bootstrap/')
          ? '/test/bootstrap/'
          : path.startsWith('/bootstrap/')
          ? '/bootstrap/'
          : null;
      if (bootstrapPrefix != null) {
        final key = path.substring(bootstrapPrefix.length);
        final bytes = hostBootstrap[key];
        if (bytes == null) {
          missingPaths.add(path);
          request.response.statusCode = HttpStatus.notFound;
          await request.response.close();
          return;
        }
        request.response
          ..contentLength = bytes.length
          ..add(bytes)
          ..close();
        return;
      }
      final canonical = path.split('/');
      final channelOffset =
          canonical.length > 2 &&
              (canonical[1] == 'test' || canonical[1] == 'stable') &&
              canonical[2] == 'pocket'
          ? 2
          : 1;
      final isCanonicalPackagePath =
          canonical.length == channelOffset + 4 &&
          canonical[channelOffset] == 'pocket' &&
          canonical.last == 'latest.json';
      var relative = path == '/latest.json'
          ? 'latest.json'
          : isCanonicalPackagePath
          ? 'latest.json'
          : path.startsWith('/')
          ? path.substring(1)
          : path;
      if (isCanonicalPackagePath) {
        final appId = Uri.decodeComponent(canonical[channelOffset + 2]);
        final index = hostIndexes[appId] == null
            ? null
            : Map<String, dynamic>.from(
                jsonDecode(jsonEncode(hostIndexes[appId])) as Map,
              );
        if (index == null) {
          request.response.statusCode = HttpStatus.notFound;
          await request.response.close();
          return;
        }
        final latest = index['latest'] as Map<String, dynamic>;
        if (appId == childAppId) {
          const version = '1.0.0';
          latest['releaseId'] = 'release-$releaseBuild';
          latest['id'] = appId;
          latest['packageId'] = appId;
          latest['version'] = version;
          latest['build'] = releaseBuild;
          latest['manifestUrl'] =
              '/test/pocket/0.1.0/${Uri.encodeComponent(appId)}/release-$releaseBuild/latest.json';
        }
        if (appId == rootAppId && rootReleaseBuild == 2) {
          final versions = index['versions'] as List<dynamic>;
          final next = versions.cast<Map<String, dynamic>>().firstWhere(
            (entry) => entry['releaseId'] == 'release-2',
          );
          index['latest'] = Map<String, dynamic>.from(next);
        }
        request.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(index))
          ..close();
        return;
      }
      final isCanonicalFilePath =
          canonical.length >= channelOffset + 5 &&
          canonical[channelOffset] == 'pocket';
      if (isCanonicalFilePath) {
        relative = canonical.sublist(channelOffset + 4).join('/');
      }
      if (relative == 'latest.json') {
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
      final fileAppId = isCanonicalFilePath
          ? Uri.decodeComponent(canonical[channelOffset + 2])
          : null;
      final isRootPackage = fileAppId != null && fileAppId == rootAppId;
      final packageBuild = isRootPackage ? rootReleaseBuild : releaseBuild;
      final packageDirectory = isRootPackage
          ? 'root-v$packageBuild'
          : 'child-v$packageBuild';
      final file = File('$fixtureRoot/$packageDirectory/$relative');
      filePaths.add(relative);
      if (!file.existsSync()) {
        missingPaths.add(relative);
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      fileRequests++;
      servedPackageDirectories.add(packageDirectory);
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
