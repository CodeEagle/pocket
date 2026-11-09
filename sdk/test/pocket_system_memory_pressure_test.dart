import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/src/pocket_config.dart';
import 'package:pocket_sdk/src/pocket_system_host.dart';

final class _MemoryPressureRuntime
    implements PocketRuntime, PocketBytecodeRuntime {
  final List<Map<String, dynamic>> sent = <Map<String, dynamic>>[];
  final PocketFrame initialFrame = PocketFrame.empty();

  @override
  PocketFrame eval(String source) => initialFrame;

  @override
  PocketFrame load(String source, Uint8List pak) => initialFrame;

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) => initialFrame;

  @override
  String? get actualAbi => 'system-host-memory-pressure-abi';

  @override
  PocketFrame frame(int deltaMilliseconds) => initialFrame;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    sent.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory supportDirectory;
  late _MemoryPressureRuntime runtime;
  PocketRuntime Function(Size viewport)? previousRuntimeFactory;

  setUp(() {
    supportDirectory = Directory.systemTemp.createTempSync(
      'pocket-memory-pressure-host-',
    );
    runtime = _MemoryPressureRuntime();
    previousRuntimeFactory = debugPocketSelfOwnedRuntimeFactory;
    debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => supportDirectory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final requested = utf8.decode(data.buffer.asUint8List());
      final Object content;
      if (requested.endsWith('root.metadata.json')) {
        content = <String, Object?>{
          'entryFormat': 'quickjs-bytecode',
          'formatVersion': 1,
          'kind': 'script',
          'bindingGeneration': 1,
          'tickHz': 60,
          'runtimeAbi': 'system-host-memory-pressure-abi',
          'bytecodeBytes': 1,
          'build': 1,
          'version': '1.0.0',
        };
      } else if (requested.endsWith('root.manifest.json')) {
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
      } else if (requested.endsWith('root.qjbc')) {
        content = <int>[1];
      } else if (requested.endsWith('root.pak')) {
        content = <int>[];
      } else {
        throw StateError('Unexpected test asset: $requested');
      }
      final bytes = content is List<int>
          ? content
          : utf8.encode(jsonEncode(content));
      return ByteData.sublistView(Uint8List.fromList(bytes));
    });
  });

  tearDown(() {
    debugPocketSelfOwnedRuntimeFactory = previousRuntimeFactory;
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
      supportDirectory.deleteSync(recursive: true);
    }
  });

  testWidgets('OS memory callback only reaches the live SystemUI generation', (
    tester,
  ) async {
    final controller = PocketSystemHostController();
    final rootConfig = PocketAppConfig(
      appId: 'system.test.root',
      bytecodeAsset: 'test/root.qjbc',
      pakAsset: 'test/root.pak',
      metadataAsset: 'test/root.metadata.json',
      manifestAsset: 'test/root.manifest.json',
    );
    final pressurePackets = () => runtime.sent
        .where((packet) => packet['name'] == 'system.runtime.memoryPressure')
        .toList(growable: false);

    Widget host(Size size) => MaterialApp(
      home: Center(
        child: SizedBox.fromSize(
          size: size,
          child: PocketSystemHost(
            systemUI: rootConfig,
            applications: const <String, PocketAppConfig>{},
            controller: controller,
          ),
        ),
      ),
    );

    await tester.pumpWidget(host(Size.zero));
    final rootBeforeFrame = controller.instances.single;
    expect(rootBeforeFrame.firstFrameReady, isFalse);
    binding.handleMemoryPressure();
    expect(pressurePackets(), isEmpty);

    await tester.pumpWidget(host(const Size(320, 480)));
    for (var attempt = 0; attempt < 120; attempt++) {
      if (controller.instances.single.firstFrameReady) break;
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1)),
      );
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(controller.instances.single.firstFrameReady, isTrue);

    binding.handleMemoryPressure();
    final sent = pressurePackets();
    expect(sent, hasLength(1));
    expect(sent.single['payload'], <String, Object?>{
      'generation': controller.instances.single.generation,
    });

    final rootSession = controller.instances.single.session;
    await rootSession.onError(StateError('SystemUI failed'));
    binding.handleMemoryPressure();
    expect(pressurePackets(), hasLength(1));

    await tester.runAsync(rootSession.close);
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    binding.handleMemoryPressure();
    expect(pressurePackets(), hasLength(1));
  });
}
