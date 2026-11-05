import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  group('PocketTrustStore', () {
    late Directory directory;
    late SimpleKeyPair root;
    late SimpleKeyPair releaseA;
    late SimpleKeyPair releaseB;
    final now = DateTime.fromMillisecondsSinceEpoch(1_700_000_000 * 1000);

    setUp(() async {
      directory = await Directory.systemTemp.createTemp('pocket-trust-test-');
      final algorithm = Ed25519();
      root = await algorithm.newKeyPair();
      releaseA = await algorithm.newKeyPair();
      releaseB = await algorithm.newKeyPair();
    });

    tearDown(() async {
      if (await directory.exists()) await directory.delete(recursive: true);
    });

    Future<Uint8List> policyEnvelope({
      required SimpleKeyPair rootKey,
      required int epoch,
      required String releaseId,
      required List<int> releasePublic,
      List<String> scope = const <String>['test.app'],
      int notBefore = 1_600_000_000,
      int notAfter = 1_800_000_000,
      List<String> revokedKeys = const <String>[],
      List<String> revokedPackages = const <String>[],
      String? appId,
      Uint8List? exactPayload,
    }) async {
      final payload =
          exactPayload ??
          Uint8List.fromList(
            utf8.encode(
              jsonEncode(<String, dynamic>{
                'schemaVersion': 1,
                'epoch': epoch,
                if (appId != null) 'appId': appId,
                'releaseKeys': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'keyId': releaseId,
                    'publicKeyBase64': base64Encode(releasePublic),
                    'appScope': scope,
                    'notBefore': notBefore,
                    'notAfter': notAfter,
                  },
                ],
                if (revokedKeys.isNotEmpty) 'revokedKeys': revokedKeys,
                if (revokedPackages.isNotEmpty)
                  'revokedPackages': revokedPackages,
              }),
            ),
          );
      final signature = await Ed25519().sign(payload, keyPair: rootKey);
      return Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            'keyId': 'root-1',
            'payload': base64Encode(payload),
            'signature': base64Encode(signature.bytes),
          }),
        ),
      );
    }

    PocketTrustStore store(List<int> rootPublic) => PocketTrustStore(
      directory: directory,
      appId: 'test.app',
      rootKeyId: 'root-1',
      rootPublicKey: rootPublic,
      clock: () => now,
    );

    test('verifies the root over exact payload bytes', () async {
      final rootPublic = (await root.extractPublicKey()).bytes;
      final exact = Uint8List.fromList(
        utf8.encode(
          '{"schemaVersion":1,"epoch":1,"releaseKeys":[{"keyId":"a","publicKeyBase64":"${base64Encode((await releaseA.extractPublicKey()).bytes)}","appScope":["test.app"],"notBefore":1600000000,"notAfter":1800000000}]}',
        ),
      );
      final signed = await policyEnvelope(
        rootKey: root,
        epoch: 1,
        releaseId: 'a',
        releasePublic: (await releaseA.extractPublicKey()).bytes,
        exactPayload: exact,
      );
      final trust = store(rootPublic);
      await trust.installBytes(signed);
      expect((await trust.current()).epoch, 1);

      final envelope = jsonDecode(utf8.decode(signed)) as Map<String, dynamic>;
      final changed = Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            ...envelope,
            'payload': base64Encode(
              Uint8List.fromList(utf8.encode('${utf8.decode(exact)} ')),
            ),
          }),
        ),
      );
      await expectLater(
        trust.installBytes(changed),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-policy-root',
          ),
        ),
      );
    });

    test('enforces app scope and certificate validity', () async {
      final trust = store((await root.extractPublicKey()).bytes);
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 1,
          releaseId: 'a',
          releasePublic: (await releaseA.extractPublicKey()).bytes,
          scope: const <String>['other.app'],
        ),
      );
      await expectLater(
        trust.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: now.millisecondsSinceEpoch ~/ 1000,
          contentHash: _repeat('a', 64),
          payloadBytes: Uint8List(0),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-certificate-scope',
          ),
        ),
      );
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 2,
          releaseId: 'a',
          releasePublic: (await releaseA.extractPublicKey()).bytes,
          notBefore: 1_750_000_000,
        ),
      );
      await expectLater(
        trust.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: 1_700_000_000,
          contentHash: _repeat('b', 64),
          payloadBytes: Uint8List(0),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-certificate-expired',
          ),
        ),
      );
    });

    test('rejects stale and conflicting policy epochs', () async {
      final trust = store((await root.extractPublicKey()).bytes);
      final pub = (await releaseA.extractPublicKey()).bytes;
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 2,
          releaseId: 'a',
          releasePublic: pub,
        ),
      );
      await expectLater(
        trust.installBytes(
          await policyEnvelope(
            rootKey: root,
            epoch: 1,
            releaseId: 'a',
            releasePublic: pub,
          ),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-policy-rollback',
          ),
        ),
      );
      await expectLater(
        trust.installBytes(
          await policyEnvelope(
            rootKey: root,
            epoch: 2,
            releaseId: 'b',
            releasePublic: (await releaseB.extractPublicKey()).bytes,
          ),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-policy-conflict',
          ),
        ),
      );
    });

    test('rotation and revocation survive a new store instance', () async {
      final rootPublic = (await root.extractPublicKey()).bytes;
      final aPublic = (await releaseA.extractPublicKey()).bytes;
      final bPublic = (await releaseB.extractPublicKey()).bytes;
      final trust = store(rootPublic);
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 1,
          releaseId: 'a',
          releasePublic: aPublic,
        ),
      );
      expect(
        await trust.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: 1_700_000_000,
          contentHash: '1' * 64,
          payloadBytes: Uint8List.fromList(<int>[1]),
        ),
        aPublic,
      );
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 2,
          releaseId: 'b',
          releasePublic: bPublic,
          revokedKeys: const <String>['a'],
          revokedPackages: <String>[_repeat('1', 64)],
        ),
      );
      final restarted = store(rootPublic);
      await expectLater(
        restarted.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: 1_700_000_000,
          contentHash: _repeat('1', 64),
          payloadBytes: Uint8List.fromList(<int>[1]),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-revoked-key',
          ),
        ),
      );
      expect(
        await restarted.publicKeyForPackage(
          keyId: 'b',
          packageAppId: 'test.app',
          signedAt: 1_700_000_000,
          contentHash: _repeat('2', 64),
          payloadBytes: Uint8List.fromList(<int>[2]),
        ),
        bPublic,
      );
      await expectLater(
        restarted.publicKeyForPackage(
          keyId: 'b',
          packageAppId: 'test.app',
          signedAt: 1_700_000_000,
          contentHash: _repeat('1', 64),
          payloadBytes: Uint8List.fromList(<int>[3]),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-revoked-package',
          ),
        ),
      );
    });

    test('requires host time and signedAt inside the current release window', () async {
      final trust = store((await root.extractPublicKey()).bytes);
      final releasePublic = (await releaseA.extractPublicKey()).bytes;
      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 1,
          releaseId: 'a',
          releasePublic: releasePublic,
        ),
      );
      await expectLater(
        trust.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: 1_700_000_001,
          contentHash: _repeat('c', 64),
          payloadBytes: Uint8List.fromList(<int>[3]),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-signed-at',
          ),
        ),
      );

      await trust.installBytes(
        await policyEnvelope(
          rootKey: root,
          epoch: 2,
          releaseId: 'a',
          releasePublic: releasePublic,
          notAfter: 1_699_999_999,
        ),
      );
      await expectLater(
        trust.publicKeyForPackage(
          keyId: 'a',
          packageAppId: 'test.app',
          signedAt: 1_699_999_999,
          contentHash: _repeat('d', 64),
          payloadBytes: Uint8List.fromList(<int>[4]),
        ),
        throwsA(
          isA<PocketTrustException>().having(
            (e) => e.code,
            'code',
            'trust-certificate-expired',
          ),
        ),
      );
    });

    test('serializes concurrent policy acceptance across store instances', () async {
      final rootPublic = (await root.extractPublicKey()).bytes;
      final first = store(rootPublic);
      final second = store(rootPublic);
      final releasePublic = (await releaseA.extractPublicKey()).bytes;
      final newer = await policyEnvelope(
        rootKey: root,
        epoch: 2,
        releaseId: 'a',
        releasePublic: releasePublic,
      );
      final older = await policyEnvelope(
        rootKey: root,
        epoch: 1,
        releaseId: 'a',
        releasePublic: releasePublic,
      );

      Future<String> attempt(Future<void> operation, String label) async {
        try {
          await operation;
          return '$label-ok';
        } on PocketTrustException catch (error) {
          return '$label-${error.code}';
        }
      }

      final outcomes = await Future.wait(<Future<String>>[
        attempt(first.installBytes(newer), 'newer'),
        attempt(second.installBytes(older), 'older'),
      ]);
      expect(await first.current().then((policy) => policy.epoch), 2);
      expect(
        outcomes.any((result) => result == 'older-trust-policy-rollback') ||
            outcomes.every((result) => result.endsWith('-ok')),
        isTrue,
      );
    });
  });
}

String _repeat(String value, int count) =>
    List<String>.filled(count, value).join();
