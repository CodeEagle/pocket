import 'dart:convert';
import 'pocket_memory_limits.dart';
import 'dart:typed_data';

const int pocketRecordingSchemaVersion = 2;
const String pocketRecordingSchema = 'pocket.runtime.recording';
const int pocketRecordingDefaultMaxEntries = 8192;
const int pocketRecordingDefaultMaxBytes = 8 * 1024 * 1024;
const int pocketRecordingMaxTraceLaneEvents = 8192;
const int pocketRecordingMaxTraceLaneBytes = 8 * 1024 * 1024;

final class PocketRecordingFormatException extends FormatException {
  const PocketRecordingFormatException(
    super.message, [
    super.source,
    super.offset,
  ]);
}

/// Immutable 21-slot host font metrics snapshot captured in recording metadata
/// so deterministic replay reproduces exact layout without reading OS fonts.
final class PocketHostFontMetricsSnapshot {
  PocketHostFontMetricsSnapshot({
    required Iterable<double> lineHeights,
    required Iterable<double> cjkAdvances,
    required Iterable<double> asciiAdvances,
  }) : lineHeights = List<double>.unmodifiable(lineHeights),
       cjkAdvances = List<double>.unmodifiable(cjkAdvances),
       asciiAdvances = List<double>.unmodifiable(asciiAdvances) {
    if (this.lineHeights.length != 21 ||
        this.cjkAdvances.length != 21 ||
        this.asciiAdvances.length != 21 * 95) {
      throw const PocketRecordingFormatException(
        'metadata.hostFonts must have 21 lineHeights, 21 cjkAdvances, and 1995 asciiAdvances',
      );
    }
    for (final value in this.lineHeights) {
      if (!value.isFinite || value <= 0) {
        throw const PocketRecordingFormatException(
          'metadata.hostFonts.lineHeights must be finite and positive',
        );
      }
    }
    for (final value in this.cjkAdvances) {
      if (!value.isFinite || value <= 0) {
        throw const PocketRecordingFormatException(
          'metadata.hostFonts.cjkAdvances must be finite and positive',
        );
      }
    }
    for (final value in this.asciiAdvances) {
      if (!value.isFinite || value < 0) {
        throw const PocketRecordingFormatException(
          'metadata.hostFonts.asciiAdvances must be finite and non-negative',
        );
      }
    }
  }

  factory PocketHostFontMetricsSnapshot.fromJson(Object? value) {
    final map = _object(value, 'metadata.hostFonts');
    _requireKeys(map, const <String>{
      'lineHeights',
      'cjkAdvances',
      'asciiAdvances',
    }, 'metadata.hostFonts');
    _expectKeys(map, const <String>{
      'lineHeights',
      'cjkAdvances',
      'asciiAdvances',
    }, 'metadata.hostFonts');
    List<double> numList(Object? raw, String field) {
      if (raw is! List) {
        throw PocketRecordingFormatException('$field must be an array');
      }
      return raw
          .map((item) => _finiteNumber(item, field))
          .toList(growable: false);
    }

    return PocketHostFontMetricsSnapshot(
      lineHeights: numList(map['lineHeights'], 'metadata.hostFonts.lineHeights'),
      cjkAdvances: numList(map['cjkAdvances'], 'metadata.hostFonts.cjkAdvances'),
      asciiAdvances: numList(
        map['asciiAdvances'],
        'metadata.hostFonts.asciiAdvances',
      ),
    );
  }

  final List<double> lineHeights;
  final List<double> cjkAdvances;
  final List<double> asciiAdvances;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'lineHeights': lineHeights,
    'cjkAdvances': cjkAdvances,
    'asciiAdvances': asciiAdvances,
  };
}

/// Dimensions and build identity attached to a runtime recording.
final class PocketRecordingMetadata {
  PocketRecordingMetadata({
    required this.width,
    required this.height,
    required this.density,
    required this.tickHz,
    this.engineAbi,
    this.memoryLimits = const PocketMemoryLimits(),
    this.hostFonts,
    Map<String, String> contentHashes = const <String, String>{},
  }) : contentHashes = Map<String, String>.unmodifiable(
         Map<String, String>.from(contentHashes),
       ) {
    memoryLimits.validate();
    _validateFinite(width, 'metadata.width');
    _validateFinite(height, 'metadata.height');
    if (width <= 0 || height <= 0) {
      throw PocketRecordingFormatException(
        'metadata width and height must be positive',
      );
    }
    if (density < 1 || density > 4) {
      throw PocketRecordingFormatException('metadata.density must be 1..4');
    }
    if (tickHz < 1 || tickHz > 120) {
      throw PocketRecordingFormatException('metadata.tickHz must be 1..120');
    }
    if (engineAbi != null && engineAbi!.length > 4096) {
      throw PocketRecordingFormatException('metadata.engineAbi is too long');
    }
    for (final entry in this.contentHashes.entries) {
      _validateSha256(entry.value, 'metadata.contentHashes.${entry.key}');
    }
  }

  factory PocketRecordingMetadata.fromJson(Object? value) {
    final map = _object(value, 'metadata');
    _requireKeys(map, const <String>{
      'width',
      'height',
      'density',
      'tickHz',
      'engineAbi',
      'contentHashes',
    }, 'metadata');
    _expectKeys(map, const <String>{
      'width',
      'height',
      'density',
      'tickHz',
      'engineAbi',
      'contentHashes',
      'memory',
      'hostFonts',
    }, 'metadata');
    final engineAbi = map['engineAbi'];
    if (engineAbi != null && engineAbi is! String) {
      throw PocketRecordingFormatException('metadata.engineAbi must be string');
    }
    final hashes = _object(map['contentHashes'], 'metadata.contentHashes');
    final contentHashes = <String, String>{};
    for (final entry in hashes.entries) {
      if (entry.key.isEmpty ||
          entry.key.length > 128 ||
          entry.value is! String) {
        throw PocketRecordingFormatException(
          'metadata.contentHashes has an invalid entry',
        );
      }
      contentHashes[entry.key] = entry.value as String;
    }
    return PocketRecordingMetadata(
      width: _finiteNumber(map['width'], 'metadata.width'),
      height: _finiteNumber(map['height'], 'metadata.height'),
      density: _integer(map['density'], 'metadata.density'),
      tickHz: _integer(map['tickHz'], 'metadata.tickHz'),
      engineAbi: engineAbi as String?,
      contentHashes: contentHashes,
      memoryLimits: map.containsKey('memory')
          ? PocketMemoryLimits.fromJson(map['memory'])
          : const PocketMemoryLimits(),
      hostFonts: map['hostFonts'] == null
          ? null
          : PocketHostFontMetricsSnapshot.fromJson(map['hostFonts']),
    );
  }

