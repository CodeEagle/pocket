import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  late Directory directory;
  late _AdmissionFixture fixture;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'pocket-trust-admission-test-',
    );
    fixture = await _AdmissionFixture.create(directory);
  });

  tearDown(() async {
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test(
    'valid trust admission remains usable and activate re-verifies',
    () async {
      final policy = await fixture.policy(epoch: 1);
      final trust = fixture.trustStore();
      await trust.installBytes(policy);
      final verifier = fixture.verifier(trust);
      final store = PocketPackageStore(directory).scoped(fixture.appId);
      final signed = await fixture.manifest(
        build: 1,
        version: '1.0.0',
        entry: <int>[1, 1, 1],
        pak: <int>[1, 1, 2],
      );
      final package = await fixture.stage(store, verifier, signed);

      await store.commitHealthy(package, verifier: verifier);
      expect(await store.readPointerId('active'), package.versionId);
      expect(await store.readPointerId('lastGood'), package.versionId);

      // A direct low-level activation is still required to pass the same
      // verifier; it cannot promote a package through a trust-policy bypass.
      await store.activate(package, verifier: verifier);
      expect(await store.readPointerId('active'), package.versionId);

      final revoked = await fixture.policy(
        epoch: 2,
        revokedPackages: <String>[signed.payload.contentHash],
      );
      await trust.installBytes(revoked);
      await expectLater(
        store.activate(package, verifier: fixture.verifier(trust)),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            'trust-revoked-package',
          ),
        ),
      );
      expect(await store.readPointerId('active'), package.versionId);
    },
  );

  test(
    'fallback propagates pointer IO errors and retains the healthy target',
    () async {
      final trust = fixture.trustStore();
      await trust.installBytes(await fixture.policy(epoch: 1));
      final verifier = fixture.verifier(trust);
      final store = PocketPackageStore(directory).scoped(fixture.appId);
      final pair = await _seedPair(fixture, store, verifier, marker: 9);
      final active = File('${directory.path}/apps/${fixture.appId}/active');
      await active.delete();
      await Directory(active.path).create();
      // A non-file target forces a real atomic-pointer write failure.
      await expectLater(
        store.fallbackFor(pair.second.versionId, verifier: verifier),
        throwsA(isA<FileSystemException>()),
      );
      expect(await store.readPointerId('lastGood'), pair.first.versionId);
      expect(await pair.second.directory.exists(), isTrue);
    },
  );

  for (final revokePackage in <bool>[false, true]) {
    test('commitHealthy rejects a policy revocation during final admission '
        '(revoke ${revokePackage ? 'package' : 'key'})', () async {
      final signed = await fixture.manifest(
        build: 1,
        version: '1.0.0',
        entry: <int>[2, 1, 1],
        pak: <int>[2, 1, 2],
      );
      final policy1 = await fixture.policy(epoch: 1);
      final policy2 = await fixture.policy(
        epoch: 2,
        revokedKeys: revokePackage ? const <String>[] : <String>['release-a'],
        revokedPackages: revokePackage
            ? <String>[signed.payload.contentHash]
            : const <String>[],
      );
      final race = _PolicyRace(
        directory: directory,
        appId: fixture.appId,
        rootKeyId: fixture.rootKeyId,
        rootPublicKey: fixture.rootPublic,
        validNow: fixture.validNow,
        revocation: policy2,
      );
      await race.checker.installBytes(policy1);
      final verifier = fixture.verifier(race.checker);
      final store = PocketPackageStore(directory).scoped(fixture.appId);
      final package = await fixture.stage(store, verifier, signed);

      race.arm();
      await expectLater(
        store.commitHealthy(package, verifier: verifier),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            revokePackage ? 'trust-revoked-package' : 'trust-revoked-key',
          ),
        ),
      );
      await race.waitForRevocation();

      expect(race.triggered, isTrue);
      expect(await store.readPointerId('active'), isNull);
      expect(await store.readPointerId('lastGood'), isNull);
      expect((await race.checker.current()).epoch, 2);
    });
  }

  test('rollback does not promote a target revoked during IO', () async {
    final policy1 = await fixture.policy(epoch: 1);
    final trust = fixture.trustStore();
    await trust.installBytes(policy1);
    final verifier = fixture.verifier(trust);
    final store = PocketPackageStore(directory).scoped(fixture.appId);
    final pair = await _seedPair(fixture, store, verifier, marker: 3);
    final package1 = pair.first;
    final package2 = pair.second;
    expect(await store.readPointerId('active'), package2.versionId);
    expect(await store.readPointerId('previous'), package1.versionId);

    final revokedPolicy = await fixture.policy(
      epoch: 2,
      revokedPackages: <String>[package1.manifest.payload.contentHash],
    );
    final race = _PolicyRace(
      directory: directory,
      appId: fixture.appId,
      rootKeyId: fixture.rootKeyId,
      rootPublicKey: fixture.rootPublic,
      validNow: fixture.validNow,
      revocation: revokedPolicy,
    );
    final raceVerifier = fixture.verifier(race.checker);
    race.arm();
    await expectLater(
      store.rollback(versionId: package1.versionId, verifier: raceVerifier),
      throwsA(
        isA<PocketPackageException>().having(
          (error) => error.code,
          'code',
          'trust-revoked-package',
        ),
      ),
    );
    await race.waitForRevocation();
    expect(await store.readPointerId('active'), package2.versionId);
    expect(await store.readPointerId('lastGood'), package2.versionId);
  });

  test('fallback does not promote a target revoked during IO', () async {
    final policy1 = await fixture.policy(epoch: 1);
    final trust = fixture.trustStore();
    await trust.installBytes(policy1);
    final verifier = fixture.verifier(trust);
    final store = PocketPackageStore(directory).scoped(fixture.appId);
    final pair = await _seedPair(fixture, store, verifier, marker: 5);
    final policy2 = await fixture.policy(
      epoch: 2,
      revokedPackages: <String>[pair.first.manifest.payload.contentHash],
    );
    final race = _PolicyRace(
      directory: directory,
      appId: fixture.appId,
      rootKeyId: fixture.rootKeyId,
      rootPublicKey: fixture.rootPublic,
      validNow: fixture.validNow,
      revocation: policy2,
    );
    final raceVerifier = fixture.verifier(race.checker);
    race.arm();
    final fallback = await store.fallbackFor(
      pair.second.versionId,
      verifier: raceVerifier,
    );
    await race.waitForRevocation();
    expect(race.triggered, isTrue);
    expect(fallback, isNull);
    expect(await store.readPointerId('active'), isNot(pair.first.versionId));
    expect(await store.readPointerId('lastGood'), isNot(pair.first.versionId));
  });

  test(
    'prepared candidate is rejected before use after expiry or revocation',
    () async {
      final policy = await fixture.policy(
        epoch: 1,
        keyNotAfter: fixture.validSeconds + 10,
      );
      final mutableNow = _MutableClock(fixture.validNow);
      final trust = fixture.trustStore(clock: mutableNow.call);
      await trust.installBytes(policy);
      final verifier = fixture.verifier(trust);
      final store = PocketPackageStore(directory).scoped(fixture.appId);
      final package = await fixture.stage(
        store,
        verifier,
        await fixture.manifest(
          build: 1,
          version: '1.0.0',
          entry: <int>[4, 1, 1],
          pak: <int>[4, 1, 2],
        ),
      );
      final coordinator = PocketUpdateCoordinator(
        manifestUri: Uri.parse('https://updates.example.test/latest.json'),
        appId: fixture.appId,
        trustedKeys: const <String, List<int>>{},
        store: PocketPackageStore(directory),
        trustStore: trust,
      );
      final prepared = PocketPreparedPackage(
        package: package,
        needsActivation: true,
      );
      var used = false;
      try {
        mutableNow.value = fixture.validNow.add(const Duration(seconds: 20));
        await expectLater(
          coordinator.withVerifiedPrepared<bool>(prepared, () {
            used = true;
            return true;
          }),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'trust-certificate-expired',
            ),
          ),
        );
        expect(used, isFalse);
      } finally {
        coordinator.dispose();
      }

      // The same prepared object is also refused when revocation arrives while
      // its full artifact hash is being checked.
      final policy2 = await fixture.policy(
        epoch: 2,
        revokedPackages: <String>[package.manifest.payload.contentHash],
      );
      final race = _PolicyRace(
        directory: directory,
        appId: fixture.appId,
        rootKeyId: fixture.rootKeyId,
        rootPublicKey: fixture.rootPublic,
        validNow: fixture.validNow,
        revocation: policy2,
      );
      await race.checker.installBytes(policy);
      final raceVerifier = fixture.verifier(race.checker);
      final raceCoordinator = PocketUpdateCoordinator(
        manifestUri: Uri.parse('https://updates.example.test/latest.json'),
        appId: fixture.appId,
        trustedKeys: const <String, List<int>>{},
        store: PocketPackageStore(directory),
        trustStore: race.checker,
      );
      var revokedUse = false;
      try {
        // Ensure the package is still valid under the race verifier before the
        // controlled interleaving is armed.
        await raceVerifier.verify(package.manifest);
        race.arm();
        await expectLater(
          raceCoordinator.withVerifiedPrepared<bool>(prepared, () {
            revokedUse = true;
            return true;
          }),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'trust-revoked-package',
            ),
          ),
        );
        await race.waitForRevocation();
        expect(revokedUse, isFalse);
      } finally {
        raceCoordinator.dispose();
      }
    },
  );
}

