import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as path;
import 'package:pocket_flutter/src/pocket_package.dart'
    show PocketPackageSource;

import 'pocket_guest_manifest.dart';
import 'pocket_trust.dart';

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

/// Work reported while a downloaded package moves through extraction,
/// per-file verification, and local package assembly.
enum PocketPackagePreparationStage {
  decodingArchive,
  verifyingFiles,
  assemblingPackage,
}

/// A snapshot of work that has actually completed during package preparation.
///
/// Byte and file counts are optional because not every phase has both kinds of
/// measurable work. Callers should use [stage] to interpret the counts.
final class PocketPackagePreparationProgress {
  const PocketPackagePreparationProgress({
    required this.stage,
    this.processedBytes,
    this.totalBytes,
    this.processedFiles,
    this.totalFiles,
  });

  final PocketPackagePreparationStage stage;
  final int? processedBytes;
  final int? totalBytes;
  final int? processedFiles;
  final int? totalFiles;
}

/// Optional host capability for extracting a verified 7z archive directly
/// from its staged file into a fresh destination directory.
///
/// Implementations must enforce [maxOutputBytes], reject unsafe paths and
/// links, and finish all filesystem work before the returned future completes.
typedef PocketArchiveExtractor =
    Future<void> Function({
      required String archivePath,
      required String destinationPath,
      required int maxOutputBytes,
    });

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
    this.kind,
    this.key,
    this.dtype,
  });

  factory PocketPakPart.fromJson(Object? value) {
    final json = _object(value, 'pak part');
    final rawKind = json['kind'];
    if (rawKind != null && rawKind != 'blob' && rawKind != 'metadata') {
      throw const PocketPackageException(
        'pak.parts.kind must be blob or metadata',
        code: 'manifest-parts',
      );
    }
    final rawKey = json['key'];
    if (rawKey != null) {
      if (rawKey is! String ||
          rawKey.isEmpty ||
          rawKey.trim() != rawKey ||
          _hasControlChars(rawKey) ||
          utf8.encode(rawKey).length > 0xffff) {
        throw const PocketPackageException(
          'pak.parts.key must be a valid non-empty key within 65535 UTF-8 bytes',
          code: 'manifest-parts',
        );
      }
    }
    final rawDtype = json['dtype'];
    int? dtype;
    if (rawDtype != null) {
      dtype = _int(rawDtype, 'pak.parts.dtype');
      if (dtype < 0 || dtype > 0xff) {
        throw const PocketPackageException(
          'pak.parts.dtype must be an integer in 0..255',
          code: 'manifest-parts',
        );
      }
    }
    if (rawKind == 'metadata' && (rawKey != null || dtype != null)) {
      throw const PocketPackageException(
        'metadata pak part must not declare key or dtype',
        code: 'manifest-parts',
      );
    }
    return PocketPakPart(
      offset: _int(json['offset'], 'pak.parts.offset'),
      sha256: _hash(json['sha256'], 'pak.parts.sha256'),
      size: _int(json['size'], 'pak.parts.size'),
      kind: rawKind as String?,
      key: rawKey as String?,
      dtype: dtype,
    );
  }

  final int offset;
  final String sha256;
  final int size;
  final String? kind;
  final String? key;
  final int? dtype;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'offset': offset,
    'sha256': sha256,
    'size': size,
    if (kind != null) 'kind': kind,
    if (key != null) 'key': key,
    if (dtype != null) 'dtype': dtype,
  };
}

final class PocketManifestBundle {
  const PocketManifestBundle({
    required this.format,
    required this.sha256,
    required this.size,
    required this.url,
    this.blobs,
  });

  factory PocketManifestBundle.fromJson(Object? value) {
    final json = _object(value, 'manifest bundle');
    final format = _string(json['format'], 'bundle.format');
    if (format != '7z' && format != 'zip') {
      throw PocketPackageException(
        'unsupported bundle format $format',
        code: 'manifest-bundle',
      );
    }
    final rawBlobs = json['blobs'];
    if (rawBlobs != null && rawBlobs is! List) {
      throw const PocketPackageException(
        'bundle.blobs must be a list of content hashes',
        code: 'manifest-bundle',
      );
    }
    return PocketManifestBundle(
      format: format,
      sha256: _hash(json['sha256'], 'bundle.sha256'),
      size: _int(json['size'], 'bundle.size'),
      url: _string(json['url'], 'bundle.url'),
      blobs: rawBlobs == null
          ? null
          : List<String>.unmodifiable(
              (rawBlobs as List).map((value) => _hash(value, 'bundle.blobs')),
            ),
    );
  }

  final String format;
  final String sha256;
  final int size;
  final String url;

  /// Exact signed contents of a partial base archive. Null means the legacy
  /// archive containing every manifest file. Other files still require hash
  /// verification and complete PAK admission before the guest can execute.
  final List<String>? blobs;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'format': format,
    'sha256': sha256,
    'size': size,
    'url': url,
    if (blobs != null) 'blobs': blobs,
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
    this.bundle,
    this.entryFormat = 'bytecode',
    this.runtimeAbi,
    this.signedAt,
    this.assets = const <String, PocketManifestAsset>{},
    this.guestManifest = const PocketGuestManifest(),
    this.worker,
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
      bundle: json['bundle'] == null
          ? null
          : PocketManifestBundle.fromJson(json['bundle']),
      entryFormat: json['entryFormat'] is String
          ? json['entryFormat'] as String
          : 'bytecode',
      runtimeAbi: json['runtimeAbi'] is String
          ? json['runtimeAbi'] as String
          : null,
      signedAt:
          json['signedAt'] is num &&
              (json['signedAt'] as num).isFinite &&
              (json['signedAt'] as num) >= 0 &&
              (json['signedAt'] as num) ==
                  (json['signedAt'] as num).truncateToDouble()
          ? (json['signedAt'] as num).toInt()
          : null,
      assets: Map<String, PocketManifestAsset>.unmodifiable(assets),
      guestManifest: PocketGuestManifest.fromJson(guestJson),
      worker: json['worker'] == null
          ? null
          : Map<String, dynamic>.unmodifiable(
              _object(json['worker'], 'worker descriptor'),
            ),
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

  /// Unix seconds recorded by the release tool. Legacy packages omit it and
  /// remain valid only when the old trusted-key mode is in use.
  final int? signedAt;
  final PocketPakManifest pak;
  final List<PocketManifestFile> files;
  final PocketManifestBundle? bundle;
  final Map<String, PocketManifestAsset> assets;
  final PocketGuestManifest guestManifest;