  final double width;
  final double height;
  final int density;
  final int tickHz;
  final String? engineAbi;
  final PocketMemoryLimits memoryLimits;
  final PocketHostFontMetricsSnapshot? hostFonts;
  final Map<String, String> contentHashes;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'width': width,
    'height': height,
    'density': density,
    'tickHz': tickHz,
    'engineAbi': engineAbi,
    'contentHashes': contentHashes,
    if (!memoryLimits.isEmpty) 'memory': memoryLimits.toJson(),
    if (hostFonts != null) 'hostFonts': hostFonts!.toJson(),
  };
}

/// One host transaction. Asset bytes are represented by hash/length
/// descriptors; only fixed-size duplex records are retained as replay inputs.
final class PocketRecordingEntry {
  PocketRecordingEntry({
    required this.index,
    required this.kind,
    Map<String, dynamic> args = const <String, dynamic>{},
    Map<String, dynamic> result = const <String, dynamic>{},
    Map<String, dynamic>? error,
  }) : args = _freezeObject(args, 'entry.args') as Map<String, dynamic>,
       result = _freezeRecordingResult(result),
       error = error == null
           ? null
           : _freezeObject(error, 'entry.error') as Map<String, dynamic> {
    if (index < 0) {
      throw PocketRecordingFormatException('entry.index must be non-negative');
    }
    if (kind.isEmpty || kind.length > 96 || !_entryKinds.contains(kind)) {
      throw PocketRecordingFormatException(
        'unknown recording entry kind: $kind',
      );
    }
    if (error != null) _validateError(error);
    _validateRecordingEntry(kind, this.args, this.result, this.error);
  }

  factory PocketRecordingEntry.fromJson(Object? value) {
    final map = _object(value, 'entry');
    _requireKeys(map, const <String>{
      'index',
      'kind',
      'args',
      'result',
      'error',
    }, 'entry');
    _expectKeys(map, const <String>{
      'index',
      'kind',
      'args',
      'result',
      'error',
    }, 'entry');
    final rawError = map['error'];
    if (rawError != null && rawError is! Map) {
      throw PocketRecordingFormatException(
        'entry.error must be an object or null',
      );
    }
    return PocketRecordingEntry(
      index: _integer(map['index'], 'entry.index'),
      kind: _string(map['kind'], 'entry.kind', maxLength: 96),
      args: _object(map['args'], 'entry.args'),
      result: _object(map['result'], 'entry.result'),
      error: rawError == null
          ? null
          : Map<String, dynamic>.from(_object(rawError, 'entry.error')),
    );
  }

  final int index;
  final String kind;
  final Map<String, dynamic> args;
  final Map<String, dynamic> result;
  final Map<String, dynamic>? error;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'index': index,
    'kind': kind,
    'args': args,
    'result': result,
    'error': error,
  };

  PocketRecordingEntry withIndex(int nextIndex) => PocketRecordingEntry(
    index: nextIndex,
    kind: kind,
    args: args,
    result: result,
    error: error,
  );
}

const Set<String> _entryKinds = <String>{
  'eval',
  'load',
  'loadBytecode',
  'loadFiles',
  'loadBytecodeFiles',
  'frame',
  'frameDelta',
  'send',
  'resize',
  'auxiliary',
  'compositor',
  'schedulerPause',
  'duplexIngressPublish',
  'duplexStep',
  'duplexEgressPeek',
  'duplexEgressConsume',
  'offloadConfigure',
  'workerConfigure',
  'externalWork',
  'captureStop',
  'asyncStop',
};

/// A complete bounded host trace.
final class PocketRecording {
  PocketRecording({
    required this.metadata,
    required List<PocketRecordingEntry> entries,
    required this.maxEntries,
    required this.maxBytes,
    required this.bytes,
    required this.incomplete,
    this.version = 1,
    this.incompleteReason,
  }) : entries = List<PocketRecordingEntry>.unmodifiable(entries) {
    if (version < 1 || version > pocketRecordingSchemaVersion) {
      throw PocketRecordingFormatException('unsupported recording version');
    }
    if (maxEntries < 1 ||
        maxEntries > 64 * 1024 * 1024 ||
        maxBytes < 1 ||
        maxBytes > 64 * 1024 * 1024) {
      throw PocketRecordingFormatException('recording limits must be positive');
    }
    if (bytes < 0 || bytes > maxBytes) {
      throw PocketRecordingFormatException('recording byte count is invalid');
    }
    if (!incomplete && incompleteReason != null) {
      throw PocketRecordingFormatException(
        'complete recording cannot have incompleteReason',
      );
    }
    if (this.entries.length > maxEntries) {
      throw PocketRecordingFormatException('recording has too many entries');
    }
    for (var index = 0; index < this.entries.length; index++) {
      if (this.entries[index].index != index) {
        throw PocketRecordingFormatException(
          'recording entry indexes are not contiguous',
        );
      }
    }
    if (version == 1 && this.entries.any(_entryRequiresRecordingV2)) {
      throw PocketRecordingFormatException(
        'recording version 1 cannot contain Worker or offload lanes',
      );
    }
    var workerEvents = 0;
    var offloadEvents = 0;
    var workerEventBytes = 0;
    var offloadEventBytes = 0;
    for (final entry in this.entries) {
      final traceClock = entry.result['traceClock'];
      if (traceClock is Map) {
        final workerLane = traceClock['workerEvents'] as List?;
        final offloadLane = traceClock['offloadEvents'] as List?;
        workerEvents += workerLane?.length ?? 0;
        offloadEvents += offloadLane?.length ?? 0;
        workerEventBytes += _traceEventBytes(workerLane);
        offloadEventBytes += _traceEventBytes(offloadLane);
      }
    }
    if (workerEvents + offloadEvents > pocketRecordingMaxTraceLaneEvents ||
        workerEventBytes + offloadEventBytes >
            pocketRecordingMaxTraceLaneBytes) {
      throw PocketRecordingFormatException(
        'recording Worker or offload trace lane exceeds its bounds',
      );
    }
  }

  factory PocketRecording.fromJsonString(String source) {
    if (source.length > 64 * 1024 * 1024) {
      throw PocketRecordingFormatException('recording JSON is too large');
    }
    return PocketRecording.fromJson(jsonDecode(source));
  }