final class _AdmissionFixture {
  _AdmissionFixture({
    required this.directory,
    required this.root,
    required this.release,
    required this.rootPublic,
    required this.releasePublic,
  });

  static const defaultAppId = 'test.app';
  static const defaultRootKeyId = 'root-1';
  static const releaseKeyId = 'release-a';
  static const defaultValidSeconds = 1_700_000_000;
  static final defaultValidNow = DateTime.fromMillisecondsSinceEpoch(
    defaultValidSeconds * 1000,
    isUtc: true,
  );

  final Directory directory;
  final SimpleKeyPair root;
  final SimpleKeyPair release;
  final List<int> rootPublic;
  final List<int> releasePublic;
  final Map<String, ({Uint8List entry, Uint8List pak})> artifacts =
      <String, ({Uint8List entry, Uint8List pak})>{};

  String get appId => _AdmissionFixture.defaultAppId;
  String get rootKeyId => _AdmissionFixture.defaultRootKeyId;
  int get validSeconds => _AdmissionFixture.defaultValidSeconds;
  DateTime get validNow => _AdmissionFixture.defaultValidNow;

  static Future<_AdmissionFixture> create(Directory directory) async {
    final algorithm = Ed25519();
    final root = await algorithm.newKeyPair();
    final release = await algorithm.newKeyPair();
    return _AdmissionFixture(
      directory: directory,
      root: root,
      release: release,
      rootPublic: (await root.extractPublicKey()).bytes,
      releasePublic: (await release.extractPublicKey()).bytes,
    );
  }

