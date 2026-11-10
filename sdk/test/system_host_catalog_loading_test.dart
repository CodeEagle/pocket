import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart' show PocketView;
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

const _rootId = 'test.catalog-gate.root';
const _childId = 'test.catalog-gate.child';
const _abi = 'catalog-gate-abi';
const _chunkSize = 64 * 1024;

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final savedHttpOverrides = HttpOverrides.current;
  // Exercise the same HTTP transport used by app hosts against loopback.
  HttpOverrides.global = null;

  late Directory supportDirectory;
  late HttpServer server;
  late _SignedRelease release;
  late _ChunkGate chunkGate;
  late SimpleKeyPair keyPair;
  late SimplePublicKey publicKey;

  setUp(() async {
    supportDirectory = await Directory.systemTemp.createTemp(
      'pocket-system-host-catalog-gate-',
    );
    keyPair = await Ed25519().newKeyPair();
    publicKey = await keyPair.extractPublicKey();
    release = await _makeRelease(keyPair);
    chunkGate = _ChunkGate();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) => _serve(request, release, chunkGate));

    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      if (message == null) return null;
      final requested = utf8.decode(message.buffer.asUint8List());
      if (requested.endsWith('metadata.json')) {
        return _assetBytes(<String, Object?>{
          'runtimeAbi': _abi,
          'bytecodeBytes': 0,
          'build': 1,
          'version': '1.0.0',
        });
      }
      if (requested.endsWith('manifest.json')) {
        return _assetBytes(<String, Object?>{
          'capabilities': <String, Object?>{'requires': <String>[]},
        });
      }
      throw StateError('Unexpected catalog gate fixture asset: $requested');
    });
  });

  tearDown(() async {
    chunkGate.releaseAll();
    await server.close(force: true);
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (await supportDirectory.exists()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  tearDownAll(() {
    HttpOverrides.global = savedHttpOverrides;
  });

  testWidgets(
    'dynamic catalog gate shows session progress, errors, and leaves the outer host usable',
    (tester) async {
      final controller = PocketSystemHostController();
      final catalogGate = Completer<PocketSystemHostCatalog?>();
      final catalogEntered = Completer<void>();
      final config = PocketAppConfig(
        appId: _rootId,
        metadataAsset: 'catalog-gate/metadata.json',
        manifestAsset: 'catalog-gate/manifest.json',
        downloadOnOpen: true,
        updates: PocketUpdateConfig(
          url: 'http://127.0.0.1:${server.port}/manifest.json',
          keyId: 'catalog-gate-test',
          publicKey: base64Encode(publicKey.bytes),
        ),
        additionalCapabilities: const <String>{'ui.compositor-surfaces'},
        compositorSurfaces: const <String, int>{_childId: 17},
      );
      var outerActionCount = 0;

      Future<void> pumpUntil(
        bool Function() predicate, {
        Duration timeout = const Duration(seconds: 15),
      }) async {
        final attempts = (timeout.inMilliseconds / 16).ceil();
        for (var attempt = 0; attempt < attempts; attempt++) {
          if (predicate()) return;
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 5)),
          );
          await tester.pump(const Duration(milliseconds: 16));
        }
        fail(
          'Timed out waiting for catalog gate: '
          'sessions=${controller.instances.map((item) => '${item.session.stage}:${item.session.transferProgress?.downloadedBytes}/${item.session.transferProgress?.totalBytes}:${item.session.failure}').toList()}, '
          'requests=${chunkGate.requests}',
        );
      }

      final loader = (String? _) {
        if (!catalogEntered.isCompleted) catalogEntered.complete();
        return catalogGate.future;
      };

      try {
        await tester.pumpWidget(
          MaterialApp(
            // This HTTP/progress fixture intercepts flutter/assets. Keep the
            // outer action independent of Material's shader asset loading.
            theme: ThemeData(splashFactory: NoSplash.splashFactory),
            home: Scaffold(
              body: Column(
                children: [
                  Expanded(
                    child: PocketSystemHost(
                      systemUI: config,
                      applications: const <String, PocketAppConfig>{
                        _childId: PocketAppConfig(
                          appId: _childId,
                          metadataAsset: 'catalog-gate/child-metadata.json',
                          manifestAsset: 'catalog-gate/child-manifest.json',
                        ),
                      },
                      controller: controller,
                      catalogLoader: loader,
                    ),
                  ),
                  TextButton(
                    onPressed: () => outerActionCount++,
                    child: const Text('Outer action'),
                  ),
                ],
              ),
            ),
          ),
        );

        await pumpUntil(() {
          final session = controller.instances
              .where((instance) => instance.isSystemUI)
              .firstOrNull
              ?.session;
          final progress = session?.transferProgress;
          return progress?.stage == PocketUpdateStage.downloading &&
              progress!.downloadedBytes >= _chunkSize;
        });
        expect(
          find.byKey(const ValueKey<String>('pocket-startup-progress')),
          findsOneWidget,
        );
        expect(find.text('下载资源'), findsOneWidget);
        expect(find.textContaining('已下载 64 KB'), findsOneWidget);
        expect(find.byType(PocketView), findsNothing);

        chunkGate.releaseFirst.complete();
        await pumpUntil(() {
          final progress = controller.instances
              .where((instance) => instance.isSystemUI)
              .firstOrNull
              ?.session
              .transferProgress;
          return chunkGate.secondChunkSent.isCompleted &&
              (progress?.downloadedBytes ?? 0) >= 2 * _chunkSize;
        });
        expect(find.textContaining('已下载 128 KB'), findsOneWidget);
        expect(find.byType(PocketView), findsNothing);

        await tester.tap(find.text('Outer action'));
        await tester.pump();
        expect(outerActionCount, 1);

        chunkGate.releaseSecond.complete();
        await pumpUntil(() => catalogEntered.isCompleted);
        final session = controller.instances
            .where((instance) => instance.isSystemUI)
            .single
            .session;
        final expectedStage = switch (session.stage) {
          'index' => '读取应用索引',
          'descriptor' => '读取宿主配置',
          'bootstrapAsset' => '读取启动资源',
          'checking' => '检查更新',
          'downloading' => '下载资源',
          'verifying' || 'verified' => '校验资源',
          'loading' || 'ready' => '准备首帧',
          _ => '初始化',
        };
        expect(
          find.byKey(const ValueKey<String>('pocket-startup-progress')),
          findsNothing,
        );
        expect(find.text(expectedStage), findsNothing);
        // The previous compositor map is still the constructor map, but the
        // held signed-catalog boundary must prevent its PocketView from mounting.
        expect(find.byType(PocketView), findsNothing);

        catalogGate.completeError(StateError('catalog gate rejected'));
        await pumpUntil(() => session.failure != null);
        expect(find.textContaining('Pocket 启动失败'), findsOneWidget);
        expect(find.text(expectedStage), findsNothing);
        expect(find.byType(PocketView), findsNothing);
      } finally {
        chunkGate.releaseAll();
        if (!catalogGate.isCompleted) catalogGate.complete(null);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        final sessions = controller.instances
            .map((instance) => instance.session)
            .toList(growable: false);
        await tester.runAsync(() async {
          for (final session in sessions) {
            try {
              await session.close();
            } on Object {
              // The signed-package gate is intentionally failed in this test.
            }
          }
        });
        controller.dispose();
      }
    },
  );
}

