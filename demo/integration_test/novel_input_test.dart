import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';
import 'novel_mesh_span_diagnostics.dart' show readNovelBundledGuestIdentity;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Keep desktop acceptance pump-driven when its window is occluded.
  // PocketView, the IME transport and the painted frame remain live.
  binding.framePolicy = Platform.isMacOS
      ? LiveTestWidgetsFlutterBindingFramePolicy.fadePointers
      : LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  const tourOnly = bool.fromEnvironment('POCKET_INPUT_TOUR_ONLY');
  binding.reportData = {
    'pocketAcceptance': {
      'required': tourOnly ? ['tour-input'] : ['main-input', 'tour-input'],
      'completed': <String>[],
    },
  };

  if (!tourOnly) {
    testWidgets('Lantern story fields use the PocketView Flutter IME protocol', (
      tester,
    ) async {
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
      // IntegrationTestWidgetsFlutterBinding has no widget-test text-input stub
      // by default. Register it to drive the same TextInputClient that a system
      // IME uses, while leaving the real PocketView and guest event bridge live.
      tester.testTextInput.register();
      try {
        await tester.pumpWidget(pocketHostApp());
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');

        await _advanceUntilVisible(tester, '问 Ren：那晚中继熄灭时发生了什么？');
        await _tapGuestText(tester, '问 Ren：那晚中继熄灭时发生了什么？');
        await _advanceUntilVisible(tester, '把信封和旧七号邮路图对照。');
        await _tapGuestText(tester, '把信封和旧七号邮路图对照。');
        await _advanceUntilVisible(tester, '从灯塔窗沿沿七号线追到收信亭。');
        await _tapGuestText(tester, '从灯塔窗沿沿七号线追到收信亭。');
        await _advanceUntilVisible(tester, '趁窗口还在，留一张回邮签。');
        await _tapGuestText(tester, '趁窗口还在，留一张回邮签。');
        await _advanceUntilVisible(tester, '收好行囊，继续寄信');
        await _tapGuestText(tester, '收好行囊，继续寄信');
        await _advanceUntilVisible(tester, '例如：小岚🙂');
        await guest.tapGuest(tester, '例如：小岚🙂', scroll: false);
        await _waitForTextClient(tester);
        expect(find.byType(TextField), findsOneWidget);
        expect(find.byType(EditableText), findsOneWidget);
        expect(tester.testTextInput.isVisible, isTrue);
        await _waitForGuestTextAbsent(tester, '例如：小岚🙂');
        final skinnedEditor = tester.widget<TextField>(find.byType(TextField));
        expect(skinnedEditor.decoration?.fillColor, Colors.transparent);
        for (final border in [
          skinnedEditor.decoration?.border,
          skinnedEditor.decoration?.enabledBorder,
          skinnedEditor.decoration?.focusedBorder,
        ]) {
          expect(border!.borderSide.color, Colors.transparent);
        }
        expect(skinnedEditor.cursorColor, skinnedEditor.style?.color);

        // The value travels through Flutter TextInputClient and PocketView's
        // textInput.edit event, then changes the guest frame and story value.
        tester.testTextInput.enterText('林岚🙂');
        await tester.pump();
        await _waitForEditableValue(tester, '林岚🙂');
        expect(
          _guestHasText(tester, '林岚🙂'),
          isFalse,
          reason:
              'focused input value must be painted by the native editor once, not repeated in Guest DrawOps',
        );
        const composingValue = TextEditingValue(
          text: '林岚🙂',
          selection: TextSelection.collapsed(offset: 4),
          composing: TextRange(start: 2, end: 4),
        );
        tester.testTextInput.updateEditingValue(composingValue);
        await tester.pump();
        await _waitForEditableValue(tester, '林岚🙂');
        final composingEditor = tester.widget<EditableText>(
          find.byType(EditableText),
        );
        expect(
          composingEditor.controller.value.selection,
          composingValue.selection,
        );
        expect(
          composingEditor.controller.value.composing,
          composingValue.composing,
        );
        expect(
          _guestHasText(tester, '林岚🙂'),
          isFalse,
          reason:
              'composing CJK/emoji remains in EditableText while the Guest duplicate is suppressed',
        );
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        await _waitForClosedTextClient(tester);
        await guest.tapGuest(tester, '提交', scroll: false);
        await guest.waitForContaining(tester, '回邮签上的收件人写着 林岚🙂');

        await _advanceUntilVisible(tester, '0–999');
        await guest.tapGuest(tester, '0–999', scroll: false);
        await _waitForTextClient(tester);
        tester.testTextInput.enterText('1000');
        await tester.pump();
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        await _waitForClosedTextClient(tester);
        await guest.tapGuest(tester, '提交', scroll: false);
        await guest.waitForContaining(tester, '不能大于');
        expect(
          guest.texts(tester).join('\n'),
          isNot(contains('编号 1000')),
          reason:
              'invalid numeric input must stay at its field instead of advancing the story',
        );

        // A second editor session corrects the draft using exponent syntax; only
        // its explicit done action commits the typed number and continues JS.
        await guest.tapGuest(tester, '1000', scroll: false);
        await _waitForTextClient(tester);
        tester.testTextInput.enterText('1e2');
        await tester.pump();
        await _waitForEditableValue(tester, '1e2');
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        await _waitForClosedTextClient(tester);
        await guest.tapGuest(tester, '提交', scroll: false);
        await guest.waitForContaining(tester, '编号 100');
        await _advanceUntilVisible(tester, '你同意把自己的署名也记进站史簿吗');
        await guest.tapGuest(tester, '是', scroll: false);
        _printInputGuestTextOps(tester, 'after-boolean-yes');
        await guest.tapGuest(tester, '提交', scroll: false);
        _printInputGuestTextOps(tester, 'after-boolean-submit');
        await _advanceUntilVisible(tester, '我会把你的署名和 林岚🙂 的回邮格一起收好');

        // This runs through Flutter's test TextInputClient and real PocketView
        // guest protocol. It does not claim to exercise a physical key, OS IME
        // candidate window or hardware keyboard on a device.
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        if (tester.testTextInput.isRegistered) {
          tester.testTextInput.unregister();
        }
        await _restoreIsolatedSupportAfterWrites(tester, isolatedSupport);
        final normalStoreAfter = await normalStore.exists()
            ? await normalStore.readAsBytes()
            : null;
        expect(
          normalStoreAfter,
          normalStoreBefore,
          reason:
              'main-story input regression must leave normal app storage unchanged',
        );
      }
      _markCompleted(binding, 'main-input');
    });
  }

  testWidgets(
    'five-minute tour input shows one native copy while focused and restores guest text on blur at 329x600',
    (tester) async {
      const dpr = 2.0;
      tester.view.devicePixelRatio = dpr;
      tester.view.physicalSize = const Size(658, 1200);
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

      final output = await tester.runAsync(
        () => Directory.systemTemp.createTemp('pocket-lantern-input-overlay-'),
      );
      expect(output, isNotNull);
      final captureDirectory = output!;
      final captureKey = GlobalKey();
      tester.testTextInput.register();
      try {
        final guestIdentity = await tester.runAsync(
          readNovelBundledGuestIdentity,
        );
        expect(guestIdentity, isNotNull);
        binding.reportData!['inputGuestIdentity'] = guestIdentity;
        debugPrint('LANTERN_INPUT_GUEST ${jsonEncode(guestIdentity)}');
        await tester.pumpWidget(
          Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 329,
              height: 600,
              child: RepaintBoundary(key: captureKey, child: pocketHostApp()),
            ),
          ),
        );
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        debugPrint(
          'novel-input-overlay: logicalViewport=329x600 dpr=$dpr output=${captureDirectory.path}',
        );

        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitForContaining(tester, '雾港末班信');
        await guest.tapGuest(tester, '5分钟能力巡演');
        await guest.waitForContaining(tester, '五分钟巡演');
        await _advanceUntilVisible(tester, '先体验哪一段？');
        debugPrint(
          'LANTERN_INPUT_TOUR_HUB_GEOMETRY ${jsonEncode(_textGeometryFacts(tester, '留一句话'))}',
        );
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'tour-hub-choice-before-input',
          dpr,
        );
        // On a 329 logical-pixel viewport this button wraps across several
        // DrawList text ops. Tap its visible first line inside the same real
        // FocusTarget instead of requiring one op to contain the full caption.
        await _tapGuestText(tester, '留一句话');
        await _advanceUntilVisible(tester, '一句话即可');
        await guest.tapGuest(tester, '一句话即可', scroll: false);
        await _waitForTextClient(tester);
        expect(find.byType(TextField), findsOneWidget);
        expect(tester.testTextInput.isVisible, isTrue);
        final emptyEditor = tester.widget<TextField>(find.byType(TextField));
        expect(emptyEditor.decoration?.hintText, '一句话即可');
        await _waitForGuestTextAbsent(tester, '一句话即可');
        expect(
          _guestHasText(tester, '一句话即可'),
          isFalse,
          reason:
              'once textInput.opened confirms the overlay, the Guest placeholder must not double-paint',
        );
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'focused-empty',
          dpr,
        );

        tester.testTextInput.enterText('林岚🙂');
        await tester.pump();
        await _waitForEditableValue(tester, '林岚🙂');
        expect(_guestHasText(tester, '林岚🙂'), isFalse);
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'focused-cjk-emoji',
          dpr,
        );

        const composingValue = TextEditingValue(
          text: '林岚🙂',
          selection: TextSelection.collapsed(offset: 4),
          composing: TextRange(start: 2, end: 4),
        );
        tester.testTextInput.updateEditingValue(composingValue);
        await tester.pump();
        await _waitForEditableValue(tester, '林岚🙂');
        final composingEditor = tester.widget<EditableText>(
          find.byType(EditableText),
        );
        expect(
          composingEditor.controller.value.composing,
          composingValue.composing,
        );
        expect(
          composingEditor.controller.value.selection,
          composingValue.selection,
        );
        expect(_guestHasText(tester, '林岚🙂'), isFalse);
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'focused-preedit',
          dpr,
        );

        // The prompt is a real guest target outside the editor rect with no
        // submit action. Tapping it exercises Flutter's outside-up dismissal.
        await guest.tapGuest(tester, '留一句给未来的雾港读者', scroll: false);
        await _waitForClosedTextClient(tester);
        await guest.waitForContaining(tester, '林岚🙂');
        expect(
          guest
              .texts(tester)
              .where((text) => _flattenRenderedText(text).contains('林岚🙂'))
              .length,
          1,
          reason:
              'after blur, exactly one guest fallback copy should be visible',
        );
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'blurred-cjk-emoji',
          dpr,
        );

        // Reopen the populated field, replace it with the user's six-CJK
        // sample, and keep that value native while its full composing range is
        // active. The acknowledgement wait below is intentional: this case
        // covers steady focused rendering, not the separate first-overlay
        // frame before the Guest consumes textInput.opened.
        await guest.tapGuest(tester, '林岚🙂', scroll: false);
        await _waitForTextClient(tester);
        await _waitForGuestTextAbsent(tester, '林岚🙂');
        const sixCjk = '小满平安归港';
        tester.testTextInput.enterText(sixCjk);
        await tester.pump();
        await _waitForEditableValue(tester, sixCjk);
        expect(
          _guestHasText(tester, sixCjk),
          isFalse,
          reason:
              'focused six-character CJK value must be painted by EditableText only',
        );

        const sixCjkComposingValue = TextEditingValue(
          text: sixCjk,
          selection: TextSelection.collapsed(offset: 6),
          composing: TextRange(start: 0, end: 6),
        );
        tester.testTextInput.updateEditingValue(sixCjkComposingValue);
        await tester.pump();
        await _waitForEditableValue(tester, sixCjk);
        final sixCjkEditor = tester.widget<EditableText>(
          find.byType(EditableText),
        );
        expect(
          sixCjkEditor.controller.value.selection,
          sixCjkComposingValue.selection,
        );
        expect(
          sixCjkEditor.controller.value.composing,
          sixCjkComposingValue.composing,
        );
        expect(
          _guestHasText(tester, sixCjk),
          isFalse,
          reason:
              'composing six-character CJK must remain in EditableText without a Guest duplicate',
        );
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'focused-six-cjk-preedit',
          dpr,
        );

        await guest.tapGuest(tester, '留一句给未来的雾港读者', scroll: false);
        await _waitForClosedTextClient(tester);
        await guest.waitForContaining(tester, sixCjk);
        expect(
          guest
              .texts(tester)
              .where((text) => _flattenRenderedText(text).contains(sixCjk))
              .length,
          1,
          reason:
              'after blur, the six-character CJK value must return as one Guest fallback copy',
        );
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'blurred-six-cjk',
          dpr,
        );
        await _captureInputOpeningFrame(
          tester,
          captureKey,
          captureDirectory,
          sixCjk,
          dpr,
          () => guest.tapGuest(tester, sixCjk, scroll: false),
        );
        await _waitForTextClient(tester);
        await _waitForGuestTextAbsent(tester, sixCjk);
        final acknowledgedEditor = tester.widget<TextField>(
          find.byType(TextField),
        );
        expect(acknowledgedEditor.style!.color!.a, greaterThan(0));
        await _captureInputScreen(
          tester,
          captureKey,
          captureDirectory,
          'six-cjk-after-opening-ack',
          dpr,
        );
        await guest.tapGuest(tester, '留一句给未来的雾港读者', scroll: false);
        await _waitForClosedTextClient(tester);

        debugPrint(
          'novel-input-overlay: CJK/emoji and six-CJK focused, preedit, blur and opening captures completed',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        if (tester.testTextInput.isRegistered) {
          tester.testTextInput.unregister();
        }
        await _restoreIsolatedSupportAfterWrites(tester, isolatedSupport);
        final normalStoreAfter = await normalStore.exists()
            ? await normalStore.readAsBytes()
            : null;
        expect(
          normalStoreAfter,
          normalStoreBefore,
          reason: 'tour input must leave the normal user store unchanged',
        );
      }
      _markCompleted(binding, 'tour-input');
    },
  );
}