  PocketTrustStore trustStore({DateTime Function()? clock}) => PocketTrustStore(
    directory: directory,
    appId: appId,
    rootKeyId: rootKeyId,
    rootPublicKey: rootPublic,
    clock: clock ?? () => validNow,
  );

  PocketManifestVerifier verifier(PocketTrustStore trust) =>
      PocketManifestVerifier(
        trustedKeys: const <String, List<int>>{},
        appId: appId,
        trustStore: trust,
      );

  Future<Uint8List> policy({
    required int epoch,
    Iterable<String> revokedKeys = const <String>[],
    Iterable<String> revokedPackages = const <String>[],
    int keyNotAfter = 4_000_000_000,
  }) async {
    final payload = <String, dynamic>{
      'schemaVersion': 1,
      'epoch': epoch,
      'releaseKeys': <Map<String, dynamic>>[
        <String, dynamic>{
          'keyId': releaseKeyId,
          'publicKeyBase64': base64Encode(releasePublic),
          'appScope': <String>[appId],
          'notBefore': 0,
          'notAfter': keyNotAfter,
        },
      ],
      if (revokedKeys.isNotEmpty) 'revokedKeys': revokedKeys.toList(),
      if (revokedPackages.isNotEmpty)
        'revokedPackages': revokedPackages.toList(),
    };
    final payloadBytes = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
    final signature = await Ed25519().sign(payloadBytes, keyPair: root);
    return Uint8List.fromList(
      utf8.encode(
        jsonEncode(<String, dynamic>{
          'keyId': rootKeyId,
          'payload': base64Encode(payloadBytes),
          'signature': base64Encode(signature.bytes),
        }),
      ),
    );
  }

