import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as path;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test('large ZIP and 7z bundles leave the caller isolate responsive', () async {
    final tempDir = await Directory.systemTemp.createTemp('pocket-bundle-worker-heartbeat-');
    try {
      for (final format in <String>['zip', '7z']) {
        final blobBytes = _largeDeterministicBytes(12 * 1024 * 1024);
        final blobSha256 = _sha256(blobBytes);
        final archiveBytes = format == 'zip'
            ? encodePocketZip(<String, List<int>>{'blobs/$blobSha256': blobBytes})
            : encodePocket7z(<String, List<int>>{'blobs/$blobSha256': blobBytes});
        final archiveFile = File(path.join(tempDir.path, '$format.archive'));
        await archiveFile.writeAsBytes(archiveBytes, flush: true);
        final store = PocketPackageStore(Directory(path.join(tempDir.path, format)));
        var receivedArchive = false;
        var heartbeatsDuringProcessing = 0;
        var lastHeartbeatMilliseconds = 0;
        var largestHeartbeatGapMilliseconds = 0;
        var processingStartedMilliseconds = 0;
        Timer? heartbeat;
        final stopwatch = Stopwatch()..start();

        final result = await store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: format,
            sha256: _sha256(archiveBytes),
            size: archiveBytes.length,
            url: 'bundle.$format',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: blobSha256,
              size: blobBytes.length,
              url: 'blobs/$blobSha256',
            ),
          ],
          bytes: archiveFile.openRead(),
          cancellation: PocketCancellationToken(),
          onBytes: (received) {
            if (received == archiveBytes.length && !receivedArchive) {
              receivedArchive = true;
              // Start measuring after the last network/file chunk was read.
              // The real decoder and per-entry hash now run in the worker.
              processingStartedMilliseconds = stopwatch.elapsedMilliseconds;
              lastHeartbeatMilliseconds = processingStartedMilliseconds;
              heartbeat = Timer.periodic(const Duration(milliseconds: 1), (_) {
                final now = stopwatch.elapsedMilliseconds;
                final gap = now - lastHeartbeatMilliseconds;
                if (gap > largestHeartbeatGapMilliseconds) {
                  largestHeartbeatGapMilliseconds = gap;
                }
                lastHeartbeatMilliseconds = now;
                heartbeatsDuringProcessing++;
              });
            }
          },
        );
        final processingMilliseconds = stopwatch.elapsedMilliseconds - processingStartedMilliseconds;
        final finalGap = stopwatch.elapsedMilliseconds - lastHeartbeatMilliseconds;
        if (finalGap > largestHeartbeatGapMilliseconds) largestHeartbeatGapMilliseconds = finalGap;
        stopwatch.stop();
        heartbeat?.cancel();

        expect(receivedArchive, isTrue, reason: format);
        expect(
          heartbeatsDuringProcessing,
          greaterThanOrEqualTo(10),
          reason: '$format decode must keep yielding to the caller isolate',
        );
        expect(processingMilliseconds, greaterThanOrEqualTo(20), reason: format);
        expect(
          largestHeartbeatGapMilliseconds,
          lessThan(processingMilliseconds ~/ 2),
          reason: '$format decode must not block the caller isolate',
        );
        expect(stopwatch.elapsed, greaterThan(const Duration(milliseconds: 5)));
        expect(result[blobSha256]?.lengthSync(), blobBytes.length);
        expect(await _fileSha256(result[blobSha256]!), blobSha256);
      }
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  test('cancelling a bundle worker leaves no cached blob or package pointer', () async {
    final tempDir = await Directory.systemTemp.createTemp('pocket-bundle-worker-cancel-');
    try {
      final blobBytes = _largeDeterministicBytes(32 * 1024 * 1024);
      final blobSha256 = _sha256(blobBytes);
      final archiveBytes = encodePocket7z(<String, List<int>>{'blobs/$blobSha256': blobBytes});
      final archiveFile = File(path.join(tempDir.path, 'cancel.7z'));
      await archiveFile.writeAsBytes(archiveBytes, flush: true);
      final store = PocketPackageStore(tempDir);
      final cancellation = PocketCancellationToken();
      Timer? cancelWorker;
      Timer? cancellationHeartbeat;
      var receivedArchive = false;
      var heartbeatsBeforeCancellation = 0;

      await expectLater(
        store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: '7z',
            sha256: _sha256(archiveBytes),
            size: archiveBytes.length,
            url: 'bundle.7z',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: blobSha256,
              size: blobBytes.length,
              url: 'blobs/$blobSha256',
            ),
          ],
          bytes: archiveFile.openRead(),
          cancellation: cancellation,
          onBytes: (received) {
            if (received == archiveBytes.length && !receivedArchive) {
              receivedArchive = true;
              cancellationHeartbeat = Timer.periodic(
                const Duration(milliseconds: 1),
                (_) => heartbeatsBeforeCancellation++,
              );
            }
            if (receivedArchive && cancelWorker == null) {
              // Give the spawned decoder time to start on this real 32 MiB
              // archive, then cancel while its pure-Dart work is in flight.
              cancelWorker = Timer(const Duration(milliseconds: 100), cancellation.cancel);
            }
          },
        ),
        throwsA(isA<PocketUpdateCancellation>()),
      );
      cancelWorker?.cancel();
      cancellationHeartbeat?.cancel();

      expect(receivedArchive, isTrue);
      expect(heartbeatsBeforeCancellation, greaterThanOrEqualTo(10));
      expect(await File(path.join(tempDir.path, 'blobs', blobSha256)).exists(), isFalse);
      expect(await File(path.join(tempDir.path, 'active')).exists(), isFalse);
      expect(await File(path.join(tempDir.path, 'previous')).exists(), isFalse);
      expect(await File(path.join(tempDir.path, 'lastGood')).exists(), isFalse);
      final blobs = Directory(path.join(tempDir.path, 'blobs'));
      expect(
        (await blobs.list().toList()).where(
          (entry) => path.basename(entry.path).startsWith('.bundle'),
        ),
        isEmpty,
      );
      expect((await Directory(path.join(tempDir.path, 'versions')).list().toList()), isEmpty);
    } finally {
      await tempDir.delete(recursive: true);
    }
  });

  group('PocketPackageUpdate', () {
    late Directory tempDir;
    late SimpleKeyPair keyPair;
    late SimplePublicKey publicKey;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('pocket-update-test-');
      final algorithm = Ed25519();
      keyPair = await algorithm.newKeyPair();
      publicKey = await keyPair.extractPublicKey();
    });

    tearDown(() async {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    });

    Future<PocketSignedManifest> makeSignedManifest({
      required int build,
      required String version,
      required List<int> entryBytes,
      required List<int> pakBytes,
    }) async {
      final algorithm = Ed25519();
      final entryHash = _sha256(entryBytes);
      final pakHash = _sha256(pakBytes);
      final payload = <String, dynamic>{
        'schemaVersion': 1,
        'appId': 'test.app',
        'version': version,
        'build': build,
        'protocol': 1,
        'minHostVersion': 1,
        'entry': <String, dynamic>{
          'sha256': entryHash,
          'size': entryBytes.length,
        },
        'entryFormat': 'bytecode',
        'runtimeAbi': 'abi-v1',
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
      final payloadBytes = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
      final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
      return PocketSignedManifest.fromBytes(
        _envelopeBytes(
          keyId: 'test-key',
          payloadBytes: payloadBytes,
          signatureBytes: signature.bytes,
        ),
      );
    }

    test(
      'fixed package index advances without replacing the coordinator',
      () async {
        final source = Uri.parse(
          'http://127.0.0.1:39123/test/pocket/1.0.0/test.app/latest.json',
        );
        final transport = _MemoryTransport(<String, List<int>>{});
        final coordinator = PocketUpdateCoordinator(
          manifestUri: source,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: PocketPackageStore(tempDir),
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );
        final records = <Map<String, Object?>>[];
        Future<void> publish(int build) async {
          final entry = <int>[1, 2, build];
          final pak = <int>[4, 5, build];
          final signed = await makeSignedManifest(
            build: build,
            version: '1.0.$build',
            entryBytes: entry,
            pakBytes: pak,
          );
          // The actual manifest lives at a different depth from the fixed index.
          final manifest = source.resolve('releases/$build/latest.json');
          transport.responses[manifest.toString()] = signed.envelopeBytes;
          transport.responses[manifest
                  .resolve('blobs/${_sha256(entry)}')
                  .toString()] =
              entry;
          transport.responses[manifest
                  .resolve('blobs/${_sha256(pak)}')
                  .toString()] =
              pak;
          records.insert(0, <String, Object?>{
            'id': 'test.app',
            'version': '1.0.$build',
            'build': build,
            'manifestUrl': 'releases/$build/latest.json',
            'payloadSha256': _sha256(signed.payloadBytes),
          });
          transport.responses[source.toString()] = utf8.encode(
            jsonEncode({
              'schemaVersion': 1,
              'kind': 'pocket-editor-package-index',
              'packageId': 'test.app',
              'latest': records.first,
              'versions': records,
            }),
          );
        }

        await publish(1);
        final first = await coordinator.prepare();
        expect(first.package.manifest.payload.build, 1);
        await coordinator.commitHealthy(first);
        await publish(2);
        final second = await coordinator.prepare();
        expect(second.package.manifest.payload.build, 2);
        await coordinator.commitHealthy(second);
        // The catalog cannot turn an older signed package into an allowed rollback.
        transport.responses[source.toString()] = utf8.encode(
          jsonEncode({
            'schemaVersion': 1,
            'kind': 'pocket-editor-package-index',
            'packageId': 'test.app',
            'latest': records.last,
            'versions': records,
          }),
        );
        await expectLater(
          coordinator.prepare(),
          throwsA(isA<PocketPackageFormatException>()),
        );
        expect(
          (await coordinator.store
                  .scoped('test.app')
                  .active(verifier: coordinator.verifier))!
              .manifest
              .payload
              .build,
          2,
        );
      },
    );

    test(
      'package index rejects escaped and inconsistent manifest pointers',
      () async {
        final source = Uri.parse(
          'http://127.0.0.1:39123/test/pocket/1/test.app/latest.json',
        );
        final transport = _MemoryTransport(<String, List<int>>{});
        final coordinator = PocketUpdateCoordinator(
          manifestUri: source,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: PocketPackageStore(tempDir),
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );
        void point(String manifestUrl) {
          transport.responses[source.toString()] = utf8.encode(
            jsonEncode({
              'schemaVersion': 1,
              'kind': 'pocket-editor-package-index',
              'packageId': 'test.app',
              'latest': {
                'id': 'test.app',
                'version': '1.0.99',
                'build': 99,
                'manifestUrl': manifestUrl,
              },
            }),
          );
        }

        point('http://other.test/latest.json');
        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'manifest-url',
            ),
          ),
        );
        final signed = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: [1],
          pakBytes: [2],
        );
        transport.responses[source
                .resolve('releases/1/latest.json')
                .toString()] =
            signed.envelopeBytes;
        point('releases/1/latest.json');
        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'manifest-index',
            ),
          ),
        );
        expect(
          await coordinator.store
              .scoped('test.app')
              .active(verifier: coordinator.verifier),
          isNull,
        );
      },
    );

    test(
      '1. Downgrade rejection: build 2 active -> build 1 manifest rejected with PocketPackageFormatException',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry2 = <int>[1, 2, 3];
        final pak2 = <int>[4, 5, 6];
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry2,
          pakBytes: pak2,
        );

        final entry1 = <int>[7, 8, 9];
        final pak1 = <int>[10, 11, 12];
        final signed1 = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: entry1,
          pakBytes: pak1,
        );

        // Populate transport with build 2 files
        final hashEntry2 = _sha256(entry2);
        final hashPak2 = _sha256(pak2);
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry2').toString()] =
            entry2;
        transport.responses[manifestUri.resolve('blobs/$hashPak2').toString()] =
            pak2;

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        // Prepare and commit build 2
        final prepared2 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared2);

        // Now update transport to serve build 1
        final hashEntry1 = _sha256(entry1);
        final hashPak1 = _sha256(pak1);
        transport.responses[manifestUri.toString()] = signed1.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry1').toString()] =
            entry1;
        transport.responses[manifestUri.resolve('blobs/$hashPak1').toString()] =
            pak1;

        // Attempting to prepare build 1 must throw PocketPackageFormatException
        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay: package build 1 is not newer than current build 2'),
            ),
          ),
        );
      },
    );

    test(
      '2. Concurrent Future.wait([store.prepare(pkg), store.prepare(pkg)]) succeeds without PathNotFoundException',
      () async {
        final store = PocketPackageStore(tempDir).scoped('test.app');
        final entryBytes = <int>[100, 101, 102];
        final pakBytes = <int>[103, 104, 105];
        final signed = await makeSignedManifest(
          build: 1,
          version: '1.0.0',
          entryBytes: entryBytes,
          pakBytes: pakBytes,
        );

        final entryBlob = File('${tempDir.path}/entry.blob');
        await entryBlob.writeAsBytes(entryBytes);
        final pakBlob = File('${tempDir.path}/pak.blob');
        await pakBlob.writeAsBytes(pakBytes);

        final verifier = PocketManifestVerifier(
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          appId: 'test.app',
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        final cancellation = PocketCancellationToken();
        final blobs = <String, File>{
          _sha256(entryBytes): entryBlob,
          _sha256(pakBytes): pakBlob,
        };

        // Prepare the package once to create a package object
        final initialPkg = await store.stage(
          signed: signed,
          verifier: verifier,
          entryBlob: entryBlob,
          blobs: blobs,
          cancellation: cancellation,
        );

        // Run concurrent prepare calls 10 times to verify lock serialization
        for (var i = 0; i < 10; i++) {
          final results = await Future.wait([
            store.prepare(initialPkg),
            store.prepare(initialPkg),
          ]);
          expect(results[0].versionId, initialPkg.versionId);
          expect(results[1].versionId, initialPkg.versionId);
        }
      },
    );

    test(
      '3. Auto-fallback from promoted v2 back to v1 followed by commitHealthy(v1): rollback does NOT return v2',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry1 = <int>[1, 1, 1];
        final pak1 = <int>[1, 1, 2];
        final signed1 = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: entry1,
          pakBytes: pak1,
        );

        final entry2 = <int>[2, 2, 2];
        final pak2 = <int>[2, 2, 3];
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry2,
          pakBytes: pak2,
        );

        // Register v1 in transport and commit healthy
        final hashEntry1 = _sha256(entry1);
        final hashPak1 = _sha256(pak1);
        transport.responses[manifestUri.toString()] = signed1.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry1').toString()] =
            entry1;
        transport.responses[manifestUri.resolve('blobs/$hashPak1').toString()] =
            pak1;

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        final prepared1 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared1);

        // Verify v1 is active and lastGood
        var active = await coordinator.lastGood();
        expect(active?.version, '1.0.1');

        // Now upgrade to v2
        final hashEntry2 = _sha256(entry2);
        final hashPak2 = _sha256(pak2);
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry2').toString()] =
            entry2;
        transport.responses[manifestUri.resolve('blobs/$hashPak2').toString()] =
            pak2;

        final prepared2 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared2);

        active = await coordinator.lastGood();
        expect(active?.version, '1.0.2');

        // v2 encounters a runtime failure; trigger fallbackFor(prepared2)
        final fallback = await coordinator.fallbackFor(prepared2);
        expect(fallback, isNotNull);
        expect(fallback!.version, '1.0.1');

        // 1 second later healthy check passes for fallback v1
        await coordinator.commitHealthy(fallback);

        // Now call rollback: it must NOT return v2!
        try {
          await coordinator.rollback();
          final afterRollback = await coordinator.lastGood();
          expect(afterRollback?.version, isNot('1.0.2'));
        } on PocketPackageException catch (e) {
          // If there is no previous rollback target, it throws rollback-missing which is also safe
          expect(e.code, 'rollback-missing');
        }

        final scoped = store.scoped('test.app');
        final currentActive = await scoped.active(verifier: coordinator.verifier);
        expect(currentActive?.manifest.payload.version, isNot('1.0.2'));
      },
    );

    test('4. _readPointerId rejecting ".."', () async {
      final store = PocketPackageStore(tempDir).scoped('test.app');
      await store.initialize();

      // Write '..' to active pointer file
      final activeFile = File('${tempDir.path}/apps/test.app/active');
      await activeFile.parent.create(recursive: true);
      await activeFile.writeAsString('..\n');

      // readPointerId must reject '..' and return null
      final readId = await store.readPointerId('active');
      expect(readId, isNull);

      // _readPointer must return null without directory traversal
      final verifier = PocketManifestVerifier(
        trustedKeys: const {},
        appId: 'test.app',
      );
      final activePkg = await store.active(verifier: verifier);
      expect(activePkg, isNull);

      // Also test '.'
      await activeFile.writeAsString('.\n');
      expect(await store.readPointerId('active'), isNull);

      // Also test path with slashes
      await activeFile.writeAsString('foo/bar\n');
      expect(await store.readPointerId('active'), isNull);
    });

    test(
      '5. lastGood=1, active=3: coordinator.prepare() rejects build=2 and build=3 (different versionId)',
      () async {
        final store = PocketPackageStore(tempDir);
        final scoped = store.scoped('test.app');
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry1 = <int>[1, 1, 1];
        final pak1 = <int>[1, 1, 2];
        final signed1 = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: entry1,
          pakBytes: pak1,
        );

        final entry3 = <int>[3, 3, 3];
        final pak3 = <int>[3, 3, 4];
        final signed3 = await makeSignedManifest(
          build: 3,
          version: '1.0.3',
          entryBytes: entry3,
          pakBytes: pak3,
        );

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        // Prepare and commit build 1 so lastGood=1, active=1
        final hashEntry1 = _sha256(entry1);
        final hashPak1 = _sha256(pak1);
        transport.responses[manifestUri.toString()] = signed1.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry1').toString()] =
            entry1;
        transport.responses[manifestUri.resolve('blobs/$hashPak1').toString()] =
            pak1;

        final prepared1 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared1);

        // Prepare build 3 and activate directly so active=3, lastGood remains 1
        final hashEntry3 = _sha256(entry3);
        final hashPak3 = _sha256(pak3);
        transport.responses[manifestUri.toString()] = signed3.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry3').toString()] =
            entry3;
        transport.responses[manifestUri.resolve('blobs/$hashPak3').toString()] =
            pak3;

        final prepared3 = await coordinator.prepare();
        await scoped.activate(prepared3.package, verifier: coordinator.verifier);

        final good = await scoped.lastGood(verifier: coordinator.verifier);
        final act = await scoped.active(verifier: coordinator.verifier);
        expect(good?.manifest.payload.build, 1);
        expect(act?.manifest.payload.build, 3);

        // Candidate with build=2 must be rejected
        final entry2 = <int>[2, 2, 2];
        final pak2 = <int>[2, 2, 3];
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry2,
          pakBytes: pak2,
        );
        final hashEntry2 = _sha256(entry2);
        final hashPak2 = _sha256(pak2);
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry2').toString()] =
            entry2;
        transport.responses[manifestUri.resolve('blobs/$hashPak2').toString()] =
            pak2;

        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay: package build 2 is not newer than current build 3'),
            ),
          ),
        );

        // Candidate with build=3 but different versionId
        final entry3Alt = <int>[3, 3, 3, 99];
        final pak3Alt = <int>[3, 3, 4, 99];
        final signed3Alt = await makeSignedManifest(
          build: 3,
          version: '1.0.3-alt',
          entryBytes: entry3Alt,
          pakBytes: pak3Alt,
        );
        final hashEntry3Alt = _sha256(entry3Alt);
        final hashPak3Alt = _sha256(pak3Alt);
        transport.responses[manifestUri.toString()] = signed3Alt.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry3Alt').toString()] =
            entry3Alt;
        transport.responses[manifestUri.resolve('blobs/$hashPak3Alt').toString()] =
            pak3Alt;

        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay: package build 3 is not newer than current build 3'),
            ),
          ),
        );
      },
    );

    test(
      '6. minimumBuild=10 on an empty store: coordinator.prepare() rejects build=10',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry10 = <int>[10, 10, 10];
        final pak10 = <int>[10, 10, 11];
        final signed10 = await makeSignedManifest(
          build: 10,
          version: '1.0.10',
          entryBytes: entry10,
          pakBytes: pak10,
        );

        final hashEntry10 = _sha256(entry10);
        final hashPak10 = _sha256(pak10);
        transport.responses[manifestUri.toString()] = signed10.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry10').toString()] =
            entry10;
        transport.responses[manifestUri.resolve('blobs/$hashPak10').toString()] =
            pak10;

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
          minimumBuild: 10,
        );

        await expectLater(
          coordinator.prepare(),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay: package build 10 is not newer than current build 10'),
            ),
          ),
        );
      },
    );

    test(
      '7. Out-of-order commit of prepared candidates rejects older candidate and preserves lastGood',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry2 = <int>[2, 2, 2];
        final pak2 = <int>[2, 2, 3];
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry2,
          pakBytes: pak2,
        );

        final entry3 = <int>[3, 3, 3];
        final pak3 = <int>[3, 3, 4];
        final signed3 = await makeSignedManifest(
          build: 3,
          version: '1.0.3',
          entryBytes: entry3,
          pakBytes: pak3,
        );

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        // Serve build 2 and prepare
        final hashEntry2 = _sha256(entry2);
        final hashPak2 = _sha256(pak2);
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry2').toString()] =
            entry2;
        transport.responses[manifestUri.resolve('blobs/$hashPak2').toString()] =
            pak2;

        final prepared2 = await coordinator.prepare();

        // Serve build 3 and prepare
        final hashEntry3 = _sha256(entry3);
        final hashPak3 = _sha256(pak3);
        transport.responses[manifestUri.toString()] = signed3.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry3').toString()] =
            entry3;
        transport.responses[manifestUri.resolve('blobs/$hashPak3').toString()] =
            pak3;

        final prepared3 = await coordinator.prepare();

        // Commit healthy build 3 first
        await coordinator.commitHealthy(prepared3);
        var active = await coordinator.lastGood();
        expect(active?.build, 3);

        // Now attempt out-of-order commit of prepared build 2
        await expectLater(
          coordinator.commitHealthy(prepared2),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay: package build 2 is not newer than current build 3'),
            ),
          ),
        );

        // Verify lastGood remains build 3
        active = await coordinator.lastGood();
        expect(active?.build, 3);
      },
    );

    test(
      '8. store.fallbackFor("../sentinel-outside-versions") throws unsafe-token and preserves sentinel directory',
      () async {
        final store = PocketPackageStore(tempDir).scoped('test.app');
        await store.initialize();

        // Create sentinel directory outside versions
        final sentinelDir = Directory(
          path.join(tempDir.path, 'apps', 'test.app', 'sentinel-outside-versions'),
        );
        await sentinelDir.create(recursive: true);
        final sentinelFile = File(path.join(sentinelDir.path, 'data.txt'));
        await sentinelFile.writeAsString('safe-data');

        final verifier = PocketManifestVerifier(
          trustedKeys: const {},
          appId: 'test.app',
        );

        await expectLater(
          store.fallbackFor(
            '../sentinel-outside-versions',
            verifier: verifier,
          ),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'unsafe-token',
            ),
          ),
        );

        // Verify directory and file were not deleted
        expect(await sentinelDir.exists(), isTrue);
        expect(await sentinelFile.exists(), isTrue);
        expect(await sentinelFile.readAsString(), 'safe-data');
      },
    );

    test(
      '9. store.readPointerId("../outside") throws unsafe-token',
      () async {
        final store = PocketPackageStore(tempDir).scoped('test.app');
        await store.initialize();

        await expectLater(
          store.readPointerId('../outside'),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'unsafe-token',
            ),
          ),
        );

        await expectLater(
          store.readPointerId('unknownPointer'),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'unsafe-token',
            ),
          ),
        );
      },
    );

    test(
      '10. Session rollback promotion path: commitHealthy(isRollback: true) and coordinator.rollback() promote previous to active and lastGood',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry1 = <int>[1, 1, 1];
        final pak1 = <int>[1, 1, 2];
        final signed1 = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: entry1,
          pakBytes: pak1,
        );

        final entry2 = <int>[2, 2, 2];
        final pak2 = <int>[2, 2, 3];
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry2,
          pakBytes: pak2,
        );

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        // Install & commit v1
        final hashEntry1 = _sha256(entry1);
        final hashPak1 = _sha256(pak1);
        transport.responses[manifestUri.toString()] = signed1.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry1').toString()] =
            entry1;
        transport.responses[manifestUri.resolve('blobs/$hashPak1').toString()] =
            pak1;

        final prepared1 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared1);

        // Install & commit v2
        final hashEntry2 = _sha256(entry2);
        final hashPak2 = _sha256(pak2);
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        transport.responses[manifestUri.resolve('blobs/$hashEntry2').toString()] =
            entry2;
        transport.responses[manifestUri.resolve('blobs/$hashPak2').toString()] =
            pak2;

        final prepared2 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared2);

        final current = await coordinator.lastGood();
        expect(current?.version, '1.0.2');

        final versions = await coordinator.listVersions();
        final previous = versions.firstWhere((v) => v.isPrevious);
        expect(previous.version, '1.0.1');

        // Normal commitHealthy without isRollback throws downgrade rejection
        final nonRollbackCandidate = PocketPreparedPackage(
          package: previous.package,
          needsActivation: true,
        );
        await expectLater(
          coordinator.commitHealthy(nonRollbackCandidate),
          throwsA(
            isA<PocketPackageFormatException>().having(
              (e) => e.message,
              'message',
              contains('Refusing downgrade or replay'),
            ),
          ),
        );

        // Rollback candidate with isRollback: true succeeds
        final rollbackCandidate = PocketPreparedPackage(
          package: previous.package,
          needsActivation: true,
          isRollback: true,
        );
        await coordinator.commitHealthy(rollbackCandidate);

        final afterRollback = await coordinator.lastGood();
        expect(afterRollback?.version, '1.0.1');
        expect(afterRollback?.build, 1);

        final versionsAfter = await coordinator.listVersions();
        final v1Info = versionsAfter.firstWhere((v) => v.versionId == previous.versionId);
        expect(v1Info.isActive, isTrue);
        expect(v1Info.isLastGood, isTrue);
        expect(v1Info.isPrevious, isFalse);

        final v2Info = versionsAfter.firstWhere((v) => v.version == '1.0.2');
        expect(v2Info.isActive, isFalse);
        expect(v2Info.isLastGood, isFalse);
        expect(v2Info.isPrevious, isTrue);

        // Also test coordinator.rollback(versionId: v2Info.versionId) back to v2 succeeds
        await coordinator.rollback(versionId: v2Info.versionId);
        final afterSecondRollback = await coordinator.lastGood();
        expect(afterSecondRollback?.version, '1.0.2');
      },
    );

    test(
      '11. Dual update modes: fresh install uses one-shot bundle.zip; already-downloaded mini-app updates only code or a single resource file',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        Future<({PocketSignedManifest signed, Uint8List zipBytes})>
        buildMultiPartRelease({
          required int build,
          required String version,
          required List<int> entryBytes,
          required List<int> alphaBytes,
          required List<int> betaBytes,
          required List<int> videoBytes,
          required List<int> posterBytes,
          int alphaDtype = 0,
          int betaDtype = 0,
          Map<String, dynamic>? worker,
          List<String> requiredCaps = const <String>[],
        }) async {
          final algorithm = Ed25519();
          final pakBytes = encodePocketPak(<PocketPakBlobEntry>[
            PocketPakBlobEntry(
              key: 'ui:img.alpha',
              data: alphaBytes,
              dtype: alphaDtype,
            ),
            PocketPakBlobEntry(
              key: 'ui:img.beta',
              data: betaBytes,
              dtype: betaDtype,
            ),
          ]);
          final pakView = ByteData.sublistView(pakBytes);
          final dirOffset = pakView.getUint32(12, Endian.little);
          final alphaOffset = pakView.getUint32(dirOffset + 4, Endian.little);
          final betaOffset = pakView.getUint32(
            dirOffset + 24 + 4,
            Endian.little,
          );
          final pakHeaderBytes = Uint8List.sublistView(
            pakBytes,
            0,
            alphaOffset,
          );
          final midMetaOffset = alphaOffset + alphaBytes.length;
          final midMetaBytes = Uint8List.sublistView(
            pakBytes,
            midMetaOffset,
            betaOffset,
          );
          final tailMetaOffset = betaOffset + betaBytes.length;
          final tailMetaBytes = Uint8List.sublistView(
            pakBytes,
            tailMetaOffset,
            pakBytes.length,
          );

          final entryHash = _sha256(entryBytes);
          final headerHash = _sha256(pakHeaderBytes);
          final alphaHash = _sha256(alphaBytes);
          final betaHash = _sha256(betaBytes);
          final videoHash = _sha256(videoBytes);
          final posterHash = _sha256(posterBytes);
          final pakHash = _sha256(pakBytes);

          final blobEntries = <String, List<int>>{
            'blobs/$entryHash': entryBytes,
            'blobs/$headerHash': pakHeaderBytes,
            'blobs/$alphaHash': alphaBytes,
            if (midMetaBytes.isNotEmpty)
              'blobs/${_sha256(midMetaBytes)}': midMetaBytes,
            'blobs/$betaHash': betaBytes,
            if (tailMetaBytes.isNotEmpty)
              'blobs/${_sha256(tailMetaBytes)}': tailMetaBytes,
            'blobs/$videoHash': videoBytes,
            'blobs/$posterHash': posterBytes,
          };
          final zipBytes = encodePocket7z(blobEntries);
          final zipHash = _sha256(zipBytes);

          final files = blobEntries.entries
              .map(
                (e) => <String, dynamic>{
                  'sha256': e.key.substring('blobs/'.length),
                  'size': e.value.length,
                  'url': e.key,
                },
              )
              .toList()
            ..sort(
              (a, b) => (a['sha256'] as String).compareTo(b['sha256'] as String),
            );

          final payload = <String, dynamic>{
            'schemaVersion': 1,
            'appId': 'test.app',
            'version': version,
            'build': build,
            'protocol': 1,
            'minHostVersion': 1,
            if (requiredCaps.isNotEmpty)
              'capabilities': <String, dynamic>{'requires': requiredCaps},
            'entry': <String, dynamic>{
              'sha256': entryHash,
              'size': entryBytes.length,
            },
            'entryFormat': 'bytecode',
            'runtimeAbi': 'abi-v1',
            'pak': <String, dynamic>{
              'sha256': pakHash,
              'size': pakBytes.length,
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{
                  'offset': 0,
                  'sha256': headerHash,
                  'size': pakHeaderBytes.length,
                  'kind': 'metadata',
                },
                <String, dynamic>{
                  'offset': alphaOffset,
                  'sha256': alphaHash,
                  'size': alphaBytes.length,
                  'kind': 'blob',
                  'key': 'ui:img.alpha',
                  'dtype': alphaDtype,
                },
                if (midMetaBytes.isNotEmpty)
                  <String, dynamic>{
                    'offset': midMetaOffset,
                    'sha256': _sha256(midMetaBytes),
                    'size': midMetaBytes.length,
                    'kind': 'metadata',
                  },
                <String, dynamic>{
                  'offset': betaOffset,
                  'sha256': betaHash,
                  'size': betaBytes.length,
                  'kind': 'blob',
                  'key': 'ui:img.beta',
                  'dtype': betaDtype,
                },
                if (tailMetaBytes.isNotEmpty)
                  <String, dynamic>{
                    'offset': tailMetaOffset,
                    'sha256': _sha256(tailMetaBytes),
                    'size': tailMetaBytes.length,
                    'kind': 'metadata',
                  },
              ],
            },
            'files': files,
            'bundle': <String, dynamic>{
              'format': '7z',
              'sha256': zipHash,
              'size': zipBytes.length,
              'url': 'bundle.7z',
            },
            'assets': <String, dynamic>{
              'assets/images/poster.png': <String, dynamic>{
                'sha256': posterHash,
                'size': posterBytes.length,
              },
              'assets/video.mp4': <String, dynamic>{
                'sha256': videoHash,
                'size': videoBytes.length,
              },
            },
            if (worker != null) 'worker': worker,
          };
          final payloadBytes = Uint8List.fromList(
            utf8.encode(jsonEncode(payload)),
          );
          final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
          final signed = PocketSignedManifest.fromBytes(
            _envelopeBytes(
              keyId: 'test-key',
              payloadBytes: payloadBytes,
              signatureBytes: signature.bytes,
            ),
          );
          return (signed: signed, zipBytes: zipBytes);
        }

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        final v1Entry = <int>[10, 11, 12, 13];
        final v1Alpha = <int>[1, 2, 3, 4, 5, 6, 7, 8];
        final v1Beta = <int>[10, 20, 30, 40, 50, 60, 70, 80];
        final v1Video = <int>[100, 101, 102, 103];
        final v1Poster = <int>[200, 201, 202];

        // --- Phase 1: Fresh install via one-shot bundle.7z ---
        // Notice we ONLY populate latest.json and bundle.7z in transport (no individual blobs/*)
        final v1Release = await buildMultiPartRelease(
          build: 1,
          version: '1.0.0',
          entryBytes: v1Entry,
          alphaBytes: v1Alpha,
          betaBytes: v1Beta,
          videoBytes: v1Video,
          posterBytes: v1Poster,
        );
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v1Release.signed.envelopeBytes
          ..[manifestUri.resolve('bundle.7z').toString()] = v1Release.zipBytes;
        transport.requestedUris.clear();

        final preparedV1 = await coordinator.prepare();
        expect(preparedV1.deliveryMode, PocketUpdateMode.zip);
        expect(preparedV1.downloadedFiles, 1);
        expect(preparedV1.downloadedBytes, v1Release.zipBytes.length);
        expect(transport.requestedUris, <String>[
          manifestUri.toString(),
          manifestUri.resolve('bundle.7z').toString(),
        ]);
        await coordinator.commitHealthy(preparedV1);

        // --- Phase 2: Code-only update on already-downloaded mini-app ---
        final v2Entry = <int>[99, 98, 97, 96, 95];
        final v2Release = await buildMultiPartRelease(
          build: 2,
          version: '1.0.1',
          entryBytes: v2Entry,
          alphaBytes: v1Alpha,
          betaBytes: v1Beta,
          videoBytes: v1Video,
          posterBytes: v1Poster,
        );
        final v2EntryHash = _sha256(v2Entry);
        // Only serve the 1 changed code blob (no bundle.zip, no unchanged resource blobs)
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v2Release.signed.envelopeBytes
          ..[manifestUri.resolve('blobs/$v2EntryHash').toString()] = v2Entry;
        transport.requestedUris.clear();

        final progressV2 = <PocketUpdateProgress>[];
        final preparedV2 = await coordinator.prepare(
          target: const PocketUpdateTarget.codeOnly(),
          onProgress: progressV2.add,
        );
        expect(preparedV2.deliveryMode, PocketUpdateMode.granular);
        expect(preparedV2.downloadedFiles, 1);
        expect(
          preparedV2.reusedFiles,
          v2Release.signed.payload.files.length - 1,
        );
        expect(preparedV2.downloadedBytes, v2Entry.length);
        expect(preparedV2.updatedComponents, <String>['code']);
        final dlProgress = progressV2
            .where((p) => p.stage == PocketUpdateStage.downloading)
            .toList();
        expect(dlProgress, isNotEmpty);
        expect(
          dlProgress.every((p) => p.totalBytes == v2Entry.length),
          isTrue,
        );
        expect(dlProgress.last.downloadedBytes, v2Entry.length);
        expect(transport.requestedUris, <String>[
          manifestUri.toString(),
          manifestUri.resolve('blobs/$v2EntryHash').toString(),
        ]);
        await coordinator.commitHealthy(preparedV2);

        // --- Phase 3: Single PAK resource update ("ui:img.beta") ---
        final v3Beta = <int>[88, 77, 66, 55, 44, 33, 22, 11];
        final v3Release = await buildMultiPartRelease(
          build: 3,
          version: '1.0.2',
          entryBytes: v2Entry,
          alphaBytes: v1Alpha,
          betaBytes: v3Beta,
          videoBytes: v1Video,
          posterBytes: v1Poster,
        );
        final v3BetaHash = _sha256(v3Beta);
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v3Release.signed.envelopeBytes
          ..[manifestUri.resolve('blobs/$v3BetaHash').toString()] = v3Beta;
        transport.requestedUris.clear();

        final preparedV3 = await coordinator.prepare(
          target: PocketUpdateTarget.singleResource('ui:img.beta'),
        );
        expect(preparedV3.deliveryMode, PocketUpdateMode.granular);
        expect(preparedV3.downloadedFiles, 1);
        expect(
          preparedV3.reusedFiles,
          v3Release.signed.payload.files.length - 1,
        );
        expect(preparedV3.downloadedBytes, v3Beta.length);
        expect(preparedV3.updatedComponents, <String>['pak:ui:img.beta']);
        expect(transport.requestedUris, <String>[
          manifestUri.toString(),
          manifestUri.resolve('blobs/$v3BetaHash').toString(),
        ]);
        await coordinator.commitHealthy(preparedV3);

        // --- Phase 4: Single loose asset update ("assets/images/poster.png") ---
        final v4Poster = <int>[42, 43, 44, 45, 46];
        final v4Release = await buildMultiPartRelease(
          build: 4,
          version: '1.0.3',
          entryBytes: v2Entry,
          alphaBytes: v1Alpha,
          betaBytes: v3Beta,
          videoBytes: v1Video,
          posterBytes: v4Poster,
        );
        final v4PosterHash = _sha256(v4Poster);
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v4Release.signed.envelopeBytes
          ..[manifestUri.resolve('blobs/$v4PosterHash').toString()] = v4Poster;
        transport.requestedUris.clear();

        final preparedV4 = await coordinator.prepare(
          target: PocketUpdateTarget.singleResource('assets/images/poster.png'),
        );
        expect(preparedV4.deliveryMode, PocketUpdateMode.granular);
        expect(preparedV4.downloadedFiles, 1);
        expect(
          preparedV4.reusedFiles,
          v4Release.signed.payload.files.length - 1,
        );
        expect(preparedV4.downloadedBytes, v4Poster.length);
        expect(
          preparedV4.updatedComponents,
          <String>['asset:assets/images/poster.png'],
        );
        expect(transport.requestedUris, <String>[
          manifestUri.toString(),
          manifestUri.resolve('blobs/$v4PosterHash').toString(),
        ]);
        await coordinator.commitHealthy(preparedV4);

        final finalPoster = File(
          preparedV4.source.pathForAsset('assets/images/poster.png')!,
        );
        expect(await finalPoster.readAsBytes(), v4Poster);

        // --- Phase 5: PAK dtype change is rejected when targeting an unrelated loose asset ---
        final v5DtypeRelease = await buildMultiPartRelease(
          build: 5,
          version: '1.0.4',
          entryBytes: v2Entry,
          alphaBytes: v1Alpha,
          betaBytes: v3Beta,
          videoBytes: v1Video,
          posterBytes: v4Poster,
          alphaDtype: 7,
        );
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v5DtypeRelease.signed.envelopeBytes;
        await expectLater(
          coordinator.prepare(
            target: PocketUpdateTarget.singleResource('assets/video.mp4'),
          ),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'update-target-scope',
            ),
          ),
        );

        // --- Phase 6: Single-resource scope rejects guest policy changes (Finding 4) ---
        final v6PolicyRelease = await buildMultiPartRelease(
          build: 6,
          version: '1.0.5',
          entryBytes: v2Entry,
          alphaBytes: v1Alpha,
          betaBytes: v3Beta,
          videoBytes: v1Video,
          posterBytes: <int>[99, 98, 97, 96],
          requiredCaps: const <String>['camera'],
        );
        transport.responses
          ..clear()
          ..[manifestUri.toString()] = v6PolicyRelease.signed.envelopeBytes;
        await expectLater(
          coordinator.prepare(
            target: PocketUpdateTarget.singleResource(
              'assets/images/poster.png',
            ),
          ),
          throwsA(
            isA<PocketPackageException>()
                .having((e) => e.code, 'code', 'update-target-scope')
                .having(
                  (e) => e.message,
                  'message',
                  contains('guest policy also changed'),
                ),
          ),
        );
      },
    );

    test(
      '12. Granular target enforcement rejects missing baseline and out-of-scope changes',
      () async {
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');

        final entry1 = <int>[1, 2, 3];
        final pak1 = <int>[4, 5, 6];
        final signed1 = await makeSignedManifest(
          build: 1,
          version: '1.0.1',
          entryBytes: entry1,
          pakBytes: pak1,
        );
        transport.responses[manifestUri.toString()] = signed1.envelopeBytes;

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        // Code-only update without an installed baseline must fail with update-baseline-missing
        await expectLater(
          coordinator.prepare(target: const PocketUpdateTarget.codeOnly()),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'update-baseline-missing',
            ),
          ),
        );

        // Install v1 as baseline
        transport.responses[manifestUri
            .resolve('blobs/${_sha256(entry1)}')
            .toString()] = entry1;
        transport.responses[manifestUri
            .resolve('blobs/${_sha256(pak1)}')
            .toString()] = pak1;
        final prepared1 = await coordinator.prepare();
        await coordinator.commitHealthy(prepared1);

        // v2 changes PAK bytes; requesting codeOnly() must fail with update-target-scope
        final signed2 = await makeSignedManifest(
          build: 2,
          version: '1.0.2',
          entryBytes: entry1,
          pakBytes: <int>[9, 9, 9],
        );
        transport.responses[manifestUri.toString()] = signed2.envelopeBytes;
        await expectLater(
          coordinator.prepare(target: const PocketUpdateTarget.codeOnly()),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'update-target-scope',
            ),
          ),
        );
      },
    );

    test(
      '13. Bounded ZIP inflation, PAK annotation verification, and preserved ZIP error codes',
      () async {
        // 1. Bounded ZIP inflation aborts immediately when inflated bytes exceed declared uncompressedSize or maxTotalBytes
        final largeZeros = Uint8List(128 * 1024);
        final validZip = encodePocketZip(<String, List<int>>{
          'blobs/test': largeZeros,
        });
        final forgedZip = Uint8List.fromList(validZip);
        final view = ByteData.sublistView(forgedZip);
        // Locate central directory header signature 0x02014b50 and forge uncompressedSize = 1
        var centralPos = -1;
        for (var i = 0; i <= forgedZip.length - 46; i++) {
          if (view.getUint32(i, Endian.little) == 0x02014b50) {
            centralPos = i;
            break;
          }
        }
        expect(centralPos, greaterThan(0));
        view.setUint32(centralPos + 24, 1, Endian.little);
        view.setUint32(22, 1, Endian.little);

        expect(
          () => decodePocketZip(forgedZip, maxTotalBytes: 1024),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              anyOf('bundle-format', 'manifest-size'),
            ),
          ),
        );

        // 2. encodePocketZip rejects post-normalization duplicates and >65535-byte filenames
        expect(
          () => encodePocketZip(<String, List<int>>{
            r'a\b': <int>[1],
            'a/b': <int>[2],
          }),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'bundle-format',
            ),
          ),
        );
        expect(
          () => encodePocketZip(<String, List<int>>{
            'k' * 65536: <int>[1],
          }),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'bundle-format',
            ),
          ),
        );

        // 3. ZIP validation failure in coordinator preserves structured bundle-content error code without retrying
        final store = PocketPackageStore(tempDir);
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');
        final entryBytes = <int>[1, 2, 3];
        final pakBytes = <int>[4, 5, 6];
        final entryHash = _sha256(entryBytes);
        final pakHash = _sha256(pakBytes);
        // Bundle omits pakBytes so writeBundleZip fails with bundle-content
        final incompleteZip = encodePocketZip(<String, List<int>>{
          'blobs/$entryHash': entryBytes,
        });
        final incompleteZipHash = _sha256(incompleteZip);
        final payload = <String, dynamic>{
          'schemaVersion': 1,
          'appId': 'test.app',
          'version': '1.0.0',
          'build': 1,
          'protocol': 1,
          'minHostVersion': 1,
          'entry': <String, dynamic>{
            'sha256': entryHash,
            'size': entryBytes.length,
          },
          'entryFormat': 'bytecode',
          'runtimeAbi': 'abi-v1',
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
          'bundle': <String, dynamic>{
            'format': 'zip',
            'sha256': incompleteZipHash,
            'size': incompleteZip.length,
            'url': 'bundles/bundle-$incompleteZipHash.zip',
          },
        };
        final payloadBytes = Uint8List.fromList(
          utf8.encode(jsonEncode(payload)),
        );
        final sig = await Ed25519().sign(payloadBytes, keyPair: keyPair);
        final signed = PocketSignedManifest.fromBytes(
          _envelopeBytes(
            keyId: 'test-key',
            payloadBytes: payloadBytes,
            signatureBytes: sig.bytes,
          ),
        );
        transport.responses[manifestUri.toString()] = signed.envelopeBytes;
        transport.responses[manifestUri
            .resolve('bundles/bundle-$incompleteZipHash.zip')
            .toString()] = incompleteZip;

        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'test-key': publicKey.bytes},
          store: store,
          transport: transport,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        await expectLater(
          coordinator.prepare(mode: PocketUpdateMode.zip),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'bundle-content',
            ),
          ),
        );
        // Must not retry deterministic bundle-content failures
        expect(transport.requestedUris, hasLength(2));

        // 4. 7z encoder/decoder roundtrip, bounded decompression, and 7zz CLI interop
        final sample7z = encodePocket7z(<String, List<int>>{
          'blobs/alpha': <int>[1, 2, 3, 4, 5],
          'blobs/beta': List<int>.generate(2048, (i) => (i * 13) & 0xff),
          'blobs/empty': const <int>[],
        });
        final decoded7z = decodePocketBundle(sample7z, format: '7z');
        expect(decoded7z['blobs/alpha'], <int>[1, 2, 3, 4, 5]);
        expect(
          decoded7z['blobs/beta'],
          List<int>.generate(2048, (i) => (i * 13) & 0xff),
        );
        expect(decoded7z['blobs/empty'], isEmpty);
        expect(
          () => decodePocket7z(sample7z, maxTotalBytes: 128),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'manifest-size',
            ),
          ),
        );

        final sevenZipBin = File('/opt/homebrew/bin/7zz').existsSync()
            ? '/opt/homebrew/bin/7zz'
            : null;
        if (sevenZipBin != null) {
          final cliDir = await Directory.systemTemp.createTemp('pocket-7zz-');
          try {
            final blobsDir = Directory(path.join(cliDir.path, 'blobs'));
            await blobsDir.create(recursive: true);
            final fileA = File(path.join(blobsDir.path, 'a'));
            final fileB = File(path.join(blobsDir.path, 'b'));
            await fileA.writeAsBytes(
              utf8.encode('Hello from 7-Zip LZMA2 solid archive! ' * 25),
            );
            await fileB.writeAsBytes(
              List<int>.generate(1024, (i) => (i * 7) & 0xff),
            );
            final archivePath = path.join(cliDir.path, 'cli.7z');
            final proc = await Process.run(
              sevenZipBin,
              <String>[
                'a',
                '-t7z',
                '-m0=lzma2',
                '-mf=off',
                '-ms=on',
                '-mhc=on',
                archivePath,
                'blobs/a',
                'blobs/b',
              ],
              workingDirectory: cliDir.path,
            );
            expect(proc.exitCode, 0);
            final cliBytes = await File(archivePath).readAsBytes();
            final extractedCli = decodePocket7z(Uint8List.fromList(cliBytes));
            expect(
              utf8.decode(extractedCli['blobs/a']!),
              'Hello from 7-Zip LZMA2 solid archive! ' * 25,
            );
            expect(
              extractedCli['blobs/b'],
              List<int>.generate(1024, (i) => (i * 7) & 0xff),
            );
          } finally {
            if (await cliDir.exists()) {
              await cliDir.delete(recursive: true);
            }
          }
        }

        // Reject mutated LZMA2 first range-coder byte (Finding 6)
        final mutated7z = Uint8List.fromList(sample7z);
        mutated7z[38] = 0x01;
        expect(
          () => decodePocket7z(mutated7z),
          throwsA(
            isA<PocketPackageException>().having(
              (e) => e.code,
              'code',
              'bundle-format',
            ),
          ),
        );
      },
    );
  });
}

