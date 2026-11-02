import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

// Session/store integration: exercise real signature verification, persisted
// pointers and restart selection. Bytecode execution belongs to the FFI tests.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const appId = 'test.host.upgrade';
  const abi = 'session-upgrade-abi';
  late Directory directory;
  late SimpleKeyPair keyPair;
  late SimplePublicKey publicKey;
  late PocketPackageStore store;
  var metadata = <String, dynamic>{};
  var manifest = <String, dynamic>{};

  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'pocket-session-upgrade-',
    );
    keyPair = await Ed25519().newKeyPair();
    publicKey = await keyPair.extractPublicKey();
    store = PocketPackageStore(
      Directory('${directory.path}/pocket-packages/$appId/default'),
    );
    metadata = {'runtimeAbi': abi, 'version': '1.0.0', 'build': 1};
    manifest = {
      'capabilities': {'requires': <String>[]},
    };
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      final name = utf8.decode(message!.buffer.asUint8List());
      return ByteData.sublistView(
        Uint8List.fromList(
          utf8.encode(
            jsonEncode(name.endsWith('metadata.json') ? metadata : manifest),
          ),
        ),
      );
    });
  });

  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    await directory.delete(recursive: true);
  });

  PocketSession newSession({bool updates = true}) => PocketSession(
    config: PocketAppConfig(
      appId: appId,
      metadataAsset: 'upgrade/metadata.json',
      manifestAsset: 'upgrade/manifest.json',
      updates: updates
          ? PocketUpdateConfig(
              url: 'http://127.0.0.1:1/latest.json',
              keyId: 'upgrade-test',
              publicKey: base64Encode(publicKey.bytes),
            )
          : null,
    ),
  );

  Future<void> seedHealthyOta({int build = 2}) async {
    final entry = <int>[1, 2, 3];
    final pak = <int>[4, 5, 6];
    String digest(List<int> bytes) => crypto.sha256.convert(bytes).toString();
    final entryHash = digest(entry);
    final pakHash = digest(pak);
    final payload = utf8.encode(
      jsonEncode({
        'schemaVersion': 1,
        'appId': appId,
        'version': '$build.0.0',
        'build': build,
        'capabilities': {
          'requires': ['updates.rollback'],
        },
        'protocol': 1,
        'minHostVersion': 1,
        'entry': {'sha256': entryHash, 'size': entry.length},
        'entryFormat': 'bytecode',
        'runtimeAbi': abi,
        'pak': {
          'sha256': pakHash,
          'size': pak.length,
          'parts': [
            {'offset': 0, 'sha256': pakHash, 'size': pak.length},
          ],
        },
        'files': [
          {
            'sha256': entryHash,
            'size': entry.length,
            'url': 'blobs/$entryHash',
          },
          {'sha256': pakHash, 'size': pak.length, 'url': 'blobs/$pakHash'},
        ],
      }),
    );
    final signature = await Ed25519().sign(payload, keyPair: keyPair);
    final signed = PocketSignedManifest.fromBytes(
      Uint8List.fromList(
        utf8.encode(
          jsonEncode({
            'keyId': 'upgrade-test',
            'payload': base64Encode(payload),
            'signature': base64Encode(signature.bytes),
          }),
        ),
      ),
    );
    final uri = Uri.parse('http://127.0.0.1:1/latest.json');
    final coordinator = PocketUpdateCoordinator(
      manifestUri: uri,
      appId: appId,
      trustedKeys: {'upgrade-test': publicKey.bytes},
      expectedRuntimeAbi: abi,
      requireBytecode: true,
      store: store,
      transport: _MemoryTransport({
        uri.toString(): signed.envelopeBytes,
        uri.resolve('blobs/$entryHash').toString(): entry,
        uri.resolve('blobs/$pakHash').toString(): pak,
      }),
    );
    try {
      await coordinator.commitHealthy(await coordinator.prepare());
    } finally {
      coordinator.dispose();
    }
  }

  Future<void> waitUntil(bool Function() condition) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!condition()) {
      if (DateTime.now().isAfter(deadline))
        fail('Session did not reach expected state');
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  test(
    'public rollback promotes the previous package after health and survives restart',
    () async {
      await seedHealthyOta(build: 1);
      await seedHealthyOta();
      final session = newSession();
      try {
        await session.initialize();
        session.onReady(session.controller);
        await waitUntil(() => session.stage == 'ready');
        expect(session.active?.build, 2);
        final generation = session.generation;
        session.onEvent(
          const PocketEvent(
            id: 'rollback',
            method: 'host.request',
            params: {
              'requestId': 'rollback',
              'capability': 'updates.rollback',
              'params': {},
            },
          ),
        );
        await waitUntil(
          () => session.generation > generation && session.active?.build == 1,
        );
        final verifier = PocketManifestVerifier(
          appId: appId,
          trustedKeys: {'upgrade-test': publicKey.bytes},
          expectedRuntimeAbi: abi,
          requireBytecode: true,
        );
        final scoped = store.scoped(appId);
        // Keep the established healthy package until the rollback target passes
        // its own health window; a crash during that window must recover v2.
        expect(
          (await scoped.lastGood(verifier: verifier))?.manifest.payload.build,
          2,
        );
        session.onReady(session.controller);
        await waitUntil(
          () => session.stage == 'ready' || session.lastError != null,
        );
        expect(
          session.lastError,
          isNull,
          reason:
              'Rollback health must not use update anti-downgrade admission',
        );
        expect(session.active?.build, 1);
        expect(
          (await scoped.lastGood(verifier: verifier))?.manifest.payload.build,
          1,
        );
        expect(
          (await scoped.listVersions(
            verifier: verifier,
          )).singleWhere((v) => v.isPrevious).build,
          2,
        );
        expect(session.lastError, isNull);
      } finally {
        await session.close();
      }
      final restarted = newSession();
      try {
        await restarted.initialize();
        expect(restarted.active?.build, 1);
      } finally {
        await restarted.close();
      }
    },
  );

  test(
    'rollback target failure before health preserves the healthy package',
    () async {
      await seedHealthyOta(build: 1);
      await seedHealthyOta();
      final session = newSession();
      try {
        await session.initialize();
        session.onReady(session.controller);
        await waitUntil(() => session.stage == 'ready');
        final generation = session.generation;
        session.onEvent(
          const PocketEvent(
            id: 'failed-rollback',
            method: 'host.request',
            params: {
              'requestId': 'failed-rollback',
              'capability': 'updates.rollback',
              'params': {},
            },
          ),
        );
        await waitUntil(
          () => session.generation > generation && session.active?.build == 1,
        );
        await session.onError(
          StateError('rollback target failed before health'),
        );
        expect(session.active?.build, 2);
        session.onReady(session.controller);
        await waitUntil(() => session.stage == 'ready');
        expect(session.active?.build, 2);
      } finally {
        await session.close();
      }
      final restarted = newSession();
      try {
        await restarted.initialize();
        expect(restarted.active?.build, 2);
      } finally {
        await restarted.close();
      }
    },
  );

  test(
    'failed embedded rollback recovers the verified OTA without restart',
    () async {
      await seedHealthyOta(); // No previous pointer: rollback selects embedded.
      final session = newSession();
      try {
        await session.initialize();
        session.onReady(session.controller);
        await waitUntil(() => session.stage == 'ready');
        final generation = session.generation;
        session.onEvent(
          const PocketEvent(
            id: 'embedded-rollback',
            method: 'host.request',
            params: {'capability': 'updates.rollback', 'params': {}},
          ),
        );
        await waitUntil(
          () => session.generation > generation && session.active == null,
        );
        await session.onError(
          StateError('embedded guest failed before health'),
        );
        expect(session.active?.build, 2);
        session.onReady(session.controller);
        await waitUntil(() => session.stage == 'ready');
        expect(session.active?.build, 2);
      } finally {
        await session.close();
      }
    },
  );

  for (final manifestFallback in [false, true]) {
    test('host upgrade clears old OTA on restart '
        '(manifest build fallback: $manifestFallback)', () async {
      await seedHealthyOta();
      final original = newSession();
      try {
        await original.initialize();
        expect(original.active?.build, 2);
        expect(original.runtimeInfo()['source'], 'verified-cache');
      } finally {
        await original.close();
      }

      metadata = {
        'runtimeAbi': abi,
        'version': '3.0.0',
        if (!manifestFallback) 'build': 3,
      };
      if (manifestFallback) manifest['build'] = 3;
      rootBundle.clear();
      for (var restart = 0; restart < 2; restart++) {
        final upgraded = newSession();
        try {
          await upgraded.initialize();
          expect(upgraded.ready, isTrue);
          expect(upgraded.active, isNull);
          expect(upgraded.runtimeInfo()['source'], 'embedded');
          expect((await upgraded.status())['activeBuild'], 3);
          final scoped = store.scoped(appId);
          for (final pointer in ['active', 'lastGood', 'previous']) {
            expect(
              await scoped.readPointerId(pointer),
              isNull,
              reason: '$pointer must stay clear after restart $restart',
            );
          }
        } finally {
          await upgraded.close();
        }
      }
    });
  }

  for (final build in [null, 0, -1, 1.5, '3', 9007199254740992]) {
    test('configured updates reject invalid embedded build $build', () async {
      metadata.remove('build');
      if (build != null) metadata['build'] = build;
      manifest['build'] = 9;
      if (build == null) manifest.remove('build');
      final session = newSession();
      try {
        await expectLater(session.initialize(), throwsFormatException);
        expect(session.ready, isFalse);
      } finally {
        // close() also observes the original initialization failure.
        await expectLater(session.close(), throwsFormatException);
      }
    });
  }

  test('legacy offline artifacts may omit release build', () async {
    metadata.remove('build');
    final session = newSession(updates: false);
    try {
      await session.initialize();
      expect(session.ready, isTrue);
      expect(session.runtimeInfo()['build'], 0);
    } finally {
      await session.close();
    }
  });
}

final class _MemoryTransport implements PocketUpdateTransport {
  _MemoryTransport(this.responses);
  final Map<String, List<int>> responses;

  @override
  Future<PocketDownloadResponse> open(
    Uri uri, {
    required PocketCancellationToken cancellation,
  }) async {
    cancellation.throwIfCancelled();
    final bytes = responses[uri.toString()];
    if (bytes == null) throw StateError('Unexpected update request: $uri');
    return PocketDownloadResponse(
      bytes: Stream.value(bytes),
      contentLength: bytes.length,
    );
  }

  @override
  void close() {}
}
