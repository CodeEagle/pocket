import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderBox, RenderRepaintBoundary;
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

const _firstZh = '读到这封信的人';
const _lastZh = '天亮以后，带着它出发。';
const _floatingZh = '守灯的人，也应该拥有自己的天亮。';
const _dialogueZh = '原来这封信的收件人';
const _firstEn = 'To whoever finds this letter';
const _lastEn = 'When morning comes, take it with you and go.';
const _floatingEn = 'Those who keep the light deserve a dawn of their own.';
const _dialogueEn = 'This letter was meant for everyone';
const _titleZh = '未寄出的信';
const _titleEn = 'An Unsent Letter';
const _localeZh = '游戏语言 · 中文';
const _localeEn = 'Game language · English';
const _continueZh = '轻触继续';
const _continueEn = 'Tap to continue';
const _revealZh = '轻触显全';
const _revealEn = 'Tap to reveal all';

String _compact(String value) => value.replaceAll(RegExp(r'\s+'), '');

List<Map<String, Object?>> _jsonDiff(
  Object? before,
  Object? after, [
  String path = r'$',
]) {
  if (before is Map && after is Map) {
    final keys = <String>{
      for (final key in before.keys) key.toString(),
      for (final key in after.keys) key.toString(),
    }.toList()..sort();
    final differences = <Map<String, Object?>>[];
    for (final key in keys) {
      if (!before.containsKey(key)) {
        differences.add({
          'path': '$path.$key',
          'before': null,
          'after': after[key],
        });
      } else if (!after.containsKey(key)) {
        differences.add({
          'path': '$path.$key',
          'before': before[key],
          'after': null,
        });
      } else {
        differences.addAll(_jsonDiff(before[key], after[key], '$path.$key'));
      }
    }
    return differences;
  }
  if (before is List && after is List) {
    final differences = <Map<String, Object?>>[];
    final length = math.max(before.length, after.length);
    for (var index = 0; index < length; index++) {
      final itemPath = '$path[$index]';
      if (index >= before.length) {
        differences.add({
          'path': itemPath,
          'before': null,
          'after': after[index],
        });
      } else if (index >= after.length) {
        differences.add({
          'path': itemPath,
          'before': before[index],
          'after': null,
        });
      } else {
        differences.addAll(_jsonDiff(before[index], after[index], itemPath));
      }
    }
    return differences;
  }
  if (before != after) {
    return [
      {'path': path, 'before': before, 'after': after},
    ];
  }
  return const [];
}

Future<void> _captureStoreDiff(
  WidgetTester tester, {
  required Directory output,
  required String label,
  required List<int> before,
  required List<int>? after,
}) async {
  try {
    final beforeText = utf8.decode(before);
    final afterText = after == null ? null : utf8.decode(after);
    final differences = afterText == null
        ? [
            {'path': r'$', 'before': 'present', 'after': null},
          ]
        : _jsonDiff(jsonDecode(beforeText), jsonDecode(afterText));
    final beforePath = '${output.path}/$label-store-before.json';
    final afterPath = '${output.path}/$label-store-after.json';
    final diffPath = '${output.path}/$label-store-diff.json';
    await tester.runAsync(() async {
      await File(beforePath).writeAsString(beforeText);
      if (afterText != null) await File(afterPath).writeAsString(afterText);
      await File(diffPath).writeAsString(jsonEncode(differences));
    });
    debugPrint(
      'LANTERN_LETTER_STORE_DIFF ${jsonEncode({
        'label': label,
        'beforeBytes': before.length,
        'afterBytes': after?.length,
        'paths': [beforePath, afterPath, diffPath],
        'differences': differences,
      })}',
    );
  } catch (error) {
    debugPrint('LANTERN_LETTER_STORE_DIFF_DIAGNOSTIC_FAILED $label $error');
  }
}

List<CustomPaint> _activePainters(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
      find.descendant(
        of: guest.activePocketViewFinder(),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is PocketCanvasPainter,
        ),
      ),
    )
    .toList(growable: false);

List<String> _activeTexts(WidgetTester tester) => [
  for (final widget in _activePainters(tester))
    for (final op in (widget.painter! as PocketCanvasPainter).ops)
      if (op is PocketTextOp) op.text,
];

