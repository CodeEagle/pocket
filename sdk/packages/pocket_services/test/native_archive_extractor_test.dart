import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:path/path.dart' as path;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test(
    '7z fails clearly before reading bytes when native extraction is absent',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-unavailable-',
      );
      try {
        var streamListeners = 0;
        var archiveVerifiedSignals = 0;
        final bytes = Stream<List<int>>.multi((_) => streamListeners++);

        await expectLater(
          PocketPackageStore(root).writeBundleZip(
            bundle: PocketManifestBundle(
              format: '7z',
              sha256: _sha256(<int>[1, 2, 3]),
              size: 3,
              url: 'bundle.7z',
            ),
            expectedFiles: const <PocketManifestFile>[],
            bytes: bytes,
            cancellation: PocketCancellationToken(),
            onArchiveVerified: () => archiveVerifiedSignals++,
          ),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'native-archive-unavailable',
            ),
          ),
        );

        expect(streamListeners, 0);
        expect(archiveVerifiedSignals, 0);
        expect(await root.list().toList(), isEmpty);
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test(
    'uses the injected native extractor and verifies files from disk',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-success-',
      );
      try {
        final contents = <int>[1, 2, 3, 4, 5];
        final hash = _sha256(contents);
        final archive = <int>[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 7, 8];
        final progress = <PocketPackagePreparationProgress>[];
        var extractorCalls = 0;
        String? stagedOutputPath;
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                extractorCalls++;
                stagedOutputPath = destinationPath;
                expect(await File(archivePath).readAsBytes(), archive);
                expect(maxOutputBytes, 1024);
                final output = File(path.join(destinationPath, 'blobs', hash));
                await output.parent.create(recursive: true);
                await output.writeAsBytes(contents, flush: true);
              },
        ).scoped('test.app');

        final result = await store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: '7z',
            sha256: _sha256(archive),
            size: archive.length,
            url: 'bundle.7z',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: hash,
              size: contents.length,
              url: 'blobs/$hash',
            ),
          ],
          bytes: Stream<List<int>>.value(archive),
          cancellation: PocketCancellationToken(),
          maxTotalBytes: 1024,
          onPreparationProgress: progress.add,
        );

        expect(extractorCalls, 1);
        expect(result[hash], isNotNull);
        expect(await result[hash]!.readAsBytes(), contents);
        expect(
          progress
              .where(
                (fact) =>
                    fact.stage == PocketPackagePreparationStage.decodingArchive,
              )
              .length,
          2,
          reason: 'native extraction reports start and completion',
        );
        final verification = progress.lastWhere(
          (fact) => fact.stage == PocketPackagePreparationStage.verifyingFiles,
        );
        expect(verification.processedBytes, contents.length);
        expect(verification.processedFiles, 1);
        expect(verification.totalFiles, 1);
        expect(await Directory(stagedOutputPath!).exists(), isFalse);
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test(
    'rejects a native extracted file with the wrong digest before caching',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-tamper-',
      );
      try {
        final contents = <int>[1, 2, 3, 4];
        final archive = <int>[8, 7, 6, 5];
        final hash = _sha256(contents);
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                final output = File(path.join(destinationPath, 'blobs', hash));
                await output.parent.create(recursive: true);
                await output.writeAsBytes(<int>[9, 2, 3, 4], flush: true);
              },
        );

        await expectLater(
          store.writeBundleZip(
            bundle: PocketManifestBundle(
              format: '7z',
              sha256: _sha256(archive),
              size: archive.length,
              url: 'bundle.7z',
            ),
            expectedFiles: <PocketManifestFile>[
              PocketManifestFile(
                sha256: hash,
                size: contents.length,
                url: 'blobs/$hash',
              ),
            ],
            bytes: Stream<List<int>>.value(archive),
            cancellation: PocketCancellationToken(),
            maxTotalBytes: 1024,
          ),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'bundle-content',
            ),
          ),
        );
        expect(
          await File(path.join(root.path, 'blobs', hash)).exists(),
          isFalse,
        );
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test(
    'propagates native extractor failures and cleans its staging files',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-error-',
      );
      try {
        final archive = <int>[1, 3, 5, 7];
        var stagedOutputPath = '';
        final failure = PocketPackageException(
          'native decoder failed',
          code: 'native-archive',
        );
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                stagedOutputPath = destinationPath;
                throw failure;
              },
        );

        await expectLater(
          store.writeBundleZip(
            bundle: PocketManifestBundle(
              format: '7z',
              sha256: _sha256(archive),
              size: archive.length,
              url: 'bundle.7z',
            ),
            expectedFiles: const <PocketManifestFile>[],
            bytes: Stream<List<int>>.value(archive),
            cancellation: PocketCancellationToken(),
            maxTotalBytes: 1024,
          ),
          throwsA(same(failure)),
        );

        expect(await Directory(stagedOutputPath).exists(), isFalse);
        final remaining = await Directory(
          path.join(root.path, 'blobs'),
        ).list().toList();
        expect(remaining, isEmpty);
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test('rejects links emitted into the native extraction directory', () async {
    final root = await Directory.systemTemp.createTemp(
      'pocket-native-archive-link-',
    );
    try {
      final contents = <int>[3, 1, 4, 1];
      final archive = <int>[5, 9, 2, 6];
      final hash = _sha256(contents);
      final externalFile = File(path.join(root.path, 'outside'));
      await externalFile.writeAsBytes(contents, flush: true);
      final store = PocketPackageStore(
        root,
        archiveExtractor:
            ({
              required String archivePath,
              required String destinationPath,
              required int maxOutputBytes,
            }) async {
              final output = Link(path.join(destinationPath, 'blobs', hash));
              await output.parent.create(recursive: true);
              await output.create(externalFile.path);
            },
      );

      await expectLater(
        store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: '7z',
            sha256: _sha256(archive),
            size: archive.length,
            url: 'bundle.7z',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: hash,
              size: contents.length,
              url: 'blobs/$hash',
            ),
          ],
          bytes: Stream<List<int>>.value(archive),
          cancellation: PocketCancellationToken(),
          maxTotalBytes: 1024,
        ),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            'bundle-content',
          ),
        ),
      );
      expect(await File(path.join(root.path, 'blobs', hash)).exists(), isFalse);
    } finally {
      await root.delete(recursive: true);
    }
  });

  test(
    'waits for native extraction to finish before cancellation cleanup',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-cancel-',
      );
      try {
        final contents = <int>[2, 4, 6, 8];
        final archive = <int>[1, 2, 3, 4];
        final hash = _sha256(contents);
        final cancellation = PocketCancellationToken();
        final extractorStarted = Completer<void>();
        final releaseExtractor = Completer<void>();
        var stagedArchivePath = '';
        var stagedOutputPath = '';
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                stagedArchivePath = archivePath;
                stagedOutputPath = destinationPath;
                extractorStarted.complete();
                await releaseExtractor.future;
                final output = File(path.join(destinationPath, 'blobs', hash));
                await output.parent.create(recursive: true);
                await output.writeAsBytes(contents, flush: true);
              },
        );
        final operation = store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: '7z',
            sha256: _sha256(archive),
            size: archive.length,
            url: 'bundle.7z',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: hash,
              size: contents.length,
              url: 'blobs/$hash',
            ),
          ],
          bytes: Stream<List<int>>.value(archive),
          cancellation: cancellation,
          maxTotalBytes: 1024,
        );

        await extractorStarted.future;
        cancellation.cancel();
        var completed = false;
        unawaited(
          operation.then<void>(
            (_) => completed = true,
            onError: (Object _, StackTrace __) => completed = true,
          ),
        );
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(completed, isFalse);
        expect(await File(stagedArchivePath).exists(), isTrue);
        expect(await Directory(stagedOutputPath).exists(), isTrue);

        releaseExtractor.complete();
        await expectLater(operation, throwsA(isA<PocketUpdateCancellation>()));
        expect(await File(stagedArchivePath).exists(), isFalse);
        expect(await Directory(stagedOutputPath).exists(), isFalse);
        expect(
          await File(path.join(root.path, 'blobs', hash)).exists(),
          isFalse,
        );
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test(
    'ZIP uses Dart extraction without calling the configured native extractor',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-zip-dart-only-',
      );
      try {
        final contents = <int>[10, 20, 30, 40];
        final hash = _sha256(contents);
        final archive = encodePocketZip(<String, List<int>>{
          'blobs/$hash': contents,
        });
        var extractorCalls = 0;
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                extractorCalls++;
              },
        );

        final result = await store.writeBundleZip(
          bundle: PocketManifestBundle(
            format: 'zip',
            sha256: _sha256(archive),
            size: archive.length,
            url: 'bundle.zip',
          ),
          expectedFiles: <PocketManifestFile>[
            PocketManifestFile(
              sha256: hash,
              size: contents.length,
              url: 'blobs/$hash',
            ),
          ],
          bytes: Stream<List<int>>.value(archive),
          cancellation: PocketCancellationToken(),
          maxTotalBytes: 1024,
        );

        expect(extractorCalls, 0);
        expect(result[hash], isNotNull);
        expect(await result[hash]!.readAsBytes(), contents);
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test(
    '7z does not fall back when native extractor reports native-archive-unavailable',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'pocket-native-archive-7z-no-fallback-',
      );
      try {
        final contents = <int>[10, 20, 30, 40];
        final hash = _sha256(contents);
        final archive = <int>[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
        var extractorCalls = 0;
        final store = PocketPackageStore(
          root,
          archiveExtractor:
              ({
                required String archivePath,
                required String destinationPath,
                required int maxOutputBytes,
              }) async {
                extractorCalls++;
                throw const PocketPackageException(
                  'native plugin not registered on this host',
                  code: 'native-archive-unavailable',
                );
              },
        );

        await expectLater(
          store.writeBundleZip(
            bundle: PocketManifestBundle(
              format: '7z',
              sha256: _sha256(archive),
              size: archive.length,
              url: 'bundle.7z',
            ),
            expectedFiles: <PocketManifestFile>[
              PocketManifestFile(
                sha256: hash,
                size: contents.length,
                url: 'blobs/$hash',
              ),
            ],
            bytes: Stream<List<int>>.value(archive),
            cancellation: PocketCancellationToken(),
            maxTotalBytes: 1024,
          ),
          throwsA(
            isA<PocketPackageException>().having(
              (error) => error.code,
              'code',
              'native-archive-unavailable',
            ),
          ),
        );

        expect(extractorCalls, 1);
        expect(
          await File(path.join(root.path, 'blobs', hash)).exists(),
          isFalse,
        );
      } finally {
        await root.delete(recursive: true);
      }
    },
  );
}

String _sha256(List<int> bytes) => crypto.sha256.convert(bytes).toString();