  factory PocketRecording.fromJson(Object? value) {
    final map = _object(value, 'recording');
    _requireKeys(map, const <String>{
      'schema',
      'version',
      'metadata',
      'limits',
      'bytes',
      'incomplete',
      'incompleteReason',
      'entries',
    }, 'recording');
    _expectKeys(map, const <String>{
      'schema',
      'version',
      'metadata',
      'limits',
      'bytes',
      'incomplete',
      'incompleteReason',
      'entries',
    }, 'recording');
    if (map['schema'] != pocketRecordingSchema) {
      throw PocketRecordingFormatException('unsupported recording schema');
    }
    final version = _integer(map['version'], 'recording.version');
    if (version < 1 || version > pocketRecordingSchemaVersion) {
      throw PocketRecordingFormatException('unsupported recording version');
    }
    final limits = _object(map['limits'], 'recording.limits');
    _requireKeys(limits, const <String>{
      'maxEntries',
      'maxBytes',
    }, 'recording.limits');
    _expectKeys(limits, const <String>{
      'maxEntries',
      'maxBytes',
    }, 'recording.limits');
    final rawEntries = map['entries'];
    if (rawEntries is! List) {
      throw PocketRecordingFormatException(
        'recording.entries must be an array',
      );
    }
    final entries = <PocketRecordingEntry>[];
    for (final entry in rawEntries) {
      entries.add(PocketRecordingEntry.fromJson(entry));
    }
    final incomplete = map['incomplete'];
    if (incomplete is! bool) {
      throw PocketRecordingFormatException(
        'recording.incomplete must be boolean',
      );
    }
    final reason = map['incompleteReason'];
    if (reason != null && reason is! String) {
      throw PocketRecordingFormatException(
        'recording.incompleteReason must be string or null',
      );
    }
    final recording = PocketRecording(
      metadata: PocketRecordingMetadata.fromJson(map['metadata']),
      entries: entries,
      maxEntries: _integer(limits['maxEntries'], 'recording.limits.maxEntries'),
      maxBytes: _integer(limits['maxBytes'], 'recording.limits.maxBytes'),
      bytes: _integer(map['bytes'], 'recording.bytes'),
      incomplete: incomplete,
      version: version,
      incompleteReason: reason as String?,
    );
    var measuredBytes = 0;
    for (final entry in recording.entries) {
      measuredBytes += utf8.encode(pocketCanonicalJson(entry.toJson())).length;
    }
    if (measuredBytes != recording.bytes) {
      throw PocketRecordingFormatException(
        'recording.bytes does not match entries',
      );
    }
    return recording;
  }

  final PocketRecordingMetadata metadata;
  final List<PocketRecordingEntry> entries;
  final int maxEntries;
  final int maxBytes;
  final int bytes;
  final bool incomplete;
  final int version;
  final String? incompleteReason;

  bool get replayable => !incomplete && entries.isNotEmpty;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'schema': pocketRecordingSchema,
    'version': version,
    'metadata': metadata.toJson(),
    'limits': <String, dynamic>{'maxEntries': maxEntries, 'maxBytes': maxBytes},
    'bytes': bytes,
    'incomplete': incomplete,
    'incompleteReason': incompleteReason,
    'entries': entries.map((entry) => entry.toJson()).toList(growable: false),
  };

  String toJsonString() => pocketCanonicalJson(toJson());
}

/// Owns a bounded trace. Omitting a controller from [FfiPocketRuntime.open]
/// leaves the runtime's disabled path allocation-free.
final class PocketRecordingController {
  PocketRecordingController({
    this.enabled = true,
    int maxEntries = pocketRecordingDefaultMaxEntries,
    int maxBytes = pocketRecordingDefaultMaxBytes,
    this.retainReplayAssets = false,
    int maxAssetBytes = 16 * 1024 * 1024,
  }) : maxEntries = _positiveLimit(maxEntries, 'maxEntries'),
       maxBytes = _positiveLimit(maxBytes, 'maxBytes'),
       maxAssetBytes = _positiveLimit(maxAssetBytes, 'maxAssetBytes');

  final bool enabled;
  final int maxEntries;
  final int maxBytes;
  final bool retainReplayAssets;
  final int maxAssetBytes;

  PocketRecordingMetadata? _metadata;
  final List<PocketRecordingEntry> _entries = <PocketRecordingEntry>[];
  int _bytes = 0;
  String? _incompleteReason;
  bool _started = false;
  bool _finished = false;
  int _version = 1;
  int _asyncEventCount = 0;
  int _asyncEventBytes = 0;
  void Function()? _beforeFinish;
  PocketRecording? _recording;
  int _retainedAssetBytes = 0;
  final Map<String, Uint8List> _replayAssets = <String, Uint8List>{};

  bool get isStarted => _started;
  bool get isFinished => _finished;
  bool get isRecording => enabled && _started && !_finished && !isIncomplete;
  bool get isIncomplete => _incompleteReason != null;
  PocketRecording? get recording => _recording;
  int get entryCount => _entries.length;
  int get recordedBytes => _bytes;
  int get bytes => _bytes;
  int get retainedAssetBytes => _retainedAssetBytes;
  PocketReplayAssets get replayAssets => PocketReplayAssets(
    byKey: _replayAssets,
    byHash: <String, Uint8List>{
      for (final value in _replayAssets.values) pocketSha256(value): value,
    },
  );

  /// Runtime integrations call this before the first load transaction.
  void start(PocketRecordingMetadata metadata) {
    if (!enabled) return;
    if (_started || _finished) {
      throw StateError('Pocket recording controller has already started');
    }
    _metadata = metadata;
    _started = true;
  }

  /// Installs the single native boundary needed to freeze an active trace.
  /// Product-level stop policy remains with the embedding host.
  void bindBeforeFinish(void Function() boundary) {
    if (!_started || _finished) {
      throw StateError('Pocket recording controller is not active');
    }
    if (_beforeFinish != null) {
      throw StateError('Pocket recording controller already has a runtime');
    }
    _beforeFinish = boundary;
  }

  /// Detaches a native boundary before its runtime handle is destroyed.
  void clearBeforeFinish() {
    _beforeFinish = null;
  }