void _markCompleted(
  IntegrationTestWidgetsFlutterBinding binding,
  String checkpoint,
) {
  final pocketAcceptance =
      binding.reportData!['pocketAcceptance'] as Map<String, Object?>;
  final completed = pocketAcceptance['completed'] as List<String>;
  completed.add(checkpoint);
}

Future<void> _restoreIsolatedSupportAfterWrites(
  WidgetTester tester,
  IsolatedNovelSupportDirectory isolatedSupport,
) async {
  final path = isolatedSupport.path;
  await _waitForSupportTreeStable(tester, path);
  try {
    await isolatedSupport.restore();
  } on FileSystemException catch (error) {
    // The store may finish its final atomic history write just as PocketView
    // unmounts. restore() has already reinstated the real path provider; wait
    // for a stable tree and retry deleting only this test-owned temp directory.
    debugPrint('input-overlay: retrying isolated support cleanup: $error');
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

Future<void> _waitForEditableValue(WidgetTester tester, String value) async {
  for (var index = 0; index < 160; index++) {
    if (find.byType(EditableText).evaluate().isNotEmpty &&
        tester.testTextInput.hasAnyClients &&
        tester.testTextInput.isVisible &&
        tester
                .widget<EditableText>(find.byType(EditableText))
                .controller
                .text ==
            value) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail('EditableText did not show "$value"; guest=${guest.texts(tester)}');
}

Future<void> _waitForGuestTextAbsent(WidgetTester tester, String value) async {
  for (var index = 0; index < 160; index++) {
    if (!_guestHasText(tester, value)) return;
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail('Guest text "$value" remained after native overlay attachment');
}

String _flattenRenderedText(String value) =>
    value.replaceAll(RegExp(r'[\r\n]+'), '');

bool _guestHasText(WidgetTester tester, String value) => guest
    .texts(tester)
    .any((text) => _flattenRenderedText(text).contains(value));

Future<void> _captureInputScreen(
  WidgetTester tester,
  GlobalKey key,
  Directory directory,
  String name,
  double pixelRatio,
) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: pixelRatio);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    expect(data, isNotNull);
    final bytes = data!.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    final file = File('${directory.path}/$name.png');
    await tester.runAsync(() => file.writeAsBytes(bytes, flush: true));
    expect(image.width, 658);
    expect(image.height, 1200);
    debugPrint(
      'LANTERN_INPUT_SCREEN ${jsonEncode({
        'name': name,
        'path': file.path,
        'pngBytes': bytes.length,
        'pixels': [image.width, image.height],
        'logicalViewport': [329, 600],
        'dpr': pixelRatio,
        'guestText': guest.texts(tester),
      })}',
    );
  } finally {
    image.dispose();
  }
}

