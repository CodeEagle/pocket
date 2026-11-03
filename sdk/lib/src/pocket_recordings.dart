import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';

/// Explicit debug capture of every native generation, including hidden apps.
/// Business scheduling stays in SystemUI; this only groups diagnostic files.
final class PocketRecordingLibrary {
  PocketRecordingLibrary({this.maxRuntimes = 8}) {
    if (maxRuntimes < 1 || maxRuntimes > 32) {
      throw RangeError.range(maxRuntimes, 1, 32, 'maxRuntimes');
    }
  }

  final int maxRuntimes;
  final Map<String, PocketRecordingController> _captures = {};
  final Map<String, String> _appIds = {};
  final Map<(PocketAppConfig, bool), PocketAppConfig> _configured = {};
  bool _stopped = false;
  String? _incompleteReason;

  /// Apply before mounting an app. Controls are granted only to a trusted
  /// debug UI; ordinary child apps can be captured without export authority.
  PocketAppConfig attach(PocketAppConfig config, {bool controls = false}) {
    if (config.recordingFactory != null) {
      throw ArgumentError('The application already has a recording factory');
    }
    final cacheKey = (config, controls);
    final existing = _configured[cacheKey];
    if (existing != null) return existing;
    final configured = PocketAppConfig(
      appId: config.appId,
      bytecodeAsset: config.bytecodeAsset,
      pakAsset: config.pakAsset,
      metadataAsset: config.metadataAsset,
      manifestAsset: config.manifestAsset,
      updates: config.updates,
      compositorSurfaces: config.compositorSurfaces,
      workerHttpOrigins: config.workerHttpOrigins,
      offloadProviderFactory: config.offloadProviderFactory,
      showFps: config.showFps,
      allowedPermissions: config.allowedPermissions,
      additionalCapabilities: config.additionalCapabilities,
      pluginFactories: [
        ...config.pluginFactories,
        if (controls) (_) => _RecordingPlugin(this),
      ],
      recordingFactory: () => _create(config.appId),
    );
    _configured[cacheKey] = configured;
    return configured;
  }

  PocketRecordingController _create(String appId) {
    if (_stopped) return PocketRecordingController(enabled: false);
    if (_captures.length >= maxRuntimes) {
      _incompleteReason = 'maxRuntimes exceeded';
      return PocketRecordingController(enabled: false);
    }
    final id = '${_captures.length + 1}-$appId';
    final capture = PocketRecordingController(retainReplayAssets: true);
    _captures[id] = capture;
    _appIds[id] = appId;
    return capture;
  }

  Map<String, dynamic> status() => {
    'enabled': true,
    'stopped': _stopped,
    'incomplete':
        _incompleteReason != null ||
        _captures.values.any((capture) => capture.isIncomplete),
    if (_incompleteReason != null) 'reason': _incompleteReason,
    'runtimes': [
      for (final entry in _captures.entries)
        {
          'id': entry.key,
          'appId': _appIds[entry.key],
          'entries': entry.value.entryCount,
          'bytes': entry.value.recordedBytes,
          'finished': entry.value.isFinished,
          'incomplete': entry.value.isIncomplete,
        },
    ],
  };

  /// Freeze each active trace at a native transaction boundary.
  ///
  /// This ends capture while leaving the guest and its Worker/offload services
  /// running. Disposing a runtime during capture records its separate native
  /// async-stop transaction.
  Map<String, PocketRecording> stop() {
    _stopped = true;
    if (_captures.values.any((capture) => !capture.isStarted)) {
      _incompleteReason ??= 'A guest recorder did not finish starting';
    } else if (_captures.values.any((capture) => capture.entryCount == 0)) {
      _incompleteReason ??= 'A guest recorded no transactions';
    }
    return Map<String, PocketRecording>.unmodifiable({
      for (final entry in _captures.entries)
        if (entry.value.isStarted) entry.key: entry.value.finish(),
    });
  }

