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
  group('signed package rejection', () {
    test('rejects a signed payload after its JSON is tampered', () async {
      final algorithm = Ed25519();
      final keyPair = await algorithm.newKeyPair();
      final publicKey = await keyPair.extractPublicKey();
      final payload = _manifestPayload();
      final originalPayload = Uint8List.fromList(
        utf8.encode(jsonEncode(payload)),
      );
      final signature = await algorithm.sign(originalPayload, keyPair: keyPair);
      final tamperedPayload = Uint8List.fromList(
        utf8.encode(jsonEncode({...payload, 'version': '1.0.1'})),
      );
      final signed = PocketSignedManifest.fromBytes(
        _envelopeBytes(
          keyId: 'known',
          payloadBytes: tamperedPayload,
          signatureBytes: signature.bytes,
        ),
      );

      await expectLater(
        PocketManifestVerifier(
          trustedKeys: <String, List<int>>{'known': publicKey.bytes},
          appId: 'test.app',
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        ).verify(signed),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            'manifest-signature',
          ),
        ),
      );
    });

    test('rejects a valid signature from an unknown key id', () async {
      final algorithm = Ed25519();
      final keyPair = await algorithm.newKeyPair();
      final payloadBytes = Uint8List.fromList(
        utf8.encode(jsonEncode(_manifestPayload())),
      );
      final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
      final signed = PocketSignedManifest.fromBytes(
        _envelopeBytes(
          keyId: 'not-trusted',
          payloadBytes: payloadBytes,
          signatureBytes: signature.bytes,
        ),
      );

      await expectLater(
        PocketManifestVerifier(
          trustedKeys: const <String, List<int>>{},
          appId: 'test.app',
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        ).verify(signed),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            'manifest-signature',
          ),
        ),
      );
    });
  });

  group('package artifact integrity', () {
    test(
      'does not promote a package after an entry blob is tampered',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'pocket-services-integrity-',
        );
        final algorithm = Ed25519();
        final keyPair = await algorithm.newKeyPair();
        final publicKey = await keyPair.extractPublicKey();
        final payload = _manifestPayload();
        final payloadBytes = Uint8List.fromList(
          utf8.encode(jsonEncode(payload)),
        );
        final signature = await algorithm.sign(payloadBytes, keyPair: keyPair);
        final signed = PocketSignedManifest.fromBytes(
          _envelopeBytes(
            keyId: 'known',
            payloadBytes: payloadBytes,
            signatureBytes: signature.bytes,
          ),
        );
        final transport = _MemoryTransport(<String, List<int>>{});
        final manifestUri = Uri.parse('http://127.0.0.1:39123/latest.json');
        final hashEntry = _sha256(<int>[1]);
        final hashPak = _sha256(<int>[2]);
        transport.responses[manifestUri.toString()] = signed.envelopeBytes;
        transport.responses[manifestUri
            .resolve('blobs/$hashEntry')
            .toString()] = <int>[
          1,
        ];
        transport.responses[manifestUri.resolve('blobs/$hashPak').toString()] =
            <int>[2];
        final store = PocketPackageStore(directory);
        final coordinator = PocketUpdateCoordinator(
          manifestUri: manifestUri,
          appId: 'test.app',
          trustedKeys: <String, List<int>>{'known': publicKey.bytes},
          store: store,
          transport: transport,
          maxRetries: 0,
          expectedRuntimeAbi: 'abi-v1',
          requireBytecode: true,
        );

        try {
          final prepared = await coordinator.prepare();
          await prepared.package.entryFile.writeAsBytes(<int>[9]);

          await expectLater(
            coordinator.commitHealthy(prepared),
            throwsA(
              isA<PocketPackageException>().having(
                (error) => error.code,
                'code',
                'cache-hash',
              ),
            ),
          );
          expect(
            await store
                .scoped('test.app')
                .active(verifier: coordinator.verifier),
            isNull,
          );
        } finally {
          coordinator.dispose();
          await directory.delete(recursive: true);
        }
      },
    );
  });

  group('plugin lifecycle and permission intersection', () {
    test(
      'deactivate revokes a provider and reactivation restores real calls',
      () async {
        final responses = <Map<String, dynamic>>[];
        final registry = PocketHostRegistry();
        final host = PocketHost(
          registry: registry,
          streams: PocketStreamBridge(send: (_, __) => true),
          allowedCapabilities: const <String>{'test.echo'},
          send: (method, params) {
            responses.add(<String, dynamic>{'method': method, ...params});
            return true;
          },
        );
        final plugin = _RecordingPlugin(
          id: 'test.echo.plugin',
          capability: 'test.echo',
        );
        final manager = PocketPluginManager(
          host: host,
          appId: 'test.app',
          sessionId: 'session-1',
        );
        manager.register(plugin);
        final session = PocketPluginSession(manager);

        try {
          final first = await session.mountGuest(
            required: const <String>['test.echo'],
            requestedPermissions: const <String>[],
          );
          expect(first.satisfied, isTrue);
          await _sendRequest(host, 'first', 'test.echo');
          expect(responses.last['ok'], isTrue);
          expect(responses.last['result'], 'first');
          expect(plugin.activateCalls, 1);

          await session.unmountGuest();
          expect(plugin.deactivateCalls, 1);
          await _sendRequest(host, 'revoked', 'test.echo');
          expect(responses.last['ok'], isFalse);
          expect((responses.last['error'] as Map)['code'], 'capability_denied');

          final second = await session.mountGuest(
            required: const <String>['test.echo'],
            requestedPermissions: const <String>[],
          );
          expect(second.satisfied, isTrue);
          await _sendRequest(host, 'second', 'test.echo');
          expect(responses.last['ok'], isTrue);
          expect(responses.last['result'], 'second');
          expect(plugin.activateCalls, 2);
        } finally {
          await session.dispose();
          host.dispose();
        }
        expect(plugin.deactivateCalls, 2);
      },
    );

    test(
      'rejects a required plugin whose permission was not declared',
      () async {
        final registry = PocketHostRegistry();
        final host = PocketHost(
          registry: registry,
          streams: PocketStreamBridge(send: (_, __) => true),
          allowedCapabilities: const <String>{'test.permissioned'},
          send: (_, __) => true,
        );
        final plugin = _RecordingPlugin(
          id: 'test.permission.plugin',
          capability: 'test.permissioned',
          permissions: const <String>{'network'},
        );
        final manager = PocketPluginManager(
          host: host,
          appId: 'test.app',
          sessionId: 'session-2',
          allowedPermissions: const <String>{'network'},
        );
        manager.register(plugin);
        final session = PocketPluginSession(manager);

        try {
          await expectLater(
            session.mountGuest(
              required: const <String>['test.permissioned'],
              requestedPermissions: const <String>[],
            ),
            throwsA(
              isA<PocketCapabilityException>().having(
                (error) => error.code,
                'code',
                'permission_not_declared',
              ),
            ),
          );
          expect(plugin.activateCalls, 0);
          expect(host.isAllowed('test.permissioned'), isFalse);
        } finally {
          await session.dispose();
          host.dispose();
        }
      },
    );

    test(
      'does not activate an optional provider with undeclared permissions',
      () async {
        final host = PocketHost(
          registry: PocketHostRegistry(),
          streams: PocketStreamBridge(send: (_, __) => true),
          allowedCapabilities: const <String>{'test.optional'},
          send: (_, __) => true,
        );
        final plugin = _RecordingPlugin(
          id: 'test.optional.plugin',
          capability: 'test.optional',
          permissions: const <String>{'network'},
        );
        final manager = PocketPluginManager(
          host: host,
          appId: 'test.app',
          sessionId: 'session-3',
          allowedPermissions: const <String>{'network'},
        );
        manager.register(plugin);
        final session = PocketPluginSession(manager);

        try {
          final availability = await session.mountGuest(
            required: const <String>[],
            optional: const <String>['test.optional'],
            requestedPermissions: const <String>[],
          );
          expect(availability.granted, isEmpty);
          expect(availability.unavailableOptional, contains('test.optional'));
          expect(plugin.activateCalls, 0);
          expect(host.isAllowed('test.optional'), isFalse);
        } finally {
          await session.dispose();
          host.dispose();
        }
      },
    );
  });
}