/// Inspect the first painted overlay frame before its post-frame mount ACK.
/// Register before the real pointer gesture, without advancing the Guest or
/// changing production scheduling. Capture pixels synchronously so a later ACK
/// cannot replace the opening frame while GPU readback is pending.
Future<void> _captureInputOpeningFrame(
  WidgetTester tester,
  GlobalKey captureKey,
  Directory directory,
  String value,
  double dpr,
  Future<void> Function() open,
) async {
  ui.Image? image;
  Map<String, Object?>? facts;
  var watching = true;
  void inspect(Duration _) {
    if (!watching) return;
    final fields = find.byType(TextField);
    if (fields.evaluate().isEmpty) {
      tester.binding.addPostFrameCallback(inspect);
      return;
    }
    final field = fields.evaluate().single.widget as TextField;
    final fallbackVisible = find
        .byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is PocketCanvasPainter,
        )
        .evaluate()
        .any((element) {
          final painter =
              (element.widget as CustomPaint).painter! as PocketCanvasPainter;
          return painter.ops.whereType<PocketTextOp>().any(
            (op) => _flattenRenderedText(op.text).contains(value),
          );
        });
    facts = {
      'controllerText': field.controller!.text,
      'nativeTextColor': field.style!.color!.toARGB32(),
      'nativeTextAlpha': field.style!.color!.a,
      'guestFallbackVisible': fallbackVisible,
      'logicalViewport': [329, 600],
      'dpr': dpr,
    };
    final boundary =
        captureKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    image = boundary.toImageSync(pixelRatio: dpr);
    watching = false;
  }

  tester.binding.addPostFrameCallback(inspect);
  try {
    await open();
    expect(image, isNotNull, reason: 'Capture the first native overlay paint');
    expect(facts!['controllerText'], value);
    expect(
      facts!['guestFallbackVisible'],
      isTrue,
      reason: 'The opening capture must precede Guest mount acknowledgement',
    );
    final bytes = (await image!.toByteData(
      format: ui.ImageByteFormat.png,
    ))!.buffer.asUint8List();
    final file = File('${directory.path}/six-cjk-opening-first-frame.png');
    await tester.runAsync(() => file.writeAsBytes(bytes, flush: true));
    debugPrint(
      'LANTERN_INPUT_OPEN_FRAME ${jsonEncode({...facts!, 'path': file.path, 'pngBytes': bytes.length})}',
    );
    const requireTransparent = bool.fromEnvironment(
      'POCKET_INPUT_HANDOFF_REQUIRE_TRANSPARENT',
    );
    if (requireTransparent) {
      expect(
        facts!['nativeTextAlpha'],
        0,
        reason: 'Guest fallback and native glyphs must never paint together',
      );
    }
  } finally {
    watching = false;
    image?.dispose();
  }
}

