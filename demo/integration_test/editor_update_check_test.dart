import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

const _updateUrl = String.fromEnvironment('POCKET_UPDATE_URL');
const _storeNamespace = String.fromEnvironment('POCKET_STORE_NAMESPACE');
const _expectedVersion = String.fromEnvironment(
  'POCKET_TEST_UPDATE_VERSION',
  defaultValue: '0.1.0',
);

Future<void> _waitForContaining(WidgetTester tester, String fragment) async {
  for (var index = 0; index < 500; index++) {
    await tester.pump(const Duration(milliseconds: 40));
    if (guest.texts(tester).any((value) => value.contains(fragment))) return;
  }
  fail(
    'Real guest did not paint text containing "$fragment". '
    'Actual: ${guest.texts(tester)}',
  );
}

Future<void> _openUpdates(WidgetTester tester) async {
  await guest.tapGuest(tester, 'Host');
  await _waitForContaining(tester, 'Runtime');
  await guest.tapGuest(tester, 'Updates');
  await _waitForContaining(tester, 'Current status');
  await _waitForContaining(tester, 'stage=ready');
}

Future<void> _deleteTestStore() async {
  if (_storeNamespace.isEmpty ||
      !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(_storeNamespace)) {
    return;
  }
  final support = await getApplicationSupportDirectory();
  final store = Directory(
    '${support.path}/pocket-packages/${showcaseConfig.appId}/$_storeNamespace',
  );
  if (await store.exists()) await store.delete(recursive: true);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'editor signed manifest passes the real JS updates.check path',
    (tester) async {
      expect(
        _updateUrl,
        contains('/updates/showcase/latest.json'),
        reason:
            'Run this smoke test with .pocket-build/editor-host.json or an '
            'equivalent editor host config',
      );
      expect(
        _storeNamespace,
        isNotEmpty,
        reason: 'Use an epoch-specific POCKET_STORE_NAMESPACE for isolation',
      );
      expect(_expectedVersion, isNotEmpty);
      try {
        await tester.pumpWidget(pocketHostApp());
        await guest.waitFor(tester, '00');
        await _openUpdates(tester);

        // Check only. It must fetch the editor's latest.json, verify the
        // Ed25519 envelope, validate qjbc/PAK hashes, and stage a candidate;
        // applying it would remount the showcase and is intentionally covered
        // by update_lifecycle_test.dart instead.
        await guest.tapGuest(tester, 'Check');
        await _waitForContaining(tester, 'stage=verified');
        await _waitForContaining(tester, 'available=$_expectedVersion');
        await _waitForContaining(tester, 'lastError=none');
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump(const Duration(milliseconds: 100));
        await _deleteTestStore();
      }
    },
  );
}
