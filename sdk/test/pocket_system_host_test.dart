import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show
        PocketBytecodeRuntime,
        PocketCompositorRuntime,
        PocketEvent,
        PocketFrame,
        PocketImageResource,
        PocketOp,
        PocketRectOp,
        PocketRuntime,
        PocketView,
        debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_flutter/src/pocket_compositor.dart';
import 'package:pocket_flutter/src/pocket_memory_limits.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';
import 'package:pocket_services/pocket_services.dart';

final class _ProbeChildRuntime
    implements PocketRuntime, PocketCompositorRuntime, PocketBytecodeRuntime {
  int frameCalls = 0;
  final List<int> frameDeltas = <int>[];
  final List<Map<String, dynamic>> sentMessages = <Map<String, dynamic>>[];
  Map<String, dynamic>? presetsBeforeFirstFrame;

  static const PocketFrame _frame = PocketFrame(
    width: 240,
    height: 320,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 240, height: 320, color: 0xff101827),
    ],
    events: <PocketEvent>[],
    resources: <PocketImageResource>[],
  );

  @override
  void configureCompositor(Map<String, int> applications) {}

  @override
  String? get actualAbi => 'system-host-unit-abi';

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) => _frame;

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls += 1;
    frameDeltas.add(deltaMilliseconds);
    for (final message in sentMessages) {
      if (message['name'] == 'platform.presets' &&
          message['payload'] is Map<String, dynamic>) {
        presetsBeforeFirstFrame = Map<String, dynamic>.from(
          message['payload'] as Map<String, dynamic>,
        );
      }
    }
    return _frame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    sentMessages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

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

  testWidgets('system Back asks the guest before closing the embedded host', (
    tester,
  ) async {
    final controller = PocketSystemHostController();
    final runtime = _ProbeChildRuntime();
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
    var closes = 0;
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final content = requested.endsWith('metadata.json')
          ? <String, Object?>{
              'entryFormat': 'quickjs-bytecode',
              'formatVersion': 1,
              'kind': 'script',
              'bindingGeneration': 1,
              'tickHz': 60,
              'runtimeAbi': 'system-host-unit-abi',
              'bytecodeBytes': 1,
              'version': '1.0.0',
              'build': 1,
            }
          : <String, Object?>{
              'capabilities': {
                'requires': ['ui.compositor-surfaces'],
              },
            };
      return ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(content))),
      );
    });
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PocketSystemHost(
              systemUI: const PocketAppConfig(
                appId: rootId,
                bytecodeAsset: 'test/root.qjbc',
                pakAsset: 'test/root.pak',
                metadataAsset: 'test/root.metadata.json',
                manifestAsset: 'test/root.manifest.json',
                additionalCapabilities: {'ui.compositor-surfaces'},
              ),
              applications: const {},
              controller: controller,
              onClose: () => closes++,
            ),
          ),
        ),
      );
      final root = await waitFor(
        tester,
        controller,
        (entry) => entry.isSystemUI && entry.firstFrameReady,
      );
      List<Map<String, dynamic>> requests() => runtime.sentMessages
          .where((message) => message['name'] == 'platform.back.request')
          .toList();

      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(requests(), hasLength(1));
      expect(closes, 0);
      final pending = controller.requestBack();
      expect(
        identical(pending, controller.requestBack()),
        isTrue,
        reason: 'concurrent back requests must share one guest request',
      );
      final requestId = (requests().single['payload'] as Map)['requestId'];
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {'requestId': 'stale-request', 'handled': false},
        ),
      );
      await tester.pump();
      expect(closes, 0);
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {'requestId': requestId, 'handled': true},
        ),
      );
      await tester.pump();
      expect(await pending, isTrue);
      expect(
        closes,
        0,
        reason: 'a JS page pop must retain the embedded container',
      );

      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(requests(), hasLength(2));
      root.session.onEvent(
        PocketEvent(
          id: 'back-response',
          method: 'platform.back.response',
          params: {
            'requestId': (requests().last['payload'] as Map)['requestId'],
            'handled': false,
          },
        ),
      );
      await tester.pump();
      expect(
        closes,
        1,
        reason: 'an unhandled root back must close exactly once',
      );
      expect(tester.takeException(), isNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
      controller.dispose();
    }
  });

  testWidgets(
    'loaded host on iOS runtime with Android theme dispatches left-edge velocity and distance swipes to guest',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final controller = PocketSystemHostController();
      final runtime = _ProbeChildRuntime();
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
      var closes = 0;
      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) return ByteData(1);
        if (requested.endsWith('.pak')) return ByteData(0);
        final content = requested.endsWith('metadata.json')
            ? <String, Object?>{
                'entryFormat': 'quickjs-bytecode',
                'formatVersion': 1,
                'kind': 'script',
                'bindingGeneration': 1,
                'tickHz': 60,
                'runtimeAbi': 'system-host-unit-abi',
                'bytecodeBytes': 1,
                'version': '1.0.0',
                'build': 1,
              }
            : <String, Object?>{
                'capabilities': {
                  'requires': ['ui.compositor-surfaces'],
                },
              };
        return ByteData.sublistView(
          Uint8List.fromList(utf8.encode(jsonEncode(content))),
        );
      });
      try {
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData(platform: TargetPlatform.android),
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: TextButton(
                    onPressed: () {
                      Navigator.of(context).push<void>(
                        MaterialPageRoute<void>(
                          builder: (_) => Scaffold(
                            body: PocketSystemHost(
                              systemUI: const PocketAppConfig(
                                appId: rootId,
                                bytecodeAsset: 'test/root.qjbc',
                                pakAsset: 'test/root.pak',
                                metadataAsset: 'test/root.metadata.json',
                                manifestAsset: 'test/root.manifest.json',
                                additionalCapabilities: {
                                  'ui.compositor-surfaces',
                                },
                              ),
                              applications: const {},
                              controller: controller,
                              onClose: () => closes++,
                            ),
                          ),
                        ),
                      );
                    },
                    child: const Text('open-host'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open-host'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 350));

        final root = await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.firstFrameReady,
        );
        List<Map<String, dynamic>> requests() => runtime.sentMessages
            .where((message) => message['name'] == 'platform.back.request')
            .toList();

        // 1. Retained parent velocity-based left-edge fling (startX=30 < 36, dx=56 < 88, velocity > 260).
        await tester.flingFrom(
          const Offset(30, 200),
          const Offset(56, 0),
          600,
        );
        await tester.pump();
        expect(
          requests(),
          hasLength(1),
          reason:
              'iOS device with forced Android Theme must still dispatch velocity edge swipe over loaded PocketView',
        );
        root.session.onEvent(
          PocketEvent(
            id: 'back-response-1',
            method: 'platform.back.response',
            params: {
              'requestId': (requests().last['payload'] as Map)['requestId'],
              'handled': true,
            },
          ),
        );
        await tester.pump();
        expect(closes, 0);

        // 2. Slow distance-based left-edge drag (startX=12 < 36, dx=100 >= 88, dy=10 <= 72, low velocity).
        final slowSwipe = await tester.startGesture(const Offset(12, 200));
        await slowSwipe.moveTo(const Offset(112, 210));
        await tester.pump(const Duration(milliseconds: 500));
        await slowSwipe.up();
        await tester.pump();
        expect(
          requests(),
          hasLength(2),
          reason: 'slow distance-based edge drag must also dispatch once',
        );
        root.session.onEvent(
          PocketEvent(
            id: 'back-response-2',
            method: 'platform.back.response',
            params: {
              'requestId': (requests().last['payload'] as Map)['requestId'],
              'handled': false,
            },
          ),
        );
        await tester.pump();
        expect(closes, 1);
        expect(tester.takeException(), isNull);
      } finally {
        debugDefaultTargetPlatformOverride = null;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        controller.dispose();
      }
    },
  );

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

  testWidgets(
    'system.container.close invokes onClose for trusted SystemUI and rejects unavailable or untrusted child requests',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      late PocketHostRegistry childRegistry;
      var closeCount = 0;

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
                  applications: <String, PocketAppConfig>{
                    childId: PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                      pluginFactories: <PocketPluginFactory>[
                        (_) => _RegistryCapturePlugin((registry) {
                          childRegistry = registry;
                        }),
                      ],
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
        await expectLater(
          invokeSystem(tester, rootRegistry, 'system.container.close'),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'capability_unavailable',
            ),
          ),
          reason:
              'a host without onClose must report capability_unavailable honestly',
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
        await waitFor(
          tester,
          controller,
          (entry) => entry.instanceId == created['instanceId'] && entry.ready,
        );
        expect(
          childRegistry.registrationFor('system.container.close'),
          isNull,
          reason:
              'untrusted child runtimes must not receive system.container.close',
        );

        // Unmount the first host before attaching this controller again.
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox.shrink(
                child: PocketSystemHost(
                  key: const ValueKey<String>('with-close'),
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
                  applications: <String, PocketAppConfig>{
                    childId: const PocketAppConfig(
                      appId: childId,
                      bytecodeAsset: 'test/child.qjbc',
                      pakAsset: 'test/child.pak',
                      metadataAsset: 'test/child.metadata.json',
                      manifestAsset: 'test/child.manifest.json',
                    ),
                  },
                  controller: controller,
                  onClose: () {
                    closeCount += 1;
                  },
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
        final closed = await invokeSystem(
          tester,
          rootRegistry,
          'system.container.close',
        );
        expect(closed, equals(<String, Object?>{'closed': true}));
        expect(closeCount, 1);
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
    'system.runtime.create and prepareOpen forward initialEvents into child PocketView before its first frame',
    (tester) async {
      final controller = PocketSystemHostController();
      late PocketHostRegistry rootRegistry;
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final createdRuntimes = <_ProbeChildRuntime>[];
      debugPocketSelfOwnedRuntimeFactory = (_) {
        final runtime = _ProbeChildRuntime();
        createdRuntimes.add(runtime);
        return runtime;
      };

      binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
        data,
      ) async {
        if (data == null) return null;
        final requested = utf8.decode(data.buffer.asUint8List());
        if (requested.endsWith('.qjbc')) {
          return ByteData(1);
        }
        if (requested.endsWith('.pak')) {
          return ByteData(0);
        }
        final Object content;
        if (requested.endsWith('metadata.json')) {
          content = <String, Object?>{
            'entryFormat': 'quickjs-bytecode',
            'formatVersion': 1,
            'kind': 'script',
            'bindingGeneration': 1,
            'tickHz': 60,
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
                'system.runtime.prepareOpen',
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

      try {
        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: Center(
              child: SizedBox(
                width: 240,
                height: 320,
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

        await waitFor(
          tester,
          controller,
          (entry) => entry.isSystemUI && entry.firstFrameReady,
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

        await expectLater(
          invokeSystem(
            tester,
            rootRegistry,
            'system.runtime.create',
            <String, dynamic>{
              'appId': childId,
              'initialEvents': <Object?>[
                <String, Object?>{'method': '', 'params': <String, Object?>{}},
              ],
            },
          ),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'invalid_event',
            ),
          ),
        );

        final created = Map<String, dynamic>.from(
          await invokeSystem(
                tester,
                rootRegistry,
                'system.runtime.create',
                <String, dynamic>{
                  'appId': childId,
                  'prepareForOpen': true,
                  'cacheFirst': true,
                  'initialEvents': <Map<String, Object?>>[
                    <String, Object?>{
                      'method': 'platform.presets',
                      'params': <String, Object?>{
                        'darkMode': true,
                        'colorScheme': 'dark',
                        'accentColor': 'violet',
                        'density': 'desktop',
                        'presentationStyle': 'page',
                      },
                    },
                  ],
                },
              )
              as Map,
        );
        final childInstance = await waitFor(
          tester,
          controller,
          (entry) =>
              entry.instanceId == created['instanceId'] &&
              entry.firstFrameReady,
        );
        expect(createdRuntimes.length, greaterThanOrEqualTo(2));
        final childRuntime = createdRuntimes.last;
        expect(
          childRuntime.presetsBeforeFirstFrame,
          equals(<String, dynamic>{
            'darkMode': true,
            'colorScheme': 'dark',
            'accentColor': 'violet',
            'density': 'desktop',
            'presentationStyle': 'page',
          }),
          reason:
              'child PocketView must evaluate initialEvents at delta=0 before firstFrameReady is admitted',
        );
        expect(childRuntime.frameDeltas.first, 0);

        final childPocketView = tester
            .widgetList<PocketView>(
              find.byType(PocketView, skipOffstage: false),
            )
            .singleWhere((view) => view.bytecodeAsset == 'test/child.qjbc');
        expect(
          childPocketView.initialEvents,
          equals(<Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'platform.presets',
              'params': <String, dynamic>{
                'darkMode': true,
                'colorScheme': 'dark',
                'accentColor': 'violet',
                'density': 'desktop',
                'presentationStyle': 'page',
              },
            },
          ]),
        );

        // Verify prepareOpen also updates session.initialEvents for subsequent remounts.
        await invokeSystem(
          tester,
          rootRegistry,
          'system.runtime.prepareOpen',
          <String, dynamic>{
            'instanceId': childInstance.instanceId,
            'generation': childInstance.generation,
            'cacheFirst': true,
            'initialEvents': <Map<String, Object?>>[
              <String, Object?>{
                'method': 'platform.presets',
                'params': <String, Object?>{
                  'darkMode': false,
                  'colorScheme': 'light',
                  'accentColor': 'teal',
                  'density': 'touch',
                  'presentationStyle': 'sheet',
                },
              },
            ],
          },
        );
        expect(
          childInstance.session.initialEvents,
          equals(<Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'platform.presets',
              'params': <String, dynamic>{
                'darkMode': false,
                'colorScheme': 'light',
                'accentColor': 'teal',
                'density': 'touch',
                'presentationStyle': 'sheet',
              },
            },
          ]),
        );
      } finally {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
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
