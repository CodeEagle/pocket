import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

/// Runs the production FFI runtime without a [PocketView].
///
/// This is deliberately a native/runtime regression test rather than a
/// widget test: the same bytecode and PAK used by the Showcase are loaded into
/// a real [FfiPocketRuntime], then its binary delta ABI is driven through the
/// exact resize sequence observed while the Duo keyboard animates. A failure
/// here points at the native artifact or the guest/runtime contract; a pass
/// leaves PocketView geometry and painting as the remaining surface to audit.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('native binary resize keeps focused guest content visible', (
    tester,
  ) async {
    await tester.pumpWidget(const SizedBox.shrink());

    final bytecode = await _assetBytes('assets/app.qjbc');
    final pak = await _assetBytes('assets/app.pak');
    final metadata = PocketBytecodeMetadata.fromJsonString(
      await rootBundle.loadString('assets/app.bytecode.json'),
    );
    final runtime = FfiPocketRuntime.open(
      width: 951,
      height: 669,
      tickHz: metadata.tickHz,
    );

    try {
      var frame = runtime.loadBytecode(
        bytecode,
        pak,
        expectedRuntimeAbi: metadata.runtimeAbi,
      );
      frame = _settleHostRequests(runtime, frame, metadata);
      frame = _advanceAndSettleHostRequests(runtime, metadata);
      final initialTap = _text(frame, 'Tap to type');
      final initialCounter = _text(frame, 'Counter');
      expect(initialTap, isNotNull, reason: _frameSummary(frame));
      expect(initialCounter, isNotNull, reason: _frameSummary(frame));

      final tap = initialTap!;
      final tapX = tap.x + tap.width / 2;
      final tapY = tap.y + tap.height / 2;
      runtime.send(_pointer('down', tapX, tapY));
      frame = _advanceAndSettleHostRequests(runtime, metadata);
      runtime.send(_pointer('up', tapX, tapY));
      frame = _advanceAndSettleHostRequests(runtime, metadata);

      final openedOverlayY = _inputEventY(frame);
      expect(
        openedOverlayY,
        isNotNull,
        reason: 'the production guest did not open its system-input rect',
      );
      expect(openedOverlayY, closeTo(tap.y - 8, 2));
      var overlayY = openedOverlayY!;

      const insets = <double>[
        586.9,
        664.68,
        698.14,
        723.3,
        742.01,
        755.82,
        765.93,
        773.29,
        778.62,
        782.46,
        785.22,
        787.19,
        788.6,
        789.6,
        790.31,
        790.81,
        791.16,
        791.41,
        791.59,
        792,
      ];

      for (final inset in insets) {
        final height = 669 - inset / 3;
        expect(
          runtime.resizeViewport(951, height),
          isTrue,
          reason: 'native resize ABI is unavailable at height $height',
        );

        // A resize invalidates the retained DrawList synchronously. The
        // following display-tick call may legitimately be unchanged; both
        // calls are checked so a stale/missing first resize frame cannot hide
        // behind an otherwise healthy ticker.
        final resizeFrame = pocketFrameDeltaAt(runtime, 0);
        _assertVisibleFrame(resizeFrame, height, 'resize delta=0');
        overlayY = _recordInputRect(resizeFrame, overlayY);

        final tickFrame = pocketFrameDeltaAt(runtime, 16.67);
        if (tickFrame != null) {
          _assertVisibleFrame(tickFrame, height, 'resize delta=16.67');
          overlayY = _recordInputRect(tickFrame, overlayY);
        }

        final visible = tickFrame ?? resizeFrame!;
        final input = _text(visible, 'Input round-trip')!;
        final counter = _text(visible, 'Counter')!;
        expect(
          input.y,
          closeTo(counter.y, 2),
          reason: 'Input and Counter did not preserve the page scroll delta',
        );
        expect(
          overlayY,
          closeTo(_text(visible, 'Tap to type')!.y - 8, 2),
          reason:
              'native text-input rect fell out of sync with the JS input shell',
        );
      }

      // Once the keyboard has settled, unchanged binary frames are expected.
      // If the native side emits a changed frame, it must still contain the
      // same visible anchors rather than a stale pre-scroll DrawList.
      for (var index = 0; index < 12; index++) {
        final settled = pocketFrameDeltaAt(runtime, 16.67);
        if (settled == null) continue;
        _assertVisibleFrame(settled, 405, 'settled delta=16.67');
        overlayY = _recordInputRect(settled, overlayY);
        expect(overlayY, closeTo(_text(settled, 'Tap to type')!.y - 8, 2));
      }
    } finally {
      runtime.dispose();
    }
  });
}

