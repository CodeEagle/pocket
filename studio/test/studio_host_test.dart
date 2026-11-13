import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M1 exit test: "the Studio window lists the files of demo/js using
/// capabilities only". Everything is real: the native QuickJS runtime, the
/// Studio bytecode built by the pinned buildGuest, the host's own
/// `studioSystemUI` configuration (grants, plugins), `PocketStudioPlugin` and a
/// real editor service started by `PocketStudioService` with `--project-root`
/// pointing at the demo's JS project. The guest can reach the service only
/// through studio.* capabilities.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = Platform.environment['POCKET_BUN'] ?? '${Platform.environment['HOME']}/.bun/bin/bun';
  final repo = Directory.current.parent.path;
  final projectRoot = <String>[repo, 'demo', 'js'].join('/');
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : !Directory(projectRoot).existsSync()
      ? 'sample project is missing'
      : false;

  late Directory work;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-host-');
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: projectRoot,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      environment: {...Platform.environment, 'POCKET_SOURCE_BUILD': '1', 'TMPDIR': '/tmp'},
    );
    service = PocketStudioService(config, stopOnExit: false);
    await service.start();
  });

  tearDownAll(() async {
    if (skip != false) return;
    await service.stop();
    await work.delete(recursive: true);
  });

  test('preview child gets no studio or clipboard grants; Studio gets exactly those', () {
    final studio = studioSystemUI(PocketStudioConfig(port: 1));
    final child = studioPreviewChild(PocketStudioConfig(port: 1));
    expect(studio.appId, 'dev.pocket.studio');
    expect(studio.allowedPermissions, {...PocketStudioPermissions.all, 'clipboard.read', 'clipboard.write'});
    expect(studio.rawTextInputEnabled, isTrue);
    expect(studio.memoryLimits.heapLimitBytes, PocketMemoryLimits.maximumHeapBytes);
    expect(child.appId, PocketStudioConfig.previewAppId);
    expect(child.allowedPermissions, isEmpty);
    expect(child.pluginFactories, isEmpty);
    expect(child.additionalCapabilities, isEmpty);
  });

  test('Studio window lists the files of demo/js using capabilities only', () async {
    final ui = studioSystemUI(config);
    final assets = '$repo/studio/assets';
    final entry = Uint8List.fromList(await File('$assets/app.qjbc').readAsBytes());
    final pak = Uint8List.fromList(await File('$assets/app.pak').readAsBytes());
    final metadata = jsonDecode(await File('$assets/app.bytecode.json').readAsString()) as Map;
    final manifest = PocketGuestManifest.fromJsonString(await File('$assets/guest-manifest.json').readAsString());

    final runtime = FfiPocketRuntime.open(width: 900, height: 1400);
    expect(syncPocketHostFonts(runtime), isTrue); // the view installs host font metrics before load
    final requested = <String>[];
    // The same wiring PocketSession uses: PocketHost + PocketPluginManager
    // admission with the host's allowedPermissions and the guest's manifest.
    late PocketHost host;
    bool send(String method, Map<String, dynamic> params) {
      runtime.send(<String, dynamic>{'type': 'event', 'name': method, 'payload': params});
      return true;
    }

    final registry = PocketHostRegistry();
    final providers = [for (final factory in ui.pluginFactories) factory(PocketViewController())];
    host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: send),
      allowedCapabilities: {for (final p in providers) ...p.descriptor.capabilities.keys},
      send: send,
    );
    final manager = PocketPluginManager(
      host: host,
      appId: ui.appId,
      sessionId: 'studio-test',
      allowedPermissions: ui.allowedPermissions,
    );
    for (final provider in providers) {
      manager.register(provider);
    }
    final negotiated = manager.negotiate(
      required: manifest.requiredCapabilities.where((c) => c.startsWith('studio.')),
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    );
    await manager.activate(negotiated);

    var frame = runtime.loadBytecode(entry, pak, expectedRuntimeAbi: metadata['runtimeAbi'] as String);
    Future<PocketFrame> pump([int count = 1]) async {
      for (var i = 0; i < count; i++) {
        for (final event in frame.events) {
          if (event.method == 'host.request') requested.add('${event.params['capability']}');
          unawaited(host.handle(event));
        }
        await Future<void>.delayed(const Duration(milliseconds: 4));
        frame = runtime.frame(16);
      }
      return frame;
    }

    String textOf() => frame.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n');
    Future<void> until(bool Function() ok, String what) async {
      for (var i = 0; i < 1500 && !ok(); i++) {
        await pump();
      }
      expect(ok(), isTrue, reason: 'timed out waiting for $what\nrequested=$requested\n${textOf()}');
    }

    Future<void> tap(String label) async {
      final op = frame.ops.whereType<PocketTextOp>().firstWhere((o) => o.text == label, orElse: () => throw StateError('no "$label" in\n${textOf()}'));
      final point = {'id': 0, 'x': op.x + op.width / 2, 'y': op.y + op.height / 2};
      for (final phase in const ['down', 'up']) {
        runtime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': phase}});
        await pump();
      }
    }

    try {
      // 1. The project list comes from studio.project.list on the real service.
      await until(() => textOf().contains('PocketJS Flutter host showcase'), 'project list');
      final before = textOf();
      expect(before, contains('项目'));

      // 2. Tapping the project loads the file tree through studio.fs.tree.
      await tap('PocketJS Flutter host showcase');
      await until(() => textOf().contains('manifest.json'), 'file tree');
      final tree = textOf();
      expect(tree, isNot(before), reason: 'tapping a project must change the frame');
      expect(tree, contains('app.tsx'));
      expect(tree, contains('manifest.json'));

      // The expected names come from the real files on disk.
      final onDisk = projectFileNames(projectRoot);
      const protected = {'pocket.json', 'pocket.system.json', 'editor.json'}; // service policy hides these
      for (final name in onDisk.where((n) => !n.contains('/') && !protected.contains(n))) {
        expect(tree, contains(name.split('/').last), reason: '$name should be listed');
      }

      // 3. Tapping a folder expands it and reveals its children.
      final folders = RegExp(r'^▸ (.+)$', multiLine: true).allMatches(tree).map((m) => m[1]!).toList();
      expect(folders, isNotEmpty, reason: 'demo/js has source folders\n$tree');
      final folder = folders.firstWhere((f) => onDisk.any((n) => n.startsWith('$f/')));
      await tap('▸ $folder');
      final child = onDisk.firstWhere((n) => n.startsWith('$folder/') && n.split('/').length == 2).split('/').last;
      await until(() => textOf().contains('▾ $folder') && textOf().contains(child), 'expanded folder');

      // 4. Tapping a file shows its real text in the read-only viewer.
      // A small file: the multi-line InputField shapes the whole text, which is slow on the debug native build.
      await pump(10); // let layout settle after the expand before the next tap
      await tap('manifest.json');
      final firstLine = File('$projectRoot/manifest.json').readAsLinesSync().firstWhere((l) => l.trim().length > 8).trim();
      await until(() => textOf().contains(firstLine.length > 60 ? firstLine.substring(0, 60) : firstLine), 'editor text');

      // 5. Capabilities only: every request the guest made was a studio.* call.
      expect(requested, isNotEmpty);
      // studio.* calls are the provider's; the System kernel's own requests (system.*) are not served in
      // this harness (no PocketSystemHost) and the guest tolerates that.
      final studioCalls = requested.where((c) => c.startsWith('studio.')).toSet();
      expect(studioCalls.difference(pocketStudioCapabilityNames), isEmpty, reason: requested.toString());
      expect(requested.where((c) => !c.startsWith('studio.') && !c.startsWith('system.')), isEmpty, reason: requested.toString());
      expect(requested, containsAll(<String>['studio.project.list', 'studio.fs.tree', 'studio.fs.read']));
      // 6. Nothing absolute reached the guest.
      expect(textOf(), isNot(contains(projectRoot)));
      expect(textOf(), isNot(contains(work.path)));
    } finally {
      await manager.dispose();
      runtime.dispose();
    }
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));

  testWidgets('PocketSystemHost boots the Studio config on the real native runtime', (tester) async {
    final support = (await tester.runAsync(() => Directory.systemTemp.createTemp('studio-support-')))!;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => support.path,
    );
    final controller = PocketSystemHostController();
    await tester.pumpWidget(Directionality(textDirection: TextDirection.ltr, child: studioApp(config, controller: controller)));
    for (var i = 0; i < 100; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 16));
    }
    final studio = controller.instances.singleWhere((i) => i.appId == 'dev.pocket.studio');
    expect(studio.firstFrameReady, isTrue);
    expect(studio.session.failure, isNull);
    expect(studio.session.active, isNull, reason: 'embedded bytecode, no remote package');
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 100));
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
  }, skip: skip != false, timeout: const Timeout(Duration(seconds: 90)));
}

/// Editable source files of a project directory, as the service lists them.
List<String> projectFileNames(String root) {
  const editable = {'ts', 'tsx', 'js', 'jsx', 'json', 'svg', 'css', 'md'};
  const ignored = {'node_modules', '.git', '.pocket-build', '.pocket-editor', 'assets', 'builds', 'updates', 'keys', 'build', 'dist', 'out', 'generated'};
  final result = <String>[];
  for (final entity in Directory(root).listSync(recursive: true, followLinks: false)) {
    if (entity is! File) continue;
    final relative = entity.path.substring(root.length + 1);
    final parts = relative.split('/');
    if (parts.any((p) => p.startsWith('.') || ignored.contains(p))) continue;
    if (editable.contains(relative.split('.').last)) result.add(relative);
  }
  return result;
}
