import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pocket_services/pocket_services.dart'
    show PocketCapabilityException;

/// Metadata for one immutable, app-private captured PNG.
final class PocketStoredImage {
  const PocketStoredImage({
    required this.id,
    required this.width,
    required this.height,
    required this.pngBytes,
  });

  final String id;
  final int width;
  final int height;
  final Uint8List pngBytes;
}

/// Small content-addressed PNG storage for app-owned image references.
///
/// App IDs are hashed before they enter the path, image IDs are SHA-256 hex
/// digests, and no image path is returned to a guest. There is no metadata
/// index: dimensions are read from the PNG IHDR and [list] scans the bounded
/// app directory. Writes are atomic and images are immutable.
final class PocketImageStore {
  PocketImageStore({
    required Directory directory,
    this.maxImageBytes = 512 * 1024,
    this.maxAppBytes = 32 * 1024 * 1024,
    this.maxImagesPerApp = 256,
  }) : _directory = directory.absolute {
    if (maxImageBytes <= 0 ||
        maxAppBytes <= 0 ||
        maxImagesPerApp <= 0 ||
        maxImageBytes > maxAppBytes) {
      throw ArgumentError('image store quotas must be positive and ordered');
    }
  }

  static const int maxWidth = 256;
  static const int maxHeight = 256;
  static const String _pngSuffix = '.png';
  static const String _tmpSuffix = '.tmp';
  static final RegExp _appIdPattern = RegExp(
    r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
  );
  static final RegExp _imageIdPattern = RegExp(r'^[0-9a-f]{64}$');

  final Directory _directory;
  final int maxImageBytes;
  final int maxAppBytes;
  final int maxImagesPerApp;
  Future<void> _operationTail = Future<void>.value();
  bool _closingRequested = false;
  bool _closed = false;
  int _temporarySequence = 0;

