// End-to-end: a real buildGuest CodeView (QuickJS bytecode) on the real native library,
// driven through PocketView with rawTextInputEnabled: hardware keys and IME deltas reach the
// guest editor, and the text layout cache is measured while scrolling a 5,000-line file.
//
// Fixture: bun packages/pocket_ui/test/code_view_flutter_fixture.ts <dir>
// Run: POCKET_CODE_VIEW_FIXTURE_DIR=<dir> POCKET_NATIVE_LIBRARY=<libpocket_flutter.so> flutter test <this file>
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _size = Size(480, 640);

Map<String, dynamic> _delta(String oldText, String deltaText, int start, int end, int selection,
    {int composingBase = -1, int composingExtent = -1}) => <String, dynamic>{
      'oldText': oldText,
      'deltaText': deltaText,
      'deltaStart': start,
      'deltaEnd': end,
      'selectionBase': selection,
      'selectionExtent': selection,
      'selectionAffinity': 'TextAffinity.downstream',
      'selectionIsDirectional': false,
      'composingBase': composingBase,
      'composingExtent': composingExtent,
    };

class _Rig {
  _Rig(this.tester, this.controller, this.events);
  final WidgetTester tester;
  final PocketViewController controller;
  final List<PocketEvent> events;

  Future<void> settle([int ms = 50, int n = 3]) async {
    for (var i = 0; i < n; i++) {
      await tester.pump(Duration(milliseconds: ms));
    }
  }

  Future<Map<String, dynamic>> dump({List<int>? lines}) async {
    final before = events.length;
    controller.send(method: 'test.dump', params: <String, dynamic>{if (lines != null) 'lines': lines});
    await settle();
    final e = events.skip(before).lastWhere((e) => e.method == 'cv.dump');
    return Map<String, dynamic>.from(e.params);
  }

  Future<void> ime(List<Map<String, dynamic>> list) async {
    final setClient = tester.testTextInput.log.lastWhere((c) => c.method == 'TextInput.setClient');
    final clientId = (setClient.arguments as List<dynamic>)[0] as int;
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      'flutter/textinput',
      const JSONMethodCodec().encodeMethodCall(MethodCall(
        'TextInputClient.updateEditingStateWithDeltas',
        <dynamic>[clientId, <String, dynamic>{'deltas': list}],
      )),
      (_) {},
    );
    await settle();
  }
}

