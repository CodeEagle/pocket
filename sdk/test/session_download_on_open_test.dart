import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

// The core cases stop at the host's first-frame boundary; the optional final
// case also loads the signed package through the real FFI runtime when the
// generated fixture and native library are available.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final savedHttpOverrides = HttpOverrides.current;
  // Flutter's test binding installs a blocking override. This suite uses a
  // real loopback HttpServer and must exercise the production HTTP transport.
  HttpOverrides.global = null;
  tearDownAll(() => HttpOverrides.global = savedHttpOverrides);
  const appId = 'test.download-on-open';
  const otherAppId = 'test.download-on-open.other';
  const abi = 'download-on-open-abi';
  const keyId = 'download-on-open-test';
  const metadataAsset = 'download-on-open/metadata.json';
  const manifestAsset = 'download-on-open/manifest.json';

  late Directory directory;
  late HttpServer server;
  late SimpleKeyPair keyPair;
  late SimplePublicKey publicKey;
  late _UpdateServer updateServer;
  late List<String> assetRequests;
  Map<String, dynamic>? fixtureMetadata;
  Map<String, dynamic>? fixtureManifest;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'pocket-session-download-on-open-',
    );
    keyPair = await Ed25519().newKeyPair();
    publicKey = await keyPair.extractPublicKey();
    assetRequests = <String>[];
    fixtureMetadata = null;
    fixtureManifest = null;
    updateServer = _UpdateServer();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen(updateServer.handle);

    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      final name = utf8.decode(message!.buffer.asUint8List());
      assetRequests.add(name);
      if (name.endsWith(metadataAsset)) {
        return _assetBytes(
          fixtureMetadata ??
              <String, dynamic>{
                'runtimeAbi': abi,
                'version': '1.0.0',
                'build': 1,
                // The local entry is intentionally not present. The update package
                // is the first executable artifact for this host.
                'bytecodeBytes': 0,
              },
        );
      }
      if (name.endsWith(manifestAsset)) {
        return _assetBytes(
          fixtureManifest ??
              <String, dynamic>{
                'capabilities': <String, dynamic>{
                  'requires': <String>[
                    'updates.rollback',
                    'updates.check',
                    'updates.apply',
                  ],
                },
              },
        );
      }
      // A download-on-open app must not silently fall back to absent embedded
      // qjbc/pak assets when it has no healthy package.
      throw StateError('Unexpected embedded asset request: $name');
    });
  });

  tearDown(() async {
    updateServer.releaseHeldResponse();
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
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  PocketAppConfig config({String id = appId, bool downloadOnOpen = true}) =>
      PocketAppConfig(
        appId: id,
        metadataAsset: metadataAsset,
        manifestAsset: manifestAsset,
        // This is the new opt-in path under test. The legacy default remains
        // false, so every test states the policy explicitly.
        downloadOnOpen: downloadOnOpen,
        updates: PocketUpdateConfig(
          url: 'http://127.0.0.1:${server.port}/manifest.json',
          keyId: keyId,
          publicKey: base64Encode(publicKey.bytes),
        ),
      );

  PocketSession session({String id = appId}) =>
      PocketSession(config: config(id: id));

  Future<void> waitUntil(
    bool Function() condition, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (!condition()) {
      if (DateTime.now().isAfter(deadline)) {
        fail('Session did not reach expected state');
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  Future<void> waitForHealthy(PocketSession value) async {
    value.onReady(value.controller);
    await waitUntil(
      () => value.stage == 'ready' || value.failure != null,
      timeout: const Duration(seconds: 4),
    );
    expect(value.failure, isNull, reason: value.lastError);
    expect(value.stage, 'ready');
  }

  Future<void> waitForAvailableVersion(
    PocketSession value,
    String version,
  ) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (DateTime.now().isBefore(deadline)) {
      final current = await value.status();
      if (current['availableVersion'] == version) return;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    fail('Session did not stage update $version');
  }

  Future<void> closeQuietly(PocketSession value) async {
    try {
      await value.close();
    } catch (_) {
      // Initialization failures are intentionally rethrown by close(); the
      // individual test has already asserted the original failure.
    }
  }

  PocketPackageStore packageStore() => PocketPackageStore(
    Directory('${directory.path}/pocket-packages/$appId/default'),
  );

  PocketManifestVerifier verifier() => PocketManifestVerifier(
    trustedKeys: <String, List<int>>{keyId: publicKey.bytes},
    appId: appId,
    expectedRuntimeAbi: abi,
    requireBytecode: true,
  );

  test(
    'downloadOnOpen downloads once, deduplicates initialize, and promotes healthy package',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;

      final value = session();
      final unopened = session(id: otherAppId);
      try {
        final first = value.initialize();
        final duplicate = value.initialize();
        expect(identical(first, duplicate), isTrue);
        await first;

        expect(updateServer.count('/manifest.json'), 1);
        expect(updateServer.count(release.entryPath), 1);
        expect(updateServer.count(release.pakPath), 1);
        expect(value.active?.build, 2);
        expect(value.active?.version, '2.0.0');
        expect(value.transferProgress, isNull);
        expect(
          assetRequests.where(
            (name) => name.endsWith('.qjbc') || name.endsWith('.pak'),
          ),
          isEmpty,
        );

        // Merely constructing an unopened package does not trigger a request
        // for that package's signed manifest or content.
        expect(updateServer.totalRequests, 3);
        await waitForHealthy(value);
        final healthy = await packageStore()
            .scoped(appId)
            .lastGood(verifier: verifier());
        expect(healthy?.manifest.payload.build, 2);
        expect(healthy?.manifest.payload.pak.size, release.pak.length);
      } finally {
        await closeQuietly(unopened);
        await closeQuietly(value);
      }
    },
  );

  test(
    'downloadOnOpen allows a slow transfer while real byte progress continues',
    () async {
      const chunkSize = 32 * 1024;
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        entryBytes: Uint8List.fromList(
          List<int>.generate(3 * chunkSize, (index) => index % 251),
        ),
      );
      updateServer.current = release;
      updateServer.chunkedPath = release.entryPath;
      updateServer.chunkSize = chunkSize;
      updateServer.chunkDelay = const Duration(seconds: 11);

      final value = session();
      final progress = <PocketUpdateProgress>[];
      void observeProgress() {
        final current = value.transferProgress;
        if (current != null) progress.add(current);
      }

      value.addListener(observeProgress);
      final elapsed = Stopwatch()..start();
      try {
        await value.initialize();

        expect(elapsed.elapsed, greaterThan(const Duration(seconds: 20)));
        expect(value.active?.build, 2);
        expect(value.transferProgress, isNull);
        expect(
          progress
              .where((fact) => fact.stage == PocketUpdateStage.downloading)
              .map((fact) => fact.downloadedBytes)
              .toSet()
              .length,
          greaterThanOrEqualTo(3),
        );
      } finally {
        value.removeListener(observeProgress);
        await closeQuietly(value);
      }
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );

  test(
    'downloadOnOpen times out a stalled preparation and cancels the request',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      updateServer.holdPath = '/manifest.json';

      final value = session();
      final initializing = value.initialize();
      try {
        await waitUntil(() => updateServer.count('/manifest.json') > 0);
        await expectLater(
          initializing.timeout(const Duration(seconds: 24)),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'download-timeout',
            ),
          ),
        );
        expect(value.transferProgress, isNull);
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(value);
      }
    },
    timeout: const Timeout(Duration(seconds: 40)),
  );

  test(
    'downloadOnOpen reports real streamed bytes and clears on cancellation',
    () async {
      const chunkSize = 64 * 1024;
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        entryBytes: Uint8List.fromList(
          List<int>.generate(4 * chunkSize, (index) => index % 251),
        ),
      );
      updateServer.current = release;
      updateServer.chunkedPath = release.entryPath;
      updateServer.chunkSize = chunkSize;
      // The first real chunk is flushed to the client, then the server holds
      // the rest so listeners can inspect a stable mid-transfer snapshot.
      updateServer.holdPath = release.entryPath;

      final value = session();
      var notifications = 0;
      final observed = <PocketUpdateProgress>[];
      void observeProgress() {
        notifications++;
        final progress = value.transferProgress;
        if (progress != null) observed.add(progress);
      }

      value.addListener(observeProgress);
      final initializing = value.initialize();
      try {
        await waitUntil(() {
          final progress = value.transferProgress;
          return progress?.stage == PocketUpdateStage.downloading &&
              progress!.downloadedBytes >= chunkSize;
        });
        final progress = value.transferProgress!;
        expect(progress.stage, PocketUpdateStage.downloading);
        expect(progress.downloadedBytes, chunkSize);
        expect(progress.totalBytes, release.entry.length + release.pak.length);
        expect(notifications, greaterThan(1));
        expect(
          observed.any((fact) => fact.downloadedBytes == chunkSize),
          isTrue,
        );
        expect(value.ready, isFalse);

        // Stop before the fixture's fake bytecode can reach a runtime mount.
        // Disposing cancels the active HTTP transfer and clears the snapshot.
        final closing = value.close();
        updateServer.releaseHeldResponse();
        try {
          await closing;
        } catch (_) {
          // Initialization reports the expected cancellation to its caller.
        }
        expect(value.transferProgress, isNull);
      } finally {
        value.removeListener(observeProgress);
        updateServer.releaseHeldResponse();
        try {
          await initializing;
        } catch (_) {
          // This test intentionally cancels initialization mid-transfer.
        }
        await closeQuietly(value);
      }
    },
  );

  test(
    'applying the active package is a verified no-op without a remount',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      late PocketHostRegistry registry;
      final value = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) => _CaptureUpdateRegistry((captured) => registry = captured),
          ],
        ),
      );
      try {
        await value.initialize();
        await waitForHealthy(value);
        final generation = value.generation;

        final checked = await registry
            .registrationFor('updates.check')!
            .request!(const {});
        expect((checked as Map)['availableVersion'], '2.0.0');

        final applying = registry.registrationFor('updates.apply')!.request!(
          const {},
        );
        await expectLater(
          value.prepareForOpen(),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'busy',
            ),
          ),
        );
        final applied = await applying;
        expect((applied as Map)['scheduled'], isFalse);
        expect(applied['version'], '2.0.0');
        expect(value.generation, generation);
        expect(value.active?.build, 2);
        expect(value.stage, 'ready');
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'stale apply precondition leaves the signed candidate untouched',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      final release3 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 3,
        version: '3.0.0',
      );
      updateServer.current = release2;
      late PocketHostRegistry registry;
      final value = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) => _CaptureUpdateRegistry((captured) => registry = captured),
          ],
        ),
      );
      try {
        await value.initialize();
        await waitForHealthy(value);
        final generation = value.generation;

        updateServer.current = release3;
        final checked = await registry
            .registrationFor('updates.check')!
            .request!(const {});
        expect((checked as Map)['availableVersion'], '3.0.0');

        await expectLater(
          registry.registrationFor('updates.apply')!.request!(<String, dynamic>{
            // A JS Number can arrive in Dart as double; an integral 2.0 is
            // accepted, then rejected as stale against the prepared v3.
            'expectedVersion': '2.0.0',
            'expectedBuild': 2.0,
          }),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'stale_update',
            ),
          ),
        );
        expect(value.generation, generation);
        expect(value.active?.build, 2);
        expect(value.stage, 'verified');
        expect((await value.status())['availableVersion'], '3.0.0');

        // The stale rejection must not leave the session busy; a subsequent
        // check can still replace/reuse the verified signed candidate.
        final retried = await registry
            .registrationFor('updates.check')!
            .request!(const {});
        expect((retried as Map)['availableVersion'], '3.0.0');
        expect(value.stage, 'verified');
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'signed partial base archive fetches only omitted resources before activation',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        partialBundle: true,
      );
      updateServer.current = release;
      final value = session();
      try {
        await value.initialize();
        expect(updateServer.count('/base.zip'), 1);
        expect(updateServer.count(release.entryPath), 0);
        expect(updateServer.count(release.pakPath), 1);
        expect(
          await File(value.active!.source.pakPath).readAsBytes(),
          release.pak,
        );
        await waitForHealthy(value);
        final requests = updateServer.totalRequests;
        await closeQuietly(value);
        updateServer.online = false;
        final reopened = session();
        try {
          await reopened.initialize();
          expect(reopened.active!.build, 2);
          expect(reopened.transferProgress, isNull);
          expect(updateServer.totalRequests, requests);
        } finally {
          await closeQuietly(reopened);
        }
      } finally {
        await closeQuietly(value);
      }
    },
  );

  for (final failure in [
    'corrupt-network',
    'missing-base-entry',
    'missing-base-entry-warm',
    'corrupt-base-entry-warm',
    'extra-base-entry',
    'unknown-hash',
    'duplicate-hash',
  ]) {
    test('partial base archive rejects $failure without activation', () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        partialBundle: true,
        corruptPak: failure == 'corrupt-network',
        omitBundledEntry: failure.startsWith('missing-base-entry'),
        corruptBundledEntry: failure == 'corrupt-base-entry-warm',
        extraBundledEntry: failure == 'extra-base-entry',
        invalidSubset: failure == 'unknown-hash' || failure == 'duplicate-hash'
            ? failure
            : null,
      );
      updateServer.current = release;
      if (failure.endsWith('-warm')) {
        final hash = crypto.sha256.convert(release.entry).toString();
        await packageStore()
            .scoped(appId)
            .writeBlob(
              file: PocketManifestFile(
                sha256: hash,
                size: release.entry.length,
                url: 'blobs/$hash',
              ),
              bytes: Stream<List<int>>.value(release.entry),
              cancellation: PocketCancellationToken(),
            );
      }
      final value = session();
      try {
        await expectLater(value.initialize(), throwsA(anything));
        expect(value.active, isNull);
        final store = packageStore().scoped(appId);
        expect(await store.active(verifier: verifier()), isNull);
        expect(await store.lastGood(verifier: verifier()), isNull);
        if (failure != 'corrupt-network')
          expect(updateServer.count(release.pakPath), 0);
      } finally {
        await closeQuietly(value);
      }
    });
  }

  test(
    'a healthy download-on-open cache reopens offline without another request',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;

      final first = session();
      try {
        await first.initialize();
        await waitForHealthy(first);
      } finally {
        await closeQuietly(first);
      }
      final requestsBeforeOffline = updateServer.totalRequests;
      expect(requestsBeforeOffline, 3);

      updateServer.online = false;
      final reopened = session();
      try {
        await reopened.initialize();
        expect(reopened.active?.build, 2);
        expect(reopened.runtimeInfo()['source'], 'verified-cache');
        expect(updateServer.totalRequests, requestsBeforeOffline);
        expect(reopened.lastError, isNull);
      } finally {
        await closeQuietly(reopened);
      }
    },
  );

  test(
    'cacheFirst presents healthy cache through blocked HTTP and uses staged update on next open',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      final first = session();
      try {
        await first.initialize();
        await waitForHealthy(first);
      } finally {
        await closeQuietly(first);
      }

      final release3 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 3,
        version: '3.0.0',
      );
      updateServer.current = release3;
      updateServer.holdPath = '/manifest.json';
      final manifestRequests = updateServer.count('/manifest.json');
      final cached = session();
      try {
        // initialize returns before the held response is released. The
        // background check has not mounted or promoted the newer package.
        await cached
            .initialize(prepareForOpen: true, cacheFirst: true)
            .timeout(const Duration(seconds: 2));
        await waitUntil(
          () => updateServer.count('/manifest.json') > manifestRequests,
        );
        expect(cached.active?.version, '2.0.0');
        expect(cached.generation, 0);
        final repeatedOpen = await cached
            .prepareForOpen(cacheFirst: true)
            .timeout(const Duration(seconds: 1));
        expect(repeatedOpen, <String, Object?>{
          'configured': true,
          'updated': false,
        });
        expect(cached.active?.version, '2.0.0');
        expect(cached.generation, 0);

        updateServer.releaseHeldResponse();
        await waitForAvailableVersion(cached, '3.0.0');
        expect(cached.active?.version, '2.0.0');
        expect(cached.generation, 0);
        await waitForHealthy(cached);
        final healthy = await packageStore()
            .scoped(appId)
            .lastGood(verifier: verifier());
        expect(healthy?.manifest.payload.version, '2.0.0');

        // A resident open consumes the staged v3 package, then starts its own
        // non-blocking refresh so each subsequent open can stage the next
        // published version.
        updateServer.holdPath = '/manifest.json';
        final residentOpenManifestRequests = updateServer.count(
          '/manifest.json',
        );
        final residentOpen = await cached.prepareForOpen(cacheFirst: true);
        expect(residentOpen, <String, Object?>{
          'configured': true,
          'updated': true,
        });
        expect(cached.active?.version, '3.0.0');
        expect(cached.generation, 1);
        await waitUntil(
          () =>
              updateServer.count('/manifest.json') >
              residentOpenManifestRequests,
        );
        expect(cached.active?.version, '3.0.0');
        expect(cached.generation, 1);
        updateServer.releaseHeldResponse();
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(cached);
      }

      // The staged v3 directory is consumed locally on the next cache-first
      // startup. Its own refresh is held to prove startup does not need HTTP.
      updateServer.holdPath = '/manifest.json';
      final nextOpenManifestRequests = updateServer.count('/manifest.json');
      final nextOpen = session();
      try {
        await nextOpen
            .initialize(prepareForOpen: true, cacheFirst: true)
            .timeout(const Duration(seconds: 2));
        expect(nextOpen.active?.version, '3.0.0');
        expect(nextOpen.generation, 0);
        final repeatedOpen = await nextOpen.prepareForOpen(cacheFirst: true);
        expect(repeatedOpen, <String, Object?>{
          'configured': true,
          'updated': false,
        });
        await waitUntil(
          () => updateServer.count('/manifest.json') > nextOpenManifestRequests,
        );
        expect(nextOpen.active?.version, '3.0.0');
        expect(nextOpen.generation, 0);
        expect(updateServer.count(release3.entryPath), 1);
        expect(updateServer.count(release3.pakPath), 1);
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(nextOpen);
      }
    },
  );

  test(
    'cacheFirst waits for a cold signed download and cancellation drains it',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      updateServer.holdPath = '/manifest.json';
      final value = session();
      var completed = false;
      final initializing = value
          .initialize(prepareForOpen: true, cacheFirst: true)
          .then<void>(
            (_) => completed = true,
            onError: (Object _) {
              completed = true;
            },
          );
      try {
        await waitUntil(() => updateServer.count('/manifest.json') > 0);
        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(completed, isFalse);
        expect(value.ready, isFalse);
        expect(value.active, isNull);

        final closing = value.close();
        updateServer.releaseHeldResponse();
        await closing;
        await initializing;
        expect(value.active, isNull);
        expect(value.ready, isFalse);
        expect(
          await packageStore().scoped(appId).lastGood(verifier: verifier()),
          isNull,
        );
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(value);
      }
    },
  );

  test(
    'cacheFirst background check failure leaves the healthy runtime ready',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final first = session();
      try {
        await first.initialize();
        await waitForHealthy(first);
      } finally {
        await closeQuietly(first);
      }

      updateServer.online = false;
      final cached = session();
      try {
        await cached
            .initialize(prepareForOpen: true, cacheFirst: true)
            .timeout(const Duration(seconds: 2));
        final generation = cached.generation;
        expect(cached.active?.version, '2.0.0');
        expect(cached.ready, isTrue);
        await waitForHealthy(cached);
        await waitUntil(
          () =>
              cached.lastError?.startsWith(
                'Background update preparation failed:',
              ) ==
              true,
        );
        expect(cached.active?.version, '2.0.0');
        expect(cached.generation, generation);
        expect(cached.ready, isTrue);
        expect(cached.stage, 'ready');
        expect(cached.failure, isNull);
      } finally {
        await closeQuietly(cached);
      }
    },
  );

  test(
    'cacheFirst cold download failure has no embedded or stale fallback',
    () async {
      updateServer.online = false;
      final value = session();
      try {
        await expectLater(
          value.initialize(prepareForOpen: true, cacheFirst: true),
          throwsA(anything),
        );
        expect(updateServer.count('/manifest.json'), greaterThan(0));
        expect(value.active, isNull);
        expect(value.ready, isFalse);
        expect(value.failure, isNotNull);
        expect(value.stage, 'error');
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'cacheFirst keeps a bundled runtime presentable during a blocked update',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 1,
        version: 'embedded-floor-1.0.0',
      );
      updateServer.current = release;
      updateServer.holdPath = '/manifest.json';
      final value = PocketSession(config: config(downloadOnOpen: false));
      try {
        await value
            .initialize(prepareForOpen: true, cacheFirst: true)
            .timeout(const Duration(seconds: 2));
        await waitUntil(() => updateServer.count('/manifest.json') > 0);
        expect(value.ready, isTrue);
        expect(value.runtimeInfo()['source'], 'embedded');
        expect(value.active, isNull);
        expect(value.failure, isNull);
        final result = await value.prepareForOpen(cacheFirst: true);
        expect(result, <String, Object?>{'configured': true, 'updated': false});
        expect(value.runtimeInfo()['source'], 'embedded');

        updateServer.releaseHeldResponse();
        await waitForAvailableVersion(value, 'embedded-floor-1.0.0');
        expect(value.active, isNull);
        expect(value.failure, isNull);
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(value);
      }

      updateServer.holdPath = '/manifest.json';
      final nextOpen = PocketSession(config: config(downloadOnOpen: false));
      try {
        await nextOpen
            .initialize(prepareForOpen: true, cacheFirst: true)
            .timeout(const Duration(seconds: 2));
        expect(nextOpen.active?.version, 'embedded-floor-1.0.0');
        expect(nextOpen.active?.build, 1);
        expect(nextOpen.generation, 0);
      } finally {
        updateServer.releaseHeldResponse();
        await closeQuietly(nextOpen);
      }
    },
  );

  test(
    'hidden mounted bundle is a same-content no-op without re-downloading it',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        partialBundle: true,
      );
      updateServer.current = release;
      final value = session();
      try {
        await value.initialize();
        final baseRequests = updateServer.count('/base.zip');
        final pakRequests = updateServer.count(release.pakPath);

        final result = await value.prepareForOpen();

        expect(result, <String, Object?>{'configured': true, 'updated': false});
        expect(updateServer.count('/base.zip'), baseRequests);
        expect(updateServer.count(release.pakPath), pakRequests);
        expect(value.active?.version, '2.0.0');
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'hidden mounted bundle is the granular baseline for a newer release',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        partialBundle: true,
      );
      updateServer.current = release2;
      final value = session();
      try {
        await value.initialize();
        final baseRequests = updateServer.count('/base.zip');
        final entryRequests = updateServer.count(release2.entryPath);
        final pakRequests = updateServer.count(release2.pakPath);
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
          entryBytes: release2.entry,
          pakBytes: release2.pak,
          partialBundle: true,
        );
        updateServer.current = release3;

        final result = await value.prepareForOpen();

        expect(result, <String, Object?>{'configured': true, 'updated': true});
        expect(updateServer.count('/base.zip'), baseRequests);
        expect(updateServer.count(release3.entryPath), entryRequests);
        expect(updateServer.count(release3.pakPath), pakRequests);
        expect(value.active?.build, 3);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'hidden mounted package prevents downgrade and same-build replacement',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      final value = session();
      try {
        await value.initialize();
        final generation = value.generation;
        final release1 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 1,
          version: '1.0.0',
        );
        updateServer.current = release1;
        await expectLater(
          value.prepareForOpen(),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'manifest-format',
            ),
          ),
        );
        expect(value.active?.version, '2.0.0');
        expect(value.generation, generation);

        final sameBuildReplacement = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 2,
          version: '2.0.1',
          entryBytes: Uint8List.fromList(<int>[0x52, 2, 0x42]),
          pakBytes: encodePocketPak(<PocketPakBlobEntry>[
            PocketPakBlobEntry(key: 'bootstrap/2.0.1', data: <int>[2, 0x7e]),
          ]),
        );
        updateServer.current = sameBuildReplacement;
        await expectLater(
          value.prepareForOpen(),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'manifest-format',
            ),
          ),
        );
        expect(value.active?.version, '2.0.0');
        expect(value.generation, generation);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'a disk-active package from another session does not make mounted code a no-op',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      late PocketHostRegistry registry;
      final resident = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) => _CaptureUpdateRegistry((captured) => registry = captured),
          ],
        ),
      );
      PocketSession? promoted;
      try {
        await resident.initialize();
        await waitForHealthy(resident);
        await resident.setForeground(false);
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
        );
        updateServer.current = release3;
        promoted = session();
        await promoted.initialize();
        await waitForHealthy(promoted);

        final checked = await registry
            .registrationFor('updates.check')!
            .request!(const {});
        expect((checked as Map)['availableVersion'], '3.0.0');
        final applied = await registry
            .registrationFor('updates.apply')!
            .request!(const {});
        expect((applied as Map)['scheduled'], isTrue);
        expect(applied['version'], '3.0.0');
      } finally {
        final other = promoted;
        if (other != null) await closeQuietly(other);
        await closeQuietly(resident);
      }
    },
  );

  test(
    'double mount failure clears the active package and leaves a retryable error',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      var providerCreations = 0;
      final value = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) {
              providerCreations++;
              if (providerCreations >= 2) {
                throw StateError('bridge failure');
              }
              return _CaptureUpdateRegistry((_) {});
            },
          ],
        ),
      );
      try {
        await value.initialize();
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
        );
        updateServer.current = release3;

        Future<void> expectMountFailure() async {
          await expectLater(
            value.prepareForOpen(),
            throwsA(
              isA<PocketCapabilityException>().having(
                (error) => error.code,
                'code',
                'update_mount_failed',
              ),
            ),
          );
        }

        await expectMountFailure();
        expect(value.active, isNull);
        expect(value.ready, isFalse);
        expect(value.failure, isNotNull);
        expect(value.stage, 'error');

        // A second attempt must reach package admission again rather than
        // inheriting the hidden prewarm's previous busy state.
        await expectMountFailure();
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen checks a healthy cache and mounts the newer signed package',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      final value = session();
      try {
        await value.initialize();
        await waitForHealthy(value);
        final previousManifestRequests = updateServer.count('/manifest.json');
        final previousGeneration = value.generation;

        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
        );
        updateServer.current = release3;
        final result = await value.prepareForOpen();

        expect(result, <String, Object?>{'configured': true, 'updated': true});
        expect(value.transferProgress, isNull);
        expect(
          updateServer.count('/manifest.json'),
          previousManifestRequests + 1,
        );
        expect(value.active?.package.versionId, isNotNull);
        expect(value.active?.build, 3);
        expect(value.generation, previousGeneration + 1);

        // prepareForOpen does not wait for health while mounting. The normal
        // visible-frame promotion remains responsible for the healthy pointer.
        await waitForHealthy(value);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen re-verifies an unchanged package without remounting',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final value = session();
      try {
        await value.initialize();
        await waitForHealthy(value);
        final manifestRequests = updateServer.count('/manifest.json');
        final entryRequests = updateServer.count(release.entryPath);
        final pakRequests = updateServer.count(release.pakPath);
        final generation = value.generation;

        final result = await value.prepareForOpen();

        expect(result, <String, Object?>{'configured': true, 'updated': false});
        expect(updateServer.count('/manifest.json'), manifestRequests + 1);
        expect(updateServer.count(release.entryPath), entryRequests);
        expect(updateServer.count(release.pakPath), pakRequests);
        expect(value.generation, generation);
        expect(value.active?.build, 2);
        expect(value.stage, 'ready');
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen does not remount an unpromoted hidden package',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final value = session();
      try {
        await value.initialize();
        // The package is active in the hidden/prewarm session, but no visible
        // health window has promoted it to lastGood yet.
        expect(value.active?.version, '2.0.0');
        final generation = value.generation;
        final manifestRequests = updateServer.count('/manifest.json');

        final result = await value.prepareForOpen();

        expect(result, <String, Object?>{'configured': true, 'updated': false});
        expect(updateServer.count('/manifest.json'), manifestRequests + 1);
        expect(value.generation, generation);
        expect(value.active?.version, '2.0.0');
        await waitForHealthy(value);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen reports a mount rollback instead of accepting the old package',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release2;
      var providerCreations = 0;
      final value = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) {
              providerCreations++;
              if (providerCreations == 2) {
                throw StateError('candidate bridge failed');
              }
              return _CaptureUpdateRegistry((_) {});
            },
          ],
        ),
      );
      try {
        await value.initialize();
        await waitForHealthy(value);
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
        );
        updateServer.current = release3;

        await expectLater(
          value.prepareForOpen(),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'update_mount_failed',
            ),
          ),
        );
        expect(providerCreations, 3);
        expect(value.active?.build, 2);

        // The failed hidden mount must not leave the session permanently
        // locked; the original package can be health-checked or retried.
        await waitForHealthy(value);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen rejects a concurrent mount while bridge admission is blocked',
    () async {
      final release2 = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
        requiredCapabilities: const <String>[
          'updates.rollback',
          'updates.check',
          'updates.apply',
          'test.blocking',
        ],
        guestManifest: <String, dynamic>{
          'capabilities': <String, dynamic>{
            'requires': <String>['test.blocking'],
          },
        },
      );
      updateServer.current = release2;
      fixtureManifest = <String, dynamic>{
        'capabilities': <String, dynamic>{
          'requires': <String>[
            'updates.rollback',
            'updates.check',
            'updates.apply',
            'test.blocking',
          ],
        },
      };
      final entered = Completer<void>();
      final releasePlugin = Completer<void>();
      var providerCreations = 0;
      final value = PocketSession(
        config: config().copyWith(
          pluginFactories: [
            (_) {
              providerCreations++;
              if (providerCreations == 2) {
                return _BlockingPlugin(entered, releasePlugin.future);
              }
              final ready = Completer<void>()..complete();
              return _BlockingPlugin(ready, Future<void>.value());
            },
          ],
        ),
      );
      try {
        await value.initialize();
        await waitForHealthy(value);
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
          requiredCapabilities: const <String>[
            'updates.rollback',
            'updates.check',
            'updates.apply',
            'test.blocking',
          ],
          guestManifest: <String, dynamic>{
            'capabilities': <String, dynamic>{
              'requires': <String>['test.blocking'],
            },
          },
        );
        updateServer.current = release3;

        final first = value.prepareForOpen();
        await entered.future;
        await expectLater(
          value.prepareForOpen(),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'busy',
            ),
          ),
        );
        releasePlugin.complete();
        final result = await first;
        expect(result['updated'], isTrue);
        expect(value.active?.build, 3);
      } finally {
        if (!releasePlugin.isCompleted) releasePlugin.complete();
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen accepts a signed package at the embedded build floor',
    () async {
      fixtureMetadata = <String, dynamic>{
        'runtimeAbi': abi,
        'version': '2.0.0',
        'build': 2,
        'bytecodeBytes': 0,
      };
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final value = PocketSession(config: config(downloadOnOpen: false));
      try {
        await value.initialize(prepareForOpen: true);
        expect(value.active?.build, 2);
        expect(value.active?.version, '2.0.0');
        expect(updateServer.count('/manifest.json'), 1);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  test(
    'prepareForOpen startup failure does not fall back to embedded runtime',
    () async {
      fixtureMetadata = <String, dynamic>{
        'runtimeAbi': abi,
        'version': '2.0.0',
        'build': 2,
        'bytecodeBytes': 0,
      };
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final value = PocketSession(
        config: config(downloadOnOpen: false).copyWith(
          pluginFactories: [(_) => throw StateError('candidate bridge failed')],
        ),
      );
      try {
        await expectLater(
          value.initialize(prepareForOpen: true),
          throwsStateError,
        );
        expect(value.active, isNull);
        expect(value.ready, isFalse);
        expect(value.failure, isNotNull);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  for (final invalid in <String>['signature', 'hash', 'appId', 'abi']) {
    test(
      'downloadOnOpen rejects a signed package with invalid $invalid',
      () async {
        final release = await _makeRelease(
          keyPair: keyPair,
          appId: invalid == 'appId' ? 'wrong.download-on-open' : appId,
          abi: invalid == 'abi' ? 'wrong-runtime-abi' : abi,
          build: 2,
          version: '2.0.0-$invalid',
          corruptSignature: invalid == 'signature',
          corruptPak: invalid == 'hash',
        );
        updateServer.current = release;
        final value = session();
        Object? initializationError;
        try {
          try {
            await value.initialize();
          } catch (error) {
            initializationError = error;
          }
          expect(
            initializationError,
            isNotNull,
            reason: 'invalid $invalid package must not be admitted',
          );
          expect(value.ready, isFalse);
          expect(value.active, isNull);
          expect(value.transferProgress, isNull);
          expect(
            assetRequests.where(
              (name) => name.endsWith('.qjbc') || name.endsWith('.pak'),
            ),
            isEmpty,
            reason: 'invalid $invalid package must not try embedded runtime',
          );
          expect(
            await packageStore().scoped(appId).lastGood(verifier: verifier()),
            isNull,
          );
        } finally {
          await closeQuietly(value);
        }
      },
    );
  }

  test(
    'downloadOnOpen rejects an initial package below the embedded build floor',
    () async {
      fixtureMetadata = <String, dynamic>{
        'runtimeAbi': abi,
        'version': '3.0.0',
        'build': 3,
        'bytecodeBytes': 0,
      };
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 1,
        version: '1.0.1',
      );
      updateServer.current = release;
      final value = session();
      Object? initializationError;
      try {
        try {
          await value.initialize();
        } catch (error) {
          initializationError = error;
        }
        expect(initializationError, isNotNull);
        expect(value.ready, isFalse);
        expect(value.active, isNull);
        expect(
          assetRequests.where(
            (name) => name.endsWith('.qjbc') || name.endsWith('.pak'),
          ),
          isEmpty,
        );
      } finally {
        await closeQuietly(value);
      }
    },
  );

  for (final partial in [false, true]) {
    test(
      'close cancels an in-flight download before it can become healthy (partial archive: $partial)',
      () async {
        final release = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 2,
          version: '2.0.0',
          partialBundle: partial,
        );
        updateServer.current = release;
        final heldPath = partial ? release.pakPath : release.entryPath;
        updateServer.holdPath = heldPath;
        final value = session();
        final initializing = value.initialize();
        try {
          await waitUntil(() => updateServer.count(heldPath) > 0);
          final closing = value.close();
          try {
            await closing.timeout(const Duration(seconds: 3));
          } on TimeoutException {
            rethrow;
          } catch (_) {
            // close() waits on initialize(); cancellation may surface the
            // expected PocketUpdateCancellation through that future.
          }
          // The disposed session is allowed to swallow cancellation while
          // unwinding its initialization future; the observable contract is
          // that it never publishes a runtime or healthy pointer.
          await initializing;
          expect(value.ready, isFalse);
          expect(value.active, isNull);
          expect(value.transferProgress, isNull);
          expect(
            await packageStore().scoped(appId).lastGood(verifier: verifier()),
            isNull,
          );
        } finally {
          updateServer.releaseHeldResponse();
          await closeQuietly(value);
        }
      },
    );
  }

  test(
    'runtime failure before first health has no embedded fallback',
    () async {
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = release;
      final value = session();
      try {
        await value.initialize();
        expect(value.active?.build, 2);

        await value.onError(StateError('downloaded guest failed to start'));
        expect(value.stage, 'error');
        expect(value.failure, isNotNull);
        expect(value.active, isNull);
        expect(value.ready, isFalse);
        expect(
          assetRequests.where(
            (name) => name.endsWith('.qjbc') || name.endsWith('.pak'),
          ),
          isEmpty,
          reason: 'no healthy package means no embedded fallback',
        );
        expect(
          await packageStore().scoped(appId).lastGood(verifier: verifier()),
          isNull,
        );
      } finally {
        await closeQuietly(value);
      }
    },
  );

  for (final fallbackFails in [false, true]) {
    test(
      'failed update recovery never restarts failed candidate (fallback fails: $fallbackFails)',
      () async {
        final release2 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 2,
          version: '2.0.0',
        );
        final release3 = await _makeRelease(
          keyPair: keyPair,
          appId: appId,
          abi: abi,
          build: 3,
          version: '3.0.0',
        );
        updateServer.current = release2;
        late PocketHostRegistry registry;
        var providerCreations = 0;
        final value = PocketSession(
          config: config().copyWith(
            pluginFactories: [
              (_) {
                providerCreations++;
                if (fallbackFails && providerCreations == 3) {
                  throw StateError('healthy fallback provider failed');
                }
                return _CaptureUpdateRegistry((value) => registry = value);
              },
            ],
          ),
        );
        try {
          await value.initialize();
          await waitForHealthy(value);
          expect(value.active?.build, 2);

          updateServer.current = release3;
          await registry.registrationFor('updates.check')!.request!(const {});
          expect((await value.status())['availableVersion'], '3.0.0');
          await registry.registrationFor('updates.apply')!.request!(const {});
          await waitUntil(() => value.active?.build == 3);

          // The new package has not passed its health window. onError must use
          // the promoted v2 package, rather than the immutable embedded guest.
          await value.onError(StateError('v3 failed before health'));
          if (fallbackFails) {
            expect(value.failure, isNotNull);
            expect(
              value.lastError,
              contains('healthy fallback provider failed'),
            );
            expect(value.active, isNull);
            expect(value.ready, isFalse);
            expect(
              providerCreations,
              3,
              reason: 'must not reactivate failed v3',
            );
            return;
          }
          expect(value.active?.build, 2);
          expect(value.lastError, contains('v3 failed before health'));
          await waitForHealthy(value);
          expect(value.active?.build, 2);
          expect(
            (await packageStore().scoped(appId).lastGood(verifier: verifier()))
                ?.manifest
                .payload
                .build,
            2,
          );
        } finally {
          await closeQuietly(value);
        }
      },
    );
  }

  test(
    'active-only package is not reused as a healthy offline cache',
    () async {
      final staged = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = staged;
      final first = session();
      try {
        await first.initialize();
        final store = packageStore().scoped(appId);
        await store.activate(first.active!.package, verifier: verifier());
        expect(await store.lastGood(verifier: verifier()), isNull);
      } finally {
        await first.close();
      }
      final current = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 3,
        version: '3.0.0',
      );
      updateServer.current = current;
      final reopened = session();
      try {
        await reopened.initialize();
        expect(reopened.active?.build, 3);
        expect(updateServer.count(current.entryPath), greaterThan(0));
      } finally {
        await reopened.close();
      }
    },
  );

  test(
    'bootstrap upgrade excludes stale healthy cache and failed-candidate recovery',
    () async {
      final old = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 2,
        version: '2.0.0',
      );
      updateServer.current = old;
      final first = session();
      try {
        await first.initialize();
        await waitForHealthy(first);
      } finally {
        await first.close();
      }
      fixtureMetadata = {'runtimeAbi': abi, 'build': 3, 'version': '3.0.0'};
      rootBundle.clear();
      final current = await _makeRelease(
        keyPair: keyPair,
        appId: appId,
        abi: abi,
        build: 3,
        version: '3.0.0',
      );
      updateServer.current = current;
      final upgraded = session();
      try {
        await upgraded.initialize();
        expect(upgraded.active?.build, 3);
        expect(updateServer.count(current.entryPath), greaterThan(0));
        await upgraded.onError(StateError('build 3 cannot start'));
        expect(upgraded.failure, isNotNull);
        expect(upgraded.active, isNull);
        expect(upgraded.ready, isFalse);
        expect(upgraded.stage, 'error');
      } finally {
        await closeQuietly(upgraded);
      }
    },
  );

  test(
    'remote bootstrap requires a trusted positive build before any HTTP request',
    () async {
      fixtureMetadata = {'runtimeAbi': abi};
      final value = session();
      try {
        await expectLater(value.initialize(), throwsFormatException);
        expect(updateServer.totalRequests, 0);
        expect(value.ready, isFalse);
      } finally {
        await closeQuietly(value);
      }
    },
  );

  final nativePath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final fixtureRoot = Platform.environment['POCKET_ON_DEMAND_FIXTURE_DIR'];
  final fixtureAssetsPath = fixtureRoot == null ? null : '$fixtureRoot/assets';
  final fixtureNames = <String>[
    'app.bytecode.json',
    'guest-manifest.json',
    'app.qjbc',
    'app.pak',
  ];
  final missingFixture = fixtureAssetsPath == null
      ? fixtureNames
      : fixtureNames
            .where((name) => !File('$fixtureAssetsPath/$name').existsSync())
            .toList(growable: false);
  final ffiSkip = nativePath == null
      ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native library.'
      : fixtureAssetsPath == null
      ? 'Set POCKET_ON_DEMAND_FIXTURE_DIR to the on_demand_fixture.ts output.'
      : missingFixture.isEmpty
      ? null
      : 'Missing generated fixture assets: ${missingFixture.join(', ')}';

  test(
    'downloaded QJBC renders and responds to native pointer input',
    () async {
      final assetsPath = fixtureAssetsPath!;
      final metadata = Map<String, dynamic>.from(
        jsonDecode(await File('$assetsPath/app.bytecode.json').readAsString())
            as Map,
      )..remove('worker');
      final metadataAbi = metadata['runtimeAbi'];
      if (metadataAbi is! String || metadataAbi.isEmpty) {
        fail('Generated fixture metadata has no runtimeAbi');
      }
      final fixtureAbi = metadataAbi;
      final manifest = Map<String, dynamic>.from(
        jsonDecode(await File('$assetsPath/guest-manifest.json').readAsString())
            as Map,
      );
      manifest['capabilities'] = <String, dynamic>{
        'requires': <String>[],
        'optional': <String>[],
      };
      final entry = Uint8List.fromList(
        await File('$assetsPath/app.qjbc').readAsBytes(),
      );
      final pak = Uint8List.fromList(
        await File('$assetsPath/app.pak').readAsBytes(),
      );
      final embeddedBuild = (metadata['build'] as num?)?.toInt() ?? 1;
      const nativeAppId = 'test.download-on-open.native';
      fixtureMetadata = metadata;
      fixtureManifest = manifest;
      final release = await _makeRelease(
        keyPair: keyPair,
        appId: nativeAppId,
        abi: fixtureAbi,
        build: embeddedBuild + 1,
        version: 'native-${embeddedBuild + 1}.0.0',
        entryBytes: entry,
        pakBytes: pak,
        requiredCapabilities: const <String>[],
        partialBundle: true,
      );
      updateServer.current = release;
      final value = session(id: nativeAppId);
      FfiPocketRuntime? runtime;
      try {
        await value.initialize();
        final package = value.active;
        expect(package, isNotNull);
        final actualEntry = await File(package!.source.entryPath).readAsBytes();
        final actualPak = await File(package.source.pakPath).readAsBytes();
        expect(actualEntry, orderedEquals(entry));
        expect(actualPak, orderedEquals(pak));
        expect(updateServer.count('/base.zip'), 1);
        expect(updateServer.count(release.entryPath), 0);
        expect(updateServer.count(release.pakPath), 1);

        runtime = FfiPocketRuntime.open(width: 360, height: 640);
        var frame = runtime.loadBytecode(
          Uint8List.fromList(actualEntry),
          Uint8List.fromList(actualPak),
          expectedRuntimeAbi: fixtureAbi,
        );
        final imageResources = <PocketImageResource>[...frame.resources];
        String textFrom(PocketFrame current) => current.ops
            .whereType<PocketTextOp>()
            .map((op) => op.text)
            .join('\n');
        var text = textFrom(frame);
        for (
          var tick = 0;
          tick < 60 && !text.contains('Downloaded count 0');
          tick++
        ) {
          frame = runtime.frame(16);
          imageResources.addAll(frame.resources);
          text = textFrom(frame);
        }
        expect(text, contains('Downloaded count 0'));
        final image = imageResources.singleWhere(
          (resource) => resource.asset == 'assets/remote.svg',
        );
        expect(image.width, 16);
        expect(image.height, 16);
        expect(image.pixels.take(4), orderedEquals(<int>[50, 100, 200, 255]));
        expect(
          frame.ops.whereType<PocketImageOp>().map((op) => op.asset),
          contains('assets/remote.svg'),
        );
        final button = frame.ops.whereType<PocketTextOp>().singleWhere(
          (op) => op.text == 'Increment downloaded app',
        );
        final point = <String, dynamic>{
          'id': 0,
          'x': button.x + button.width / 2,
          'y': button.y + button.height / 2,
        };
        runtime.send({
          'type': 'event',
          'name': 'input.pointer',
          'payload': {...point, 'phase': 'down'},
        });
        runtime.frame(16);
        runtime.send({
          'type': 'event',
          'name': 'input.pointer',
          'payload': {...point, 'phase': 'up'},
        });
        final changed = runtime.frame(16);
        expect(
          changed.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n'),
          contains('Downloaded count 1'),
        );
      } finally {
        runtime?.dispose();
        await closeQuietly(value);
        fixtureMetadata = null;
        fixtureManifest = null;
      }
    },
    skip: ffiSkip,
  );
}

