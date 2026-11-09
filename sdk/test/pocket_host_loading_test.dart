import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
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

  for (final exit in ['button', 'escape', 'system back']) {
    testWidgets('pending container returns through $exit without waiting', (
      tester,
    ) async {
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
      expect(find.text('初始化'), findsOneWidget);
      expect(pending.isCompleted, isFalse);
      switch (exit) {
        case 'button':
          await tester.tap(find.byKey(const ValueKey('pocket-container-exit')));
        case 'escape':
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        case 'system back':
          await tester.binding.handlePopRoute();
      }
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.text('主界面 0'), findsOneWidget);
      expect(find.byType(PocketSystemHostApplication), findsNothing);
      // The slow request is deliberately still pending. The retained parent
      // route must already accept input before any network result arrives.
      await tester.tap(find.text('主界面 0'));
      await tester.pump();
      expect(find.text('主界面 1'), findsOneWidget);
      pending.completeError(StateError('late remote response'));
      await tester.pump();
      expect(find.text('主界面 1'), findsOneWidget);
      expect(find.textContaining('late remote response'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('changing the host link replaces stale content with loading', (
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
    expect(find.text('初始化'), findsOneWidget);
    final indicator = tester.widget<LinearProgressIndicator>(
      find.byType(LinearProgressIndicator),
    );
    expect(indicator.value, isNull);
    expect(indicator.color, Colors.white);

    next.completeError(StateError('new link'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('new link'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