PocketTextOp? _paintedText(WidgetTester tester, Iterable<String> candidates) {
  final ops = [
    for (final widget in _activePainters(tester))
      for (final op in (widget.painter! as PocketCanvasPainter).ops)
        if (op is PocketTextOp) op,
  ];
  for (final candidate in candidates) {
    final wanted = _compact(candidate);
    for (final op in ops) {
      if (_compact(op.text) == wanted) return op;
    }
  }
  for (final candidate in candidates) {
    final wanted = _compact(candidate);
    for (final op in ops) {
      if (_compact(op.text).contains(wanted)) return op;
    }
  }
  return null;
}

Future<String> _waitForPaintedAction(
  WidgetTester tester,
  Iterable<String> candidates,
) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    final op = _paintedText(tester, candidates);
    if (op != null) return op.text;
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail(
    'No active guest action in $candidates; painted=${_activeTexts(tester)}',
  );
}

Future<void> _waitForText(
  WidgetTester tester,
  String fragment, {
  bool visible = false,
}) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    if (visible
        ? _lineFact(tester, fragment, requireStartVisible: true) != null
        : _activeTexts(
            tester,
          ).any((text) => _compact(text).contains(_compact(fragment)))) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail(
    'Guest did not paint${visible ? ' visibly' : ''} "$fragment"; '
    'painted=${_activeTexts(tester)}',
  );
}

Future<void> _tapAction(
  WidgetTester tester,
  Iterable<String> candidates, {
  bool scroll = true,
}) async {
  final actual = await _waitForPaintedAction(tester, candidates);
  await guest.tapGuest(tester, actual, scroll: scroll);
}

final class _LineFact {
  const _LineFact({
    required this.text,
    required this.rect,
    required this.visibleRect,
    required this.point,
    required this.canvasWidth,
    required this.canvasHeight,
  });

  final String text;
  final Rect rect;
  final Rect visibleRect;
  final Offset point;
  final double canvasWidth;
  final double canvasHeight;
}

_LineFact? _lineFact(
  WidgetTester tester,
  String fragment, {
  bool requireStartVisible = false,
}) {
  final wanted = _compact(fragment);
  if (wanted.isEmpty) return null;
  for (final widget in _activePainters(tester).reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    if (painter.width <= 0 || painter.height <= 0 || box.size.isEmpty) continue;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      final lines = op.text.split('\n');
      final compactLines = lines.map(_compact).toList(growable: false);
      final compactText = compactLines.join();
      final startOffset = compactText.indexOf(wanted);
      if (startOffset < 0) continue;
      final endOffset = startOffset + wanted.length - 1;
      int lineForOffset(int offset) {
        var lineStart = 0;
        for (var lineIndex = 0; lineIndex < compactLines.length; lineIndex++) {
          final lineEnd = lineStart + compactLines[lineIndex].length;
          if (offset < lineEnd) return lineIndex;
          lineStart = lineEnd;
        }
        return -1;
      }

      final firstLine = lineForOffset(startOffset);
      final lastLine = lineForOffset(endOffset);
      if (firstLine < 0 || lastLine < 0) continue;
      _LineFact? factForLine(int lineIndex) {
        if (lineIndex < 0 || lineIndex >= lines.length) return null;
        final lineHeight = op.height / math.max(1, lines.length);
        if (lineHeight <= 0) return null;
        final rect = Rect.fromLTWH(
          op.x,
          op.y + lineIndex * lineHeight,
          op.width,
          lineHeight,
        );
        var visible = rect.intersect(
          Rect.fromLTWH(0, 0, painter.width, painter.height),
        );
        final clip = op.clip;
        if (clip != null) {
          visible = visible.intersect(
            Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
          );
        }
        if (visible.isEmpty || visible.height < lineHeight * .75) return null;
        return _LineFact(
          text: lines[lineIndex],
          rect: rect,
          visibleRect: visible,
          point: box.localToGlobal(
            Offset(
              visible.center.dx * box.size.width / painter.width,
              visible.center.dy * box.size.height / painter.height,
            ),
          ),
          canvasWidth: painter.width,
          canvasHeight: painter.height,
        );
      }

      final terminalFact = factForLine(lastLine);
      if (terminalFact == null) continue;
      if (requireStartVisible && factForLine(firstLine) == null) continue;
      return terminalFact;
    }
  }
  return null;
}

