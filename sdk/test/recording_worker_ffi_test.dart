import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

const _workerUiSource = r'''
__pocketWorkerChannels.configure(1, 0);
__pocketWorkerChannels.configure(2, 0);
globalThis.submitWorkerUrl = function(url) {
  const bytes = Array.from(url, value => value.charCodeAt(0));
  __pocketWorkerChannels.publish(2, new Uint8Array(bytes));
};
globalThis.frame = function() {
  for (const bytes of __pocketWorkerChannels.observe(1)) {
    const value = Array.from(bytes, item => String.fromCharCode(item)).join('');
    pocket._emit(JSON.stringify({method: 'worker.result', params: {value}}));
  }
};
''';

void main() {
  final nativePath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final fixturePath =
      Platform.environment['POCKET_RECORDING_WORKER_FIXTURE_DIR'];
  final skip = nativePath == null
      ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
      : fixturePath == null
      ? 'Generate a real Worker QJBC fixture with worker_recording_fixture.ts.'
      : false;

  test(
    'explicit recording stop captures a replayable cut and leaves the guest live',
    () async {
      final controller = PocketRecordingController(retainReplayAssets: true);
      final runtime = FfiPocketRuntime.open(
        width: 32,
        height: 24,
        recording: controller,
      );
      addTearDown(runtime.dispose);

      runtime.eval('globalThis.capturePrefix = 1;');
      final recording = controller.finish();
      expect(recording.entries.last.kind, 'eval');
      expect(recording.version, 1);

      expect(
        () => runtime.eval('globalThis.afterCapture = 2;'),
        returnsNormally,
      );
      runtime.dispose();

      final replay = await replayPocketRecording(
        recording,
        assets: controller.replayAssets,
      );
      expect(replay.matched, isTrue, reason: replay.toString());
    },
    skip: nativePath == null
        ? 'Set POCKET_NATIVE_LIBRARY to a built Pocket native dylib/so.'
        : false,
  );

  test(
    'real Worker QJBC, HTTP facts, channel output and archive replay survive teardown',
    () async {
      final root = Directory.systemTemp.createTempSync(
        'pocket-worker-recording-ffi-',
      );
      addTearDown(() async {
        if (await root.exists()) await root.delete(recursive: true);
      });

      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var serverRequests = 0;
      server.listen((request) {
        serverRequests++;
        unawaited(() async {
          request.response.headers.contentType = ContentType.text;
          request.response.write('recorded-worker-body');
          await request.response.close();
        }());
      });
      FfiPocketRuntime? activeRuntime;
      addTearDown(() async {
        activeRuntime?.dispose();
        await server.close(force: true);
      });
      final origin = 'http://127.0.0.1:${server.port}';
      final url = '$origin/facts';
      final assets = Directory('$fixturePath/assets');
      final appMetadataSource = await File(
        '${assets.path}/app.bytecode.json',
      ).readAsString();
      final appMetadata = Map<String, dynamic>.from(
        jsonDecode(appMetadataSource) as Map,
      );
      final guestManifest = Map<String, dynamic>.from(
        jsonDecode(
              await File('${assets.path}/guest-manifest.json').readAsString(),
            )
            as Map,
      );
      final workerBytecode = await File(
        '${assets.path}/app.worker.qjbc',
      ).readAsBytes();

      final recordings = PocketRecordingLibrary(maxRuntimes: 1);
      final config = recordings.attach(
        PocketAppConfig(
          appId: 'worker.recording.fixture',
          workerHttpOrigins: {origin},
        ),
      );
      final controller = config.recordingFactory!.call();
      final runtime = activeRuntime = FfiPocketRuntime.open(
        width: 160,
        height: 96,
        recording: controller,
      );
      final abi = runtime.actualAbi;
      if (abi == null) {
        runtime.dispose();
        await server.close(force: true);
        throw StateError('The native test library does not expose its ABI');
      }
      final worker = PocketWorkerArtifact.verify(
        appMetadataJson: appMetadataSource,
        bytecode: workerBytecode,
        actualRuntimeAbi: abi,
        expectedBindingGeneration: (appMetadata['bindingGeneration'] as num)
            .toInt(),
        expectedTickHz: (appMetadata['tickHz'] as num).toInt(),
        admittedCapabilities: List<String>.from(
          (guestManifest['capabilities'] as Map)['requires'] as List,
        ),
        allowedHttpOrigins: [origin],
      ).program;

      var wake = Completer<void>();
      final workerRuntime = runtime as PocketWorkerRuntime;
      workerRuntime.configureWorker(
        worker,
        onWake: () {
          if (!wake.isCompleted) wake.complete();
        },
      );
      runtime.eval(_workerUiSource);
      runtime.eval('submitWorkerUrl(${jsonEncode(url)});');

      final observed = <String>[];
      final deadline = DateTime.now().add(const Duration(seconds: 12));
      while (!observed.contains('end:0')) {
        final remaining = deadline.difference(DateTime.now());
        if (remaining <= Duration.zero) {
          throw TimeoutException(
            'Worker did not publish its HTTP result; observed=$observed',
          );
        }
        final signaled = wake;
        await signaled.future.timeout(
          remaining,
          onTimeout: () => throw TimeoutException(
            'Worker wake timed out; observed=$observed; '
            'HTTP requests=$serverRequests; native=${runtime.lastError}',
          ),
        );
        // Replace the awaited latch only after its notification arrives.
        // onWake completes the current latch; replacing it before awaiting
        // would leave this Future permanently waiting on the old instance.
        wake = Completer<void>();
        final frame = runtime.frameAt(0);
        observed.addAll(
          frame.events
              .where((event) => event.method == 'worker.result')
              .map((event) => event.params['value'])
              .whereType<String>(),
        );
      }
      expect(observed, contains('body:recorded-worker-body'));
      expect(serverRequests, 1);

      runtime.dispose();
      activeRuntime = null;
      await server.close(force: true);
      final frozen = recordings.stop();
      final recording = frozen.values.single;
      expect(recording.version, 2);
      expect(recording.replayable, isTrue);
      expect(recording.entries.last.kind, 'asyncStop');
      expect(
        recording.entries.any((entry) => entry.kind == 'captureStop'),
        isFalse,
      );
      final eventKinds = <String>{
        for (final entry in recording.entries)
          if (entry.result['traceClock'] case final Map trace)
            for (final event in (trace['workerEvents'] as List? ?? const []))
              (event as Map)['kind'] as String,
      };
      expect(
        eventKinds,
        containsAll(<String>{'channel.publish', 'io.request', 'io.fact'}),
      );

      final exported = await recordings.export(directory: root);
      final archive = File(exported['path'] as String);

      final firstReplay = await PocketRecordingLibrary.replayArchive(archive);
      final secondReplay = await PocketRecordingLibrary.replayArchive(archive);
      expect(firstReplay['ok'], isTrue, reason: jsonEncode(firstReplay));
      expect(secondReplay['ok'], isTrue, reason: jsonEncode(secondReplay));
      expect(serverRequests, 1, reason: 'offline replay must not repeat HTTP');

      final originalDocument = await archive.readAsString();
      final document = Map<String, dynamic>.from(
        jsonDecode(originalDocument) as Map,
      );
      final recordingJson = Map<String, dynamic>.from(
        (document['recordings'] as Map).values.single as Map,
      );
      final entries = (recordingJson['entries'] as List)
          .cast<Map<String, dynamic>>();
      final event = entries
          .map((entry) => entry['result']['traceClock'])
          .whereType<Map>()
          .expand((trace) => trace['workerEvents'] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .first;

      event['seq'] = -1;
      await archive.writeAsString(jsonEncode(document));
      await expectLater(
        PocketRecordingLibrary.replayArchive(archive),
        throwsA(isA<FormatException>()),
      );

      final payloadDocument = Map<String, dynamic>.from(
        jsonDecode(originalDocument) as Map,
      );
      final payloadRecording = Map<String, dynamic>.from(
        (payloadDocument['recordings'] as Map).values.single as Map,
      );
      final payloadEntries = (payloadRecording['entries'] as List)
          .cast<Map<String, dynamic>>();
      final changed = _mutateFirstBytePayload(payloadEntries);
      expect(
        changed,
        isTrue,
        reason: 'Worker trace should contain inline facts',
      );
      await archive.writeAsString(jsonEncode(payloadDocument));
      final payloadReplay = await PocketRecordingLibrary.replayArchive(archive);
      expect(payloadReplay['ok'], isFalse, reason: jsonEncode(payloadReplay));
    },
    skip: skip,
  );
}

bool _mutateFirstBytePayload(Object? value) {
  if (value is Map) {
    for (final entry in value.entries.toList(growable: false)) {
      if (entry.key == 'bytesBase64' && entry.value is String) {
        final bytes = base64Decode(entry.value as String);
        if (bytes.isEmpty) continue;
        bytes[0] = (bytes[0] + 1) & 0xff;
        value[entry.key] = base64Encode(bytes);
        return true;
      }
      if (_mutateFirstBytePayload(entry.value)) return true;
    }
  } else if (value is List) {
    for (final item in value) {
      if (_mutateFirstBytePayload(item)) return true;
    }
  }
  return false;
}
