import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_live2d/pocket_live2d.dart';
import 'package:pocket_live2d/src/pocket_live2d_ffi.dart';

void main() {
  final sdkRoot =
      Platform.environment['CUBISM_SDK_ROOT'] ??
      '.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5';
  final libraryPath = Platform.environment['POCKET_LIVE2D_CORE_LIBRARY'];
  final mocPath = '$sdkRoot/Samples/Resources/Mao/Mao.moc3';
  final hiyoriMocPath = '$sdkRoot/Samples/Resources/Hiyori/Hiyori.moc3';
  final prerequisitesAvailable =
      libraryPath != null &&
      File(libraryPath).existsSync() &&
      File(mocPath).existsSync();
  final hiyoriPrerequisitesAvailable =
      libraryPath != null &&
      File(libraryPath).existsSync() &&
      File(hiyoriMocPath).existsSync();

  test(
    'official Core deformation crosses the real Pocket binary host-response budget',
    () async {
      final mocBytes = Uint8List.fromList(await File(mocPath).readAsBytes());
      final bundle = _MocAssetBundle('Mao.moc3', mocBytes);
      final library = DynamicLibrary.open(libraryPath!);
      final plugin = PocketLive2dPlugin(
        assets: const <String, String>{'Mao.moc3': 'Mao.moc3'},
        bundle: bundle,
        coreFactory: (bytes) =>
            PocketLive2dFfiCore.createModel(bytes, library: library),
      );

      try {
        final loaded =
            await plugin.load(<String, dynamic>{
                  'id': 'mao',
                  'mocAsset': 'Mao.moc3',
                  'textures': <String>['texture_00.png'],
                })
                as Map<String, Object?>;
        expect(loaded['mocVersion'], 5);
        expect(loaded['parameterDefaults'], isNotEmpty);
        final metadata = (loaded['parameterMetadata']! as List)
            .cast<Map<String, Object?>>();
        expect(metadata, hasLength(loaded['parameterCount']! as int));
        expect(
          metadata.firstWhere((entry) => entry['id'] == 'ParamAngleX'),
          <String, Object?>{
            'id': 'ParamAngleX',
            'minimum': -30.0,
            'maximum': 30.0,
            'defaultValue': 0.0,
          },
        );
        expect(loaded['parts'], isNotEmpty);
        final loadedPacket = PocketBinaryCodec.encodeMessage(
          _hostResponse(loaded),
          maxBytes: 1024 * 1024,
        );
        expect(loadedPacket.length, lessThan(1024 * 1024));
        expect(loaded['nativeBytes'], greaterThan(mocBytes.length));

        final modelId = loaded['modelId']! as String;
        var previous = await _update(plugin, modelId, const <Object?>[]);
        final quietFrames = <_VertexFrameStats>[];
        for (var frame = 0; frame < 6; frame++) {
          final next = await _update(plugin, modelId, const <Object?>[]);
          final stats = _measureVertexFrame(
            previous['drawables']! as List<Map<String, Object?>>,
            next['drawables']! as List<Map<String, Object?>>,
          );
          quietFrames.add(stats);
          expect(
            stats.movedComponents,
            0,
            reason: 'Mao default Core update $frame should preserve vertices',
          );
          previous = next;
        }
        final baseline = previous;
        final changed = await _update(plugin, modelId, const <Object?>[
          <String, Object?>{'id': 'ParamAngleX', 'value': 30.0},
        ]);
        final baselineDrawables =
            baseline['drawables']! as List<Map<String, Object?>>;
        final changedDrawables =
            changed['drawables']! as List<Map<String, Object?>>;
        final changedFrameStats = _measureVertexFrame(
          baselineDrawables,
          changedDrawables,
        );
        expect(
          changedFrameStats.movedComponents,
          greaterThan(0),
          reason: 'Mao ParamAngleX change should deform Core positions',
        );
        final repeatedAngleFrames = <_VertexFrameStats>[];
        var repeatedAngleFrame = changed;
        for (var frame = 0; frame < 4; frame++) {
          final next = await _update(plugin, modelId, const <Object?>[
            <String, Object?>{'id': 'ParamAngleX', 'value': 30.0},
          ]);
          final stats = _measureVertexFrame(
            repeatedAngleFrame['drawables']! as List<Map<String, Object?>>,
            next['drawables']! as List<Map<String, Object?>>,
          );
          repeatedAngleFrames.add(stats);
          expect(
            stats.movedComponents,
            0,
            reason:
                'Mao repeated ParamAngleX frame $frame should preserve vertices',
          );
          repeatedAngleFrame = next;
        }
        var movedComponents = 0;
        for (var index = 0; index < baselineDrawables.length; index++) {
          final before = _decodePms1Positions(
            baselineDrawables[index]['meshBytes']! as Uint8List,
          );
          final after = _decodePms1Positions(
            changedDrawables[index]['meshBytes']! as Uint8List,
          );
          for (var component = 0; component < before.length; component++) {
            if ((before[component] - after[component]).abs() > 0.001)
              movedComponents++;
          }
        }
        expect(movedComponents, greaterThan(0));

        final response = _hostResponse(changed);
        final packet = PocketBinaryCodec.encodeMessage(
          response,
          maxBytes: 1024 * 1024,
        );
        expect(packet.length, lessThan(1024 * 1024));
        final decoded = PocketBinaryCodec.decodeMessage(
          packet,
          maxBytes: 1024 * 1024,
        );
        final decodedResult = ((decoded['payload']! as Map)['result']! as Map);
        final decodedDrawables = decodedResult['drawables']! as List<dynamic>;
        expect(decodedDrawables, hasLength(262));
        expect(
          (decodedDrawables.first as Map)['meshBytes'],
          isA<Uint8List>(),
        );

        final scalarDrawables = changedDrawables
            .map((drawable) {
              final meshBytes = drawable['meshBytes']! as Uint8List;
              final meshData = ByteData.sublistView(meshBytes);
              final vertexCount = meshBytes.isEmpty
                  ? 0
                  : meshData.getUint32(4, Endian.little);
              final indexCount = meshBytes.isEmpty
                  ? 0
                  : meshData.getUint32(8, Endian.little);
              final verticesEnd = 16 + vertexCount * 16;
              return <String, Object?>{
                ...drawable,
                'vertices': meshBytes.isEmpty
                    ? const <double>[]
                    : _decodeFloat32(
                        Uint8List.sublistView(meshBytes, 16, verticesEnd),
                      ),
                'indices': meshBytes.isEmpty
                    ? const <int>[]
                    : _decodeUnsigned(
                        Uint8List.sublistView(
                          meshBytes,
                          verticesEnd,
                          verticesEnd + indexCount * 4,
                        ),
                        4,
                      ),
                'maskIndices': _decodeUnsigned(
                  drawable['maskIndices']! as Uint8List,
                  4,
                ),
                'multiplyColorRgba': _decodeFloat32(
                  drawable['multiplyColorRgba']! as Uint8List,
                ),
                'screenColorRgba': _decodeFloat32(
                  drawable['screenColorRgba']! as Uint8List,
                ),
              }..remove('meshBytes');
            })
            .toList(growable: false);
        final scalarResult = <String, Object?>{
          ...changed,
          'drawables': scalarDrawables,
        };
        final scalarPacket = PocketBinaryCodec.encodeMessage(
          _hostResponse(scalarResult),
          maxBytes: 4 * 1024 * 1024,
        );
        expect(scalarPacket.length, greaterThan(packet.length));

        final reset = await _update(plugin, modelId, const <Object?>[]);
        final resetDrawables =
            reset['drawables']! as List<Map<String, Object?>>;
        expect(
          _decodePms1Positions(
            resetDrawables.first['meshBytes']! as Uint8List,
          ),
          _decodePms1Positions(
            baselineDrawables.first['meshBytes']! as Uint8List,
          ),
        );
        await plugin.release(<String, dynamic>{'modelId': modelId});
        expect(plugin.activeModelCount, 0);

        print(
          'Live2D Core facts: drawables=${decodedDrawables.length}, '
          'Mao defaultFrames=${quietFrames.length} '
          '${_formatVertexStats(quietFrames)}, '
          'ParamAngleX-transition=${_formatVertexStats([changedFrameStats])}, '
          'ParamAngleX-repeated=${_formatVertexStats(repeatedAngleFrames)}, '
          'movedComponents=$movedComponents, packedResponseBytes=${packet.length}, '
          'scalarResponseBytes=${scalarPacket.length}, '
          'packedReduction=${(100 * (1 - packet.length / scalarPacket.length)).toStringAsFixed(1)}%',
        );
      } finally {
        await plugin.dispose();
      }
    },
    skip: prerequisitesAvailable
        ? false
        : 'Run scripts/run_macos_core_bridge_test.sh after local Cubism Core bootstrap.',
  );

  test(
    'official Hiyori Core vertex flags report frame facts without changing coordinates',
    () async {
      final mocBytes = Uint8List.fromList(
        await File(hiyoriMocPath).readAsBytes(),
      );
      final library = DynamicLibrary.open(libraryPath!);
      final plugin = PocketLive2dPlugin(
        assets: const <String, String>{'Hiyori.moc3': 'Hiyori.moc3'},
        bundle: _MocAssetBundle('Hiyori.moc3', mocBytes),
        coreFactory: (bytes) =>
            PocketLive2dFfiCore.createModel(bytes, library: library),
      );
      try {
        final loaded =
            await plugin.load(<String, dynamic>{
                  'id': 'hiyori-core-facts',
                  'mocAsset': 'Hiyori.moc3',
                  'textures': <String>[
                    'Hiyori.2048/texture_00.png',
                    'Hiyori.2048/texture_01.png',
                  ],
                })
                as Map<String, Object?>;
        final modelId = loaded['modelId']! as String;
        expect(loaded['drawableCount'], 134);

        var previous = await _update(plugin, modelId, const <Object?>[]);
        final quietFrames = <_VertexFrameStats>[];
        for (var frame = 0; frame < 6; frame++) {
          final next = await _update(plugin, modelId, const <Object?>[]);
          final stats = _measureVertexFrame(
            previous['drawables']! as List<Map<String, Object?>>,
            next['drawables']! as List<Map<String, Object?>>,
          );
          quietFrames.add(stats);
          expect(
            stats.movedComponents,
            0,
            reason:
                'Hiyori default Core update $frame should preserve vertices',
          );
          previous = next;
        }

        final changed = await _update(plugin, modelId, const <Object?>[
          <String, Object?>{'id': 'ParamAngleX', 'value': 30.0},
        ]);
        final changedStats = _measureVertexFrame(
          previous['drawables']! as List<Map<String, Object?>>,
          changed['drawables']! as List<Map<String, Object?>>,
        );
        expect(
          changedStats.movedComponents,
          greaterThan(0),
          reason: 'Hiyori ParamAngleX should deform real Core positions',
        );

        final repeatedFrames = <_VertexFrameStats>[];
        var repeated = changed;
        for (var frame = 0; frame < 4; frame++) {
          final next = await _update(plugin, modelId, const <Object?>[
            <String, Object?>{'id': 'ParamAngleX', 'value': 30.0},
          ]);
          final stats = _measureVertexFrame(
            repeated['drawables']! as List<Map<String, Object?>>,
            next['drawables']! as List<Map<String, Object?>>,
          );
          repeatedFrames.add(stats);
          expect(
            stats.movedComponents,
            0,
            reason:
                'Hiyori repeated ParamAngleX frame $frame should preserve vertices',
          );
          repeated = next;
        }

        print(
          'Live2D Core facts: Hiyori drawables=${loaded['drawableCount']}, '
          'defaultFrames=${quietFrames.length} ${_formatVertexStats(quietFrames)}, '
          'ParamAngleX-transition=${_formatVertexStats([changedStats])}, '
          'ParamAngleX-repeated=${_formatVertexStats(repeatedFrames)}',
        );
        await plugin.release(<String, dynamic>{'modelId': modelId});
        expect(plugin.activeModelCount, 0);
      } finally {
        await plugin.dispose();
      }
    },
    skip: hiyoriPrerequisitesAvailable
        ? false
        : 'Run scripts/run_macos_core_bridge_test.sh after local Cubism Core bootstrap.',
  );
  test(
    'real Core drawable snapshots stay immutable across update and disposal',
    () {
      final model = PocketLive2dFfiCore.createModel(
        File(hiyoriMocPath).readAsBytesSync(),
        library: DynamicLibrary.open(libraryPath!),
      );
      try {
        model.update();
        final snapshots = [
          for (var index = 0; index < model.drawableCount; index++)
            model.drawableAt(index),
        ];
        final expectedPositions = [
          for (final snapshot in snapshots) [...snapshot.positionsXYPixels],
        ];
        for (var index = 0; index < snapshots.length; index++) {
          final snapshot = snapshots[index];
          final floatArrays = <List<double>>[
            snapshot.positionsXYPixels,
            snapshot.uvs,
            snapshot.multiplyColorRgba,
            snapshot.screenColorRgba,
          ];
          for (final values in floatArrays) {
            if (values.isEmpty) continue;
            expect(() => values[0] = 99, throwsUnsupportedError);
            expect(
              () => (values as Float32List).buffer.asUint8List()[0] = 0,
              throwsUnsupportedError,
            );
          }
        }
        model.setParameter('ParamAngleX', 30);
        model.update();
        var changed = false;
        for (var index = 0; index < snapshots.length; index++) {
          final current = model.drawableAt(index).positionsXYPixels;
          final original = expectedPositions[index];
          for (var component = 0; component < current.length; component++) {
            if ((current[component] - original[component]).abs() > .001) {
              changed = true;
              break;
            }
          }
        }
        expect(changed, isTrue, reason: 'the real native model must deform');
        model.dispose();
        for (var index = 0; index < snapshots.length; index++) {
          expect(snapshots[index].positionsXYPixels, expectedPositions[index]);
        }
      } finally {
        model.dispose();
      }
    },
    skip: hiyoriPrerequisitesAvailable
        ? false
        : 'Run scripts/run_macos_core_bridge_test.sh after local Cubism Core bootstrap.',
  );
}