  void add(PocketRecordingEntry entry) {
    if (!enabled || !_started || _finished || _incompleteReason != null) return;
    if (_entries.length >= maxEntries) {
      _incompleteReason = 'maxEntries exceeded';
      return;
    }
    final indexed = entry.withIndex(_entries.length);
    final entryBytes = utf8
        .encode(pocketCanonicalJson(indexed.toJson()))
        .length;
    if (entryBytes > maxBytes - _bytes) {
      _incompleteReason = 'maxBytes exceeded';
      return;
    }
    final traceClock = indexed.result['traceClock'];
    var workerEvents = 0;
    var offloadEvents = 0;
    var workerEventBytes = 0;
    var offloadEventBytes = 0;
    if (traceClock is Map) {
      final workerLane = traceClock['workerEvents'] as List?;
      final offloadLane = traceClock['offloadEvents'] as List?;
      workerEvents = workerLane?.length ?? 0;
      offloadEvents = offloadLane?.length ?? 0;
      workerEventBytes = _traceEventBytes(workerLane);
      offloadEventBytes = _traceEventBytes(offloadLane);
    }
    if (_asyncEventCount + workerEvents + offloadEvents >
            pocketRecordingMaxTraceLaneEvents ||
        _asyncEventBytes + workerEventBytes + offloadEventBytes >
            pocketRecordingMaxTraceLaneBytes) {
      _incompleteReason = 'Worker or offload trace lane exceeded its limit';
      return;
    }
    _entries.add(indexed);
    _bytes += entryBytes;
    _asyncEventCount += workerEvents + offloadEvents;
    _asyncEventBytes += workerEventBytes + offloadEventBytes;
    if (_entryRequiresRecordingV2(indexed)) _version = 2;
  }

  void setContentHash(String name, String sha256) {
    if (!enabled || !_started || _finished || _metadata == null) return;
    _validateSha256(sha256, 'content hash');
    final hashes = <String, String>{..._metadata!.contentHashes, name: sha256};
    _metadata = PocketRecordingMetadata(
      width: _metadata!.width,
      height: _metadata!.height,
      density: _metadata!.density,
      tickHz: _metadata!.tickHz,
      engineAbi: _metadata!.engineAbi,
      contentHashes: hashes,
      memoryLimits: _metadata!.memoryLimits,
      hostFonts: _metadata!.hostFonts,
    );
  }

  void setHostFonts(PocketHostFontMetricsSnapshot hostFonts) {
    if (!enabled || !_started || _finished || _metadata == null) return;
    _metadata = PocketRecordingMetadata(
      width: _metadata!.width,
      height: _metadata!.height,
      density: _metadata!.density,
      tickHz: _metadata!.tickHz,
      engineAbi: _metadata!.engineAbi,
      contentHashes: _metadata!.contentHashes,
      memoryLimits: _metadata!.memoryLimits,
      hostFonts: hostFonts,
    );
  }

  /// Retains an independently owned asset for replay without embedding it in
  /// JSON. The quota is separate from the trace byte quota and a breach marks
  /// the recording incomplete, so a caller cannot accidentally export a tape
  /// that it cannot replay.
  void retainAsset(String key, Uint8List bytes) {
    if (!enabled || !_started || _finished || !retainReplayAssets) return;
    if (_replayAssets.containsKey(key)) return;
    if (bytes.length > maxAssetBytes - _retainedAssetBytes) {
      _incompleteReason ??= 'maxAssetBytes exceeded';
      return;
    }
    _replayAssets[key] = Uint8List.fromList(bytes);
    _retainedAssetBytes += bytes.length;
  }

  /// Marks a trace unusable while allowing the runtime operation itself to
  /// preserve its native error/return semantics.
  void markIncomplete(String reason) {
    if (!enabled || !_started || _finished) return;
    _incompleteReason ??= reason;
  }

  /// Returns a consistent point-in-time artifact while keeping the live
  /// controller open. [stop] is the terminal form.
  PocketRecording snapshot() {
    if (_recording != null) return _recording!;
    if (!enabled || !_started || _metadata == null) {
      throw StateError(
        'Pocket recording controller was not attached to a runtime',
      );
    }
    return PocketRecording(
      metadata: _metadata!,
      entries: _entries,
      maxEntries: maxEntries,
      maxBytes: maxBytes,
      bytes: _bytes,
      incomplete: _incompleteReason != null,
      version: _version,
      incompleteReason: _incompleteReason,
    );
  }

  PocketRecording finish() {
    if (_recording != null) return _recording!;
    if (!enabled) {
      throw StateError('disabled PocketRecordingController has no recording');
    }
    if (!_started || _metadata == null) {
      throw StateError(
        'Pocket recording controller was not attached to a runtime',
      );
    }
    final beforeFinish = _beforeFinish;
    _beforeFinish = null;
    if (beforeFinish != null) {
      try {
        beforeFinish();
      } on Object catch (error) {
        _incompleteReason ??= 'recording finish boundary failed: $error';
      }
    }
    _finished = true;
    _recording = PocketRecording(
      metadata: _metadata!,
      entries: _entries,
      maxEntries: maxEntries,
      maxBytes: maxBytes,
      bytes: _bytes,
      incomplete: _incompleteReason != null,
      version: _version,
      incompleteReason: _incompleteReason,
    );
    return _recording!;
  }

  PocketRecording stop() => finish();
}

/// Assets supplied to an offline replay. File paths from a tape are never
/// opened; callers resolve opaque keys or SHA-256 descriptors to bytes.
final class PocketReplayAssets {
  PocketReplayAssets({
    this.source,
    Uint8List? bytecode,
    Uint8List? pak,
    Map<String, Uint8List> byHash = const <String, Uint8List>{},
    Map<String, Uint8List> byKey = const <String, Uint8List>{},
    this.resolver,
  }) : bytecode = bytecode == null ? null : Uint8List.fromList(bytecode),
       pak = pak == null ? null : Uint8List.fromList(pak),
       byHash = _copyBytesMap(byHash),
       byKey = _copyBytesMap(byKey);

  final String? source;
  final Uint8List? bytecode;
  final Uint8List? pak;
  final Map<String, Uint8List> byHash;
  final Map<String, Uint8List> byKey;
  final Uint8List? Function(String key, String? expectedSha256)? resolver;

  Uint8List? resolve({String? key, String? sha256}) {
    if (sha256 != null) {
      final byDigest = byHash[sha256];
      if (byDigest != null) return Uint8List.fromList(byDigest);
    }
    if (key != null) {
      final byOpaqueKey = byKey[key];
      if (byOpaqueKey != null) return Uint8List.fromList(byOpaqueKey);
      final resolved = resolver?.call(key, sha256);
      if (resolved != null) return Uint8List.fromList(resolved);
    }
    return null;
  }
}

