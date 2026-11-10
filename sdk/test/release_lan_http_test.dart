import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

Map<String, dynamic> _hostDocument({
  String baseUrl = 'http://192.168.50.230:8791/test',
  List<String> debugHttpHosts = const <String>[
    '192.168.50.230',
    '192.168.50.231',
  ],
}) => <String, dynamic>{
  'kind': 'pocket-editor-app-host',
  'schemaVersion': 1,
  'systemUI': 'pocket.host.demo',
  'updates': <String, dynamic>{
    'baseUrl': baseUrl,
    'hostVersion': '0.1.0',
    'packageVersion': '0.1.0',
    'keyId': 'editor-key',
    'publicKey': 'AA==',
    'namespace': 'editor_app',
    'debugHttpHosts': debugHttpHosts,
  },
  'release': <String, dynamic>{
    'appId': 'pocket.host.demo',
    'version': '0.1.0-test.3',
    'build': 3,
    'channel': 'test',
    'routeVersion': '0.1.0-test.3',
  },
  'applications': <String, dynamic>{
    'pocket.host.demo': <String, dynamic>{'appId': 'pocket.host.demo'},
    'pocket.demo.profile': <String, dynamic>{'appId': 'pocket.demo.profile'},
    'pocket.demo.lobby': <String, dynamic>{'appId': 'pocket.demo.lobby'},
  },
};

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final savedHttpOverrides = HttpOverrides.current;

  late Directory tempDir;

  setUp(() async {
    HttpOverrides.global = null;
    tempDir = await Directory.systemTemp.createTemp('pocket-release-lan-http-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => tempDir.path,
    );
  });

  tearDown(() async {
    HttpOverrides.global = savedHttpOverrides;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    if (tempDir.existsSync()) {
      await tempDir.delete(recursive: true);
    }
  });

  test('PocketHostConfig.fromJson rejects unapproved HTTP by default, '
      'allows explicit LAN host, and propagates hosts to root and child updates '
      'without letting remote descriptor expand allowlist', () {
    expect(
      () => PocketHostConfig.fromJson(
        _hostDocument(baseUrl: 'http://192.168.50.230:8791/test'),
      ),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('unsafe baseUrl'),
        ),
      ),
    );

    expect(
      () => PocketHostConfig.fromJson(
        _hostDocument(baseUrl: 'http://192.168.50.230:8791/test'),
        allowInsecureHttpHosts: const <String>{'192.168.50.99'},
      ),
      throwsA(isA<FormatException>()),
    );

    final approved = PocketHostConfig.fromJson(
      _hostDocument(
        baseUrl: 'http://192.168.50.230:8791/test',
        debugHttpHosts: const <String>[
          '192.168.50.230',
          '192.168.50.231',
          'unapproved.lan.local',
        ],
      ),
      source: Uri.parse('http://192.168.50.230:8791/host.json'),
      allowInsecureHttpHosts: const <String>{'192.168.50.230'},
    );

    expect(approved.systemUI.updates!.debugHttpHosts, <String>[
      '192.168.50.230',
    ]);
    expect(
      approved.applications['pocket.demo.profile']!.updates!.debugHttpHosts,
      <String>['192.168.50.230'],
    );
    expect(
      approved.applications['pocket.demo.lobby']!.updates!.debugHttpHosts,
      <String>['192.168.50.230'],
    );
  });

  test('PocketHostConfig.load admits explicit LAN HTTP host and rejects '
      'unapproved descriptor or bootstrap asset hosts', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));

    const lanHost = '192.168.50.230';
    const lanPort = 8791;
    const base = 'http://$lanHost:$lanPort';
    final metadata = utf8.encode(
      '{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1,"build":1}',
    );
    final manifest = utf8.encode('{"requires":[],"optional":[],"build":1}');

    var descriptorUrl = '/releases/r1/host.json';
    var version2DescriptorUrl = '/releases/r2/host.json';
    var assetMetadataUrl = '$base/bootstrap/metadata';
    var remoteDebugHosts = <String>[lanHost, 'attacker.lan.local'];

    server.listen((request) {
      final path = request.uri.path;
      if (path == '/test/pocket/0.1.0/pocket.host.demo/latest.json') {
        final index = <String, dynamic>{
          'kind': 'pocket-editor-package-index',
          'schemaVersion': 1,
          'systemUI': 'pocket.host.demo',
          'latest': <String, dynamic>{
            'releaseId': 'r1',
            'rootPayloadSha256': 'a' * 64,
            'hostConfigUrl': descriptorUrl,
          },
          'versions': <Map<String, dynamic>>[
            <String, dynamic>{
              'releaseId': 'r2',
              'rootPayloadSha256': 'b' * 64,
              'hostConfigUrl': version2DescriptorUrl,
            },
          ],
        };
        request.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(index))
          ..close();
        return;
      }
      if (path == '/releases/r1/host.json' ||
          path == '/releases/r2/host.json') {
        final rootSha = path.endsWith('/r2/host.json') ? 'b' * 64 : 'a' * 64;
        final doc = _hostDocument(
          baseUrl: '$base/test',
          debugHttpHosts: remoteDebugHosts,
        );
        final apps = doc['applications'] as Map<String, dynamic>;
        for (final entry in apps.entries) {
          final pkg = Map<String, dynamic>.from(entry.value as Map);
          pkg['bootstrapAssets'] = <String, dynamic>{
            'assets/apps/${entry.key}/app.bytecode.json': <String, dynamic>{
              'url': assetMetadataUrl,
              'sha256': crypto.sha256.convert(metadata).toString(),
              'size': metadata.length,
            },
            'assets/apps/${entry.key}/guest-manifest.json': <String, dynamic>{
              'url': '$base/bootstrap/manifest',
              'sha256': crypto.sha256.convert(manifest).toString(),
              'size': manifest.length,
            },
          };
          if (entry.key == 'pocket.host.demo') {
            pkg['payloadSha256'] = rootSha;
          }
          apps[entry.key] = pkg;
        }
        request.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(doc))
          ..close();
        return;
      }
      if (path == '/bootstrap/metadata') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(metadata)
          ..close();
        return;
      }
      if (path == '/bootstrap/manifest') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(manifest)
          ..close();
        return;
      }
      request.response
        ..statusCode = HttpStatus.notFound
        ..close();
    });

    final client = _LoopbackRedirectHttpClient(server.port);
    addTearDown(() => client.close(force: true));

    final loaded = await PocketHostConfig.load(
      Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
      client: client,
      allowInsecureHttpHosts: const <String>{lanHost},
      trustAnchorDirectory: tempDir,
    );

    expect(loaded.systemUI.updates!.debugHttpHosts, <String>[lanHost]);
    expect(
      loaded.applications['pocket.demo.profile']!.updates!.debugHttpHosts,
      <String>[lanHost],
    );
    expect(
      loaded.applications['pocket.demo.lobby']!.updates!.debugHttpHosts,
      <String>[lanHost],
    );

    assetMetadataUrl = 'http://192.168.50.231:$lanPort/bootstrap/metadata';
    await expectLater(
      PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        client: client,
        allowInsecureHttpHosts: const <String>{lanHost},
        trustAnchorDirectory: tempDir,
      ),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('Bootstrap asset URL is outside the host config'),
        ),
      ),
    );
    assetMetadataUrl = '$base/bootstrap/metadata';

    descriptorUrl = 'http://192.168.50.231:$lanPort/releases/r1/host.json';
    await expectLater(
      PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        client: client,
        allowInsecureHttpHosts: const <String>{lanHost},
        trustAnchorDirectory: tempDir,
      ),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('Pocket host descriptor URL is outside the host config'),
        ),
      ),
    );
    descriptorUrl = '/releases/r1/host.json';

    HttpOverrides.global = _LoopbackHttpOverrides(server.port);
    final defaultHost = PocketSystemHost.fromHostConfig(config: loaded);
    expect(defaultHost.catalogLoader, isNotNull);

    final sameCatalog = await defaultHost.catalogLoader!('a' * 64);
    expect(sameCatalog?.rootPayloadSha256, 'a' * 64);

    final reloadedCatalog = await defaultHost.catalogLoader!('b' * 64);
    expect(reloadedCatalog?.rootPayloadSha256, 'b' * 64);
    expect(reloadedCatalog?.systemUI.updates?.debugHttpHosts, <String>[
      lanHost,
    ]);
    expect(
      reloadedCatalog
          ?.applications['pocket.demo.profile']
          ?.updates
          ?.debugHttpHosts,
      <String>[lanHost],
    );

    version2DescriptorUrl =
        'http://192.168.50.231:$lanPort/releases/r2/host.json';
    await expectLater(
      defaultHost.catalogLoader!('b' * 64),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('Pocket host descriptor URL is outside the host config'),
        ),
      ),
    );
    version2DescriptorUrl = '/releases/r2/host.json';

    var customReloadRootSha = '';
    final customHost = PocketSystemHost.fromHostConfig(
      config: loaded,
      reloadHostConfig: (rootPayloadSha256) async {
        customReloadRootSha = rootPayloadSha256 ?? '';
        return loaded;
      },
    );
    final customCatalog = await customHost.catalogLoader!('c' * 64);
    expect(customReloadRootSha, 'c' * 64);
    expect(customCatalog?.rootPayloadSha256, 'a' * 64);
  });

  test('PocketSession forwards configured debugHttpHosts to coordinator and '
      'rejects unapproved LAN HTTP hosts', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));

    const lanHost = '192.168.50.230';
    final keyPair = await Ed25519().newKeyPair();
    final publicKey = await keyPair.extractPublicKey();
    const abi = 'release-lan-http-abi';
    const keyId = 'release-lan-key';

    final entry = Uint8List.fromList(<int>[1, 2, 3, 4]);
    final pak = Uint8List.fromList(List<int>.filled(32, 7));
    final entryHash = crypto.sha256.convert(entry).toString();
    final pakHash = crypto.sha256.convert(pak).toString();

    // Sign manifests for root and child apps.
    Future<Uint8List> makeEnvelope(String appId) async {
      final payload = <String, dynamic>{
        'schemaVersion': 1,
        'appId': appId,
        'version': '2.0.0',
        'build': 2,
        'signedAt': DateTime.now().millisecondsSinceEpoch ~/ 1000,
        'capabilities': const <String, dynamic>{'requires': <String>[]},
        'protocol': 1,
        'minHostVersion': 1,
        'entry': <String, dynamic>{'sha256': entryHash, 'size': entry.length},
        'entryFormat': 'bytecode',
        'runtimeAbi': abi,
        'pak': <String, dynamic>{
          'sha256': pakHash,
          'size': pak.length,
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{
              'offset': 0,
              'sha256': pakHash,
              'size': pak.length,
            },
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
      final sig = await Ed25519().sign(payloadBytes, keyPair: keyPair);
      return Uint8List.fromList(
        utf8.encode(
          jsonEncode(<String, dynamic>{
            'keyId': keyId,
            'payload': base64Encode(payloadBytes),
            'signature': base64Encode(sig.bytes),
          }),
        ),
      );
    }

    final rootEnvelope = await makeEnvelope('pocket.host.demo');
    final childEnvelope = await makeEnvelope('pocket.demo.profile');

    server.listen((request) async {
      final path = request.uri.path;
      if (path.endsWith('/pocket.host.demo/latest.json')) {
        request.response
          ..contentLength = rootEnvelope.length
          ..add(rootEnvelope);
        await request.response.close();
        return;
      }
      if (path.endsWith('/pocket.demo.profile/latest.json')) {
        request.response
          ..contentLength = childEnvelope.length
          ..add(childEnvelope);
        await request.response.close();
        return;
      }
      if (path.endsWith('/blobs/$entryHash')) {
        request.response
          ..contentLength = entry.length
          ..add(entry);
        await request.response.close();
        return;
      }
      if (path.endsWith('/blobs/$pakHash')) {
        request.response
          ..contentLength = pak.length
          ..add(pak);
        await request.response.close();
        return;
      }
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
    });

    HttpOverrides.global = _LoopbackHttpOverrides(server.port);

    final baseUrl = 'http://$lanHost:${server.port}/test';
    final rawHostDoc = _hostDocument(
      baseUrl: baseUrl,
      debugHttpHosts: const <String>[lanHost],
    );
    (rawHostDoc['updates'] as Map<String, dynamic>)['keyId'] = keyId;
    (rawHostDoc['updates'] as Map<String, dynamic>)['publicKey'] = base64Encode(
      publicKey.bytes,
    );

    const bootstrapMeta =
        '{"runtimeAbi":"$abi","version":"1.0.0","build":1,"bytecodeBytes":0}';
    const bootstrapManifest = '{"requires":[],"optional":[],"build":1}';

    final hostConfig = PocketHostConfig.fromJson(
      rawHostDoc,
      source: Uri.parse('$baseUrl/host.json'),
      allowInsecureHttpHosts: const <String>{lanHost},
    );

    final rootAppConfig = hostConfig.systemUI.copyWith(
      downloadOnOpen: true,
      bootstrapMetadataJson: bootstrapMeta,
      bootstrapManifestJson: bootstrapManifest,
    );
    final childAppConfig = hostConfig.applications['pocket.demo.profile']!
        .copyWith(
          downloadOnOpen: true,
          bootstrapMetadataJson: bootstrapMeta,
          bootstrapManifestJson: bootstrapManifest,
        );

    final rootSession = PocketSession(config: rootAppConfig);
    final childSession = PocketSession(config: childAppConfig);
    try {
      await rootSession.initialize();
      expect(rootSession.active?.version, '2.0.0');
      expect(rootSession.active?.build, 2);

      await childSession.initialize();
      expect(childSession.active?.version, '2.0.0');
      expect(childSession.active?.build, 2);
    } finally {
      await rootSession.close();
      await childSession.close();
    }

    // Unapproved HTTP host in PocketSession must be rejected by coordinator.
    final unapprovedConfig = PocketAppConfig(
      appId: 'pocket.demo.profile',
      downloadOnOpen: true,
      bootstrapMetadataJson: bootstrapMeta,
      bootstrapManifestJson: bootstrapManifest,
      updates: PocketUpdateConfig(
        url:
            'http://unapproved.lan.local:${server.port}/test/pocket/0.1.0/pocket.demo.profile/latest.json',
        keyId: keyId,
        publicKey: base64Encode(publicKey.bytes),
        namespace: 'unapproved_ns',
        debugHttpHosts: const <String>[lanHost],
      ),
    );
    final unapprovedSession = PocketSession(config: unapprovedConfig);
    try {
      await expectLater(
        unapprovedSession.initialize(),
        throwsA(
          isA<PocketPackageException>().having(
            (e) => e.code,
            'code',
            'manifest-url',
          ),
        ),
      );
    } finally {
      try {
        await unapprovedSession.close();
      } on Object {
        // Expected initialization error on close.
      }
    }
  });
}

final class _LoopbackHttpOverrides extends HttpOverrides {
  _LoopbackHttpOverrides(this.port);

  final int port;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _LoopbackRedirectHttpClient(port, inner: super.createHttpClient(context));
}

final class _LoopbackRedirectHttpClient implements HttpClient {
  _LoopbackRedirectHttpClient(this.loopbackPort, {HttpClient? inner})
    : _inner = inner ?? HttpClient();

  final int loopbackPort;
  final HttpClient _inner;

  Uri _map(Uri url) => url.replace(
    host: InternetAddress.loopbackIPv4.address,
    port: loopbackPort,
  );

  @override
  Future<HttpClientRequest> getUrl(Uri url) => _inner.getUrl(_map(url));

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) =>
      _inner.openUrl(method, _map(url));

  @override
  void close({bool force = false}) => _inner.close(force: force);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
