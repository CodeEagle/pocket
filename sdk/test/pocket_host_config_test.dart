import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:crypto/crypto.dart';
import 'package:pocket_services/pocket_services.dart'
    show PocketCancellationToken, PocketUpdateCancellation;

Map<String, dynamic> _document({
  String baseUrl = 'https://updates.example.test/test',
}) => {
  'kind': 'pocket-editor-app-host',
  'schemaVersion': 1,
  'systemUI': 'pocket.host.demo',
  'updates': {
    'baseUrl': baseUrl,
    'hostVersion': '0.1.0',
    'packageVersion': '0.1.0',
    'keyId': 'editor-key',
    'publicKey': 'AA==',
    'namespace': 'editor_app',
    'debugHttpHosts': <String>['127.0.0.1'],
  },
  'release': {
    'appId': 'pocket.host.demo',
    'version': '0.1.0-test.3',
    'build': 3,
    'channel': 'test',
    'routeVersion': '0.1.0-test.3',
  },
  'applications': <String, dynamic>{
    'pocket.host.demo': {'appId': 'pocket.host.demo'},
    'pocket.demo.profile': {'appId': 'pocket.demo.profile'},
    'pocket.demo.lobby': {'appId': 'pocket.demo.lobby'},
  },
};

void main() {
  late Directory trustDirectory;

  setUp(() async {
    trustDirectory = await Directory.systemTemp.createTemp(
      'pocket-host-config-trust-',
    );
  });

  tearDown(() async {
    if (trustDirectory.existsSync()) {
      await trustDirectory.delete(recursive: true);
    }
  });

  test('one host document configures root and every mini app on one endpoint', () {
    final config = PocketHostConfig.fromJson(
      _document(),
      source: Uri.parse(
        'https://updates.example.test/pocket/0.1.0/app/0.1.0-test.3/host.json',
      ),
    );

    expect(config.systemUI.appId, 'pocket.host.demo');
    expect(
      config.applications.keys,
      containsAll(<String>['pocket.demo.profile', 'pocket.demo.lobby']),
    );
    expect(config.packageVersion, '0.1.0');
    expect(config.systemUI.updates!.packageVersion, '0.1.0');
    expect(
      config.systemUI.updates!.manifestUri(config.systemUI.appId).toString(),
      'https://updates.example.test/test/pocket/0.1.0/pocket.host.demo/latest.json',
    );
    expect(
      config.applications['pocket.demo.profile']!.updates!
          .manifestUri('pocket.demo.profile')
          .toString(),
      'https://updates.example.test/test/pocket/0.1.0/pocket.demo.profile/latest.json',
    );
    expect(config.applications['pocket.demo.profile']!.downloadOnOpen, isTrue);

    final packageKeys = _document();
    (packageKeys['applications']
        as Map<String, dynamic>)['pocket.demo.profile'] = <String, dynamic>{
      'appId': 'pocket.demo.profile',
      'keyId': 'profile-key',
      'publicKey': 'AQ==',
      'namespace': 'profile_updates',
    };
    final keyed = PocketHostConfig.fromJson(packageKeys);
    expect(
      keyed.applications['pocket.demo.profile']!.updates!.keyId,
      'profile-key',
    );
    expect(
      keyed.applications['pocket.demo.profile']!.updates!.packageVersion,
      '0.1.0',
    );
  });

  test(
    'host config rejects duplicate child ids and unsafe HTTP by default',
    () {
      final duplicate = _document()
        ..['applications'] = <String, dynamic>{
          'pocket.host.demo': {'appId': 'pocket.host.demo'},
          'pocket.demo.profile': {'appId': 'pocket.demo.profile'},
          'duplicate': {'appId': 'pocket.demo.profile'},
        };
      expect(() => PocketHostConfig.fromJson(duplicate), throwsFormatException);
      expect(
        () => PocketHostConfig.fromJson(
          _document(baseUrl: 'http://192.168.50.230:8791'),
        ),
        throwsFormatException,
      );
      final debug = PocketHostConfig.fromJson(
        _document(baseUrl: 'http://192.168.50.230:8791'),
        allowInsecureHttpHosts: const <String>{'192.168.50.230'},
      );
      expect(
        debug.systemUI.updates!.debugHttpHosts,
        contains('192.168.50.230'),
      );
    },
  );

  test('host URL fetch is one request and rejects redirects', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    final metadata = utf8.encode(
      '{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1,"build":1}',
    );
    final manifest = utf8.encode('{"requires":[],"optional":[],"build":1}');
    final base = 'http://127.0.0.1:${server.port}';
    final documentMap = _document(baseUrl: base);
    final applications = documentMap['applications'] as Map<String, dynamic>;
    for (final entry in applications.entries) {
      final package = Map<String, dynamic>.from(entry.value as Map);
      package['bootstrapAssets'] = <String, dynamic>{
        'assets/apps/${entry.key}/app.bytecode.json': {
          'url': '$base/metadata',
          'sha256': sha256.convert(metadata).toString(),
          'size': metadata.length,
        },
        'assets/apps/${entry.key}/guest-manifest.json': {
          'url': '$base/manifest',
          'sha256': sha256.convert(manifest).toString(),
          'size': manifest.length,
        },
      };
      applications[entry.key] = package;
    }
    final document = jsonEncode(documentMap);
    server.listen((request) {
      if (request.uri.path == '/redirect') {
        request.response
          ..statusCode = HttpStatus.movedTemporarily
          ..headers.set(HttpHeaders.locationHeader, '/host.json')
          ..close();
        return;
      }
      if (request.uri.path == '/metadata') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(metadata)
          ..close();
      } else if (request.uri.path == '/manifest') {
        request.response
          ..headers.contentType = ContentType.json
          ..add(manifest)
          ..close();
      } else {
        request.response
          ..headers.contentType = ContentType.json
          ..write(document)
          ..close();
      }
    });
    final loaded = await PocketHostConfig.load(
      Uri.parse('http://127.0.0.1:${server.port}/host.json'),
      allowInsecureHttpHosts: const <String>{'127.0.0.1'},
      trustAnchorDirectory: trustDirectory,
    );
    expect(loaded.applications.length, 2);
    expect(
      () => PocketHostConfig.load(
        Uri.parse('http://127.0.0.1:${server.port}/redirect'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
      ),
      throwsA(isA<HttpException>()),
    );
  });

  test(
    'cancellation before response headers aborts request but keeps client',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final client = HttpClient();
      final requestSeen = Completer<void>();
      var bootstrapRequests = 0;
      addTearDown(() async {
        await server.close(force: true);
        client.close(force: true);
      });
      server.listen((request) {
        if (request.uri.path == '/host.json') {
          bootstrapRequests++;
          if (!requestSeen.isCompleted) requestSeen.complete();
          // Keep the socket open without sending response headers.
          return;
        }
        if (request.uri.path == '/health') {
          request.response
            ..write('ok')
            ..close();
          return;
        }
        request.response
          ..statusCode = HttpStatus.notFound
          ..close();
      });

      final token = PocketCancellationToken();
      final progress = <PocketHostLoadProgress>[];
      final loading = PocketHostConfig.load(
        Uri.parse('http://127.0.0.1:${server.port}/host.json'),
        client: client,
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
        cancellation: token,
        onProgress: progress.add,
      );
      await requestSeen.future.timeout(const Duration(seconds: 2));
      token.cancel();
      await expectLater(
        loading.timeout(const Duration(seconds: 2)),
        throwsA(isA<PocketUpdateCancellation>()),
      );
      expect(progress, isEmpty);

      final health = await client.getUrl(
        Uri.parse('http://127.0.0.1:${server.port}/health'),
      );
      final healthResponse = await health.close();
      expect(await utf8.decoder.bind(healthResponse).join(), 'ok');
      expect(bootstrapRequests, 1);
    },
  );

  test(
    'cancellation while reading body stops progress and later bootstrap requests',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final client = HttpClient();
      final bodyStarted = Completer<void>();
      final releaseResponse = Completer<void>();
      var bootstrapRequests = 0;
      var progressAfterCancellation = 0;
      addTearDown(() async {
        if (!releaseResponse.isCompleted) releaseResponse.complete();
        await server.close(force: true);
        client.close(force: true);
      });
      server.listen((request) async {
        if (request.uri.path == '/host.json') {
          bootstrapRequests++;
          request.response.headers.contentType = ContentType.json;
        request.response
          ..bufferOutput = false
          ..contentLength = 1024;
          request.response.add(utf8.encode('{"kind":"'));
          await request.response.flush();
          if (!bodyStarted.isCompleted) bodyStarted.complete();
          await releaseResponse.future;
          try {
            await request.response.close();
          } on Object {
            // The client aborts this deliberately incomplete response.
          }
          return;
        }
        if (request.uri.path == '/health') {
          request.response
            ..write('ok')
            ..close();
          return;
        }
        request.response
          ..statusCode = HttpStatus.notFound
          ..close();
      });

      final token = PocketCancellationToken();
      final progress = <PocketHostLoadProgress>[];
      final loading = PocketHostConfig.load(
        Uri.parse('http://127.0.0.1:${server.port}/host.json'),
        client: client,
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
        cancellation: token,
        onProgress: (sample) {
          progress.add(sample);
          if (token.isCancelled) progressAfterCancellation++;
          if (sample.downloadedBytes > 0 && !token.isCancelled) token.cancel();
        },
      );
      await bodyStarted.future.timeout(const Duration(seconds: 2));
      await expectLater(
        loading.timeout(const Duration(seconds: 2)),
        throwsA(isA<PocketUpdateCancellation>()),
      );
      expect(progress, isNotEmpty);
      expect(progressAfterCancellation, 0);

      final health = await client.getUrl(
        Uri.parse('http://127.0.0.1:${server.port}/health'),
      );
      final healthResponse = await health.close();
      expect(await utf8.decoder.bind(healthResponse).join(), 'ok');
      expect(bootstrapRequests, 1);
    },
  );

  test(
    'fixed package index resolves immutable host descriptor and relative bootstrap',
    () async {
      final metadata = utf8.encode(
        '{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1,"build":1}',
      );
      final manifest = utf8.encode('{"requires":[],"optional":[],"build":1}');
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final base = 'http://127.0.0.1:${server.port}';
      final document = _document(baseUrl: base);
      final applications = document['applications'] as Map<String, dynamic>;
      for (final entry in applications.entries) {
        final package = Map<String, dynamic>.from(entry.value as Map);
        final prefix = entry.key == 'pocket.host.demo' ? 'root' : entry.key;
        package['bootstrapAssets'] = <String, dynamic>{
          'assets/apps/${entry.key}/app.bytecode.json': {
            'url': '../../bootstrap/$prefix/metadata',
            'sha256': sha256.convert(metadata).toString(),
            'size': metadata.length,
          },
          'assets/apps/${entry.key}/guest-manifest.json': {
            'url': '../../bootstrap/$prefix/manifest',
            'sha256': sha256.convert(manifest).toString(),
            'size': manifest.length,
          },
        };
        if (entry.key == 'pocket.host.demo') {
          package['payloadSha256'] = 'a' * 64;
        }
        applications[entry.key] = package;
      }
      final historicalDocument =
          jsonDecode(jsonEncode(document)) as Map<String, dynamic>;
      final historicalApplications =
          historicalDocument['applications'] as Map<String, dynamic>;
      (historicalApplications['pocket.host.demo']
              as Map<String, dynamic>)['payloadSha256'] =
          'b' * 64;
      final index = <String, dynamic>{
        'schemaVersion': 1,
        'kind': 'pocket-editor-package-index',
        'systemUI': 'pocket.host.demo',
        'rootAppId': 'pocket.host.demo',
        'latest': <String, dynamic>{
          'releaseId': 'test-release-1',
          'rootPayloadSha256': 'a' * 64,
          'hostConfigUrl': '/history/test-release-1/host.json',
        },
        'versions': <dynamic>[
          <String, dynamic>{
            'releaseId': 'old-release',
            'rootPayloadSha256': 'b' * 64,
            'hostConfigUrl': '/history/old-release/host.json',
          },
        ],
      };
      server.listen((request) {
        final path = request.uri.path;
        if (path == '/test/pocket/0.1.0/pocket.host.demo/latest.json') {
          request.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(index))
            ..close();
          return;
        }
        if (path == '/history/test-release-1/host.json') {
          request.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(document))
            ..close();
          return;
        }
        if (path == '/history/old-release/host.json') {
          request.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(historicalDocument))
            ..close();
          return;
        }
        final parts = path.split('/');
        final bytes = parts.length >= 4 && parts[1] == 'bootstrap'
            ? (parts.last == 'metadata' ? metadata : manifest)
            : null;
        if (bytes == null) {
          request.response.statusCode = HttpStatus.notFound;
        } else {
          request.response
            ..headers.contentType = ContentType.json
            ..add(bytes);
        }
        request.response.close();
      });
      final loaded = await PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
      );
      expect(loaded.systemUI.appId, 'pocket.host.demo');
      expect(loaded.applications.keys, contains('pocket.demo.profile'));
      expect(loaded.systemUI.downloadOnOpen, isTrue);
      expect(
        loaded.applications['pocket.demo.profile']!.downloadOnOpen,
        isTrue,
      );
      expect(loaded.systemUI.bootstrapMetadataJson, utf8.decode(metadata));
      expect(
        loaded.applications['pocket.demo.profile']!.bootstrapManifestJson,
        utf8.decode(manifest),
      );
      expect(
        loaded.source.path,
        '/test/pocket/0.1.0/pocket.host.demo/latest.json',
      );
      expect(
        loaded.systemUI.updates!.indexUrl,
        '$base/test/pocket/0.1.0/pocket.host.demo/latest.json',
      );
      expect(
        loaded.applications['pocket.demo.profile']!.updates!.indexUrl,
        '$base/test/pocket/0.1.0/pocket.demo.profile/latest.json',
      );
      final expectedNamespace = sha256
          .convert(
            utf8.encode(
              '${loaded.systemUI.updates!.indexUrl}\n'
              'pocket.demo.profile',
            ),
          )
          .toString()
          .substring(0, 24);
      expect(
        loaded.applications['pocket.demo.profile']!.updates!.namespace,
        'host_$expectedNamespace',
      );
      final mutableUpdates = document['updates'] as Map<String, dynamic>;
      mutableUpdates['baseUrl'] = '$base/stable';
      mutableUpdates['namespace'] = 'remote-controlled';
      final sameIndex = await PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
      );
      expect(
        sameIndex.systemUI.updates!.indexUrl,
        loaded.systemUI.updates!.indexUrl,
      );
      expect(
        sameIndex.applications['pocket.demo.profile']!.updates!.namespace,
        loaded.applications['pocket.demo.profile']!.updates!.namespace,
      );

      final historical = await PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        requiredRootPayloadSha256: 'b' * 64,
        trustAnchorDirectory: trustDirectory,
      );
      expect(historical.rootPayloadSha256, 'b' * 64);
      expect(historical.selectedCatalogEntry?.releaseId, 'old-release');
      expect(
        historical.systemUI.updates!.indexUrl,
        loaded.systemUI.updates!.indexUrl,
      );

      // Fixed-index descriptors cannot switch to a per-child release key.
      final historicalProfile =
          historicalDocument['applications'] as Map<String, dynamic>;
      (historicalProfile['pocket.demo.profile']
              as Map<String, dynamic>)['keyId'] =
          'profile-key';
      await expectLater(
        PocketHostConfig.load(
          Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          requiredRootPayloadSha256: 'b' * 64,
          trustAnchorDirectory: trustDirectory,
        ),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test(
    'host URL verifies bootstrap metadata before handing it to sessions',
    () async {
      final metadata = utf8.encode(
        '{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1}',
      );
      final manifest = utf8.encode('{"requires":[],"optional":[]}');
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final base = 'http://127.0.0.1:${server.port}';
      Map<String, dynamic> asset(String path, List<int> bytes) => {
        'url': '$base/$path',
        'sha256': sha256.convert(bytes).toString(),
        'size': bytes.length,
      };
      var document = _document(baseUrl: base);
      final applications = document['applications'] as Map<String, dynamic>;
      for (final entry in applications.entries) {
        final package = Map<String, dynamic>.from(entry.value as Map);
        package['bootstrapAssets'] = <String, dynamic>{
          'assets/apps/${entry.key}/app.bytecode.json': asset(
            'metadata',
            metadata,
          ),
          'assets/apps/${entry.key}/guest-manifest.json': asset(
            'manifest',
            manifest,
          ),
        };
        applications[entry.key] = package;
      }
      server.listen((request) {
        if (request.uri.path == '/host.json') {
          request.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(document))
            ..close();
          return;
        }
        final bytes = request.uri.path == '/metadata' ? metadata : manifest;
        request.response
          ..headers.contentType = ContentType.json
          ..add(bytes)
          ..close();
      });
      final client = HttpClient();
      addTearDown(client.close);
      final loaded = await PocketHostConfig.load(
        Uri.parse('$base/host.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        client: client,
        trustAnchorDirectory: trustDirectory,
      );
      expect(loaded.systemUI.bootstrapMetadataJson, utf8.decode(metadata));
      expect(
        loaded.applications['pocket.demo.profile']!.bootstrapManifestJson,
        utf8.decode(manifest),
      );
      final loadedAgain = await PocketHostConfig.load(
        Uri.parse('$base/host.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        client: client,
        trustAnchorDirectory: trustDirectory,
      );
      expect(loadedAgain.systemUI.updates!.keyId, 'editor-key');
      final loadedWithQuery = await PocketHostConfig.load(
        Uri.parse('$base/host.json?selector=another-release'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        client: client,
        trustAnchorDirectory: trustDirectory,
      );
      expect(loadedWithQuery.systemUI.appId, 'pocket.host.demo');
      // A new compatibility/version directory is selected by the signed
      // update protocol; it must not mint a new bootstrap trust anchor.
      (document['updates'] as Map<String, dynamic>)['packageVersion'] = '0.2.0';
      final loadedWithNewCompatibility = await PocketHostConfig.load(
        Uri.parse('$base/host.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        client: client,
        trustAnchorDirectory: trustDirectory,
      );
      expect(loadedWithNewCompatibility.packageVersion, '0.2.0');
      (document['updates'] as Map<String, dynamic>)['packageVersion'] = '0.1.0';
      document['systemUI'] = 'pocket.demo.profile';
      await expectLater(
        PocketHostConfig.load(
          Uri.parse('$base/host.json'),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          client: client,
          trustAnchorDirectory: trustDirectory,
        ),
        throwsA(isA<FormatException>()),
      );
      document['systemUI'] = 'pocket.host.demo';
      (document['updates'] as Map<String, dynamic>)['keyId'] = 'rotated-key';
      await expectLater(
        PocketHostConfig.load(
          Uri.parse('$base/host.json'),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          client: client,
          trustAnchorDirectory: trustDirectory,
        ),
        throwsA(isA<FormatException>()),
      );
      document['systemUI'] = 'pocket.host.demo';
      final updates = document['updates'] as Map<String, dynamic>;
      updates['keyId'] = 'editor-key';
      updates['trustRootKeyId'] = 'editor-root';
      updates['trustRootPublicKey'] = 'AA==';
      updates['trustPolicyUrl'] = '$base/trust-policy.json';
      await expectLater(
        PocketHostConfig.load(
          Uri.parse('$base/host.json'),
          allowInsecureHttpHosts: const <String>{'127.0.0.1'},
          client: client,
          trustAnchorDirectory: trustDirectory,
        ),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test(
    'bootstrap progress reports bytes from chunked index, descriptor and assets',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);
      final base = 'http://127.0.0.1:${server.port}';
      final metadata = utf8.encode(
        '{"runtimeAbi":"quickjs-bytecode-v1","bytecodeBytes":1,'
        '"padding":"${List<String>.filled(1536, 'm').join()}"}',
      );
      final manifest = utf8.encode(
        '{"requires":[],"optional":[],"padding":"${List<String>.filled(1024, 'g').join()}"}',
      );
      final descriptor = _document(baseUrl: base);
      final applications = descriptor['applications'] as Map<String, dynamic>;
      for (final entry in applications.entries) {
        final package = Map<String, dynamic>.from(entry.value as Map);
        package['bootstrapAssets'] = <String, dynamic>{
          'assets/apps/${entry.key}/app.bytecode.json': <String, Object>{
            'url': '/bootstrap/metadata',
            'sha256': sha256.convert(metadata).toString(),
            'size': metadata.length,
          },
          'assets/apps/${entry.key}/guest-manifest.json': <String, Object>{
            'url': '/bootstrap/manifest',
            'sha256': sha256.convert(manifest).toString(),
            'size': manifest.length,
          },
        };
        if (entry.key == 'pocket.host.demo') {
          package['payloadSha256'] = 'a' * 64;
        }
        applications[entry.key] = package;
      }
      final index = <String, dynamic>{
        'kind': 'pocket-editor-package-index',
        'schemaVersion': 1,
        'systemUI': 'pocket.host.demo',
        'latest': <String, dynamic>{
          'rootPayloadSha256': 'a' * 64,
          'hostConfigUrl': '/releases/root/host.json',
        },
      };
      final indexBytes = utf8.encode(jsonEncode(index));
      final descriptorBytes = utf8.encode(jsonEncode(descriptor));

      Future<void> writeChunked(HttpResponse response, List<int> body) async {
        response
          ..statusCode = HttpStatus.ok
          ..headers.contentType = ContentType.json
          ..headers.chunkedTransferEncoding = true;
        final first = body.length ~/ 3;
        final second = (body.length * 2) ~/ 3;
        for (final range in <(int, int)>[
          (0, first),
          (first, second),
          (second, body.length),
        ]) {
          response.add(body.sublist(range.$1, range.$2));
          await response.flush();
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        await response.close();
      }

      server.listen((request) async {
        final body = switch (request.uri.path) {
          '/test/pocket/0.1.0/pocket.host.demo/latest.json' => indexBytes,
          '/releases/root/host.json' => descriptorBytes,
          '/bootstrap/metadata' => metadata,
          '/bootstrap/manifest' => manifest,
          _ => null,
        };
        if (body == null) {
          request.response
            ..statusCode = HttpStatus.notFound
            ..close();
          return;
        }
        await writeChunked(request.response, body);
      });

      final progress = <PocketHostLoadProgress>[];
      final loaded = await PocketHostConfig.load(
        Uri.parse('$base/test/pocket/0.1.0/pocket.host.demo/latest.json'),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: trustDirectory,
        onProgress: progress.add,
      );
      expect(loaded.systemUI.appId, 'pocket.host.demo');
      expect(loaded.systemUI.bootstrapMetadataJson, utf8.decode(metadata));

      for (final stage in <String>['index', 'descriptor']) {
        final samples = progress
            .where((entry) => entry.stage == stage)
            .toList();
        final expectedLength = stage == 'index'
            ? indexBytes.length
            : descriptorBytes.length;
        expect(samples, isNotEmpty);
        expect(samples.first.downloadedBytes, 0);
        expect(samples.every((entry) => entry.totalBytes == null), isTrue);
        expect(samples.last.downloadedBytes, expectedLength);
      }

      final assetSamples = progress
          .where((entry) => entry.stage == 'bootstrapAsset')
          .toList();
      expect(assetSamples, isNotEmpty);
      expect(
        assetSamples.every(
          (entry) =>
              entry.totalBytes == metadata.length ||
              entry.totalBytes == manifest.length,
        ),
        isTrue,
      );
      expect(
        assetSamples.any(
          (entry) =>
              entry.downloadedBytes == metadata.length &&
              entry.totalBytes == metadata.length,
        ),
        isTrue,
      );
      expect(
        assetSamples.any(
          (entry) =>
              entry.downloadedBytes == manifest.length &&
              entry.totalBytes == manifest.length,
        ),
        isTrue,
      );
    },
  );
}
