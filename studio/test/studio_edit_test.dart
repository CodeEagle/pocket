import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M2 exit test: "edit a Showcase page in Studio, save, see the change on disk".
///
/// The project is a TEMP COPY of demo/js (the real one is never touched). Everything is real: native
/// runtime, Studio bytecode, the host's grants and plugins, the real editor service. The guest is driven
/// by pointer taps found from its own drawn labels, the multi-line InputField's `textInput.open` /
/// `textInput.edit` protocol (exactly what the Flutter overlay exchanges with the guest), and the
/// Save button.
/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = Platform.environment['POCKET_BUN'] ?? '${Platform.environment['HOME']}/.bun/bin/bun';
  final repo = Directory.current.parent.path;
  final source = '$repo/demo/js';
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : false;
  requireReal(skip);

  late Directory work;
  late String copy;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-edit-');
    copy = '${work.path}/showcase';
    const skipDirs = {'node_modules', '.pocket-build', 'generated', 'assets', 'build', '.git'};
    void copyTree(Directory from, Directory to) {
      to.createSync(recursive: true);
      for (final entity in from.listSync(followLinks: false)) {
        final name = entity.path.split('/').last;
        if (entity is Directory) {
          if (!skipDirs.contains(name)) copyTree(entity, Directory('${to.path}/$name'));
        } else if (entity is File) {
          entity.copySync('${to.path}/$name');
        }
      }
    }

    copyTree(Directory(source), Directory(copy));
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: copy,
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

  test('edit a Showcase file in Studio, Save writes it to disk (temp copy only)', () async {
    final ui = studioSystemUI(config);
    final assets = '$repo/studio/assets';
    final entry = Uint8List.fromList(await File('$assets/app.qjbc').readAsBytes());
    final pak = Uint8List.fromList(await File('$assets/app.pak').readAsBytes());
    final metadata = jsonDecode(await File('$assets/app.bytecode.json').readAsString()) as Map;
    final manifest = PocketGuestManifest.fromJsonString(await File('$assets/guest-manifest.json').readAsString());

    final runtime = FfiPocketRuntime.open(width: 900, height: 1400);
    expect(syncPocketHostFonts(runtime), isTrue);
    late PocketHost host;
    bool send(String method, Map<String, dynamic> params) {
      runtime.send(<String, dynamic>{'type': 'event', 'name': method, 'payload': params});
      return true;
    }

    final providers = [for (final factory in ui.pluginFactories) factory(PocketViewController())];
    host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: send),
      allowedCapabilities: {for (final p in providers) ...p.descriptor.capabilities.keys},
      send: send,
    );
    final manager = PocketPluginManager(host: host, appId: ui.appId, sessionId: 'studio-edit', allowedPermissions: ui.allowedPermissions);
    for (final provider in providers) {
      manager.register(provider);
    }
    await manager.activate(manager.negotiate(
      required: manifest.requiredCapabilities.where((c) => c.startsWith('studio.')),
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    ));

    final events = <PocketEvent>[];
    var frame = runtime.loadBytecode(entry, pak, expectedRuntimeAbi: metadata['runtimeAbi'] as String);
    Future<PocketFrame> pump([int count = 1]) async {
      for (var i = 0; i < count; i++) {
        for (final event in frame.events) {
          events.add(event);
          if (event.method == 'host.request') unawaited(host.handle(event));
        }
        await Future<void>.delayed(const Duration(milliseconds: 4));
        frame = runtime.frame(16);
      }
      return frame;
    }

    String textOf() => frame.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n');
    Future<void> until(bool Function() ok, String what, {int max = 2500}) async {
      for (var i = 0; i < max && !ok(); i++) {
        await pump();
      }
      expect(ok(), isTrue, reason: 'timed out waiting for $what\n${textOf()}');
    }

    Future<void> tap(String label, {bool last = false}) async {
      final ops = frame.ops.whereType<PocketTextOp>().where((o) => o.text == label).toList();
      if (ops.isEmpty) throw StateError('no "$label" in\n${textOf()}');
      final op = last ? ops.last : ops.first;
      final point = {'id': 0, 'x': op.x + (op.width / 2 < 60 ? op.width / 2 : 40), 'y': op.y + (op.height / 2 < 20 ? op.height / 2 : 10)};
      await pump(10); // let layout settle (the debug native build is slow)
      for (final phase in const ['down', 'up']) {
        runtime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': phase}});
        await pump(2);
      }
    }


    // The Studio's default editor is the CodeView (M4); these M2 tests drive the multi-line InputField, so pick it in Settings.
    Future<void> useInputFieldEditor() async {
      await tap('设置');
      await until(() => textOf().contains('多行输入框（备用）'), 'settings page');
      await tap('多行输入框（备用）');
      await pump(10);
      await tap('源码');
      await until(() => textOf().contains('+ 文件'), 'source page');
    }

    try {
      await until(() => textOf().contains('PocketJS Flutter host showcase'), 'project list');
      await tap('PocketJS Flutter host showcase');
      await until(() => textOf().contains('release.ts'), 'file tree');
      final original = File('$copy/release.ts').readAsStringSync();
      await useInputFieldEditor();
      await tap('release.ts');
      await until(() => textOf().contains('demoRelease'), 'file opened in the editor');
      expect(textOf(), contains('release.ts ·'), reason: 'tab/header names the file');

      // Tap the editor shell: the guest opens its InputField session.
      await tap('/** Build-time guest release marker. Update tooling can replace the title in app.js. */\nexport const demoRelease = "embedded";\n');
      await until(() => events.any((e) => e.method == 'textInput.open'), 'textInput.open');
      final open = events.lastWhere((e) => e.method == 'textInput.open');
      const edited = 'export const demoRelease = "EDITED_IN_STUDIO";\n';
      runtime.send({
        'type': 'event',
        'name': 'textInput.edit',
        'payload': {
          'id': open.params['id'],
          'editingSession': open.params['editingSession'],
          'revision': ((open.params['revision'] as num?) ?? 0) + 1,
          'jsRevision': open.params['jsRevision'] ?? 0,
          'text': edited,
          'selectionBase': edited.length,
          'selectionExtent': edited.length,
          'composingBase': -1,
          'composingExtent': -1,
        },
      });
      await until(() => textOf().contains('EDITED_IN_STUDIO') && textOf().contains('未保存'), 'dirty editor');
      expect(File('$copy/release.ts').readAsStringSync(), original, reason: 'nothing is written before Save');

      await until(() => frame.ops.whereType<PocketTextOp>().any((o) => o.text.startsWith('保存')), 'Save button');
      final save = frame.ops.whereType<PocketTextOp>().firstWhere((o) => o.text.startsWith('保存'));
      await tap(save.text);
      await until(() => File('$copy/release.ts').readAsStringSync() == edited, 'file written to disk');
      await until(() => textOf().contains('已保存 release.ts'), 'saved toast');
      expect(textOf(), isNot(contains('未保存')));
      // The real Showcase project is untouched.
      expect(File('$source/release.ts').readAsStringSync(), original);
      expect(textOf(), isNot(contains(copy)));
    } finally {
      await manager.dispose();
      runtime.dispose();
    }
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 4)));
}