Uint8List _envelopeBytes({
  required String keyId,
  required List<int> payloadBytes,
  required List<int> signatureBytes,
}) =>
    Uint8List.fromList(
      utf8.encode(
        jsonEncode(<String, dynamic>{
          'keyId': keyId,
          'payload': base64Encode(payloadBytes),
          'signature': base64Encode(signatureBytes),
        }),
      ),
    );

String _sha256(List<int> bytes) => crypto.sha256.convert(bytes).toString();

Future<String> _fileSha256(File file) async {
  final digests = <crypto.Digest>[];
  final converter = crypto.sha256.startChunkedConversion(
    ChunkedConversionSink<crypto.Digest>.withCallback(digests.addAll),
  );
  await for (final chunk in file.openRead()) {
    converter.add(chunk);
  }
  converter.close();
  return digests.single.toString();
}

Uint8List _largeDeterministicBytes(int length) {
  final bytes = Uint8List(length);
  var state = 0x12345678;
  for (var index = 0; index < bytes.length; index++) {
    state = (1664525 * state + 1013904223) & 0xffffffff;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

final class _MemoryTransport implements PocketUpdateTransport {
  _MemoryTransport(this.responses);

  final Map<String, List<int>> responses;
  final List<String> requestedUris = <String>[];

  @override
  Future<PocketDownloadResponse> open(
    Uri uri, {
    required PocketCancellationToken cancellation,
  }) async {
    cancellation.throwIfCancelled();
    requestedUris.add(uri.toString());
    final bytes = responses[uri.toString()];
    if (bytes == null) throw StateError('missing test response for $uri');
    return PocketDownloadResponse(
      bytes: Stream<List<int>>.value(bytes),
      contentLength: bytes.length,
    );
  }

  @override
  void close() {}
}