final class PocketReplayMismatch {
  const PocketReplayMismatch({
    required this.entryIndex,
    required this.transaction,
    required this.reason,
    this.frameIndex,
    this.expected,
    this.actual,
  });

  final int entryIndex;
  final String transaction;
  final String reason;
  final int? frameIndex;
  final Object? expected;
  final Object? actual;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'entryIndex': entryIndex,
    'transaction': transaction,
    'frameIndex': frameIndex,
    'reason': reason,
    'expected': expected,
    'actual': actual,
  };

  @override
  String toString() =>
      'PocketReplayMismatch(entry=$entryIndex, $transaction: $reason)';
}

final class PocketReplayResult {
  const PocketReplayResult({
    required this.matched,
    required this.replayable,
    required this.entriesReplayed,
    required this.framesCompared,
    this.firstMismatch,
    this.rejection,
  });

  final bool matched;
  final bool replayable;
  final int entriesReplayed;
  final int framesCompared;
  final PocketReplayMismatch? firstMismatch;
  final String? rejection;
  bool get rejected => !replayable;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'matched': matched,
    'replayable': replayable,
    'entriesReplayed': entriesReplayed,
    'framesCompared': framesCompared,
    'firstMismatch': firstMismatch?.toJson(),
    'rejection': rejection,
  };
}

/// Deterministic JSON used for trace accounting and frame/resource digests.
String pocketCanonicalJson(Object? value) {
  final output = StringBuffer();
  _writeCanonicalJson(output, value, 0);
  return output.toString();
}

/// Validates and freezes the trace envelope attached to a host transaction.
/// Version 1 is the original pure UI clock lane. Version 2 adds optional
/// Worker and offload fact lanes while keeping those older archives readable.
Map<String, dynamic> pocketValidateTraceClockEnvelope(Object? value) {
  if (value is! Map) {
    throw const PocketRecordingFormatException(
      'trace clock envelope must be object',
    );
  }
  final map = _object(value, 'trace clock envelope');
  final version = map['version'];
  final isLegacy = version == null;
  if (isLegacy) {
    _expectKeys(map, const <String>{'idleMs', 'scalars'}, 'trace clock');
    _requireKeys(map, const <String>{'idleMs', 'scalars'}, 'trace clock');
  } else {
    if (version != 2) {
      throw const PocketRecordingFormatException(
        'unsupported trace clock envelope version',
      );
    }
    _expectKeys(map, const <String>{
      'version',
      'idleMs',
      'scalars',
      'workerEvents',
      'offloadEvents',
    }, 'trace clock');
    _requireKeys(map, const <String>{
      'version',
      'idleMs',
      'scalars',
    }, 'trace clock');
  }
  final idle = map['idleMs'];
  final scalars = map['scalars'];
  if (idle is! List || scalars is! List) {
    throw const PocketRecordingFormatException(
      'trace clock envelope arrays are required',
    );
  }
  if (idle.length > 1 << 16 || scalars.length > 1 << 16) {
    throw const PocketRecordingFormatException(
      'trace clock envelope is too large',
    );
  }
  final idleValues = <num>[];
  for (final item in idle) {
    if (item is! num || !item.isFinite || item < 0) {
      throw const PocketRecordingFormatException(
        'trace clock idleMs value is invalid',
      );
    }
    idleValues.add(item);
  }
  final scalarValues = <Map<String, dynamic>>[];
  for (final item in scalars) {
    if (item is! Map) {
      throw const PocketRecordingFormatException(
        'trace clock scalar is invalid',
      );
    }
    final scalar = _object(item, 'trace clock scalar');
    if (scalar.length != 2 ||
        scalar['kind'] is! String ||
        scalar['value'] is! num) {
      throw const PocketRecordingFormatException(
        'trace clock scalar shape is invalid',
      );
    }
    final scalarValue = scalar['value'] as num;
    final kind = scalar['kind'] as String;
    if (!scalarValue.isFinite || kind.length > 32) {
      throw const PocketRecordingFormatException(
        'trace clock scalar value is invalid',
      );
    }
    if (kind != 'dateNow' &&
        kind != 'mathRandom' &&
        kind != 'performanceNow' &&
        kind != 'hostTextAdvance') {
      throw const PocketRecordingFormatException(
        'trace clock scalar kind is invalid',
      );
    }
    if (kind == 'hostTextAdvance' && scalarValue < 0) {
      throw const PocketRecordingFormatException(
        'trace clock hostTextAdvance scalar must be non-negative',
      );
    }
    scalarValues.add(<String, dynamic>{'kind': kind, 'value': scalarValue});
  }

  final result = <String, dynamic>{
    if (!isLegacy) 'version': 2,
    'idleMs': idleValues,
    'scalars': scalarValues,
  };
  var laneBytes = 0;
  for (final lane in const <String>['workerEvents', 'offloadEvents']) {
    if (!map.containsKey(lane)) continue;
    final events = map[lane];
    if (events is! List || events.length > pocketRecordingMaxTraceLaneEvents) {
      throw PocketRecordingFormatException(
        'trace clock $lane must be a bounded array',
      );
    }
    var previousSequence = -1;
    final frozenEvents = <Map<String, dynamic>>[];
    for (final value in events) {
      if (value is! Map) {
        throw PocketRecordingFormatException(
          'trace clock $lane event must be an object',
        );
      }
      final event = _object(value, 'trace clock $lane event');
      _requireKeys(event, const <String>{
        'seq',
        'session',
        'kind',
        'data',
      }, 'trace clock $lane event');
      _expectKeys(event, const <String>{
        'seq',
        'session',
        'kind',
        'data',
      }, 'trace clock $lane event');
      final sequence = event['seq'];
      if (sequence is! int ||
          sequence < 0 ||
          sequence > 0x7fffffffffffffff ||
          sequence <= previousSequence) {
        throw PocketRecordingFormatException(
          'trace clock $lane event sequence is invalid',
        );
      }
      previousSequence = sequence;
      final session = _string(
        event['session'],
        'trace clock $lane event session',
        maxLength: 256,
      );
      final kind = _string(
        event['kind'],
        'trace clock $lane event kind',
        maxLength: 96,
      );
      if (session.isEmpty || kind.isEmpty || event['data'] is! Map) {
        throw PocketRecordingFormatException(
          'trace clock $lane event fields are invalid',
        );
      }
      final data =
          _freezeObject(
                _object(event['data'], 'trace clock $lane event data'),
                'trace clock $lane event data',
              )
              as Map<String, dynamic>;
      final frozen = <String, dynamic>{
        'seq': sequence,
        'session': session,
        'kind': kind,
        'data': data,
      };
      final eventBytes = utf8.encode(pocketCanonicalJson(frozen)).length;
      if (eventBytes > 16 * 1024 ||
          laneBytes > pocketRecordingMaxTraceLaneBytes - eventBytes) {
        throw PocketRecordingFormatException(
          'trace clock $lane exceeds its event byte limit',
        );
      }
      laneBytes += eventBytes;
      frozenEvents.add(Map<String, dynamic>.unmodifiable(frozen));
    }
    result[lane] = List<Map<String, dynamic>>.unmodifiable(frozenEvents);
  }
  return Map<String, dynamic>.unmodifiable(result);
}

