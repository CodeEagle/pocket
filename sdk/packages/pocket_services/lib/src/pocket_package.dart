import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as path;
import 'package:pocket_flutter/src/pocket_package.dart'
    show PocketPackageSource;

import 'pocket_guest_manifest.dart';

final class PocketPackageException implements Exception {
  const PocketPackageException(this.message, {this.code = 'package'});

  final String message;
  final String code;

  @override
  String toString() => 'PocketPackageException($code): $message';
}

final class PocketPackageFormatException extends PocketPackageException {
  const PocketPackageFormatException(
    super.message, {
    super.code = 'manifest-format',
  });
}

final class PocketUpdateCancellation implements Exception {
  const PocketUpdateCancellation();

  @override
  String toString() => 'Pocket update was cancelled';
}

final class PocketCancellationToken {
  final Completer<void> _cancelledCompleter = Completer<void>();
  bool _cancelled = false;

  bool get isCancelled => _cancelled;
  Future<void> get whenCancelled => _cancelledCompleter.future;

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    _cancelledCompleter.complete();
  }

  void throwIfCancelled() {
    if (_cancelled) throw const PocketUpdateCancellation();
  }
}

final class PocketManifestFile {
  const PocketManifestFile({
    required this.sha256,
    required this.size,
    required this.url,
  });

  factory PocketManifestFile.fromJson(Object? value) {
    final json = _object(value, 'manifest file');
    return PocketManifestFile(
      sha256: _hash(json['sha256'], 'files.sha256'),
      size: _int(json['size'], 'files.size'),
      url: _string(json['url'], 'files.url'),
    );
  }

  final String sha256;
  final int size;
  final String url;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'sha256': sha256,
    'size': size,
    'url': url,
  };
}

final class PocketManifestEntry {
  const PocketManifestEntry({required this.sha256, required this.size});

  factory PocketManifestEntry.fromJson(Object? value) {
    final json = _object(value, 'manifest entry');
    return PocketManifestEntry(
      sha256: _hash(json['sha256'], 'entry.sha256'),
      size: _int(json['size'], 'entry.size'),
    );
  }

  final String sha256;
  final int size;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'sha256': sha256,
    'size': size,
  };
}

final class PocketPakPart {
  const PocketPakPart({
    required this.offset,
    required this.sha256,
    required this.size,
  });

  factory PocketPakPart.fromJson(Object? value) {
    final json = _object(value, 'pak part');
    return PocketPakPart(
      offset: _int(json['offset'], 'pak.parts.offset'),
      sha256: _hash(json['sha256'], 'pak.parts.sha256'),
      size: _int(json['size'], 'pak.parts.size'),
    );
  }

  final int offset;
  final String sha256;
  final int size;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'offset': offset,
    'sha256': sha256,
    'size': size,
  };
}

final class PocketPakManifest {
  const PocketPakManifest({
    required this.sha256,
    required this.size,
    required this.parts,
  });

  factory PocketPakManifest.fromJson(Object? value) {
    final json = _object(value, 'manifest pak');
    final rawParts = json['parts'];
    if (rawParts is! List || rawParts.isEmpty) {
      throw const PocketPackageException(
        'manifest pak.parts must be non-empty',
      );
    }
    return PocketPakManifest(
      sha256: _hash(json['sha256'], 'pak.sha256'),
      size: _int(json['size'], 'pak.size'),
      parts: List<PocketPakPart>.unmodifiable(
        rawParts.map(PocketPakPart.fromJson),
      ),
    );
  }

  final String sha256;
  final int size;
  final List<PocketPakPart> parts;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'sha256': sha256,
    'size': size,
    'parts': parts.map((part) => part.toJson()).toList(growable: false),
  };
}

final class PocketManifestAsset {
  const PocketManifestAsset({required this.sha256, required this.size});

  factory PocketManifestAsset.fromJson(Object? value) {
    final json = _object(value, 'manifest asset');
    return PocketManifestAsset(
      sha256: _hash(json['sha256'], 'assets.sha256'),
      size: _int(json['size'], 'assets.size'),
    );
  }

  final String sha256;
  final int size;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'sha256': sha256,
    'size': size,
  };
}

/// Exact JSON payload signed by the Ed25519 envelope.
///
/// `entryFormat` is deliberately part of the signed payload. A bytecode entry
/// is never passed through a UTF-8 source evaluator, and `runtimeAbi` binds it
/// to the host's actual QuickJS build.
final class PocketPackageManifest {
  const PocketPackageManifest({
    required this.schemaVersion,
    required this.appId,
    required this.version,
    required this.build,
    required this.protocol,
    required this.minHostVersion,
    required this.entry,
    required this.pak,
    required this.files,
    this.entryFormat = 'bytecode',
    this.runtimeAbi,
    this.assets = const <String, PocketManifestAsset>{},
    this.guestManifest = const PocketGuestManifest(),
  });