Map<String, dynamic> _manifestPayload({
  String version = '1.0.0',
  int build = 1,
}) {
  final entryHash = _sha256(<int>[1]);
  final pakHash = _sha256(<int>[2]);
  return <String, dynamic>{
    'schemaVersion': 1,
    'appId': 'test.app',
    'version': version,
    'build': build,
    'protocol': 1,
    'minHostVersion': 1,
    'entry': <String, dynamic>{'sha256': entryHash, 'size': 1},
    'entryFormat': 'quickjs-bytecode',
    'runtimeAbi': 'abi-v1',
    'pak': <String, dynamic>{
      'sha256': pakHash,
      'size': 1,
      'parts': <Map<String, dynamic>>[
        <String, dynamic>{'offset': 0, 'sha256': pakHash, 'size': 1},
      ],
    },
    'files': <Map<String, dynamic>>[
      <String, dynamic>{
        'sha256': entryHash,
        'size': 1,
        'url': 'blobs/$entryHash',
      },
      <String, dynamic>{'sha256': pakHash, 'size': 1, 'url': 'blobs/$pakHash'},
    ],
  };
}

Uint8List _envelopeBytes({
  required String keyId,
  required List<int> payloadBytes,
  required List<int> signatureBytes,
}) => Uint8List.fromList(
  utf8.encode(
    jsonEncode(<String, dynamic>{
      'keyId': keyId,
      'payload': base64Encode(payloadBytes),
      'signature': base64Encode(signatureBytes),
    }),
  ),
);

String _sha256(List<int> bytes) => crypto.sha256.convert(bytes).toString();

Future<void> _sendRequest(PocketHost host, String value, String capability) =>
    host.handle(
      PocketEvent(
        id: value,
        method: 'host.request',
        params: <String, dynamic>{
          'requestId': value,
          'capability': capability,
          'params': <String, dynamic>{'value': value},
        },
      ),
    );

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

final class _RecordingPlugin extends PocketPlugin {
  _RecordingPlugin({
    required this.id,
    required this.capability,
    this.permissions = const <String>{},
  });

  final String id;
  final String capability;
  final Set<String> permissions;
  int activateCalls = 0;
  int deactivateCalls = 0;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: id,
    version: '1.0.0',
    permissions: permissions,
    capabilities: <String, PocketPluginCapability>{
      capability: PocketPluginCapability(
        name: capability,
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(capability, (params) => params['value']);
  }

  @override
  Future<void> activate(PocketPluginContext context) async {
    activateCalls++;
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    deactivateCalls++;
  }
}
