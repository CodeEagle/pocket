import 'package:flutter_test/flutter_test.dart';

import 'guest_interaction_test.dart' as guest;

/// Wait for the same loading feedback the player sees before choosing a slot.
Future<void> waitForNovelSlotPage(WidgetTester tester) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    if (!guest.texts(tester).any((text) => text.contains('正在读取'))) return;
  }
  fail('The actual slot list did not finish loading: ${guest.texts(tester)}');
}

/// Select a slot and explicitly accept its visible overwrite confirmation.
Future<void> saveNovelSlot(WidgetTester tester, String slot) async {
  await waitForNovelSlotPage(tester);
  await guest.tapGuest(tester, '信笺 $slot');
  for (var attempt = 0; attempt < 200; attempt++) {
    final labels = guest.texts(tester);
    if (labels.any((text) => text.contains('信笺 $slot 已封存'))) return;
    if (labels.any((text) => text.contains('覆盖存档 $slot？'))) {
      await guest.tapGuest(tester, '确认', scroll: false);
      await guest.waitForContaining(tester, '信笺 $slot 已封存');
      return;
    }
    await tester.pump(const Duration(milliseconds: 30));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
  }
  fail('The actual guest did not save slot $slot: ${guest.texts(tester)}');
}