  factory PocketPackageManifest.fromJson(Object? value) {
    final json = _object(value, 'manifest payload');
    final rawFiles = json['files'];
    if (rawFiles is! List || rawFiles.isEmpty) {
      throw const PocketPackageException('manifest files must be non-empty');
    }
    final rawAssets = json['assets'];
    final assets = <String, PocketManifestAsset>{};
    if (rawAssets != null) {
      final map = _object(rawAssets, 'manifest assets');
      for (final item in map.entries) {
        if (item.key.isEmpty)
          throw const PocketPackageException('asset name must not be empty');
        assets[item.key] = PocketManifestAsset.fromJson(item.value);
      }
    }
    // Guest declaration is top-level to keep it part of the package contract,
    // while `guest` remains accepted for early development manifests.
    final guestJson = json['guest'] ?? json;
    return PocketPackageManifest(
      schemaVersion: _int(json['schemaVersion'], 'schemaVersion'),
      appId: _string(json['appId'], 'appId'),
      version: _string(json['version'], 'version'),
      build: _int(json['build'], 'build'),
      protocol: _int(json['protocol'], 'protocol'),
      minHostVersion: _int(json['minHostVersion'], 'minHostVersion'),
      entry: PocketManifestEntry.fromJson(json['entry']),
      pak: PocketPakManifest.fromJson(json['pak']),
      files: List<PocketManifestFile>.unmodifiable(
        rawFiles.map(PocketManifestFile.fromJson),
      ),
      entryFormat: json['entryFormat'] is String
          ? json['entryFormat'] as String
          : 'bytecode',
      runtimeAbi: json['runtimeAbi'] is String
          ? json['runtimeAbi'] as String
          : null,
      assets: Map<String, PocketManifestAsset>.unmodifiable(assets),
      guestManifest: PocketGuestManifest.fromJson(guestJson),
    );
  }

  final int schemaVersion;
  final String appId;
  final String version;
  final int build;
  final int protocol;
  final int minHostVersion;
  final PocketManifestEntry entry;
  final String entryFormat;
  final String? runtimeAbi;
  final PocketPakManifest pak;
  final List<PocketManifestFile> files;
  final Map<String, PocketManifestAsset> assets;
  final PocketGuestManifest guestManifest;

  bool get isBytecode =>
      entryFormat == 'quickjs-bytecode' || entryFormat == 'bytecode';

  Map<String, dynamic> toJson() {
    final sortedAssets = <String, dynamic>{};
    for (final name in assets.keys.toList()..sort()) {
      sortedAssets[name] = assets[name]!.toJson();
    }
    return <String, dynamic>{
      'schemaVersion': schemaVersion,
      'appId': appId,
      'version': version,
      'build': build,
      'protocol': protocol,
      'minHostVersion': minHostVersion,
      'entry': entry.toJson(),
      'entryFormat': entryFormat,
      if (runtimeAbi != null) 'runtimeAbi': runtimeAbi,
      'pak': pak.toJson(),
      'files': files.map((file) => file.toJson()).toList(growable: false),
      if (sortedAssets.isNotEmpty) 'assets': sortedAssets,
      ...guestManifest.toJson(),
    };
  }

  String get contentHash =>
      crypto.sha256.convert(utf8.encode(jsonEncode(toJson()))).toString();

  Map<String, PocketManifestFile> get filesByHash {
    final result = <String, PocketManifestFile>{};
    for (final file in files) {
      final old = result[file.sha256];
      if (old != null && (old.size != file.size || old.url != file.url)) {
        throw PocketPackageException(
          'conflicting file ${file.sha256}',
          code: 'manifest-duplicate',
        );
      }
      result[file.sha256] = file;
    }
    return result;
  }

  void validate({
    required String expectedAppId,
    required int hostVersion,
    int expectedProtocol = 1,
    int maxFileBytes = 256 * 1024 * 1024,
    int maxEntryBytes = 16 * 1024 * 1024,
    int maxPakBytes = 256 * 1024 * 1024,
    int maxTotalBytes = 768 * 1024 * 1024,
  }) {
    if (schemaVersion != 1) {
      throw PocketPackageException(
        'unsupported manifest schemaVersion $schemaVersion',
        code: 'manifest-schema',
      );
    }
    if (appId != expectedAppId) {
      throw PocketPackageException(
        'manifest appId $appId does not match $expectedAppId',
        code: 'manifest-app',
      );
    }
    if (protocol != expectedProtocol) {
      throw PocketPackageException(
        'unsupported package protocol $protocol',
        code: 'manifest-protocol',
      );
    }
    if (minHostVersion > hostVersion) {
      throw PocketPackageException(
        'package needs host version $minHostVersion',
        code: 'host-version',
      );
    }
    if (entryFormat != 'javascript' &&
        entryFormat != 'quickjs-bytecode' &&
        entryFormat != 'bytecode') {
      throw PocketPackageException(
        'unsupported entryFormat $entryFormat',
        code: 'manifest-entry-format',
      );
    }
    if (isBytecode &&
        (runtimeAbi == null || runtimeAbi!.trim().isEmpty)) {
      throw const PocketPackageException(
        'bytecode entry requires runtimeAbi',
        code: 'manifest-runtime-abi',
      );
    }
    final byHash = filesByHash;
    final entryFile = byHash[entry.sha256];
    if (entryFile == null || entryFile.size != entry.size) {
      throw const PocketPackageException(
        'entry must reference a matching files item',
        code: 'manifest-entry',
      );
    }
    if (entry.size > maxFileBytes || entry.size > maxEntryBytes) {
      throw const PocketPackageException(
        'entry exceeds configured size limits',
        code: 'manifest-entry-size',
      );
    }
    if (pak.size > maxPakBytes) {
      throw const PocketPackageException(
        'pak exceeds configured size limit',
        code: 'manifest-size',
      );
    }
    final parts = [...pak.parts]..sort((a, b) => a.offset.compareTo(b.offset));
    var cursor = 0;
    for (final part in parts) {
      if (part.offset != cursor || part.size <= 0 || part.size > maxFileBytes) {
        throw const PocketPackageException(
          'pak parts must be ordered and gap-free',
          code: 'manifest-parts',
        );
      }
      final file = byHash[part.sha256];
      if (file == null || file.size != part.size) {
        throw PocketPackageException(
          'pak part ${part.sha256} is not in files',
          code: 'manifest-parts',
        );
      }
      cursor += part.size;
    }
    if (cursor != pak.size) {
      throw const PocketPackageException(
        'pak parts do not cover pak.size',
        code: 'manifest-parts',
      );
    }
    for (final item in assets.entries) {
      _validateAssetName(item.key);
      final file = byHash[item.value.sha256];
      if (file == null || file.size != item.value.size) {
        throw PocketPackageException(
          'asset ${item.key} is not in files',
          code: 'manifest-assets',
        );
      }
    }
    final total = byHash.values.fold<int>(0, (sum, file) => sum + file.size);
    if (total > maxTotalBytes ||
        byHash.values.any(
          (file) => file.size > maxFileBytes || file.url.isEmpty,
        )) {
      throw const PocketPackageException(
        'manifest files exceed configured size limits',
        code: 'manifest-size',
      );
    }
  }
}

