import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

/// Pocket Studio signed preview, end to end on the real native runtime.
///
/// A real editor service (`scripts/tests/studio_preview_service.ts`, pinned
/// compiler, real signing) builds and preview-publishes a project. A
/// PocketSystemHost runs a Studio stand-in SystemUI plus ONE fixed preview
/// child (`dev.pocket.studio.preview`) whose update source is the service's
/// `preview` slot, fetched through the normal signed update coordinator. The
/// stand-in reloads the child by destroying it and re-creating it without
/// `cacheFirst`, so the newest signed package is verified before it runs.
///
/// Skips explicitly without `POCKET_NATIVE_LIBRARY` or a Bun executable; a
/// skip is not evidence. Nothing is mocked except the asset bundle that
/// carries the stand-in's own embedded bytecode.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = _findBun();
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : bun == null
      ? 'bun executable not found (set POCKET_BUN)'
      : false;
  // POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure (a skip is not evidence).
  final requireReal = Platform.environment['POCKET_REQUIRE_REAL'] == '1';
  if (requireReal && skip != false) {
    test('real preview prerequisites are present (POCKET_REQUIRE_REAL=1)', () => fail('$skip'));
  }
  final savedHttpOverrides = HttpOverrides.current;
  HttpOverrides.global = null;

  late Directory workDirectory;
  late Directory supportDirectory;
  late Process service;
  late _Editor editor;
  late Map<String, Uint8List> embeddedAssets;
  late String previewAppId;
  late String studioAppId;

  setUpAll(() async {
    if (skip != false) return;
    workDirectory = await Directory.systemTemp.createTemp('pocket-studio-ffi-');
    service = await Process.start(
      bun!,
      <String>['scripts/tests/studio_preview_service.ts', workDirectory.path],
      workingDirectory: Directory.current.path,
      environment: <String, String>{
        'POCKET_SOURCE_BUILD': '1',
        'TMPDIR': '/tmp',
        ...Platform.environment,
      },
    );
    final ready = Completer<Map<String, dynamic>>();
    final log = StringBuffer();
    service.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          log.writeln(line);
          if (line.startsWith('{"ready"') && !ready.isCompleted) {
            ready.complete(jsonDecode(line) as Map<String, dynamic>);
          }
        });
    service.stderr.transform(utf8.decoder).listen(log.write);
    final info = await ready.future.timeout(
      const Duration(minutes: 4),
      onTimeout: () => throw StateError('editor service did not start: $log'),
    );
    editor = _Editor(info);
    previewAppId = info['previewAppId'] as String;
    studioAppId = info['studioAppId'] as String;
    final assets = Directory('${workDirectory.path}/root/assets');
    embeddedAssets = <String, Uint8List>{
      for (final name in const <String>[
        'app.qjbc',
        'app.pak',
        'app.bytecode.json',
        'guest-manifest.json',
      ])
        'root/$name': Uint8List.fromList(
          await File('${assets.path}/$name').readAsBytes(),
        ),
    };
  });

  tearDownAll(() async {
    HttpOverrides.global = savedHttpOverrides;
    if (skip != false) return;
    service.kill();
    await service.exitCode.timeout(
      const Duration(seconds: 10),
      onTimeout: () {
        service.kill(ProcessSignal.sigkill);
        return -1;
      },
    );
    if (workDirectory.existsSync()) await workDirectory.delete(recursive: true);
  });

  setUp(() async {
    if (skip != false) return;
    supportDirectory = await Directory.systemTemp.createTemp(
      'pocket-studio-ffi-support-',
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      message,
    ) async {
      if (message == null) return null;
      final requested = utf8.decode(message.buffer.asUint8List());
      final relative = requested.startsWith('assets/')
          ? requested.substring('assets/'.length)
          : requested;
      final bytes = embeddedAssets[relative];
      if (bytes == null) {
        throw StateError('Unexpected Studio fixture asset: $requested');
      }
      return ByteData.sublistView(bytes);
    });
  });

  tearDown(() async {
    if (skip != false) return;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (supportDirectory.existsSync()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  testWidgets('signed preview child: v1, reload to v2, reject tamper and downgrade, isolate capabilities', (
    tester,
  ) async {
    final timings = <String, num>{};
    final signals = <Map<String, dynamic>>[];
    final childRecordings = <PocketRecordingController>[];
    final proxy = (await tester.runAsync(
      () => _Proxy.start(editor.port, editor.hostVersion, previewAppId),
    ))!;
    addTearDown(() => proxy.close());

    // --- v1: build and preview-publish through the real service. ----------
    await tester.runAsync(() async {
      await editor.createProject('studio-demo');
      await editor.writeFile('studio-demo', 'manifest.json', _manifest);
      await editor.writeFile('studio-demo', 'app.tsx', _source('PREVIEW_V1'));
    });
    final v1 = (await tester.runAsync(() => editor.buildAndPublish('studio-demo')))!;
    timings['publish v1 (build excluded) ms'] = v1.publishMs;
    expect(v1.body['packageId'], previewAppId);
    expect(jsonEncode(v1.body), isNot(contains(workDirectory.path)));
    final hostJson = (await tester.runAsync(
      () => editor.getJson(v1.body['hostConfigUrl'] as String),
    ))!;
    final metadataJson = (await tester.runAsync(
      () => editor.getText('${proxy.origin}${proxy.slot}/bootstrap/app.bytecode.json'),
    ))!;
    final manifestJson = (await tester.runAsync(
      () => editor.getText('${proxy.origin}${proxy.slot}/bootstrap/guest-manifest.json'),
    ))!;

    final controller = PocketSystemHostController();
    final studio = PocketAppConfig(
      appId: studioAppId,
      pluginFactories: <PocketPluginFactory>[
        (_) => _TestCapabilities(signals, <String>{
          'fixture.signal',
          'studio.secret',
          'clipboard.readText',
        }),
      ],
      bytecodeAsset: 'root/app.qjbc',
      pakAsset: 'root/app.pak',
      metadataAsset: 'root/app.bytecode.json',
      manifestAsset: 'root/guest-manifest.json',
      compositorSurfaces: <String, int>{previewAppId: 2},
    );
    // The preview child: signed `preview` slot only, no embedded bytes. It is
    // granted fixture.signal and (host side only) studio.secret; its signed
    // manifest declares just fixture.signal.
    final preview = PocketAppConfig(
      appId: previewAppId,
      downloadOnOpen: true,
      bootstrapMetadataJson: metadataJson,
      bootstrapManifestJson: manifestJson,
      updates: PocketUpdateConfig(
        // The host takes the slot path from host.json; the test reaches it via
        // its loopback front so it can forge/replay responses.
        url: '${proxy.origin}${Uri.parse(hostJson['POCKET_UPDATE_URL'] as String).path}',
        keyId: hostJson['POCKET_UPDATE_KEY_ID'] as String,
        publicKey: hostJson['POCKET_UPDATE_PUBLIC_KEY'] as String,
        namespace: hostJson['POCKET_STORE_NAMESPACE'] as String,
        debugHttpHosts: const <String>['127.0.0.1'],
      ),
      pluginFactories: <PocketPluginFactory>[
        (_) => _TestCapabilities(signals, <String>{
          'fixture.signal',
          'studio.secret',
        }),
      ],
      recordingFactory: () {
        final recording = PocketRecordingController();
        childRecordings.add(recording);
        return recording;
      },
    );
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: PocketSystemHost(
          systemUI: studio,
          applications: <String, PocketAppConfig>{previewAppId: preview},
          controller: controller,
        ),
      ),
    );

    Map<String, dynamic>? lastSignal(String event) {
      for (final signal in signals.reversed) {
        if (signal['event'] == event) return signal;
      }
      return null;
    }

    int count(String event, {String? marker}) => signals
        .where(
          (s) =>
              s['event'] == event && (marker == null || s['marker'] == marker),
        )
        .length;

    // Returns a wall-clock breakdown of one reload, all in milliseconds.
    Future<Map<String, int>> reload({required String expectEvent}) async {
      final before = count(expectEvent);
      final hitsBefore = proxy.hits.length;
      final root = controller.instances.firstWhere((i) => i.appId == studioAppId);
      final t0 = DateTime.now().millisecondsSinceEpoch;
      await _sendPointer(tester, root.session, x: 24);
      await _waitUntil(
        tester,
        () => count(expectEvent) > before,
        diagnostic: () => _diagnostics(controller, signals, proxy),
      );
      final signalAt = signals.lastWhere((s) => s['event'] == expectEvent)['at'] as int;
      var firstFrameAt = signalAt;
      if (expectEvent == 'reloaded') {
        await _waitUntil(
          tester,
          () => controller.instances.any((i) => i.appId == previewAppId && i.firstFrameReady),
          diagnostic: () => _diagnostics(controller, signals, proxy),
        );
        firstFrameAt = DateTime.now().millisecondsSinceEpoch;
      }
      final newHits = proxy.hits.skip(hitsBefore).toList();
      final firstHit = newHits.isEmpty ? t0 : newHits.map((h) => h.$1).reduce((a, b) => a < b ? a : b);
      final lastDone = newHits.isEmpty ? t0 : newHits.map((h) => h.$2).reduce((a, b) => a > b ? a : b);
      return <String, int>{
        'pointer to first service request (child close + check start)': firstHit - t0,
        'service fetch (manifest + changed blobs)': lastDone - firstHit,
        'fetch done to child created (verify + store + native load)': signalAt - lastDone,
        'created to first frame observed': firstFrameAt - signalAt,
        'total pointer to first frame': firstFrameAt - t0,
        'service requests': newHits.length,
      };
    }

    // The Studio presents the preview child, which makes its session
    // foreground; only a foreground first frame plus a live window promotes a
    // package to healthy (the anti-downgrade floor). This hidden test host
    // stands in for that presentation by foregrounding the child session.
    Future<void> promoteHealthy() async {
      final instance = controller.instances.firstWhere((i) => i.appId == previewAppId);
      await tester.runAsync(() => instance.session.setForeground(true));
      await _waitUntil(
        tester,
        () => controller.instances.any((i) => i.appId == previewAppId && i.session.stage == 'ready'),
        diagnostic: () => _diagnostics(controller, signals, proxy),
      );
    }

    // First open of the preview child: cold download of the signed v1 package.
    final coldTimer = Stopwatch()..start();
    await _waitUntil(
      tester,
      () => count('reloaded') == 1 && count('hello', marker: 'PREVIEW_V1') >= 1,
      timeout: const Duration(seconds: 60),
      diagnostic: () => _diagnostics(controller, signals, proxy),
    );
    var child = controller.instances.firstWhere((i) => i.appId == previewAppId);
    await _waitUntil(tester, () => child.firstFrameReady || controller.instances.firstWhere((i) => i.appId == previewAppId).firstFrameReady);
    child = controller.instances.firstWhere((i) => i.appId == previewAppId);
    timings['cold open v1: create to first frame ms'] = coldTimer.elapsedMilliseconds;
    expect(child.firstFrameReady, isTrue);
    expect(child.appId, previewAppId);
    expect(child.session.active?.build, v1.body['build']);
    final v1Digests = _frameDigests(childRecordings.last);
    expect(v1Digests, isNotEmpty);

    // Keep the exact v1 signed bytes to replay them later.
    final oldManifest = (await tester.runAsync(() => editor.getBytes(v1.body['manifestUrl'] as String)))!;

    // --- v2: edit, rebuild, preview-publish, reload. ----------------------
    await tester.runAsync(
      () => editor.writeFile('studio-demo', 'app.tsx', _source('PREVIEW_V2')),
    );
    final v2 = (await tester.runAsync(() => editor.buildAndPublish('studio-demo')))!;
    timings['publish v2 (build excluded) ms'] = v2.publishMs;
    timings['build v2 ms'] = v2.buildMs;
    expect(v2.body['build'] as int, greaterThan(v1.body['build'] as int));
    final reloadV2 = await reload(expectEvent: 'reloaded');
    await _waitUntil(
      tester,
      () => count('hello', marker: 'PREVIEW_V2') >= 1,
      diagnostic: () => _diagnostics(controller, signals, proxy),
    );
    child = controller.instances.firstWhere((i) => i.appId == previewAppId);
    expect(child.session.active?.build, v2.body['build']);
    expect(_frameDigests(childRecordings.last).first, isNot(v1Digests.first));

    await promoteHealthy();

    // --- Parent capability works for the Studio, not for the child. -------
    final root = controller.instances.firstWhere((i) => i.appId == studioAppId);
    await _sendPointer(tester, root.session, x: 72);
    await _waitUntil(tester, () => lastSignal('parent-capability') != null);
    expect(lastSignal('parent-capability')!['ok'], isTrue);

    // --- Anti-downgrade: the service re-serves the older signed build. ----
    proxy.replayManifest = oldManifest;
    await reload(expectEvent: 'reload-error');
    expect(lastSignal('reload-error')!['message'], isNotEmpty);
    expect(controller.instances.where((i) => i.appId == previewAppId), isEmpty);
    proxy.replayManifest = null;
    await reload(expectEvent: 'reloaded');
    child = controller.instances.firstWhere((i) => i.appId == previewAppId);
    expect(child.session.active?.build, v2.body['build'], reason: 'v2 must still be the admitted package');
    expect(count('hello', marker: 'PREVIEW_V1'), 1, reason: 'v1 must not run again');

    // --- Tampering: a forged signature and a corrupted blob are rejected. -
    await tester.runAsync(
      () => editor.writeFile('studio-demo', 'app.tsx', _source('PREVIEW_V3')),
    );
    final v3 = (await tester.runAsync(() => editor.buildAndPublish('studio-demo')))!;
    proxy.tamper = _Tamper.signature;
    await reload(expectEvent: 'reload-error');
    expect(count('hello', marker: 'PREVIEW_V3'), 0);
    proxy.tamper = _Tamper.blob;
    await reload(expectEvent: 'reload-error');
    expect(count('hello', marker: 'PREVIEW_V3'), 0);
    expect(controller.instances.where((i) => i.appId == previewAppId), isEmpty);
    expect(proxy.tamperedResponses, greaterThan(0));
    // The failed v3 attempts never replaced the previously verified package.
    proxy.tamper = null;
    await reload(expectEvent: 'reloaded');
    await _waitUntil(tester, () => count('hello', marker: 'PREVIEW_V3') >= 1);
    child = controller.instances.firstWhere((i) => i.appId == previewAppId);
    expect(child.session.active?.build, v3.body['build']);

    // --- Isolation: the child probes capabilities it must not have. -------
    await tester.runAsync(
      () => editor.writeFile('studio-demo', 'app.tsx', _probeSource),
    );
    await tester.runAsync(() => editor.buildAndPublish('studio-demo'));
    await reload(expectEvent: 'reloaded');
    // Host responses are delivered on frames, so the child must be foreground
    // (as it is when presented in Studio) to complete its awaited requests.
    await tester.runAsync(
      () => controller.instances.firstWhere((i) => i.appId == previewAppId).session.setForeground(true),
    );
    await _waitUntil(
      tester,
      () => signals.where((s) => s['event'] == 'probe').length >= 3,
      timeout: const Duration(seconds: 90),
      diagnostic: () => _diagnostics(controller, signals, proxy),
    );
    final probes = <String, Map<String, dynamic>>{
      for (final s in signals.where((s) => s['event'] == 'probe'))
        s['method'] as String: s,
    };
    // studio.secret: granted by the host to the child but not declared in its
    // signed manifest. clipboard.readText: the parent holds it, the child
    // neither declares it nor is granted it.
    expect(probes['studio.secret']!['ok'], isFalse);
    expect(probes['clipboard.readText']!['ok'], isFalse);
    expect(probes['studio.fake']!['ok'], isFalse);
    expect(
      signals.where((s) => s['event'] == 'probe' && s['leaked'] == true),
      isEmpty,
      reason: 'the child must never receive the parent secret',
    );

    // ignore: avoid_print
    print('STUDIO_PREVIEW_TIMINGS ${const JsonEncoder.withIndent('  ').convert(<String, dynamic>{
      ...timings,
      'reload v2 breakdown ms': reloadV2,
      'service timings v1 (package/sign/total ms)': v1.body['timingsMs'],
      'service timings v2 (package/sign/total ms)': v2.body['timingsMs'],
      'preview build numbers': <int>[v1.body['build'] as int, v2.body['build'] as int, v3.body['build'] as int],
      'proxy requests': proxy.requests,
    })}');
    await _closeHost(tester, controller);
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 8)));
}

