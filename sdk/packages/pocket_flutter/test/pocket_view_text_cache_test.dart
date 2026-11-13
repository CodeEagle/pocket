import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _TextRuntime implements PocketRuntime {
  _TextRuntime(this.runs);

  final int runs;

  PocketFrame _frame() => PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      for (var i = 0; i < runs; i++)
        PocketTextOp(
          x: 0,
          y: i * 12.0,
          width: 100,
          height: 12,
          text: 'run $i',
          size: 10,
          color: 0xffffffff,
        ),
    ],
    events: const <PocketEvent>[],
  );

  @override
  PocketFrame eval(String source) => _frame();
  @override
  PocketFrame load(String source, Uint8List pak) => _frame();
  @override
  PocketFrame frame(int deltaMilliseconds) => _frame();
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

Future<PocketViewController> _mount(
  WidgetTester tester, {
  required int runs,
  int? capacity,
}) async {
  final controller = PocketViewController();
  await tester.pumpWidget(
    MaterialApp(
      home: SizedBox(
        width: 320,
        height: 480,
        child: capacity == null
            ? PocketView(
                runtime: _TextRuntime(runs),
                controller: controller,
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
              )
            : PocketView(
                runtime: _TextRuntime(runs),
                controller: controller,
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
                textLayoutCacheCapacity: capacity,
              ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  return controller;
}

void main() {
  testWidgets('default capacity is 256 and counters are readable', (
    tester,
  ) async {
    final controller = await _mount(tester, runs: 10);
    final stats = controller.textLayoutCacheStats!;
    expect(stats.capacity, 256);
    expect(stats.length, 10);
    expect(stats.layoutCount, 10);
    expect(stats.evictionCount, 0);
  });

  testWidgets('a small capacity bounds the cache and counts evictions', (
    tester,
  ) async {
    final controller = await _mount(tester, runs: 10, capacity: 4);
    final stats = controller.textLayoutCacheStats!;
    expect(stats.capacity, 4);
    expect(stats.length, 4);
    expect(stats.layoutCount, greaterThanOrEqualTo(10));
    expect(stats.evictionCount, stats.layoutCount - 4);
  });

  testWidgets('a large capacity keeps every run (no thrash)', (tester) async {
    final controller = await _mount(tester, runs: 300, capacity: 2048);
    final stats = controller.textLayoutCacheStats!;
    expect(stats.length, 300);
    expect(stats.evictionCount, 0);
  });

  test('capacity must be positive', () {
    expect(
      () => PocketView(textLayoutCacheCapacity: 0),
      throwsA(isA<AssertionError>()),
    );
  });

  test('cache stats snapshot is immutable and tracks hits', () {
    final cache = PocketTextLayoutCache(capacity: 2);
    const style = TextStyle(fontSize: 10);
    cache.obtain(text: 'a', style: style);
    cache.obtain(text: 'a', style: style);
    final before = cache.stats;
    cache.obtain(text: 'b', style: style);
    cache.obtain(text: 'c', style: style);
    expect(before.hitCount, 1);
    expect(before.layoutCount, 1);
    expect(cache.stats.evictionCount, 1);
    expect(cache.stats.length, 2);
    cache.dispose();
  });
}