Future<Uint8List> _assetBytes(String name) async {
  final data = await rootBundle.load(name);
  return Uint8List.fromList(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
  );
}

PocketFrame _settleHostRequests(
  FfiPocketRuntime runtime,
  PocketFrame frame,
  PocketBytecodeMetadata metadata,
) {
  for (final event in frame.events) {
    if (event.method != 'host.request') continue;
    final capability = event.params['capability'];
    final requestId = event.params['requestId'];
    if (capability is! String || requestId is! String) continue;
    runtime.send({
      'type': 'event',
      'name': 'host.response',
      'payload': {
        'requestId': requestId,
        'capability': capability,
        'ok': true,
        'result': _hostResult(capability, metadata),
      },
    });
  }
  return frame;
}

PocketFrame _advanceAndSettleHostRequests(
  FfiPocketRuntime runtime,
  PocketBytecodeMetadata metadata,
) {
  var frame = pocketFrameAt(runtime, 16.67);
  for (var attempt = 0; attempt < 4; attempt++) {
    final before = frame.events
        .where((event) => event.method == 'host.request')
        .length;
    _settleHostRequests(runtime, frame, metadata);
    if (before == 0) return frame;
    frame = pocketFrameAt(runtime, 16.67);
  }
  return frame;
}

Map<String, dynamic> _hostResult(
  String capability,
  PocketBytecodeMetadata metadata,
) {
  switch (capability) {
    case 'runtime.info':
      return {
        'entryFormat': metadata.entryFormat,
        'runtimeAbi': metadata.runtimeAbi,
        'version': 'embedded',
        'build': 0,
        'source': 'embedded',
        'entryBytes': metadata.bytecodeBytes,
      };
    case 'plugins.list':
      return {
        'plugins': [
          {'id': 'probe.plugin', 'version': '1.0.0', 'kind': 'capability'},
        ],
      };
    case 'plugins.packageInfo':
      return {
        'provider': 'package_info_plus',
        'appName': 'Pocket Host',
        'packageName': 'dev.tryjoy.pocket-host',
        'version': '0.1.0',
        'buildNumber': '1',
      };
    case 'updates.status':
      return {
        'configured': false,
        'stage': 'not_configured',
        'activeVersion': 'embedded',
        'activeBuild': 0,
        'availableVersion': null,
        'versions': <Object?>[],
        'lastError': null,
      };
    default:
      return <String, dynamic>{};
  }
}

Map<String, dynamic> _pointer(String phase, double x, double y) => {
  'type': 'event',
  'name': 'input.pointer',
  'payload': {'phase': phase, 'id': 0, 'x': x, 'y': y},
};

PocketTextOp? _text(PocketFrame frame, String value) {
  for (final op in frame.ops) {
    if (op is PocketTextOp && op.text == value) return op;
  }
  return null;
}

double? _inputEventY(PocketFrame? frame) {
  if (frame == null) return null;
  for (final event in frame.events) {
    if (event.method != 'textInput.open' &&
        event.method != 'textInput.update') {
      continue;
    }
    final raw = event.params['rect'];
    if (raw is Map && raw['y'] is num) return (raw['y'] as num).toDouble();
  }
  return null;
}

double _recordInputRect(PocketFrame? frame, double previous) {
  final next = _inputEventY(frame);
  if (frame != null) {
    expect(
      frame.events.where((event) => event.method == 'textInput.close'),
      isEmpty,
      reason: 'the active editor closed during keyboard resize',
    );
  }
  return next ?? previous;
}

void _assertVisibleFrame(PocketFrame? frame, double height, String phase) {
  expect(frame, isNotNull, reason: '$phase returned no changed binary frame');
  final current = frame!;
  expect(current.width, closeTo(951, .01), reason: '$phase width drifted');
  expect(current.height, closeTo(height, .01), reason: '$phase height drifted');
  expect(
    _text(current, 'Input round-trip'),
    isNotNull,
    reason: '$phase lost the Input anchor: ${_frameSummary(current)}',
  );
  expect(
    _text(current, 'Counter'),
    isNotNull,
    reason: '$phase lost the Counter anchor: ${_frameSummary(current)}',
  );
}

String _frameSummary(PocketFrame frame) {
  final labels = frame.ops
      .whereType<PocketTextOp>()
      .map((op) => op.text)
      .where((text) => text == 'Input round-trip' || text == 'Counter')
      .join(',');
  return 'frame=${frame.width}x${frame.height} ops=${frame.ops.length} labels=[$labels]';
}
