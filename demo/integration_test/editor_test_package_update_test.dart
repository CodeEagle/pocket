import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

const _version = String.fromEnvironment('POCKET_TEST_UPDATE_VERSION');
const _namespace = String.fromEnvironment('POCKET_STORE_NAMESPACE');

Future<void> _updates(WidgetTester tester) async {
  await guest.tapGuest(tester, 'Host');
  await guest.waitForContaining(tester, 'Runtime');
  await guest.tapGuest(tester, 'Updates');
  await guest.waitForContaining(tester, 'Current status');
  await guest.waitForContaining(tester, 'stage=ready');
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('Editor signed test package checks, applies, and survives a guest restart', (tester) async {
    expect(_version, isNotEmpty);
    expect(_namespace.startsWith('editor_smoke_'), isTrue,
      reason: 'Acceptance must not delete the interactive Editor package store');
    expect(showcaseConfig.updates!.configured, isTrue);
    try {
      await tester.pumpWidget(pocketHostApp());
      await guest.waitFor(tester, '00');
      await _updates(tester);
      await guest.tapGuest(tester, 'Check');
      await guest.waitForContaining(tester, 'available=$_version');
      final before = tester.widget<PocketView>(guest.activePocketViewFinder()).key;
      await guest.tapGuest(tester, 'Apply');
      var replaced = false;
      for (var i = 0; i < 300; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        final views = find.byType(PocketView);
        if (views.evaluate().isNotEmpty && tester.widget<PocketView>(guest.activePocketViewFinder()).key != before) {
          replaced = true;
          break;
        }
      }
      expect(replaced, isTrue, reason: 'OTA must replace the native guest instance');
      await guest.waitFor(tester, '00');
      await _updates(tester);
      await guest.waitForContaining(tester, 'active=$_version');
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(pocketHostApp());
      await guest.waitFor(tester, '00');
      await _updates(tester);
      await guest.waitForContaining(tester, 'active=$_version');
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));
      if (_namespace.startsWith('editor_smoke_') && RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(_namespace)) {
        final support = await getApplicationSupportDirectory();
        final store = Directory('${support.path}/pocket-packages/${showcaseConfig.appId}/$_namespace');
        if (await store.exists()) await store.delete(recursive: true);
      }
    }
  });
}
