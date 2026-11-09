# pocket_archive

`pocket_archive` is the single native file-extraction package used by Pocket
Flutter hosts and the FunApp `unzip_kit` compatibility shim. Flutter passes file
paths and a byte quota over a method channel; archive data is not copied through
Dart.

```dart
await PocketNativeArchive.extract(
  archivePath: archiveFile.path,
  destinationPath: emptyPrivateStage.path,
  maxOutputBytes: 768 * 1024 * 1024,
  password: zipPassword,
);
```

The destination must already exist as an empty, non-symlink directory. The
caller owns its staging and publication transaction and must delete the stage
after a failed extraction. The native method completes only after extraction,
integrity checks, and output close finish. A positive `maxOutputBytes` is
required and enforced before extraction where archive metadata allows, then
again while writing.

## Formats and platform support

- ZIP: the retained 7-Zip ZIP handler, with password support for the retained
  ZIP encryption modes. Traversal, links, duplicate paths, case-fold collisions,
  and quota excess are rejected.
- 7z: the 7-Zip 26.05 C decoder, including solid LZMA/LZMA2. Encrypted 7z
  archives are unsupported. A solid folder is decoded once and reused as the
  cache for subsequent files.
- Flutter plugin targets: Android, iOS, and macOS. The Android, Apple, and macOS
  bridges execute native work off the platform UI queue.

Archive names are limited to 4096 UTF-8 bytes and 100,000 entries. Duplicate
path folding is ASCII case-insensitive, matching the existing ZIP wrapper's
cross-platform checks. Directory and file entries cannot shadow each other.

## Native smoke driver

The smoke driver accepts an archive, an empty staging directory, a positive
output-byte quota, and an optional ZIP password:

```sh
cmake -S native -B /tmp/pocket-archive-native \
  -DPOCKET_ARCHIVE_BUILD_SMOKE_TEST=ON -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/pocket-archive-native --parallel 4
/tmp/pocket-archive-native/pocket_archive_smoke \
  ARCHIVE_PATH EMPTY_STAGE_PATH 805306368 [ZIP_PASSWORD]
```

The repository regression runner exercises the tracked 7z fixtures and ZIP
password, traversal, symlink, duplicate-name, and quota cases:

```sh
python3 native/tests/regression.py /tmp/pocket-archive-native/pocket_archive_smoke
```

`native/UPSTREAM-7ZIP-26.05.txt` records the upstream source archive hash,
retained FunApp ZIP source paths, local adaptations, and decoder coverage.