final class PocketSignedManifest {
  const PocketSignedManifest({
    required this.keyId,
    required this.payloadBytes,
    required this.signatureBytes,
    required this.payload,
    required this.envelopeBytes,
  });

  factory PocketSignedManifest.fromBytes(Uint8List bytes) {
    final envelope = _object(
      jsonDecode(utf8.decode(bytes)),
      'signed manifest envelope',
    );
    final keyId = _string(envelope['keyId'], 'keyId');
    final payloadText = _string(envelope['payload'], 'payload');
    final signatureText = _string(envelope['signature'], 'signature');
    try {
      final payloadBytes = Uint8List.fromList(base64.decode(payloadText));
      final signatureBytes = Uint8List.fromList(base64.decode(signatureText));
      return PocketSignedManifest(
        keyId: keyId,
        payloadBytes: payloadBytes,
        signatureBytes: signatureBytes,
        payload: PocketPackageManifest.fromJson(
          jsonDecode(utf8.decode(payloadBytes)),
        ),
        envelopeBytes: Uint8List.fromList(bytes),
      );
    } on FormatException catch (error) {
      throw PocketPackageException(
        'invalid signed manifest encoding: $error',
        code: 'manifest-encoding',
      );
    }
  }

  final String keyId;
  final Uint8List payloadBytes;
  final Uint8List signatureBytes;
  final PocketPackageManifest payload;
  final Uint8List envelopeBytes;

  Future<void> verify({required Map<String, List<int>> trustedKeys}) async {
    final keyBytes = trustedKeys[keyId];
    if (keyBytes == null ||
        keyBytes.length != 32 ||
        signatureBytes.length != 64) {
      throw const PocketPackageException(
        'untrusted or malformed Ed25519 key',
        code: 'manifest-signature',
      );
    }
    final valid = await Ed25519().verify(
      payloadBytes,
      signature: Signature(
        signatureBytes,
        publicKey: SimplePublicKey(keyBytes, type: KeyPairType.ed25519),
      ),
    );
    if (!valid)
      throw const PocketPackageException(
        'manifest signature is invalid',
        code: 'manifest-signature',
      );
  }
}

final class PocketPackage {
  const PocketPackage({
    required this.manifest,
    required this.versionId,
    required this.directory,
  });

  final PocketSignedManifest manifest;
  final String versionId;
  final Directory directory;

  File get entryFile => File(path.join(directory.path, 'entry.js'));
  File get pakFile => File(path.join(directory.path, 'package.pak'));

  /// The renderer's source value object is the only package-source type.
  PocketPackageSource get source => PocketPackageSource(
    entryPath: entryFile.path,
    pakPath: pakFile.path,
    entryFormat: manifest.payload.entryFormat,
    runtimeAbi: manifest.payload.runtimeAbi,
    assetPaths: <String, String>{
      for (final name in manifest.payload.assets.keys)
        name: path.join(directory.path, 'loose-assets', name),
    },
  );

  Future<PocketPackageArtifact> readArtifact() async {
    final bytes = Uint8List.fromList(await entryFile.readAsBytes());
    return PocketPackageArtifact(
      package: this,
      entryBytes: bytes,
      entrySource: manifest.payload.isBytecode ? null : utf8.decode(bytes),
      pakBytes: Uint8List.fromList(await pakFile.readAsBytes()),
    );
  }
}

final class PocketPackageArtifact {
  const PocketPackageArtifact({
    required this.package,
    required this.entryBytes,
    required this.entrySource,
    required this.pakBytes,
  });

  final PocketPackage package;
  final Uint8List entryBytes;
  final String? entrySource;
  final Uint8List pakBytes;
}

final class PocketVersionInfo {
  const PocketVersionInfo({
    required this.package,
    required this.isActive,
    required this.isPrevious,
    required this.isLastGood,
  });

  final PocketPackage package;
  final bool isActive;
  final bool isPrevious;
  final bool isLastGood;

  String get versionId => package.versionId;
  String get version => package.manifest.payload.version;
  int get build => package.manifest.payload.build;
  String get contentHash => package.manifest.payload.contentHash;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'versionId': versionId,
    'version': version,
    'build': build,
    'contentHash': contentHash,
    'entryFormat': package.manifest.payload.entryFormat,
    'runtimeAbi': package.manifest.payload.runtimeAbi,
    'active': isActive,
    'previous': isPrevious,
    'lastGood': isLastGood,
  };
}

final class PocketPackageStore {
  const PocketPackageStore(this.rootDirectory, {this.appId});

  final Directory rootDirectory;
  final String? appId;

  PocketPackageStore scoped(String applicationId) {
    if (applicationId.trim().isEmpty)
      throw const PocketPackageException('app id must not be empty');
    return PocketPackageStore(rootDirectory, appId: applicationId);
  }

