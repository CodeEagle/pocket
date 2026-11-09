import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test('decoded ZIP entries remain independently mutable', () {
    final files = decodePocketZip(
      encodePocketZip(<String, List<int>>{
        'first': <int>[1, 2, 3],
        'second': <int>[4, 5, 6],
      }),
    );
    files['first']![0] = 99;
    expect(files['first'], <int>[99, 2, 3]);
    expect(files['second'], <int>[4, 5, 6]);
  });

  test('ZIP extraction and file verification report completed work', () async {
    final payload = List<int>.generate(1048576, (index) => (index * 17) % 251);
    final archive = encodePocketZip(<String, List<int>>{
      'payload.bin': payload,
    });
    final hash = crypto.sha256.convert(payload).toString();
    final directory = await Directory.systemTemp.createTemp(
      'pocket-zip-progress-',
    );
    final facts = <PocketPackagePreparationProgress>[];
    try {
      final files = await PocketPackageStore(directory).writeBundleZip(
        bundle: PocketManifestBundle(
          format: 'zip',
          sha256: crypto.sha256.convert(archive).toString(),
          size: archive.length,
          url: 'bundle.zip',
        ),
        expectedFiles: <PocketManifestFile>[
          PocketManifestFile(
            sha256: hash,
            size: payload.length,
            url: 'payload.bin',
          ),
        ],
        bytes: Stream<List<int>>.value(archive),
        cancellation: PocketCancellationToken(),
        onPreparationProgress: facts.add,
      );

      final decode = facts
          .where(
            (fact) =>
                fact.stage == PocketPackagePreparationStage.decodingArchive,
          )
          .toList();
      expect(decode.length, greaterThanOrEqualTo(4));
      var previous = 0;
      for (final fact in decode) {
        expect(fact.totalBytes, payload.length);
        expect(fact.processedBytes, inInclusiveRange(previous, payload.length));
        previous = fact.processedBytes!;
      }
      expect(decode.last.processedBytes, payload.length);

      final verified = facts.lastWhere(
        (fact) => fact.stage == PocketPackagePreparationStage.verifyingFiles,
      );
      expect(verified.processedBytes, payload.length);
      expect(verified.processedFiles, 1);
      expect(verified.totalFiles, 1);
      final bytes = await files[hash]!.readAsBytes();
      expect(crypto.sha256.convert(bytes).toString(), hash);
      expect(bytes.length, payload.length);
      expect(bytes[12345], payload[12345]);
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