  /// Signed worker bytecode/declaration, linked to a verified loose asset.
  final Map<String, dynamic>? worker;

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
      if (signedAt != null) 'signedAt': signedAt,
      'protocol': protocol,
      'minHostVersion': minHostVersion,
      'entry': entry.toJson(),
      'entryFormat': entryFormat,
      if (runtimeAbi != null) 'runtimeAbi': runtimeAbi,
      'pak': pak.toJson(),
      'files': files.map((file) => file.toJson()).toList(growable: false),
      if (bundle != null) 'bundle': bundle!.toJson(),
      if (sortedAssets.isNotEmpty) 'assets': sortedAssets,
      ...guestManifest.toJson(),
      if (worker != null) 'worker': worker,
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
    if (isBytecode && (runtimeAbi == null || runtimeAbi!.trim().isEmpty)) {
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
    final seenPakKeys = <String>{};
    var cursor = 0;
    for (final part in parts) {
      if (part.key != null && !seenPakKeys.add(part.key!)) {
        throw PocketPackageException(
          'duplicate pak part key ${part.key}',
          code: 'manifest-parts',
        );
      }
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
    final descriptor = worker;
    if (descriptor != null) {
      final bytecode = _object(descriptor['bytecode'], 'worker bytecode');
      final name = _string(bytecode['path'], 'worker bytecode path');
      _validateAssetName(name);
      final hash = _string(bytecode['sha256'], 'worker bytecode sha256');
      final bytes = _int(bytecode['bytes'], 'worker bytecode bytes');
      final asset = assets[name];
      final required = descriptor['requiredCaps'];
      final declared = {
        ...guestManifest.requiredCapabilities,
        ...guestManifest.optionalCapabilities,
      };
      if (!isBytecode ||
          descriptor['kind'] != 'quickjs-bytecode' ||
          descriptor['protocolVersion'] != 1 ||
          descriptor['runtimeAbi'] != runtimeAbi ||
          asset == null ||
          asset.sha256 != hash ||
          asset.size != bytes ||
          bytes <= 124 ||
          bytes > 64 * 1024 * 1024 ||
          required is! List ||
          required.any((c) => c is! String || !declared.contains(c)) ||
          !declared.contains('runtime.worker')) {
        throw const PocketPackageException(
          'worker descriptor is not bound to admitted bytecode/assets/capabilities',
          code: 'manifest-worker',
        );
      }
    } else if (guestManifest.requiredCapabilities.contains('runtime.worker')) {
      throw const PocketPackageException(
        'required worker descriptor is missing',
        code: 'manifest-worker',
      );
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
    if (bundle != null) {
      if (bundle!.size <= 0 ||
          bundle!.size > maxTotalBytes ||
          bundle!.url.isEmpty) {
        throw const PocketPackageException(
          'manifest bundle exceeds configured size limits',
          code: 'manifest-size',
        );
      }
      _validateAssetName(bundle!.url);
      final included = bundle!.blobs;
      if (included != null &&
          (included.isEmpty ||
              included.toSet().length != included.length ||
              included.any((hash) => !byHash.containsKey(hash)))) {
        throw const PocketPackageException(
          'bundle.blobs must contain unique declared file hashes',
          code: 'manifest-bundle',
        );
      }
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
    final bytes = await entryFile.readAsBytes();
    return PocketPackageArtifact(
      package: this,
      entryBytes: bytes,
      entrySource: manifest.payload.isBytecode ? null : utf8.decode(bytes),
      pakBytes: await pakFile.readAsBytes(),
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
  const PocketPackageStore(
    this.rootDirectory, {
    this.appId,
    this.archiveExtractor,
  });

  final Directory rootDirectory;
  final String? appId;
  final PocketArchiveExtractor? archiveExtractor;

  PocketPackageStore scoped(String applicationId) {
    if (applicationId.trim().isEmpty)
      throw const PocketPackageException('app id must not be empty');
    return PocketPackageStore(
      rootDirectory,
      appId: applicationId,
      archiveExtractor: archiveExtractor,
    );
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

  /// Downloads and verifies a signed package bundle, extracts its
  /// content-addressed blobs, and returns the verified files keyed by SHA-256.
  /// ZIP decoding runs in a Dart isolate; 7z requires [archiveExtractor].
  Future<Map<String, File>> writeBundleZip({
    required PocketManifestBundle bundle,
    required List<PocketManifestFile> expectedFiles,
    required Stream<List<int>> bytes,
    required PocketCancellationToken cancellation,
    int maxArchiveBytes = 768 * 1024 * 1024,
    int maxTotalBytes = 768 * 1024 * 1024,
    void Function(int received)? onBytes,
    void Function()? onArchiveVerified,
    void Function(PocketPackagePreparationProgress progress)?
    onPreparationProgress,
  }) async {
    if (bundle.format != 'zip' && bundle.format != '7z') {
      throw PocketPackageException(
        'unsupported bundle format ${bundle.format}',
        code: 'manifest-bundle',
      );
    }
    if (bundle.format == '7z' && archiveExtractor == null) {
      throw const PocketPackageException(
        '7z bundles require native archive extraction',
        code: 'native-archive-unavailable',
      );
    }
    await initialize();
    if (bundle.size <= 0 || bundle.size > maxArchiveBytes) {
      throw const PocketPackageException(
        'bundle exceeds size limit',
        code: 'download-size',
      );
    }
    final temporaryId =
        '${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}';
    final archiveFile = File(path.join(_blobs.path, '.bundle-$temporaryId'));
    final extractionDirectory = Directory(
      path.join(_blobs.path, '.bundle-extract-$temporaryId'),
    );
    final sink = archiveFile.openWrite();
    final digests = <crypto.Digest>[];
    final converter = crypto.sha256.startChunkedConversion(
      ChunkedConversionSink<crypto.Digest>.withCallback(digests.addAll),
    );
    var received = 0;
    var sinkClosed = false;
    try {
      await for (final chunk in bytes) {
        cancellation.throwIfCancelled();
        received += chunk.length;
        if (received > bundle.size || received > maxArchiveBytes) {
          throw const PocketPackageException(
            'bundle download exceeded declared size',
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
      sinkClosed = true;
      if (received != bundle.size ||
          digests.single.toString() != bundle.sha256) {
        throw const PocketPackageException(
          'bundle download hash or size mismatch',
          code: 'download-hash',
        );
      }
      cancellation.throwIfCancelled();
      // The response reached EOF and its signed byte count and digest passed.
      // Publish this boundary before ZIP extraction and per-entry validation,
      // which can take much longer than the network transfer.
      onArchiveVerified?.call();
      await extractionDirectory.create();
      final PocketArchiveExtractor? nativeExtractor = bundle.format == '7z'
          ? archiveExtractor
          : null;
      final Map<String, File> extractedFiles;
      if (nativeExtractor != null) {
        cancellation.throwIfCancelled();
        onPreparationProgress?.call(
          const PocketPackagePreparationProgress(
            stage: PocketPackagePreparationStage.decodingArchive,
          ),
        );
        // Native extraction is not cancellable through this interface. Await
        // its actual completion before honoring cancellation or deleting the
        // archive and destination directory in the finally block.
        await nativeExtractor(
          archivePath: archiveFile.path,
          destinationPath: extractionDirectory.path,
          maxOutputBytes: maxTotalBytes,
        );
        cancellation.throwIfCancelled();
        final nativeOutput = await _indexNativeBundleFiles(
          extractionDirectory: extractionDirectory,
          expectedFiles: expectedFiles,
          maxTotalBytes: maxTotalBytes,
        );
        onPreparationProgress?.call(
          PocketPackagePreparationProgress(
            stage: PocketPackagePreparationStage.decodingArchive,
            processedBytes: nativeOutput.totalBytes,
            totalBytes: expectedFiles.fold<int>(
              0,
              (sum, file) => sum + file.size,
            ),
            processedFiles: nativeOutput.files.length,
            totalFiles: expectedFiles.length,
          ),
        );
        extractedFiles = nativeOutput.files;
      } else {
        extractedFiles = await _decodeBundleInWorker(
          archivePath: archiveFile.path,
          outputDirectory: extractionDirectory.path,
          maxTotalBytes: maxTotalBytes,
          expectedFiles: expectedFiles,
          requireExactEntries: bundle.blobs != null,
          cancellation: cancellation,
          onPreparationProgress: onPreparationProgress,
        );
      }
      final blobs = <String, File>{};
      var verifiedBytes = 0;
      var verifiedFiles = 0;
      final verifyTotalBytes = expectedFiles.fold<int>(
        0,
        (sum, file) => sum + file.size,
      );
      if (nativeExtractor != null) {
        onPreparationProgress?.call(
          PocketPackagePreparationProgress(
            stage: PocketPackagePreparationStage.verifyingFiles,
            processedBytes: 0,
            totalBytes: verifyTotalBytes,
            processedFiles: 0,
            totalFiles: expectedFiles.length,
          ),
        );
      }
      for (final file in expectedFiles) {
        cancellation.throwIfCancelled();
        final extracted = extractedFiles[file.sha256];
        if (nativeExtractor != null) {
          if (extracted == null ||
              !await extracted.exists() ||
              await extracted.length() != file.size) {
            throw PocketPackageException(
              'bundle is missing or has corrupted blob ${file.sha256}',
              code: 'bundle-content',
            );
          }
          var lastFileBytes = 0;
          final actualHash = await _fileHash(extracted, cancellation, (
            readBytes,
          ) {
            verifiedBytes += readBytes - lastFileBytes;
            lastFileBytes = readBytes;
            onPreparationProgress?.call(
              PocketPackagePreparationProgress(
                stage: PocketPackagePreparationStage.verifyingFiles,
                processedBytes: verifiedBytes,
                totalBytes: verifyTotalBytes,
                processedFiles: verifiedFiles,
                totalFiles: expectedFiles.length,
              ),
            );
          });
          if (actualHash != file.sha256) {
            throw PocketPackageException(
              'bundle is missing or has corrupted blob ${file.sha256}',
              code: 'bundle-content',
            );
          }
          verifiedFiles++;
          onPreparationProgress?.call(
            PocketPackagePreparationProgress(
              stage: PocketPackagePreparationStage.verifyingFiles,
              processedBytes: verifiedBytes,
              totalBytes: verifyTotalBytes,
              processedFiles: verifiedFiles,
              totalFiles: expectedFiles.length,
            ),
          );
        }
        final existing = await validBlob(file, cancellation: cancellation);
        if (existing != null) {
          // Partial archives promise the exact signed subset. Their extracted
          // bytes were already checked by the worker even when cache wins.
          blobs[file.sha256] = existing;
          continue;
        }
        if (extracted == null) {
          throw PocketPackageException(
            'bundle is missing blob ${file.sha256}',
            code: 'bundle-content',
          );
        }
        if (nativeExtractor != null) {
          blobs[file.sha256] = await _promoteNativeExtractedFile(
            extracted,
            file,
            cancellation,
          );
        } else {
          final target = File(path.join(_blobs.path, file.sha256));
          await _copyAtomic(extracted, target);
          blobs[file.sha256] = target;
        }
      }
      return blobs;
    } finally {
      if (!sinkClosed) await sink.close();
      if (await archiveFile.exists()) await archiveFile.delete();
      if (await extractionDirectory.exists()) {
        await extractionDirectory.delete(recursive: true);
      }
    }
  }

  Future<({Map<String, File> files, int totalBytes})> _indexNativeBundleFiles({
    required Directory extractionDirectory,
    required List<PocketManifestFile> expectedFiles,
    required int maxTotalBytes,
  }) async {
    final rootType = await FileSystemEntity.type(
      extractionDirectory.path,
      followLinks: false,
    );
    if (rootType != FileSystemEntityType.directory) {
      throw const PocketPackageException(
        'native bundle extractor replaced its destination directory',
        code: 'bundle-content',
      );
    }

    final aliases = <String, String>{};
    void addAlias(String name, String sha256) {
      final normalized = name.replaceAll('\\', '/');
      _validateAssetName(normalized);
      final previous = aliases[normalized];
      if (previous != null && previous != sha256) {
        throw const PocketPackageException(
          'native bundle entries have ambiguous signed paths',
          code: 'bundle-content',
        );
      }
      aliases[normalized] = sha256;
    }

    for (final file in expectedFiles) {
      addAlias(file.url, file.sha256);
      addAlias('blobs/${file.sha256}', file.sha256);
      addAlias(file.sha256, file.sha256);
    }

    final files = <String, File>{};
    var totalBytes = 0;
    await for (final entity in extractionDirectory.list(
      recursive: true,
      followLinks: false,
    )) {
      final relative = path.relative(
        entity.path,
        from: extractionDirectory.path,
      );
      if (path.isAbsolute(relative) ||
          relative == '..' ||
          relative.startsWith('..${path.separator}')) {
        throw const PocketPackageException(
          'native bundle extractor returned a path outside its destination',
          code: 'bundle-content',
        );
      }
      final normalized = relative.replaceAll(path.separator, '/');
      _validateAssetName(normalized);
      final type = await FileSystemEntity.type(entity.path, followLinks: false);
      if (type == FileSystemEntityType.directory) continue;
      if (type != FileSystemEntityType.file) {
        throw PocketPackageException(
          'native bundle extractor returned an unsupported entry $normalized',
          code: 'bundle-content',
        );
      }
      final sha256 = aliases[normalized];
      if (sha256 == null || files.containsKey(sha256)) {
        throw PocketPackageException(
          'native bundle entries differ from the signed file set at $normalized',
          code: 'bundle-content',
        );
      }
      final file = File(entity.path);
      final size = await file.length();
      totalBytes += size;
      if (totalBytes > maxTotalBytes) {
        throw const PocketPackageException(
          'native bundle output exceeds the configured size limit',
          code: 'bundle-content',
        );
      }
      files[sha256] = file;
    }
    if (files.length != expectedFiles.length) {
      throw const PocketPackageException(
        'native bundle is missing signed files',
        code: 'bundle-content',
      );
    }
    return (files: files, totalBytes: totalBytes);
  }

  /// Seeds content-addressed blobs into `_blobs/<sha256>` from an already-staged
  /// local [package] (`entry.js`, `package.pak` slices, and `loose-assets/*`).
  /// This ensures granular updates on an already-downloaded mini-app reuse all
  /// unchanged code and resource blobs locally without network downloads or
  /// redundant whole-file memory allocations.
  Future<void> seedBlobsFromPackage(
    PocketPackage package, {
    PocketCancellationToken? cancellation,
  }) async {
    await initialize();
    final token = cancellation ?? PocketCancellationToken();
    final payload = package.manifest.payload;

    Future<void> ensureStreamedBlob(
      String sha256,
      int size,
      Stream<List<int>> Function() openStream,
    ) async {
      token.throwIfCancelled();
      final descriptor = PocketManifestFile(
        sha256: sha256,
        size: size,
        url: 'blobs/$sha256',
      );
      if (await validBlob(descriptor, cancellation: token) != null) {
        return;
      }
      try {
        await writeBlob(
          file: descriptor,
          bytes: openStream(),
          cancellation: token,
          maxBytes: math.max(size, 256 * 1024 * 1024),
        );
      } on PocketUpdateCancellation {
        rethrow;
      } on Object {
        // Ignore corrupted local artifact; coordinator will download missing blobs.
      }
    }

    final entryDescriptor = PocketManifestFile(
      sha256: payload.entry.sha256,
      size: payload.entry.size,
      url: 'blobs/${payload.entry.sha256}',
    );
    if (await validBlob(entryDescriptor, cancellation: token) == null &&
        await package.entryFile.exists()) {
      await ensureStreamedBlob(
        payload.entry.sha256,
        payload.entry.size,
        package.entryFile.openRead,
      );
    }

    final missingPakParts = <PocketPakPart>[];
    for (final part in payload.pak.parts) {
      token.throwIfCancelled();
      final descriptor = PocketManifestFile(
        sha256: part.sha256,
        size: part.size,
        url: 'blobs/${part.sha256}',
      );
      if (await validBlob(descriptor, cancellation: token) == null) {
        missingPakParts.add(part);
      }
    }
    if (missingPakParts.isNotEmpty && await package.pakFile.exists()) {
      final pakLength = await package.pakFile.length();
      if (pakLength == payload.pak.size) {
        for (final part in missingPakParts) {
          if (part.offset >= 0 &&
              part.size > 0 &&
              part.offset + part.size <= pakLength) {
            await ensureStreamedBlob(
              part.sha256,
              part.size,
              () => package.pakFile.openRead(
                part.offset,
                part.offset + part.size,
              ),
            );
          }
        }
      }
    }

    for (final item in payload.assets.entries) {
      token.throwIfCancelled();
      final descriptor = PocketManifestFile(
        sha256: item.value.sha256,
        size: item.value.size,
        url: 'blobs/${item.value.sha256}',
      );
      if (await validBlob(descriptor, cancellation: token) != null) {
        continue;
      }
      final assetFile = File(
        path.join(package.directory.path, 'loose-assets', item.key),
      );
      if (await assetFile.exists()) {
        await ensureStreamedBlob(
          item.value.sha256,
          item.value.size,
          assetFile.openRead,
        );
      }
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
    void Function(PocketPackagePreparationProgress progress)?
    onPreparationProgress,
  }) => _synchronized(
    () => _stageUnlocked(
      signed: signed,
      verifier: verifier,
      entryBlob: entryBlob,
      blobs: blobs,
      cancellation: cancellation,
      onPreparationProgress: onPreparationProgress,
    ),
  );

  Future<PocketPackage> prepare(
    dynamic packageOrSigned, {
    PocketManifestVerifier? verifier,
    File? entryBlob,
    Map<String, File>? blobs,
    PocketCancellationToken? cancellation,
  }) => _synchronized(() async {
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
    void Function(PocketPackagePreparationProgress progress)?
    onPreparationProgress,
  }) async {
    await initialize();
    final id = _versionId(signed.payload);
    final directory = Directory(path.join(_versions.path, id));
    if (await directory.exists()) {
      try {
        final loaded = await _loadVersion(
          id,
          verifier: verifier,
          onPreparationProgress: onPreparationProgress,
        );
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
      final packageBytes =
          signed.payload.entry.size +
          signed.payload.pak.size +
          signed.payload.assets.values.fold<int>(
            0,
            (sum, asset) => sum + asset.size,
          );
      final packageFiles = 2 + signed.payload.assets.length;
      var assembledBytes = 0;
      var assembledFiles = 0;
      var nextProgressBytes = 256 * 1024;

      void reportAssemblyProgress({bool force = false}) {
        final report = onPreparationProgress;
        if (report == null || (!force && assembledBytes < nextProgressBytes)) {
          return;
        }
        report(
          PocketPackagePreparationProgress(
            stage: PocketPackagePreparationStage.assemblingPackage,
            processedBytes: assembledBytes,
            totalBytes: packageBytes,
            processedFiles: assembledFiles,
            totalFiles: packageFiles,
          ),
        );
        nextProgressBytes = assembledBytes + 256 * 1024;
      }

      reportAssemblyProgress(force: true);
      await _writeAtomic(
        File(path.join(directory.path, 'manifest.json')),
        signed.envelopeBytes,
      );
      Future<void> copyPackageFile(File source, File destination) async {
        var fileBytes = 0;
        await _copyAtomic(
          source,
          destination,
          onBytes: (copiedBytes) {
            assembledBytes += copiedBytes - fileBytes;
            fileBytes = copiedBytes;
            reportAssemblyProgress();
          },
        );
        assembledFiles++;
        reportAssemblyProgress(force: true);
      }

      await copyPackageFile(
        entryBlob,
        File(path.join(directory.path, 'entry.js')),
      );
      var pakBytes = 0;
      await _assemblePak(
        signed.payload,
        blobs,
        File(path.join(directory.path, 'package.pak')),
        cancellation,
        onBytes: (copiedBytes) {
          assembledBytes += copiedBytes - pakBytes;
          pakBytes = copiedBytes;
          reportAssemblyProgress();
        },
      );
      assembledFiles++;
      reportAssemblyProgress(force: true);
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
        await copyPackageFile(blob, target);
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
    required PocketManifestVerifier verifier,
    bool recordPrevious = true,
    int minimumBuild = 0,
    bool allowDowngrade = false,
  }) => _synchronized(() async {
    final verified = await _revalidatePackage(package, verifier);
    await verifier.withVerified(
      verified.manifest,
      () => _activateUnlocked(
        verified,
        recordPrevious: recordPrevious,
        minimumBuild: minimumBuild,
        allowDowngrade: allowDowngrade,
      ),
    );
  });

  /// Rechecks cached bytes, then serializes their final trust admission and
  /// publication with policy installation. [use] must not acquire a package
  /// lock or install a policy. It does not mark a package healthy on disk.
  Future<T> withVerifiedPackage<T>(
    PocketPackage package, {
    required PocketManifestVerifier verifier,
    required FutureOr<T> Function() use,
  }) => _synchronized(() async {
    final verified = await _revalidatePackage(package, verifier);
    return verifier.withVerified(verified.manifest, use);
  });

  Future<PocketPackage> _revalidatePackage(
    PocketPackage package,
    PocketManifestVerifier verifier,
  ) async {
    final verified = await _loadVersion(package.versionId, verifier: verifier);
    if (verified.manifest.payload.contentHash !=
            package.manifest.payload.contentHash ||
        path.canonicalize(verified.directory.path) !=
            path.canonicalize(package.directory.path)) {
      throw const PocketPackageException(
        'candidate package changed before admission',
        code: 'cache-package',
      );
    }
    return verified;
  }

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
  }) => _synchronized(
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
    final verified = await _revalidatePackage(package, verifier);
    await verifier.withVerified(verified.manifest, () async {
      await _activateUnlocked(
        verified,
        minimumBuild: minimumBuild,
        allowDowngrade: allowDowngrade,
      );
      await _writeAtomic(_pointer('lastGood'), utf8.encode(verified.versionId));
    });
    await _pruneInactiveVersionsUnlocked(keep: 2, verifier: verifier);
  }

  Future<int?> _readBuildForVersionId(String id) async {
    try {
      final safeId = _requireSafeToken(id, 'versionId');
      final manifestFile = File(
        path.join(_versions.path, safeId, 'manifest.json'),
      );
      if (!await manifestFile.exists()) return null;
      final bytes = await manifestFile.readAsBytes();
      final signed = PocketSignedManifest.fromBytes(bytes);
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
    PocketPackage? fallbackPackage;
    if (fallbackId != null) {
      var admitted = false;
      try {
        final candidate = await _loadVersion(fallbackId, verifier: verifier);
        await verifier.withVerified(candidate.manifest, () async {
          admitted = true;
          if (lastGoodId == safeFailedId) {
            await _writeAtomic(
              _pointer('lastGood'),
              utf8.encode(candidate.versionId),
            );
          }
          await _writeAtomic(
            _pointer('active'),
            utf8.encode(candidate.versionId),
          );
        });
        fallbackPackage = candidate;
      } catch (_) {
        // An invalid candidate has no usable fallback. A publication failure
        // is an IO error, however: preserve the healthy pointers and surface
        // it rather than treating a verified package as invalid.
        if (admitted) rethrow;
        fallbackPackage = null;
        fallbackId = null;
      }
    }

    final activeFile = _pointer('active');
    if (fallbackPackage == null) {
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
    final previousId = await _readPointerId('previous');
    final lastGoodId = await _readPointerId('lastGood');
    if (versionId != null) {
      if (versionId != previousId && versionId != lastGoodId) {
        throw PocketPackageFormatException(
          'Rollback target $versionId is not a recorded previous or lastGood version',
        );
      }
    }
    final targetId = versionId ?? (previousId ?? lastGoodId);
    if (targetId == null) {
      throw const PocketPackageException(
        'no verified rollback target',
        code: 'rollback-missing',
      );
    }
    final target = await _loadVersion(targetId, verifier: verifier);
    await verifier.withVerified(target.manifest, () async {
      final active = await _readPointerId('active');
      if (active != null && active != target.versionId) {
        await _writeAtomic(_pointer('previous'), utf8.encode(active));
      }
      await _writeAtomic(_pointer('active'), utf8.encode(target.versionId));
      await _writeAtomic(_pointer('lastGood'), utf8.encode(target.versionId));
    });
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
          await manifestFile.readAsBytes(),
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

  /// Keeps activation-pointer targets and, when [verifier] is supplied, up to
  /// [keep] newest complete signed versions that are not pointed to. Without
  /// a verifier, unpointed directories are removed as in the legacy API.
  Future<void> pruneInactiveVersions([
    String? applicationId,
    int keep = 2,
    PocketManifestVerifier? verifier,
  ]) => _synchronized(() {
    final target = applicationId != null ? scoped(applicationId) : this;
    return target._pruneInactiveVersionsUnlocked(
      keep: keep,
      verifier: verifier,
    );
  });

  Future<void> _pruneInactiveVersionsUnlocked({
    int keep = 2,
    PocketManifestVerifier? verifier,
  }) async {
    if (!await _versions.exists()) return;
    final keepSet = <String>{};
    for (final name in ['active', 'previous', 'lastGood']) {
      final id = await _readPointerId(name);
      if (id != null) keepSet.add(id);
    }
    final candidates = <PocketPackage>[];
    final directories = await _versions.list(followLinks: false).toList();
    for (final entity in directories) {
      if (entity is! Directory) continue;
      final id = path.basename(entity.path);
      if (keepSet.contains(id)) continue;
      if (verifier == null) {
        await _deleteVersionDirectory(entity);
        continue;
      }
      try {
        final package = await _loadVersion(id, verifier: verifier);
        if (_versionId(package.manifest.payload) != id) {
          throw const PocketPackageException(
            'staged package version ID does not match its signed manifest',
            code: 'cache-package',
          );
        }
        candidates.add(package);
      } on Object {
        // Incomplete, corrupt, or no-longer-trusted stages are not reusable.
        await _deleteVersionDirectory(entity);
      }
    }
    candidates.sort((a, b) {
      final buildOrder = b.manifest.payload.build.compareTo(
        a.manifest.payload.build,
      );
      return buildOrder != 0 ? buildOrder : b.versionId.compareTo(a.versionId);
    });
    final retained = math.max(0, keep);
    for (final package in candidates.skip(retained)) {
      await _deleteVersionDirectory(package.directory);
    }
  }

  Future<void> _deleteVersionDirectory(Directory directory) async {
    try {
      await directory.delete(recursive: true);
    } catch (_) {}
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
    void Function(PocketPackagePreparationProgress progress)?
    onPreparationProgress,
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
      await manifestFile.readAsBytes(),
    );
    await verifier.verify(signed);

    final totalBytes =
        signed.payload.entry.size +
        signed.payload.pak.size +
        signed.payload.assets.values.fold<int>(
          0,
          (sum, asset) => sum + asset.size,
        );
    final totalFiles = 2 + signed.payload.assets.length;
    var processedBytes = 0;
    var processedFiles = 0;
    void reportVerificationProgress() {
      final report = onPreparationProgress;
      if (report == null) return;
      report(
        PocketPackagePreparationProgress(
          stage: PocketPackagePreparationStage.verifyingFiles,
          processedBytes: processedBytes,
          totalBytes: totalBytes,
          processedFiles: processedFiles,
          totalFiles: totalFiles,
        ),
      );
    }

    Future<bool> matchesFile(
      File file,
      int expectedSize,
      String expectedSha256,
    ) async {
      if (!await file.exists() || await file.length() != expectedSize) {
        return false;
      }
      var lastFileBytes = 0;
      final actualSha256 = await _fileHash(file, null, (readBytes) {
        processedBytes += readBytes - lastFileBytes;
        lastFileBytes = readBytes;
        reportVerificationProgress();
      });
      final matches = actualSha256 == expectedSha256;
      if (matches) processedFiles++;
      reportVerificationProgress();
      return matches;
    }

    reportVerificationProgress();
    if (!await matchesFile(
          entry,
          signed.payload.entry.size,
          signed.payload.entry.sha256,
        ) ||
        !await matchesFile(
          pak,
          signed.payload.pak.size,
          signed.payload.pak.sha256,
        )) {
      throw const PocketPackageException(
        'staged package failed integrity validation',
        code: 'cache-hash',
      );
    }
    for (final item in signed.payload.assets.entries) {
      final file = File(path.join(directory.path, 'loose-assets', item.key));
      if (!await matchesFile(file, item.value.size, item.value.sha256)) {
        throw PocketPackageException(
          'staged asset ${item.key} failed integrity validation',
          code: 'cache-assets',
        );
      }
    }
    return PocketPackage(
      manifest: signed,
      versionId: safeId,
      directory: directory,
    );
  }

  Future<void> _assemblePak(
    PocketPackageManifest manifest,
    Map<String, File> blobs,
    File destination,
    PocketCancellationToken cancellation, {
    void Function(int copiedBytes)? onBytes,
  }) async {
    final temporary = File(
      '${destination.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
    );
    final sink = temporary.openWrite();
    final digest = <crypto.Digest>[];
    final converter = crypto.sha256.startChunkedConversion(
      ChunkedConversionSink<crypto.Digest>.withCallback(digest.addAll),
    );
    var copiedBytes = 0;
    var lastReportedBytes = 0;
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
          copiedBytes += chunk.length;
          if (onBytes != null &&
              copiedBytes - lastReportedBytes >= 256 * 1024) {
            onBytes(copiedBytes);
            lastReportedBytes = copiedBytes;
          }
        }
      }
      if (onBytes != null && lastReportedBytes < copiedBytes) {
        onBytes(copiedBytes);
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
      await _verifyPakAnnotations(manifest, temporary);
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

  Future<void> _copyAtomic(
    File source,
    File destination, {
    void Function(int copiedBytes)? onBytes,
  }) async {
    final temporary = File(
      '${destination.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}',
    );
    final sink = temporary.openWrite();
    var copiedBytes = 0;
    var lastReportedBytes = 0;
    try {
      await for (final chunk in source.openRead()) {
        sink.add(chunk);
        copiedBytes += chunk.length;
        if (onBytes != null && copiedBytes - lastReportedBytes >= 256 * 1024) {
          onBytes(copiedBytes);
          lastReportedBytes = copiedBytes;
        }
      }
      await sink.flush();
      await sink.close();
      if (onBytes != null && lastReportedBytes < copiedBytes) {
        onBytes(copiedBytes);
      }
    } catch (_) {
      await sink.close();
      if (await temporary.exists()) await temporary.delete();
      rethrow;
    }
    try {
      await temporary.rename(destination.path);
    } catch (_) {
      if (await destination.exists()) await destination.delete();
      await temporary.rename(destination.path);
    }
  }

  Future<File> _promoteNativeExtractedFile(
    File extracted,
    PocketManifestFile expected,
    PocketCancellationToken cancellation,
  ) async {
    final target = File(path.join(_blobs.path, expected.sha256));
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        // The native output was streamed through its signed size and hash
        // checks above and lives on the same filesystem as the blob store.
        // Rename avoids writing another full copy of large package files.
        return await extracted.rename(target.path);
      } on FileSystemException {
        final concurrentWinner = await validBlob(
          expected,
          cancellation: cancellation,
        );
        if (concurrentWinner != null) return concurrentWinner;
        if (attempt == 0) {
          // validBlob removes a corrupt target. Retry once in case a writer
          // recreated it between validation and rename.
          if (await target.exists()) await target.delete();
          continue;
        }
        rethrow;
      }
    }
    throw StateError('unreachable native blob promotion state');
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
    this.trustStore,
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

  /// When set, the host-owned root policy is the only source of release keys.
  /// [trustedKeys] is deliberately ignored in this mode, preventing an old
  /// configured key from bypassing rotation or revocation.
  final PocketTrustStore? trustStore;

  /// Final verification and use form one admission relative to policy install.
  /// The package-store lock, when needed, must already be held. [use] must not
  /// install policies or acquire another package lock.
  Future<T> withVerified<T>(
    PocketSignedManifest signed,
    FutureOr<T> Function() use,
  ) {
    Future<T> admit() async {
      await verify(signed);
      return use();
    }

    return trustStore?.withPolicyAdmission(admit) ?? admit();
  }

  Future<void> verify(PocketSignedManifest signed) async {
    try {
      if (trustStore == null) {
        await signed.verify(trustedKeys: trustedKeys);
      } else {
        final key = await trustStore!.publicKeyForPackage(
          keyId: signed.keyId,
          packageAppId: signed.payload.appId,
          signedAt: signed.payload.signedAt,
          contentHash: signed.payload.contentHash,
          payloadBytes: signed.payloadBytes,
        );
        await signed.verify(
          trustedKeys: <String, List<int>>{signed.keyId: key},
        );
      }
    } on PocketTrustException catch (error) {
      throw PocketPackageException(error.message, code: error.code);
    }
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

bool _hasControlChars(String value) {
  for (var i = 0; i < value.length; i++) {
    final code = value.codeUnitAt(i);
    if (code <= 0x1f || code == 0x7f) return true;
  }
  return false;
}

void _validateAssetName(String name) {
  if (name.isEmpty ||
      name.startsWith('/') ||
      name.startsWith('\\') ||
      name.endsWith('/') ||
      name.endsWith('\\') ||
      _hasControlChars(name) ||
      name.contains('://') ||
      RegExp(r'^[A-Za-z]:').hasMatch(name)) {
    throw PocketPackageException(
      'unsafe asset name $name',
      code: 'manifest-assets',
    );
  }
  final segments = name.split('/');
  if (segments.any(
    (part) =>
        part.isEmpty || part == '.' || part == '..' || part.trim() != part,
  )) {
    throw PocketPackageException(
      'unsafe asset name $name',
      code: 'manifest-assets',
    );
  }
}

const int _pakMagic = 0x4b504344;
const int _pakVersion = 1;
const int _pakHeaderSize = 32;
const int _pakEntrySize = 24;
const int _pakAlign = 16;

final class PocketPakBlobEntry {
  const PocketPakBlobEntry({
    required this.key,
    required this.data,
    this.dtype = 0,
  });

  final String key;
  final List<int> data;
  final int dtype;
}

int _fnv1a32(String text) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.codeUnitAt(i);
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash;
}

int _alignPak(int n) => (n + (_pakAlign - 1)) & ~(_pakAlign - 1);

/// Deterministic `.pak` binary encoder for tests and local packaging.
Uint8List encodePocketPak(List<PocketPakBlobEntry> entriesIn) {
  final entries = [...entriesIn]..sort((a, b) => a.key.compareTo(b.key));
  final seen = <String>{};
  final encodedNames = <Uint8List>[];
  for (final entry in entries) {
    if (entry.key.isEmpty ||
        entry.key.trim() != entry.key ||
        _hasControlChars(entry.key) ||
        !seen.add(entry.key)) {
      throw PocketPackageException(
        'invalid or duplicate PAK key ${entry.key}',
        code: 'pak-layout',
      );
    }
    final nameBytes = Uint8List.fromList(utf8.encode(entry.key));
    if (nameBytes.isEmpty || nameBytes.length > 0xffff) {
      throw PocketPackageException(
        'PAK key ${entry.key} exceeds 65535 UTF-8 bytes',
        code: 'pak-layout',
      );
    }
    if (entry.data.isEmpty) {
      throw PocketPackageException(
        'PAK entry ${entry.key} must not be empty',
        code: 'pak-layout',
      );
    }
    if (entry.dtype < 0 || entry.dtype > 0xff) {
      throw PocketPackageException(
        'PAK entry ${entry.key} has invalid dtype ${entry.dtype}',
        code: 'pak-layout',
      );
    }
    encodedNames.add(nameBytes);
  }
  const dirOffset = _pakHeaderSize;
  final namesOffset = dirOffset + entries.length * _pakEntrySize;
  var nameCursor = 0;
  final nameOffsets = <int>[];
  for (final name in encodedNames) {
    nameOffsets.add(nameCursor);
    nameCursor += name.length;
  }
  final blobsOffset = _alignPak(namesOffset + nameCursor);
  var blobCursor = blobsOffset;
  final blobOffsets = <int>[];
  for (final entry in entries) {
    blobOffsets.add(blobCursor);
    blobCursor += _alignPak(entry.data.length);
  }
  final out = Uint8List(blobCursor);
  final view = ByteData.sublistView(out);
  view.setUint32(0, _pakMagic, Endian.little);
  view.setUint16(4, _pakVersion, Endian.little);
  view.setUint16(6, 0, Endian.little);
  view.setUint32(8, entries.length, Endian.little);
  view.setUint32(12, dirOffset, Endian.little);
  view.setUint32(16, namesOffset, Endian.little);
  view.setUint32(20, blobsOffset, Endian.little);
  view.setUint32(24, out.length, Endian.little);
  view.setUint32(28, 0, Endian.little);
  for (var index = 0; index < entries.length; index++) {
    final entryOffset = dirOffset + index * _pakEntrySize;
    final entry = entries[index];
    final nameBytes = encodedNames[index];
    view.setUint32(entryOffset + 0, _fnv1a32(entry.key), Endian.little);
    view.setUint32(entryOffset + 4, blobOffsets[index], Endian.little);
    view.setUint32(entryOffset + 8, entry.data.length, Endian.little);
    view.setUint32(entryOffset + 12, nameOffsets[index], Endian.little);
    view.setUint16(entryOffset + 16, nameBytes.length, Endian.little);
    out[entryOffset + 18] = entry.dtype & 0xff;
    out[entryOffset + 19] = 0;
    view.setUint32(entryOffset + 20, 0, Endian.little);
    out.setRange(
      namesOffset + nameOffsets[index],
      namesOffset + nameOffsets[index] + nameBytes.length,
      nameBytes,
    );
    out.setRange(
      blobOffsets[index],
      blobOffsets[index] + entry.data.length,
      entry.data,
    );
  }
  return out;
}

Future<void> _verifyPakAnnotations(
  PocketPackageManifest manifest,
  File pakFile,
) async {
  final hasAnnotations = manifest.pak.parts.any(
    (part) => part.kind != null || part.key != null || part.dtype != null,
  );
  final fileSize = manifest.pak.size;
  var hasPakMagic = false;
  if (fileSize >= _pakHeaderSize) {
    final headerBuilder = BytesBuilder(copy: false);
    await for (final chunk in pakFile.openRead(0, _pakHeaderSize)) {
      headerBuilder.add(chunk);
    }
    final headerBytes = headerBuilder.takeBytes();
    if (headerBytes.length == _pakHeaderSize) {
      final headerView = ByteData.sublistView(headerBytes);
      hasPakMagic = headerView.getUint32(0, Endian.little) == _pakMagic;
    }
  }
  if (!hasAnnotations && !hasPakMagic) {
    return;
  }
  if (fileSize < _pakHeaderSize) {
    throw const PocketPackageException(
      'annotated PAK is smaller than PAK header size',
      code: 'pak-layout',
    );
  }
  final headerBuilder = BytesBuilder(copy: false);
  await for (final chunk in pakFile.openRead(0, _pakHeaderSize)) {
    headerBuilder.add(chunk);
  }
  final headerBytes = headerBuilder.takeBytes();
  final headerView = ByteData.sublistView(headerBytes);
  if (headerView.getUint32(0, Endian.little) != _pakMagic ||
      headerView.getUint16(4, Endian.little) != _pakVersion) {
    throw const PocketPackageException(
      'invalid PAK magic or version',
      code: 'pak-layout',
    );
  }
  final entryCount = headerView.getUint32(8, Endian.little);
  final directoryOffset = headerView.getUint32(12, Endian.little);
  final namesOffset = headerView.getUint32(16, Endian.little);
  final blobsOffset = headerView.getUint32(20, Endian.little);
  final declaredSize = headerView.getUint32(24, Endian.little);
  final directoryEnd = directoryOffset + entryCount * _pakEntrySize;
  if (declaredSize != fileSize ||
      directoryOffset < _pakHeaderSize ||
      directoryEnd > namesOffset ||
      namesOffset > blobsOffset ||
      blobsOffset > fileSize) {
    throw const PocketPackageException(
      'invalid PAK header offsets',
      code: 'pak-layout',
    );
  }
  final prefixBuilder = BytesBuilder(copy: false);
  await for (final chunk in pakFile.openRead(0, blobsOffset)) {
    prefixBuilder.add(chunk);
  }
  final prefixBytes = prefixBuilder.takeBytes();
  final view = ByteData.sublistView(prefixBytes);
  final dirEntries = <({int offset, int size, String key, int dtype})>[];
  final seenKeys = <String>{};
  for (var index = 0; index < entryCount; index++) {
    final entryOffset = directoryOffset + index * _pakEntrySize;
    final blobOffset = view.getUint32(entryOffset + 4, Endian.little);
    final blobSize = view.getUint32(entryOffset + 8, Endian.little);
    final nameOffset = view.getUint32(entryOffset + 12, Endian.little);
    final nameSize = view.getUint16(entryOffset + 16, Endian.little);
    final dtype = prefixBytes[entryOffset + 18];
    if (nameSize <= 0 ||
        namesOffset + nameOffset + nameSize > blobsOffset ||
        blobOffset < blobsOffset ||
        blobSize <= 0 ||
        blobOffset + blobSize > fileSize) {
      throw const PocketPackageException(
        'invalid or empty PAK directory entry',
        code: 'pak-layout',
      );
    }
    final String key;
    try {
      key = utf8.decode(
        Uint8List.sublistView(
          prefixBytes,
          namesOffset + nameOffset,
          namesOffset + nameOffset + nameSize,
        ),
      );
    } on FormatException {
      throw const PocketPackageException(
        'invalid UTF-8 in PAK directory key',
        code: 'pak-layout',
      );
    }
    if (key.isEmpty ||
        key.trim() != key ||
        _hasControlChars(key) ||
        !seenKeys.add(key)) {
      throw PocketPackageException(
        'invalid or duplicate PAK directory key $key',
        code: 'pak-layout',
      );
    }
    dirEntries.add((
      offset: blobOffset,
      size: blobSize,
      key: key,
      dtype: dtype,
    ));
  }
  dirEntries.sort((a, b) => a.offset.compareTo(b.offset));
  for (var index = 1; index < dirEntries.length; index++) {
    final prev = dirEntries[index - 1];
    final curr = dirEntries[index];
    if (curr.offset < prev.offset + prev.size) {
      throw const PocketPackageException(
        'overlapping or aliased PAK blob ranges',
        code: 'pak-layout',
      );
    }
  }
  if (hasAnnotations) {
    final annotatedBlobs =
        manifest.pak.parts
            .where((part) => part.kind == 'blob' || part.key != null)
            .toList()
          ..sort((a, b) => a.offset.compareTo(b.offset));
    if (annotatedBlobs.length != dirEntries.length) {
      throw const PocketPackageException(
        'PAK directory entry count does not match signed pak.parts annotations',
        code: 'pak-layout',
      );
    }
    for (var i = 0; i < dirEntries.length; i++) {
      final dir = dirEntries[i];
      final part = annotatedBlobs[i];
      if (part.offset != dir.offset ||
          part.size != dir.size ||
          (part.key != null && part.key != dir.key) ||
          (part.dtype != null && part.dtype != dir.dtype)) {
        throw const PocketPackageException(
          'PAK directory entry does not match signed pak.parts annotation',
          code: 'pak-layout',
        );
      }
    }
  }
}

Future<Map<String, File>> _decodeBundleInWorker({
  required String archivePath,
  required String outputDirectory,
  required int maxTotalBytes,
  required List<PocketManifestFile> expectedFiles,
  required bool requireExactEntries,
  required PocketCancellationToken cancellation,
  void Function(PocketPackagePreparationProgress progress)?
  onPreparationProgress,
}) async {
  cancellation.throwIfCancelled();
  final responsePort = ReceivePort();
  final outcome = Completer<Map<String, String>>();
  final exited = Completer<void>();
  final responseSubscription = responsePort.listen((Object? message) {
    // The isolate's reply and onExit notifications share this port, so FIFO
    // delivery makes a missing result distinguishable without racing a
    // separate exit/error port.
    if (message == null) {
      if (!exited.isCompleted) exited.complete();
      if (!outcome.isCompleted) {
        outcome.completeError(
          const PocketPackageException(
            'bundle decoder exited before returning a result',
            code: 'bundle-worker',
          ),
        );
      }
      return;
    }
    if (outcome.isCompleted) return;
    if (message is List && message.length == 2) {
      outcome.completeError(
        PocketPackageException(
          'bundle decoder isolate failed: ${message.first}',
          code: 'bundle-worker',
        ),
      );
      return;
    }
    if (message is Map && message['progress'] == true) {
      final rawStage = message['stage'];
      final rawProcessedBytes = message['processedBytes'];
      final rawTotalBytes = message['totalBytes'];
      final rawProcessedFiles = message['processedFiles'];
      final rawTotalFiles = message['totalFiles'];
      if (rawStage is! int ||
          rawStage < 0 ||
          rawStage >= PocketPackagePreparationStage.values.length ||
          (rawProcessedBytes != null && rawProcessedBytes is! int) ||
          (rawTotalBytes != null && rawTotalBytes is! int) ||
          (rawProcessedFiles != null && rawProcessedFiles is! int) ||
          (rawTotalFiles != null && rawTotalFiles is! int)) {
        outcome.completeError(
          const PocketPackageException(
            'bundle decoder returned invalid progress',
            code: 'bundle-worker',
          ),
        );
        return;
      }
      onPreparationProgress?.call(
        PocketPackagePreparationProgress(
          stage: PocketPackagePreparationStage.values[rawStage],
          processedBytes: rawProcessedBytes as int?,
          totalBytes: rawTotalBytes as int?,
          processedFiles: rawProcessedFiles as int?,
          totalFiles: rawTotalFiles as int?,
        ),
      );
      return;
    }
    if (message is! Map || message['ok'] is! bool) {
      outcome.completeError(
        const PocketPackageException(
          'bundle decoder returned an invalid response',
          code: 'bundle-worker',
        ),
      );
      return;
    }
    if (message['ok'] != true) {
      outcome.completeError(
        PocketPackageException(
          message['message'] is String
              ? message['message'] as String
              : 'bundle decoder failed',
          code: message['code'] is String
              ? message['code'] as String
              : 'bundle-worker',
        ),
      );
      return;
    }
    final rawFiles = message['files'];
    if (rawFiles is! Map ||
        rawFiles.entries.any(
          (entry) => entry.key is! String || entry.value is! String,
        )) {
      outcome.completeError(
        const PocketPackageException(
          'bundle decoder returned invalid file paths',
          code: 'bundle-worker',
        ),
      );
      return;
    }
    outcome.complete(<String, String>{
      for (final entry in rawFiles.entries)
        entry.key as String: entry.value as String,
    });
  });

  Isolate? worker;
  var isCancelled = false;
  unawaited(
    cancellation.whenCancelled.then((_) {
      isCancelled = true;
      worker?.kill(priority: Isolate.immediate);
    }),
  );
  final result = Future.any<Map<String, String>>(<Future<Map<String, String>>>[
    outcome.future,
    cancellation.whenCancelled.then<Map<String, String>>(
      (_) => throw const PocketUpdateCancellation(),
    ),
  ]);
  // Subscribe before spawning: cancellation can arrive during Isolate.spawn,
  // and a worker exit error must never become an unhandled future error.
  unawaited(result.then<void>((_) {}, onError: (Object _, StackTrace __) {}));
  Future<Isolate>? spawn;
  try {
    spawn =
        Isolate.spawn<List<Object?>>(
          _decodeBundleWorkerMain,
          <Object?>[
            responsePort.sendPort,
            archivePath,
            outputDirectory,
            maxTotalBytes,
            <List<Object?>>[
              for (final file in expectedFiles)
                <Object?>[file.sha256, file.size, file.url],
            ],
            requireExactEntries,
            onPreparationProgress != null,
          ],
          onError: responsePort.sendPort,
          onExit: responsePort.sendPort,
          errorsAreFatal: true,
          debugName: 'Pocket bundle decoder',
        ).then((isolate) {
          worker = isolate;
          if (isCancelled) isolate.kill(priority: Isolate.immediate);
          return isolate;
        });
    worker = await Future.any<Isolate>(<Future<Isolate>>[
      spawn,
      cancellation.whenCancelled.then<Isolate>(
        (_) => throw const PocketUpdateCancellation(),
      ),
    ]);
    // Unlike Isolate.run, this worker has an explicit lifetime. Closing the
    // package/session kills the decoder immediately instead of waiting for a
    // large pure-Dart inflate to finish on the caller isolate.
    cancellation.throwIfCancelled();
    final paths = await result;
    cancellation.throwIfCancelled();
    return <String, File>{
      for (final entry in paths.entries) entry.key: File(entry.value),
    };
  } finally {
    if (worker == null) {
      // Cancellation may win while Isolate.spawn is still resolving. Wait for
      // spawn failure or success; the success callback kills it immediately.
      final pendingSpawn = spawn;
      if (pendingSpawn != null) {
        try {
          worker = await pendingSpawn.timeout(const Duration(seconds: 5));
        } on Object {
          // A failed/timed-out spawn has no worker to reap.
        }
      }
    }
    final activeWorker = worker;
    if (activeWorker != null && !exited.isCompleted) {
      activeWorker.kill(priority: Isolate.immediate);
      await exited.future.timeout(const Duration(seconds: 5), onTimeout: () {});
    }
    await responseSubscription.cancel();
    responsePort.close();
  }
}

@pragma('vm:entry-point')
Future<void> _decodeBundleWorkerMain(List<Object?> request) async {
  final reply = request[0] as SendPort;
  try {
    final archivePath = request[1] as String;
    final outputDirectory = request[2] as String;
    final maxTotalBytes = request[3] as int;
    final expectedFiles = (request[4] as List<Object?>).cast<List<Object?>>();
    final requireExactEntries = request[5] as bool;
    final reportProgress = request[6] as bool;
    final totalBytes = expectedFiles.fold<int>(
      0,
      (sum, file) => sum + (file[1] as int),
    );
    void sendProgress(PocketPackagePreparationProgress progress) {
      if (!reportProgress) return;
      reply.send(<String, Object?>{
        'progress': true,
        'stage': progress.stage.index,
        if (progress.processedBytes case final value?) 'processedBytes': value,
        if (progress.totalBytes case final value?) 'totalBytes': value,
        if (progress.processedFiles case final value?) 'processedFiles': value,
        if (progress.totalFiles case final value?) 'totalFiles': value,
      });
    }

    // Path-based transfer avoids duplicating an archive or extracted payload
    // of hundreds of MiB across isolate message queues.
    final archive = await File(archivePath).readAsBytes();
    final extracted = decodePocketZip(
      archive,
      maxTotalBytes: maxTotalBytes,
      onOutputBytes: reportProgress
          ? (decodedBytes) => sendProgress(
              PocketPackagePreparationProgress(
                stage: PocketPackagePreparationStage.decodingArchive,
                processedBytes: decodedBytes,
                totalBytes: totalBytes,
                processedFiles: 0,
                totalFiles: expectedFiles.length,
              ),
            )
          : null,
    );
    if (requireExactEntries) {
      final expectedPaths = expectedFiles
          .map((file) => file[2] as String)
          .toSet();
      if (extracted.length != expectedPaths.length ||
          extracted.keys.any((name) => !expectedPaths.contains(name))) {
        throw const PocketPackageException(
          'partial bundle entries differ from its signed subset',
          code: 'bundle-content',
        );
      }
    }

    final files = <String, String>{};
    var verifiedBytes = 0;
    var verifiedFiles = 0;
    for (final file in expectedFiles) {
      final sha256 = file[0] as String;
      final size = file[1] as int;
      final url = file[2] as String;
      final entryBytes =
          extracted[url] ?? extracted['blobs/$sha256'] ?? extracted[sha256];
      if (entryBytes == null ||
          entryBytes.length != size ||
          crypto.sha256.convert(entryBytes).toString() != sha256) {
        throw PocketPackageException(
          'bundle is missing or has corrupted blob $sha256',
          code: 'bundle-content',
        );
      }
      final outputPath = path.join(outputDirectory, sha256);
      if (!files.containsKey(sha256)) {
        await File(outputPath).writeAsBytes(entryBytes, flush: true);
        files[sha256] = outputPath;
      }
      verifiedBytes += size;
      verifiedFiles++;
      sendProgress(
        PocketPackagePreparationProgress(
          stage: PocketPackagePreparationStage.verifyingFiles,
          processedBytes: verifiedBytes,
          totalBytes: totalBytes,
          processedFiles: verifiedFiles,
          totalFiles: expectedFiles.length,
        ),
      );
    }
    reply.send(<String, Object?>{'ok': true, 'files': files});
  } on PocketPackageException catch (error) {
    reply.send(<String, Object?>{
      'ok': false,
      'code': error.code,
      'message': error.message,
    });
  } on Object catch (error) {
    reply.send(<String, Object?>{
      'ok': false,
      'code': 'bundle-worker',
      'message': '$error',
    });
  }
}

Future<String> _fileHash(
  File file, [
  PocketCancellationToken? cancellation,
  void Function(int readBytes)? onBytes,
]) async {
  final output = <crypto.Digest>[];
  final converter = crypto.sha256.startChunkedConversion(
    ChunkedConversionSink<crypto.Digest>.withCallback(output.addAll),
  );
  var readBytes = 0;
  var lastReportedBytes = 0;
  await for (final chunk in file.openRead()) {
    cancellation?.throwIfCancelled();
    converter.add(chunk);
    readBytes += chunk.length;
    if (onBytes != null && readBytes - lastReportedBytes >= 256 * 1024) {
      onBytes(readBytes);
      lastReportedBytes = readBytes;
    }
  }
  converter.close();
  if (onBytes != null && lastReportedBytes < readBytes) {
    onBytes(readBytes);
  }
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

const int _zipLocalFileHeaderSig = 0x04034b50;
const int _zipCentralDirHeaderSig = 0x02014b50;
const int _zipEndOfCentralDirSig = 0x06054b50;
const int _zipUtf8Flag = 0x0800;
const int _zipDosDate1980 = 0x0021;

final Uint32List _crc32Table = () {
  final table = Uint32List(256);
  for (var i = 0; i < 256; i++) {
    var crc = i;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) != 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc & 0xffffffff;
  }
  return table;
}();

int pocketCrc32(List<int> bytes) {
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) {
    crc = (_crc32Table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) & 0xffffffff;
  }
  return (crc ^ 0xffffffff) & 0xffffffff;
}

/// Deterministic PKZIP encoder (supporting method 8 DEFLATE and method 0 STORE).
Uint8List encodePocketZip(Map<String, List<int>> entries) {
  if (entries.length > 0xffff) {
    throw const PocketPackageException(
      'zip entry count exceeds ZIP32 limit',
      code: 'bundle-format',
    );
  }
  final normalizedEntries = <({String name, Uint8List data})>[];
  for (final item in entries.entries) {
    final normalized = item.key.replaceAll('\\', '/');
    _validateAssetName(normalized);
    normalizedEntries.add((
      name: normalized,
      data: Uint8List.fromList(item.value),
    ));
  }
  normalizedEntries.sort((a, b) => a.name.compareTo(b.name));
  for (var i = 1; i < normalizedEntries.length; i++) {
    if (normalizedEntries[i].name == normalizedEntries[i - 1].name) {
      throw PocketPackageException(
        'duplicate zip entry ${normalizedEntries[i].name}',
        code: 'bundle-format',
      );
    }
  }

  final localParts = <Uint8List>[];
  final centralParts = <Uint8List>[];
  var localOffset = 0;
  final rawDeflater = ZLibEncoder(raw: true);

  for (final entry in normalizedEntries) {
    final nameBytes = Uint8List.fromList(utf8.encode(entry.name));
    if (nameBytes.length > 0xffff) {
      throw PocketPackageException(
        'zip entry name exceeds 65535 bytes: ${entry.name}',
        code: 'bundle-format',
      );
    }
    final uncompressed = entry.data;
    if (uncompressed.length > 0xffffffff) {
      throw PocketPackageException(
        'zip entry ${entry.name} exceeds ZIP32 size limit',
        code: 'bundle-format',
      );
    }
    final deflated = uncompressed.isEmpty
        ? uncompressed
        : Uint8List.fromList(rawDeflater.convert(uncompressed));
    final useDeflate =
        uncompressed.isNotEmpty && deflated.length < uncompressed.length;
    final method = useDeflate ? 8 : 0;
    final compressed = useDeflate ? deflated : uncompressed;
    if (compressed.length > 0xffffffff || localOffset > 0xffffffff) {
      throw const PocketPackageException(
        'zip archive exceeds ZIP32 offset or size limit',
        code: 'bundle-format',
      );
    }
    final checksum = pocketCrc32(uncompressed);

    final localHeader = Uint8List(30 + nameBytes.length);
    final localView = ByteData.sublistView(localHeader);
    localView.setUint32(0, _zipLocalFileHeaderSig, Endian.little);
    localView.setUint16(4, 20, Endian.little);
    localView.setUint16(6, _zipUtf8Flag, Endian.little);
    localView.setUint16(8, method, Endian.little);
    localView.setUint16(10, 0, Endian.little);
    localView.setUint16(12, _zipDosDate1980, Endian.little);
    localView.setUint32(14, checksum, Endian.little);
    localView.setUint32(18, compressed.length, Endian.little);
    localView.setUint32(22, uncompressed.length, Endian.little);
    localView.setUint16(26, nameBytes.length, Endian.little);
    localView.setUint16(28, 0, Endian.little);
    localHeader.setRange(30, 30 + nameBytes.length, nameBytes);

    final centralHeader = Uint8List(46 + nameBytes.length);
    final centralView = ByteData.sublistView(centralHeader);
    centralView.setUint32(0, _zipCentralDirHeaderSig, Endian.little);
    centralView.setUint16(4, 20, Endian.little);
    centralView.setUint16(6, 20, Endian.little);
    centralView.setUint16(8, _zipUtf8Flag, Endian.little);
    centralView.setUint16(10, method, Endian.little);
    centralView.setUint16(12, 0, Endian.little);
    centralView.setUint16(14, _zipDosDate1980, Endian.little);
    centralView.setUint32(16, checksum, Endian.little);
    centralView.setUint32(20, compressed.length, Endian.little);
    centralView.setUint32(24, uncompressed.length, Endian.little);
    centralView.setUint16(28, nameBytes.length, Endian.little);
    centralView.setUint16(30, 0, Endian.little);
    centralView.setUint16(32, 0, Endian.little);
    centralView.setUint16(34, 0, Endian.little);
    centralView.setUint16(36, 0, Endian.little);
    centralView.setUint32(38, 0, Endian.little);
    centralView.setUint32(42, localOffset, Endian.little);
    centralHeader.setRange(46, 46 + nameBytes.length, nameBytes);

    localParts.add(localHeader);
    localParts.add(compressed);
    centralParts.add(centralHeader);
    localOffset += localHeader.length + compressed.length;
  }

  final centralSize = centralParts.fold<int>(
    0,
    (sum, part) => sum + part.length,
  );
  if (centralSize > 0xffffffff ||
      localOffset > 0xffffffff ||
      localOffset + centralSize + 22 > 0xffffffff) {
    throw const PocketPackageException(
      'zip archive exceeds ZIP32 size limit',
      code: 'bundle-format',
    );
  }
  final eocd = Uint8List(22);
  final eocdView = ByteData.sublistView(eocd);
  eocdView.setUint32(0, _zipEndOfCentralDirSig, Endian.little);
  eocdView.setUint16(4, 0, Endian.little);
  eocdView.setUint16(6, 0, Endian.little);
  eocdView.setUint16(8, normalizedEntries.length, Endian.little);
  eocdView.setUint16(10, normalizedEntries.length, Endian.little);
  eocdView.setUint32(12, centralSize, Endian.little);
  eocdView.setUint32(16, localOffset, Endian.little);
  eocdView.setUint16(20, 0, Endian.little);

  final builder = BytesBuilder(copy: false);
  for (final part in localParts) builder.add(part);
  for (final part in centralParts) builder.add(part);
  builder.add(eocd);
  return builder.takeBytes();
}

final class _BoundedByteSink extends ByteConversionSinkBase {
  _BoundedByteSink({
    required this.maxAllowedBytes,
    required this.declaredUnpackSize,
    required this.exceedsLimitMessage,
    required this.exceedsDeclaredMessage,
    this.onBytes,
  });

  final int maxAllowedBytes;
  final int declaredUnpackSize;
  final String exceedsLimitMessage;
  final String exceedsDeclaredMessage;
  final void Function(int producedBytes)? onBytes;
  final BytesBuilder _builder = BytesBuilder(copy: false);
  int _produced = 0;
  int _nextProgressBytes = 256 * 1024;

  @override
  void add(List<int> chunk) {
    addSlice(chunk, 0, chunk.length, false);
  }

  @override
  void addSlice(List<int> chunk, int start, int end, bool isLast) {
    final len = end - start;
    if (len <= 0) return;
    _produced += len;
    if (_produced > maxAllowedBytes) {
      throw PocketPackageException(exceedsLimitMessage, code: 'manifest-size');
    }
    if (_produced > declaredUnpackSize) {
      throw PocketPackageException(
        exceedsDeclaredMessage,
        code: 'bundle-format',
      );
    }
    if (start == 0 && end == chunk.length) {
      _builder.add(chunk);
    } else if (chunk is Uint8List) {
      _builder.add(Uint8List.sublistView(chunk, start, end));
    } else {
      _builder.add(chunk.sublist(start, end));
    }
    final report = onBytes;
    if (report != null &&
        (_produced >= _nextProgressBytes || _produced == declaredUnpackSize)) {
      report(_produced);
      _nextProgressBytes = _produced + 256 * 1024;
    }
  }

  @override
  void close() {}

  Uint8List takeBytes() => _builder.takeBytes();
}

/// Validates and extracts a PKZIP archive into memory with strict path,
/// size, and CRC-32 verification.
Map<String, Uint8List> decodePocketZip(
  Uint8List archive, {
  int maxTotalBytes = 768 * 1024 * 1024,
  void Function(int decodedBytes)? onOutputBytes,
}) {
  if (archive.length < 22) {
    throw const PocketPackageException(
      'zip archive is truncated',
      code: 'bundle-format',
    );
  }
  final view = ByteData.sublistView(archive);
  var eocdOffset = -1;
  final minSearch = math.max(0, archive.length - 22 - 0xffff);
  for (var offset = archive.length - 22; offset >= minSearch; offset--) {
    if (view.getUint32(offset, Endian.little) == _zipEndOfCentralDirSig) {
      final commentLen = view.getUint16(offset + 20, Endian.little);
      if (offset + 22 + commentLen == archive.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw const PocketPackageException(
      'zip archive missing end of central directory',
      code: 'bundle-format',
    );
  }

  final entryCount = view.getUint16(eocdOffset + 10, Endian.little);
  final centralSize = view.getUint32(eocdOffset + 12, Endian.little);
  final centralOffset = view.getUint32(eocdOffset + 16, Endian.little);
  if (centralOffset < 0 ||
      centralSize < 0 ||
      centralOffset + centralSize > eocdOffset) {
    throw const PocketPackageException(
      'zip central directory out of bounds',
      code: 'bundle-format',
    );
  }

  final extracted = <String, Uint8List>{};
  var totalUncompressed = 0;
  var cursor = centralOffset;
  final rawInflater = ZLibDecoder(raw: true);

  for (var index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize ||
        view.getUint32(cursor, Endian.little) != _zipCentralDirHeaderSig) {
      throw const PocketPackageException(
        'invalid zip central directory header',
        code: 'bundle-format',
      );
    }
    final method = view.getUint16(cursor + 10, Endian.little);
    final expectedCrc = view.getUint32(cursor + 16, Endian.little);
    final compressedSize = view.getUint32(cursor + 20, Endian.little);
    final uncompressedSize = view.getUint32(cursor + 24, Endian.little);
    final nameLen = view.getUint16(cursor + 28, Endian.little);
    final extraLen = view.getUint16(cursor + 30, Endian.little);
    final commentLen = view.getUint16(cursor + 32, Endian.little);
    final localHeaderOffset = view.getUint32(cursor + 42, Endian.little);
    final headerTotal = 46 + nameLen + extraLen + commentLen;
    if (cursor + headerTotal > centralOffset + centralSize) {
      throw const PocketPackageException(
        'truncated zip central directory entry',
        code: 'bundle-format',
      );
    }
    final rawName = utf8.decode(
      Uint8List.sublistView(archive, cursor + 46, cursor + 46 + nameLen),
    );
    final name = rawName.replaceAll('\\', '/');
    _validateAssetName(name);
    if (extracted.containsKey(name)) {
      throw PocketPackageException(
        'duplicate zip entry $name',
        code: 'bundle-format',
      );
    }

    if (localHeaderOffset < 0 ||
        localHeaderOffset + 30 > centralOffset ||
        view.getUint32(localHeaderOffset, Endian.little) !=
            _zipLocalFileHeaderSig) {
      throw const PocketPackageException(
        'invalid zip local file header',
        code: 'bundle-format',
      );
    }
    final localNameLen = view.getUint16(localHeaderOffset + 26, Endian.little);
    final localExtraLen = view.getUint16(localHeaderOffset + 28, Endian.little);
    final dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset < 0 ||
        compressedSize < 0 ||
        dataOffset + compressedSize > centralOffset) {
      throw const PocketPackageException(
        'zip entry data out of bounds',
        code: 'bundle-format',
      );
    }

    if (uncompressedSize > maxTotalBytes - totalUncompressed) {
      throw const PocketPackageException(
        'zip uncompressed size exceeds limit',
        code: 'manifest-size',
      );
    }

    final compressedSlice = Uint8List.sublistView(
      archive,
      dataOffset,
      dataOffset + compressedSize,
    );
    late final Uint8List uncompressedBytes;
    if (method == 0) {
      if (compressedSize != uncompressedSize) {
        throw const PocketPackageException(
          'stored zip entry size mismatch',
          code: 'bundle-format',
        );
      }
      totalUncompressed += uncompressedSize;
      uncompressedBytes = Uint8List.fromList(compressedSlice);
    } else if (method == 8) {
      final remainingBudget = maxTotalBytes - totalUncompressed;
      final boundedSink = _BoundedByteSink(
        maxAllowedBytes: remainingBudget,
        declaredUnpackSize: uncompressedSize,
        exceedsLimitMessage: 'zip uncompressed size exceeds limit',
        exceedsDeclaredMessage:
            'zip entry $name inflated past declared size $uncompressedSize',
        onBytes: onOutputBytes == null
            ? null
            : (produced) => onOutputBytes(totalUncompressed + produced),
      );
      final sink = rawInflater.startChunkedConversion(boundedSink);
      try {
        const sliceSize = 16 * 1024;
        if (compressedSlice.isEmpty) {
          sink.add(const <int>[]);
        } else {
          for (
            var offset = 0;
            offset < compressedSlice.length;
            offset += sliceSize
          ) {
            final end = math.min(offset + sliceSize, compressedSlice.length);
            sink.addSlice(
              compressedSlice,
              offset,
              end,
              end == compressedSlice.length,
            );
          }
        }
        sink.close();
        uncompressedBytes = boundedSink.takeBytes();
      } on PocketPackageException {
        rethrow;
      } on Object catch (error) {
        throw PocketPackageException(
          'failed to inflate zip entry $name: $error',
          code: 'bundle-format',
        );
      }
      totalUncompressed += uncompressedBytes.length;
    } else {
      throw PocketPackageException(
        'unsupported zip compression method $method',
        code: 'bundle-format',
      );
    }

    if (uncompressedBytes.length != uncompressedSize ||
        pocketCrc32(uncompressedBytes) != expectedCrc) {
      throw PocketPackageException(
        'zip entry $name failed CRC-32 or length check',
        code: 'bundle-format',
      );
    }
    extracted[name] = uncompressedBytes;
    onOutputBytes?.call(totalUncompressed);
    cursor += headerTotal;
  }
  return extracted;
}