  static int _tempCounter = 0;
  static final Map<String, Future<void>> _locks = <String, Future<void>>{};

  Future<T> _synchronized<T>(Future<T> Function() action) {
    final key = path.canonicalize(_stateRoot.path);
    final previousLock = _locks[key] ?? Future<void>.value();
    final completer = Completer<T>();
    final nextLock = previousLock.whenComplete(() async {
      try {
        final result = await action();
        completer.complete(result);
      } catch (e, st) {
        completer.completeError(e, st);
      }
    });
    _locks[key] = nextLock;
    nextLock.whenComplete(() {
      if (_locks[key] == nextLock) {
        _locks.remove(key);
      }
    });
    return completer.future;
  }

  static const Set<String> _allowedPointerNames = <String>{
    'active',
    'previous',
    'lastGood',
  };

  static String _requirePointerName(String name) {
    final safe = _requireSafeToken(name, 'pointerName');
    if (!_allowedPointerNames.contains(safe)) {
      throw PocketPackageException(
        'unknown pointer name: $name',
        code: 'unsafe-token',
      );
    }
    return safe;
  }

  Directory get _blobs => Directory(path.join(rootDirectory.path, 'blobs'));
  Directory get _stateRoot => appId == null
      ? rootDirectory
      : Directory(path.join(rootDirectory.path, 'apps', _safePart(appId!)));
  Directory get _versions => Directory(path.join(_stateRoot.path, 'versions'));
  File _pointer(String name) =>
      File(path.join(_stateRoot.path, _requirePointerName(name)));

  Future<void> initialize() async {
    await _blobs.create(recursive: true);
    await _versions.create(recursive: true);
  }

  Future<File?> validBlob(
    PocketManifestFile file, {
    PocketCancellationToken? cancellation,
  }) async {
    await initialize();
    final candidate = File(path.join(_blobs.path, file.sha256));
    if (!await candidate.exists()) return null;
    try {
      if (await candidate.length() != file.size ||
          await _fileHash(candidate, cancellation) != file.sha256) {
        await candidate.delete();
        return null;
      }
      return candidate;
    } on FileSystemException {
      return null;
    }
  }

  Future<File> writeBlob({
    required PocketManifestFile file,
    required Stream<List<int>> bytes,
    required PocketCancellationToken cancellation,
    int maxBytes = 256 * 1024 * 1024,
    void Function(int received)? onBytes,
  }) async {
    await initialize();
    final cached = await validBlob(file, cancellation: cancellation);
    if (cached != null) return cached;
    if (file.size > maxBytes)
      throw const PocketPackageException(
        'file exceeds size limit',
        code: 'download-size',
      );
    final temporary = File(
      path.join(
        _blobs.path,
        '.${file.sha256}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
      ),
    );
    final sink = temporary.openWrite();
    final digests = <crypto.Digest>[];
    final converter = crypto.sha256.startChunkedConversion(
      ChunkedConversionSink<crypto.Digest>.withCallback(digests.addAll),
    );
    var received = 0;
    try {
      await for (final chunk in bytes) {
        cancellation.throwIfCancelled();
        received += chunk.length;
        if (received > file.size || received > maxBytes) {
          throw const PocketPackageException(
            'download exceeded declared size',
            code: 'download-size',
          );
        }
        sink.add(chunk);
        converter.add(chunk);
        onBytes?.call(received);
      }
      converter.close();
      await sink.flush();
      await sink.close();
      if (received != file.size || digests.single.toString() != file.sha256) {
        throw const PocketPackageException(
          'download hash or size mismatch',
          code: 'download-hash',
        );
      }
      final target = File(path.join(_blobs.path, file.sha256));
      try {
        return await temporary.rename(target.path);
      } catch (_) {
        if (await target.exists()) await target.delete();
        return await temporary.rename(target.path);
      }
    } catch (_) {
      await sink.close();
      if (await temporary.exists()) await temporary.delete();
      rethrow;
    }
  }

  Future<PocketPackage?> active({required PocketManifestVerifier verifier}) =>
      _readPointer('active', verifier);
  Future<PocketPackage?> previous({required PocketManifestVerifier verifier}) =>
      _readPointer('previous', verifier);
  Future<PocketPackage?> lastGood({required PocketManifestVerifier verifier}) =>
      _readPointer('lastGood', verifier);

  Future<PocketPackage> stage({
    required PocketSignedManifest signed,
    required PocketManifestVerifier verifier,
    required File entryBlob,
    required Map<String, File> blobs,
    required PocketCancellationToken cancellation,
  }) =>
      _synchronized(
        () => _stageUnlocked(
          signed: signed,
          verifier: verifier,
          entryBlob: entryBlob,
          blobs: blobs,
          cancellation: cancellation,
        ),
      );

  Future<PocketPackage> prepare(
    dynamic packageOrSigned, {
    PocketManifestVerifier? verifier,
    File? entryBlob,
    Map<String, File>? blobs,
    PocketCancellationToken? cancellation,
  }) =>
      _synchronized(() async {
        await initialize();
        if (packageOrSigned is PocketPackage) {
          final id = _versionId(packageOrSigned.manifest.payload);
          final directory = Directory(path.join(_versions.path, id));
          if (await directory.exists()) {
            return packageOrSigned;
          }
          if (verifier == null) {
            return packageOrSigned;
          }
          return _stageUnlocked(
            signed: packageOrSigned.manifest,
            verifier: verifier,
            entryBlob: entryBlob ?? packageOrSigned.entryFile,
            blobs: blobs ?? <String, File>{},
            cancellation: cancellation ?? PocketCancellationToken(),
          );
        } else if (packageOrSigned is PocketSignedManifest) {
          if (verifier == null ||
              entryBlob == null ||
              blobs == null ||
              cancellation == null) {
            throw ArgumentError(
              'verifier, entryBlob, blobs, and cancellation are required for PocketSignedManifest',
            );
          }
          return _stageUnlocked(
            signed: packageOrSigned,
            verifier: verifier,
            entryBlob: entryBlob,
            blobs: blobs,
            cancellation: cancellation,
          );
        }
        throw ArgumentError.value(packageOrSigned, 'packageOrSigned');
      });

