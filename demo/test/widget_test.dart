import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _StaticRuntime implements PocketRuntime {
  final PocketFrame _frame = const PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) => _frame;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  testWidgets('host mounts the renderer without a Dart business page', (
    tester,
  ) async {
    final runtime = _StaticRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: PocketView(
          runtime: runtime,
          jsSource: '',
          pakBytes: Uint8List(0),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(PocketView), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
  });
}