Future<Map<String, Object?>> _update(
  PocketLive2dPlugin plugin,
  String modelId,
  List<Object?> parameters,
) async =>
    await plugin.update(<String, dynamic>{
          'modelId': modelId,
          'parameters': parameters,
          'partOpacities': const <Object?>[],
        })
        as Map<String, Object?>;

List<double> _decodeFloat32(Uint8List bytes) {
  final data = ByteData.sublistView(bytes);
  return <double>[
    for (var offset = 0; offset < bytes.length; offset += 4)
      data.getFloat32(offset, Endian.little),
  ];
}

List<double> _decodePms1Positions(Uint8List bytes) {
  if (bytes.isEmpty) return const <double>[];
  final data = ByteData.sublistView(bytes);
  expect(data.getUint32(0, Endian.little), pocketLive2dPms1Magic);
  final vertexCount = data.getUint32(4, Endian.little);
  final result = <double>[];
  for (var vertex = 0; vertex < vertexCount; vertex++) {
    final offset = 16 + vertex * 16;
    result.add(data.getFloat32(offset, Endian.little));
    result.add(data.getFloat32(offset + 4, Endian.little));
  }
  return result;
}

List<int> _decodeUnsigned(Uint8List bytes, int bytesPerValue) {
  final data = ByteData.sublistView(bytes);
  return <int>[
    for (var offset = 0; offset < bytes.length; offset += bytesPerValue)
      bytesPerValue == 2
          ? data.getUint16(offset, Endian.little)
          : data.getUint32(offset, Endian.little),
  ];
}