  Future<PocketPackage> _stageUnlocked({
    required PocketSignedManifest signed,
    required PocketManifestVerifier verifier,
    required File entryBlob,
    required Map<String, File> blobs,
    required PocketCancellationToken cancellation,
  }) async {
    await initialize();
    final id = _versionId(signed.payload);
    final directory = Directory(path.join(_versions.path, id));
    if (await directory.exists()) {
      try {
        final loaded = await _loadVersion(id, verifier: verifier);
        if (loaded.manifest.payload.contentHash == signed.payload.contentHash) {
          return loaded;
        }
      } on Object {
        try {
          await directory.delete(recursive: true);
        } catch (_) {}
      }
    }
    await directory.create(recursive: true);
    try {
      await _writeAtomic(
        File(path.join(directory.path, 'manifest.json')),
        signed.envelopeBytes,
      );
      await _copyAtomic(entryBlob, File(path.join(directory.path, 'entry.js')));
      await _assemblePak(
        signed.payload,
        blobs,
        File(path.join(directory.path, 'package.pak')),
        cancellation,
      );
      for (final item in signed.payload.assets.entries) {
        final blob = blobs[item.value.sha256];
        if (blob == null) {
          throw PocketPackageException(
            'missing asset ${item.key}',
            code: 'asset-file',
          );
        }
        final target = File(
          path.join(directory.path, 'loose-assets', item.key),
        );
        await target.parent.create(recursive: true);
        await _copyAtomic(blob, target);
      }
      return PocketPackage(
        manifest: signed,
        versionId: id,
        directory: directory,
      );
    } on Object {
      try {
        await directory.delete(recursive: true);
      } catch (_) {}
      rethrow;
    }
  }

  Future<void> activate(
    PocketPackage package, {
    bool recordPrevious = true,
    int minimumBuild = 0,
    bool allowDowngrade = false,
  }) =>
      _synchronized(
        () => _activateUnlocked(
          package,
          recordPrevious: recordPrevious,
          minimumBuild: minimumBuild,
          allowDowngrade: allowDowngrade,
        ),
      );

  Future<void> _activateUnlocked(
    PocketPackage package, {
    bool recordPrevious = true,
    int minimumBuild = 0,
    bool allowDowngrade = false,
  }) async {
    _requireSafeToken(package.versionId, 'versionId');
    await initialize();
    await _checkAntiDowngradeUnlocked(
      package: package,
      minimumBuild: minimumBuild,
      allowDowngrade: allowDowngrade,
    );
    final active = _pointer('active');
    if (recordPrevious && await active.exists()) {
      final old = (await active.readAsString()).trim();
      if (old.isNotEmpty && old != package.versionId) {
        await _writeAtomic(_pointer('previous'), utf8.encode(old));
      }
    }
    await _writeAtomic(active, utf8.encode(package.versionId));
  }

  /// Commits active and lastGood only after a host reports a healthy first
  /// frame. This keeps a candidate from becoming the boot fallback early.
  Future<void> commitHealthy(
    PocketPackage package, {
    required PocketManifestVerifier verifier,
    int minimumBuild = 0,
    bool allowDowngrade = false,
  }) =>
      _synchronized(
        () => _commitHealthyUnlocked(
          package,
          verifier: verifier,
          minimumBuild: minimumBuild,
          allowDowngrade: allowDowngrade,
        ),
      );

  Future<void> _commitHealthyUnlocked(
    PocketPackage package, {
    required PocketManifestVerifier verifier,
    int minimumBuild = 0,
    bool allowDowngrade = false,
  }) async {
    _requireSafeToken(package.versionId, 'versionId');
    await _checkAntiDowngradeUnlocked(
      package: package,
      minimumBuild: minimumBuild,
      allowDowngrade: allowDowngrade,
    );
    final verified = await _loadVersion(package.versionId, verifier: verifier);
    if (verified.manifest.payload.contentHash !=
        package.manifest.payload.contentHash) {
      throw const PocketPackageException(
        'candidate package changed before health commit',
        code: 'cache-package',
      );
    }
    await _activateUnlocked(
      verified,
      minimumBuild: minimumBuild,
      allowDowngrade: allowDowngrade,
    );
    await _writeAtomic(_pointer('lastGood'), utf8.encode(verified.versionId));
    await _pruneInactiveVersionsUnlocked(keep: 2);
  }

  Future<int?> _readBuildForVersionId(String id) async {
    try {
      final safeId = _requireSafeToken(id, 'versionId');
      final manifestFile = File(
        path.join(_versions.path, safeId, 'manifest.json'),
      );
      if (!await manifestFile.exists()) return null;
      final bytes = await manifestFile.readAsBytes();
      final signed = PocketSignedManifest.fromBytes(
        Uint8List.fromList(bytes),
      );
      return signed.payload.build;
    } catch (_) {
      return null;
    }
  }