Future<ByteData> _assetBytes(Map<String, dynamic> value) async =>
    ByteData.sublistView(Uint8List.fromList(utf8.encode(jsonEncode(value))));

Future<_Release> _makeRelease({
  required SimpleKeyPair keyPair,
  required String appId,
  required String abi,
  required int build,
  required String version,
  Uint8List? entryBytes,
  Uint8List? pakBytes,
  List<String> requiredCapabilities = const <String>[
    'updates.rollback',
    'updates.check',
    'updates.apply',
  ],
  Map<String, dynamic>? guestManifest,
  bool corruptSignature = false,
  bool corruptPak = false,
  bool partialBundle = false,
  bool omitBundledEntry = false,
  bool corruptBundledEntry = false,
  bool extraBundledEntry = false,
  String? invalidSubset,
}) async {
  final entry = entryBytes ?? Uint8List.fromList(<int>[0x51, build, 0x42]);
  final pak =
      pakBytes ??
      encodePocketPak(<PocketPakBlobEntry>[
        PocketPakBlobEntry(key: 'bootstrap/$version', data: <int>[build, 0x7f]),
      ]);
  final entryHash = crypto.sha256.convert(entry).toString();
  final pakHash = crypto.sha256.convert(pak).toString();
  final bundle = partialBundle
      ? encodePocketZip(<String, List<int>>{
          if (!omitBundledEntry)
            'blobs/$entryHash': corruptBundledEntry
                ? (Uint8List.fromList(entry)..[0] ^= 1)
                : entry,
          if (extraBundledEntry) 'unlisted': <int>[1, 2, 3],
        })
      : null;
  final payload = <String, dynamic>{
    'schemaVersion': 1,
    'appId': appId,
    'version': version,
    'build': build,
    'signedAt': DateTime.now().millisecondsSinceEpoch ~/ 1000,
    'capabilities': <String, dynamic>{'requires': requiredCapabilities},
    if (guestManifest != null) 'guestManifest': guestManifest,
    'protocol': 1,
    'minHostVersion': 1,
    'entry': <String, dynamic>{'sha256': entryHash, 'size': entry.length},
    'entryFormat': 'bytecode',
    'runtimeAbi': abi,
    if (bundle != null)
      'bundle': <String, dynamic>{
        'format': 'zip',
        'sha256': crypto.sha256.convert(bundle).toString(),
        'size': bundle.length,
        'url': 'base.zip',
        'blobs': <String>[
          entryHash,
          if (invalidSubset == 'unknown-hash') List.filled(64, 'a').join(),
          if (invalidSubset == 'duplicate-hash') entryHash,
        ],
      },
    'pak': <String, dynamic>{
      'sha256': pakHash,
      'size': pak.length,
      'parts': <Map<String, dynamic>>[
        <String, dynamic>{'offset': 0, 'sha256': pakHash, 'size': pak.length},
      ],
    },
    'files': <Map<String, dynamic>>[
      <String, dynamic>{
        'sha256': entryHash,
        'size': entry.length,
        'url': 'blobs/$entryHash',
      },
      <String, dynamic>{
        'sha256': pakHash,
        'size': pak.length,
        'url': 'blobs/$pakHash',
      },
    ],
  };
  final payloadBytes = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
  final signature = await Ed25519().sign(payloadBytes, keyPair: keyPair);
  final signatureBytes = List<int>.from(signature.bytes);
  if (corruptSignature) signatureBytes[0] ^= 0x01;
  final envelope = Uint8List.fromList(
    utf8.encode(
      jsonEncode(<String, dynamic>{
        'keyId': 'download-on-open-test',
        'payload': base64Encode(payloadBytes),
        'signature': base64Encode(signatureBytes),
      }),
    ),
  );
  final servedPak = Uint8List.fromList(pak);
  if (corruptPak) servedPak[0] ^= 0x01;
  return _Release(
    envelope: envelope,
    entryPath: '/blobs/$entryHash',
    pakPath: '/blobs/$pakHash',
    entry: entry,
    pak: pak,
    servedPak: servedPak,
    bundle: bundle,
  );
}