String? _findBun() {
  final configured = Platform.environment['POCKET_BUN'];
  if (configured != null && File(configured).existsSync()) return configured;
  final home = Platform.environment['HOME'];
  for (final candidate in <String>[
    if (home != null) '$home/.bun/bin/bun',
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ]) {
    if (File(candidate).existsSync()) return candidate;
  }
  final result = Process.runSync('which', <String>['bun']);
  return result.exitCode == 0 ? (result.stdout as String).trim() : null;
}

const String _manifest = '{"capabilities":{"requires":["fixture.signal"]}}';

String _source(String marker) =>
    '''
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";

const host = createHostBridge();
const marker = "$marker";
host.onEvent?.((event) => {
  if (event.method === "platform.lifecycle" && event.params.state === "init") {
    void host.request("fixture.signal", { event: "hello", marker });
  }
});
void host.request("fixture.signal", { event: "hello", marker });

mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">{marker}</Text>
  </View>
</Screen>);
''';

const String _probeSource = '''
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";

const host = createHostBridge();
async function probe(method: string): Promise<void> {
  let result: Record<string, unknown>;
  try {
    const value = await host.request(method, {}) as Record<string, unknown>;
    result = { event: "probe", method, ok: true, leaked: value?.value === "studio-secret-value" };
  } catch (error) {
    const e = error as { code?: string };
    result = { event: "probe", method, ok: false, code: String(e?.code ?? ""), message: String(error) };
  }
  try {
    await host.request("fixture.signal", result as never);
  } catch (error) {
    await host.request("fixture.signal", { event: "probe-error", method, message: String(error) });
  }
}
let started = false;
function start(): void {
  if (started) return;
  started = true;
  void (async () => {
    await host.request("fixture.signal", { event: "probe-start" });
    await probe("studio.secret");
    await probe("clipboard.readText");
    await probe("studio.fake");
  })();
}
host.onEvent?.((event) => {
  if (event.method === "platform.lifecycle" && event.params.state === "init") start();
});
start();
mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="p-4"><Text class="text-base text-black">PROBE</Text></View>
</Screen>);
''';