const _vertexPositionsDidChange = 1 << 5;

typedef _VertexFrameStats = ({
  int flaggedMoved,
  int flaggedStill,
  int clearMoved,
  int clearStill,
  int movedComponents,
  double maxDelta,
});

_VertexFrameStats _measureVertexFrame(
  List<Map<String, Object?>> before,
  List<Map<String, Object?>> after,
) {
  final beforeById = <String, Map<String, Object?>>{
    for (final drawable in before) drawable['id']! as String: drawable,
  };
  expect(after, hasLength(before.length), reason: 'Core drawable count');
  var flaggedMoved = 0;
  var flaggedStill = 0;
  var clearMoved = 0;
  var clearStill = 0;
  var movedComponents = 0;
  var maxDelta = 0.0;
  for (final drawable in after) {
    final id = drawable['id']! as String;
    final previous = beforeById[id]!;
    final oldPositions = _decodePms1Positions(
      previous['meshBytes']! as Uint8List,
    );
    final nextPositions = _decodePms1Positions(
      drawable['meshBytes']! as Uint8List,
    );
    expect(
      nextPositions,
      hasLength(oldPositions.length),
      reason: '$id topology',
    );
    var drawableMoved = false;
    for (var index = 0; index < oldPositions.length; index++) {
      final delta = (oldPositions[index] - nextPositions[index]).abs();
      if (delta > 0) {
        drawableMoved = true;
        movedComponents++;
      }
      if (delta > maxDelta) maxDelta = delta;
    }
    final flagSet =
        ((drawable['dynamicFlags']! as int) & _vertexPositionsDidChange) != 0;
    if (flagSet) {
      if (drawableMoved) {
        flaggedMoved++;
      } else {
        flaggedStill++;
      }
    } else {
      if (drawableMoved) {
        clearMoved++;
      } else {
        clearStill++;
      }
    }
  }
  return (
    flaggedMoved: flaggedMoved,
    flaggedStill: flaggedStill,
    clearMoved: clearMoved,
    clearStill: clearStill,
    movedComponents: movedComponents,
    maxDelta: maxDelta,
  );
}