Future<void> _advanceDialogue(
  WidgetTester tester,
  String actualContinueText,
) async {
  // Use the exact wrapped DrawList text that was just checked for completion.
  await guest.tapGuest(tester, actualContinueText, scroll: false);
}

Future<void> _tapGuestText(WidgetTester tester, String fragment) async {
  final normalizedFragment = fragment.replaceAll(RegExp(r'\s+'), ' ').trim();
  for (var index = 0; index < 100; index++) {
    final op = _textOpContaining(tester, normalizedFragment);
    if (op != null) {
      // Pass the actual wrapped DrawList text to the shared helper. It
      // requires stable, unclipped geometry and sends a real Flutter pointer.
      await guest.tapGuest(tester, op.text, scroll: false);
      return;
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail(
    'No stable visible guest text containing "$fragment"; '
    'actual=${guest.texts(tester)}',
  );
}

PocketTextOp? _textOpContaining(WidgetTester tester, String fragment) {
  for (final paintWidget in guest.painters(tester).toList().reversed) {
    final painter = paintWidget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      final normalizedText = op.text.replaceAll(RegExp(r'\s+'), ' ').trim();
      if (!normalizedText.contains(fragment)) continue;
      return op;
    }
  }
  return null;
}

Map<String, Object?> _textGeometryFacts(WidgetTester tester, String fragment) {
  final normalizedFragment = fragment.replaceAll(RegExp(r'\s+'), ' ').trim();
  final activeViews = <Map<String, Object?>>[];
  for (final element in guest.activePocketViewFinder().evaluate()) {
    final renderObject = element.renderObject;
    if (renderObject is RenderBox) {
      activeViews.add({
        'size': [renderObject.size.width, renderObject.size.height],
      });
    }
  }
  final matches = <Map<String, Object?>>[];
  for (final paintWidget in guest.painters(tester)) {
    final painter = paintWidget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(paintWidget));
    for (var index = 0; index < painter.ops.length; index++) {
      final op = painter.ops[index];
      if (op is! PocketTextOp) continue;
      final normalizedText = op.text.replaceAll(RegExp(r'\s+'), ' ').trim();
      if (!normalizedText.contains(normalizedFragment)) continue;
      final rawRect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      var visibleRect = rawRect;
      if (op.clip != null) {
        visibleRect = visibleRect.intersect(
          Rect.fromLTWH(
            op.clip!.x,
            op.clip!.y,
            op.clip!.width,
            op.clip!.height,
          ),
        );
      }
      visibleRect = visibleRect.intersect(
        Rect.fromLTWH(0, 0, painter.width, painter.height),
      );
      final scaleX = box.size.width / painter.width;
      final scaleY = box.size.height / painter.height;
      final globalTopLeft = box.localToGlobal(
        Offset(rawRect.left * scaleX, rawRect.top * scaleY),
      );
      final globalBottomRight = box.localToGlobal(
        Offset(rawRect.right * scaleX, rawRect.bottom * scaleY),
      );
      matches.add({
        'text': op.text,
        'opIndex': index,
        'raw': [rawRect.left, rawRect.top, rawRect.width, rawRect.height],
        'clip': op.clip == null
            ? null
            : [op.clip!.x, op.clip!.y, op.clip!.width, op.clip!.height],
        'visible': [
          visibleRect.left,
          visibleRect.top,
          visibleRect.width,
          visibleRect.height,
        ],
        'painterSize': [painter.width, painter.height],
        'paintBoxSize': [box.size.width, box.size.height],
        'globalRaw': [
          globalTopLeft.dx,
          globalTopLeft.dy,
          globalBottomRight.dx - globalTopLeft.dx,
          globalBottomRight.dy - globalTopLeft.dy,
        ],
        'exactPoint': guest.pointFor(tester, op.text)?.toString(),
      });
    }
  }
  return {'activePocketViews': activeViews, 'matches': matches};
}

