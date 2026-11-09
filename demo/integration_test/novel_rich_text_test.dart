import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;
import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

String _compact(String value) => value.replaceAll(RegExp(r'\s+'), '');
bool _painted(WidgetTester tester, String value) =>
    guest.texts(tester).any((text) => _compact(text).contains(_compact(value)));
Future<void> _frame(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 25));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 4)),
  );
}

Future<void> _advanceTo(WidgetTester tester, String fragment) async {
  for (var n = 0; n < 160; n++) {
    if (_painted(tester, fragment) &&
        (fragment != 'RETURN' || _painted(tester, 'cháo hén')))
      return;
    final labels = guest.texts(tester);
    final action = labels
        .where(
          (text) =>
              text.contains('轻触显全') ||
              text.contains('轻触继续') ||
              text.contains('轻触续读'),
        )
        .firstOrNull;
    if (action != null) await guest.tapGuest(tester, action, scroll: false);
    await _frame(tester);
  }
  fail('Actual Lantern did not reach $fragment: ${guest.texts(tester)}');
}

Future<void> _tapWrapped(WidgetTester tester, String label) async {
  final rendered = guest
      .texts(tester)
      .where((value) => _compact(value) == _compact(label))
      .firstOrNull;
  expect(
    rendered,
    isNotNull,
    reason: 'the real wrapped action label is painted: $label',
  );
  await guest.tapGuest(tester, rendered!, scroll: false);
}

Future<List<int>?> _store(File file) async =>
    await file.exists() ? file.readAsBytes() : null;

