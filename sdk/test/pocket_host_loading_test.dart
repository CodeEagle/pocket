import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  testWidgets('local bundled catalog bootstrap stays quiet', (tester) async {
    final catalog = Completer<PocketBundledApplicationCatalog>();
    await tester.pumpWidget(
      PocketSystemHostApplication(
        loadBundledApplications: () => catalog.future,
        buildSystemUI: (_) =>
            throw StateError('catalog is still loading locally'),
        buildApplications: (_) => const <String, PocketAppConfig>{},
      ),
    );
    await tester.pump();

    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );
    expect(find.text('初始化'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    catalog.complete(PocketBundledApplicationCatalog.empty);
  });

  testWidgets('custom exit does not wait for or reopen a pending container', (
    tester,
  ) async {
    final pending = Completer<PocketHostConfig?>();
    var exits = 0;
    await tester.pumpWidget(
      PocketSystemHostApplication(
        loadHostConfig: () => pending.future,
        loadBundledApplications: () async =>
            PocketBundledApplicationCatalog.empty,
        buildSystemUI: (_) =>
            throw StateError('must not mount a cancelled host'),
        buildApplications: (_) => const <String, PocketAppConfig>{},
        onExit: () => exits++,
      ),
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('pocket-container-exit')));
    await tester.pump();
    expect(exits, 1);
    expect(pending.isCompleted, isFalse);
    expect(find.byType(PocketSystemHost), findsNothing);
    pending.completeError(StateError('late custom loader'));
    await tester.pump();
    await tester.pump();
    expect(exits, 1);
    expect(find.textContaining('late custom loader'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final exit in ['button', 'escape', 'system back', 'edge swipe']) {
    testWidgets('pending container returns through $exit without waiting', (
      tester,
    ) async {
      if (exit == 'edge swipe') {
        debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
      }
      final pending = Completer<PocketHostConfig?>();
      var count = 0;
      late BuildContext mainContext;
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              mainContext = context;
              return Scaffold(
                body: TextButton(
                  onPressed: () => setState(() => count++),
                  child: Text('主界面 $count'),
                ),
              );
            },
          ),
        ),
      );
      unawaited(
        Navigator.of(mainContext).push<void>(
          MaterialPageRoute(
            builder: (_) => PocketSystemHostApplication(
              loadHostConfig: () => pending.future,
              loadBundledApplications: () async =>
                  PocketBundledApplicationCatalog.empty,
              buildSystemUI: (_) => const PocketAppConfig(appId: 'test.host'),
              buildApplications: (_) => const <String, PocketAppConfig>{},
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      if (exit == 'edge swipe') {
        await tester.pump(const Duration(milliseconds: 200));
      }
      expect(find.text('初始化'), findsNothing);
      expect(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
        findsNothing,
      );
      expect(pending.isCompleted, isFalse);
      switch (exit) {
        case 'button':
          await tester.tap(find.byKey(const ValueKey('pocket-container-exit')));
        case 'escape':
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        case 'system back':
          await tester.binding.handlePopRoute();
        case 'edge swipe':
          final cancelled = await tester.startGesture(const Offset(8, 200));
          await cancelled.moveTo(const Offset(120, 200));
          await cancelled.cancel();
          await tester.pump();
          expect(
            find.byType(PocketSystemHostApplication),
            findsOneWidget,
            reason: 'a cancelled edge gesture must retain the container',
          );
          final swipe = await tester.createGesture(pointer: 2);
          await swipe.down(
            const Offset(8, 200),
            timeStamp: const Duration(milliseconds: 900),
          );
          await swipe.moveTo(
            const Offset(120, 200),
            timeStamp: const Duration(milliseconds: 1100),
          );
          await tester.pump();
          expect(
            find.byType(PocketSystemHostApplication),
            findsOneWidget,
            reason: 'the container waits for the edge gesture end phase',
          );
          expect(pending.isCompleted, isFalse);
          await swipe.up(timeStamp: const Duration(milliseconds: 1150));
      }
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 550));
      expect(find.text('主界面 0'), findsOneWidget);
      expect(find.byType(PocketSystemHostApplication), findsNothing);
      // The opaque custom callback is deliberately still pending. The
      // retained parent route must already accept input before it completes.
      await tester.tap(find.text('主界面 0'));
      await tester.pump();
      expect(find.text('主界面 1'), findsOneWidget);
      pending.completeError(StateError('late remote response'));
      await tester.pump();
      expect(find.text('主界面 1'), findsOneWidget);
      expect(find.textContaining('late remote response'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      if (exit == 'edge swipe') debugDefaultTargetPlatformOverride = null;
    });
  }

  testWidgets('changing an opaque host loader stays quiet until its result', (
    tester,
  ) async {
    Widget host(Future<PocketHostConfig?> Function() load) =>
        PocketSystemHostApplication(
          loadHostConfig: load,
          loadBundledApplications: () async =>
              PocketBundledApplicationCatalog.empty,
          buildSystemUI: (_) => const PocketAppConfig(appId: 'test.host'),
          buildApplications: (_) => const <String, PocketAppConfig>{},
        );

    await tester.pumpWidget(
      host(() => Future<PocketHostConfig?>.error(StateError('old link'))),
    );
    await tester.pump();
    expect(find.textContaining('old link'), findsOneWidget);
    final error = tester.widget<SelectableText>(find.byType(SelectableText));
    expect(error.style?.color, Colors.white);

    final next = Completer<PocketHostConfig?>();
    await tester.pumpWidget(host(() => next.future));
    await tester.pump();
    expect(find.textContaining('old link'), findsNothing);
    expect(find.text('初始化'), findsNothing);
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsNothing,
    );

    next.completeError(StateError('new link'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('new link'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('SDK URL-backed host config keeps request progress visible', (
    tester,
  ) async {
    var createdClients = 0;
    await HttpOverrides.runWithHttpOverrides(() async {
      await tester.pumpWidget(
        PocketSystemHostApplication(
          hostConfigUrl: Uri.parse('http://127.0.0.1:1/host.json'),
          loadBundledApplications: () async =>
              PocketBundledApplicationCatalog.empty,
          buildSystemUI: (_) => const PocketAppConfig(appId: 'test.host'),
          buildApplications: (_) => const <String, PocketAppConfig>{},
        ),
      );
      await tester.pump();
      expect(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
        findsOneWidget,
      );
      expect(createdClients, 1);
      expect(find.text('初始化'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    }, _RealHttpOverrides(() => createdClients++));
  });
}

final class _RealHttpOverrides extends HttpOverrides {
  _RealHttpOverrides(this.onCreate);

  final VoidCallback onCreate;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    onCreate();
    return super.createHttpClient(context);
  }
}
