import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _nativeSource = r'''
let tick = 0;
globalThis.frame = function() {
  tick++;
  const random = Math.random();
  const now = Date.now();
  const perf = globalThis.performance.now();
  globalThis.__clockSample = [now, random, perf];
  const node = ui.createNode(0);
  ui.setProp(node, 1, 40);
  ui.setProp(node, 2, 24);
  ui.setProp(node, 64, random < 0.5 ? 0xff336699 : 0xff996633);
  ui.insertBefore(1, node, 0);
};
''';

const _duplexSource = r'''
globalThis.__pocketDuplexEvent = function(type, flags, target, a0, a1) {
  pocket.duplex.emit(type + 1, flags, target, a0, a1);
};
''';

const _deterministicSource = r'''
const node = ui.createNode(0);
ui.setProp(node, 1, 40);
ui.setProp(node, 2, 24);
ui.setProp(node, 64, 0xff336699);
ui.insertBefore(1, node, 0);
globalThis.frame = function() {};
''';

String _frameDigest(PocketFrame frame) {
  final summary = <String, dynamic>{
    'width': frame.width,
    'height': frame.height,
    'ops': frame.ops.map(_opSnapshot).toList(growable: false),
    'events': frame.events
        .map(
          (event) => <String, dynamic>{
            'id': event.id,
            'method': event.method,
            'params': event.params,
          },
        )
        .toList(growable: false),
    'resources': frame.resources
        .map(
          (resource) => <String, dynamic>{
            'asset': resource.asset,
            'revision': resource.revision,
            'width': resource.width,
            'height': resource.height,
            'psm': resource.psm,
            'linear': resource.linear,
            'pixelsBytes': resource.pixels.length,
            'pixelsSha256': pocketSha256(resource.pixels),
            'paletteBytes': resource.palette?.length,
            'paletteSha256': resource.palette == null
                ? null
                : pocketSha256(resource.palette!),
          },
        )
        .toList(growable: false),
    'releasedResources': frame.releasedResources,
    'auxiliary': frame.auxiliary == null
        ? null
        : <String, dynamic>{
            'width': frame.auxiliary!.width,
            'height': frame.auxiliary!.height,
            'ops': frame.auxiliary!.ops
                .map(_opSnapshot)
                .toList(growable: false),
          },
  };
  return pocketSha256(utf8.encode(pocketCanonicalJson(summary)));
}

