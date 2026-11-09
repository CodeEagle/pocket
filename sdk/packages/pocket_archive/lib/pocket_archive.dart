import 'package:flutter/services.dart';

/// Extracts ZIP and 7z archives into a caller-created empty directory.
///
/// ZIP supports the codecs and encryption retained by the original
/// `unzip_kit` package. 7z uses the vendored 7-Zip C decoder and supports
/// solid LZMA/LZMA2 archives. The output quota is enforced before extraction.
/// Filesystem work runs on a native worker queue and the future completes only
/// after extraction and integrity checks finish.
final class PocketNativeArchive {
  PocketNativeArchive._();

  static const MethodChannel _channel =
      MethodChannel('dev.pocketjs/pocket_archive');

  /// Extracts [archivePath] into an already-created empty [destinationPath].
  ///
  /// [maxOutputBytes] must be positive. For encrypted ZIP files, pass the
  /// password; `null` and an empty string mean no password. 7z encrypted
  /// archives are not supported by this extraction-only package.
  static Future<void> extract({
    required String archivePath,
    required String destinationPath,
    required int maxOutputBytes,
    String? password,
  }) async {
    if (archivePath.isEmpty || destinationPath.isEmpty) {
      throw ArgumentError('Archive and destination paths must not be empty.');
    }
    if (maxOutputBytes <= 0) {
      throw ArgumentError.value(
        maxOutputBytes,
        'maxOutputBytes',
        'Must be greater than zero.',
      );
    }
    await _channel.invokeMethod<void>('extract', <String, Object?>{
      'archivePath': archivePath,
      'destinationPath': destinationPath,
      'maxOutputBytes': maxOutputBytes,
      if (password != null) 'password': password,
    });
  }
}