Future<int> _scrollUntilVisible(
  WidgetTester tester,
  String fragment, {
  String subject = 'letter content',
}) async {
  var drags = 0;
  for (; drags < 18; drags++) {
    if (_lineFact(tester, fragment) != null) return drags;
    final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
    final gesture = await tester.startGesture(
      box.localToGlobal(Offset(box.size.width * .52, box.size.height * .72)),
    );
    for (var move = 0; move < 10; move++) {
      await gesture.moveBy(const Offset(0, -22));
      await tester.pump(const Duration(milliseconds: 16));
      if (_lineFact(tester, fragment) != null) break;
    }
    for (var settle = 0; settle < 3; settle++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
  }
  fail(
    'The $subject did not scroll into the clipped viewport; '
    'last=${_lineFact(tester, fragment)?.visibleRect}, '
    'painted=${_activeTexts(tester)}',
  );
}

List<_LineFact> _continueLineFacts(WidgetTester tester) {
  final facts = <_LineFact>[];
  for (final candidate in const [_continueZh, _continueEn]) {
    final fact = _lineFact(tester, candidate);
    if (fact != null) facts.add(fact);
  }
  return facts;
}

void _expectContinueAboveToolbar(WidgetTester tester) {
  final facts = _continueLineFacts(tester);
  expect(
    facts,
    isNotEmpty,
    reason: 'The real continue control must be painted.',
  );
  for (final fact in facts) {
    // The current player toolbar is at the bottom and is 40–48 logical pixels
    // high. This 52px band includes a small separation margin and catches an
    // overlapping FocusTarget even if the hint text itself looks unobstructed.
    expect(
      fact.rect.bottom,
      lessThanOrEqualTo(fact.canvasHeight - 52 + .5),
      reason: 'Continue must remain above the bottom toolbar hit targets.',
    );
    expect(
      fact.visibleRect.height,
      greaterThanOrEqualTo(fact.rect.height * .75),
    );
  }
}

Future<String> _waitForCompletedSay(WidgetTester tester) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    var reveal = _paintedText(tester, const [_revealZh, _revealEn]);
    if (reveal != null) {
      // Short lines may finish typing while tapGuest waits for a stable
      // target. Confirm the reveal affordance survives a few real frames
      // before asking the pointer helper to hit it; otherwise the completed
      // Continue control below is the current, correct target.
      var revealStayedVisible = true;
      for (var settle = 0; settle < 3; settle++) {
        await tester.pump(const Duration(milliseconds: 16));
        reveal = _paintedText(tester, const [_revealZh, _revealEn]);
        if (reveal == null) {
          revealStayedVisible = false;
          break;
        }
      }
      if (revealStayedVisible && reveal != null) {
        await guest.tapGuest(tester, reveal.text, scroll: false);
        continue;
      }
    }
    final proceed = _paintedText(tester, const [_continueZh, _continueEn]);
    if (proceed != null) {
      _expectContinueAboveToolbar(tester);
      await _waitForStableSayLayout(tester);
      return proceed.text;
    }
    await tester.pump(const Duration(milliseconds: 40));
  }
  fail('Say did not reveal its complete text; painted=${_activeTexts(tester)}');
}

String _sayLayoutSignature(WidgetTester tester) => jsonEncode([
  for (final widget in _activePainters(tester))
    () {
      final painter = widget.painter! as PocketCanvasPainter;
      return [
        painter.width,
        painter.height,
        for (final op in painter.ops)
          if (op is PocketTextOp)
            [op.text, op.x, op.y, op.width, op.height, op.clip?.toString()]
          else if (op is PocketTextureTriangleOp &&
              op.asset.contains('art/ui/'))
            [
              op.asset,
              op.points.map((point) => [point.x, point.y]).toList(),
            ],
      ];
    }(),
]);

Future<void> _waitForStableSayLayout(WidgetTester tester) async {
  String? previous;
  var stable = 0;
  for (var attempt = 0; attempt < 100; attempt++) {
    await tester.pump(const Duration(milliseconds: 40));
    final current = _sayLayoutSignature(tester);
    if (current == previous) {
      stable++;
      if (stable >= 2) return;
    } else {
      previous = current;
      stable = 0;
    }
  }
  fail('The fully revealed say layout did not stabilize.');
}