  Future<void> _checkAntiDowngradeUnlocked({
    required PocketPackage package,
    required int minimumBuild,
    required bool allowDowngrade,
  }) async {
    if (allowDowngrade) return;

    final activeId = await _readPointerId('active');
    final goodId = await _readPointerId('lastGood');

    int? activeBuild;
    if (activeId != null) {
      activeBuild = await _readBuildForVersionId(activeId);
    }

    int? goodBuild;
    if (goodId != null) {
      goodBuild = await _readBuildForVersionId(goodId);
    }

    final hasBaseline =
        minimumBuild > 0 || goodBuild != null || activeBuild != null;
    if (!hasBaseline) return;

    final floorBuild = math.max(
      minimumBuild,
      math.max(goodBuild ?? 0, activeBuild ?? 0),
    );

    final establishedIdsAtFloor = <String>{
      if (goodId != null && goodBuild != null && goodBuild == floorBuild)
        goodId,
      if (activeId != null && activeBuild != null && activeBuild == floorBuild)
        activeId,
    };

    final candidateBuild = package.manifest.payload.build;
    final candidateId = package.versionId;

    if (candidateBuild < floorBuild ||
        (candidateBuild == floorBuild &&
            (establishedIdsAtFloor.isEmpty ||
                !establishedIdsAtFloor.every((id) => id == candidateId)))) {
      throw PocketPackageFormatException(
        'Refusing downgrade or replay: package build $candidateBuild is not newer than current build $floorBuild',
      );
    }
  }

  Future<PocketPackage?> fallbackFor(
    String failedVersionId, {
    required PocketManifestVerifier verifier,
  }) async {
    final safeFailedId = _requireSafeToken(failedVersionId, 'failedVersionId');
    return _synchronized(
      () => _fallbackForUnlocked(safeFailedId, verifier: verifier),
    );
  }

  Future<PocketPackage?> _fallbackForUnlocked(
    String failedVersionId, {
    required PocketManifestVerifier verifier,
  }) async {
    final safeFailedId = _requireSafeToken(failedVersionId, 'failedVersionId');
    await initialize();
    final lastGoodId = await _readPointerId('lastGood');
    final previousId = await _readPointerId('previous');

    String? fallbackId;
    if (lastGoodId != null && lastGoodId != safeFailedId) {
      fallbackId = lastGoodId;
    } else if (previousId != null && previousId != safeFailedId) {
      fallbackId = previousId;
    }

    if (previousId == safeFailedId) {
      final prevFile = _pointer('previous');
      if (await prevFile.exists()) await prevFile.delete();
    }
    if (lastGoodId == safeFailedId) {
      final lgFile = _pointer('lastGood');
      if (fallbackId != null) {
        await _writeAtomic(lgFile, utf8.encode(fallbackId));
      } else if (await lgFile.exists()) {
        await lgFile.delete();
      }
    }

    PocketPackage? fallbackPackage;
    if (fallbackId != null) {
      try {
        fallbackPackage = await _loadVersion(fallbackId, verifier: verifier);
      } catch (_) {
        fallbackPackage = null;
        fallbackId = null;
      }
    }

    final activeFile = _pointer('active');
    if (fallbackPackage != null) {
      await _writeAtomic(activeFile, utf8.encode(fallbackPackage.versionId));
    } else {
      if (await activeFile.exists()) await activeFile.delete();
      final lgFile = _pointer('lastGood');
      if (await lgFile.exists()) await lgFile.delete();
    }

    final failedDir = Directory(path.join(_versions.path, safeFailedId));
    if (await failedDir.exists()) {
      try {
        await failedDir.delete(recursive: true);
      } catch (_) {}
    }

    return fallbackPackage;
  }

  /// Removes activation pointers while retaining verified version directories
  /// and shared blobs. Hosts use this after the immutable embedded package has
  /// passed its health check, so a later restart starts from the embedded
  /// package instead of an old OTA pointer.
  Future<void> clearActivation() =>
      _synchronized(() => _clearActivationUnlocked());

  Future<void> resetToEmbedded() => clearActivation();

  Future<void> _clearActivationUnlocked() async {
    await initialize();
    for (final name in <String>['active', 'previous', 'lastGood']) {
      final pointer = _pointer(name);
      if (await pointer.exists()) await pointer.delete();
    }
  }

  Future<void> rollback({
    String? versionId,
    required PocketManifestVerifier verifier,
  }) async {
    if (versionId != null) {
      _requireSafeToken(versionId, 'versionId');
    }
    return _synchronized(
      () => _rollbackUnlocked(versionId: versionId, verifier: verifier),
    );
  }

  Future<void> _rollbackUnlocked({
    String? versionId,
    required PocketManifestVerifier verifier,
  }) async {
    if (versionId != null) {
      _requireSafeToken(versionId, 'versionId');
    }
    final targetId =
        versionId ??
        (await _readPointerId('previous') ?? await _readPointerId('lastGood'));
    if (targetId == null) {
      throw const PocketPackageException(
        'no verified rollback target',
        code: 'rollback-missing',
      );
    }
    final target = await _loadVersion(targetId, verifier: verifier);
    final active = await _readPointerId('active');
    if (active != null && active != target.versionId) {
      await _writeAtomic(_pointer('previous'), utf8.encode(active));
    }
    await _writeAtomic(_pointer('active'), utf8.encode(target.versionId));
    await _writeAtomic(_pointer('lastGood'), utf8.encode(target.versionId));
  }

