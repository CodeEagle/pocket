import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'guest_interaction_test.dart' as guest;

const _updateUrl = String.fromEnvironment('POCKET_UPDATE_URL');
const _controlUrl = String.fromEnvironment('POCKET_TEST_CONTROL_URL');
const _storeNamespace = String.fromEnvironment('POCKET_STORE_NAMESPACE');

Future<void> _waitForContaining(WidgetTester tester, String fragment) async {
  for (var index = 0; index < 500; index++) {
    await tester.pump(const Duration(milliseconds: 40));
    if (guest.texts(tester).any((value) => value.contains(fragment))) return;
  }
  fail(
    'Real guest did not paint text containing "$fragment". Actual: ${guest.texts(tester)}',
  );
}

Future<void> _publish(String version) async {
  final response = await _post(Uri.parse('$_controlUrl/publish/$version'));
  if (response.statusCode != 200) {
    fail('Publishing $version failed: ${response.statusCode} ${response.body}');
  }
}

Future<_HttpResponse> _post(Uri uri) async {
  // Keep this test's only network dependency in dart:io; the update transport
  // itself remains the production `http` implementation in the host service.
  final client = HttpClient();
  try {
    final request = await client.postUrl(uri);
    request.headers.contentType = ContentType.json;
    final response = await request.close();
    final body = await utf8.decoder.bind(response).join();
    return _HttpResponse(response.statusCode, body);
  } finally {
    client.close(force: true);
  }
}

Future<void> _openUpdates(WidgetTester tester) async {
  // Updates is a Host sub-tab, not a bottom navigation item. Every successful
  // package remount starts the guest on Home, so enter Host first.
  await guest.tapGuest(tester, 'Host');
  await _waitForContaining(tester, 'Runtime');
  await guest.tapGuest(tester, 'Updates');
  await _waitForContaining(tester, 'Current status');
  await _waitForContaining(tester, 'stage=ready');
}

Future<void> _checkAndApply(
  WidgetTester tester,
  String version, {
  required String expectedTitle,
}) async {
  await _openUpdates(tester);
  await guest.tapGuest(tester, 'Check');
  await _waitForContaining(tester, 'available=$version');
  final previousKey = tester.widget<PocketView>(find.byType(PocketView)).key;
  await guest.tapGuest(tester, 'Apply');
  var remounted = false;
  for (var index = 0; index < 500; index++) {
    await tester.pump(const Duration(milliseconds: 40));
    final views = tester.widgetList<PocketView>(find.byType(PocketView));
    if (views.isNotEmpty && views.single.key != previousKey) {
      remounted = true;
      break;
    }
  }
  expect(
    remounted,
    isTrue,
    reason: 'Apply must replace the native guest instance',
  );
  await _waitForContaining(tester, expectedTitle);
  // Apply returns before the host's first-frame health timer promotes the
  // candidate. Re-enter the Updates page and wait for the post-health status;
  // this also prevents the broken release from passing on the old v1 title.
  await _openUpdates(tester);
  await _waitForContaining(tester, 'stage=ready');
}

Future<void> _deleteTestStore() async {
  if (_storeNamespace.isEmpty ||
      !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(_storeNamespace)) {
    return;
  }
  final support = await getApplicationSupportDirectory();
  final store = Directory('${support.path}/pocket-packages/${showcaseConfig.appId}/$_storeNamespace');
  if (await store.exists()) await store.delete(recursive: true);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('signed bytecode update lifecycle, rollback, and broken recovery', (
    tester,
  ) async {
    expect(
      _updateUrl,
      isNotEmpty,
      reason: 'test_updates.ts must provide a loopback update URL',
    );
    expect(
      _controlUrl,
      isNotEmpty,
      reason: 'test_updates.ts must provide a publish control URL',
    );
    expect(
      _storeNamespace,
      isNotEmpty,
      reason: 'test_updates.ts must provide an isolated store namespace',
    );

    try {
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '+1');
      await guest.waitFor(tester, '01');
      await guest.tapGuest(tester, 'Host');
      await _waitForContaining(tester, 'quickjs-bytecode');
      await _waitForContaining(tester, 'flutter.package_info_plus');
      await guest.tapGuest(tester, 'Stress');
      await guest.tapGuest(tester, 'Run 500 nodes');
      await _waitForContaining(tester, '500 retained nodes');

      // The script publishes release 1 before launching Flutter. This proves
      // the embedded guest starts first and that Check/Apply consumes a signed v1.
      await _checkAndApply(
        tester,
        '1.0.1',
        expectedTitle: 'Pocket Host Lab v1',
      );

      await _publish('2');
      await _checkAndApply(
        tester,
        '1.0.2',
        expectedTitle: 'Pocket Host Lab v2',
      );

      // v2's previous pointer is v1. Rollback must mount the verified v1 package
      // and return to the v1 title without any Dart-owned page state.
      await _openUpdates(tester);
      await guest.tapGuest(tester, 'Rollback');
      await _waitForContaining(tester, 'Pocket Host Lab v1');

      await _publish('broken');
      await _checkAndApply(
        tester,
        'broken',
        expectedTitle: 'Pocket Host Lab v1',
      );
      // The broken release is correctly signed but throws during QuickJS startup;
      // host health timeout/error handling must restore the verified v1 package.
      await _waitForContaining(tester, 'Pocket Host Lab v1');
      await _waitForContaining(tester, 'guest bytecode evaluate');

      // Restart the host shell: the last healthy signed package is persistent.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(const PocketHostApp());
      await _waitForContaining(tester, 'Pocket Host Lab v1');
      await _openUpdates(tester);
      await _waitForContaining(tester, 'active=1.0.1');
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));
      await _deleteTestStore();
    }
  });
}

final class _HttpResponse {
  const _HttpResponse(this.statusCode, this.body);

  final int statusCode;
  final String body;
}