Map<String, Map<String, int>> _decodedUiSkinFacts(WidgetTester tester) {
  final images = <String, Map<String, int>>{};
  for (final widget in _activePainters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextureTriangleOp>()) {
      if (!op.asset.contains('art/ui/')) continue;
      final image = painter.images[op.asset];
      if (image != null) {
        images[op.asset] = {'width': image.width, 'height': image.height};
      }
    }
  }
  return images;
}

Future<void> _waitForDecodedUiSkin(WidgetTester tester) async {
  for (var attempt = 0; attempt < 120; attempt++) {
    if (_decodedUiSkinFacts(tester).isNotEmpty) return;
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail('No decoded image-backed VN skin was painted.');
}

Future<Map<String, Object?>> _guestFingerprint() async {
  final qjbcData = await rootBundle.load('assets/apps/lantern/app.qjbc');
  final pakData = await rootBundle.load('assets/apps/lantern/app.pak');
  final metadataData = await rootBundle.load(
    'assets/apps/lantern/app.bytecode.json',
  );
  final metadataBytes = metadataData.buffer.asUint8List(
    metadataData.offsetInBytes,
    metadataData.lengthInBytes,
  );
  final metadata = jsonDecode(utf8.decode(metadataBytes)) as Map;
  final qjbc = qjbcData.buffer.asUint8List(
    qjbcData.offsetInBytes,
    qjbcData.lengthInBytes,
  );
  final pak = pakData.buffer.asUint8List(
    pakData.offsetInBytes,
    pakData.lengthInBytes,
  );
  final headerBytes = metadata['headerBytes'] as int;
  expect(qjbc.length, metadata['bytecodeBytes']);
  expect(pocketSha256(qjbc.sublist(headerBytes)), metadata['payloadSha256']);
  return {
    'qjbcBytes': qjbc.length,
    'qjbcSha256': pocketSha256(qjbc),
    'pakBytes': pak.length,
    'pakSha256': pocketSha256(pak),
    'metadataSha256': pocketSha256(metadataBytes),
    'sourceSha256': metadata['sourceSha256'],
    'payloadSha256': metadata['payloadSha256'],
  };
}

Future<Map<String, Object?>> _capture(
  WidgetTester tester,
  GlobalKey key,
  Directory output,
  String name,
  double dpr,
) async {
  await _waitForDecodedUiSkin(tester);
  final skinImages = _decodedUiSkinFacts(tester);
  expect(skinImages, isNotEmpty);
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
    final file = File('${output.path}/$name.png');
    await tester.runAsync(() => file.writeAsBytes(bytes, flush: true));
    final capture = <String, Object?>{
      'name': name,
      'path': file.path,
      'pngBytes': bytes.length,
      'sha256': pocketSha256(bytes),
      'pixels': [image!.width, image.height],
      'logicalViewport': [boundary.size.width, boundary.size.height],
      'devicePixelRatio': dpr,
      'activeGuestTexts': _activeTexts(tester),
      'decodedUiImages': skinImages,
    };
    debugPrint('LANTERN_LETTER_SCREEN ${jsonEncode(capture)}');
    return capture;
  } finally {
    image?.dispose();
  }
}

Future<List<int>?> _readStore(File file) async =>
    await file.exists() ? file.readAsBytes() : null;

Future<Map<String, dynamic>?> _readAuto(String supportPath) async {
  final file = File(
    '$supportPath/pocket-platform-data/pocket_platform_data.json',
  );
  if (!await file.exists()) return null;
  final root = jsonDecode(await file.readAsString()) as Map;
  final private = root['private'];
  final app = private is Map ? private['pocket.demo.lantern'] : null;
  final auto = app is Map ? app['lantern.slot.auto'] : null;
  return auto is Map ? Map<String, dynamic>.from(auto) : null;
}

Future<Map<String, dynamic>> _waitForArrivalAuto(
  WidgetTester tester,
  String supportPath,
) async {
  for (var attempt = 0; attempt < 240; attempt++) {
    final auto = await tester.runAsync(() => _readAuto(supportPath));
    final state = auto?['state'];
    final active = state is Map ? state['active'] : null;
    if (active is Map && active['id'] == 'arrival_01') return auto!;
    await tester.pump(const Duration(milliseconds: 30));
    if (attempt % 10 == 9) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
    }
  }
  fail(
    'Main auto-save did not reach arrival_01: ${await _readAuto(supportPath)}',
  );
}

