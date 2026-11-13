import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M6 exit test (Linux part): "the Studio opens its own project, publishes itself, updates itself through the
/// OTA path and survives a broken build by rolling back".
///
/// Everything is real: the native QuickJS runtime, the host's own `studioApp` (PocketSystemHost, the Studio
/// SystemUI with its signed update slot), `PocketStudioPlugin`, a real editor service (pinned compiler, real
/// Ed25519 signing) started by `PocketStudioService` with the Studio's guest project as a trusted extra root
/// (a TEMP COPY of studio/js: the real source is never modified), the real `PocketUpdateCoordinator` /
/// `PocketPackageStore` / health trial and the guest-controlled refresh client (`@pocket/ui/updates`).
/// The Studio guest is driven by pointer taps on labels it draws, located from the frames the native runtime
/// returns to the view. Source edits are written through `studio.fs.write` like an external editor (the
/// code editor's IME path is covered by studio_code_editor_test.dart); open, build, publish, check and apply
/// are all taps.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = Platform.environment['POCKET_BUN'] ?? '${Platform.environment['HOME']}/.bun/bin/bun';
  final repo = Directory.current.parent.path;
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : false;

  late Directory work;
  late Directory ownProject; // temp copy of studio/js
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-self-');
    ownProject = Directory('${work.path}/studio-js');
    await _copyProject(Directory('$repo/studio/js'), ownProject);
    final main = Directory('${work.path}/main-app')..createSync();
    File('${main.path}/pocket.json').writeAsStringSync(
      jsonEncode({
        'app': {'entry': 'app.tsx'},
        'version': '1.0.0',
        'build': 1,
      }),
    );
    File('${main.path}/editor.json').writeAsStringSync(
      jsonEncode({
        'id': 'main-app',
        'appId': 'pocket.main',
        'name': 'Main App',
        'title': 'Main App',
        'version': '1.0.0',
        'build': 1,
        'tickHz': 60,
        'entry': 'app.tsx',
        'output': 'app',
        'framework': 'solid',
      }),
    );
    File('${main.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    File('${main.path}/app.tsx').writeAsStringSync('export const main = 1;\n');
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: main.path,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      extraProjectRoots: [
        ownProject.path,
      ], // trusted host configuration: the Studio's own guest project
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

  testWidgets(
    'Studio opens its own project, publishes itself, updates itself and rolls back a broken build',
    (tester) async {
      tester.view.physicalSize = const Size(900, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final support = (await tester.runAsync(
        () => Directory.systemTemp.createTemp('studio-self-support-'),
      ))!;
      binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (_) async => support.path,
      );
      addTearDown(
        () => binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          null,
        ),
      );

      // ---- observation: every frame the native runtime returns to a view, keyed by runtime -------------------
      final seen = <PocketRuntime, ({int seq, List<PocketTextOp> texts})>{};
      var seq = 0;
      debugPocketFrameDeltaAtOverride = (runtime, delta) {
        try {
          final frame = pocketFrameDeltaAt(runtime, delta);
          if (frame != null) {
            seen[runtime] = (seq: ++seq, texts: frame.ops.whereType<PocketTextOp>().toList());
          }
          return frame;
        } on Object catch (error, stack) {
          // ignore: avoid_print
          print('[self-update] frame hook failed: $error\n$stack');
          rethrow;
        }
      };
      addTearDown(() => debugPocketFrameDeltaAtOverride = null);

      final controller = PocketSystemHostController();
      final studioMetadata = File('$repo/studio/assets/app.bytecode.json').readAsStringSync();
      final bundledMetadata = jsonDecode(studioMetadata) as Map<String, dynamic>;
      expect(
        config.readUpdateKey(),
        isNotNull,
        reason: 'the service provisioned the update signing key at startup',
      );
      final ui = studioSystemUI(config);
      expect(
        ui.updates?.configured,
        isTrue,
        reason: 'the host configures the Studio SystemUI with its own signed slot',
      );
      expect(ui.updates!.manifestUri(studioAppId).toString(), config.selfUpdateUrl);
      expect(ui.textLayoutCacheCapacity, 2048);
      await tester.pumpWidget(
        studioApp(
          config,
          controller: controller,
          previewBootstrapMetadata: previewBootstrap(studioMetadata),
        ),
      );

      // ---- helpers -----------------------------------------------------------------------------------------
      Future<void> pumpFor(Duration d) async {
        final end = DateTime.now().add(d);
        while (DateTime.now().isBefore(end)) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
          await tester.pump(const Duration(milliseconds: 16));
        }
      }

      PocketSystemInstanceSnapshot studio() =>
          controller.instances.firstWhere((i) => i.appId == studioAppId);
      PocketSession session() => studio().session;
      // The package store does file IO: it must run in the real zone (the test body runs in fake async).
      Future<Map<String, dynamic>> statusOf(PocketSession s) async =>
          (await tester.runAsync(s.status))!;
      // The runtime that most recently drew the Studio chrome (rail labels). Old runtimes stop drawing when replaced.
      ({PocketRuntime runtime, List<PocketTextOp> texts})? studioFrame() {
        ({PocketRuntime runtime, List<PocketTextOp> texts, int seq})? best;
        seen.forEach((runtime, entry) {
          final labels = entry.texts.map((t) => t.text);
          if (labels.contains('设置') &&
              labels.contains('项目') &&
              (best == null || entry.seq > best!.seq)) {
            best = (runtime: runtime, texts: entry.texts, seq: entry.seq);
          }
        });
        return best == null ? null : (runtime: best!.runtime, texts: best!.texts);
      }

      String screen() => studioFrame()?.texts.map((t) => t.text).join('\n') ?? '';
      String diag() =>
          'screen:\n${screen()}\nsessions: ${controller.instances.map((i) => '${i.appId}:ready=${i.firstFrameReady}:stage=${i.session.stage}:build=${i.session.active?.build}:err=${i.session.lastError}').toList()}';

      Future<void> until(
        bool Function() ok,
        String what, {
        Duration timeout = const Duration(seconds: 120),
      }) async {
        // ignore: avoid_print
        print('[self-update] waiting for $what');
        final clock = Stopwatch()..start();
        while (clock.elapsed < timeout) {
          if (ok()) return;
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
          await tester.pump(const Duration(milliseconds: 16));
        }
        final status = await tester.runAsync(
          () => _getJson(config.port, '/api/projects/pocket-studio/status'),
        );
        fail(
          'timed out waiting for $what\n${diag()}\nservice: revision=${status?['revision']} built=${status?['builtRevision']} busy=${status?['busy']} error=${status?['error']}',
        );
      }

      Future<void> tap(String label, {int nth = 0}) async {
        final texts = studioFrame()!.texts.where((t) => t.text == label).toList();
        if (texts.length <= nth) throw StateError('no "$label" #$nth on\n${screen()}');
        final op = texts[nth];
        final x = op.x + (op.width < 40 ? op.width / 2 : 20);
        final y = op.y + (op.height < 20 ? op.height / 2 : 10);
        await pumpFor(const Duration(milliseconds: 150));
        for (final phase in const ['down', 'up']) {
          session().controller.send(
            method: 'input.pointer',
            params: {'phase': phase, 'id': 0, 'x': x, 'y': y},
          );
          await pumpFor(const Duration(milliseconds: 60));
        }
      }

      // The package store the Studio SystemUI's session uses (pointer files are the SDK's own state).
      PocketPackageStore store() => PocketPackageStore(
        Directory('${support.path}/pocket-packages/$studioAppId/studio-self'),
      ).scoped(studioAppId);
      Future<Map<String, String?>> pointers() async => (await tester.runAsync(
        () async => {
          for (final name in const ['active', 'lastGood', 'previous'])
            name: await store().readPointerId(name),
        },
      ))!;

      Future<void> buildViaStudio() async {
        await tap('控制台');
        await until(() => screen().contains('开始构建'), 'the Console page');
        await tap('开始构建');
        await until(
          () => screen().contains('构建中') || screen().contains('已构建（最新）'),
          'the build to start',
        );
        late Map<String, dynamic> status;
        final clock = Stopwatch()..start();
        do {
          await pumpFor(const Duration(milliseconds: 250));
          status = (await tester.runAsync(
            () => _getJson(config.port, '/api/projects/pocket-studio/status'),
          ))!;
        } while (clock.elapsed < const Duration(seconds: 240) &&
            !(status['busy'] == false &&
                status['builtRevision'] == status['revision'] &&
                status['error'] == null));
        expect(
          status['builtRevision'],
          status['revision'],
          reason: 'the service built the Studio source: ${status['error']}',
        );
        await until(() => screen().contains('已构建（最新）'), 'the Console to show the finished build');
      }

      Future<Map<String, dynamic>> publishViaStudio(int expectedHistory) async {
        await tap('发布');
        await until(() => screen().contains('已构建（可发布）'), 'the publish plan');
        await tap('发布测试包');
        await until(
          () => screen().contains('发布完成 · 测试') && !screen().contains('发布中…'),
          'the signed publish to finish',
        );
        final versions = (await tester.runAsync(
          () => _getJson(config.port, '/api/projects/pocket-studio/versions'),
        ))!;
        expect((versions['history'] as List), hasLength(expectedHistory));
        return versions;
      }

      final writer = PocketStudioPlugin(config: config);
      addTearDown(writer.dispose);
      final rail = File('${ownProject.path}/src/components/rail.tsx');
      final app = File('${ownProject.path}/app.tsx');
      final railOriginal = rail.readAsStringSync();
      final appOriginal = app.readAsStringSync();
      expect(railOriginal, contains('POCKET STUDIO</Text>'));
      Future<void> writeSource(String path, String content) async {
        await tester.runAsync(
          () => writer.invoke('studio.fs.write', {
            'project': 'pocket-studio',
            'path': path,
            'content': content,
          }),
        );
      }

      // ---- 0. the Studio runs its bundled bytecode and sees its own project --------------------------------
      await until(
        () =>
            controller.instances.any((i) => i.appId == studioAppId && i.firstFrameReady) &&
            studioFrame() != null,
        'the Studio first frame',
      );
      final bundled = session();
      expect(bundled.active, isNull, reason: 'the first start runs the bundled package');
      expect((await statusOf(bundled))['activeBuild'], bundledMetadata['build']);
      expect((await statusOf(bundled))['configured'], isTrue);
      expect(screen(), isNot(contains('SELF_V1')));
      await until(
        () => screen().contains('Pocket Studio') && screen().contains('Main App'),
        'the project list with the Studio\'s own project',
      );
      expect(
        screen(),
        contains('pocket-studio ·'),
        reason: 'listed through the trusted extra root',
      );

      // ---- 1. open the own project, change a visible marker, build and publish it ---------------------------
      await tap('Pocket Studio');
      await until(
        () => screen().contains('app.tsx') && screen().contains('manifest.json'),
        'the own project file tree',
      );
      await writeSource(
        'src/components/rail.tsx',
        railOriginal.replaceFirst('POCKET STUDIO</Text>', 'POCKET STUDIO SELF_V1</Text>'),
      );
      await buildViaStudio();
      final versions1 = await publishViaStudio(1);
      final slot1 = (versions1['slots'] as List).cast<Map>().firstWhere((s) => s['name'] == 'test');
      final build1 = slot1['build'] as int;
      final version1 = slot1['version'] as String;
      expect(build1, greaterThan(bundledMetadata['build'] as int));
      expect(version1, startsWith('0.1.0-test.'));
      expect(
        screen(),
        isNot(contains('SELF_V1')),
        reason: 'publishing does not change the running Studio by itself',
      );
      expect(session().generation, bundled.generation);

      // ---- 2. check and apply from Settings: the running Studio is replaced and shows the new marker -----------
      final beforeRuntime = studioFrame()!.runtime;
      final generation0 = studio().generation;
      await tap('设置');
      await until(
        () =>
            screen().contains('检查 Studio 更新') &&
            screen().contains('v0.1.0 · 构建 ${bundledMetadata['build']}'),
        'the Settings update panel with the running version',
      );
      await tap('检查 Studio 更新');
      await until(
        () => screen().contains('v$version1 · 构建 $build1') && screen().contains('应用更新'),
        'the update check to find the published build',
      );
      await tap('应用更新');
      await until(
        () =>
            studio().generation > generation0 &&
            studioFrame()!.runtime != beforeRuntime &&
            screen().contains('SELF_V1'),
        'the Studio to restart with the new marker',
      );
      final updated = session();
      expect(
        screen(),
        contains('SELF_V1'),
        reason: 'the running Studio now shows the published marker',
      );
      await until(() => updated.stage == 'ready', 'the new Studio to pass its health trial');
      final good1 = await pointers();
      expect(updated.active?.version, version1);
      expect(updated.active?.build, build1);
      expect(good1['active'], isNotNull);
      expect(
        good1['lastGood'],
        good1['active'],
        reason: 'the healthy update was promoted to last good',
      );
      // UI state handoff: the new guest reopened Settings and the own project (portable state only).
      await until(
        () => screen().contains('Studio 更新') && screen().contains('v$version1 · 构建 $build1'),
        'the handed-over Settings page',
      );
      await until(
        () => screen().contains('界面状态已恢复') || screen().contains('检查 Studio 更新'),
        'the restored UI',
      );
      expect((await statusOf(updated))['stage'], 'ready');

      // ---- 3. a deliberately broken build: the startup trial fails and the host rolls back -----------------------
      // The state handoff reopened the Studio's own project (the Console build below needs it); the source is edited
      // like an external editor.
      await until(() => studioFrame() != null, 'the restored Studio');
      await writeSource(
        'app.tsx',
        'throw new Error("STUDIO_BROKEN_V2: startup failure");\n$appOriginal',
      );
      await writeSource(
        'src/components/rail.tsx',
        railOriginal.replaceFirst('POCKET STUDIO</Text>', 'POCKET STUDIO SELF_BROKEN</Text>'),
      );
      await tap('控制台');
      await until(() => screen().contains('开始构建'), 'the Console page');
      await buildViaStudio();
      final versions2 = await publishViaStudio(2);
      final slot2 = (versions2['slots'] as List).cast<Map>().firstWhere((s) => s['name'] == 'test');
      final build2 = slot2['build'] as int;
      expect(build2, greaterThan(build1));
      expect(
        screen(),
        contains('SELF_V1'),
        reason: 'the broken package is only published, not running',
      );

      final brokenRuntimeFrom = studioFrame()!.runtime;
      final generation1 = studio().generation;
      await tap('设置');
      await until(() => screen().contains('检查 Studio 更新'), 'the Settings update panel again');
      await tap('检查 Studio 更新');
      await until(
        () => screen().contains('v${slot2['version']} · 构建 $build2') && screen().contains('应用更新'),
        'the check to find the broken build',
      );
      await tap('应用更新');
      // The broken guest throws before it can draw; the host recovers to the last good package on its own.
      await until(
        () => studio().generation > generation1,
        'the host to mount the broken candidate',
      );
      await until(
        () =>
            studioFrame()!.runtime != brokenRuntimeFrom &&
            screen().contains('SELF_V1') &&
            !screen().contains('SELF_BROKEN') &&
            studio().firstFrameReady &&
            session().stage != 'error',
        'the automatic rollback to the last good Studio',
      );
      final rolledBack = session();
      expect(screen(), contains('SELF_V1'), reason: 'the previous marker is back');
      expect(screen(), isNot(contains('SELF_BROKEN')));
      expect(rolledBack.active?.build, build1, reason: 'the host runs the last good package again');
      expect(rolledBack.active?.version, version1);
      await until(() => rolledBack.stage == 'ready', 'the rolled-back Studio to become healthy');
      final after = await pointers();
      expect(
        after['active'],
        good1['active'],
        reason: 'the active pointer is the last good package',
      );
      expect(after['lastGood'], good1['lastGood']);
      expect(
        rolledBack.lastError,
        isNotNull,
        reason: 'the coordinator keeps the failure for the UI',
      );
      expect(
        rolledBack.lastError,
        contains('STUDIO_BROKEN_V2'),
        reason: 'the failure is the guest\'s own startup error',
      );
      // The broken release is not retried on its own (no automatic refresh): the host stays on the last good package.
      final generationAfterRollback = studio().generation;
      await pumpFor(const Duration(seconds: 3));
      expect(studio().generation, generationAfterRollback);
      expect(session().active?.build, build1);

      // The Studio is functional again: it reports the failure, does not retry the broken build by itself,
      // and the user can navigate and run a check without being offered the same broken release as new state.
      await until(
        () => screen().contains('检查 Studio 更新') || screen().contains('Studio 更新'),
        'Settings after the rollback',
      );
      await tap('项目');
      await until(
        () => screen().contains('pocket-studio ·'),
        'a working project list after the rollback',
      );
      await tap('设置');
      await until(
        () => screen().contains('上次更新失败（已回滚到可用版本）'),
        'the rollback reason on the Settings page',
      );
      expect(screen(), contains('v$version1 · 构建 $build1'));

      // Evidence for the report.
      // ignore: avoid_print
      print(
        'STUDIO_SELF_UPDATE ${jsonEncode({
          'bundledBuild': bundledMetadata['build'],
          'published': {'v1': '$version1/$build1', 'broken': '${slot2['version']}/$build2'},
          'afterSelfUpdate': {'active': updated.active?.version, 'build': updated.active?.build, 'pointers': good1},
          'afterBrokenApply': {'active': rolledBack.active?.version, 'build': rolledBack.active?.build, 'pointers': after, 'lastError': rolledBack.lastError},
        })}',
      );

      await tester.pumpWidget(const SizedBox.shrink());
      final sessions = controller.instances.map((i) => i.session).toList(growable: false);
      await tester.runAsync(() async {
        for (final s in sessions) {
          await s.close();
        }
      });
      await tester.pump(const Duration(seconds: 21));
      controller.dispose();
    },
    skip: skip != false,
    timeout: const Timeout(Duration(minutes: 15)),
  );
}

Future<void> _copyProject(Directory from, Directory to) async {
  to.createSync(recursive: true);
  await for (final entity in from.list(followLinks: false)) {
    final name = entity.uri.pathSegments.where((s) => s.isNotEmpty).last;
    if (name == '.pocket-build' || name == 'tests' || name == 'scripts' || name == 'bun.lock') {
      continue;
    }
    if (entity is Directory) {
      await _copyProject(entity, Directory('${to.path}/$name'));
    } else if (entity is File) {
      entity.copySync('${to.path}/$name');
    }
  }
}

Future<Map<String, dynamic>> _getJson(int port, String path) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port$path'));
    final response = await request.close();
    return jsonDecode(await utf8.decoder.bind(response).join()) as Map<String, dynamic>;
  } finally {
    client.close(force: true);
  }
}