/// Test-only capabilities. Registered on the parent and (only `studio.secret`
/// and the signal) on the child so the manifest declaration is what denies.
final class _TestCapabilities extends PocketPlugin {
  _TestCapabilities(this.signals, this.names);
  final List<Map<String, dynamic>> signals;
  final Set<String> names;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'test.studio.capabilities.${names.length}',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{
      for (final name in names)
        name: PocketPluginCapability(
          name: name,
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('fixture.signal', (params) async {
      signals.add(<String, dynamic>{
        ...params,
        'appId': context.appId,
        'at': DateTime.now().millisecondsSinceEpoch,
      });
      return const <String, Object?>{'received': true};
    });
    for (final name in names.where((n) => n != 'fixture.signal')) {
      context.registerRequest(name, (params) async {
        return const <String, Object?>{'value': 'studio-secret-value'};
      });
    }
  }
}

Future<void> _sendPointer(
  WidgetTester tester,
  PocketSession session, {
  required double x,
}) async {
  expect(
    session.controller.send(
      method: 'input.pointer',
      params: <String, dynamic>{'phase': 'down', 'id': 0, 'x': x, 'y': 24.0},
    ),
    isTrue,
  );
  expect(
    session.controller.send(
      method: 'input.pointer',
      params: <String, dynamic>{'phase': 'up', 'id': 0, 'x': x, 'y': 24.0},
    ),
    isTrue,
  );
  await tester.pump(const Duration(milliseconds: 64));
}

Future<void> _waitUntil(
  WidgetTester tester,
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 30),
  String Function()? diagnostic,
}) async {
  final elapsed = Stopwatch()..start();
  while (elapsed.elapsed < timeout) {
    if (condition()) return;
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  fail(
    'Timed out waiting for studio preview state${diagnostic == null ? '' : ': ${diagnostic()}'}',
  );
}

String _diagnostics(
  PocketSystemHostController controller,
  List<Map<String, dynamic>> signals,
  _Proxy proxy,
) =>
    'instances=${controller.instances.map((i) => '${i.appId}:first=${i.firstFrameReady}:active=${i.session.active?.build}:stage=${i.session.stage}:failure=${i.session.failure}').toList()} '
    'signals=${signals.map((s) => '${s['event']}:${s['marker'] ?? ''}${s['code'] ?? ''} ${s['message'] ?? ''}').toList()} proxy=${proxy.requests}';

List<String> _frameDigests(PocketRecordingController recording) {
  if (!recording.isStarted) return const <String>[];
  return <String>[
    for (final entry in recording.snapshot().entries)
      if (entry.result['frame'] is Map &&
          (entry.result['frame'] as Map)['opsSha'] is String)
        (entry.result['frame'] as Map)['opsSha'] as String,
  ];
}

Future<void> _closeHost(
  WidgetTester tester,
  PocketSystemHostController controller,
) async {
  final sessions = controller.instances
      .map((instance) => instance.session)
      .toList(growable: false);
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
  var completed = false;
  Object? failure;
  StackTrace? failureStack;
  final closeAll = Future.wait<void>(sessions.map((session) => session.close()))
      .then<void>(
        (_) => completed = true,
        onError: (Object error, StackTrace stack) {
          failure = error;
          failureStack = stack;
          completed = true;
        },
      );
  final deadline = DateTime.now().add(const Duration(seconds: 8));
  while (!completed && DateTime.now().isBefore(deadline)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  if (!completed) throw StateError('Timed out closing studio host sessions');
  await closeAll;
  if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
  controller.dispose();
}

enum _Tamper { signature, blob }

/// Loopback front for the editor's preview slot. It forwards every request
/// unchanged except when the test asks it to forge a signature, corrupt a blob
/// or replay an older (genuinely signed) manifest.
final class _Proxy {
  _Proxy._(this._server, this._upstreamPort, this.slot);

  final HttpServer _server;
  final int _upstreamPort;
  final String slot;
  final HttpClient _client = HttpClient();
  Uint8List? replayManifest;
  _Tamper? tamper;
  int tamperedResponses = 0;
  int requests = 0;
  final List<(int, int, String)> hits = <(int, int, String)>[];

  String get origin => 'http://127.0.0.1:${_server.port}';

  static Future<_Proxy> start(int upstreamPort, String host, String appId) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final proxy = _Proxy._(
      server,
      upstreamPort,
      '/preview/pocket/$host/${Uri.encodeComponent(appId)}/preview',
    );
    server.listen(proxy._handle);
    return proxy;
  }

  Future<void> close() async {
    _client.close(force: true);
    await _server.close(force: true);
  }

  Future<void> _handle(HttpRequest request) async {
    requests++;
    final path = request.uri.path;
    final startedAt = DateTime.now().millisecondsSinceEpoch;
    try {
      if (replayManifest != null && path.endsWith('/latest.json')) {
        request.response
          ..headers.contentType = ContentType.json
          ..add(replayManifest!);
        await request.response.close();
        return;
      }
      final upstream = await _client.getUrl(
        Uri.parse('http://127.0.0.1:$_upstreamPort$path'),
      );
      final response = await upstream.close();
      final bytes = await response.fold<BytesBuilder>(
        BytesBuilder(copy: false),
        (builder, chunk) => builder..add(chunk),
      );
      var body = bytes.takeBytes();
      if (response.statusCode == 200 && tamper == _Tamper.signature && path.endsWith('/latest.json')) {
        final envelope = jsonDecode(utf8.decode(body)) as Map<String, dynamic>;
        final signature = base64Decode(envelope['signature'] as String);
        signature[0] ^= 0x01;
        envelope['signature'] = base64Encode(signature);
        body = Uint8List.fromList(utf8.encode(jsonEncode(envelope)));
        tamperedResponses++;
      } else if (response.statusCode == 200 && tamper == _Tamper.blob && (path.contains('/blobs/') || path.contains('/bundles/'))) {
        body = Uint8List.fromList(body);
        body[body.length ~/ 2] ^= 0xff;
        tamperedResponses++;
      }
      request.response
        ..statusCode = response.statusCode
        ..headers.contentType = response.headers.contentType ?? ContentType.binary
        ..contentLength = body.length
        ..add(body);
      await request.response.close();
      hits.add((startedAt, DateTime.now().millisecondsSinceEpoch, path));
    } on Object {
      request.response.statusCode = HttpStatus.badGateway;
      await request.response.close();
    }
  }
}

final class _Published {
  _Published(this.body, this.publishMs, this.buildMs);
  final Map<String, dynamic> body;
  final int publishMs;
  final int buildMs;
}

/// Thin client for the real editor HTTP API (write credential included).
final class _Editor {
  _Editor(Map<String, dynamic> info)
    : port = info['port'] as int,
      csrf = info['csrfToken'] as String,
      hostVersion = info['hostVersion'] as String;

  final int port;
  final String csrf;
  final String hostVersion;
  final HttpClient _client = HttpClient();

  Future<(int, Uint8List)> _send(
    String method,
    String urlOrPath, {
    Object? json,
  }) async {
    final uri = urlOrPath.startsWith('http')
        ? Uri.parse(urlOrPath)
        : Uri.parse('http://127.0.0.1:$port$urlOrPath');
    final request = await _client.openUrl(method, uri);
    if (method != 'GET') request.headers.set('x-pocket-csrf', csrf);
    if (json != null) {
      request.headers.contentType = ContentType.json;
      request.add(utf8.encode(jsonEncode(json)));
    }
    final response = await request.close();
    final bytes = await response.fold<BytesBuilder>(
      BytesBuilder(copy: false),
      (builder, chunk) => builder..add(chunk),
    );
    return (response.statusCode, bytes.takeBytes());
  }

  Future<Uint8List> getBytes(String url) async {
    final (status, bytes) = await _send('GET', url);
    if (status != 200) throw StateError('GET $url -> $status');
    return bytes;
  }

  Future<String> getText(String url) async => utf8.decode(await getBytes(url));

  Future<Map<String, dynamic>> getJson(String url) async =>
      jsonDecode(await getText(url)) as Map<String, dynamic>;

  Future<void> createProject(String id) async {
    final (status, body) = await _send(
      'POST',
      '/api/projects',
      json: <String, dynamic>{
        'id': id,
        'name': 'Studio Demo',
        'version': '0.1.0',
        'tickHz': 60,
      },
    );
    if (status != 201) throw StateError('create project -> $status ${utf8.decode(body)}');
  }

  Future<void> writeFile(String id, String path, String content) async {
    final (status, body) = await _send(
      'PUT',
      '/api/projects/$id/files/$path',
      json: <String, dynamic>{'content': content},
    );
    if (status != 200) throw StateError('write $path -> $status ${utf8.decode(body)}');
  }

  Future<_Published> buildAndPublish(String id) async {
    final buildTimer = Stopwatch()..start();
    final (started, startBody) = await _send(
      'POST',
      '/api/projects/$id/build',
      json: <String, dynamic>{},
    );
    if (started != 202) throw StateError('build -> $started ${utf8.decode(startBody)}');
    for (;;) {
      final status =
          jsonDecode(utf8.decode((await _send('GET', '/api/projects/$id/status')).$2))
              as Map<String, dynamic>;
      if (status['busy'] != true) {
        if (status['error'] != null || status['builtRevision'] != status['revision']) {
          throw StateError('build failed: ${status['error']}');
        }
        break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 25));
    }
    final buildMs = buildTimer.elapsedMilliseconds;
    final publishTimer = Stopwatch()..start();
    final (status, body) = await _send(
      'POST',
      '/api/projects/$id/preview-publish',
      json: <String, dynamic>{},
    );
    final publishMs = publishTimer.elapsedMilliseconds;
    if (status != 200) throw StateError('preview-publish -> $status ${utf8.decode(body)}');
    return _Published(
      jsonDecode(utf8.decode(body)) as Map<String, dynamic>,
      publishMs,
      buildMs,
    );
  }
}
