import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_compositor.dart';
import 'package:pocket_flutter/src/pocket_memory_limits.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';
import 'package:pocket_services/pocket_services.dart';

final class _RegistryCapturePlugin extends PocketPlugin {
  _RegistryCapturePlugin(this.onRegistered);

  final void Function(PocketHostRegistry registry) onRegistered;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: 'test.pocket-system-host-registry-capture',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{},
  );

  @override
  void register(PocketPluginContext context) => onRegistered(context.registry);
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const rootId = 'system.test.root';
  const childId = 'system.test.child';
  const emptyMemoryChildId = 'system.test.empty-memory-child';
  late Directory directory;

  setUp(() {
    directory = Directory.systemTemp.createTempSync('pocket-system-host-unit-');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      final Object content;
      if (requested.endsWith('metadata.json')) {
        content = <String, Object?>{
          'runtimeAbi': 'system-host-unit-abi',
          'bytecodeBytes': 1,
          'build': 1,
          'version': '1.0.0',
        };
      } else if (requested.contains('root.manifest.json')) {
        content = <String, Object?>{
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
      } else {
        content = <String, Object?>{
          'capabilities': <String, Object?>{'requires': <String>[]},
        };
      }
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
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
    if (directory.existsSync()) {
      directory.deleteSync(recursive: true);
    }
  });

  Future<Object?> invokeSystem(
    WidgetTester tester,
    PocketHostRegistry rootRegistry,
    String capability, [
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    final registration = rootRegistry.registrationFor(capability);
    if (registration?.request == null) {
      throw StateError('System capability was not registered: $capability');
    }
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
    for (var attempt = 0; attempt < 60 && !completed; attempt++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(completed, isTrue, reason: '$capability did not finish');
    if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
    return result;
  }

  Future<PocketSystemInstanceSnapshot> waitFor(
    WidgetTester tester,
    PocketSystemHostController controller,
    bool Function(PocketSystemInstanceSnapshot) predicate,
  ) async {
    for (var attempt = 0; attempt < 60; attempt++) {
      for (final instance in controller.instances) {
        if (predicate(instance)) return instance;
      }
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
    fail('Timed out waiting for host instance');
  }

  testWidgets(
    'awaitFirstFrame throws when a runtime fails after producing an Offstage frame and then becoming visible',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;

      try {
        // Zero-sized host constraints keep PocketView in its pre-start state
        // while exercising the real PocketSystemHost session/plugin lifecycle.
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
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
            ),
          ),
        );

        await waitFor(tester, controller, (e) => e.isSystemUI && e.ready);
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.storage.batch',
          <String, dynamic>{
            'appId': rootId,
            'operations': <Map<String, Object?>>[
              {'type': 'set', 'key': 'slot.a', 'value': 'chapter-a'},
              {'type': 'set', 'key': 'slot.b', 'value': 'chapter-b'},
            ],
          },
        );
        expect(
          await invokeSystem(
            tester,
            rootRegistry,
            'system.storage.get',
            <String, dynamic>{'appId': rootId, 'key': 'slot.a'},
          ),
          'chapter-a',
        );
        await expectLater(
          invokeSystem(
            tester,
            rootRegistry,
            'system.storage.batch',
            <String, dynamic>{
              'appId': rootId,
              'operations': <Map<String, Object?>>[
                {'type': 'set', 'key': 'slot.a', 'value': 'must-not-commit'},
                {'type': 'remove', 'key': 'slot.a'},
              ],
            },
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'duplicate_storage_key',
            ),
          ),
        );
        expect(
          await invokeSystem(
            tester,
            rootRegistry,
            'system.storage.get',
            <String, dynamic>{'appId': rootId, 'key': 'slot.a'},
          ),
          'chapter-a',
          reason:
              'invalid native batches must leave the complete old bucket intact',
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstanceId = created['instanceId'] as String;
        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );

        var notifications = 0;
        void observeFacts() => notifications++;
        controller.addListener(observeFacts);
        rootGuest.onFirstFrame!();
        expect(notifications, 1, reason: 'new first-frame facts must publish');
        final published = controller.instances;
        rootGuest.onFirstFrame!();
        expect(notifications, 1, reason: 'identical facts must not republish');
        expect(controller.instances, same(published));
        controller.removeListener(observeFacts);

        // Child produces an Offstage first frame while its compositor slot is hidden.
        const offstageSlot = PocketCompositorSlot(
          surfaceHandle: 2,
          bounds: Rect.zero,
          visibleClip: Rect.zero,
          logicalViewport: Size(120, 120),
          visible: false,
          focused: false,
          drawIndex: 0,
        );
        final offstageChild =
            rootGuest.hostSurfaceBuilder!(offstageSlot) as PocketGuestSession;
        final stableOffstageChild =
            rootGuest.hostSurfaceBuilder!(offstageSlot) as PocketGuestSession;
        expect(
          stableOffstageChild.geometryRevision,
          offstageChild.geometryRevision,
          reason: 'unchanged slots must not schedule duplicate geometry work',
        );
        offstageChild.onFirstFrame!();

        final childAfterOffstageFrame = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(childAfterOffstageFrame.firstFrameReady, isTrue);
        expect(childAfterOffstageFrame.isPresented, isFalse);

        // Child fails while Offstage, then its compositor slot becomes visible.
        final beforeFailure = notifications;
        controller.addListener(observeFacts);
        await childAfterOffstageFrame.session.onError(
          StateError('failed after offstage frame'),
        );
        expect(
          notifications,
          greaterThan(beforeFailure),
          reason: 'live session failures must still notify host observers',
        );
        controller.removeListener(observeFacts);
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.fromLTWH(0, 0, 120, 120),
                    visibleClip: Rect.fromLTWH(0, 0, 120, 120),
                    logicalViewport: Size(120, 120),
                    visible: true,
                    focused: true,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        expect(
          visibleChild.geometryRevision,
          greaterThan(offstageChild.geometryRevision),
          reason: 'a moved/visible slot must invalidate child geometry',
        );
        await tester.pump();

        final awaitRegistration = rootRegistry.registrationFor(
          'system.runtime.awaitFirstFrame',
        )!;
        await expectLater(
          Future<Object?>.sync(
            () => awaitRegistration.request!(<String, dynamic>{
              'instanceId': childInstanceId,
              'generation': childAfterOffstageFrame.generation,
            }),
          ),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('failed after offstage frame'),
            ),
          ),
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets(
    'reloaded generation failure before first frame rejects both firstFrame and awaitFirstFrame',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: const <String, PocketAppConfig>{
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
            ),
          ),
        );

        await waitFor(tester, controller, (e) => e.isSystemUI && e.ready);
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstanceId = created['instanceId'] as String;
        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );

        // Generation 0 produces its first frame so hasEverProducedFrame is true.
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.fromLTWH(0, 0, 120, 120),
                    visibleClip: Rect.fromLTWH(0, 0, 120, 120),
                    logicalViewport: Size(120, 120),
                    visible: true,
                    focused: true,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        visibleChild.onFirstFrame!();
        await tester.pump();

        final gen0Snapshot = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(gen0Snapshot.generation, 0);
        expect(gen0Snapshot.firstFrameReady, isTrue);
        await gen0Snapshot.firstFrame;

        // Simulate a reload into generation 1 before any frame is produced.
        gen0Snapshot.session.generation = 1;
        await gen0Snapshot.session.setForeground(false);

        final gen1Snapshot = controller.instances.singleWhere(
          (entry) => entry.instanceId == childInstanceId,
        );
        expect(gen1Snapshot.generation, 1);
        expect(gen1Snapshot.firstFrameReady, isFalse);
        expect(gen1Snapshot.firstFrame, isNotNull);

        final awaitRegistration = rootRegistry.registrationFor(
          'system.runtime.awaitFirstFrame',
        )!;
        final awaitFirstVisible = Future<Object?>.value(
          awaitRegistration.request!(<String, dynamic>{
            'instanceId': childInstanceId,
            'generation': 1,
          }),
        );
        final firstFrameRejected = expectLater(
          gen1Snapshot.firstFrame,
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('reloaded generation failed'),
            ),
          ),
        );
        final awaitFirstVisibleRejected = expectLater(
          awaitFirstVisible,
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              contains('reloaded generation failed'),
            ),
          ),
        );

        await gen1Snapshot.session.onError(
          StateError('reloaded generation failed'),
        );
        await firstFrameRejected;
        await awaitFirstVisibleRejected;
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );

  testWidgets('runtime memory requests cannot exceed trusted host limits', (
    tester,
  ) async {
    final controller = PocketSystemHostController();
    late PocketHostRegistry rootRegistry;
    const childLimits = PocketMemoryLimits(
      heapLimitBytes: 128 * 1024,
      maxPakBytes: 8 * 1024 * 1024,
    );

    try {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: SizedBox.shrink(
              child: PocketSystemHost(
                systemUI: PocketAppConfig(
                  appId: rootId,
                  bytecodeAsset: 'test/root.qjbc',
                  pakAsset: 'test/root.pak',
                  metadataAsset: 'test/root.metadata.json',
                  manifestAsset: 'test/root.manifest.json',
                  additionalCapabilities: const {'ui.compositor-surfaces'},
                  compositorSurfaces: const <String, int>{
                    childId: 2,
                    emptyMemoryChildId: 3,
                  },
                  pluginFactories: <PocketPluginFactory>[
                    (_) => _RegistryCapturePlugin((registry) {
                      rootRegistry = registry;
                    }),
                  ],
                ),
                applications: const <String, PocketAppConfig>{
                  childId: PocketAppConfig(
                    appId: childId,
                    bytecodeAsset: 'test/child.qjbc',
                    pakAsset: 'test/child.pak',
                    metadataAsset: 'test/child.metadata.json',
                    manifestAsset: 'test/child.manifest.json',
                    memoryLimits: childLimits,
                  ),
                  emptyMemoryChildId: PocketAppConfig(
                    appId: emptyMemoryChildId,
                    bytecodeAsset: 'test/child.qjbc',
                    pakAsset: 'test/child.pak',
                    metadataAsset: 'test/child.metadata.json',
                    manifestAsset: 'test/child.manifest.json',
                    memoryLimits: childLimits,
                  ),
                },
                controller: controller,
              ),
            ),
          ),
        ),
      );

      await waitFor(
        tester,
        controller,
        (entry) => entry.isSystemUI && entry.ready,
      );
      await invokeSystem(
        tester,
        rootRegistry,
        'system.runtime.configure',
        <String, dynamic>{
          'systemUI': rootId,
          'grants': <Map<String, Object?>>[
            {'appId': rootId, 'sharedNamespaces': <String>[]},
            {'appId': childId, 'sharedNamespaces': <String>[]},
            {'appId': emptyMemoryChildId, 'sharedNamespaces': <String>[]},
          ],
        },
      );

      final createRegistration = rootRegistry.registrationFor(
        'system.runtime.create',
      )!;
      await expectLater(
        Future<Object?>.sync(
          () => createRegistration.request!(<String, dynamic>{
            'appId': childId,
            'memory': <String, dynamic>{
              'heapLimitBytes': childLimits.heapLimitBytes! + 1,
            },
          }),
        ),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'memory_limit_denied',
          ),
        ),
      );
      expect(
        controller.instances.where((entry) => entry.appId == childId),
        isEmpty,
        reason:
            'an over-limit request must be rejected before runtime creation',
      );

      final admitted = Map<String, dynamic>.from(
        await invokeSystem(
              tester,
              rootRegistry,
              'system.runtime.create',
              <String, dynamic>{
                'appId': childId,
                'memory': <String, dynamic>{
                  'heapLimitBytes': 64 * 1024,
                  'maxPakBytes': 1,
                },
              },
            )
            as Map,
      );
      expect(admitted['memory'], <String, int>{
        'heapLimitBytes': 64 * 1024,
        'maxPakBytes': 1,
      });
      final admittedInstance = await waitFor(
        tester,
        controller,
        (entry) => entry.appId == childId && entry.ready,
      );
      expect(
        admittedInstance.session.memoryLimits,
        equals(
          const PocketMemoryLimits(heapLimitBytes: 64 * 1024, maxPakBytes: 1),
        ),
      );

      final defaulted = Map<String, dynamic>.from(
        await invokeSystem(
              tester,
              rootRegistry,
              'system.runtime.create',
              <String, dynamic>{'appId': emptyMemoryChildId},
            )
            as Map,
      );
      expect(defaulted['memory'], <String, int>{
        'heapLimitBytes': childLimits.heapLimitBytes!,
        'maxPakBytes': childLimits.maxPakBytes!,
      });
      final defaultedInstance = await waitFor(
        tester,
        controller,
        (entry) => entry.appId == emptyMemoryChildId && entry.ready,
      );
      expect(defaultedInstance.session.memoryLimits, equals(childLimits));
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      controller.dispose();
    }
  });

  testWidgets(
    'child image provider stays app-scoped and capture opt-in survives hide/resume',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      late PocketHostRegistry childRegistry;
      const imageCapabilities = <String>[
        'platform.images.capture',
        'platform.images.read',
        'platform.images.list',
        'platform.images.remove',
      ];
      final childConfig = PocketAppConfig(
        appId: childId,
        bytecodeAsset: 'test/child.qjbc',
        pakAsset: 'test/child.pak',
        metadataAsset: 'test/child.metadata.json',
        manifestAsset: 'test/child.manifest.json',
        bootstrapManifestJson: jsonEncode(<String, Object?>{
          'capabilities': <String, Object?>{'requires': imageCapabilities},
        }),
        pluginFactories: <PocketPluginFactory>[
          (_) => _RegistryCapturePlugin((registry) {
            childRegistry = registry;
          }),
        ],
      );

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  systemUI: PocketAppConfig(
                    appId: rootId,
                    bytecodeAsset: 'test/root.qjbc',
                    pakAsset: 'test/root.pak',
                    metadataAsset: 'test/root.metadata.json',
                    manifestAsset: 'test/root.manifest.json',
                    additionalCapabilities: const {'ui.compositor-surfaces'},
                    compositorSurfaces: const <String, int>{childId: 2},
                    pluginFactories: <PocketPluginFactory>[
                      (_) => _RegistryCapturePlugin((registry) {
                        rootRegistry = registry;
                      }),
                    ],
                  ),
                  applications: <String, PocketAppConfig>{childId: childConfig},
                  controller: controller,
                ),
              ),
            ),
          ),
        );

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.ready,
        );
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.configure',
          <String, dynamic>{
            'systemUI': rootId,
            'grants': <Map<String, Object?>>[
              {'appId': rootId, 'sharedNamespaces': <String>[]},
              {'appId': childId, 'sharedNamespaces': <String>[]},
            ],
          },
        );
        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{'appId': childId},
              )
              as Map,
        );
        final childInstance = await waitFor(
          tester,
          controller,
          (entry) => entry.instanceId == created['instanceId'] && entry.ready,
        );
        expect(
          childInstance.session.hasConfiguredCapability(
            'platform.images.capture',
          ),
          isTrue,
        );
        expect(rootRegistry.registrationFor('platform.images.read'), isNull);

        final listRequest = childRegistry.registrationFor(
          'platform.images.list',
        )!;
        final listed = await tester.runAsync(
          () async => await listRequest.request!(<String, dynamic>{}),
        );
        expect(listed, isEmpty);
        final captureRequest = childRegistry.registrationFor(
          'platform.images.capture',
        )!;
        await expectLater(
          captureRequest.request!(<String, dynamic>{}),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'capture_unavailable',
            ),
          ),
          reason: 'a child with no mounted scene must not report a fake image',
        );

        final rootGuest = tester.widget<PocketGuestSession>(
          find.byType(PocketGuestSession).first,
        );
        final visibleSlot = const PocketCompositorSlot(
          surfaceHandle: 2,
          bounds: Rect.fromLTWH(0, 0, 120, 120),
          visibleClip: Rect.fromLTWH(0, 0, 120, 120),
          logicalViewport: Size(120, 120),
          visible: true,
          focused: true,
          drawIndex: 0,
        );
        final visibleChild =
            rootGuest.hostSurfaceBuilder!(visibleSlot) as PocketGuestSession;
        expect(visibleChild.enableSceneCapture, isTrue);
        await tester.pump();
        await childInstance.session.setForeground(true);
        expect(
          childInstance.session.hasConfiguredCapability(
            'platform.images.capture',
          ),
          isTrue,
          reason:
              'foreground capability revocation must not remove capture opt-in',
        );

        final hiddenChild =
            rootGuest.hostSurfaceBuilder!(
                  const PocketCompositorSlot(
                    surfaceHandle: 2,
                    bounds: Rect.zero,
                    visibleClip: Rect.zero,
                    logicalViewport: Size(120, 120),
                    visible: false,
                    focused: false,
                    drawIndex: 0,
                  ),
                )
                as PocketGuestSession;
        expect(hiddenChild.enableSceneCapture, isTrue);
        await tester.pump();
        await childInstance.session.setForeground(false);
        final resumedChild =
            rootGuest.hostSurfaceBuilder!(visibleSlot) as PocketGuestSession;
        expect(resumedChild.enableSceneCapture, isTrue);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        controller.dispose();
      }
    },
  );
}
