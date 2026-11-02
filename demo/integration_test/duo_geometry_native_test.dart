import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

// Device Hub supplies real open/partially-open/closed poses during this test.
// A raw guest echoes the framework geometry event; no geometry is fabricated.
const geometryGuest = r'''
const bg = ui.createNode(0);
ui.setProp(bg, 1, 2000); ui.setProp(bg, 2, 2000);
ui.setProp(bg, 64, 0xff264653); ui.insertBefore(1,bg,0);
globalThis.frame = function() {};
globalThis.__pocketEvent = function(line) {
  const e = JSON.parse(line);
  if (e.name === 'display.viewport') {
    pocket._emit(JSON.stringify({type:'event',name:'qa.geometry',payload:e.payload}));
  }
};
''';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets(
    'Duo poses deliver actual reserved regions through the JS bridge',
    (tester) async {
      final snapshots = <Map<String, dynamic>>[];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: PocketView(
              jsSource: geometryGuest,
              showDebugFps: false,
              onEvent: (event) {
                if (event.method != 'qa.geometry') return;
                final snapshot = Map<String, dynamic>.from(
                  event.params,
                );
                if (snapshots.isEmpty ||
                    jsonEncode(snapshots.last) != jsonEncode(snapshot)) {
                  snapshots.add(snapshot);
                  debugPrint('DUO_GEOMETRY ${jsonEncode(snapshot)}');
                }
              },
            ),
          ),
        );
        debugPrint(
          'DUO_POSE_TEST_READY: open, partially open, then close in Device Hub',
        );
        for (var i = 0; i < 120; i++) {
          await tester.pump(const Duration(milliseconds: 500));
        }
        binding.reportData = {'geometry': snapshots};
        expect(snapshots.length, greaterThan(2));
        expect(
          snapshots.map((s) => s['width']).toSet().length,
          greaterThan(1),
          reason: 'Device Hub must exercise a real window resize',
        );
        expect(
          snapshots.any(
            (s) => (s['reservedRegions'] as List? ?? const []).isNotEmpty,
          ),
          isTrue,
          reason: 'iOS must return its actual occlusion/division regions',
        );
        for (final snapshot in snapshots) {
          final width = (snapshot['width'] as num).toDouble();
          final height = (snapshot['height'] as num).toDouble();
          final safeArea = snapshot['safeArea'] as Map?;
          if (safeArea != null) {
            // The Duo's edge occlusion never consumes half the display. A
            // larger value exposed a stale 951pt frame combined with the
            // closed window's 466pt metrics (a bogus 569pt right inset).
            expect(
              (safeArea['right'] as num).toDouble(),
              lessThan(width / 2),
              reason: 'A geometry event must use one consistent window size',
            );
          }
          for (final value
              in snapshot['reservedRegions'] as List? ?? const []) {
            final region = value as Map;
            final frame = region['frame'] as Map;
            expect(frame['left'], greaterThanOrEqualTo(0));
            expect(frame['top'], greaterThanOrEqualTo(0));
            expect(
              (frame['left'] as num) + (frame['width'] as num),
              lessThanOrEqualTo(width + .01),
            );
            expect(
              (frame['top'] as num) + (frame['height'] as num),
              lessThanOrEqualTo(height + .01),
            );
            expect(region['kind'], isIn(['division', 'occlusion']));
          }
        }
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