Map<String, dynamic> _opSnapshot(PocketOp op) {
  final result = <String, dynamic>{
    'type': switch (op) {
      PocketRectOp() => 'rect',
      PocketRoundedOp() => 'rounded',
      PocketGradientOp() => 'gradient',
      PocketTriangleOp() => 'triangle',
      PocketTextureTriangleOp() => 'textureTriangle',
      PocketMeshLayerBeginOp() => 'meshLayerBegin',
      PocketMeshMaskBeginOp() => 'meshMaskBegin',
      PocketMeshLayerRestoreOp() => 'meshLayerRestore',
      PocketTextOp() => 'text',
      PocketImageOp() => 'image',
      PocketVideoOp() => 'video',
      PocketHostSurfaceOp() => 'hostSurface',
    },
    'x': op.x,
    'y': op.y,
    'width': op.width,
    'height': op.height,
    'clip': op.clip == null
        ? null
        : <String, dynamic>{
            'x': op.clip!.x,
            'y': op.clip!.y,
            'width': op.clip!.width,
            'height': op.clip!.height,
          },
  };
  switch (op) {
    case PocketRectOp value:
      result['color'] = value.color;
    case PocketRoundedOp value:
      result['color'] = value.color;
      result['radius'] = value.radius;
    case PocketGradientOp value:
      result['fromColor'] = value.fromColor;
      result['toColor'] = value.toColor;
      result['direction'] = value.direction;
    case PocketTriangleOp value:
      result['points'] = value.points
          .map((point) => <String, dynamic>{'x': point.x, 'y': point.y})
          .toList(growable: false);
      result['colors'] = value.colors;
    case PocketTextureTriangleOp value:
      result['asset'] = value.asset;
      result['color'] = value.color;
      if (value.repeatTexture) result['repeatTexture'] = true;
      result['points'] = value.points
          .map((point) => <String, dynamic>{'x': point.x, 'y': point.y})
          .toList(growable: false);
      result['uvs'] = value.uvs;
    case PocketMeshLayerBeginOp value:
      result['color'] = value.blend;
      result['uvs'] = <double>[...value.multiplyRgb, ...value.screenRgb];
    case PocketMeshMaskBeginOp value:
      result['color'] = value.inverted ? 1 : 0;
    case PocketMeshLayerRestoreOp():
      break;
    case PocketTextOp value:
      result['text'] = value.text;
      result['size'] = value.size;
      result['color'] = value.color;
      result['fontSlot'] = value.fontSlot;
    case PocketImageOp value:
      result['asset'] = value.asset;
      result['uv'] = value.uv;
      result['tint'] = value.tint;
    case PocketVideoOp value:
      result['id'] = value.id;
      result['asset'] = value.asset;
      result['autoplay'] = value.autoplay;
      result['fit'] = value.fit;
    case PocketHostSurfaceOp value:
      result['id'] = value.id;
      result['kind'] = value.kind;
      result['parameters'] = value.parameters;
  }
  return result;
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skipWithoutNative = libraryPath == null
      ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
      : false;

  test(
    'real native record/replay captures clock, host, lifecycle, resize and auxiliary lanes',
    () async {
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 64,
        maxBytes: 256 * 1024,
      );
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 480,
        recording: controller,
      );
      try {
        runtime.enableAuxiliary(120, 80);
        final first = runtime.eval(_nativeSource);
        expect(first.ops, isNotEmpty);
        runtime.send(<String, dynamic>{
          'type': 'response',
          'id': 'recording-host-response',
          'result': <String, dynamic>{
            'ok': true,
            'token': 'ordinary-rpc-token',
            'secret': 'ordinary-rpc-secret',
            'password': 'ordinary-rpc-password',
          },
        });
        runtime.frameAt(17);
        runtime.setSchedulerPaused(true);
        runtime.setSchedulerPaused(false);
        expect(runtime.resizeViewport(300, 500), isTrue);
        runtime.frameDeltaAt(19);
      } finally {
        runtime.dispose();
      }

      final recording = controller.finish();
      expect(recording.incomplete, isFalse);
      expect(recording.entries, isNotEmpty);
      expect(
        recording.entries.map((entry) => entry.kind),
        containsAll(<String>[
          'auxiliary',
          'eval',
          'send',
          'frame',
          'schedulerPause',
          'resize',
          'frameDelta',
        ]),
      );
      expect(
        recording.entries
            .where((entry) => entry.result.containsKey('traceClock'))
            .length,
        greaterThan(0),
      );
      final scalarKinds = <String>{
        for (final entry in recording.entries)
          if (entry.result['traceClock'] case final Map clock)
            for (final scalar in clock['scalars'] as List)
              (scalar as Map)['kind'] as String,
      };
      expect(
        scalarKinds,
        containsAll(['dateNow', 'mathRandom', 'performanceNow']),
      );

      final retained = controller.replayAssets;
      final replay = await replayPocketRecording(
        recording,
        assets: PocketReplayAssets(
          source: _nativeSource,
          byHash: retained.byHash,
          byKey: retained.byKey,
        ),
      );
      expect(replay.matched, isTrue, reason: jsonEncode(replay.toJson()));
      expect(replay.firstMismatch, isNull);
    },
    skip: skipWithoutNative,
  );

  test(
    'real native binary duplex ingress/step/egress transactions replay',
    () async {
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 32,
        maxBytes: 128 * 1024,
      );
      final runtime = FfiPocketRuntime.open(recording: controller);
      PocketDuplexChannel? channel;
      try {
        runtime.eval(_duplexSource);
        channel = PocketDuplexChannel.fromRuntime(runtime);
        expect(
          channel.pushToPocketJs(
            msgType: 20,
            targetId: 42,
            arg0: 1.5,
            arg1: 2.5,
          ),
          isTrue,
        );
        expect(channel.step(), 1);
        final events = channel.drainFromPocketJs(maxBatch: 1);
        expect(events, hasLength(1));
        expect(events.single.msgType, 21);
        expect(events.single.targetId, 42);
      } finally {
        channel?.close();
        runtime.dispose();
      }

      final recording = controller.finish();
      expect(recording.incomplete, isFalse);
      expect(
        recording.entries.map((entry) => entry.kind),
        containsAll(<String>[
          'duplexIngressPublish',
          'duplexStep',
          'duplexEgressPeek',
          'duplexEgressConsume',
        ]),
      );
      final retained = controller.replayAssets;
      final replay = await replayPocketRecording(
        recording,
        assets: PocketReplayAssets(
          source: _duplexSource,
          byHash: retained.byHash,
          byKey: retained.byKey,
        ),
      );
      expect(replay.matched, isTrue, reason: '${replay.firstMismatch}');
    },
    skip: skipWithoutNative,
  );

  for (final invalidCount in [0, -1, 2]) {
    test(
      'duplex invalid publish $invalidCount records and replays the native error',
      () async {
        final controller = PocketRecordingController(
          retainReplayAssets: true,
          maxEntries: 16,
          maxBytes: 64 * 1024,
        );
        final runtime = FfiPocketRuntime.open(recording: controller);
        try {
          runtime.eval(_duplexSource);
          final endpoint = runtime.duplexEndpoint!;
          expect(endpoint.reserveIngress(1), isNotNull);
          expect(
            () => endpoint.publishIngress(invalidCount),
            throwsA(
              invalidCount < 1
                  ? isA<RangeError>()
                  : isA<PocketRuntimeException>(),
            ),
          );
          final errorEntry = controller.snapshot().entries.last;
          expect(errorEntry.kind, 'duplexIngressPublish');
          expect(errorEntry.error, isNotNull);
          // Native poisons a generation with an abandoned borrowed pointer.
          expect(() => endpoint.reserveIngress(1), throwsA(isA<StateError>()));
          expect(() => runtime.duplexEndpoint, throwsA(isA<StateError>()));
          runtime.frameAt(0);
        } finally {
          runtime.dispose();
        }
        final recording = controller.finish();
        expect(recording.incomplete, isFalse);
        final retained = controller.replayAssets;
        final replay = await replayPocketRecording(
          recording,
          assets: PocketReplayAssets(
            byHash: retained.byHash,
            byKey: retained.byKey,
          ),
        );
        expect(replay.matched, isTrue, reason: jsonEncode(replay.toJson()));
      },
      skip: skipWithoutNative,
    );
  }

  test(
    'firstMismatch identifies tampered frame/input and asset SHA rejects replay',
    () async {
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 16,
        maxBytes: 64 * 1024,
      );
      final runtime = FfiPocketRuntime.open(recording: controller);
      try {
        runtime.eval(_nativeSource);
        runtime.frameAt(16);
      } finally {
        runtime.dispose();
      }
      final recording = controller.finish();
      final retained = controller.replayAssets;
      final json = jsonDecode(recording.toJsonString()) as Map<String, dynamic>;
      final entries = (json['entries'] as List).cast<Map>();
      final firstFrame = entries.firstWhere(
        (entry) => (entry['result'] as Map).containsKey('frame'),
      );
      final result = Map<String, dynamic>.from(firstFrame['result'] as Map);
      final frame = Map<String, dynamic>.from(result['frame'] as Map);
      frame['sha256'] = List.filled(64, '0').join();
      result['frame'] = frame;
      firstFrame['result'] = result;
      final tampered = PocketRecording.fromJson(json);
      final mismatch = await replayPocketRecording(
        tampered,
        assets: PocketReplayAssets(
          source: _nativeSource,
          byHash: retained.byHash,
          byKey: retained.byKey,
        ),
      );
      expect(mismatch.matched, isFalse);
      expect(mismatch.firstMismatch, isNotNull);
      expect(mismatch.firstMismatch!.frameIndex, isNotNull);

      final inputJson =
          jsonDecode(recording.toJsonString()) as Map<String, dynamic>;
      final inputEntries = (inputJson['entries'] as List).cast<Map>();
      final frameEntry = inputEntries.firstWhere(
        (entry) => entry['kind'] == 'frame',
      );
      final inputArgs = Map<String, dynamic>.from(frameEntry['args'] as Map);
      inputArgs['deltaMs'] = 17.0;
      frameEntry['args'] = inputArgs;
      final inputTampered = PocketRecording.fromJson(inputJson);
      final inputResult = await replayPocketRecording(
        inputTampered,
        assets: PocketReplayAssets(
          source: _nativeSource,
          byHash: retained.byHash,
          byKey: retained.byKey,
        ),
      );
      expect(inputResult.matched, isFalse);
      expect(inputResult.firstMismatch?.transaction, 'frame');

      final assetJson =
          jsonDecode(recording.toJsonString()) as Map<String, dynamic>;
      final metadata = Map<String, dynamic>.from(assetJson['metadata'] as Map);
      final hashes = Map<String, dynamic>.from(
        metadata['contentHashes'] as Map,
      );
      hashes['source'] = List.filled(64, 'f').join();
      metadata['contentHashes'] = hashes;
      assetJson['metadata'] = metadata;
      final assetTampered = PocketRecording.fromJson(assetJson);
      final assetResult = await replayPocketRecording(
        assetTampered,
        assets: PocketReplayAssets(
          source: _nativeSource,
          byHash: retained.byHash,
          byKey: retained.byKey,
        ),
      );
      expect(assetResult.matched, isFalse);
      expect(assetResult.firstMismatch?.transaction, 'runtime.assets');
    },
    skip: skipWithoutNative,
  );

  test(
    'real native replay rejects deleted frame summaries and clock envelopes',
    () async {
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 16,
        maxBytes: 64 * 1024,
      );
      final runtime = FfiPocketRuntime.open(recording: controller);
      try {
        runtime.eval(_deterministicSource);
        runtime.frameAt(16);
      } finally {
        runtime.dispose();
      }
      final recording = controller.finish();
      final retained = controller.replayAssets;

      Map<String, dynamic> copyDocument() =>
          jsonDecode(recording.toJsonString()) as Map<String, dynamic>;

      void refreshEntryBytes(Map<String, dynamic> document) {
        final entries = (document['entries'] as List).cast<Map>();
        document['bytes'] = entries.fold<int>(
          0,
          (total, entry) =>
              total + utf8.encode(pocketCanonicalJson(entry)).length,
        );
      }

      Future<PocketReplayResult> replayDocument(
        Map<String, dynamic> document,
      ) async {
        refreshEntryBytes(document);
        final tampered = PocketRecording.fromJson(document);
        return replayPocketRecording(
          tampered,
          assets: PocketReplayAssets(
            source: _deterministicSource,
            byHash: retained.byHash,
            byKey: retained.byKey,
          ),
        );
      }

      final missingFrame = copyDocument();
      final frameEntry = (missingFrame['entries'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((entry) => entry['kind'] == 'frame');
      final frameResult = Map<String, dynamic>.from(
        frameEntry['result'] as Map,
      );
      expect(frameResult.remove('frame'), isNotNull);
      frameEntry['result'] = frameResult;
      final frameReplay = await replayDocument(missingFrame);
      expect(
        frameReplay.matched,
        isFalse,
        reason: jsonEncode(frameReplay.toJson()),
      );
      expect(frameReplay.replayable, isFalse);
      expect(frameReplay.rejection, contains('frame summary'));

      final missingClock = copyDocument();
      for (final rawEntry in (missingClock['entries'] as List)) {
        final entry = rawEntry as Map<String, dynamic>;
        final result = Map<String, dynamic>.from(entry['result'] as Map);
        result.remove('traceClock');
        entry['result'] = result;
      }
      final clockReplay = await replayDocument(missingClock);
      expect(
        clockReplay.matched,
        isFalse,
        reason: jsonEncode(clockReplay.toJson()),
      );
      expect(clockReplay.replayable, isFalse);
      expect(clockReplay.rejection, contains('clock envelope'));
    },
    skip: skipWithoutNative,
  );

  test('real native overrun is incomplete and cannot replay', () async {
    final controller = PocketRecordingController(
      retainReplayAssets: true,
      maxEntries: 1,
      maxBytes: 256,
    );
    final runtime = FfiPocketRuntime.open(recording: controller);
    try {
      runtime.eval(_nativeSource);
      runtime.frameAt(16);
    } finally {
      runtime.dispose();
    }
    final recording = controller.finish();
    expect(recording.incomplete, isTrue);
    final result = await replayPocketRecording(
      recording,
      assets: controller.replayAssets,
    );
    expect(result.replayable, isFalse);
    expect(result.rejected, isTrue);
  }, skip: skipWithoutNative);

  test(
    'native scalar quota invalidates the tape while the guest keeps running',
    () {
      const source = r'''
globalThis.frame = () => {
  let count = 0;
  for (let i = 0; i < 4097; i++) if (Number.isFinite(Math.random())) count++;
  pocket._emit(JSON.stringify({ name: 'scalar-count', payload: { count } }));
};
''';
      final controller = PocketRecordingController(retainReplayAssets: true);
      final recorded = FfiPocketRuntime.open(recording: controller);
      final ordinary = FfiPocketRuntime.open();
      try {
        final expected = ordinary.eval(source);
        final actual = recorded.eval(source);
        expect(_frameDigest(actual), _frameDigest(expected));
        expect(actual.events, isNotEmpty);
        expect(controller.isIncomplete, isTrue);
        expect(controller.finish().replayable, isFalse);
        expect(
          _frameDigest(recorded.frameAt(17)),
          _frameDigest(ordinary.frameAt(17)),
        );
      } finally {
        recorded.dispose();
        ordinary.dispose();
      }
    },
    skip: skipWithoutNative,
  );

  test(
    'deep guest events invalidate diagnostics without changing the guest result',
    () {
      const source = r'''
globalThis.frame = () => {
  let payload = { value: 42 };
  for (let i = 0; i < 20; i++) payload = { child: payload };
  pocket._emit(JSON.stringify({ name: 'deep-event', payload }));
};
''';
      final controller = PocketRecordingController(retainReplayAssets: true);
      final recorded = FfiPocketRuntime.open(recording: controller);
      final ordinary = FfiPocketRuntime.open();
      try {
        final expected = ordinary.eval(source);
        final actual = recorded.eval(source);
        expect(_frameDigest(actual), _frameDigest(expected));
        expect(actual.events, isNotEmpty);
        expect(controller.isIncomplete, isTrue);
        expect(controller.finish().replayable, isFalse);
      } finally {
        recorded.dispose();
        ordinary.dispose();
      }
    },
    skip: skipWithoutNative,
  );

  test(
    'stop freezes recording while the native runtime continues, with disabled ablation',
    () async {
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 16,
        maxBytes: 64 * 1024,
      );
      final runtime = FfiPocketRuntime.open(recording: controller);
      final disabled = FfiPocketRuntime.open();
      try {
        final enabledWatch = Stopwatch()..start();
        final enabledFrame = runtime.eval(_deterministicSource);
        runtime.frameAt(16);
        enabledWatch.stop();
        final beforeStop = controller.entryCount;
        final completed = controller.stop();
        expect(completed.version, 1);
        expect(completed.entries, hasLength(beforeStop));
        final afterStop = runtime.frameAt(16);
        runtime.send(<String, dynamic>{
          'type': 'response',
          'id': 'ablation-host-response',
          'result': <String, dynamic>{'ok': true, 'token': 'normal-token'},
        });
        final afterSend = runtime.frameAt(16);
        expect(controller.entryCount, beforeStop);

        final disabledWatch = Stopwatch()..start();
        final disabledFrame = disabled.eval(_deterministicSource);
        final disabledBeforeSend = disabled.frameAt(16);
        disabled.send(<String, dynamic>{
          'type': 'response',
          'id': 'ablation-host-response',
          'result': <String, dynamic>{'ok': true, 'token': 'normal-token'},
        });
        final disabledAfterSend = disabled.frameAt(16);
        disabledWatch.stop();
        expect(_frameDigest(disabledFrame), _frameDigest(enabledFrame));
        expect(_frameDigest(afterStop), _frameDigest(disabledBeforeSend));
        expect(_frameDigest(disabledAfterSend), _frameDigest(afterSend));
        // This is diagnostic-only: no fragile performance threshold is used.
        print(
          'recording ablation: enabled=${enabledWatch.elapsedMicroseconds}us '
          'disabled=${disabledWatch.elapsedMicroseconds}us '
          'entries=$beforeStop bytes=${controller.recordedBytes}',
        );
      } finally {
        runtime.dispose();
        disabled.dispose();
      }
    },
    skip: skipWithoutNative,
  );
}