Future<void> _advanceUntilVisible(WidgetTester tester, String target) async {
  final normalizedTarget = _collapseTextSpaces(target);
  for (var index = 0; index < 120; index++) {
    if (_visibleGuestTextContaining(tester, normalizedTarget)
        case final text?) {
      if (target.startsWith('我会把你的署名和')) {
        debugPrint(
          'LANTERN_MAIN_INPUT_COMPLETION_TEXT ${jsonEncode({'target': target, 'drawOpText': text})}',
        );
      }
      return;
    }

    // Wait for the current line's real continue prompt without tapping it.
    // A target line may be partially typed now, then become complete while
    // this wait runs. Recheck it before sending a pointer so we do not skip
    // the expected line by advancing immediately after it finishes.
    final continueText = await _waitForContinueOrTarget(
      tester,
      normalizedTarget,
    );
    if (_visibleGuestTextContaining(tester, normalizedTarget)
        case final text?) {
      if (target.startsWith('我会把你的署名和')) {
        debugPrint(
          'LANTERN_MAIN_INPUT_COMPLETION_TEXT ${jsonEncode({'target': target, 'drawOpText': text})}',
        );
      }
      return;
    }
    if (continueText == null) {
      fail('Lantern target "$target" appeared and disappeared before continue');
    }
    debugPrint(
      'LANTERN_INPUT_ADVANCE ${jsonEncode({'index': index, 'target': target, 'continueText': continueText, 'guestTextOps': _inputGuestTextOps(tester)})}',
    );
    await _advanceDialogue(tester, continueText);
  }
  fail('Lantern did not reach "$target"; actual=${guest.texts(tester)}');
}

