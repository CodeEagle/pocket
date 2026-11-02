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
        await scoped.activate(prepared3.package);

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
    if (bytes == null) throw StateError('missing test response for $uri');
    return PocketDownloadResponse(
      bytes: Stream<List<int>>.value(bytes),
      contentLength: bytes.length,
    );
  }

  @override
  void close() {}
}
