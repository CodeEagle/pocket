import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('parses bytecode metadata without treating entry as source', () {
    final metadata = PocketBytecodeMetadata.fromJsonString('''
{
  "entryFormat": "quickjs-bytecode",
  "formatVersion": 1,
  "kind": "script",
  "bindingGeneration": 12,
  "tickHz": 60,
  "runtimeAbi": "quickjs-bytecode-v1:test",
  "bytecodeBytes": 124
}
''');
    expect(metadata.entryFormat, 'quickjs-bytecode');
    expect(metadata.kind, 'script');
    expect(metadata.bytecodeBytes, 124);
  });

  test('rejects metadata missing the runtime ABI', () {
    expect(
      () => PocketBytecodeMetadata.fromJsonString('''
{
  "entryFormat": "quickjs-bytecode",
  "formatVersion": 1,
  "kind": "script",
  "bindingGeneration": 12,
  "tickHz": 60,
  "bytecodeBytes": 124
}
'''),
      throwsA(isA<PocketRuntimeException>()),
    );
  });

  test('dispatches bytecode through the concrete runtime capability', () {
    final concrete = _FakeBytecodeRuntime();
    // Keep the static type at the renderer boundary. This is the call shape
    // used by PocketView and catches accidental recursion through the
    // PocketRuntimeBytecode extension.
    final PocketRuntime runtime = concrete;

    final frame = runtime.loadBytecode(
      Uint8List.fromList(<int>[0x50, 0x4a, 0x42, 0x43]),
      Uint8List.fromList(<int>[1]),
      expectedRuntimeAbi: 'quickjs-bytecode-v1:test',
    );

    expect(frame.width, 360);
    expect(concrete.bytecodeLoads, 1);
    expect(concrete.lastExpectedAbi, 'quickjs-bytecode-v1:test');
  });
}

final class _FakeBytecodeRuntime
    implements PocketRuntime, PocketBytecodeRuntime {
  int bytecodeLoads = 0;
  String? lastExpectedAbi;

  @override
  String? get actualAbi => 'quickjs-bytecode-v1:test';

  @override
  PocketFrame eval(String source) => PocketFrame.empty();

  @override
  PocketFrame frame(int deltaMilliseconds) => PocketFrame.empty();

  @override
  PocketFrame load(String source, Uint8List pak) => eval(source);

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  PocketFrame loadBytecode(
    Uint8List bytecode,
    Uint8List pak, {
    String? expectedRuntimeAbi,
  }) {
    bytecodeLoads += 1;
    lastExpectedAbi = expectedRuntimeAbi;
    return PocketFrame.empty();
  }

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}