int _traceEventBytes(List? events) {
  if (events == null) return 0;
  var total = 0;
  for (final event in events) {
    total += utf8.encode(pocketCanonicalJson(event)).length;
  }
  return total;
}

void _writeCanonicalJson(StringBuffer output, Object? value, int depth) {
  if (depth > 32)
    throw PocketRecordingFormatException('JSON nesting is too deep');
  if (value == null) {
    output.write('null');
  } else if (value is bool) {
    output.write(value ? 'true' : 'false');
  } else if (value is String) {
    if (value.length > 4 * 1024 * 1024) {
      throw PocketRecordingFormatException('JSON string is too long');
    }
    output.write(jsonEncode(value));
  } else if (value is int) {
    output.write(value);
  } else if (value is double) {
    if (!value.isFinite)
      throw PocketRecordingFormatException('JSON number is not finite');
    output.write(
      value == 0 ? (value.isNegative ? '-0.0' : '0') : value.toString(),
    );
  } else if (value is num) {
    if (!value.isFinite)
      throw PocketRecordingFormatException('JSON number is not finite');
    output.write(value.toString());
  } else if (value is Map) {
    final entries = <List<Object?>>[];
    for (final item in value.entries) {
      if (item.key is! String) {
        throw PocketRecordingFormatException(
          'JSON object keys must be strings',
        );
      }
      entries.add(<Object?>[item.key as String, item.value]);
    }
    entries.sort((a, b) => (a[0]! as String).compareTo(b[0]! as String));
    output.write('{');
    for (var index = 0; index < entries.length; index++) {
      if (index > 0) output.write(',');
      output.write(jsonEncode(entries[index][0]));
      output.write(':');
      _writeCanonicalJson(output, entries[index][1], depth + 1);
    }
    output.write('}');
  } else if (value is Iterable) {
    output.write('[');
    var index = 0;
    for (final item in value) {
      if (index++ > 0) output.write(',');
      _writeCanonicalJson(output, item, depth + 1);
    }
    output.write(']');
  } else {
    throw PocketRecordingFormatException(
      'unsupported JSON value: ${value.runtimeType}',
    );
  }
}

/// Compact pure-Dart SHA-256. Keeping this here avoids making the Flutter
/// renderer depend on a package used only by the service layer.
String pocketSha256(List<int> bytes) {
  final bitLength = bytes.length * 8;
  final padded = <int>[...bytes, 0x80];
  while (padded.length % 64 != 56) padded.add(0);
  for (var shift = 56; shift >= 0; shift -= 8)
    padded.add((bitLength >> shift) & 0xff);
  var h0 = 0x6a09e667;
  var h1 = 0xbb67ae85;
  var h2 = 0x3c6ef372;
  var h3 = 0xa54ff53a;
  var h4 = 0x510e527f;
  var h5 = 0x9b05688c;
  var h6 = 0x1f83d9ab;
  var h7 = 0x5be0cd19;
  const k = <int>[
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  ];
  const mask = 0xffffffff;
  int rotr(int value, int bits) =>
      ((value >> bits) | (value << (32 - bits))) & mask;
  int add32(Iterable<int> values) =>
      values.fold<int>(0, (sum, item) => (sum + item) & mask);
  for (var offset = 0; offset < padded.length; offset += 64) {
    final words = List<int>.filled(64, 0);
    for (var index = 0; index < 16; index++) {
      final start = offset + index * 4;
      words[index] =
          (padded[start] << 24) |
          (padded[start + 1] << 16) |
          (padded[start + 2] << 8) |
          padded[start + 3];
    }
    for (var index = 16; index < 64; index++) {
      final word15 = words[index - 15];
      final word2 = words[index - 2];
      final s0 = rotr(word15, 7) ^ rotr(word15, 18) ^ (word15 >> 3);
      final s1 = rotr(word2, 17) ^ rotr(word2, 19) ^ (word2 >> 10);
      words[index] = add32(<int>[words[index - 16], s0, words[index - 7], s1]);
    }
    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;
    var f = h5;
    var g = h6;
    var h = h7;
    for (var index = 0; index < 64; index++) {
      final s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      final ch = (e & f) ^ ((~e) & g);
      final temp1 = add32(<int>[h, s1, ch, k[index], words[index]]);
      final s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final temp2 = add32(<int>[s0, maj]);
      h = g;
      g = f;
      f = e;
      e = add32(<int>[d, temp1]);
      d = c;
      c = b;
      b = a;
      a = add32(<int>[temp1, temp2]);
    }
    h0 = add32(<int>[h0, a]);
    h1 = add32(<int>[h1, b]);
    h2 = add32(<int>[h2, c]);
    h3 = add32(<int>[h3, d]);
    h4 = add32(<int>[h4, e]);
    h5 = add32(<int>[h5, f]);
    h6 = add32(<int>[h6, g]);
    h7 = add32(<int>[h7, h]);
  }
  final output = StringBuffer();
  for (final word in <int>[h0, h1, h2, h3, h4, h5, h6, h7]) {
    output.write(word.toRadixString(16).padLeft(8, '0'));
  }
  return output.toString();
}

Map<String, dynamic> _object(Object? value, String field) {
  if (value is! Map)
    throw PocketRecordingFormatException('$field must be an object');
  for (final key in value.keys) {
    if (key is! String)
      throw PocketRecordingFormatException('$field has a non-string key');
  }
  return Map<String, dynamic>.from(value);
}

void _expectKeys(
  Map<String, dynamic> value,
  Set<String> allowed,
  String field,
) {
  for (final key in value.keys) {
    if (!allowed.contains(key))
      throw PocketRecordingFormatException('$field contains unknown key $key');
  }
}

void _requireKeys(
  Map<String, dynamic> value,
  Set<String> required,
  String field,
) {
  for (final key in required) {
    if (!value.containsKey(key)) {
      throw PocketRecordingFormatException(
        '$field is missing required key $key',
      );
    }
  }
}