  /// Replay creates independent native guests without platform providers.
  /// Hardware, network and SystemUI results come from recorded input lanes.
  Future<Map<String, dynamic>> replay() async {
    final recordings = _requireReplayableRecordings();
    final jobs = <Map<String, dynamic>>[
      for (final entry in recordings.entries)
        {
          'id': entry.key,
          'recording': entry.value.toJsonString(),
          'assets': _captures[entry.key]!.replayAssets.byHash,
        },
    ];
    return Isolate.run(() => _replayCapturedGuests(jobs));
  }

  /// Export the frozen tape and content-addressed assets together. Tape JSON
  /// contains no source paths; consumers can retain the matching asset bundle.
  Future<Map<String, dynamic>> export({
    Directory? directory,
    Object? inputTape,
  }) async {
    _validateUpstreamAttachment(inputTape);
    final recordings = _requireReplayableRecordings();
    final blobs = <String, Uint8List>{};
    for (final controller in _captures.values) {
      blobs.addAll(controller.replayAssets.byHash);
    }
    if (blobs.length > 128 ||
        blobs.values.fold<int>(0, (total, bytes) => total + bytes.length) >
            128 * 1024 * 1024) {
      throw const FormatException('Archive asset limits exceeded');
    }
    final document = jsonEncode({
      'schema': 'pocket.recording.archive',
      'version': 1,
      'status': status(),
      if (inputTape != null) 'upstreamInputTape': inputTape,
      'recordings': {
        for (final entry in recordings.entries) entry.key: entry.value.toJson(),
      },
    });
    if (utf8.encode(document).length > 128 * 1024 * 1024) {
      throw const FormatException('Recording archive exceeds 128 MiB');
    }
    final base = directory ?? await getApplicationDocumentsDirectory();
    final target = Directory(
      '${base.path}/pocket-recording-${DateTime.now().microsecondsSinceEpoch}',
    );
    await target.create(recursive: true);
    final assets = Directory('${target.path}/assets');
    await assets.create();
    for (final asset in blobs.entries) {
      await File('${assets.path}/${asset.key}.bin').writeAsBytes(asset.value);
    }
    final output = File('${target.path}/recordings.json');
    await output.writeAsString(document);
    return {
      'path': output.path,
      'runtimeCount': recordings.length,
      ...status(),
    };
  }

  /// Open only this archive's content-addressed regular files. Asset hashes
  /// and the linked engine ABI are verified again by the native replay path.
  static Future<Map<String, dynamic>> replayArchive(File manifest) async {
    if (await manifest.length() > 128 * 1024 * 1024) {
      throw const FormatException('Recording archive exceeds 128 MiB');
    }
    final decoded = jsonDecode(await manifest.readAsString());
    if (decoded is! Map ||
        decoded.keys.any(
          (key) =>
              key is! String ||
              !const <String>{
                'schema',
                'version',
                'status',
                'upstreamInputTape',
                'recordings',
              }.contains(key),
        ) ||
        !decoded.containsKey('schema') ||
        !decoded.containsKey('version') ||
        !decoded.containsKey('status') ||
        !decoded.containsKey('recordings') ||
        decoded['schema'] != 'pocket.recording.archive' ||
        decoded['version'] != 1 ||
        decoded['recordings'] is! Map ||
        decoded['status'] is! Map) {
      throw const FormatException('Invalid recording archive');
    }
    if ((decoded['status'] as Map)['incomplete'] != false) {
      throw const FormatException('Incomplete recording archive');
    }
    _validateUpstreamAttachment(decoded['upstreamInputTape']);
    final rawRecordings = decoded['recordings'] as Map;
    if (rawRecordings.isEmpty || rawRecordings.length > 32) {
      throw const FormatException('Invalid archive runtime count');
    }
    final directory = Directory('${manifest.parent.path}/assets');
    if (await FileSystemEntity.type(directory.path, followLinks: false) !=
        FileSystemEntityType.directory) {
      throw const FormatException('Archive assets must be a regular directory');
    }
    final allAssets = <String, Uint8List>{};
    var totalBytes = 0;
    await for (final entry in directory.list(followLinks: false)) {
      final name = entry.uri.pathSegments.last;
      if (!RegExp(r'^[a-f0-9]{64}\.bin$').hasMatch(name) ||
          entry is! File ||
          await FileSystemEntity.type(entry.path, followLinks: false) !=
              FileSystemEntityType.file) {
        throw const FormatException('Unexpected archive asset');
      }
      final length = await entry.length();
      if (length > 64 * 1024 * 1024) {
        throw const FormatException('Archive asset exceeds 64 MiB');
      }
      totalBytes += length;
      if (totalBytes > 128 * 1024 * 1024 || allAssets.length >= 128) {
        throw const FormatException('Archive asset limits exceeded');
      }
      final bytes = await entry.readAsBytes();
      final hash = name.substring(0, 64);
      if (bytes.length != length || pocketSha256(bytes) != hash) {
        throw const FormatException('Archive asset size or SHA-256 mismatch');
      }
      allAssets[hash] = bytes;
    }
    final jobs = <Map<String, dynamic>>[];
    for (final entry in rawRecordings.entries) {
      if (entry.key is! String || (entry.key as String).length > 256) {
        throw const FormatException('Invalid archive runtime identity');
      }
      final recording = PocketRecording.fromJson(entry.value);
      if (!recording.replayable) {
        throw const FormatException('Archive contains an unreplayable guest');
      }
      jobs.add({
        'id': entry.key,
        'recording': recording.toJsonString(),
        'assets': allAssets,
      });
    }
    final result = await Isolate.run(() => _replayCapturedGuests(jobs));
    return {
      ...result,
      'hasUpstreamInputTape': decoded['upstreamInputTape'] != null,
    };
  }

