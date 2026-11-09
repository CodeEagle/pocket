import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_sdk/src/pocket_app.dart'
    show PocketGuestSession, PocketGuestSessionState;

final class _ApplicationPlugin extends PocketPlugin {
  String? activatedApp;
  final disposed = Completer<void>();
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'example.custom',
    version: '1.0.0',
    capabilities: {
      'example.echo': PocketPluginCapability(
        name: 'example.echo',
        kind: PocketCapabilityKind.request,
      ),
    },
  );
  @override
  void register(PocketPluginContext context) =>
      context.registerRequest('example.echo', (params) => params);
  @override
  void activate(PocketPluginContext context) {
    activatedApp = context.appId;
  }

  @override
  void dispose() {
    if (!disposed.isCompleted) disposed.complete();
  }
}

Future<void> _waitForHealthy(PocketSession session) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (session.stage != 'ready' && DateTime.now().isBefore(deadline)) {
    if (session.lastError != null) break;
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
  expect(session.lastError, isNull);
  expect(session.stage, 'ready');
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory directory;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('pocket-sdk-session-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      final name = utf8.decode(data!.buffer.asUint8List());
      final content = name.endsWith('metadata.json')
          ? {
              'runtimeAbi': 'test-session-admission',
              'bytecodeBytes': 123,
              'build': 42,
              'version': '2.3.0',
            }
          : {
              'capabilities': {
                'requires': [
                  name.contains('missing') ? 'example.missing' : 'example.echo',
                  'input.touch',
                  'display.viewport.live',
                ],
              },
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
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
    try {
      if (await directory.exists()) {
        await directory.delete(recursive: true);
      }
    } catch (_) {}
  });

  test(
    'external app identity and plugin factory enter the SDK admission lifecycle',
    () async {
      final plugin = _ApplicationPlugin();
      var created = 0;
      final session = PocketSession(
        config: PocketAppConfig(
          appId: 'external.sample',
          metadataAsset: 'external/metadata.json',
          manifestAsset: 'external/manifest.json',
          pluginFactories: [
            (controller) {
              created++;
              return plugin;
            },
          ],
        ),
      );
      try {
        await session.initialize();
        expect(session.ready, isTrue);
        expect(created, 1);
        expect(plugin.activatedApp, 'external.sample');
        expect(
          session.performance.logPath,
          contains('/pocket-performance/external.sample/'),
        );
        final status = await session.status();
        expect(status['configured'], isFalse);
        expect(status['activeBuild'], 42);
        expect(status['activeVersion'], '2.3.0');
        expect((status['versions'] as List).single['build'], 42);
        expect(session.runtimeInfo()['build'], 42);
        expect(session.runtimeInfo()['version'], '2.3.0');
      } finally {
        session.dispose();
        await plugin.disposed.future;
        await session.performance.dispose();
      }
    },
  );

  test(
    'official button requirements need an explicitly enabled keyboard source',
    () async {
      for (final enabled in [false, true]) {
        final session = PocketSession(
          config: PocketAppConfig(
            appId: 'external.buttons.$enabled',
            metadataAsset: 'buttons/metadata.json',
            bootstrapManifestJson:
                '{"capabilities":{"requires":["input.buttons"]}}',
            keyboardInputEnabled: enabled,
          ),
        );
        try {
          if (enabled) {
            await session.initialize();
            expect(session.ready, isTrue);
          } else {
            await expectLater(session.initialize(), throwsStateError);
            expect(session.ready, isFalse);
          }
        } finally {
          session.dispose();
          await session.performance.dispose();
        }
      }
    },
  );

  test(
    'external required capability is rejected before guest startup',
    () async {
      final session = PocketSession(
        config: const PocketAppConfig(
          appId: 'external.missing',
          metadataAsset: 'missing/metadata.json',
          manifestAsset: 'missing/manifest.json',
        ),
      );
      try {
        await expectLater(session.initialize(), throwsStateError);
        expect(session.ready, isFalse);
      } finally {
        session.dispose();
        await session.performance.dispose();
      }
    },
  );

  test(
    'bootstrap assets and history load together and admission waits for all',
    () async {
      final metadataRequested = Completer<void>();
      final manifestRequested = Completer<void>();
      final releaseMetadata = Completer<void>();
      final historyRequested = Completer<void>();
      final releaseHistory = Completer<void>();
      final plugin = _ApplicationPlugin();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (_) async {
          if (!historyRequested.isCompleted) historyRequested.complete();
          await releaseHistory.future;
          return directory.path;
        },
      );
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        final isMetadata = name.endsWith('metadata.json');
        if (isMetadata) {
          metadataRequested.complete();
          await releaseMetadata.future;
        } else {
          manifestRequested.complete();
        }
        return ByteData.sublistView(
          Uint8List.fromList(
            utf8.encode(
              jsonEncode(
                isMetadata
                    ? {'runtimeAbi': 'test-session-admission', 'build': 42}
                    : {
                        'capabilities': {
                          'requires': ['example.echo'],
                        },
                      },
              ),
            ),
          ),
        );
      });
      final session = PocketSession(
        config: PocketAppConfig(
          appId: 'external.concurrent',
          metadataAsset: 'concurrent/metadata.json',
          manifestAsset: 'concurrent/manifest.json',
          pluginFactories: [(_) => plugin],
        ),
      );
      final initializing = session.initialize();
      try {
        await historyRequested.future.timeout(const Duration(seconds: 5));
        await metadataRequested.future.timeout(const Duration(seconds: 5));
        await manifestRequested.future.timeout(const Duration(seconds: 5));
        expect(session.ready, isFalse);
        expect(plugin.activatedApp, isNull);
        releaseMetadata.complete();
        await Future<void>.delayed(Duration.zero);
        expect(session.ready, isFalse);
        expect(plugin.activatedApp, isNull);
        releaseHistory.complete();
        await initializing;
        expect(session.ready, isTrue);
        expect(plugin.activatedApp, 'external.concurrent');
      } finally {
        if (!releaseMetadata.isCompleted) releaseMetadata.complete();
        if (!releaseHistory.isCompleted) releaseHistory.complete();
        await initializing;
        await session.close();
      }
    },
  );

  test(
    'bootstrap failure and close drain pending history restoration',
    () async {
      final historyRequested = Completer<void>();
      final releaseHistory = Completer<void>();
      final metadataRequested = Completer<void>();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (_) async {
          if (!historyRequested.isCompleted) historyRequested.complete();
          await releaseHistory.future;
          return directory.path;
        },
      );
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        if (name.endsWith('metadata.json')) {
          metadataRequested.complete();
          return null;
        }
        return ByteData.sublistView(Uint8List.fromList(utf8.encode('{}')));
      });
      final session = PocketSession(
        config: const PocketAppConfig(
          appId: 'external.failed-bootstrap',
          metadataAsset: 'failed-bootstrap/metadata.json',
          manifestAsset: 'failed-bootstrap/manifest.json',
        ),
      );
      var initialized = false;
      Object? failure;
      final initializing = session.initialize().then<void>(
        (_) => initialized = true,
        onError: (Object error) {
          failure = error;
          initialized = true;
        },
      );
      Future<Object?>? closing;
      try {
        await historyRequested.future.timeout(const Duration(seconds: 5));
        await metadataRequested.future.timeout(const Duration(seconds: 5));
        await Future<void>.delayed(Duration.zero);
        expect(initialized, isFalse);
        var closed = false;
        closing = session.close().then<Object?>(
          (_) {
            closed = true;
            return null;
          },
          onError: (Object error) {
            closed = true;
            return error;
          },
        );
        await Future<void>.delayed(Duration.zero);
        expect(closed, isFalse);
        releaseHistory.complete();
        await initializing;
        expect(failure, isA<FlutterError>());
        expect(await closing, isA<FlutterError>());
      } finally {
        if (!releaseHistory.isCompleted) releaseHistory.complete();
        await initializing;
        await (closing ?? session.close().catchError((Object _) {}));
      }
    },
  );

  test(
    'close waits for initialization and disposes a coordinator created late',
    () async {
      final metadataRequested = Completer<void>();
      final releaseMetadata = Completer<void>();
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        if (name.endsWith('slow-metadata.json')) {
          if (!metadataRequested.isCompleted) metadataRequested.complete();
          await releaseMetadata.future;
          return ByteData.sublistView(
            Uint8List.fromList(
              utf8.encode(
                jsonEncode(<String, dynamic>{
                  'runtimeAbi': 'test-session-admission',
                  'bytecodeBytes': 123,
                  'build': 42,
                }),
              ),
            ),
          );
        }
        return ByteData.sublistView(
          Uint8List.fromList(
            utf8.encode(
              jsonEncode(<String, dynamic>{
                'capabilities': <String, dynamic>{'requires': <String>[]},
              }),
            ),
          ),
        );
      });
      addTearDown(() {
        if (!releaseMetadata.isCompleted) releaseMetadata.complete();
      });

      final session = PocketSession(
        config: const PocketAppConfig(
          appId: 'external.slow',
          metadataAsset: 'slow-metadata.json',
          manifestAsset: 'slow-manifest.json',
          updates: PocketUpdateConfig(
            url: 'http://127.0.0.1:1/manifest.json',
            keyId: 'test-key',
            publicKey: 'AA==',
          ),
        ),
      );
      final initializing = session.initialize();
      await metadataRequested.future;

      final closing = session.close();
      var closed = false;
      closing.then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);

      releaseMetadata.complete();
      await initializing;
      await closing;
      expect(session.ready, isFalse);
      expect(session.stage, 'initializing');
    },
  );

  testWidgets(
    'rebuilding PocketGuest with identical non-const PocketAppConfig preserves the same PocketSession instance',
    (tester) async {
      PocketAppConfig makeConfig() => PocketAppConfig(
        appId: 'external.rebuild',
        metadataAsset: 'external/metadata.json',
        manifestAsset: 'external/manifest.json',
        allowedPermissions: const {'test.perm'},
        additionalCapabilities: const {'test.cap'},
        updates: const PocketUpdateConfig(
          url: 'http://127.0.0.1:1/manifest.json',
          keyId: 'test-key',
          publicKey: 'AA==',
        ),
      );

      final config1 = makeConfig();
      final config2 = makeConfig();
      expect(identical(config1, config2), isFalse);
      expect(config1 == config2, isTrue);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PocketGuest(config: config1)),
        ),
      );

      final state1 = tester.state<PocketGuestSessionState>(
        find.byType(PocketGuestSession),
      );
      final session1 = state1.session;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PocketGuest(config: config2)),
        ),
      );

      final state2 = tester.state<PocketGuestSessionState>(
        find.byType(PocketGuestSession),
      );
      final session2 = state2.session;

      expect(identical(state1, state2), isTrue);
      expect(identical(session1, session2), isTrue);
    },
  );
  testWidgets(
    'a stale initialization error must not dispose the replacement session',
    (tester) async {
      final binding = TestWidgetsFlutterBinding.ensureInitialized();
      final requestedA = Completer<void>();
      final requestedB = Completer<void>();
      final gateA = Completer<void>();
      final gateB = Completer<void>();
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => directory.path,
      );
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        if (name == 'review-A-metadata.json') {
          if (!requestedA.isCompleted) requestedA.complete();
          await gateA.future;
          return null; // Old configuration's asset load fails late.
        }
        if (name == 'review-B-metadata.json') {
          if (!requestedB.isCompleted) requestedB.complete();
          await gateB.future;
        }
        final value = name.contains('metadata')
            ? {
                'runtimeAbi': 'review-abi',
                'bytecodeBytes': 1,
                'version': '1',
                'build': 1,
              }
            : {
                'capabilities': {
                  'requires': <String>['updates.rollback'],
                },
              };
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(value))),
        );
      });
      Widget app(String asset) => MaterialApp(
        home: PocketGuest(
          config: PocketAppConfig(
            appId: 'review.same.app',
            metadataAsset: asset,
            manifestAsset: 'review-manifest.json',
          ),
        ),
      );
      try {
        await tester.pumpWidget(app('review-A-metadata.json'));
        for (var i = 0; i < 100 && !requestedA.isCompleted; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
        }
        expect(requestedA.isCompleted, isTrue, reason: 'A requested');
        final state = tester.state<PocketGuestSessionState>(
          find.byType(PocketGuestSession),
        );
        final old = state.session;
        await tester.pumpWidget(app('review-B-metadata.json'));
        for (var i = 0; i < 100 && !requestedB.isCompleted; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
        }
        expect(requestedB.isCompleted, isTrue, reason: 'B requested');
        final replacement = state.session;
        expect(identical(old, replacement), isFalse);
        gateA.complete();
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        });
        await tester.pump();
        var replacementDisposed = false;
        try {
          replacement.addListener(() {});
        } catch (_) {
          replacementDisposed = true;
        }
        expect(
          replacementDisposed,
          isFalse,
          reason: 'old initialize failure disposed the replacement session',
        );
        expect(
          state.startupError,
          isNull,
          reason:
              'old initialize failure polluted the replacement startup state',
        );

        // Allow B to complete and verify replacement session is ready and responds
        gateB.complete();
        await tester.runAsync(() async {
          for (var i = 0; i < 100 && !replacement.ready; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 10));
          }
        });
        expect(replacement.ready, isTrue);
        final status = await replacement.status();
        expect(status['activeBuild'], 1);
      } finally {
        if (!gateA.isCompleted) gateA.complete();
        if (!gateB.isCompleted) gateB.complete();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        });
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          null,
        );
        binding.defaultBinaryMessenger.setMockMessageHandler(
          'flutter/assets',
          null,
        );
        rootBundle.clear();
      }
    },
  );

  test(
    'Session user-initiated rollback through bridge and onReady health promotion',
    () async {
      final algorithm = Ed25519();
      final keyPair = await algorithm.newKeyPair();
      final publicKey = await keyPair.extractPublicKey();

      final storeDir = Directory(
        '${directory.path}/pocket-packages/external.rollback/default',
      );
      await storeDir.create(recursive: true);
      final store = PocketPackageStore(storeDir);

      final verifier = PocketManifestVerifier(
        trustedKeys: {'test-key': publicKey.bytes},
        appId: 'external.rollback',
        expectedRuntimeAbi: 'test-session-admission',
        requireBytecode: true,
      );

      Future<PocketSignedManifest> makeSigned({
        required int build,
        required String version,
        required List<int> entryBytes,
        required List<int> pakBytes,
      }) async {
        final entryHash = crypto.sha256.convert(entryBytes).toString();
        final pakHash = crypto.sha256.convert(pakBytes).toString();
        final payload = <String, dynamic>{
          'schemaVersion': 1,
          'appId': 'external.rollback',
          'capabilities': {
            'requires': ['updates.rollback'],
          },
          'version': version,
          'build': build,
          'protocol': 1,
          'minHostVersion': 1,
          'entry': <String, dynamic>{
            'sha256': entryHash,
            'size': entryBytes.length,
          },
          'entryFormat': 'bytecode',
          'runtimeAbi': 'test-session-admission',
          'pak': <String, dynamic>{
            'sha256': pakHash,
            'size': pakBytes.length,
            'parts': <Map<String, dynamic>>[
              <String, dynamic>{
                'offset': 0,
                'sha256': pakHash,
                'size': pakBytes.length,
              },
            ],
          },
          'files': <Map<String, dynamic>>[
            <String, dynamic>{
              'sha256': entryHash,
              'size': entryBytes.length,
              'url': 'blobs/$entryHash',
            },
            <String, dynamic>{
              'sha256': pakHash,
              'size': pakBytes.length,
              'url': 'blobs/$pakHash',
            },
          ],
        };
        final payloadBytes = Uint8List.fromList(
          utf8.encode(jsonEncode(payload)),
        );
        final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
        return PocketSignedManifest.fromBytes(
          Uint8List.fromList(
            utf8.encode(
              jsonEncode(<String, dynamic>{
                'keyId': 'test-key',
                'payload': base64Encode(payloadBytes),
                'signature': base64Encode(signature.bytes),
              }),
            ),
          ),
        );
      }

      Future<PocketPackage> stageAndCommit(
        PocketSignedManifest signed,
        List<int> entryBytes,
        List<int> pakBytes,
      ) async {
        final entryBlob = File(
          '${directory.path}/${signed.payload.build}-entry.blob',
        );
        await entryBlob.writeAsBytes(entryBytes);
        final pakBlob = File(
          '${directory.path}/${signed.payload.build}-pak.blob',
        );
        await pakBlob.writeAsBytes(pakBytes);
        final scoped = store.scoped('external.rollback');
        final pkg = await scoped.stage(
          signed: signed,
          verifier: verifier,
          entryBlob: entryBlob,
          blobs: {
            signed.payload.entry.sha256: entryBlob,
            signed.payload.pak.sha256: pakBlob,
          },
          cancellation: PocketCancellationToken(),
        );
        await scoped.commitHealthy(pkg, verifier: verifier);
        return pkg;
      }

      final signed1 = await makeSigned(
        build: 1,
        version: '1.0.1',
        entryBytes: [1, 1, 1],
        pakBytes: [1, 1, 2],
      );
      final pkg1 = await stageAndCommit(signed1, [1, 1, 1], [1, 1, 2]);

      final signed2 = await makeSigned(
        build: 2,
        version: '1.0.2',
        entryBytes: [2, 2, 2],
        pakBytes: [2, 2, 3],
      );
      final pkg2 = await stageAndCommit(signed2, [2, 2, 2], [2, 2, 3]);

      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        final content = name.endsWith('metadata.json')
            ? {
                'runtimeAbi': 'test-session-admission',
                'bytecodeBytes': 123,
                'build': 1,
                'version': '1.0.0',
              }
            : {
                'capabilities': {
                  'requires': <String>['updates.rollback'],
                },
              };
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });

      final session = PocketSession(
        config: PocketAppConfig(
          appId: 'external.rollback',
          metadataAsset: 'rollback/metadata.json',
          manifestAsset: 'rollback/manifest.json',
          updates: PocketUpdateConfig(
            url: 'http://127.0.0.1:39123/manifest.json',
            keyId: 'test-key',
            publicKey: base64Encode(publicKey.bytes),
          ),
        ),
      );

      try {
        await session.initialize();
        expect(session.ready, isTrue);
        expect(session.active?.version, '1.0.2');
        expect((await session.status())['activeVersion'], '1.0.2');

        // Let v2 complete initial ready check so session is not busy
        session.onReady(session.controller);
        await _waitForHealthy(session);
        expect((await session.status())['stage'], 'ready');

        // Invoke updates.rollback through session bridge
        session.onEvent(
          const PocketEvent(
            id: 'rollback-1',
            method: 'host.request',
            params: {
              'capability': 'updates.rollback',
              'params': <String, dynamic>{},
            },
          ),
        );

        // Wait 200ms for the 150ms _mountTimer
        await Future<void>.delayed(const Duration(milliseconds: 200));

        expect(session.active?.version, '1.0.1');

        // Trigger onReady and advance health timer (1 second)
        session.onReady(session.controller);
        await _waitForHealthy(session);

        // Assert session.active remains 1.0.1 (not rejected by anti-downgrade)
        expect(session.active?.version, '1.0.1');
        expect((await session.status())['activeVersion'], '1.0.1');
        expect(session.lastError, isNull);

        // Assert store state has v1 as active and lastGood
        final scopedStore = store.scoped('external.rollback');
        final activePkg = await scopedStore.active(verifier: verifier);
        expect(activePkg?.versionId, pkg1.versionId);
        final lastGoodPkg = await scopedStore.lastGood(verifier: verifier);
        expect(lastGoodPkg?.versionId, pkg1.versionId);

        final versions = await scopedStore.listVersions(verifier: verifier);
        final v1Info = versions.firstWhere(
          (v) => v.versionId == pkg1.versionId,
        );
        expect(v1Info.isActive, isTrue);
        expect(v1Info.isLastGood, isTrue);
        expect(v1Info.isPrevious, isFalse);

        final v2Info = versions.firstWhere(
          (v) => v.versionId == pkg2.versionId,
        );
        expect(v2Info.isActive, isFalse);
        expect(v2Info.isLastGood, isFalse);
        expect(v2Info.isPrevious, isTrue);
      } finally {
        await session.close();
      }
    },
  );
}