  Future<List<PocketVersionInfo>> listVersions({
    required PocketManifestVerifier verifier,
  }) async {
    await initialize();
    final active = await _readPointerId('active');
    final previous = await _readPointerId('previous');
    final lastGood = await _readPointerId('lastGood');
    final result = <PocketVersionInfo>[];
    await for (final entity in _versions.list(followLinks: false)) {
      if (entity is! Directory) continue;
      final id = path.basename(entity.path);
      final manifestFile = File(path.join(entity.path, 'manifest.json'));
      if (!await manifestFile.exists()) continue;
      try {
        final signed = PocketSignedManifest.fromBytes(
          Uint8List.fromList(await manifestFile.readAsBytes()),
        );
        await verifier.verify(signed);
        final package = PocketPackage(
          manifest: signed,
          versionId: id,
          directory: entity,
        );
        result.add(
          PocketVersionInfo(
            package: package,
            isActive: id == active,
            isPrevious: id == previous,
            isLastGood: id == lastGood,
          ),
        );
      } on Object {
        // Corrupt/incomplete versions are not exposed as selectable versions.
      }
    }
    result.sort(
      (a, b) => b.build != a.build
          ? b.build.compareTo(a.build)
          : b.versionId.compareTo(a.versionId),
    );
    return List<PocketVersionInfo>.unmodifiable(result);
  }

  Future<void> pruneInactiveVersions([
    String? applicationId,
    int keep = 2,
  ]) =>
      _synchronized(() {
        final target = applicationId != null ? scoped(applicationId) : this;
        return target._pruneInactiveVersionsUnlocked(keep: keep);
      });

  Future<void> _pruneInactiveVersionsUnlocked({int keep = 2}) async {
    if (!await _versions.exists()) return;
    final keepSet = <String>{};
    for (final name in ['active', 'previous', 'lastGood']) {
      final id = await _readPointerId(name);
      if (id != null) keepSet.add(id);
    }
    await for (final entity in _versions.list(followLinks: false)) {
      if (entity is Directory && !keepSet.contains(path.basename(entity.path))) {
        try {
          await entity.delete(recursive: true);
        } catch (_) {}
      }
    }
  }

  Future<PocketPackage?> _readPointer(
    String name,
    PocketManifestVerifier verifier,
  ) async {
    final id = await _readPointerId(name);
    if (id == null) return null;
    try {
      return await _loadVersion(id, verifier: verifier);
    } on Object {
      return null;
    }
  }

  Future<String?> _readPointerId(String name) async {
    _requirePointerName(name);
    final file = _pointer(name);
    if (!await file.exists()) return null;
    final id = (await file.readAsString()).trim();
    if (id.isEmpty) return null;
    try {
      return _requireSafeToken(id, 'versionPointer');
    } catch (_) {
      return null;
    }
  }

  Future<String?> readPointerId(String name) => _readPointerId(name);

  Future<PocketPackage> _loadVersion(
    String id, {
    required PocketManifestVerifier verifier,
  }) async {
    final safeId = _requireSafeToken(id, 'versionId');
    final directory = Directory(path.join(_versions.path, safeId));
    final manifestFile = File(path.join(directory.path, 'manifest.json'));
    final entry = File(path.join(directory.path, 'entry.js'));
    final pak = File(path.join(directory.path, 'package.pak'));
    if (!await manifestFile.exists() ||
        !await entry.exists() ||
        !await pak.exists()) {
      throw const PocketPackageException(
        'staged package is incomplete',
        code: 'cache-incomplete',
      );
    }
    final signed = PocketSignedManifest.fromBytes(
      Uint8List.fromList(await manifestFile.readAsBytes()),
    );
    await verifier.verify(signed);
    if (await entry.length() != signed.payload.entry.size ||
        await _fileHash(entry) != signed.payload.entry.sha256 ||
        await pak.length() != signed.payload.pak.size ||
        await _fileHash(pak) != signed.payload.pak.sha256) {
      throw const PocketPackageException(
        'staged package failed integrity validation',
        code: 'cache-hash',
      );
    }
    for (final item in signed.payload.assets.entries) {
      final file = File(path.join(directory.path, 'loose-assets', item.key));
      if (!await file.exists() ||
          await file.length() != item.value.size ||
          await _fileHash(file) != item.value.sha256) {
        throw PocketPackageException(
          'staged asset ${item.key} failed integrity validation',
          code: 'cache-assets',
        );
      }
    }
    return PocketPackage(manifest: signed, versionId: safeId, directory: directory);
  }

  Future<void> _assemblePak(
    PocketPackageManifest manifest,
    Map<String, File> blobs,
    File destination,
    PocketCancellationToken cancellation,
  ) async {
    final temporary = File(
      '${destination.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
    );
    final sink = temporary.openWrite();
    final digest = <crypto.Digest>[];
    final converter = crypto.sha256.startChunkedConversion(
      ChunkedConversionSink<crypto.Digest>.withCallback(digest.addAll),
    );
    try {
      for (final part in [
        ...manifest.pak.parts,
      ]..sort((a, b) => a.offset.compareTo(b.offset))) {
        cancellation.throwIfCancelled();
        final blob = blobs[part.sha256];
        if (blob == null || await blob.length() != part.size) {
          throw PocketPackageException(
            'missing PAK part ${part.sha256}',
            code: 'pak-part',
          );
        }
        await for (final chunk in blob.openRead()) {
          cancellation.throwIfCancelled();
          sink.add(chunk);
          converter.add(chunk);
        }
      }
      converter.close();
      await sink.flush();
      await sink.close();
      if (await temporary.length() != manifest.pak.size ||
          digest.single.toString() != manifest.pak.sha256) {
        throw const PocketPackageException(
          'assembled PAK hash mismatch',
          code: 'pak-hash',
        );
      }
      try {
        await temporary.rename(destination.path);
      } catch (_) {
        if (await destination.exists()) await destination.delete();
        await temporary.rename(destination.path);
      }
    } catch (_) {
      await sink.close();
      if (await temporary.exists()) await temporary.delete();
      rethrow;
    }
  }

