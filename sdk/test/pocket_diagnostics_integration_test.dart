import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
        debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

final class _TestRuntime
    implements PocketRuntime, PocketCompositorRuntime, PocketBytecodeRuntime {
  int frameCalls = 0;
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
  String? get actualAbi => 'diagnostics-test-abi';

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
    return _frame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {}

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
    id: 'test.pocket-diagnostics-registry-capture',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{},
  );

  @override
  void register(PocketPluginContext context) => onRegistered(context.registry);
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  const rootId = 'system.diag.root';
  const childId = 'system.diag.child';
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('pocket_sdk_diag_test_');
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => tempDir.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      if (requested.endsWith('.qjbc')) return ByteData(1);
      if (requested.endsWith('.pak')) return ByteData(0);
      final Object content;
      if (requested.endsWith('metadata.json')) {
        content = <String, Object?>{
          'entryFormat': 'quickjs-bytecode',
          'formatVersion': 1,
          'kind': 'script',
          'bindingGeneration': 1,
          'tickHz': 60,
          'runtimeAbi': 'diagnostics-test-abi',
          'bytecodeBytes': 1,
          'version': '2.4.0',
          'build': 12,
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
              'diagnostics.log',
              'diagnostics.crash',
              'diagnostics.list',
              'diagnostics.export',
              'diagnostics.clear',
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
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  test(
    'flush and close retain admitted records while the support directory is pending',
    () async {
      for (final closing in [false, true]) {
        final resolvedDirectory = Completer<String>();
        final directory = Directory(
          '${tempDir.path}/${closing ? 'close' : 'flush'}',
        );
        binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (_) => resolvedDirectory.future,
        );
        final diagnostics = PocketHostDiagnostics();
        diagnostics.recordSessionLog(
          appId: 'startup',
          generation: 1,
          tag: 'startup',
          message: 'startup admitted',
        );
        final crash = diagnostics.recordSessionCrash(
          appId: 'startup',
          generation: 1,
          stage: 'loading',
          event: 'startup-failure',
          error: StateError('startup failed'),
        );
        var drained = false;
        final drain = (closing ? diagnostics.close() : diagnostics.flush())
            .then((_) {
              drained = true;
            });
        await Future<void>.delayed(Duration.zero);
        expect(
          drained,
          isFalse,
          reason:
              'Teardown must wait for admitted writes awaiting the directory.',
        );
        resolvedDirectory.complete(directory.path);
        await drain;
        expect(await crash, isNotNull);
        if (!closing) await diagnostics.close();
        final reopened = createFileDiagnostics(
          directory: Directory('${directory.path}/pocket-diagnostics'),
        );
        expect((await reopened.list()).map((record) => record.kind), [
          DiagnosticRecordKind.log,
          DiagnosticRecordKind.crash,
        ]);
        await reopened.close();
      }
    },
  );

  test(
    'PocketSession captures runtime onError crash before fallback resets context',
    () async {
      final diagDir = Directory('${tempDir.path}/session-diag')
        ..createSync(recursive: true);
      final diagnostics = PocketHostDiagnostics(directory: diagDir);
      final config = diagnostics.attach(
        const PocketAppConfig(
          appId: 'pocket.test.crash',
          bytecodeAsset: 'test/app.qjbc',
          pakAsset: 'test/app.pak',
          metadataAsset: 'test/app.metadata.json',
          manifestAsset: 'test/app.manifest.json',
        ),
      );

      final session = PocketSession(config: config);
      await session.initialize();
      session.onReady(session.controller);

      // Trigger actual PocketSession.onError boundary
      await session.onError(
        StateError(
          'QuickJS guest exception: ReferenceError: foo is not defined',
        ),
      );

      await session.close();
      await diagnostics.close();

      // Reopen from disk to verify persistence survived session teardown
      final reopened = createFileDiagnostics(directory: diagDir);
      final logs = await reopened.listLogs();
      expect(
        logs.map((l) => l.tag).toList(),
        containsAll(<String?>['session.ready', 'session.first_frame']),
      );

      final crashes = await reopened.listCrashes();
      expect(crashes.length, 1);
      final crash = crashes.single;
      expect(crash.projectId, 'pocket.test.crash');
      expect(crash.sessionId, 'guest-0');
      expect(crash.revision, 12);
      expect(crash.tag, 'runtime-recovery');
      expect(
        crash.error.message,
        contains('QuickJS guest exception: ReferenceError: foo is not defined'),
      );
      final crashData = crash.data as Map<String, Object?>?;
      expect(crashData?['stage'], 'loading');
      expect(crashData?['version'], '2.4.0');
      expect(crash.recentLogIds, isNotNull);
      expect(crash.recentLogIds!.length, greaterThanOrEqualTo(2));
      await reopened.close();
    },
  );

  testWidgets(
    'PocketSystemHost wires host diagnostics and exposes diagnostics.* capabilities to SystemUI',
    (tester) async {
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      debugPocketSelfOwnedRuntimeFactory = (_) => _TestRuntime();
      final controller = PocketSystemHostController();
      addTearDown(() {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        controller.dispose();
      });

      final diagDir = Directory('${tempDir.path}/host-diag')
        ..createSync(recursive: true);
      final diagnostics = PocketHostDiagnostics(directory: diagDir);
      late PocketHostRegistry rootRegistry;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PocketSystemHost(
              controller: controller,
              diagnostics: diagnostics,
              systemUI: PocketAppConfig(
                appId: rootId,
                bytecodeAsset: 'test/root.qjbc',
                pakAsset: 'test/root.pak',
                metadataAsset: 'test/root.metadata.json',
                manifestAsset: 'test/root.manifest.json',
                additionalCapabilities: const {
                  'ui.compositor-surfaces',
                  'diagnostics.log',
                  'diagnostics.crash',
                  'diagnostics.list',
                  'diagnostics.export',
                  'diagnostics.clear',
                },
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
            ),
          ),
        ),
      );

      var rootReady = false;
      for (var attempt = 0; attempt < 60 && !rootReady; attempt++) {
        for (final instance in controller.instances) {
          if (instance.isSystemUI &&
              instance.ready &&
              instance.firstFrameReady) {
            rootReady = true;
            break;
          }
        }
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 1)),
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
      expect(rootReady, isTrue);

      Future<Object?> invokeDiag(
        String capability, [
        Map<String, dynamic> params = const <String, dynamic>{},
      ]) async {
        final reg = rootRegistry.registrationFor(capability);
        expect(
          reg?.request,
          isNotNull,
          reason: '$capability must be registered',
        );
        var completed = false;
        Object? result;
        Object? failure;
        StackTrace? failureStack;
        Future<Object?>.sync(() => reg!.request!(params)).then(
          (value) {
            result = value;
            completed = true;
          },
          onError: (Object error, StackTrace stack) {
            failure = error;
            failureStack = stack;
            completed = true;
          },
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

      final logged =
          await invokeDiag('diagnostics.log', <String, dynamic>{
                'severity': 'warn',
                'tag': 'ui.router',
                'message': 'missing route fallback',
                'data': <String, dynamic>{'path': '/unknown'},
              })
              as Map<String, Object?>;
      expect(logged['kind'], 'log');
      expect(logged['severity'], 'warn');

      final crashed =
          await invokeDiag('diagnostics.crash', <String, dynamic>{
                'tag': 'ui.unhandled',
                'message': 'unhandled promise rejection',
                'error': <String, dynamic>{
                  'name': 'TypeError',
                  'message': 'cannot read property x of undefined',
                },
              })
              as Map<String, Object?>;
      expect(crashed['kind'], 'crash');

      final listed =
          await invokeDiag('diagnostics.list', <String, dynamic>{
                'kind': 'crash',
              })
              as Map<String, Object?>;
      final crashRecords = listed['records'] as List<Object?>;
      expect(crashRecords.length, 1);

      final exported =
          await invokeDiag('diagnostics.export') as Map<String, Object?>;
      expect(exported['format'], 'pocket-diagnostics-export');
      expect((exported['crashCount'] as int), 1);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pump();

      final journalFile = File(diagnostics.journalPath);
      expect(journalFile.existsSync(), isTrue);
      final rawContent = journalFile.readAsStringSync();
      expect(rawContent, contains('ui.unhandled'));
      expect(rawContent, contains('ui.router'));
    },
  );
}
