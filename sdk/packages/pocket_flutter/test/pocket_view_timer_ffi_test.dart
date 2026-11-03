import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _LegacyTickerRuntime implements PocketRuntime {
  static const _frame = PocketFrame(
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
  PocketFrame frame(int deltaMilliseconds) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  testWidgets(
    'idle wake advances real QuickJS guest work by elapsed scheduler time',
    (tester) async {
      final runtime = FfiPocketRuntime.open(width: 320, height: 480);
      final events = <PocketEvent>[];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: SizedBox(
              width: 320,
              height: 480,
              child: PocketView(
                runtime: runtime,
                jsSource: r'''
                  let ticks = 0;
                  let fired = false;
                  globalThis.frame = function() {
                    ticks++;
                    if (!fired && ticks >= 20) {
                      fired = true;
                      pocket._emit(JSON.stringify({
                        type: "event",
                        name: "delayed.guest.work",
                        payload: { elapsed: true }
                      }));
                    }
                  };
                ''',
                showDebugFps: false,
                onEvent: events.add,
              ),
            ),
          ),
        );
        await tester.pump();
        for (var index = 0; index < 7; index++) {
          await tester.pump(const Duration(milliseconds: 16));
        }

        // The virtual timer deadline wakes the guest during this scheduler
        // jump. The monotonic frame timestamp passed to native must carry the
        // elapsed 250ms into that turn; if the ticker-restart baseline were
        // used, only one ~16ms guest tick would run and the event would stay
        // pending. Libraries without the optional scheduler snapshot remain
        // on vsync and retain the same elapsed-time contract.
        await tester.pump(const Duration(milliseconds: 250));
        // A zero-duration pump handles Flutter versions that deliver the
        // Timer callback at the end of the jump and schedule the resumed
        // ticker for the next frame.
        if (!events.any((event) => event.method == 'delayed.guest.work')) {
          await tester.pump();
        }
        expect(
          events.map((event) => event.method),
          contains('delayed.guest.work'),
        );
      } finally {
        runtime.dispose();
      }
    },
    skip: libraryPath == null,
  );

  testWidgets('legacy runtime without a scheduling snapshot stays on vsync', (
    tester,
  ) async {
    final runtime = _LegacyTickerRuntime();
    final calls = <double>[];
    final previous = debugPocketFrameDeltaAtOverride;
    debugPocketFrameDeltaAtOverride = (_, delta) {
      calls.add(delta);
      return null;
    };
    addTearDown(() {
      debugPocketFrameDeltaAtOverride = previous;
      runtime.dispose();
    });

    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
          ),
        ),
      ),
    );
    await tester.pump();
    for (var index = 0; index < 7; index++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(calls.length, greaterThanOrEqualTo(6));
    final state = tester.state(find.byType(PocketView)) as dynamic;
    expect(state.isTickerActive, isTrue);
    expect(state.hasScheduledWake, isFalse);

    final beforeNextVsync = calls.length;
    await tester.pump(const Duration(milliseconds: 250));
    expect(calls.length, beforeNextVsync + 1);
    expect(state.isTickerActive, isTrue);
  });
}
