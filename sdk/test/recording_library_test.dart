import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  test(
    'attach caches configurations and withPlugins preserves the factory',
    () {
      final library = PocketRecordingLibrary();
      final config = PocketAppConfig(appId: 'library.cache');

      final first = library.attach(config);
      final second = library.attach(config);
      expect(identical(first, second), isTrue);
      expect(first.recordingFactory, isNotNull);

      final customFactory = () => PocketRecordingController(enabled: false);
      final customConfig = PocketAppConfig(
        appId: 'factory.preserved',
        recordingFactory: customFactory,
      );
      final configured = customConfig.withPlugins(
        const <PocketPluginFactory>[],
      );
      expect(identical(configured.recordingFactory, customFactory), isTrue);
      expect(
        identical(configured.recordingFactory, customConfig.recordingFactory),
        isTrue,
      );
    },
  );

  test('maxRuntimes overflow is explicit and replay is rejected', () async {
    final library = PocketRecordingLibrary(maxRuntimes: 1);
    final firstConfig = library.attach(PocketAppConfig(appId: 'library.first'));
    final first = firstConfig.recordingFactory!.call();
    first.start(_metadata());

    final secondConfig = library.attach(
      PocketAppConfig(appId: 'library.second'),
    );
    final second = secondConfig.recordingFactory!.call();
    expect(second.enabled, isFalse);

    final status = library.status();
    expect(status['incomplete'], isTrue);
    expect(status['reason'], 'maxRuntimes exceeded');
    expect(status['runtimes'], hasLength(1));
    await expectLater(library.replay(), throwsA(isA<StateError>()));
  });

  test('an unstarted factory is incomplete after library stop', () async {
    final library = PocketRecordingLibrary();
    final configured = library.attach(
      PocketAppConfig(appId: 'library.unstarted'),
    );
    final controller = configured.recordingFactory!.call();
    expect(controller.isStarted, isFalse);

    library.stop();
    final stopped = library.status();
    expect(stopped['stopped'], isTrue);
    expect(stopped['incomplete'], isTrue);
    expect(stopped['reason'], 'A guest recorder did not finish starting');

    await expectLater(library.replay(), throwsA(isA<StateError>()));
    await expectLater(library.export(), throwsA(isA<StateError>()));
    expect(library.status()['stopped'], isTrue);
  });

  test(
    'a started guest without transactions cannot export or replay',
    () async {
      final library = _startedLibrary('library.empty');
      await expectLater(library.export(), throwsA(isA<StateError>()));
      expect(library.status()['incomplete'], isTrue);
      await expectLater(library.replay(), throwsA(isA<StateError>()));
    },
  );

  test(
    'asset quota makes capture incomplete and rejects replay/export',
    () async {
      final library = PocketRecordingLibrary();
      final configured = library.attach(
        PocketAppConfig(appId: 'library.asset-quota'),
      );
      final controller = configured.recordingFactory!.call();
      controller.start(_metadata());
      controller.retainAsset('oversized', Uint8List(16 * 1024 * 1024 + 1));

      expect(controller.isIncomplete, isTrue);
      expect(library.status()['incomplete'], isTrue);
      await expectLater(library.replay(), throwsA(isA<StateError>()));
      await expectLater(library.export(), throwsA(isA<StateError>()));
    },
  );

  test(
    'invalid upstream input tapes fail before export stops recording',
    () async {
      final cyclic = <String, dynamic>{};
      cyclic['self'] = cyclic;
      final oversized = <String, dynamic>{
        'payload': List.filled(256 * 1024, 'x').join(),
      };
      final invalidTapes = <Object?>['not-a-map', cyclic, oversized];

      for (final inputTape in invalidTapes) {
        final library = _startedLibrary('library.input-tape');
        expect(library.status()['stopped'], isFalse);
        await expectLater(
          library.export(inputTape: inputTape),
          throwsA(isA<FormatException>()),
        );
        expect(library.status()['stopped'], isFalse);
      }
    },
  );

  test('replayArchive rejects invalid archive envelopes before FFI', () async {
    final wrongSchema = await _writeArchive(
      _archiveDocument(schema: 'wrong.schema'),
    );
    await expectLater(
      PocketRecordingLibrary.replayArchive(wrongSchema),
      throwsA(isA<FormatException>()),
    );

    final incomplete = await _writeArchive(
      _archiveDocument(status: const <String, dynamic>{'incomplete': true}),
    );
    await expectLater(
      PocketRecordingLibrary.replayArchive(incomplete),
      throwsA(isA<FormatException>()),
    );

    final empty = await _writeArchive(_archiveDocument());
    await expectLater(
      PocketRecordingLibrary.replayArchive(empty),
      throwsA(isA<FormatException>()),
    );
  });

  test(
    'replayArchive rejects symlink and non-content-addressed assets',
    () async {
      final symlinkArchive = await _writeArchive(
        _archiveDocument(
          recordings: <String, dynamic>{'runtime': _recordingDocument()},
        ),
      );
      final symlinkTarget = File('${symlinkArchive.parent.path}/outside.bin');
      await symlinkTarget.writeAsBytes(const <int>[1, 2, 3]);
      final symlinkName = '${List.filled(64, 'a').join()}.bin';
      await Link(
        '${symlinkArchive.parent.path}/assets/$symlinkName',
      ).create(symlinkTarget.path);
      await expectLater(
        PocketRecordingLibrary.replayArchive(symlinkArchive),
        throwsA(isA<FormatException>()),
      );

      final invalidFileArchive = await _writeArchive(
        _archiveDocument(
          recordings: <String, dynamic>{'runtime': _recordingDocument()},
        ),
      );
      await File(
        '${invalidFileArchive.parent.path}/assets/not-a-sha256-name.bin',
      ).writeAsBytes(const <int>[4, 5, 6]);
      await expectLater(
        PocketRecordingLibrary.replayArchive(invalidFileArchive),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test(
    'replayArchive rejects a valid SHA filename with wrong contents',
    () async {
      final archive = await _writeArchive(
        _archiveDocument(
          recordings: <String, dynamic>{'runtime': _recordingDocument()},
        ),
      );
      final wrongHash = List.filled(64, '0').join();
      await File(
        '${archive.parent.path}/assets/$wrongHash.bin',
      ).writeAsBytes(const <int>[1, 2, 3]);

      await expectLater(
        PocketRecordingLibrary.replayArchive(archive),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test(
    'replayArchive rejects one sparse asset over the 64 MiB limit',
    () async {
      final archive = await _writeArchive(
        _archiveDocument(
          recordings: <String, dynamic>{'runtime': _recordingDocument()},
        ),
      );
      final oversized = File(
        '${archive.parent.path}/assets/${List.filled(64, '0').join()}.bin',
      );
      const length = 64 * 1024 * 1024 + 1;
      final handle = await oversized.open(mode: FileMode.write);
      try {
        await handle.setPosition(length - 1);
        await handle.writeByte(0);
      } finally {
        await handle.close();
      }

      await expectLater(
        PocketRecordingLibrary.replayArchive(archive),
        throwsA(isA<FormatException>()),
      );
    },
  );

  test(
    'replayArchive rejects malformed asset SHA before native replay',
    () async {
      final archive = await _writeArchive(
        _archiveDocument(
          recordings: <String, dynamic>{
            'runtime': _recordingDocument(
              contentHashes: <String, dynamic>{
                'bytecode': List.filled(64, 'g').join(),
              },
            ),
          },
        ),
      );
      await expectLater(
        PocketRecordingLibrary.replayArchive(archive),
        throwsA(isA<PocketRecordingFormatException>()),
      );
    },
  );
}

PocketRecordingMetadata _metadata() => PocketRecordingMetadata(
  width: 320,
  height: 480,
  density: 2,
  tickHz: 60,
  engineAbi: 'test-engine',
);

PocketRecordingLibrary _startedLibrary(String appId) {
  final library = PocketRecordingLibrary();
  final configured = library.attach(PocketAppConfig(appId: appId));
  configured.recordingFactory!.call().start(_metadata());
  return library;
}

Map<String, dynamic> _archiveDocument({
  String schema = 'pocket.recording.archive',
  int version = 1,
  Map<String, dynamic> status = const <String, dynamic>{'incomplete': false},
  Map<String, dynamic> recordings = const <String, dynamic>{},
}) => <String, dynamic>{
  'schema': schema,
  'version': version,
  'status': status,
  'recordings': recordings,
};

Map<String, dynamic> _recordingDocument({
  Map<String, dynamic> contentHashes = const <String, dynamic>{},
}) => <String, dynamic>{
  'schema': 'pocket.runtime.recording',
  'version': 1,
  'metadata': <String, dynamic>{
    'width': 320.0,
    'height': 480.0,
    'density': 2,
    'tickHz': 60,
    'engineAbi': 'test-engine',
    'contentHashes': contentHashes,
  },
  'limits': <String, dynamic>{'maxEntries': 8192, 'maxBytes': 8 * 1024 * 1024},
  'bytes': 0,
  'incomplete': false,
  'incompleteReason': null,
  'entries': const <Object?>[],
};

Future<File> _writeArchive(Map<String, dynamic> document) async {
  final root = await Directory.systemTemp.createTemp(
    'pocket-recording-library-test-',
  );
  addTearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });
  await Directory('${root.path}/assets').create();
  final manifest = File('${root.path}/recordings.json');
  await manifest.writeAsString(jsonEncode(document));
  return manifest;
}
