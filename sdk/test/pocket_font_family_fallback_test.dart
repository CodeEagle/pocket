import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart' show PocketGuestSession;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('PocketGuest forwards configured font fallback and text cache capacity to PocketView', (
    tester,
  ) async {
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    addTearDown(() {
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
    });
    // The assertion is at the config-to-widget boundary. Fail before native
    // startup so this test does not claim to validate runtime text painting.
    debugPocketSelfOwnedRuntimeFactory = (_) {
      throw StateError('font configuration test does not start a runtime');
    };

    const config = PocketAppConfig(
      appId: 'font.fallback.test',
      fontFamilyFallback: <String>['LanternSerif'],
      textLayoutCacheCapacity: 2048,
    );
    final session = PocketSession(config: config)..ready = true;
    addTearDown(session.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: PocketGuestSession(config: config, session: session),
      ),
    );

    final view = tester.widget<PocketView>(find.byType(PocketView));
    expect(view.fontFamilyFallback, <String>['LanternSerif']);
    expect(view.textLayoutCacheCapacity, 2048);
  });
}