  Map<String, PocketRecording> _requireReplayableRecordings() {
    final recordings = stop();
    if (_incompleteReason != null || recordings.isEmpty) {
      throw StateError(_incompleteReason ?? 'No guest has been recorded');
    }
    if (recordings.values.any((recording) => !recording.replayable)) {
      throw StateError('Incomplete guest recording');
    }
    return recordings;
  }

  static void _validateUpstreamAttachment(Object? inputTape) {
    if (inputTape == null) return;
    try {
      if (inputTape is Map &&
          utf8.encode(jsonEncode(inputTape)).length <= 256 * 1024) {
        return;
      }
    } on Object {
      // Keep malformed/cyclic diagnostics from stopping a live recording.
    }
    throw const FormatException('Upstream input tape must be a bounded object');
  }
}

Future<Map<String, dynamic>> _replayCapturedGuests(
  List<Map<String, dynamic>> jobs,
) async {
  final results = <String, dynamic>{};
  for (final job in jobs) {
    final recording = PocketRecording.fromJsonString(
      job['recording'] as String,
    );
    final available = (job['assets'] as Map).cast<String, Uint8List>();
    final hashes = recording.metadata.contentHashes.values.toSet();
    for (final entry in recording.entries) {
      for (final key in ['source', 'bytecode', 'pak', 'workerBytecode']) {
        final descriptor = entry.args[key];
        if (descriptor is Map && descriptor['sha256'] is String) {
          hashes.add(descriptor['sha256'] as String);
        }
      }
    }
    final assets = PocketReplayAssets(
      byHash: {
        for (final hash in hashes)
          if (available[hash] case final Uint8List bytes) hash: bytes,
      },
    );
    results[job['id'] as String] = (await replayPocketRecording(
      recording,
      assets: assets,
    )).toJson();
  }
  return {
    'ok': results.values.every((value) => (value as Map)['matched'] == true),
    'runtimes': results,
  };
}

final class _RecordingPlugin extends PocketPlugin {
  _RecordingPlugin(this.library);
  final PocketRecordingLibrary library;

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.debug.recording',
    version: '1.0.0',
    capabilities: {
      for (final name in ['status', 'stop', 'export', 'replay'])
        'diagnostics.recording.$name': PocketPluginCapability(
          name: 'diagnostics.recording.$name',
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(
      'diagnostics.recording.status',
      (_) => library.status(),
    );
    context.registerRequest('diagnostics.recording.stop', (_) {
      library.stop();
      return library.status();
    });
    context.registerRequest(
      'diagnostics.recording.export',
      (params) => library.export(inputTape: params['inputTape']),
    );
    context.registerRequest(
      'diagnostics.recording.replay',
      (_) => library.replay(),
    );
  }
}
