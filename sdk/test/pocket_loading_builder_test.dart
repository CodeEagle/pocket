import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show PocketView, debugPocketSelfOwnedRuntimeFactory;
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_sdk/src/pocket_app.dart'
    show PocketGuest, PocketGuestSession;

const _config = PocketAppConfig(
  appId: 'loading-builder.test',
  metadataAsset: 'loading-builder-test/metadata.json',
  manifestAsset: 'loading-builder-test/manifest.json',
);

Widget _host(Widget child) =>
    Directionality(textDirection: TextDirection.ltr, child: child);

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

  testWidgets('PocketApp forwards observed package progress to its builder', (
    tester,
  ) async {
    final observed = <PocketStartupProgress>[];
    final PocketLoadingBuilder builder = (context, progress) {
      observed.add(progress);
      return const Text('custom package loading');
    };

    await tester.pumpWidget(
      PocketApp(config: _config, loadingBuilder: builder),
    );

    final guest = tester.widget<PocketGuest>(find.byType(PocketGuest));
    expect(guest.loadingBuilder, same(builder));
    expect(find.text('custom package loading'), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );
    expect(observed, isNotEmpty);
    expect(observed.first.stage, PocketStartupStage.preparingPackage);
    expect(observed.first.packageStage, 'initializing');
    expect(observed.first.downloadedBytes, isNull);
    expect(observed.first.totalBytes, isNull);
  });

  testWidgets(
    'PocketGuestSession uses custom UI before readiness but keeps errors',
    (tester) async {
      final session = PocketSession(config: _config)..stage = 'checking';
      addTearDown(session.dispose);
      final observed = <PocketStartupProgress>[];

      await tester.pumpWidget(
        _host(
          PocketGuestSession(
            config: _config,
            session: session,
            loadingBuilder: (context, progress) {
              observed.add(progress);
              return const Text('host loading surface');
            },
          ),
        ),
      );

      expect(find.text('host loading surface'), findsOneWidget);
      expect(observed, isNotEmpty);
      expect(observed.first.stage, PocketStartupStage.preparingPackage);
      expect(observed.first.packageStage, 'checking');
      expect(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
        findsNothing,
      );

      session.failure = StateError('startup test failure');
      session.notifyListeners();
      await tester.pump();

      expect(find.textContaining('Pocket 启动失败'), findsOneWidget);
      expect(find.text('host loading surface'), findsNothing);
    },
  );

  testWidgets('null builder keeps local session startup quiet', (tester) async {
    final session = PocketSession(config: _config);
    addTearDown(session.dispose);

    await tester.pumpWidget(
      _host(PocketGuestSession(config: _config, session: session)),
    );

    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );
  });

  testWidgets('ready session forwards the builder to PocketView', (
    tester,
  ) async {
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    addTearDown(() {
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
    });
    // Inspect the facade-to-view boundary without starting a native runtime.
    debugPocketSelfOwnedRuntimeFactory = (_) {
      throw StateError('loading builder forwarding does not start a runtime');
    };

    final session = PocketSession(config: _config)..ready = true;
    addTearDown(session.dispose);
    final PocketLoadingBuilder builder = (context, progress) =>
        const Text('view loading surface');

    await tester.pumpWidget(
      MaterialApp(
        home: PocketGuestSession(
          config: _config,
          session: session,
          loadingBuilder: builder,
        ),
      ),
    );

    final view = tester.widget<PocketView>(find.byType(PocketView));
    expect(view.loadingBuilder, same(builder));
  });

  testWidgets('ready local PocketView stays blank until its first frame', (
    tester,
  ) async {
    final previousFactory = debugPocketSelfOwnedRuntimeFactory;
    addTearDown(() {
      debugPocketSelfOwnedRuntimeFactory = previousFactory;
    });
    debugPocketSelfOwnedRuntimeFactory = (_) {
      throw StateError('zero-size startup surface must not start a runtime');
    };

    final session = PocketSession(config: _config)..ready = true;
    addTearDown(session.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 0,
          height: 0,
          child: PocketGuestSession(config: _config, session: session),
        ),
      ),
    );

    expect(find.byType(PocketView), findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