Map<String, dynamic> _freezeRecordingResult(Map<String, dynamic> value) {
  final frozen = _freezeObject(value, 'entry.result') as Map<String, dynamic>;
  if (!frozen.containsKey('traceClock')) return frozen;
  final result = Map<String, dynamic>.from(frozen);
  result['traceClock'] = pocketValidateTraceClockEnvelope(frozen['traceClock']);
  return Map<String, dynamic>.unmodifiable(result);
}

void _validateRecordingEntry(
  String kind,
  Map<String, dynamic> args,
  Map<String, dynamic> result,
  Map<String, dynamic>? error,
) {
  switch (kind) {
    case 'workerConfigure':
      _expectKeys(args, const <String>{
        'workerBytecode',
        'config',
        'configSha256',
      }, 'workerConfigure.args');
      _requireKeys(args, const <String>{
        'workerBytecode',
        'config',
        'configSha256',
      }, 'workerConfigure.args');
      _validateAssetDescriptor(
        args['workerBytecode'],
        'workerConfigure.bytecode',
      );
      final config = _object(args['config'], 'workerConfigure.config');
      const configKeys = <String>{
        'protocolVersion',
        'nativeGeneration',
        'bindingGeneration',
        'tickHz',
        'expectedRuntimeAbi',
        'declaration',
        'policy',
        'limits',
      };
      _expectKeys(config, configKeys, 'workerConfigure.config');
      _requireKeys(config, configKeys, 'workerConfigure.config');
      for (final field in const <String>[
        'protocolVersion',
        'nativeGeneration',
        'bindingGeneration',
        'tickHz',
      ]) {
        _validateBoundedInteger(config[field], 'workerConfigure.config.$field');
      }
      _string(
        config['expectedRuntimeAbi'],
        'workerConfigure.config.expectedRuntimeAbi',
        maxLength: 4096,
      );
      _object(config['declaration'], 'workerConfigure.config.declaration');
      final policy = _object(config['policy'], 'workerConfigure.config.policy');
      _expectKeys(policy, const <String>{
        'requiredCapabilities',
        'allowedHttpOrigins',
      }, 'workerConfigure.config.policy');
      _requireKeys(policy, const <String>{
        'requiredCapabilities',
        'allowedHttpOrigins',
      }, 'workerConfigure.config.policy');
      _validateStringArray(
        policy['requiredCapabilities'],
        'workerConfigure.config.policy.requiredCapabilities',
      );
      _validateStringArray(
        policy['allowedHttpOrigins'],
        'workerConfigure.config.policy.allowedHttpOrigins',
      );
      final limits = _object(config['limits'], 'workerConfigure.config.limits');
      const limitKeys = <String>{
        'heapBytes',
        'stackBytes',
        'turnBudgetMicros',
        'windowMicros',
        'quotaMicros',
      };
      _expectKeys(limits, limitKeys, 'workerConfigure.config.limits');
      _requireKeys(limits, limitKeys, 'workerConfigure.config.limits');
      for (final item in limits.entries) {
        _validateBoundedInteger(
          item.value,
          'workerConfigure.config.limits.${item.key}',
        );
      }
      _validateSha256(args['configSha256'], 'workerConfigure.configSha256');
      if (args['configSha256'] !=
          pocketSha256(utf8.encode(pocketCanonicalJson(config)))) {
        throw const PocketRecordingFormatException(
          'workerConfigure.config SHA-256 mismatch',
        );
      }
      _requireVersion2TraceClock(result, 'workerConfigure.result');
      _expectKeys(result, const <String>{
        'configured',
        'traceClock',
      }, 'workerConfigure.result');
      if (result.containsKey('configured') && result['configured'] is! bool) {
        throw const PocketRecordingFormatException(
          'workerConfigure.result.configured must be boolean',
        );
      }
      if (error == null && result['configured'] != true) {
        throw const PocketRecordingFormatException(
          'workerConfigure.result must confirm configuration',
        );
      }
      break;
    case 'offloadConfigure':
      _expectKeys(args, const <String>{'config'}, 'offloadConfigure.args');
      _requireKeys(args, const <String>{'config'}, 'offloadConfigure.args');
      final config = _object(args['config'], 'offloadConfigure.config');
      _expectKeys(config, const <String>{
        'generation',
        'session',
        'timeoutMs',
        'methods',
      }, 'offloadConfigure.config');
      _requireKeys(config, const <String>{
        'generation',
        'session',
        'timeoutMs',
        'methods',
      }, 'offloadConfigure.config');
      for (final key in const <String>['generation', 'session', 'timeoutMs']) {
        _validateBoundedInteger(config[key], 'offloadConfigure.config.$key');
      }
      _validateStringArray(
        config['methods'],
        'offloadConfigure.config.methods',
      );
      _requireVersion2TraceClock(result, 'offloadConfigure.result');
      _expectKeys(result, const <String>{
        'configured',
        'traceClock',
      }, 'offloadConfigure.result');
      if (result.containsKey('configured') && result['configured'] is! bool) {
        throw const PocketRecordingFormatException(
          'offloadConfigure.result.configured must be boolean',
        );
      }
      if (error == null && result['configured'] != true) {
        throw const PocketRecordingFormatException(
          'offloadConfigure.result must confirm configuration',
        );
      }
      break;
    case 'externalWork':
      _expectKeys(args, const <String>{'source'}, 'externalWork.args');
      _requireKeys(args, const <String>{'source'}, 'externalWork.args');
      _string(args['source'], 'externalWork.args.source', maxLength: 64);
      _expectKeys(result, const <String>{
        'notified',
        'traceClock',
      }, 'externalWork.result');
      if (result.containsKey('notified') && result['notified'] is! bool) {
        throw const PocketRecordingFormatException(
          'externalWork.result.notified must be boolean',
        );
      }
      if (error == null && result['notified'] != true) {
        throw const PocketRecordingFormatException(
          'externalWork.result must confirm notification',
        );
      }
      if (!result.containsKey('traceClock')) {
        throw const PocketRecordingFormatException(
          'externalWork.result is missing traceClock',
        );
      }
      break;
    case 'asyncStop':
      _expectKeys(args, const <String>{}, 'asyncStop.args');
      _requireVersion2TraceClock(result, 'asyncStop.result');
      _expectKeys(result, const <String>{
        'stopped',
        'traceClock',
      }, 'asyncStop.result');
      if (result.containsKey('stopped') && result['stopped'] is! bool) {
        throw const PocketRecordingFormatException(
          'asyncStop.result.stopped must be boolean',
        );
      }
      if (error == null && result['stopped'] != true) {
        throw const PocketRecordingFormatException(
          'asyncStop.result must confirm stop',
        );
      }
      break;
    case 'captureStop':
      _expectKeys(args, const <String>{}, 'captureStop.args');
      if (result['traceClock'] is! Map) {
        throw const PocketRecordingFormatException(
          'captureStop.result must contain a trace clock envelope',
        );
      }
      _expectKeys(result, const <String>{
        'captured',
        'traceClock',
      }, 'captureStop.result');
      if (result.containsKey('captured') && result['captured'] is! bool) {
        throw const PocketRecordingFormatException(
          'captureStop.result.captured must be boolean',
        );
      }
      if (error == null && result['captured'] != true) {
        throw const PocketRecordingFormatException(
          'captureStop.result must confirm trace capture',
        );
      }
      break;
  }
}