  Future<PocketStoredImage> put(String appId, Uint8List pngBytes) {
    _validateAppId(appId);
    if (pngBytes.length > maxImageBytes) {
      return Future<PocketStoredImage>.error(
        const PocketCapabilityException(
          'image_too_large',
          'Captured PNG exceeds the app image limit',
        ),
      );
    }
    final bytes = Uint8List.fromList(pngBytes);
    final dimensions = _readPngDimensions(bytes);
    if (dimensions == null) {
      return Future<PocketStoredImage>.error(
        const PocketCapabilityException(
          'invalid_image',
          'Captured data is not a supported PNG image',
        ),
      );
    }
    final id = sha256.convert(bytes).toString();
    return _serialize<PocketStoredImage>(() async {
      final appDirectory = (await _appDirectory(appId, create: true))!;
      final target = File(_imagePath(appDirectory, id));
      final targetType = await FileSystemEntity.type(
        target.path,
        followLinks: false,
      );
      if (targetType == FileSystemEntityType.link) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Image store contains a symbolic link at an image ID',
        );
      }
      if (targetType == FileSystemEntityType.file) {
        final existing = await _readImageFile(target, id);
        return existing;
      }
      if (targetType != FileSystemEntityType.notFound) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Image ID does not refer to a regular file',
        );
      }

      final entries = await _scan(appDirectory);
      final storedBytes = entries.fold<int>(
        0,
        (total, entry) => total + entry.bytes,
      );
      if (entries.length >= maxImagesPerApp ||
          storedBytes + bytes.length > maxAppBytes) {
        throw const PocketCapabilityException(
          'image_store_quota',
          'App image storage quota is full',
        );
      }

      Directory? temporaryDirectory;
      try {
        // Dart FileMode has no O_EXCL flag. A unique private temp directory
        // gives this write its own path without reusing a stale temp filename.
        temporaryDirectory = await appDirectory.createTemp('.capture-');
        final temporary = File(
          '${temporaryDirectory.path}${Platform.pathSeparator}'
          '${++_temporarySequence}$_tmpSuffix',
        );
        await temporary.writeAsBytes(bytes, flush: true);
        await temporary.rename(target.path);
      } on FileSystemException catch (error) {
        throw PocketCapabilityException(
          'image_store_unavailable',
          'Unable to commit captured PNG: ${error.message}',
        );
      } finally {
        if (temporaryDirectory != null && await temporaryDirectory.exists()) {
          try {
            await temporaryDirectory.delete(recursive: true);
          } on FileSystemException {
            // The image result remains governed by the atomic target write.
          }
        }
      }
      return PocketStoredImage(
        id: id,
        width: dimensions.width,
        height: dimensions.height,
        pngBytes: bytes,
      );
    });
  }

  Future<PocketStoredImage?> read(String appId, String id) {
    _validateAppId(appId);
    _validateImageId(id);
    return _serialize<PocketStoredImage?>(() async {
      final appDirectory = await _appDirectory(appId, create: false);
      if (appDirectory == null) return null;
      final file = File(_imagePath(appDirectory, id));
      final type = await FileSystemEntity.type(file.path, followLinks: false);
      if (type == FileSystemEntityType.notFound) return null;
      if (type != FileSystemEntityType.file) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Image ID does not refer to a regular file',
        );
      }
      return _readImageFile(file, id);
    });
  }

  Future<List<Map<String, Object?>>> list(String appId) {
    _validateAppId(appId);
    return _serialize<List<Map<String, Object?>>>(() async {
      final appDirectory = await _appDirectory(appId, create: false);
      if (appDirectory == null) return <Map<String, Object?>>[];
      final entries = await _scan(appDirectory);
      return <Map<String, Object?>>[
        for (final entry in entries)
          <String, Object?>{
            'id': entry.id,
            'width': entry.width,
            'height': entry.height,
          },
      ];
    });
  }

  Future<bool> remove(String appId, String id) {
    _validateAppId(appId);
    _validateImageId(id);
    return _serialize<bool>(() async {
      final appDirectory = await _appDirectory(appId, create: false);
      if (appDirectory == null) return false;
      final file = File(_imagePath(appDirectory, id));
      final type = await FileSystemEntity.type(file.path, followLinks: false);
      if (type == FileSystemEntityType.notFound) return false;
      if (type != FileSystemEntityType.file) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Image ID does not refer to a regular file',
        );
      }
      await file.delete();
      return true;
    });
  }

  Future<void> close() async {
    if (_closed) return;
    _closingRequested = true;
    await _operationTail;
    _closed = true;
  }

  Future<T> _serialize<T>(Future<T> Function() operation) {
    if (_closingRequested || _closed) {
      return Future<T>.error(
        const PocketCapabilityException(
          'image_store_closed',
          'Image store is closed',
        ),
      );
    }
    final result = Completer<T>();
    final next = _operationTail.then((_) async {
      try {
        if (_closed) {
          throw const PocketCapabilityException(
            'image_store_closed',
            'Image store is closed',
          );
        }
        result.complete(await operation());
      } on FileSystemException catch (error, stackTrace) {
        result.completeError(
          PocketCapabilityException(
            'image_store_unavailable',
            'Image store IO failed: ${error.message}',
          ),
          stackTrace,
        );
      } on Object catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    });
    _operationTail = next.catchError((Object _) {});
    return result.future;
  }

  Future<Directory?> _appDirectory(String appId, {required bool create}) async {
    final rootType = await FileSystemEntity.type(
      _directory.path,
      followLinks: false,
    );
    if (rootType == FileSystemEntityType.link) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Image store root must not be a symbolic link',
      );
    }
    if (rootType == FileSystemEntityType.notFound) {
      if (!create) return null;
      await _directory.create(recursive: true);
    } else if (rootType != FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Image store root is not a directory',
      );
    }
    final checkedRootType = await FileSystemEntity.type(
      _directory.path,
      followLinks: false,
    );
    if (checkedRootType != FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Image store root is not a safe directory',
      );
    }

    final appKey = sha256.convert(utf8.encode(appId)).toString();
    final appDirectory = Directory(
      '${_directory.path}${Platform.pathSeparator}$appKey',
    );
    final appType = await FileSystemEntity.type(
      appDirectory.path,
      followLinks: false,
    );
    if (appType == FileSystemEntityType.link) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'App image directory must not be a symbolic link',
      );
    }
    if (appType == FileSystemEntityType.notFound) {
      if (!create) return null;
      await appDirectory.create();
    } else if (appType != FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'App image path is not a directory',
      );
    }
    if (await FileSystemEntity.type(appDirectory.path, followLinks: false) !=
        FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'App image directory is not safe',
      );
    }
    return appDirectory;
  }

  Future<List<_ImageEntry>> _scan(Directory directory) async {
    final entries = <_ImageEntry>[];
    await for (final entity in directory.list(followLinks: false)) {
      if (await FileSystemEntity.type(entity.path, followLinks: false) !=
          FileSystemEntityType.file) {
        continue;
      }
      final name = entity.uri.pathSegments.isEmpty
          ? ''
          : entity.uri.pathSegments.last;
      if (!name.endsWith(_pngSuffix)) continue;
      final id = name.substring(0, name.length - _pngSuffix.length);
      if (!_imageIdPattern.hasMatch(id)) continue;
      final file = File(entity.path);
      final length = await file.length();
      if (length <= 0 || length > maxImageBytes) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Stored PNG size is outside the image limit',
        );
      }
      final bytes = await _readPrefix(file, 24);
      if (length < 33) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Stored PNG is truncated',
        );
      }
      final dimensions = _readPngDimensions(bytes, allowShortRead: true);
      if (dimensions == null) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Stored image has an invalid PNG header',
        );
      }
      entries.add(
        _ImageEntry(
          id: id,
          width: dimensions.width,
          height: dimensions.height,
          bytes: length,
        ),
      );
      if (entries.length > maxImagesPerApp) {
        throw const PocketCapabilityException(
          'image_store_corrupt',
          'Image store contains more entries than its quota',
        );
      }
    }
    entries.sort((left, right) => left.id.compareTo(right.id));
    return entries;
  }

  Future<PocketStoredImage> _readImageFile(File file, String id) async {
    final length = await file.length();
    if (length <= 0 || length > maxImageBytes) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Stored PNG size is outside the image limit',
      );
    }
    final bytes = await file.readAsBytes();
    if (sha256.convert(bytes).toString() != id) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Stored PNG does not match its content ID',
      );
    }
    final dimensions = _readPngDimensions(bytes);
    if (dimensions == null) {
      throw const PocketCapabilityException(
        'image_store_corrupt',
        'Stored PNG header is invalid',
      );
    }
    return PocketStoredImage(
      id: id,
      width: dimensions.width,
      height: dimensions.height,
      pngBytes: bytes,
    );
  }

  Future<Uint8List> _readPrefix(File file, int maxBytes) async {
    RandomAccessFile? handle;
    try {
      handle = await file.open(mode: FileMode.read);
      return Uint8List.fromList(await handle.read(maxBytes));
    } on FileSystemException catch (error) {
      throw PocketCapabilityException(
        'image_store_unavailable',
        'Unable to inspect stored PNG: ${error.message}',
      );
    } finally {
      await handle?.close();
    }
  }

  String _imagePath(Directory appDirectory, String id) {
    return '${appDirectory.path}${Platform.pathSeparator}$id$_pngSuffix';
  }

  void _validateAppId(String appId) {
    if (!_appIdPattern.hasMatch(appId)) {
      throw const PocketCapabilityException(
        'invalid_app_id',
        'App ID is not a valid image-store scope',
      );
    }
  }

  void _validateImageId(String id) {
    if (!_imageIdPattern.hasMatch(id)) {
      throw const PocketCapabilityException(
        'invalid_image_id',
        'Image ID must be a lowercase SHA-256 digest',
      );
    }
  }

  static _ImageDimensions? _readPngDimensions(
    Uint8List bytes, {
    bool allowShortRead = false,
  }) {
    const signature = <int>[137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 ||
        !allowShortRead && bytes.length < 33 ||
        !bytes.startsWith(signature) ||
        bytes[8] != 0 ||
        bytes[9] != 0 ||
        bytes[10] != 0 ||
        bytes[11] != 13 ||
        bytes[12] != 73 ||
        bytes[13] != 72 ||
        bytes[14] != 68 ||
        bytes[15] != 82) {
      return null;
    }
    final data = ByteData.sublistView(bytes);
    final width = data.getUint32(16, Endian.big);
    final height = data.getUint32(20, Endian.big);
    if (width <= 0 ||
        height <= 0 ||
        width > maxWidth ||
        height > maxHeight ||
        width * height > maxWidth * maxHeight) {
      return null;
    }
    return _ImageDimensions(width, height);
  }
}

class _ImageDimensions {
  const _ImageDimensions(this.width, this.height);

  final int width;
  final int height;
}

final class _ImageEntry {
  const _ImageEntry({
    required this.width,
    required this.height,
    required this.id,
    required this.bytes,
  });

  final int width;
  final int height;
  final String id;
  final int bytes;
}

extension on Uint8List {
  bool startsWith(List<int> prefix) {
    if (length < prefix.length) return false;
    for (var index = 0; index < prefix.length; index++) {
      if (this[index] != prefix[index]) return false;
    }
    return true;
  }
}