Future<_Rig> _mount(WidgetTester tester, String dir, int capacity) async {
  final metadata = File('$dir/app.bytecode.json').readAsStringSync();
  final runtime = FfiPocketRuntime.open(
    width: _size.width,
    height: _size.height,
    tickHz: (jsonDecode(metadata) as Map)['tickHz'] as int,
  );
  final controller = PocketViewController();
  final events = <PocketEvent>[];
  final ready = Completer<void>();
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = _size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(runtime.dispose);
  await tester.pumpWidget(MaterialApp(
    home: Align(
      alignment: Alignment.topLeft,
      child: SizedBox.fromSize(
        size: _size,
        child: PocketView(
          runtime: runtime,
          controller: controller,
          bytecodeBytes: File('$dir/app.qjbc').readAsBytesSync(),
          bytecodeMetadata: metadata,
          pakBytes: File('$dir/app.pak').readAsBytesSync(),
          rawTextInputEnabled: true,
          textLayoutCacheCapacity: capacity,
          showDebugFps: false,
          onEvent: events.add,
          onReady: (_) { if (!ready.isCompleted) ready.complete(); },
        ),
      ),
    ),
  ));
  for (var i = 0; i < 60 && !ready.isCompleted; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(ready.isCompleted, isTrue, reason: runtime.lastError);
  final rig = _Rig(tester, controller, events);
  await rig.settle(60, 12); // metrics calibration timer
  return rig;
}

void main() {
  final dir = Platform.environment['POCKET_CODE_VIEW_FIXTURE_DIR'];
  final lib = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skip = (dir == null || lib == null)
      ? 'Set POCKET_CODE_VIEW_FIXTURE_DIR (bun packages/pocket_ui/test/code_view_flutter_fixture.ts <dir>) and POCKET_NATIVE_LIBRARY.'
      : null;

  testWidgets('hardware keys and IME deltas edit the guest CodeView', (tester) async {
    final rig = await _mount(tester, dir!, 256);
    final first = await rig.dump(lines: <int>[3]);
    final l3 = first['lines'][0] as String;
    expect(first['lineCount'], 5000);
    // Tap into the text: the guest opens a raw session, the host attaches an IME client.
    final gesture = await tester.startGesture(const Offset(110, 3 * 20 + 10));
    await tester.pump(const Duration(milliseconds: 50));
    await gesture.up();
    await rig.settle();
    // ignore: avoid_print
    expect(tester.testTextInput.hasAnyClients, isTrue);
    // IME commit of "ab" (plain typing arrives as a delta), then a composition ni -> 你.
    await rig.ime(<Map<String, dynamic>>[_delta('', 'ab', 0, 0, 2)]);
    var d = await rig.dump(lines: <int>[3]);
    expect((d['lines'][0] as String).contains('ab'), isTrue, reason: d['lines'][0] as String);
    await rig.ime(<Map<String, dynamic>>[_delta('', 'ni', 0, 0, 2, composingBase: 0, composingExtent: 2)]);
    d = await rig.dump(lines: <int>[3]);
    expect(d['marked'], isNotNull);
    await rig.ime(<Map<String, dynamic>>[_delta('ni', '你', 0, 2, 1)]);
    d = await rig.dump(lines: <int>[3]);
    expect((d['lines'][0] as String).contains('你'), isTrue);
    // Hardware shortcut: Backspace key edge, then Meta+Z undoes the IME text.
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await rig.settle();
    final afterBackspace = (await rig.dump(lines: <int>[3]))['lines'][0] as String;
    expect(afterBackspace.contains('你'), isFalse);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyZ);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    await rig.settle();
    final afterUndo = (await rig.dump(lines: <int>[3]))['lines'][0] as String;
    expect(afterUndo, isNot(afterBackspace));
    // ignore: avoid_print
    print('CODEVIEW_FLUTTER keys+ime ok: original="$l3" afterUndo="$afterUndo"');
    await tester.pumpWidget(const SizedBox());
  }, skip: skip != null);

  for (final capacity in <int>[256, 2048]) {
    testWidgets('scrolling a 5k-line file, text layout cache capacity $capacity', (tester) async {
      final rig = await _mount(tester, dir!, capacity);
      final start = rig.controller.textLayoutCacheStats!;
      // Walk down 1,500 lines in 3-line steps (steady scrolling), then jump back to the top
      // and re-scroll a viewport worth of lines (revisit).
      for (var line = 0; line <= 1500; line += 3) {
        rig.controller.send(method: 'test.scrollTo', params: <String, dynamic>{'line': line});
        await tester.pump(const Duration(milliseconds: 16));
      }
      final down = rig.controller.textLayoutCacheStats!;
      for (var line = 1500; line >= 1400; line -= 3) {
        rig.controller.send(method: 'test.scrollTo', params: <String, dynamic>{'line': line});
        await tester.pump(const Duration(milliseconds: 16));
      }
      final back = rig.controller.textLayoutCacheStats!;
      // Far revisit: jump to the top (lines last painted ~1,500 lines ago).
      rig.controller.send(method: 'test.scrollTo', params: <String, dynamic>{'line': 0});
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 16));
      final top = rig.controller.textLayoutCacheStats!;
      final d = await rig.dump();
      // ignore: avoid_print
      print('CODEVIEW_FLUTTER cache capacity=$capacity '
          'start(len=${start.length} layouts=${start.layoutCount}) '
          'afterDown(len=${down.length} hits=${down.hitCount} layouts=${down.layoutCount} evictions=${down.evictionCount}) '
          'afterRevisit(hits=${back.hitCount} layouts=${back.layoutCount} evictions=${back.evictionCount}) '
          'afterJumpToTop(layoutsAdded=${top.layoutCount - back.layoutCount}) '
          'nodesLive=${d['debug']['nodesLive']} firstLine=${d['debug']['firstLine']}');
      expect(back.capacity, capacity);
      expect(d['debug']['firstLine'], 0);
      await tester.pumpWidget(const SizedBox());
    }, skip: skip != null);
  }
}
