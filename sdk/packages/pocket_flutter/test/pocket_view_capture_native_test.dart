import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _viewport = Size(80, 64);
const _panelPoint = Offset(40, 30);
const _initialPanel = Color(0xffed2839);
const _changedPanel = Color(0xff25bd62);
const _hostColor = Color(0xff5a1020);

final class _CapturedPixels {
  const _CapturedPixels({
    required this.width,
    required this.height,
    required this.rgba,
  });

  final int width;
  final int height;
  final Uint8List rgba;

  Color at(int x, int y) {
    final offset = (y * width + x) * 4;
    return Color.fromARGB(
      rgba[offset + 3],
      rgba[offset],
      rgba[offset + 1],
      rgba[offset + 2],
    );
  }

  bool contains(Color color) {
    final argb = color.toARGB32();
    for (var offset = 0; offset < rgba.length; offset += 4) {
      if (rgba[offset + 3] == ((argb >> 24) & 0xff) &&
          rgba[offset] == ((argb >> 16) & 0xff) &&
          rgba[offset + 1] == ((argb >> 8) & 0xff) &&
          rgba[offset + 2] == (argb & 0xff)) {
        return true;
      }
    }
    return false;
  }
}

String? _fixtureAssetsPath() {
  final root = Platform.environment['POCKET_VIEW_CAPTURE_FIXTURE_DIR'];
  if (root == null || root.trim().isEmpty) return null;
  return '$root/assets';
}

String? _fixtureSkipReason(String? assetsPath) {
  if (assetsPath == null) {
    return 'Set POCKET_VIEW_CAPTURE_FIXTURE_DIR to the pinned buildGuest '
        'scene-capture fixture root.';
  }
  const names = <String>[
    'app.qjbc',
    'app.pak',
    'app.bytecode.json',
    'guest-manifest.json',
  ];
  final missing = names
      .where((name) => !File('$assetsPath/$name').existsSync())
      .toList(growable: false);
  if (missing.isNotEmpty) {
    return 'Missing buildGuest fixture assets at $assetsPath: '
        '${missing.join(', ')}';
  }
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  if (nativeLibrary == null || nativeLibrary.trim().isEmpty) {
    return 'Set POCKET_NATIVE_LIBRARY to the built Pocket native library.';
  }
  if (!File(nativeLibrary).existsSync()) {
    return 'Pocket native library does not exist: $nativeLibrary';
  }
  return null;
}