Future<ByteData> _assetBytes(Map<String, Object?> value) async =>
    ByteData.sublistView(Uint8List.fromList(utf8.encode(jsonEncode(value))));

Future<_SignedRelease> _makeRelease(SimpleKeyPair keyPair) async {
  final entry = Uint8List.fromList(
    List<int>.generate(2 * _chunkSize, (index) => index % 251),
  );
  final pak = encodePocketPak(const <PocketPakBlobEntry>[
    PocketPakBlobEntry(key: 'bootstrap/catalog-gate', data: <int>[1, 2, 3]),
  ]);
  final entryHash = crypto.sha256.convert(entry).toString();
  final pakHash = crypto.sha256.convert(pak).toString();
  final payloadBytes = Uint8List.fromList(
    utf8.encode(
      jsonEncode(<String, Object?>{
        'schemaVersion': 1,
        'appId': _rootId,
        'version': '2.0.0',
        'build': 2,
        'signedAt': DateTime.now().millisecondsSinceEpoch ~/ 1000,
        'capabilities': <String, Object?>{'requires': <String>[]},
        'protocol': 1,
        'minHostVersion': 1,
        'entry': <String, Object?>{'sha256': entryHash, 'size': entry.length},
        'entryFormat': 'bytecode',
        'runtimeAbi': _abi,
        'pak': <String, Object?>{
          'sha256': pakHash,
          'size': pak.length,
          'parts': <Map<String, Object?>>[
            <String, Object?>{
              'offset': 0,
              'sha256': pakHash,
              'size': pak.length,
            },
          ],
        },
        'files': <Map<String, Object?>>[
          <String, Object?>{
            'sha256': entryHash,
            'size': entry.length,
            'url': 'blobs/$entryHash',
          },
          <String, Object?>{
            'sha256': pakHash,
            'size': pak.length,
            'url': 'blobs/$pakHash',
          },
        ],
      }),
    ),
  );
  final signed = await Ed25519().sign(payloadBytes, keyPair: keyPair);
  final envelope = Uint8List.fromList(
    utf8.encode(
      jsonEncode(<String, Object?>{
        'keyId': 'catalog-gate-test',
        'payload': base64Encode(payloadBytes),
        'signature': base64Encode(signed.bytes),
      }),
    ),
  );
  return _SignedRelease(
    envelope: envelope,
    entryHash: entryHash,
    pakHash: pakHash,
    entry: entry,
    pak: pak,
  );
}