  Future<PocketSignedManifest> manifest({
    required int build,
    required String version,
    required List<int> entry,
    required List<int> pak,
    int signedAt = _AdmissionFixture.defaultValidSeconds,
  }) async {
    final entryHash = _sha(entry);
    final pakHash = _sha(pak);
    final payload = <String, dynamic>{
      'schemaVersion': 1,
      'appId': appId,
      'version': version,
      'build': build,
      'signedAt': signedAt,
      'protocol': 1,
      'minHostVersion': 1,
      'entry': <String, dynamic>{'sha256': entryHash, 'size': entry.length},
      'entryFormat': 'javascript',
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
    final signature = await Ed25519().sign(payloadBytes, keyPair: release);
    final signed = PocketSignedManifest.fromBytes(
      Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            'keyId': releaseKeyId,
            'payload': base64Encode(payloadBytes),
            'signature': base64Encode(signature.bytes),
          }),
        ),
      ),
    );
    artifacts[signed.payload.contentHash] = (
      entry: Uint8List.fromList(entry),
      pak: Uint8List.fromList(pak),
    );
    return signed;
  }

  Future<PocketPackage> stage(
    PocketPackageStore store,
    PocketManifestVerifier verifier,
    PocketSignedManifest signed,
  ) async {
    await verifier.verify(signed);
    final artifact = artifacts[signed.payload.contentHash];
    if (artifact == null) {
      throw StateError('Missing fixture bytes for ${signed.payload.version}');
    }
    final entryBlob = File('${directory.path}/${signed.payload.version}-entry');
    final pakBlob = File('${directory.path}/${signed.payload.version}-pak');
    await entryBlob.writeAsBytes(artifact.entry);
    await pakBlob.writeAsBytes(artifact.pak);
    return store.stage(
      signed: signed,
      verifier: verifier,
      entryBlob: entryBlob,
      blobs: <String, File>{
        signed.payload.entry.sha256: entryBlob,
        signed.payload.pak.sha256: pakBlob,
      },
      cancellation: PocketCancellationToken(),
    );
  }
}

final class _MutableClock {
  _MutableClock(this.value);

  DateTime value;

  DateTime call() => value;
}

Future<({PocketPackage first, PocketPackage second})> _seedPair(
  _AdmissionFixture fixture,
  PocketPackageStore store,
  PocketManifestVerifier verifier, {
  required int marker,
}) async {
  final first = await fixture.stage(
    store,
    verifier,
    await fixture.manifest(
      build: 1,
      version: '1.$marker.0',
      entry: <int>[marker, 1, 1],
      pak: <int>[marker, 1, 2],
    ),
  );
  await store.commitHealthy(first, verifier: verifier);
  final second = await fixture.stage(
    store,
    verifier,
    await fixture.manifest(
      build: 2,
      version: '2.$marker.0',
      entry: <int>[marker, 2, 1],
      pak: <int>[marker, 2, 2],
    ),
  );
  await store.commitHealthy(second, verifier: verifier);
  return (first: first, second: second);
}

final class _PolicyRace {
  _PolicyRace({
    required Directory directory,
    required String appId,
    required String rootKeyId,
    required List<int> rootPublicKey,
    required DateTime validNow,
    required Uint8List revocation,
  }) : _validNow = validNow,
       _revocation = revocation {
    revoker = PocketTrustStore(
      directory: directory,
      appId: appId,
      rootKeyId: rootKeyId,
      rootPublicKey: rootPublicKey,
      clock: () => validNow,
    );
    checker = PocketTrustStore(
      directory: directory,
      appId: appId,
      rootKeyId: rootKeyId,
      rootPublicKey: rootPublicKey,
      clock: () {
        if (armed && !triggered) {
          triggered = true;
          pending = revoker.installBytes(_revocation);
        }
        return _validNow;
      },
    );
  }

  final DateTime _validNow;
  final Uint8List _revocation;
  late final PocketTrustStore checker;
  late final PocketTrustStore revoker;
  bool armed = false;
  bool triggered = false;
  Future<void>? pending;

  void arm() => armed = true;

  Future<void> waitForRevocation() async {
    final operation = pending;
    if (operation != null) await operation;
  }
}

String _sha(List<int> bytes) => crypto.sha256.convert(bytes).toString();