String _formatVertexStats(Iterable<_VertexFrameStats> frames) {
  final values = frames.toList(growable: false);
  if (values.isEmpty) return 'frames=0';
  final flaggedMoved = values.fold<int>(
    0,
    (sum, value) => sum + value.flaggedMoved,
  );
  final flaggedStill = values.fold<int>(
    0,
    (sum, value) => sum + value.flaggedStill,
  );
  final clearMoved = values.fold<int>(
    0,
    (sum, value) => sum + value.clearMoved,
  );
  final clearStill = values.fold<int>(
    0,
    (sum, value) => sum + value.clearStill,
  );
  final movedComponents = values.fold<int>(
    0,
    (sum, value) => sum + value.movedComponents,
  );
  final maxDelta = values.fold<double>(
    0,
    (max, value) => value.maxDelta > max ? value.maxDelta : max,
  );
  return 'frames=${values.length} flag&move=$flaggedMoved flag&same=$flaggedStill '
      'clear&move=$clearMoved clear&same=$clearStill movedComponents=$movedComponents '
      'maxDelta=${maxDelta.toStringAsFixed(6)}';
}

Map<String, Object?> _hostResponse(Map<String, Object?> result) =>
    <String, Object?>{
      'type': 'event',
      'id': 'live2d-integration',
      'name': 'host.response',
      'payload': <String, Object?>{
        'requestId': 'live2d-request',
        'capability': pocketLive2dUpdateCapability,
        'ok': true,
        'result': result,
      },
    };

final class _MocAssetBundle extends CachingAssetBundle {
  _MocAssetBundle(this.asset, this.bytes);

  final String asset;
  final Uint8List bytes;

  @override
  Future<ByteData> load(String key) async {
    if (key != asset) throw StateError('unexpected loose asset request: $key');
    return ByteData.sublistView(bytes);
  }
}
