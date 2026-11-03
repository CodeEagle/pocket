import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:pocket_flutter/pocket_flutter.dart' show PocketMemoryLimits;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test('an undeclared memory block remains backwards compatible', () {
    const manifest = PocketGuestManifest();
    expect(manifest.memoryLimits.isEmpty, isTrue);
    expect(manifest.toJson().containsKey('memory'), isFalse);

    final parsed = PocketGuestManifest.fromJson(<String, dynamic>{
      'capabilities': <String, dynamic>{'requires': <String>[]},
    });
    expect(parsed.memoryLimits, equals(manifest.memoryLimits));
  });

  test('rejects malformed, out-of-range and unknown memory declarations', () {
    final invalid = <Object?>[
      null,
      <String, dynamic>{'heapLimitBytes': null},
      <String, dynamic>{'heapLimitBytes': 0},
      <String, dynamic>{'heapLimitBytes': -1},
      <String, dynamic>{'heapLimitBytes': 64 * 1024 - 1},
      <String, dynamic>{'heapLimitBytes': 2 * 1024 * 1024 * 1024 + 1},
      <String, dynamic>{'heapLimitBytes': 64 * 1024.5},
      <String, dynamic>{'maxPakBytes': null},
      <String, dynamic>{'maxPakBytes': 0},
      <String, dynamic>{'maxPakBytes': 512 * 1024 * 1024 + 1},
      <String, dynamic>{'maxPakBytes': 1.5},
      <String, dynamic>{'gcThreshold': 1},
    ];
    for (final value in invalid) {
      expect(
        () => PocketGuestManifest.fromJson(<String, dynamic>{'memory': value}),
        throwsFormatException,
        reason: 'expected rejection for $value',
      );
    }
  });

  test('signed package roundtrip retains memory limits and verifies', () async {
    final entryBytes = Uint8List.fromList(<int>[0x50, 0x4a, 0x42, 0x43]);
    final pakBytes = Uint8List.fromList(<int>[1, 2, 3]);
    final entryHash = crypto.sha256.convert(entryBytes).toString();
    final pakHash = crypto.sha256.convert(pakBytes).toString();
    const memory = PocketMemoryLimits(
      heapLimitBytes: 128 * 1024,
      maxPakBytes: 8 * 1024 * 1024,
    );
    final manifest = PocketPackageManifest(
      schemaVersion: 1,
      appId: 'memory.signed.test',
      version: '1.0.0',
      build: 1,
      protocol: 1,
      minHostVersion: 1,
      entry: PocketManifestEntry(sha256: entryHash, size: entryBytes.length),
      entryFormat: 'bytecode',
      runtimeAbi: 'memory-test-abi',
      pak: PocketPakManifest(
        sha256: pakHash,
        size: pakBytes.length,
        parts: <PocketPakPart>[
          PocketPakPart(offset: 0, sha256: pakHash, size: pakBytes.length),
        ],
      ),
      files: <PocketManifestFile>[
        PocketManifestFile(
          sha256: entryHash,
          size: entryBytes.length,
          url: 'blobs/$entryHash',
        ),
        PocketManifestFile(
          sha256: pakHash,
          size: pakBytes.length,
          url: 'blobs/$pakHash',
        ),
      ],
      guestManifest: const PocketGuestManifest(memoryLimits: memory),
    );
    final payloadBytes = Uint8List.fromList(
      utf8.encode(jsonEncode(manifest.toJson())),
    );
    final algorithm = Ed25519();
    final keyPair = await algorithm.newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
    final envelope = Uint8List.fromList(
      utf8.encode(
        jsonEncode(<String, dynamic>{
          'keyId': 'memory-test-key',
          'payload': base64Encode(payloadBytes),
          'signature': base64Encode(signature.bytes),
        }),
      ),
    );

    final signed = PocketSignedManifest.fromBytes(envelope);
    await signed.verify(
      trustedKeys: <String, List<int>>{'memory-test-key': publicKey.bytes},
    );
    expect(signed.payload.guestManifest.memoryLimits, equals(memory));
    final reparsed = PocketPackageManifest.fromJson(signed.payload.toJson());
    expect(reparsed.guestManifest.memoryLimits, equals(memory));
  });
}
