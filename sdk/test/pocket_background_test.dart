import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart'
    show PocketGuestSession, PocketGuestSessionState;

const _config = PocketAppConfig(
  appId: 'background.test',
  metadataAsset: 'background-test/metadata.json',
  manifestAsset: 'background-test/manifest.json',
);

Widget _host(Widget child) =>
    Directionality(textDirection: TextDirection.ltr, child: child);

ColoredBox _backgroundBox(WidgetTester tester) {
  final boxes = tester.widgetList<ColoredBox>(find.byType(ColoredBox));
  return boxes.firstWhere(
    (box) => box.color == const Color(0xff030712),
    orElse: () => fail('opaque Pocket background was not mounted'),
  );
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => Directory.systemTemp.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      (_) async => null,
    );
  });

  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
  });

  test('background APIs default to opaque root and allow app overrides', () {
    const defaultApp = PocketApp(config: _config);
    const defaultGuest = PocketGuest(config: _config);
    const defaultHost = PocketSystemHost(
      systemUI: _config,
      applications: <String, PocketAppConfig>{},
    );
    expect(defaultApp.backgroundColor, const Color(0xff000000));
    expect(defaultHost.backgroundColor, const Color(0xff000000));
    expect(defaultGuest.backgroundColor, isNull);

    const custom = Color(0xff030712);
    const customApp = PocketApp(config: _config, backgroundColor: custom);
    const customGuest = PocketGuest(config: _config, backgroundColor: custom);
    const customHost = PocketSystemHost(
      systemUI: _config,
      applications: <String, PocketAppConfig>{},
      backgroundColor: custom,
    );
    expect(customApp.backgroundColor, custom);
    expect(customGuest.backgroundColor, custom);
    expect(customHost.backgroundColor, custom);
  });

  testWidgets('PocketGuestSession keeps startup and failure states opaque', (
    tester,
  ) async {
    final session = PocketSession(config: _config);
    addTearDown(session.dispose);

    await tester.pumpWidget(
      _host(
        PocketGuestSession(
          config: _config,
          session: session,
          backgroundColor: const Color(0xff030712),
        ),
      ),
    );
    await tester.pump();

    final state = tester.state<PocketGuestSessionState>(
      find.byType(PocketGuestSession),
    );
    expect(state.session.ready, isFalse);
    expect(_backgroundBox(tester).color, const Color(0xff030712));

    state.session.failure = StateError('background test failure');
    state.session.notifyListeners();
    await tester.pump();
    expect(find.textContaining('Pocket startup failed'), findsOneWidget);
    expect(_backgroundBox(tester).color, const Color(0xff030712));
    expect(
      tester.widget<SelectableText>(find.byType(SelectableText)).style?.color,
      Colors.white,
    );
  });

  testWidgets('compositor child sessions remain transparent by default', (
    tester,
  ) async {
    final session = PocketSession(config: _config);
    addTearDown(session.dispose);

    await tester.pumpWidget(
      _host(PocketGuestSession(config: _config, session: session)),
    );
    await tester.pump();

    final child = tester.widget<PocketGuestSession>(
      find.byType(PocketGuestSession),
    );
    expect(child.backgroundColor, isNull);
    expect(find.byType(ColoredBox), findsNothing);
  });
}
