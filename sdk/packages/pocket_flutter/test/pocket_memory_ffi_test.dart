import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

const _fourMiB = 4 * 1024 * 1024;
const _thirtyTwoMiB = 32 * 1024 * 1024;
const _maxConfiguredHeap = 2 * 1024 * 1024 * 1024;
const _maxConfiguredPak = 512 * 1024 * 1024;

const _arrayBufferSource = r'''
const allocation = new ArrayBuffer(8 * 1024 * 1024);
globalThis.frame = function() {};
''';

const _recordingSource = r'''
const node = ui.createNode(0);
ui.setProp(node, 1, 40);
ui.setProp(node, 2, 24);
ui.setProp(node, 64, 0xff336699);
ui.insertBefore(1, node, 0);
globalThis.frame = function() {};
''';

Uint8List _emptyPak() {
  final pak = Uint8List(32);
  final data = ByteData.sublistView(pak);
  data.setUint32(0, 0x4b504344, Endian.little);
  data.setUint16(4, 1, Endian.little);
  data.setUint32(12, 32, Endian.little);
  data.setUint32(16, 32, Endian.little);
  data.setUint32(20, 32, Endian.little);
  data.setUint32(24, 32, Endian.little);
  return pak;
}

/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skipWithoutNative = libraryPath == null
      ? 'Set POCKET_NATIVE_LIBRARY to the rebuilt macOS Pocket native dylib.'
      : false;
  requireReal(skipWithoutNative);

  test(
    'memory heap cap reaches native ArrayBuffer admission',
    () {
      final constrained = FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(heapLimitBytes: _fourMiB),
      );
      try {
        try {
          constrained.eval(_arrayBufferSource);
          fail('an 8 MiB ArrayBuffer must exceed heapLimitBytes=4 MiB');
        } on PocketRuntimeException catch (error) {
          final message = error.message.toLowerCase();
          expect(
            message,
            anyOf(contains('out of memory'), contains('allocation')),
          );
        }
      } finally {
        constrained.dispose();
      }

      final expanded = FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(heapLimitBytes: _thirtyTwoMiB),
      );
      try {
        expect(expanded.eval(_arrayBufferSource), isA<PocketFrame>());
      } finally {
        expanded.dispose();
      }
    },
    skip: skipWithoutNative,
  );

  test(
    'minimum PAK admission rejects 31 bytes and accepts 32 bytes',
    () {
      final pak = _emptyPak();
      final rejected = FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(maxPakBytes: 31),
      );
      try {
        try {
          rejected.load(_recordingSource, pak);
          fail('a 32-byte PAK must exceed maxPakBytes=31');
        } on PocketRuntimeException catch (error) {
          expect(error.message, contains('maxPakBytes'));
          expect(error.message, contains('31'));
        }
      } finally {
        rejected.dispose();
      }

      final accepted = FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(maxPakBytes: 32),
      );
      try {
        expect(accepted.load(_recordingSource, pak).ops, isNotEmpty);
      } finally {
        accepted.dispose();
      }
    },
    skip: skipWithoutNative,
  );

  test('memory policy bounds are enforced at the open/load boundary', () {
    expect(
      () => FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(heapLimitBytes: 64 * 1024 - 1),
      ),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(
          heapLimitBytes: _maxConfiguredHeap + 1,
        ),
      ),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(maxPakBytes: 0),
      ),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => FfiPocketRuntime.open(
        memoryLimits: const PocketMemoryLimits(
          maxPakBytes: _maxConfiguredPak + 1,
        ),
      ),
      throwsA(isA<FormatException>()),
    );

    const lower = PocketMemoryLimits(heapLimitBytes: 64 * 1024, maxPakBytes: 1);
    lower.validate();
    const upper = PocketMemoryLimits(
      heapLimitBytes: _maxConfiguredHeap,
      maxPakBytes: _maxConfiguredPak,
    );
    upper.validate();
  });

  test(
    'recording preserves memory limits and asset hashes through import/replay',
    () async {
      final memoryLimits = const PocketMemoryLimits(
        heapLimitBytes: _thirtyTwoMiB,
        maxPakBytes: 32,
      );
      final pak = _emptyPak();
      final controller = PocketRecordingController(
        retainReplayAssets: true,
        maxEntries: 32,
        maxBytes: 128 * 1024,
      );
      final runtime = FfiPocketRuntime.open(
        width: 320,
        height: 480,
        recording: controller,
        memoryLimits: memoryLimits,
      );
      try {
        expect(runtime.load(_recordingSource, pak).ops, isNotEmpty);
        expect(runtime.frameAt(16).ops, isNotEmpty);
      } finally {
        runtime.dispose();
      }

      final recording = controller.finish();
      expect(recording.incomplete, isFalse);
      expect(recording.metadata.memoryLimits, memoryLimits);
      expect(
        recording.metadata.contentHashes['source'],
        pocketSha256(utf8.encode(_recordingSource)),
      );
      expect(recording.metadata.contentHashes['pak'], pocketSha256(pak));
      expect(
        controller.replayAssets.byHash,
        containsPair(pocketSha256(utf8.encode(_recordingSource)), isNotNull),
      );
      expect(
        controller.replayAssets.byHash,
        containsPair(pocketSha256(pak), isNotNull),
      );

      final imported = PocketRecording.fromJsonString(recording.toJsonString());
      expect(imported.metadata.memoryLimits, memoryLimits);
      expect(
        imported.metadata.toJson()['memory'],
        equals(<String, int>{
          'heapLimitBytes': _thirtyTwoMiB,
          'maxPakBytes': 32,
        }),
      );
      expect(
        imported.metadata.contentHashes,
        equals(recording.metadata.contentHashes),
      );

      final replay = await replayPocketRecording(
        imported,
        assets: PocketReplayAssets(
          source: _recordingSource,
          pak: pak,
          byHash: controller.replayAssets.byHash,
          byKey: controller.replayAssets.byKey,
        ),
      );
      expect(replay.replayable, isTrue, reason: jsonEncode(replay.toJson()));
      expect(replay.matched, isTrue, reason: jsonEncode(replay.toJson()));
      expect(replay.firstMismatch, isNull);

      void expectMemoryMismatch(PocketReplayResult result) {
        expect(result.matched, isFalse, reason: jsonEncode(result.toJson()));
        expect(result.replayable, isTrue, reason: jsonEncode(result.toJson()));
        expect(result.entriesReplayed, 0);
        expect(result.framesCompared, 0);
        expect(result.firstMismatch?.transaction, 'runtime.open');
        expect(result.firstMismatch?.reason, 'runtime memory limits mismatch');
      }

      const differentMemoryLimits = PocketMemoryLimits(
        heapLimitBytes: _thirtyTwoMiB,
        maxPakBytes: 64,
      );
      final factoryMismatch = await replayPocketRecording(
        imported,
        assets: PocketReplayAssets(
          source: _recordingSource,
          pak: pak,
          byHash: controller.replayAssets.byHash,
          byKey: controller.replayAssets.byKey,
        ),
        runtimeFactory: (metadata) => FfiPocketRuntime.open(
          width: metadata.width,
          height: metadata.height,
          rasterDensity: metadata.density,
          tickHz: metadata.tickHz,
          memoryLimits: differentMemoryLimits,
        ),
      );
      expectMemoryMismatch(factoryMismatch);

      final emptyMetadataJson =
          jsonDecode(imported.toJsonString()) as Map<String, dynamic>;
      final emptyMetadata = Map<String, dynamic>.from(
        emptyMetadataJson['metadata'] as Map,
      )..remove('memory');
      emptyMetadataJson['metadata'] = emptyMetadata;
      final emptyMetadataRecording = PocketRecording.fromJson(
        emptyMetadataJson,
      );
      final emptyMetadataMismatch = await replayPocketRecording(
        emptyMetadataRecording,
        assets: PocketReplayAssets(
          source: _recordingSource,
          pak: pak,
          byHash: controller.replayAssets.byHash,
          byKey: controller.replayAssets.byKey,
        ),
        runtimeFactory: (metadata) => FfiPocketRuntime.open(
          width: metadata.width,
          height: metadata.height,
          rasterDensity: metadata.density,
          tickHz: metadata.tickHz,
          memoryLimits: differentMemoryLimits,
        ),
      );
      expectMemoryMismatch(emptyMetadataMismatch);
    },
    skip: skipWithoutNative,
  );
}
