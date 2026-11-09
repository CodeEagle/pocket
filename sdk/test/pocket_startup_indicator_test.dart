import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/src/pocket_startup_indicator.dart';

Widget _app(
  PocketStartupIndicator indicator, {
  Color background = Colors.black,
}) => MaterialApp(
  home: Scaffold(backgroundColor: background, body: indicator),
);

void main() {
  testWidgets('shows the observed byte total and determinate percentage', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'downloading',
          downloadedBytes: 512,
          totalBytes: 1024,
          foregroundColor: Colors.white,
        ),
      ),
    );

    final progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, 0.5);
    expect(progress.color, Colors.white);
    expect(find.text('下载资源'), findsOneWidget);
    expect(find.text('已下载 512 B / 1 KB · 50%'), findsOneWidget);
  });

  testWidgets('keeps an unknown total indeterminate and shows no fake total', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'downloading',
          downloadedBytes: 512,
          foregroundColor: Colors.white,
        ),
      ),
    );

    final progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, isNull);
    expect(find.text('已下载 512 B'), findsOneWidget);
    expect(find.textContaining('%'), findsNothing);
    expect(find.textContaining('/'), findsNothing);
  });

  testWidgets('preserves trailing zeroes in large byte totals', (tester) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'downloading',
          downloadedBytes: 100 * 1024,
          totalBytes: 1000 * 1024,
          foregroundColor: Colors.white,
        ),
      ),
    );

    expect(find.text('已下载 100 KB / 1000 KB · 10%'), findsOneWidget);
  });

  testWidgets('stays visible and follows startup stage changes', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'initializing',
          foregroundColor: Colors.white,
        ),
      ),
    );
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsOneWidget,
    );
    expect(find.text('初始化'), findsOneWidget);

    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'checking',
          foregroundColor: Colors.white,
        ),
      ),
    );
    expect(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
      findsOneWidget,
    );
    expect(find.text('检查更新'), findsOneWidget);
    expect(find.text('初始化'), findsNothing);

    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'verifying',
          foregroundColor: Colors.white,
        ),
      ),
    );
    expect(find.text('校验资源'), findsOneWidget);

    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'loading',
          foregroundColor: Colors.white,
        ),
      ),
    );
    expect(find.text('准备首帧'), findsOneWidget);
  });
}
