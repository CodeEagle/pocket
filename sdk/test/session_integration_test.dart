import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart'
    show PocketGuestSession, PocketGuestSessionState;

final class _ApplicationPlugin extends PocketPlugin {
  String? activatedApp;
  final disposed = Completer<void>();
  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'example.custom',
    version: '1.0.0',
    capabilities: {
      'example.echo': PocketPluginCapability(
        name: 'example.echo',
        kind: PocketCapabilityKind.request,
      ),
    },
  );
  @override
  void register(PocketPluginContext context) =>
      context.registerRequest('example.echo', (params) => params);
  @override
  void activate(PocketPluginContext context) {
    activatedApp = context.appId;
  }

  @override
  void dispose() {
    if (!disposed.isCompleted) disposed.complete();
  }
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory directory;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('pocket-sdk-session-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      final name = utf8.decode(data!.buffer.asUint8List());
      final content = name.endsWith('metadata.json')
          ? {
              'runtimeAbi': 'test-session-admission',
              'bytecodeBytes': 123,
              'build': 42,
              'version': '2.3.0',
            }
          : {
              'capabilities': {
                'requires': [
                  name.contains('missing') ? 'example.missing' : 'example.echo',
                ],
              },
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });
  });
  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    await directory.delete(recursive: true);
  });

  test(
    'external app identity and plugin factory enter the SDK admission lifecycle',
    () async {
      final plugin = _ApplicationPlugin();
      var created = 0;
      final session = PocketSession(
        config: PocketAppConfig(
          appId: 'external.sample',
          metadataAsset: 'external/metadata.json',
          manifestAsset: 'external/manifest.json',
          pluginFactories: [
            (controller) {
              created++;
              return plugin;
            },
          ],
        ),
      );
      try {
        await session.initialize();
        expect(session.ready, isTrue);
        expect(created, 1);
        expect(plugin.activatedApp, 'external.sample');
        expect(
          session.performance.logPath,
          contains('/pocket-performance/external.sample/'),
        );
        final status = await session.status();
        expect(status['configured'], isFalse);
        expect(status['activeBuild'], 42);
        expect(status['activeVersion'], '2.3.0');
        expect((status['versions'] as List).single['build'], 42);
        expect(session.runtimeInfo()['build'], 42);
        expect(session.runtimeInfo()['version'], '2.3.0');
      } finally {
        session.dispose();
        await plugin.disposed.future;
        await session.performance.dispose();
      }
    },
  );

  test(
    'external required capability is rejected before guest startup',
    () async {
      final session = PocketSession(
        config: const PocketAppConfig(
          appId: 'external.missing',
          metadataAsset: 'missing/metadata.json',
          manifestAsset: 'missing/manifest.json',
        ),
      );
      try {
        await expectLater(session.initialize(), throwsStateError);
        expect(session.ready, isFalse);
      } finally {
        session.dispose();
        await session.performance.dispose();
      }
    },
  );

  test(
    'close waits for initialization and disposes a coordinator created late',
    () async {
      final metadataRequested = Completer<void>();
      final releaseMetadata = Completer<void>();
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        final name = utf8.decode(data!.buffer.asUint8List());
        if (name.endsWith('slow-metadata.json')) {
          if (!metadataRequested.isCompleted) metadataRequested.complete();
          await releaseMetadata.future;
          return ByteData.sublistView(
            Uint8List.fromList(
              utf8.encode(
                jsonEncode(<String, dynamic>{
                  'runtimeAbi': 'test-session-admission',
                  'bytecodeBytes': 123,
                }),
              ),
            ),
          );
        }
        return ByteData.sublistView(
          Uint8List.fromList(
            utf8.encode(
              jsonEncode(<String, dynamic>{
                'capabilities': <String, dynamic>{'requires': <String>[]},
              }),
            ),
          ),
        );
      });
      addTearDown(() {
        if (!releaseMetadata.isCompleted) releaseMetadata.complete();
      });

      final session = PocketSession(
        config: const PocketAppConfig(
          appId: 'external.slow',
          metadataAsset: 'slow-metadata.json',
          manifestAsset: 'slow-manifest.json',
          updates: PocketUpdateConfig(
            url: 'http://127.0.0.1:1/manifest.json',
            keyId: 'test-key',
            publicKey: 'AA==',
          ),
        ),
      );
      final initializing = session.initialize();
      await metadataRequested.future;

      final closing = session.close();
      var closed = false;
      closing.then((_) => closed = true);
      await Future<void>.delayed(Duration.zero);
      expect(closed, isFalse);

      releaseMetadata.complete();
      await initializing;
      await closing;
      expect(session.ready, isFalse);
      expect(session.stage, 'initializing');
    },
  );

  testWidgets(
    'rebuilding PocketGuest with identical non-const PocketAppConfig preserves the same PocketSession instance',
    (tester) async {
      PocketAppConfig makeConfig() => PocketAppConfig(
        appId: 'external.rebuild',
        metadataAsset: 'external/metadata.json',
        manifestAsset: 'external/manifest.json',
        allowedPermissions: const {'test.perm'},
        additionalCapabilities: const {'test.cap'},
        updates: const PocketUpdateConfig(
          url: 'http://127.0.0.1:1/manifest.json',
          keyId: 'test-key',
          publicKey: 'AA==',
        ),
      );

      final config1 = makeConfig();
      final config2 = makeConfig();
      expect(identical(config1, config2), isFalse);
      expect(config1 == config2, isTrue);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PocketGuest(config: config1)),
        ),
      );

      final state1 = tester.state<PocketGuestSessionState>(
        find.byType(PocketGuestSession),
      );
      final session1 = state1.session;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PocketGuest(config: config2)),
        ),
      );

      final state2 = tester.state<PocketGuestSessionState>(
        find.byType(PocketGuestSession),
      );
      final session2 = state2.session;

      expect(identical(state1, state2), isTrue);
      expect(identical(session1, session2), isTrue);
    },
  );
}