Future<Map<String, Object?>> _capture(
  WidgetTester tester,
  GlobalKey key,
  Directory output,
  String name,
  double dpr,
) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await tester.runAsync(() => boundary.toImage(pixelRatio: dpr));
  try {
    final data = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.png),
    );
    expect(data, isNotNull);
    final bytes = data!.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final path = '${output.path}/$name.png';
    await tester.runAsync(() => File(path).writeAsBytes(bytes, flush: true));
    debugPrint('RICH_TEXT_SCREEN $name $path');
    return {
      'name': name,
      'path': path,
      'pngBase64': base64Encode(bytes),
      'pixels': [image!.width, image.height],
      'logicalViewport': [boundary.size.width, boundary.size.height],
      'texts': guest.texts(tester),
    };
  } finally {
    image?.dispose();
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.reportData = {
    'pocketAcceptance': {
      'required': [
        'rich-phone-png',
        'rich-wide-png',
        'rich-link-note-no-advance',
        'rich-history-note',
        'rich-replay-store-isolation',
        'rich-normal-store-preserved',
      ],
      'completed': <String>[],
    },
  };
  testWidgets(
    'real rich dialogue, note pointers and history at phone and desktop constraints',
    (tester) async {
      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final before = await tester.runAsync<List<int>?>(
        () => _store(normalStore),
      );
      final isolated = IsolatedNovelSupportDirectory();
      await isolated.install();
      final output = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-rich-text-'),
      );
      final screens = <Map<String, Object?>>[];
      final completed =
          (binding.reportData!['pocketAcceptance']
                  as Map<String, dynamic>)['completed']
              as List<String>;
      var size = const Size(390, 844), dpr = 2.0;
      tester.view.devicePixelRatio = dpr;
      tester.view.physicalSize = Size(size.width * dpr, size.height * dpr);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final key = GlobalKey();
      final application = pocketHostApp();
      late StateSetter resize;
      try {
        await tester.pumpWidget(
          StatefulBuilder(
            builder: (context, setState) {
              resize = setState;
              return Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: size.width,
                  height: size.height,
                  child: RepaintBoundary(key: key, child: application),
                ),
              );
            },
          ),
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        final isolatedFile = File(
          '${isolated.path}/pocket-platform-data/pocket_platform_data.json',
        );
        List<int>? mainBefore;
        for (var n = 0; n < 120; n++) {
          await _frame(tester);
          mainBefore = await tester.runAsync<List<int>?>(
            () => _store(isolatedFile),
          );
          if (mainBefore != null &&
              utf8.decode(mainBefore).contains('arrival_01')) {
            break;
          }
        }
        expect(mainBefore, isNotNull);
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.tapGuest(tester, '返回扉页');
        for (var n = 0; n < 24; n++) {
          await _frame(tester);
        }
        mainBefore = await tester.runAsync<List<int>?>(
          () => _store(isolatedFile),
        );
        expect(mainBefore, isNotNull);
        for (final scenario in [
          (name: 'phone', viewport: const Size(390, 844), dpr: 2.0),
          (name: 'wide', viewport: const Size(1920, 1080), dpr: 1.0),
        ]) {
          size = scenario.viewport;
          dpr = scenario.dpr;
          tester.view.devicePixelRatio = dpr;
          tester.view.physicalSize = Size(size.width * dpr, size.height * dpr);
          resize(() {});
          for (var n = 0; n < 12; n++) {
            await _frame(tester);
          }
          await guest.tapGuest(tester, '信纸上的第二层海');
          await _advanceTo(tester, 'RETURN');
          for (var n = 0; n < 30; n++) {
            await _frame(tester);
          }
          for (var n = 0; n < 200 && !_painted(tester, '轻触续读'); n++) {
            await _frame(tester);
          }
          expect(_painted(tester, '轻触续读'), isTrue);
          expect(_painted(tester, '不是返航指令'), isFalse);
          expect(_painted(tester, 'cháo hén'), isTrue);
          screens.add(
            await _capture(
              tester,
              key,
              output!,
              '${scenario.name}-rich-manual-pause',
              dpr,
            ),
          );
          await guest.tapGuest(tester, 'RETURN', scroll: false);
          expect(_painted(tester, '铅笔补写的注记'), isTrue);
          for (var n = 0; n < 30; n++) {
            await _frame(tester);
          }
          screens.add(
            await _capture(tester, key, output, '${scenario.name}-note', dpr),
          );
          await guest.tapGuest(tester, '返回', scroll: false);
          expect(_painted(tester, 'RETURN'), isTrue);
          expect(
            _painted(tester, '不是返航指令'),
            isFalse,
            reason: 'the note does not consume the local marker',
          );
          await _advanceTo(tester, '第一束光发出后');
          await guest.tapGuest(tester, '回声', scroll: false);
          await guest.waitForContaining(tester, 'RETURN');
          await guest.tapGuest(tester, 'RETURN', scroll: false);
          expect(_painted(tester, '铅笔补写的注记'), isTrue);
          await guest.tapGuest(tester, '返回', scroll: false);
          expect(_painted(tester, '沿途回声'), isTrue);
          screens.add(
            await _capture(
              tester,
              key,
              output,
              '${scenario.name}-history',
              dpr,
            ),
          );
          await guest.tapGuest(tester, '返回', scroll: false);
          await _tapWrapped(tester, '遮住灯，等对岸的回答');
          await _advanceTo(tester, '一封信里，终于容得下两个人的声音');
          await guest.tapGuest(tester, '返回原旅程', scroll: false);
          await guest.waitFor(tester, '启程 · 开始新的故事');
          final after = await tester.runAsync<List<int>?>(
            () => _store(isolatedFile),
          );
          expect(
            listEquals(mainBefore, after),
            isTrue,
            reason: 'the rich replay never rewrites the parked main save',
          );
          completed.add('rich-${scenario.name}-png');
        }
        completed.addAll([
          'rich-link-note-no-advance',
          'rich-history-note',
          'rich-replay-store-isolation',
        ]);
        binding.reportData!['richText'] = {
          'platform': Platform.operatingSystem,
          'screens': screens,
          'scope':
              'Actual Flutter text drawing and pointer inputs under test constraints and simulated DPR; not physical-device typography or whole-game performance.',
        };
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await isolated.restore();
        final after = await tester.runAsync<List<int>?>(
          () => _store(normalStore),
        );
        expect(
          listEquals(before, after),
          isTrue,
          reason: 'ordinary user storage remains untouched',
        );
        completed.add('rich-normal-store-preserved');
      }
    },
  );
}