Future<List<int>?> _stableStoreBytes(WidgetTester tester, File file) async {
  List<int>? previous;
  var stable = 0;
  for (var attempt = 0; attempt < 80; attempt++) {
    final current = await tester.runAsync(() => _readStore(file));
    if (previous != null && listEquals(previous, current)) {
      stable++;
      if (stable >= 2) return current;
    } else {
      previous = current;
      stable = 0;
    }
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 40)),
    );
  }
  fail('The isolated platform store did not settle before comparison.');
}

Future<void> _restoreSupportAfterWrites(
  WidgetTester tester,
  IsolatedNovelSupportDirectory isolatedSupport,
) async {
  final path = isolatedSupport.path;
  await _waitForSupportTreeStable(tester, path);
  try {
    await isolatedSupport.restore();
  } on FileSystemException catch (error) {
    // PocketView may finish an already queued atomic store write while the
    // isolated directory is being removed. restore() has already reinstated
    // the real provider; wait for quiescence and retry only this test directory.
    debugPrint('letter-showcase: retrying isolated support cleanup: $error');
    await _waitForSupportTreeStable(tester, path);
    await tester.runAsync(() async {
      for (var attempt = 0; attempt < 12; attempt++) {
        final directory = Directory(path);
        if (!await directory.exists()) return;
        try {
          await directory.delete(recursive: true);
          return;
        } on FileSystemException {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }
    });
    expect(
      await Directory(path).exists(),
      isFalse,
      reason: 'isolated app support must be removed after the test',
    );
  }
}

Future<void> _waitForSupportTreeStable(WidgetTester tester, String path) async {
  String? previous;
  var stableSamples = 0;
  for (var attempt = 0; attempt < 40; attempt++) {
    final snapshot = await _supportTreeSnapshot(path);
    if (snapshot == previous) {
      stableSamples++;
      if (stableSamples >= 3) return;
    } else {
      previous = snapshot;
      stableSamples = 0;
    }
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
  }
  fail('isolated app-support writes did not settle: $path');
}

Future<String> _supportTreeSnapshot(String path) async {
  final root = Directory(path);
  if (!await root.exists()) return '<missing>';
  final entries = <String>[];
  await for (final entity in root.list(recursive: true, followLinks: false)) {
    if (entity is File) {
      final stat = await entity.stat();
      entries.add(
        'file:${entity.path}:${stat.size}:${stat.modified.microsecondsSinceEpoch}',
      );
    } else if (entity is Directory) {
      entries.add('dir:${entity.path}');
    } else {
      entries.add('other:${entity.path}');
    }
  }
  entries.sort();
  return entries.join('\n');
}

Future<void> _setLocaleFromTitle(WidgetTester tester, String locale) async {
  final titleAction = await _waitForPaintedAction(tester, const [
    _titleZh,
    _titleEn,
  ]);
  final settingsLabel = _compact(titleAction).contains(_compact(_titleZh))
      ? '阅读偏好'
      : 'Reading preferences';
  await _scrollUntilVisible(
    tester,
    settingsLabel,
    subject: 'title settings action',
  );
  final settingsAction = _paintedText(tester, [settingsLabel]);
  expect(
    settingsAction,
    isNotNull,
    reason: 'The title settings action must be painted after a real drag.',
  );
  await guest.tapGuest(tester, settingsAction!.text, scroll: true);
  final current = await _waitForPaintedAction(tester, const [
    _localeZh,
    _localeEn,
  ]);
  final wanted = locale == 'zh' ? _localeZh : _localeEn;
  if (!_compact(current).contains(_compact(wanted))) {
    await guest.tapGuest(tester, current);
    await _waitForPaintedAction(tester, [wanted]);
  }
  await _tapAction(tester, const ['返回', 'Back'], scroll: false);
  await _waitForPaintedAction(tester, [locale == 'zh' ? _titleZh : _titleEn]);
}

Future<void> _enterLetterReplay(WidgetTester tester, String locale) async {
  await _tapAction(tester, [locale == 'zh' ? _titleZh : _titleEn]);
  await _waitForText(tester, locale == 'zh' ? _firstZh : _firstEn);
}

Future<void> _returnToMainTitle(WidgetTester tester) async {
  await _tapAction(tester, const ['手札', 'Journal'], scroll: false);
  await _waitForPaintedAction(tester, const ['返回扉页', 'Return to title']);
  await _tapAction(tester, const ['返回扉页', 'Return to title']);
  await _waitForPaintedAction(tester, const [_titleZh, _titleEn]);
}

Future<void> _switchViewport(
  WidgetTester tester,
  Size size,
  double dpr,
  void Function(VoidCallback fn) resize,
  void Function(Size size) saveSize,
) async {
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = Size(size.width * dpr, size.height * dpr);
  saveSize(size);
  resize(() {});
  for (var attempt = 0; attempt < 120; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
    if ((box.size.width - size.width).abs() < .5 &&
        (box.size.height - size.height).abs() < .5) {
      debugPrint(
        'LANTERN_LETTER_VIEWPORT ${jsonEncode({
          'logical': [box.size.width, box.size.height],
          'dpr': dpr,
          'testViewOnly': true,
        })}',
      );
      return;
    }
  }
  final box = tester.renderObject<RenderBox>(guest.activePocketViewFinder());
  fail('PocketView did not adopt $size; actual=${box.size}');
}

