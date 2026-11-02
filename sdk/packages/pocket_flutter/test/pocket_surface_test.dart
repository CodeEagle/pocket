import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

class _SurfaceRuntime implements PocketRuntime {
  final ops = <PocketOp>[
    const PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff123456),
    const PocketHostSurfaceOp(
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      id: 'glass',
      kind: 'glass',
      parameters: {'radius': 20, 'blur': 5},
      clip: PocketClip(x: 0, y: 0, width: 320, height: 70),
    ),
    const PocketTextOp(
      x: 20,
      y: 30,
      width: 70,
      height: 20,
      text: 'above glass',
      size: 12,
      color: 0xffffffff,
    ),
    const PocketHostSurfaceOp(
      x: 10,
      y: 120,
      width: 100,
      height: 80,
      id: 'camera',
      kind: 'platformTexture',
      parameters: {
        'textureId': 42,
        'rotationDegrees': 90,
        'mirrorX': true,
        'radius': 16,
      },
      // The camera is only partly inside this viewport. Its rounded mask must
      // still be measured against the original 100x80 surface, not this
      // 100x50 visible intersection.
      clip: PocketClip(x: 0, y: 100, width: 320, height: 70),
    ),
  ];
  @override
  PocketFrame frame(int deltaMilliseconds) =>
      PocketFrame(width: 320, height: 480, ops: List.of(ops), events: const []);
  @override
  PocketFrame eval(String source) => frame(0);
  @override
  PocketFrame load(String source, Uint8List pak) => frame(0);
  @override
  void send(Map<String, dynamic> message) {}
  @override
  bool resizeViewport(double width, double height) => false;
  @override
  void enableAuxiliary(double width, double height) {}
  @override
  String? get lastError => null;
  @override
  void dispose() {}
}

void main() {
  test('host surface requires a structured provider descriptor', () {
    expect(
      () => PocketOp.fromJson({'type': 'hostSurface', 'asset': '[]'}),
      throwsFormatException,
    );
    final op = PocketOp.fromJson({
      'type': 'hostSurface',
      'id': 'lens',
      'asset': '{"kind":"glass","parameters":{"radius":24}}',
      'x': 1,
      'y': 2,
      'w': 80,
      'h': 40,
    });
    expect(op, isA<PocketHostSurfaceOp>());
    expect((op as PocketHostSurfaceOp).parameters['radius'], 24);
  });

  testWidgets(
    'compositor preserves clip and paint order; textures require host grant',
    (tester) async {
      final runtime = _SurfaceRuntime();
      final controller = PocketViewController();
      await tester.pumpWidget(
        MaterialApp(
          home: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 320,
              height: 480,
              child: PocketView(
                runtime: runtime,
                controller: controller,
                viewport: const Size(320, 480),
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(BackdropFilter), findsOneWidget);
      expect(find.byType(Texture), findsNothing);
      final surface = tester.widget<Positioned>(
        find.byKey(const ValueKey('surface-glass')),
      );
      expect(
        surface.height,
        50,
      ); // 20..100 intersected with the engine's 0..70 clip.
      final stack = tester.widget<Stack>(
        find
            .ancestor(
              of: find.byKey(const ValueKey('surface-glass')),
              matching: find.byType(Stack),
            )
            .first,
      );
      final index = stack.children.indexWhere(
        (w) => w.key == const ValueKey('surface-glass'),
      );
      expect(index, greaterThan(0));
      expect(index, lessThan(stack.children.length - 1));
      controller.authorizePlatformTexture(42);
      await tester.pump(const Duration(milliseconds: 40));
      expect(find.byType(Texture), findsOneWidget);
      expect(find.byType(RotatedBox), findsOneWidget);
      expect(find.byType(Transform), findsOneWidget);
      final cameraSurface = find.byKey(const ValueKey('surface-camera'));
      expect(cameraSurface, findsOneWidget);
      final cameraRadiusClip = find.descendant(
        of: cameraSurface,
        matching: find.byType(ClipRRect),
      );
      expect(cameraRadiusClip, findsOneWidget);
      expect(tester.getSize(cameraRadiusClip), const Size(100, 80));
      expect(tester.widget<Positioned>(cameraSurface).height, 50);
      controller.revokePlatformTexture(42);
      await tester.pump(const Duration(milliseconds: 40));
      expect(find.byType(Texture), findsNothing);
      runtime.ops.removeWhere((op) => op is PocketHostSurfaceOp);
      await tester.pump(const Duration(milliseconds: 40));
      expect(find.byType(BackdropFilter), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