Future<_CapturedPixels> _decodeCapture(Uint8List pngBytes) async {
  final codec = await ui.instantiateImageCodec(pngBytes);
  try {
    final frame = await codec.getNextFrame();
    final image = frame.image;
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) throw StateError('PNG capture did not decode to RGBA');
      return _CapturedPixels(
        width: image.width,
        height: image.height,
        rgba: Uint8List.fromList(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        ),
      );
    } finally {
      image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

Future<({int width, int height, Uint8List pngBytes, _CapturedPixels pixels})>
_capturePixels(WidgetTester tester, PocketViewController controller) async {
  final captureFuture = controller.captureScene(
    maxWidth: 160,
    maxHeight: 240,
    maxPixels: 38_400,
  );
  // Scene capture synchronizes against the next composited Flutter frame.
  await tester.pump();
  final captured = await tester.runAsync(() => captureFuture);
  expect(
    captured,
    isNotNull,
    reason: 'the attached scene should be capturable',
  );
  final value = captured!;
  final decoded = await tester.runAsync(() => _decodeCapture(value.pngBytes));
  final pixels = decoded!;
  expect(value.width, _viewport.width.toInt());
  expect(value.height, _viewport.height.toInt());
  expect(pixels.width, value.width);
  expect(pixels.height, value.height);
  return (
    width: value.width,
    height: value.height,
    pngBytes: value.pngBytes,
    pixels: pixels,
  );
}

void _writeCaptureArtifact(String name, Uint8List pngBytes) {
  final root = Platform.environment['POCKET_VIEW_CAPTURE_ARTIFACT_DIR'];
  if (root == null || root.trim().isEmpty) return;
  final file = File('$root/$name');
  file.parent.createSync(recursive: true);
  file.writeAsBytesSync(pngBytes, flush: true);
}

void main() {
  final fixtureAssetsPath = _fixtureAssetsPath();
  final fixtureSkip = _fixtureSkipReason(fixtureAssetsPath);
  if (fixtureSkip != null) {
    // ignore: avoid_print
    print('pocket_view_capture_native_test skipped: $fixtureSkip');
  }

  testWidgets(
    'real buildGuest QJBC pointer input changes bounded scene PNG pixels',
    (tester) async {
      final assetsPath = fixtureAssetsPath!;
      final metadata = Map<String, dynamic>.from(
        jsonDecode(File('$assetsPath/app.bytecode.json').readAsStringSync())
            as Map,
      );
      final manifest = Map<String, dynamic>.from(
        jsonDecode(File('$assetsPath/guest-manifest.json').readAsStringSync())
            as Map,
      );
      final bytecode = Uint8List.fromList(
        File('$assetsPath/app.qjbc').readAsBytesSync(),
      );
      final pak = Uint8List.fromList(
        File('$assetsPath/app.pak').readAsBytesSync(),
      );

      expect(metadata['entryFormat'], 'quickjs-bytecode');
      expect(metadata['kind'], 'script');
      expect(metadata['bindingGeneration'], greaterThan(0));
      expect(metadata['bytecodeBytes'], bytecode.length);
      expect(metadata['tickHz'], 60);
      expect(metadata['runtimeAbi'], isA<String>());
      expect(metadata['payloadSha256'], isA<String>());
      expect((manifest['capabilities'] as Map)['requires'], isEmpty);

      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetDevicePixelRatio);

      final runtime = FfiPocketRuntime.open(
        width: _viewport.width,
        height: _viewport.height,
        tickHz: (metadata['tickHz'] as num).toInt(),
      );
      final controller = PocketViewController();
      final ready = Completer<void>();
      final loadingStages = <PocketStartupStage>[];
      const viewKey = ValueKey<String>('scene-capture-view');
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: ColoredBox(
              color: _hostColor,
              child: Align(
                alignment: Alignment.topLeft,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: SizedBox.fromSize(
                    size: _viewport,
                    child: PocketView(
                      key: viewKey,
                      runtime: runtime,
                      controller: controller,
                      bytecodeBytes: bytecode,
                      bytecodeMetadata: jsonEncode(metadata),
                      pakBytes: pak,
                      enableSceneCapture: true,
                      showDebugFps: false,
                      loadingBuilder: (context, progress) {
                        loadingStages.add(progress.stage);
                        return Text(
                          'Native startup: ${progress.stage.name}',
                          key: const ValueKey<String>('native-startup-loader'),
                        );
                      },
                      backgroundColor: null,
                      onReady: (_) {
                        if (!ready.isCompleted) ready.complete();
                      },
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

        for (var frame = 0; frame < 30 && !ready.isCompleted; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(ready.isCompleted, isTrue, reason: runtime.lastError);
        expect(controller.runtimeAbi, metadata['runtimeAbi']);
        expect(loadingStages, contains(PocketStartupStage.startingRuntime));
        await tester.pump();
        expect(
          find.byKey(const ValueKey<String>('native-startup-loader')),
          findsNothing,
        );

        final initial = await _capturePixels(tester, controller);
        _writeCaptureArtifact('before.png', initial.pngBytes);
        expect(initial.width, _viewport.width.toInt());
        expect(initial.height, _viewport.height.toInt());
        expect(
          initial.pixels.at(_panelPoint.dx.toInt(), _panelPoint.dy.toInt()),
          _initialPanel,
        );
        expect(initial.pixels.at(2, 2), const Color(0x00000000));
        expect(
          initial.pixels.contains(_hostColor),
          isFalse,
          reason: 'pixels from outside PocketView must not enter its PNG',
        );

        final origin = tester.getTopLeft(find.byKey(viewKey));
        await tester.tapAt(origin + _panelPoint);
        for (var frame = 0; frame < 6; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
        }

        final changed = await _capturePixels(tester, controller);
        _writeCaptureArtifact('after.png', changed.pngBytes);
        expect(changed.width, _viewport.width.toInt());
        expect(changed.height, _viewport.height.toInt());
        expect(
          changed.pixels.at(_panelPoint.dx.toInt(), _panelPoint.dy.toInt()),
          _changedPanel,
        );
        expect(changed.pixels.at(2, 2), const Color(0x00000000));
        expect(
          changed.pixels.contains(_hostColor),
          isFalse,
          reason: 'the bounded scene capture must exclude its surrounding host',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        runtime.dispose();
      }
    },
    skip: fixtureSkip != null,
  );
}