Future<int> _runLetterReplay(
  WidgetTester tester, {
  required String locale,
  required String viewportName,
  required double dpr,
  required Directory output,
  required GlobalKey captureKey,
  required Map<String, Object?> fingerprint,
}) async {
  final first = locale == 'zh' ? _firstZh : _firstEn;
  final last = locale == 'zh' ? _lastZh : _lastEn;
  final floating = locale == 'zh' ? _floatingZh : _floatingEn;
  final dialogue = locale == 'zh' ? _dialogueZh : _dialogueEn;
  final continueCandidates = const [_continueZh, _continueEn];
  var totalScrollDrags = 0;

  await _enterLetterReplay(tester, locale);
  await _waitForCompletedSay(tester);
  expect(
    _lineFact(tester, first, requireStartVisible: true),
    isNotNull,
    reason: 'The opening letter fragment must be fully visible.',
  );
  await _capture(
    tester,
    captureKey,
    output,
    '$locale-$viewportName-fullscreen-top',
    dpr,
  );

  final beforeEnd = _lineFact(tester, last);
  if (viewportName == 'phone') {
    expect(
      beforeEnd,
      isNull,
      reason: 'The long letter should begin clipped on the phone-like view.',
    );
  }
  totalScrollDrags = await _scrollUntilVisible(tester, last);
  if (viewportName == 'phone') {
    expect(totalScrollDrags, greaterThan(0));
  }
  expect(_lineFact(tester, last), isNotNull);
  _expectContinueAboveToolbar(tester);
  await _capture(
    tester,
    captureKey,
    output,
    '$locale-$viewportName-fullscreen-bottom',
    dpr,
  );

  final fullContinue = await _waitForPaintedAction(tester, continueCandidates);
  _expectContinueAboveToolbar(tester);
  await guest.tapGuest(tester, fullContinue, scroll: false);
  await _waitForText(tester, floating, visible: true);
  await _waitForCompletedSay(tester);
  final floatingGeometryBefore = _lineFact(tester, floating)!;
  _expectContinueAboveToolbar(tester);
  await _capture(
    tester,
    captureKey,
    output,
    '$locale-$viewportName-floating',
    dpr,
  );

  final floatingContinue = await _waitForPaintedAction(
    tester,
    continueCandidates,
  );
  _expectContinueAboveToolbar(tester);
  await guest.tapGuest(tester, floatingContinue, scroll: false);
  await _waitForText(tester, dialogue, visible: true);
  await _waitForCompletedSay(tester);
  await _capture(
    tester,
    captureKey,
    output,
    '$locale-$viewportName-dialogue',
    dpr,
  );

  // Roll the replay back one authored say. Presentation is derived from its
  // restored story location; compare the actual line geometry with the same
  // floating render observed before advancing.
  await _tapAction(tester, const ['回溯', 'Rewind'], scroll: false);
  await _waitForText(tester, floating, visible: true);
  final floatingGeometryAfterRollback = _lineFact(tester, floating)!;
  expect(
    (floatingGeometryAfterRollback.point - floatingGeometryBefore.point)
        .distance,
    lessThan(1),
    reason: 'Rollback to the floating say must restore its original geometry.',
  );
  await _capture(
    tester,
    captureKey,
    output,
    '$locale-$viewportName-floating-rollback',
    dpr,
  );

  await _tapAction(tester, const ['返回原旅程', 'Return to journey'], scroll: false);
  await _waitForPaintedAction(tester, [locale == 'zh' ? _titleZh : _titleEn]);
  debugPrint(
    'LANTERN_LETTER_ROUTE ${jsonEncode({
      'locale': locale,
      'viewport': viewportName,
      'scrollDrags': totalScrollDrags,
      'floatingRollbackBounds': [floatingGeometryAfterRollback.rect.left, floatingGeometryAfterRollback.rect.top, floatingGeometryAfterRollback.rect.width, floatingGeometryAfterRollback.rect.height],
      ...fingerprint,
    })}',
  );
  return totalScrollDrags;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  binding.reportData = <String, Object?>{
    'pocketAcceptance': {
      'required': ['letter-showcase'],
      'completed': <String>[],
    },
  };

  testWidgets(
    'Lantern letter replay shows fullscreen, floating and dialogue text at two viewport constraints in both locales',
    (tester) async {
      const phone = Size(329, 600);
      const desktop = Size(1280, 900);
      var viewport = phone;
      var dpr = 2.0;
      tester.view.devicePixelRatio = dpr;
      tester.view.physicalSize = Size(phone.width * dpr, phone.height * dpr);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final normalStoreBefore = await normalStore.exists()
          ? await normalStore.readAsBytes()
          : null;
      final isolatedSupport = IsolatedNovelSupportDirectory();
      await isolatedSupport.install();
      expect(isolatedSupport.path, isNot(normalSupport.path));
      final isolatedSupportPath = isolatedSupport.path;

      final outputDirectory = await tester.runAsync(
        () =>
            Directory.systemTemp.createTemp('pocket-lantern-letter-showcase-'),
      );
      expect(outputDirectory, isNotNull);
      final output = outputDirectory!;
      final captureKey = GlobalKey();
      final application = pocketHostApp();
      late StateSetter resize;
      final fingerprint = await _guestFingerprint();
      final screenshots = <String>[];
      Object? primaryFailure;
      File isolatedStoreFile() => File(
        '$isolatedSupportPath/pocket-platform-data/pocket_platform_data.json',
      );

      try {
        await tester.pumpWidget(
          StatefulBuilder(
            builder: (context, setState) {
              resize = setState;
              return Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: viewport.width,
                  height: viewport.height,
                  child: RepaintBoundary(key: captureKey, child: application),
                ),
              );
            },
          ),
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await _waitForPaintedAction(tester, const [
          '启程 · 开始新的故事',
          'Begin · Start a new story',
        ]);
        await _setLocaleFromTitle(tester, 'zh');

        // Create a real main-story autosave first. The replay is then tested
        // against a non-empty disk checkpoint rather than null-to-null state.
        await _tapAction(tester, const ['启程 · 开始新的故事']);
        await _waitForText(tester, '23点08分');
        final mainAuto = await _waitForArrivalAuto(
          tester,
          isolatedSupport.path,
        );
        expect(mainAuto['state']['active']['id'], 'arrival_01');
        await _returnToMainTitle(tester);
        final zhBaseline = await _stableStoreBytes(tester, isolatedStoreFile());
        expect(zhBaseline, isNotNull);
        final firstAutoBytes = await _readStore(isolatedStoreFile());
        expect(firstAutoBytes, isNotNull);
        expect(listEquals(zhBaseline, firstAutoBytes), isTrue);

        for (final scenario in const [
          (locale: 'zh', name: 'phone', size: phone, dpr: 2.0),
          (locale: 'zh', name: 'wide', size: desktop, dpr: 1.0),
          (locale: 'en', name: 'phone', size: phone, dpr: 2.0),
          (locale: 'en', name: 'wide', size: desktop, dpr: 1.0),
        ]) {
          if (viewport != scenario.size || dpr != scenario.dpr) {
            await _switchViewport(
              tester,
              scenario.size,
              scenario.dpr,
              resize,
              (value) => viewport = value,
            );
            dpr = scenario.dpr;
          }
          await _setLocaleFromTitle(tester, scenario.locale);
          final baseline = await _stableStoreBytes(tester, isolatedStoreFile());
          expect(baseline, isNotNull);
          final auto = await tester.runAsync(
            () => _readAuto(isolatedSupport.path),
          );
          expect(auto?['state']?['active']?['id'], 'arrival_01');

          final count = await _runLetterReplay(
            tester,
            locale: scenario.locale,
            viewportName: scenario.name,
            dpr: scenario.dpr,
            output: output,
            captureKey: captureKey,
            fingerprint: fingerprint,
          );
          if (scenario.name == 'phone') expect(count, greaterThan(0));
          final afterReplay = await _stableStoreBytes(
            tester,
            isolatedStoreFile(),
          );
          if (!listEquals(afterReplay, baseline)) {
            await _captureStoreDiff(
              tester,
              output: output,
              label: '${scenario.locale}-${scenario.name}',
              before: baseline!,
              after: afterReplay,
            );
          }
          expect(
            afterReplay,
            equals(baseline),
            reason:
                'The isolated replay must not write to the parked main story autosave.',
          );
          screenshots.addAll([
            '${scenario.locale}-${scenario.name}-fullscreen-top',
            '${scenario.locale}-${scenario.name}-fullscreen-bottom',
            '${scenario.locale}-${scenario.name}-floating',
            '${scenario.locale}-${scenario.name}-dialogue',
            '${scenario.locale}-${scenario.name}-floating-rollback',
          ]);
        }

        // Return from the replay to the parked main route and prove the same
        // autosaved story location remains readable after the UI tour.
        await _tapAction(tester, const [
          '续写 · 继续旅程',
          'Continue · Resume your journey',
        ]);
        // The final matrix case is English; resume keeps the selected locale.
        await _waitForText(tester, '11:08 p.m.');
        final resumedAuto = await tester.runAsync(
          () => _readAuto(isolatedSupport.path),
        );
        expect(resumedAuto?['state']?['active']?['id'], 'arrival_01');
        expect(screenshots, hasLength(20));
        debugPrint(
          'LANTERN_LETTER_SHOWCASE ${jsonEncode({'output': output.path, 'screenshots': screenshots, 'guest': fingerprint, 'isolatedSupport': isolatedSupport.path, 'mainAutosaveLocation': 'arrival_01', 'replayAutosaveIsolation': true, 'viewportsAreTestConstraints': true})}',
        );
        expect(tester.takeException(), isNull);
      } catch (error, stack) {
        primaryFailure = error;
        Error.throwWithStackTrace(error, stack);
      } finally {
        Object? cleanupFailure;
        StackTrace? cleanupFailureStack;
        Future<void> cleanupStep(Future<void> Function() action) async {
          try {
            await action();
          } catch (error, stack) {
            cleanupFailure ??= error;
            cleanupFailureStack ??= stack;
            debugPrint('letter-showcase: cleanup step failed: $error');
          }
        }

        await cleanupStep(() async {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
        });
        await cleanupStep(
          () => _restoreSupportAfterWrites(tester, isolatedSupport),
        );
        await cleanupStep(() async {
          final normalStoreAfter = await normalStore.exists()
              ? await normalStore.readAsBytes()
              : null;
          expect(
            normalStoreAfter,
            equals(normalStoreBefore),
            reason: 'Letter replay must leave the normal user store untouched.',
          );
        });
        if (cleanupFailure != null) {
          if (primaryFailure != null) {
            debugPrint(
              'letter-showcase: preserving primary failure '
              '($primaryFailure) over cleanup failure ($cleanupFailure); '
              'support=$isolatedSupportPath',
            );
          } else {
            Error.throwWithStackTrace(
              cleanupFailure!,
              cleanupFailureStack ?? StackTrace.current,
            );
          }
        }
      }
      final acceptance = binding.reportData!['pocketAcceptance'] as Map;
      (acceptance['completed'] as List<String>).add('letter-showcase');
    },
    timeout: const Timeout(Duration(minutes: 8)),
  );
}