final class _Release {
  const _Release({
    required this.envelope,
    required this.entryPath,
    required this.pakPath,
    required this.entry,
    required this.pak,
    required this.servedPak,
    this.bundle,
  });

  final Uint8List envelope;
  final String entryPath;
  final String pakPath;
  final Uint8List entry;
  final Uint8List pak;
  final Uint8List servedPak;
  final Uint8List? bundle;
}

final class _UpdateServer {
  _Release? current;
  bool online = true;
  String? holdPath;
  String? chunkedPath;
  int chunkSize = 64 * 1024;
  Duration chunkDelay = Duration.zero;
  final Map<String, int> _counts = <String, int>{};
  Completer<void>? _releaseHeld;

  int get totalRequests =>
      _counts.values.fold<int>(0, (sum, value) => sum + value);

  int count(String path) => _counts[path] ?? 0;

  Future<void> handle(HttpRequest request) async {
    final path = request.uri.path;
    _counts[path] = count(path) + 1;
    final release = current;
    if (!online || release == null) {
      request.response.statusCode = HttpStatus.serviceUnavailable;
      await request.response.close();
      return;
    }
    final bytes = switch (path) {
      '/manifest.json' => release.envelope,
      '/base.zip' => release.bundle,
      _ when path == release.entryPath => release.entry,
      _ when path == release.pakPath => release.servedPak,
      _ => null,
    };
    if (bytes == null) {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      return;
    }
    if (path == chunkedPath) {
      request.response.headers.chunkedTransferEncoding = true;
      try {
        for (var offset = 0; offset < bytes.length; offset += chunkSize) {
          final end = (offset + chunkSize).clamp(0, bytes.length).toInt();
          request.response.add(bytes.sublist(offset, end));
          await request.response.flush();
          if (offset + chunkSize < bytes.length && chunkDelay > Duration.zero) {
            await Future<void>.delayed(chunkDelay);
          }
          if (path == holdPath && offset == 0) {
            _releaseHeld ??= Completer<void>();
            await _releaseHeld!.future;
          }
        }
      } catch (_) {
        // Closing the session cancels the real client stream while the server
        // may still be waiting between chunks.
      } finally {
        try {
          await request.response.close();
        } catch (_) {}
      }
      return;
    }
    if (path == holdPath) {
      _releaseHeld ??= Completer<void>();
      request.response.headers.chunkedTransferEncoding = true;
      try {
        request.response.add(<int>[bytes.first]);
        await request.response.flush();
        await _releaseHeld!.future;
        if (bytes.length > 1) request.response.add(bytes.sublist(1));
      } catch (_) {
        // The HTTP client is expected to close this response when Session.close
        // cancels its coordinator.
      } finally {
        try {
          await request.response.close();
        } catch (_) {}
      }
      return;
    }
    request.response.contentLength = bytes.length;
    request.response.add(bytes);
    await request.response.close();
  }

  void releaseHeldResponse() {
    _releaseHeld?.complete();
    _releaseHeld = null;
    holdPath = null;
  }
}

final class _CaptureUpdateRegistry extends PocketPlugin {
  _CaptureUpdateRegistry(this.capture);
  final void Function(PocketHostRegistry) capture;
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.update.registry',
    version: '1.0.0',
    capabilities: {},
  );
  @override
  void register(PocketPluginContext context) => capture(context.registry);
}

final class _BlockingPlugin extends PocketPlugin {
  _BlockingPlugin(this.entered, this.release);

  final Completer<void> entered;
  final Future<void> release;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.blocking',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{
      'test.blocking': PocketPluginCapability(
        name: 'test.blocking',
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('test.blocking', (_) => null);
  }

  @override
  Future<void> activate(PocketPluginContext context) async {
    if (!entered.isCompleted) entered.complete();
    await release;
  }
}
