import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';

final class _RegistryCapturePlugin extends PocketPlugin {
  _RegistryCapturePlugin(this.onRegistered);

  final void Function(PocketHostRegistry registry) onRegistered;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.system-host-registry-capture',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{},
  );

  @override
  void register(PocketPluginContext context) => onRegistered(context.registry);
}

/// Exercises the real host/plugin/session path without importing Showcase
/// Dart code. The fixture is produced by
/// `sdk/scripts/tests/worker_recording_fixture.ts`; its ordinary text guest is
/// sufficient because PocketSystemHost mounts resident children Offstage from
/// `hostSurfaceResidents` even before a compositor surface is presented.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixtureRoot =
      Platform.environment['POCKET_RECORDING_WORKER_FIXTURE_DIR'];
  final skip = fixtureRoot == null;
  late Directory directory;
  late Map<String, Uint8List> assets;

  setUp(() {
    if (fixtureRoot == null) return;
    directory = Directory.systemTemp.createTempSync(
      'pocket-system-host-first-visible-',
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    final root = Directory('$fixtureRoot/assets');
    final bytecode = File('${root.path}/app.qjbc').readAsBytesSync();
    final pak = File('${root.path}/app.pak').readAsBytesSync();
    final metadata = Map<String, dynamic>.from(
      jsonDecode(File('${root.path}/app.bytecode.json').readAsStringSync())
          as Map,
    )..remove('worker');
    final rootManifest = <String, Object?>{
      'capabilities': <String, Object?>{
        'requires': <String>[
          'ui.compositor-surfaces',
          'system.runtime.configure',
          'system.runtime.create',
          'system.runtime.awaitFirstFrame',
          'system.runtime.destroy',
          'system.runtime.post',
          'system.runtime.respond',
        ],
      },
    };
    final childManifest = <String, Object?>{
      'capabilities': <String, Object?>{'requires': <String>[]},
    };
    assets = <String, Uint8List>{
      'test/root.qjbc': bytecode,
      'test/root.pak': pak,
      'test/root.metadata.json': Uint8List.fromList(
        utf8.encode(jsonEncode(metadata)),
      ),
      'test/root.manifest.json': Uint8List.fromList(
        utf8.encode(jsonEncode(rootManifest)),
      ),
      'test/child.qjbc': bytecode,
      'test/child.pak': pak,
      'test/child.metadata.json': Uint8List.fromList(
        utf8.encode(jsonEncode(metadata)),
      ),
      'test/child.manifest.json': Uint8List.fromList(
        utf8.encode(jsonEncode(childManifest)),
      ),
    };
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      final relative = requested.startsWith('assets/')
          ? requested.substring('assets/'.length)
          : requested;
      final bytes = assets[requested] ?? assets[relative];
      if (bytes == null) throw StateError('Unexpected test asset: $requested');
      return ByteData.sublistView(bytes);
    });
  });

  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    assets = <String, Uint8List>{};
    if (fixtureRoot != null && directory.existsSync()) {
      directory.deleteSync(recursive: true);
    }
  });

  testWidgets(
    'Offstage first-frame failure rejects awaitFirstFrame and permits destroy/recreate',
    (tester) async {
      final controller = PocketSystemHostController();
      final rootId = 'system.test.root';
      final childId = 'system.test.child';
      late PocketHostRegistry rootRegistry;

      Future<Object?> invokeSystem(
        String capability, [
        Map<String, dynamic> params = const <String, dynamic>{},
      ]) async {
        final registration = rootRegistry.registrationFor(capability);
        if (registration?.request == null) {
          throw StateError('System capability was not registered: $capability');
        }
        // Storage needs real I/O progress, while destruction waits for a
        // Flutter frame to unmount the resident surface. Drive both instead
        // of awaiting an endOfFrame Future inside runAsync.
        var completed = false;
        Object? result;
        Object? failure;
        StackTrace? failureStack;
        unawaited(
          Future<Object?>.sync(() => registration!.request!(params)).then(
            (value) {
              result = value;
              completed = true;
            },
            onError: (Object error, StackTrace stack) {
              failure = error;
              failureStack = stack;
              completed = true;
            },
          ),
        );
        for (var attempt = 0; attempt < 120 && !completed; attempt++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 1)),
          );
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(completed, isTrue, reason: '$capability did not finish');
        if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
        return result;
      }

      Future<Object?> startSystemWaiter(
        String capability,
        Map<String, dynamic> params,
      ) {
        final registration = rootRegistry.registrationFor(capability);
        if (registration?.request == null) {
          throw StateError('System capability was not registered: $capability');
        }
        // _awaitFirstFrame intentionally remains pending until the test
        // injects child.session.onError. Do not await it inside runAsync.
        return Future<Object?>.value(registration!.request!(params));
      }

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: PocketSystemHost(
              systemUI: PocketAppConfig(
                appId: rootId,
                bytecodeAsset: 'test/root.qjbc',
                pakAsset: 'test/root.pak',
                metadataAsset: 'test/root.metadata.json',
                manifestAsset: 'test/root.manifest.json',
                additionalCapabilities: const {'ui.compositor-surfaces'},
                compositorSurfaces: <String, int>{childId: 2},
                pluginFactories: <PocketPluginFactory>[
                  (_) => _RegistryCapturePlugin((registry) {
                    rootRegistry = registry;
                  }),
                ],
              ),
              applications: {
                childId: PocketAppConfig(
                  appId: childId,
                  bytecodeAsset: 'test/child.qjbc',
                  pakAsset: 'test/child.pak',
                  metadataAsset: 'test/child.metadata.json',
                  manifestAsset: 'test/child.manifest.json',
                ),
              },
              controller: controller,
            ),
          ),
        );

        Future<PocketSystemInstanceSnapshot> waitFor(
          bool Function(PocketSystemInstanceSnapshot) predicate,
        ) async {
          for (var attempt = 0; attempt < 120; attempt++) {
            for (final instance in controller.instances) {
              if (predicate(instance)) return instance;
            }
            // Asset loading and the native QuickJS bridge cross real async
            // boundaries; a FakeAsync-only pump can never advance those I/O
            // completions. Keep the frame pump serial while yielding briefly
            // through WidgetTester.runAsync.
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 1)),
            );
            await tester.pump(const Duration(milliseconds: 16));
          }
          fail(
            'Timed out waiting for host instance: ${controller.instances.map((e) => '${e.appId}:${e.firstFrameReady}:${e.isPresented}:${e.session.lastError}').toList()}',
          );
        }

        await waitFor((entry) => entry.isSystemUI && entry.ready);
        // Invoke the handler registered by PocketSystemHost's real
        // _SystemRuntimePlugin. The test plugin only exposes its formal host
        // registry; it does not add a production/debug API or bypass guards.
        await invokeSystem('system.runtime.configure', <String, dynamic>{
          'systemUI': rootId,
          'grants': <Map<String, Object?>>[
            {'appId': rootId, 'sharedNamespaces': <String>[]},
            {'appId': childId, 'sharedNamespaces': <String>[]},
          ],
        });
        final created = Map<String, dynamic>.from(
          await invokeSystem('system.runtime.create', <String, dynamic>{
                'appId': childId,
              })
              as Map,
        );
        final childInstanceId = created['instanceId'] as String;
        final child = await waitFor(
          (entry) =>
              entry.instanceId == childInstanceId &&
              entry.firstFrameReady &&
              !entry.isPresented,
        );
        expect(child.compositorFocused, isFalse);

        final awaitVisible = startSystemWaiter(
          'system.runtime.awaitFirstFrame',
          <String, dynamic>{
            'instanceId': childInstanceId,
            'generation': child.generation,
          },
        ).timeout(const Duration(seconds: 1));
        // Attach the matcher before injecting failure: completing the waiter
        // with an error must never become an unhandled Future error.
        final rejected = expectLater(awaitVisible, throwsA(isA<StateError>()));
        await child.session.onError(StateError('offstage child failed'));
        // Advance the bounded waiter timeout too: the pre-fix host must fail
        // this regression with TimeoutException instead of hanging the suite.
        await tester.pump(const Duration(seconds: 1));
        await rejected;

        await invokeSystem('system.runtime.destroy', <String, dynamic>{
          'instanceId': childInstanceId,
        });
        await expectLater(
          startSystemWaiter('system.runtime.awaitFirstFrame', <String, dynamic>{
            'instanceId': childInstanceId,
            'generation': child.generation,
          }),
          throwsA(isA<PocketCapabilityException>()),
        );
        await waitFor((entry) => entry.instanceId == 'system-ui');
        expect(
          controller.instances.any(
            (entry) => entry.instanceId == childInstanceId,
          ),
          isFalse,
        );

        final recreated = Map<String, dynamic>.from(
          await invokeSystem('system.runtime.create', <String, dynamic>{
                'appId': childId,
              })
              as Map,
        );
        final recreatedInstanceId = recreated['instanceId'] as String;
        expect(recreatedInstanceId, isNot(childInstanceId));
        final replacement = await waitFor(
          (entry) =>
              entry.instanceId == recreatedInstanceId &&
              entry.firstFrameReady &&
              !entry.isPresented,
        );
        expect(replacement.compositorFocused, isFalse);
        final destroyedWaiter = expectLater(
          startSystemWaiter('system.runtime.awaitFirstFrame', <String, dynamic>{
            'instanceId': recreatedInstanceId,
            'generation': replacement.generation,
          }),
          throwsA(isA<PocketCapabilityException>()),
        );
        await invokeSystem('system.runtime.destroy', <String, dynamic>{
          'instanceId': recreatedInstanceId,
        });
        await destroyedWaiter;
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
    skip: skip,
  );
}
