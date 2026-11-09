import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart' show pocketHostApp;

import 'guest_interaction_test.dart' as guest;
import 'novel_test_driver.dart' as novel;

final class _SlotRowPaintFact {
  const _SlotRowPaintFact({
    required this.alpha,
    required this.rect,
    required this.clip,
    required this.clipCenter,
    required this.visible,
  });

  final int alpha;
  final ui.Rect rect;
  final ui.Rect? clip;
  final Offset? clipCenter;
  final ui.Rect visible;

  bool get pointable => !visible.isEmpty && visible.height >= rect.height * .5;

  @override
  String toString() =>
      'alpha=$alpha rect=$rect clip=${clip ?? 'none'} visible=$visible';
}

final class _SlotRowPaintSnapshot {
  const _SlotRowPaintSnapshot({
    required this.point,
    required this.loading,
    required this.rows,
  });

  final Offset? point;
  final bool loading;
  final List<_SlotRowPaintFact> rows;

  int? get hitAlpha {
    for (final row in rows) {
      if (row.pointable) return row.alpha;
    }
    return null;
  }

  bool get enabled => !loading && point != null && hitAlpha == 0xff;

  @override
  String toString() =>
      'point=$point loading=$loading hitAlpha=$hitAlpha rows=${rows.join('; ')}';
}

