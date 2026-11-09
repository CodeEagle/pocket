import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_services/pocket_services.dart'
    show PocketPackagePreparationProgress, PocketPackagePreparationStage;
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
    await tester.pump(const Duration(milliseconds: 200));

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

  testWidgets('does not infer a completed transfer without observed totals', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(const PocketStartupIndicator(stage: 'verifying')),
    );

    final progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, isNull);
    expect(find.text('校验资源'), findsOneWidget);
    expect(find.textContaining('已下载'), findsNothing);
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

  testWidgets(
    'hands a 1% transfer snapshot to completed download and pending verification',
    (tester) async {
      await tester.pumpWidget(
        _app(
          const PocketStartupIndicator(
            stage: 'downloading',
            downloadedBytes: 1,
            totalBytes: 100,
          ),
        ),
      );
      var transfer = tester.widget<LinearProgressIndicator>(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
      );
      expect(transfer.value, 0.0);
      expect(find.text('已下载 1 B / 100 B · 1%'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 200));
      transfer = tester.widget<LinearProgressIndicator>(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
      );
      expect(transfer.value, 0.01);

      await tester.pumpWidget(
        _app(
          const PocketStartupIndicator(
            stage: 'verifying',
            downloadedBytes: 100,
            totalBytes: 100,
          ),
        ),
      );

      transfer = tester.widget<LinearProgressIndicator>(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
      );
      final processing = tester.widget<LinearProgressIndicator>(
        find.byKey(
          const ValueKey<String>('pocket-startup-processing-progress'),
        ),
      );
      expect(transfer.value, 0.01);
      expect(transfer.semanticsValue, '100%');
      expect(processing.value, isNull);
      expect(processing.semanticsLabel, '正在校验资源');
      expect(find.text('下载已完成'), findsOneWidget);
      expect(find.text('已下载 100 B / 100 B · 100%'), findsOneWidget);
      expect(find.text('校验资源'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 100));
      transfer = tester.widget<LinearProgressIndicator>(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
      );
      expect(transfer.value, closeTo(0.505, 0.01));

      await tester.pump(const Duration(milliseconds: 100));
      transfer = tester.widget<LinearProgressIndicator>(
        find.byKey(const ValueKey<String>('pocket-startup-progress')),
      );
      expect(transfer.value, 1.0);
    },
  );

  testWidgets('animates only between observed determinate transfer snapshots', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'downloading',
          downloadedBytes: 20,
          totalBytes: 100,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    var progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, 0.2);

    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'downloading',
          downloadedBytes: 80,
          totalBytes: 100,
        ),
      ),
    );
    expect(find.text('已下载 80 B / 100 B · 80%'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 100));
    progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, closeTo(0.5, 0.01));
  });

  testWidgets('animates a first known verification total from indeterminate', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'verifying',
          downloadedBytes: 1024,
          totalBytes: 1024,
        ),
      ),
    );
    var progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, 0.0);

    await tester.pump(const Duration(milliseconds: 100));
    progress = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-progress')),
    );
    expect(progress.value, closeTo(0.5, 0.01));
  });

  testWidgets('shows observed package preparation bytes and file counts', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const PocketStartupIndicator(
          stage: 'verifying',
          downloadedBytes: 1024,
          totalBytes: 1024,
          preparationProgress: PocketPackagePreparationProgress(
            stage: PocketPackagePreparationStage.decodingArchive,
            processedBytes: 512,
            totalBytes: 1024,
            processedFiles: 2,
            totalFiles: 4,
          ),
        ),
      ),
    );

    expect(find.text('下载已完成'), findsOneWidget);
    expect(find.text('解包资源'), findsOneWidget);
    expect(find.text('已处理 512 B / 1 KB · 50% · 文件 2 / 4'), findsOneWidget);
    final processing = tester.widget<LinearProgressIndicator>(
      find.byKey(const ValueKey<String>('pocket-startup-processing-progress')),
    );
    expect(processing.value, isNull);
    expect(processing.semanticsLabel, '正在解包资源');
  });

  testWidgets(
    'keeps completed-transfer and processing states compact and accessible',
    (tester) async {
      tester.view.physicalSize = const Size(240, 140);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        _app(
          const PocketStartupIndicator(
            stage: 'verifying',
            downloadedBytes: 1024,
            totalBytes: 1024,
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('下载已完成'), findsOneWidget);
      expect(find.text('校验资源'), findsOneWidget);
      final processing = tester.widget<LinearProgressIndicator>(
        find.byKey(
          const ValueKey<String>('pocket-startup-processing-progress'),
        ),
      );
      expect(processing.value, isNull);
      expect(processing.semanticsLabel, '正在校验资源');
    },
  );
}