void _validateAssetDescriptor(Object? value, String field) {
  final descriptor = _object(value, field);
  _expectKeys(descriptor, const <String>{'key', 'bytes', 'sha256'}, field);
  _requireKeys(descriptor, const <String>{'key', 'bytes', 'sha256'}, field);
  if (_string(descriptor['key'], '$field.key', maxLength: 4096).isEmpty) {
    throw PocketRecordingFormatException('$field.key is invalid');
  }
  final bytes = descriptor['bytes'];
  if (bytes is! int || bytes < 0 || bytes > 64 * 1024 * 1024) {
    throw PocketRecordingFormatException('$field.bytes is invalid');
  }
  _validateSha256(descriptor['sha256'], '$field.sha256');
}

void _requireVersion2TraceClock(Map<String, dynamic> result, String field) {
  final traceClock = result['traceClock'];
  if (traceClock is! Map || traceClock['version'] != 2) {
    throw PocketRecordingFormatException(
      '$field must contain a version 2 trace clock envelope',
    );
  }
}

void _validateStringArray(Object? value, String field) {
  if (value is! List ||
      value.length > 256 ||
      value.any((item) => item is! String)) {
    throw PocketRecordingFormatException(
      '$field must be a bounded string array',
    );
  }
  final strings = value.cast<String>();
  if (strings.any((item) => item.length > 4096)) {
    throw PocketRecordingFormatException('$field contains an oversized entry');
  }
}

void _validateBoundedInteger(Object? value, String field) {
  if (value is! int || value < 0 || value > 0x7fffffffffffffff) {
    throw PocketRecordingFormatException('$field must be a bounded integer');
  }
}

bool _entryRequiresRecordingV2(PocketRecordingEntry entry) {
  if (entry.kind == 'workerConfigure' ||
      entry.kind == 'offloadConfigure' ||
      entry.kind == 'externalWork' ||
      entry.kind == 'captureStop' ||
      entry.kind == 'asyncStop') {
    return true;
  }
  final traceClock = entry.result['traceClock'];
  return traceClock is Map &&
      (traceClock['version'] == 2 ||
          traceClock.containsKey('workerEvents') ||
          traceClock.containsKey('offloadEvents'));
}

String _string(Object? value, String field, {int maxLength = 4096}) {
  if (value is! String || value.length > maxLength) {
    throw PocketRecordingFormatException('$field must be a bounded string');
  }
  return value;
}

int _integer(Object? value, String field) {
  if (value is! int || value < 0)
    throw PocketRecordingFormatException(
      '$field must be a non-negative integer',
    );
  return value;
}

double _finiteNumber(Object? value, String field) {
  if (value is! num || !value.isFinite)
    throw PocketRecordingFormatException('$field must be finite');
  return value.toDouble();
}

void _validateFinite(double value, String field) {
  if (!value.isFinite)
    throw PocketRecordingFormatException('$field must be finite');
}

void _validateSha256(String value, String field) {
  if (value.length != 64 || !RegExp(r'^[0-9a-f]{64}$').hasMatch(value)) {
    throw PocketRecordingFormatException(
      '$field must be a lowercase SHA-256 digest',
    );
  }
}

void _validateError(Map<String, dynamic> error) {
  _expectKeys(error, const <String>{'type', 'message'}, 'entry.error');
  _string(error['type'], 'entry.error.type', maxLength: 128);
  _string(error['message'], 'entry.error.message', maxLength: 4096);
}

Object? _freezeObject(Object? value, String field, [int depth = 0]) {
  if (depth > 16)
    throw PocketRecordingFormatException('$field is too deeply nested');
  if (value == null || value is String || value is bool || value is int)
    return value;
  if (value is double) {
    if (!value.isFinite)
      throw PocketRecordingFormatException(
        '$field contains a non-finite number',
      );
    return value;
  }
  if (value is num) {
    if (!value.isFinite)
      throw PocketRecordingFormatException(
        '$field contains a non-finite number',
      );
    return value.toDouble();
  }
  if (value is Map) {
    final result = <String, dynamic>{};
    for (final entry in value.entries) {
      if (entry.key is! String)
        throw PocketRecordingFormatException('$field has a non-string key');
      result[entry.key as String] = _freezeObject(
        entry.value,
        field,
        depth + 1,
      );
    }
    return Map<String, dynamic>.unmodifiable(result);
  }
  if (value is Iterable) {
    return List<Object?>.unmodifiable(
      value.map((item) => _freezeObject(item, field, depth + 1)),
    );
  }
  throw PocketRecordingFormatException('$field contains an unsupported value');
}

int _positiveLimit(int value, String field) {
  if (value < 1 || value > 64 * 1024 * 1024)
    throw RangeError.range(value, 1, 64 * 1024 * 1024, field);
  return value;
}

Map<String, Uint8List> _copyBytesMap(Map<String, Uint8List> source) {
  final result = <String, Uint8List>{};
  var totalBytes = 0;
  for (final entry in source.entries) {
    if (entry.key.isEmpty || entry.key.length > 4096)
      throw ArgumentError.value(entry.key, 'asset key');
    if (entry.value.length > 64 * 1024 * 1024 ||
        totalBytes > 64 * 1024 * 1024 - entry.value.length) {
      throw ArgumentError.value(entry.key, 'asset map', 'assets are too large');
    }
    result[entry.key] = Uint8List.fromList(entry.value);
    totalBytes += entry.value.length;
  }
  return Map<String, Uint8List>.unmodifiable(result);
}