Future<void> _serve(
  HttpRequest request,
  _SignedRelease release,
  _ChunkGate gate,
) async {
  final path = request.uri.path;
  gate.requests.add(path);
  final Uint8List? bytes;
  if (path == '/manifest.json') {
    bytes = release.envelope;
  } else if (path == '/blobs/${release.entryHash}') {
    bytes = release.entry;
  } else if (path == '/blobs/${release.pakHash}') {
    bytes = release.pak;
  } else {
    bytes = null;
  }
  if (bytes == null) {
    request.response.statusCode = HttpStatus.notFound;
    await request.response.close();
    return;
  }
  if (path == '/blobs/${release.entryHash}') {
    request.response.headers.chunkedTransferEncoding = true;
    try {
      for (var offset = 0; offset < bytes.length; offset += _chunkSize) {
        final end = (offset + _chunkSize).clamp(0, bytes.length).toInt();
        request.response.add(bytes.sublist(offset, end));
        await request.response.flush();
        if (offset == 0) {
          await gate.releaseFirst.future;
        } else if (offset == _chunkSize) {
          if (!gate.secondChunkSent.isCompleted)
            gate.secondChunkSent.complete();
          await gate.releaseSecond.future;
        }
      }
    } on Object {
      // The Session closes this stream if initialization is cancelled.
    } finally {
      try {
        await request.response.close();
      } on Object {
        // The client may already have cancelled the streamed response.
      }
    }
    return;
  }
  request.response
    ..contentLength = bytes.length
    ..add(bytes);
  await request.response.close();
}

final class _SignedRelease {
  const _SignedRelease({
    required this.envelope,
    required this.entryHash,
    required this.pakHash,
    required this.entry,
    required this.pak,
  });

  final Uint8List envelope;
  final String entryHash;
  final String pakHash;
  final Uint8List entry;
  final Uint8List pak;
}

final class _ChunkGate {
  final secondChunkSent = Completer<void>();
  final releaseFirst = Completer<void>();
  final releaseSecond = Completer<void>();
  final requests = <String>[];

  void releaseAll() {
    if (!releaseFirst.isCompleted) releaseFirst.complete();
    if (!releaseSecond.isCompleted) releaseSecond.complete();
  }
}
