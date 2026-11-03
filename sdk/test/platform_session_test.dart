import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart' show PocketEvent;
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_session.dart';
import 'package:pocket_services/pocket_services.dart';

final class _ProbePlugin extends PocketPlugin {
  _ProbePlugin({required this.capability, required this.backgroundSafe});

  final String capability;
  @override
  final bool backgroundSafe;
  int activateCount = 0;
  int deactivateCount = 0;
  int requestCount = 0;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'test.${capability.split('.').last}',
    version: '1.0.0',
    capabilities: {
      capability: PocketPluginCapability(
        name: capability,
        kind: PocketCapabilityKind.request,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(capability, (_) {
      requestCount++;
      return <String, Object?>{'accepted': true};
    });
  }

  @override
  void activate(PocketPluginContext context) {
    activateCount++;
  }

  @override
  void deactivate(PocketPluginContext context) {
    deactivateCount++;
  }
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory directory;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'pocket-sdk-platform-session-',
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      final name = utf8.decode(data!.buffer.asUint8List());
      final content = name.endsWith('metadata.json')
          ? <String, Object?>{
              'runtimeAbi': 'platform-session-test',
              'bytecodeBytes': 1,
              'build': 1,
              'version': '1.0.0',
            }
          : <String, Object?>{
              'capabilities': <String, Object?>{
                'requires': <String>['test.coordination', 'test.hardware'],
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
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  PocketAppConfig config({
    Iterable<PocketPluginFactory> plugins = const <PocketPluginFactory>[],
  }) => PocketAppConfig(
    appId: 'platform.session.test',
    metadataAsset: 'platform-session/metadata.json',
    manifestAsset: 'platform-session/manifest.json',
    pluginFactories: List<PocketPluginFactory>.from(plugins),
  );

  Future<void> request(PocketSession session, String capability) async {
    session.onEvent(
      PocketEvent(
        id: 'request-${capability.replaceAll('.', '-')}',
        method: 'host.request',
        params: {
          'requestId': 'request-${capability.replaceAll('.', '-')}',
          'capability': capability,
          'params': <String, dynamic>{},
        },
      ),
    );
    // PocketHost.handle is intentionally fire-and-forget at the Session
    // boundary. Two event turns cover its async provider guard and response.
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  test(
    'hidden session keeps background-safe coordination and revokes hardware',
    () async {
      final coordination = _ProbePlugin(
        capability: 'test.coordination',
        backgroundSafe: true,
      );
      final hardware = _ProbePlugin(
        capability: 'test.hardware',
        backgroundSafe: false,
      );
      final session = PocketSession(
        config: config(plugins: [(_) => coordination, (_) => hardware]),
      );
      try {
        await session.initialize();
        expect(coordination.activateCount, 1);
        expect(hardware.activateCount, 1);

        await session.setForeground(false);
        expect(session.foreground, isFalse);
        expect(session.controller.appActive, isFalse);
        expect(coordination.deactivateCount, 0);
        expect(hardware.deactivateCount, 1);

        await request(session, 'test.coordination');
        await request(session, 'test.hardware');
        expect(
          coordination.requestCount,
          1,
          reason: 'background-safe provider must remain callable while hidden',
        );
        expect(
          hardware.requestCount,
          0,
          reason: 'foreground-only provider must be revoked while hidden',
        );

        await session.setForeground(true);
        expect(session.foreground, isTrue);
        expect(session.controller.appActive, isTrue);
        expect(coordination.activateCount, 1);
        expect(hardware.activateCount, 2);

        await request(session, 'test.coordination');
        await request(session, 'test.hardware');
        expect(coordination.requestCount, 2);
        expect(hardware.requestCount, 1);
      } finally {
        await session.close();
      }
    },
  );

  test(
    'startup and health windows stay paused while hidden and resume after first frame',
    () async {
      final coordination = _ProbePlugin(
        capability: 'test.coordination',
        backgroundSafe: true,
      );
      final hardware = _ProbePlugin(
        capability: 'test.hardware',
        backgroundSafe: false,
      );
      final session = PocketSession(
        config: config(plugins: [(_) => coordination, (_) => hardware]),
      );
      try {
        // Managers prewarm by making the Session hidden before initialize.
        await session.setForeground(false);
        await session.initialize();
        expect(session.ready, isTrue);
        expect(session.foreground, isFalse);
        expect(session.stage, 'loading');
        expect(session.controller.appActive, isFalse);

        // A first frame arriving offstage must not start the health promotion
        // window (nor turn a hidden app into a ready foreground app).
        session.onReady(session.controller);
        await Future<void>.delayed(const Duration(milliseconds: 1100));
        expect(session.stage, 'loading');
        expect(session.foreground, isFalse);

        await session.setForeground(true);
        expect(session.foreground, isTrue);
        expect(session.controller.appActive, isTrue);
        // setForeground(true) reuses the already received first frame and
        // starts the normal one-second health window.
        await Future<void>.delayed(const Duration(milliseconds: 1100));
        expect(session.stage, 'not_configured');
      } finally {
        await session.close();
      }
    },
  );
}