String? _visibleGuestTextContaining(WidgetTester tester, String target) => guest
    .texts(tester)
    .cast<String?>()
    .firstWhere(
      (text) =>
          text != null &&
          _renderedTextVariants(
            text,
          ).any((variant) => variant.contains(target)),
      orElse: () => null,
    );

Future<String?> _waitForContinueOrTarget(
  WidgetTester tester,
  String target,
) async {
  for (var index = 0; index < 160; index++) {
    if (_visibleGuestTextContaining(tester, target) != null) return null;
    final continueOp = _textOpContaining(tester, '轻触继续');
    if (continueOp != null) return continueOp.text;
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail(
    'Neither target nor completed dialogue was painted while waiting for "$target"; '
    'actual=${guest.texts(tester)}',
  );
}

void _printInputGuestTextOps(WidgetTester tester, String phase) {
  debugPrint(
    'LANTERN_INPUT_TEXT_OPS ${jsonEncode({'phase': phase, 'ops': _inputGuestTextOps(tester)})}',
  );
}

List<Map<String, Object?>> _inputGuestTextOps(WidgetTester tester) {
  final result = <Map<String, Object?>>[];
  for (final paintWidget in guest.painters(tester).toList().reversed) {
    final painter = paintWidget.painter! as PocketCanvasPainter;
    for (var index = 0; index < painter.ops.length; index++) {
      final op = painter.ops[index];
      if (op is! PocketTextOp) continue;
      result.add({
        'text': op.text,
        'opIndex': index,
        'rect': [op.x, op.y, op.width, op.height],
        'clip': op.clip == null
            ? null
            : [op.clip!.x, op.clip!.y, op.clip!.width, op.clip!.height],
      });
      if (result.length == 12) return result;
    }
  }
  return result;
}

String _collapseTextSpaces(String value) =>
    value.replaceAll(RegExp(r'[ \t]+'), ' ').trim();

Iterable<String> _renderedTextVariants(String value) sync* {
  yield _collapseTextSpaces(value.replaceAll(RegExp(r'[\r\n]+'), ''));
  yield _collapseTextSpaces(value.replaceAll(RegExp(r'[\r\n]+'), ' '));
}

Future<void> _waitForTextClient(WidgetTester tester) async {
  for (var index = 0; index < 160; index++) {
    if (find.byType(EditableText).evaluate().isNotEmpty &&
        tester.testTextInput.hasAnyClients &&
        tester.testTextInput.isVisible) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Lantern Flutter text client did not open: '
    'editable=${find.byType(EditableText).evaluate().length}, '
    'clients=${tester.testTextInput.hasAnyClients}, visible=${tester.testTextInput.isVisible}',
  );
}

Future<void> _waitForClosedTextClient(WidgetTester tester) async {
  for (var index = 0; index < 160; index++) {
    if (find.byType(EditableText).evaluate().isEmpty &&
        !tester.testTextInput.hasAnyClients) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Lantern Flutter text client did not close: '
    'editable=${find.byType(EditableText).evaluate().length}, '
    'clients=${tester.testTextInput.hasAnyClients}',
  );
}
