import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  group('guest manifest and capability intersection', () {
    test('normalizes required/optional declarations', () {
      final manifest = PocketGuestManifest.fromJson(<String, dynamic>{
        'capabilities': <String, dynamic>{
          'requires': <String>['demo.echo', 'demo.echo'],
          'optional': <String>['demo.echo', 'demo.ticks'],
        },
        'permissions': <String, dynamic>{
          'optional': <String>['network'],
        },
      });
      expect(manifest.requiredCapabilities, contains('demo.echo'));
      expect(manifest.optionalCapabilities, equals(<String>{'demo.ticks'}));
      expect(manifest.optionalPermissions, equals(<String>{'network'}));
    });

    test('host rejects an undeclared capability after negotiation', () async {
      final registry = PocketHostRegistry();
      registry.registerRequest('demo.echo', (params) => params['value']);
      final sent = <Map<String, dynamic>>[];
      final streams = PocketStreamBridge(
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      final host = PocketHost(
        registry: registry,
        streams: streams,
        allowedCapabilities: const <String>{'demo.echo'},
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      host.configureGuestCapabilities(required: const <String>[]);
      await host.handle(
        const PocketEvent(
          id: 'r1',
          method: 'host.request',
          params: <String, dynamic>{
            'requestId': 'r1',
            'capability': 'demo.echo',
            'params': <String, dynamic>{'value': 7},
          },
        ),
      );
      expect(sent.last['ok'], isFalse);
      expect((sent.last['error'] as Map)['code'], 'capability_denied');

      host.configureGuestCapabilities(required: const <String>['demo.echo']);
      await host.handle(
        const PocketEvent(
          id: 'r2',
          method: 'host.request',
          params: <String, dynamic>{
            'requestId': 'r2',
            'capability': 'demo.echo',
            'params': <String, dynamic>{'value': 8},
          },
        ),
      );
      expect(sent.last['ok'], isTrue);
      expect(sent.last['result'], 8);
      host.dispose();
    });

    test('disposed host suppresses a late provider response', () async {
      final result = Completer<Object?>();
      final registry = PocketHostRegistry();
      registry.registerRequest('demo.wait', (_) => result.future);
      final sent = <Map<String, dynamic>>[];
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: const <String>{'demo.wait'},
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      host.configureGuestCapabilities(required: const <String>['demo.wait']);
      final pending = host.handle(
        const PocketEvent(
          id: 'late',
          method: 'host.request',
          params: <String, dynamic>{
            'requestId': 'late',
            'capability': 'demo.wait',
          },
        ),
      );
      host.dispose();
      result.complete('must not be sent');
      await pending;
      expect(sent, isEmpty);
    });
  });

  group('signed manifest runtime ABI', () {
    test('rejects bytecode for a different host ABI', () async {
      final keyPair = await Ed25519().newKeyPair();
      final publicKey = await keyPair.extractPublicKey();
      final payload = <String, dynamic>{
        'schemaVersion': 1,
        'appId': 'test.app',
        'version': '1.0.0',
        'build': 1,
        'protocol': 1,
        'minHostVersion': 1,
        'entry': <String, dynamic>{
          'sha256': _hash([1]),
          'size': 1,
        },
        'entryFormat': 'quickjs-bytecode',
        'runtimeAbi': 'abi-v1',
        'pak': <String, dynamic>{
          'sha256': _hash([2]),
          'size': 1,
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{
              'offset': 0,
              'sha256': _hash([2]),
              'size': 1,
            },
          ],
        },
        'files': <Map<String, dynamic>>[
          <String, dynamic>{
            'sha256': _hash([1]),
            'size': 1,
            'url': 'blobs/${_hash([1])}',
          },
          <String, dynamic>{
            'sha256': _hash([2]),
            'size': 1,
            'url': 'blobs/${_hash([2])}',
          },
        ],
      };
      final payloadBytes = Uint8List.fromList(utf8.encode(jsonEncode(payload)));
      final signature = await Ed25519().sign(payloadBytes, keyPair: keyPair);
      final envelope = Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            'keyId': 'test',
            'payload': base64Encode(payloadBytes),
            'signature': base64Encode(signature.bytes),
          }),
        ),
      );
      final signed = PocketSignedManifest.fromBytes(envelope);
      final verifier = PocketManifestVerifier(
        trustedKeys: <String, List<int>>{'test': publicKey.bytes},
        appId: 'test.app',
        expectedRuntimeAbi: 'abi-v2',
        requireBytecode: true,
      );
      expect(
        () => verifier.verify(signed),
        throwsA(isA<PocketPackageException>()),
      );
    });
  });

  test(
    'resetToEmbedded clears activation pointers but keeps version folders',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-services-',
      );
      try {
        final app = Directory('${directory.path}/apps/test-app');
        await app.create(recursive: true);
        await Directory('${app.path}/versions/keep-me').create(recursive: true);
        for (final name in <String>['active', 'previous', 'lastGood']) {
          await File('${app.path}/$name').writeAsString('keep-me');
        }
        final coordinator = PocketUpdateCoordinator(
          manifestUri: Uri.parse('http://127.0.0.1/latest.json'),
          appId: 'test-app',
          trustedKeys: const <String, List<int>>{},
          store: PocketPackageStore(directory),
        );
        await coordinator.resetToEmbedded();
        expect(await File('${app.path}/active').exists(), isFalse);
        expect(await File('${app.path}/previous').exists(), isFalse);
        expect(await File('${app.path}/lastGood').exists(), isFalse);
        expect(
          await Directory('${app.path}/versions/keep-me').exists(),
          isTrue,
        );
        coordinator.dispose();
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );
}

String _hash(List<int> bytes) => crypto.sha256.convert(bytes).toString();