  Future<void> _copyAtomic(File source, File destination) async {
    final temporary = File(
      '${destination.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
    );
    await source.openRead().pipe(temporary.openWrite());
    try {
      await temporary.rename(destination.path);
    } catch (_) {
      if (await destination.exists()) await destination.delete();
      await temporary.rename(destination.path);
    }
  }

  Future<void> _writeAtomic(File destination, List<int> bytes) async {
    await destination.parent.create(recursive: true);
    final temporary = File(
      '${destination.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
    );
    await temporary.writeAsBytes(bytes, flush: true);
    try {
      await temporary.rename(destination.path);
    } catch (_) {
      if (await destination.exists()) await destination.delete();
      await temporary.rename(destination.path);
    }
  }
}

final class PocketManifestVerifier {
  const PocketManifestVerifier({
    required this.trustedKeys,
    required this.appId,
    this.hostVersion = 1,
    this.expectedProtocol = 1,
    this.maxFileBytes = 256 * 1024 * 1024,
    this.maxEntryBytes = 16 * 1024 * 1024,
    this.maxPakBytes = 256 * 1024 * 1024,
    this.maxTotalBytes = 768 * 1024 * 1024,
    this.expectedRuntimeAbi,
    this.requireBytecode = false,
  });

  final Map<String, List<int>> trustedKeys;
  final String appId;
  final int hostVersion;
  final int expectedProtocol;
  final int maxFileBytes;
  final int maxEntryBytes;
  final int maxPakBytes;
  final int maxTotalBytes;
  final String? expectedRuntimeAbi;
  final bool requireBytecode;

  Future<void> verify(PocketSignedManifest signed) async {
    await signed.verify(trustedKeys: trustedKeys);
    signed.payload.validate(
      expectedAppId: appId,
      hostVersion: hostVersion,
      expectedProtocol: expectedProtocol,
      maxFileBytes: maxFileBytes,
      maxEntryBytes: maxEntryBytes,
      maxPakBytes: maxPakBytes,
      maxTotalBytes: maxTotalBytes,
    );
    if (requireBytecode && !signed.payload.isBytecode) {
      throw const PocketPackageException(
        'host requires QuickJS bytecode',
        code: 'manifest-entry-format',
      );
    }
    if (signed.payload.isBytecode &&
        expectedRuntimeAbi != null &&
        signed.payload.runtimeAbi != expectedRuntimeAbi) {
      throw PocketPackageException(
        'package runtimeAbi ${signed.payload.runtimeAbi} does not match host $expectedRuntimeAbi',
        code: 'manifest-runtime-abi',
      );
    }
  }
}

String pocketVersionId(PocketPackageManifest manifest) {
  final version = manifest.version.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
  final safe = version.isEmpty
      ? 'version'
      : version.substring(0, math.min(48, version.length));
  return '$safe-${manifest.build}-${manifest.contentHash}';
}

String _versionId(PocketPackageManifest manifest) => pocketVersionId(manifest);

String _requireSafeToken(String value, String field) {
  final trimmed = value.trim();
  if (trimmed.isEmpty ||
      trimmed == '.' ||
      trimmed == '..' ||
      trimmed.contains('/') ||
      trimmed.contains('\\') ||
      trimmed.contains('\u0000') ||
      !RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(trimmed)) {
    throw PocketPackageException(
      'unsafe token for $field: $value',
      code: 'unsafe-token',
    );
  }
  return trimmed;
}

String _safePart(String value) {
  final normalized = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
  if (normalized == value &&
      normalized.isNotEmpty &&
      normalized != '.' &&
      normalized != '..')
    return normalized;
  return '${normalized.isEmpty ? 'app' : normalized}-${crypto.sha256.convert(utf8.encode(value)).toString().substring(0, 16)}';
}

void _validateAssetName(String name) {
  if (name.isEmpty ||
      name.startsWith('/') ||
      name.startsWith('\\') ||
      name.contains('\u0000') ||
      name.contains('://') ||
      RegExp(r'^[A-Za-z]:').hasMatch(name)) {
    throw PocketPackageException(
      'unsafe asset name $name',
      code: 'manifest-assets',
    );
  }
  final segments = name.split('/');
  if (segments.any((part) => part.isEmpty || part == '.' || part == '..')) {
    throw PocketPackageException(
      'unsafe asset name $name',
      code: 'manifest-assets',
    );
  }
}

Future<String> _fileHash(
  File file, [
  PocketCancellationToken? cancellation,
]) async {
  final output = <crypto.Digest>[];
  final converter = crypto.sha256.startChunkedConversion(
    ChunkedConversionSink<crypto.Digest>.withCallback(output.addAll),
  );
  await for (final chunk in file.openRead()) {
    cancellation?.throwIfCancelled();
    converter.add(chunk);
  }
  converter.close();
  return output.single.toString();
}

Map<String, dynamic> _object(Object? value, String field) {
  if (value is! Map) throw PocketPackageException('$field must be an object');
  return Map<String, dynamic>.from(value);
}

String _string(Object? value, String field) {
  if (value is String && value.isNotEmpty) return value;
  throw PocketPackageException('$field must be a non-empty string');
}

int _int(Object? value, String field) {
  if (value is int && value >= 0) return value;
  if (value is num && value.isFinite && value >= 0 && value == value.round())
    return value.toInt();
  throw PocketPackageException('$field must be a non-negative integer');
}

String _hash(Object? value, String field) {
  final text = _string(value, field).toLowerCase();
  if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(text))
    throw PocketPackageException('$field must be SHA-256');
  return text;
}