_SlotRowPaintSnapshot _slotRowPaintSnapshot(WidgetTester tester, String label) {
  final rows = <_SlotRowPaintFact>[];
  for (final widget in guest.painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    final scaleX = box.size.width / painter.width;
    final scaleY = box.size.height / painter.height;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (op.text != label) continue;
      final rect = ui.Rect.fromLTWH(op.x, op.y, op.width, op.height);
      final clip = op.clip == null
          ? null
          : ui.Rect.fromLTWH(
              op.clip!.x,
              op.clip!.y,
              op.clip!.width,
              op.clip!.height,
            );
      final clipCenter = clip == null
          ? null
          : box.localToGlobal(
              Offset(clip.center.dx * scaleX, clip.center.dy * scaleY),
            );
      var visible = clip == null ? rect : rect.intersect(clip);
      visible = visible.intersect(
        ui.Rect.fromLTWH(0, 0, painter.width, painter.height),
      );
      rows.add(
        _SlotRowPaintFact(
          alpha: (op.color >>> 24) & 0xff,
          rect: rect,
          clip: clip,
          clipCenter: clipCenter,
          visible: visible,
        ),
      );
    }
  }
  final labels = guest.texts(tester);
  return _SlotRowPaintSnapshot(
    point: guest.pointFor(tester, label),
    loading: labels.any((text) => text.contains('正在读取')),
    rows: rows,
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Lantern manages raw disk slots through painted UI and Flutter IME',
    (tester) async {
      tester.testTextInput.register();
      final support = await getApplicationSupportDirectory();
      final file = File(
        '${support.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final suffix = (DateTime.now().microsecondsSinceEpoch % 1000000)
          .toString();
      final copied = 'p${suffix}a';
      final moved = 'p${suffix}b';
      Map<String, dynamic> disk = {};
      var destinationValue = '';

      Future<void> frame() async {
        await tester.pump(const Duration(milliseconds: 30));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
      }

      Future<_SlotRowPaintSnapshot> waitForEnabledSlotRow(String label) async {
        _SlotRowPaintSnapshot? initial;
        for (var attempt = 0; attempt < 200; attempt++) {
          final snapshot = _slotRowPaintSnapshot(tester, label);
          initial ??= snapshot;
          if (snapshot.enabled) {
            if (attempt > 0) {
              debugPrint(
                'novel-slots: row="$label" became enabled after $attempt '
                'frames; initial=$initial enabled=$snapshot',
              );
            }
            return snapshot;
          }
          await frame();
        }
        final finalSnapshot = _slotRowPaintSnapshot(tester, label);
        fail(
          'Slot row did not become visibly enabled before selection: '
          'label="$label" final=$finalSnapshot '
          'painted=${guest.texts(tester)}',
        );
      }

      String slotLabel(String slot) => slot == 'quick' ? '快速存档' : '信笺 $slot';

      Future<void> dragManagementList(
        String label,
        List<String> pageSlots,
        int targetIndex,
      ) async {
        final target = _slotRowPaintSnapshot(tester, label);
        if (target.point != null) return;

        // Resolve direction from the target's clipped paint geometry first.
        // A row above the viewport needs a real downward finger drag; one
        // below it needs the usual upward drag. When that row is not emitted,
        // compare actual visible row labels against the page's known ordering.
        bool? dragDown;
        Offset? scrollCenter;
        for (final row in target.rows) {
          scrollCenter ??= row.clipCenter;
          final clip = row.clip;
          if (clip == null) continue;
          if (row.rect.bottom <= clip.top) {
            dragDown = true;
            break;
          }
          if (row.rect.top >= clip.bottom) {
            dragDown = false;
            break;
          }
          if (row.visible.height < row.rect.height * .5) {
            if (row.rect.top < clip.top) {
              dragDown = true;
              break;
            }
            if (row.rect.bottom > clip.bottom) {
              dragDown = false;
              break;
            }
          }
        }
        if (dragDown == null) {
          final visibleIndices = <int>[];
          for (var index = 0; index < pageSlots.length; index++) {
            final row = _slotRowPaintSnapshot(
              tester,
              slotLabel(pageSlots[index]),
            );
            for (final fact in row.rows) {
              scrollCenter ??= fact.clipCenter;
            }
            if (row.rows.any((fact) => fact.pointable)) {
              visibleIndices.add(index);
            }
          }
          if (visibleIndices.isEmpty) return;
          visibleIndices.sort(
            (left, right) => (left - targetIndex).abs().compareTo(
              (right - targetIndex).abs(),
            ),
          );
          dragDown = targetIndex < visibleIndices.first;
        }

        if (scrollCenter == null) return;
        final gesture = await tester.startGesture(scrollCenter);
        final deltaY = dragDown == true ? 23.0 : -23.0;
        for (var step = 0; step < 10; step++) {
          await gesture.moveBy(Offset(0, deltaY));
          await tester.pump(const Duration(milliseconds: 16));
          if (_slotRowPaintSnapshot(tester, label).point != null) break;
        }
        // Match the established guest.reveal gesture's low-velocity release.
        for (var step = 0; step < 3; step++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        await gesture.up();
        await tester.pump(const Duration(milliseconds: 100));
      }

      Future<Offset> revealManagementSlot(
        String slot,
        String label,
        List<String> pageSlots,
      ) async {
        final targetIndex = pageSlots.indexOf(slot);
        expect(targetIndex, greaterThanOrEqualTo(0));
        for (var attempt = 0; attempt < 8; attempt++) {
          final snapshot = _slotRowPaintSnapshot(tester, label);
          if (snapshot.point != null) {
            return guest.reveal(tester, label, scroll: false);
          }
          await dragManagementList(label, pageSlots, targetIndex);
          await frame();
        }
        fail(
          'Could not reveal slot row through the real management scroll: '
          'slot=$slot page=$pageSlots row=${_slotRowPaintSnapshot(tester, label)} '
          'painted=${guest.texts(tester)}',
        );
      }

      Future<void> waitForDisk(
        bool Function(Map<String, dynamic>) matches,
      ) async {
        for (var attempt = 0; attempt < 200; attempt++) {
          final read = await tester.runAsync(() async {
            try {
              final all = jsonDecode(await file.readAsString()) as Map;
              return Map<String, dynamic>.from(
                (all['private'] as Map)['pocket.demo.lantern'] as Map,
              );
            } on Object {
              return null;
            }
          });
          if (read != null) {
            disk = read;
            if (matches(disk)) return;
          }
          await frame();
        }
        fail(
          'Actual native slot file did not commit the expected UI operation; '
          'keys=${disk.keys.where((key) => key.startsWith("lantern.slot."))}; '
          'painted=${guest.texts(tester)}',
        );
      }

      String key(String slot) => 'lantern.slot.$slot';
      String? line(Map<String, dynamic> data, String slot) =>
          data[key(slot)]?['state']?['active']?['id'] as String?;
      Future<void> enterDestination(String value) async {
        await guest.tapGuest(
          tester,
          destinationValue.isEmpty ? '输入存档 ID' : destinationValue,
        );
        for (var attempt = 0; attempt < 100; attempt++) {
          if (find.byType(EditableText).evaluate().isNotEmpty &&
              tester.testTextInput.hasAnyClients) {
            break;
          }
          await frame();
        }
        expect(find.byType(EditableText), findsOneWidget);
        tester.testTextInput.enterText(value);
        await tester.pump();
        await tester.testTextInput.receiveAction(TextInputAction.done);
        for (var attempt = 0; attempt < 100; attempt++) {
          if (!tester.testTextInput.hasAnyClients) break;
          await frame();
        }
        expect(tester.testTextInput.hasAnyClients, isFalse);
        await guest.waitFor(tester, value);
        destinationValue = value;
      }

      Future<void> selectSlot(String slot) async {
        await novel.waitForNovelSlotPage(tester);
        final label = slot == 'quick' ? '快速存档' : '信笺 $slot';
        // Use observed disk IDs to navigate the four-item UI pages, then scroll
        // to the actual painted action. No list or selection state is injected.
        final custom =
            disk.keys
                .where((key) => key.startsWith('lantern.slot.'))
                .map((key) => key.substring('lantern.slot.'.length))
                .where((id) => !['auto', 'quick', '1', '2', '3'].contains(id))
                .toList()
              ..sort();
        final ids = [
          '1',
          '2',
          '3',
          ...custom,
          if (disk.containsKey(key('quick'))) 'quick',
        ];
        expect(ids, contains(slot));
        final targetPage = ids.indexOf(slot) ~/ 4 + 1;
        final pageStart = (targetPage - 1) * 4;
        final pageSlots = ids.skip(pageStart).take(4).toList();
        for (var attempt = 0; attempt < 128; attempt++) {
          final page = RegExp(r'第(\d+)/(\d+)页').firstMatch(
            guest.texts(tester).join('').replaceAll(RegExp(r'\s+'), ''),
          );
          expect(page, isNotNull);
          final current = int.parse(page!.group(1)!);
          final total = int.parse(page.group(2)!);
          if (total < targetPage) {
            // Native commit can precede the view's list refresh.
            await frame();
            await novel.waitForNovelSlotPage(tester);
            continue;
          }
          if (current == targetPage) {
            // The storage file can commit before mutateSlots has finished
            // refreshing the guest list and clearing its busy state. The
            // actual row alpha reflects Action.disabled; wait for the
            // target row's real scroll position before waiting for its
            // enabled paint and the loading label to disappear. This avoids
            // both offscreen waits and retrying a disabled row.
            await revealManagementSlot(slot, label, pageSlots);
            await waitForEnabledSlotRow(label);
            final point = await guest.reveal(tester, label, scroll: false);
            final before = _slotRowPaintSnapshot(tester, label);
            if (!before.enabled ||
                before.point == null ||
                (point - before.point!).distance >= .5) {
              fail(
                'Slot row changed after its enabled/stable barrier; '
                'tap not sent. label="$label" reveal=$point state=$before',
              );
            }
            final gesture = await tester.startGesture(point);
            await tester.pump(const Duration(milliseconds: 50));
            final down = _slotRowPaintSnapshot(tester, label);
            await gesture.up();
            await tester.pump(const Duration(milliseconds: 550));
            final afterUp = _slotRowPaintSnapshot(tester, label);
            for (var settle = 0; settle < 100; settle++) {
              if (guest.texts(tester).contains('来源 · $slot')) return;
              await frame();
            }
            fail(
              'Slot row was visibly enabled at the stable tap point, but '
              'selection did not paint. label="$label" point=$point '
              'before=$before down=$down after=$afterUp '
              'painted=${guest.texts(tester)}',
            );
          }
          await guest.tapGuest(
            tester,
            current < targetPage ? '下一页' : '上一页',
            scroll: false,
          );
          await frame();
          await novel.waitForNovelSlotPage(tester);
        }
        fail('Slot list did not expose $slot');
      }

      try {
        await tester.pumpWidget(pocketHostApp());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.tapGuest(tester, '封存此刻', scroll: false);
        await novel.saveNovelSlot(tester, '1');
        await waitForDisk((data) => line(data, '1') == 'arrival_01');
        final firstSave = disk[key('1')];
        await guest.tapGuest(tester, '返回', scroll: false);
        for (var attempt = 0; attempt < 100; attempt++) {
          await waitForDisk((data) => line(data, 'auto') != null);
          if (line(disk, 'auto') == 'arrival_02') break;
          final point =
              guest.pointFor(tester, '轻触继续  ›') ??
              guest.pointFor(tester, '轻触显全');
          if (point != null) {
            final pointer = await tester.startGesture(point);
            await tester.pump(const Duration(milliseconds: 30));
            await pointer.up();
          }
          await frame();
        }
        await waitForDisk((data) => line(data, 'auto') == 'arrival_02');
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.tapGuest(tester, '快速保存此刻');
        await guest.waitForContaining(tester, '快速存档已更新');
        await waitForDisk((data) => line(data, 'quick') == 'arrival_02');
        final quickSave = disk[key('quick')];
        expect(line(disk, 'auto'), 'arrival_02');
        await guest.tapGuest(tester, '封存此刻');
        await novel.waitForNovelSlotPage(tester);
        await guest.tapGuest(tester, '管理存档');
        await selectSlot('1');
        await enterDestination(copied);
        await guest.tapGuest(tester, '复制到 ID');
        await waitForDisk((data) => data.containsKey(key(copied)));
        expect(disk[key(copied)], firstSave);
        await selectSlot(copied);
        await enterDestination(moved);
        await guest.tapGuest(tester, '移动到 ID');
        await waitForDisk(
          (data) =>
              !data.containsKey(key(copied)) && data.containsKey(key(moved)),
        );
        expect(disk[key(moved)], firstSave);
        await selectSlot('1');
        await enterDestination('quick');
        await guest.tapGuest(tester, '与 ID 交换');
        await guest.waitFor(tester, '交换 1 与 quick？');
        // The confirmation is observable before any durable mutation.
        await waitForDisk((data) => line(data, '1') == 'arrival_01');
        await guest.tapGuest(tester, '确认', scroll: false);
        await waitForDisk(
          (data) =>
              line(data, '1') == 'arrival_02' &&
              line(data, 'quick') == 'arrival_01',
        );
        expect(disk[key('1')], quickSave);
        expect(disk[key('quick')], firstSave);
        await selectSlot(moved);
        await guest.tapGuest(tester, '删除来源');
        await guest.waitFor(tester, '删除存档 $moved？');
        await guest.tapGuest(tester, '确认', scroll: false);
        await waitForDisk((data) => !data.containsKey(key(moved)));

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.pumpWidget(pocketHostApp());
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '重读信笺');
        await novel.waitForNovelSlotPage(tester);
        await guest.tapGuest(tester, '快速存档');
        await guest.waitForContaining(tester, '23点08分');
        await waitForDisk((data) => line(data, 'auto') == 'arrival_01');
        debugPrint(
          'novel-slot-management: real OS copy/move/swap/delete, '
          'dedicated quick slot and fresh-host load passed through pointer/IME',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        tester.testTextInput.unregister();
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
