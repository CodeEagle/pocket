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
      worker: json['worker'] == null ? null : Map<String, dynamic>.unmodifiable(_object(json['worker'], 'worker descriptor')),
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
      final declared = {...guestManifest.requiredCapabilities, ...guestManifest.optionalCapabilities};
      if (!isBytecode || descriptor['kind'] != 'quickjs-bytecode' ||
          descriptor['protocolVersion'] != 1 || descriptor['runtimeAbi'] != runtimeAbi ||
          asset == null || asset.sha256 != hash || asset.size != bytes || bytes <= 124 ||
          bytes > 64 * 1024 * 1024 || required is! List ||
          required.any((c) => c is! String || !declared.contains(c)) ||
          !declared.contains('runtime.worker')) {
        throw const PocketPackageException('worker descriptor is not bound to admitted bytecode/assets/capabilities', code: 'manifest-worker');
      }
    } else if (guestManifest.requiredCapabilities.contains('runtime.worker')) {
      throw const PocketPackageException('required worker descriptor is missing', code: 'manifest-worker');
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

  /// Downloads and verifies a signed one-shot ZIP bundle (`bundle.zip`),
  /// extracts all content-addressed blobs into `_blobs/<sha256>`, and returns
  /// the verified blob files keyed by SHA-256.
  Future<Map<String, File>> writeBundleZip({
    required PocketManifestBundle bundle,
    required List<PocketManifestFile> expectedFiles,
    required Stream<List<int>> bytes,
    required PocketCancellationToken cancellation,
    int maxArchiveBytes = 768 * 1024 * 1024,
    int maxTotalBytes = 768 * 1024 * 1024,
    void Function(int received)? onBytes,
  }) async {
    await initialize();
    if (bundle.size <= 0 || bundle.size > maxArchiveBytes) {
      throw const PocketPackageException('bundle exceeds size limit', code: 'download-size');
    }
    final temporaryId = '${DateTime.now().microsecondsSinceEpoch}-${_tempCounter++}';
    final archiveFile = File(path.join(_blobs.path, '.bundle-$temporaryId'));
    final extractionDirectory = Directory(path.join(_blobs.path, '.bundle-extract-$temporaryId'));
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
      if (received != bundle.size || digests.single.toString() != bundle.sha256) {
        throw const PocketPackageException(
          'bundle download hash or size mismatch',
          code: 'download-hash',
        );
      }
      cancellation.throwIfCancelled();
      await extractionDirectory.create();
      final extractedFiles = await _decodeBundleInWorker(
        archivePath: archiveFile.path,
        outputDirectory: extractionDirectory.path,
        format: bundle.format,
        maxTotalBytes: maxTotalBytes,
        expectedFiles: expectedFiles,
        requireExactEntries: bundle.blobs != null,
        cancellation: cancellation,
      );
      final blobs = <String, File>{};
      for (final file in expectedFiles) {
        cancellation.throwIfCancelled();
        final existing = await validBlob(file, cancellation: cancellation);
        if (existing != null) {
          // Partial archives promise the exact signed subset. Their extracted
          // bytes were already checked by the worker even when cache wins.
          blobs[file.sha256] = existing;
          continue;
        }
        final extracted = extractedFiles[file.sha256];
        if (extracted == null) {
          throw PocketPackageException(
            'bundle is missing blob ${file.sha256}',
            code: 'bundle-content',
          );
        }
        final target = File(path.join(_blobs.path, file.sha256));
        await _copyAtomic(extracted, target);
        blobs[file.sha256] = target;
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

  /// Keeps activation-pointer targets and, when [verifier] is supplied, up to
  /// [keep] newest complete signed versions that are not pointed to. Without
  /// a verifier, unpointed directories are removed as in the legacy API.
  Future<void> pruneInactiveVersions([
    String? applicationId,
    int keep = 2,
    PocketManifestVerifier? verifier,
  ]) =>
      _synchronized(() {
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
  required String format,
  required int maxTotalBytes,
  required List<PocketManifestFile> expectedFiles,
  required bool requireExactEntries,
  required PocketCancellationToken cancellation,
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
          message['message'] is String ? message['message'] as String : 'bundle decoder failed',
          code: message['code'] is String ? message['code'] as String : 'bundle-worker',
        ),
      );
      return;
    }
    final rawFiles = message['files'];
    if (rawFiles is! Map ||
        rawFiles.entries.any((entry) => entry.key is! String || entry.value is! String)) {
      outcome.completeError(
        const PocketPackageException(
          'bundle decoder returned invalid file paths',
          code: 'bundle-worker',
        ),
      );
      return;
    }
    outcome.complete(<String, String>{
      for (final entry in rawFiles.entries) entry.key as String: entry.value as String,
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
            format,
            maxTotalBytes,
            <List<Object?>>[
              for (final file in expectedFiles) <Object?>[file.sha256, file.size, file.url],
            ],
            requireExactEntries,
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
      cancellation.whenCancelled.then<Isolate>((_) => throw const PocketUpdateCancellation()),
    ]);
    // Unlike Isolate.run, this worker has an explicit lifetime. Closing the
    // package/session kills the decoder immediately instead of waiting for a
    // large pure-Dart inflate to finish on the caller isolate.
    cancellation.throwIfCancelled();
    final paths = await result;
    cancellation.throwIfCancelled();
    return <String, File>{for (final entry in paths.entries) entry.key: File(entry.value)};
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
    final format = request[3] as String;
    final maxTotalBytes = request[4] as int;
    final expectedFiles = (request[5] as List<Object?>).cast<List<Object?>>();
    final requireExactEntries = request[6] as bool;

    // Path-based transfer avoids duplicating an archive or extracted payload
    // of hundreds of MiB across isolate message queues.
    final archive = await File(archivePath).readAsBytes();
    final extracted = decodePocketBundle(archive, format: format, maxTotalBytes: maxTotalBytes);
    if (requireExactEntries) {
      final expectedPaths = expectedFiles.map((file) => file[2] as String).toSet();
      if (extracted.length != expectedPaths.length ||
          extracted.keys.any((name) => !expectedPaths.contains(name))) {
        throw const PocketPackageException(
          'partial bundle entries differ from its signed subset',
          code: 'bundle-content',
        );
      }
    }

    final files = <String, String>{};
    for (final file in expectedFiles) {
      final sha256 = file[0] as String;
      final size = file[1] as int;
      final url = file[2] as String;
      final entryBytes = extracted[url] ?? extracted['blobs/$sha256'] ?? extracted[sha256];
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
    }
    reply.send(<String, Object?>{'ok': true, 'files': files});
  } on PocketPackageException catch (error) {
    reply.send(<String, Object?>{'ok': false, 'code': error.code, 'message': error.message});
  } on Object catch (error) {
    reply.send(<String, Object?>{'ok': false, 'code': 'bundle-worker', 'message': '$error'});
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

  final centralSize = centralParts.fold<int>(0, (sum, part) => sum + part.length);
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

/// Validates and extracts a PKZIP archive into memory with strict path,
/// size, and CRC-32 verification.
Map<String, Uint8List> decodePocketZip(
  Uint8List archive, {
  int maxTotalBytes = 768 * 1024 * 1024,
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
    cursor += headerTotal;
  }
  return extracted;
}

const List<int> _sevenZipMagic = <int>[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

List<int> _write7zU64(int value) {
  if (value < 0) {
    throw PocketPackageException(
      'invalid 7z uint64 $value',
      code: 'bundle-format',
    );
  }
  var mask = 0x80;
  var firstByte = 0;
  for (var i = 0; i < 8; i++) {
    final limit = i < 7 ? (1 << (7 * (i + 1))) : -1;
    if (i < 7 && value < limit) {
      firstByte |= (value >>> (8 * i)) & (mask - 1);
      final out = <int>[firstByte];
      for (var j = 0; j < i; j++) {
        out.add((value >>> (8 * j)) & 0xff);
      }
      return out;
    }
    firstByte |= mask;
    mask >>>= 1;
  }
  final out = <int>[0xff];
  for (var j = 0; j < 8; j++) {
    out.add((value >>> (8 * j)) & 0xff);
  }
  return out;
}

Uint8List _encodeLzma2Uncompressed(Uint8List data) {
  if (data.isEmpty) return Uint8List.fromList(const <int>[0x00]);
  final builder = BytesBuilder(copy: false);
  var offset = 0;
  var first = true;
  while (offset < data.length) {
    final chunkLen = math.min(0x10000, data.length - offset);
    builder.add(<int>[
      first ? 0x01 : 0x02,
      ((chunkLen - 1) >>> 8) & 0xff,
      (chunkLen - 1) & 0xff,
    ]);
    first = false;
    builder.add(Uint8List.sublistView(data, offset, offset + chunkLen));
    offset += chunkLen;
  }
  builder.addByte(0x00);
  return builder.takeBytes();
}

List<int> _write7zBitVector(List<bool> bits) {
  final out = <int>[];
  var cur = 0;
  var mask = 0x80;
  for (final bit in bits) {
    if (bit) cur |= mask;
    mask >>>= 1;
    if (mask == 0) {
      out.add(cur);
      cur = 0;
      mask = 0x80;
    }
  }
  if (mask != 0x80) out.add(cur);
  return out;
}

/// Deterministic `.7z` (LZMA2) encoder in pure Dart.
Uint8List encodePocket7z(Map<String, List<int>> entries) {
  if (entries.length > 0xffff) {
    throw const PocketPackageException(
      '7z entry count exceeds 65535 limit',
      code: 'bundle-format',
    );
  }
  final normalizedEntries = <({String name, Uint8List data})>[];
  for (final item in entries.entries) {
    final normalized = item.key.replaceAll('\\', '/');
    _validateAssetName(normalized);
    if (utf8.encode(normalized).length > 0xffff) {
      throw PocketPackageException(
        '7z entry name exceeds 65535 bytes: $normalized',
        code: 'bundle-format',
      );
    }
    normalizedEntries.add((
      name: normalized,
      data: Uint8List.fromList(item.value),
    ));
  }
  normalizedEntries.sort((a, b) => a.name.compareTo(b.name));
  for (var i = 1; i < normalizedEntries.length; i++) {
    if (normalizedEntries[i].name == normalizedEntries[i - 1].name) {
      throw PocketPackageException(
        'duplicate 7z entry ${normalizedEntries[i].name}',
        code: 'bundle-format',
      );
    }
  }

  final nonEmpty = normalizedEntries
      .where((entry) => entry.data.isNotEmpty)
      .toList(growable: false);
  final rawBuilder = BytesBuilder(copy: false);
  for (final entry in nonEmpty) {
    rawBuilder.add(entry.data);
  }
  final rawPayload = rawBuilder.takeBytes();
  final packedPayload = nonEmpty.isNotEmpty
      ? _encodeLzma2Uncompressed(rawPayload)
      : Uint8List(0);

  final header = <int>[0x01]; // kHeader
  if (nonEmpty.isNotEmpty) {
    header
      ..add(0x04) // kMainStreamsInfo
      ..add(0x06) // kPackInfo
      ..addAll(_write7zU64(0))
      ..addAll(_write7zU64(1))
      ..add(0x09) // kSize
      ..addAll(_write7zU64(packedPayload.length))
      ..add(0x00) // kEnd PackInfo
      ..add(0x07) // kUnPackInfo
      ..add(0x0b) // kFolder
      ..addAll(_write7zU64(1))
      ..add(0x00) // external = 0
      ..addAll(_write7zU64(1)) // 1 coder
      ..add(0x21) // flags: idSize=1, hasAttrs=true
      ..add(0x21) // codecId: LZMA2
      ..addAll(_write7zU64(1)) // props size = 1
      ..add(0x18) // dict prop (4 MiB)
      ..add(0x0c) // kCodersUnPackSize
      ..addAll(_write7zU64(rawPayload.length));
    if (nonEmpty.length == 1) {
      final c = pocketCrc32(nonEmpty.first.data);
      header.addAll(<int>[
        0x0a,
        0x01,
        c & 0xff,
        (c >>> 8) & 0xff,
        (c >>> 16) & 0xff,
        (c >>> 24) & 0xff,
      ]);
    }
    header.add(0x00); // kEnd UnPackInfo
    if (nonEmpty.length > 1) {
      header
        ..add(0x08) // kSubStreamsInfo
        ..add(0x0d) // kNumUnPackStream
        ..addAll(_write7zU64(nonEmpty.length))
        ..add(0x09); // kSize
      for (var i = 0; i < nonEmpty.length - 1; i++) {
        header.addAll(_write7zU64(nonEmpty[i].data.length));
      }
      header
        ..add(0x0a)
        ..add(0x01);
      for (final entry in nonEmpty) {
        final c = pocketCrc32(entry.data);
        header.addAll(<int>[
          c & 0xff,
          (c >>> 8) & 0xff,
          (c >>> 16) & 0xff,
          (c >>> 24) & 0xff,
        ]);
      }
      header.add(0x00); // kEnd SubStreamsInfo
    }
    header.add(0x00); // kEnd MainStreamsInfo
  }

  header
    ..add(0x05) // kFilesInfo
    ..addAll(_write7zU64(normalizedEntries.length));
  final emptyFlags = normalizedEntries
      .map((entry) => entry.data.isEmpty)
      .toList(growable: false);
  final emptyCount = emptyFlags.where((flag) => flag).length;
  if (emptyCount > 0) {
    final emptyStreamVec = _write7zBitVector(emptyFlags);
    header
      ..add(0x0e)
      ..addAll(_write7zU64(emptyStreamVec.length))
      ..addAll(emptyStreamVec);
    final emptyFileVec = _write7zBitVector(
      List<bool>.filled(emptyCount, true),
    );
    header
      ..add(0x0f)
      ..addAll(_write7zU64(emptyFileVec.length))
      ..addAll(emptyFileVec);
  }
  if (normalizedEntries.isNotEmpty) {
    final nameProp = <int>[0x00]; // external = 0
    for (final entry in normalizedEntries) {
      for (var i = 0; i < entry.name.length; i++) {
        final code = entry.name.codeUnitAt(i);
        nameProp
          ..add(code & 0xff)
          ..add((code >>> 8) & 0xff);
      }
      nameProp
        ..add(0x00)
        ..add(0x00);
    }
    header
      ..add(0x11)
      ..addAll(_write7zU64(nameProp.length))
      ..addAll(nameProp);
  }
  header
    ..add(0x00) // kEnd FilesInfo
    ..add(0x00); // kEnd Header

  final headerBytes = Uint8List.fromList(header);
  final out = Uint8List(32 + packedPayload.length + headerBytes.length);
  out.setRange(0, _sevenZipMagic.length, _sevenZipMagic);
  out[6] = 0x00;
  out[7] = 0x04;
  final view = ByteData.sublistView(out);
  view.setUint64(12, packedPayload.length, Endian.little);
  view.setUint64(20, headerBytes.length, Endian.little);
  view.setUint32(28, pocketCrc32(headerBytes), Endian.little);
  view.setUint32(
    8,
    pocketCrc32(Uint8List.sublistView(out, 12, 32)),
    Endian.little,
  );
  out.setRange(32, 32 + packedPayload.length, packedPayload);
  out.setRange(
    32 + packedPayload.length,
    32 + packedPayload.length + headerBytes.length,
    headerBytes,
  );
  return out;
}

final class _LzmaBufferDecoder {
  _LzmaBufferDecoder(int expectedSize) : out = Uint8List(expectedSize);

  final Uint8List out;
  int outPos = 0;
  int dictResetPos = 0;
  int lc = 3;
  int lp = 0;
  int pb = 2;
  int state = 0;
  final List<int> reps = <int>[0, 0, 0, 0];
  final Uint16List isMatch = Uint16List(192);
  final Uint16List isRep = Uint16List(12);
  final Uint16List isRepG0 = Uint16List(12);
  final Uint16List isRepG1 = Uint16List(12);
  final Uint16List isRepG2 = Uint16List(12);
  final Uint16List isRep0Long = Uint16List(192);
  final List<Uint16List> posSlotDecoder = List<Uint16List>.generate(
    4,
    (_) => Uint16List(64),
  );
  final Uint16List posDecoders = Uint16List(114);
  final Uint16List alignDecoder = Uint16List(16);
  Uint16List litProbs = Uint16List(0x300);
  int lenChoice = 0x400;
  int lenChoice2 = 0x400;
  final List<Uint16List> lenLow = List<Uint16List>.generate(
    16,
    (_) => Uint16List(8),
  );
  final List<Uint16List> lenMid = List<Uint16List>.generate(
    16,
    (_) => Uint16List(8),
  );
  final Uint16List lenHigh = Uint16List(256);
  int repLenChoice = 0x400;
  int repLenChoice2 = 0x400;
  final List<Uint16List> repLenLow = List<Uint16List>.generate(
    16,
    (_) => Uint16List(8),
  );
  final List<Uint16List> repLenMid = List<Uint16List>.generate(
    16,
    (_) => Uint16List(8),
  );
  final Uint16List repLenHigh = Uint16List(256);
  bool propsInitialized = false;

  void resetDictionary() {
    dictResetPos = outPos;
  }

  void resetProps(int propByte) {
    if (propByte >= 9 * 5 * 5) {
      throw const PocketPackageException(
        'invalid 7z LZMA properties byte',
        code: 'bundle-format',
      );
    }
    lc = propByte % 9;
    final rem = propByte ~/ 9;
    lp = rem % 5;
    pb = rem ~/ 5;
    litProbs = Uint16List(0x300 << (lc + lp));
    propsInitialized = true;
  }

  void resetState() {
    if (!propsInitialized) {
      throw const PocketPackageException(
        '7z LZMA properties not initialized',
        code: 'bundle-format',
      );
    }
    state = 0;
    reps[0] = 0;
    reps[1] = 0;
    reps[2] = 0;
    reps[3] = 0;
    isMatch.fillRange(0, isMatch.length, 0x400);
    isRep.fillRange(0, isRep.length, 0x400);
    isRepG0.fillRange(0, isRepG0.length, 0x400);
    isRepG1.fillRange(0, isRepG1.length, 0x400);
    isRepG2.fillRange(0, isRepG2.length, 0x400);
    isRep0Long.fillRange(0, isRep0Long.length, 0x400);
    for (final a in posSlotDecoder) {
      a.fillRange(0, a.length, 0x400);
    }
    posDecoders.fillRange(0, posDecoders.length, 0x400);
    alignDecoder.fillRange(0, alignDecoder.length, 0x400);
    litProbs.fillRange(0, litProbs.length, 0x400);
    lenChoice = 0x400;
    lenChoice2 = 0x400;
    for (final a in lenLow) {
      a.fillRange(0, a.length, 0x400);
    }
    for (final a in lenMid) {
      a.fillRange(0, a.length, 0x400);
    }
    lenHigh.fillRange(0, lenHigh.length, 0x400);
    repLenChoice = 0x400;
    repLenChoice2 = 0x400;
    for (final a in repLenLow) {
      a.fillRange(0, a.length, 0x400);
    }
    for (final a in repLenMid) {
      a.fillRange(0, a.length, 0x400);
    }
    repLenHigh.fillRange(0, repLenHigh.length, 0x400);
  }

  void copyUncompressed(Uint8List src, int offset, int len) {
    if (offset < 0 || len < 0 || offset + len > src.length) {
      throw const PocketPackageException(
        'truncated 7z LZMA2 uncompressed chunk',
        code: 'bundle-format',
      );
    }
    if (outPos + len > out.length) {
      throw const PocketPackageException(
        '7z LZMA2 output exceeds declared unpack size',
        code: 'bundle-format',
      );
    }
    out.setRange(outPos, outPos + len, src, offset);
    outPos += len;
  }

  int _getByte(int dist) {
    final avail = outPos - dictResetPos;
    if (dist <= 0 || dist > avail) {
      throw const PocketPackageException(
        'corrupted 7z LZMA back-reference distance',
        code: 'bundle-format',
      );
    }
    return out[outPos - dist];
  }

  void _putByte(int b) {
    if (outPos >= out.length) {
      throw const PocketPackageException(
        '7z LZMA output exceeds declared unpack size',
        code: 'bundle-format',
      );
    }
    out[outPos++] = b & 0xff;
  }

  void decodeChunk(Uint8List inBuf, int unpackSize) {
    if (!propsInitialized) {
      throw const PocketPackageException(
        '7z LZMA properties not initialized',
        code: 'bundle-format',
      );
    }
    if (inBuf.length < 5 || inBuf[0] != 0) {
      throw const PocketPackageException(
        'invalid or truncated 7z LZMA stream',
        code: 'bundle-format',
      );
    }
    if (outPos + unpackSize > out.length) {
      throw const PocketPackageException(
        '7z LZMA chunk exceeds declared unpack size',
        code: 'bundle-format',
      );
    }
    var inPos = 1;
    var range = 0xffffffff;
    var code = 0;
    for (var i = 0; i < 4; i++) {
      code = ((code << 8) | inBuf[inPos++]) & 0xffffffff;
    }
    int readByte() {
      if (inPos >= inBuf.length) {
        throw const PocketPackageException(
          'truncated 7z LZMA input stream',
          code: 'bundle-format',
        );
      }
      return inBuf[inPos++];
    }

    int decodeBit(Uint16List probs, int idx) {
      if (range < 0x01000000) {
        code = ((code << 8) | readByte()) & 0xffffffff;
        range = (range << 8) & 0xffffffff;
      }
      final prob = probs[idx];
      final bound = ((range >>> 11) * prob) & 0xffffffff;
      if (code < bound) {
        range = bound;
        probs[idx] = (prob + ((2048 - prob) >>> 5)) & 0xffff;
        return 0;
      } else {
        range = (range - bound) & 0xffffffff;
        code = (code - bound) & 0xffffffff;
        probs[idx] = (prob - (prob >>> 5)) & 0xffff;
        return 1;
      }
    }

    (int, int) decodeBitScalar(int prob) {
      if (range < 0x01000000) {
        code = ((code << 8) | readByte()) & 0xffffffff;
        range = (range << 8) & 0xffffffff;
      }
      final bound = ((range >>> 11) * prob) & 0xffffffff;
      late final int bit;
      late final int nextProb;
      if (code < bound) {
        range = bound;
        nextProb = (prob + ((2048 - prob) >>> 5)) & 0xffff;
        bit = 0;
      } else {
        range = (range - bound) & 0xffffffff;
        code = (code - bound) & 0xffffffff;
        nextProb = (prob - (prob >>> 5)) & 0xffff;
        bit = 1;
      }
      return (bit, nextProb);
    }

    int decodeBitTree(Uint16List probs, int numBits) {
      var m = 1;
      for (var i = 0; i < numBits; i++) {
        m = (m << 1) | decodeBit(probs, m);
      }
      return m - (1 << numBits);
    }

    int decodeReverseBitTree(Uint16List probs, int offset, int numBits) {
      var m = 1;
      var symbol = 0;
      for (var i = 0; i < numBits; i++) {
        final bit = decodeBit(probs, offset + m);
        m = (m << 1) | bit;
        symbol |= bit << i;
      }
      return symbol;
    }

    int decodeDirectBits(int numBits) {
      var res = 0;
      for (var i = numBits; i > 0; i--) {
        if (range < 0x01000000) {
          code = ((code << 8) | readByte()) & 0xffffffff;
          range = (range << 8) & 0xffffffff;
        }
        range = (range >>> 1) & 0xffffffff;
        res <<= 1;
        if (code >= range) {
          code = (code - range) & 0xffffffff;
          res |= 1;
        }
      }
      return res;
    }

    int decodeLen(bool isRepLen, int posState) {
      if (isRepLen) {
        final (b1, next1) = decodeBitScalar(repLenChoice);
        repLenChoice = next1;
        if (b1 == 0) return decodeBitTree(repLenLow[posState], 3);
        final (b2, next2) = decodeBitScalar(repLenChoice2);
        repLenChoice2 = next2;
        if (b2 == 0) return 8 + decodeBitTree(repLenMid[posState], 3);
        return 16 + decodeBitTree(repLenHigh, 8);
      } else {
        final (b1, next1) = decodeBitScalar(lenChoice);
        lenChoice = next1;
        if (b1 == 0) return decodeBitTree(lenLow[posState], 3);
        final (b2, next2) = decodeBitScalar(lenChoice2);
        lenChoice2 = next2;
        if (b2 == 0) return 8 + decodeBitTree(lenMid[posState], 3);
        return 16 + decodeBitTree(lenHigh, 8);
      }
    }

    final posStateMask = (1 << pb) - 1;
    final lpMask = (1 << lp) - 1;
    var chunkWritten = 0;
    while (chunkWritten < unpackSize) {
      final totalPos = outPos - dictResetPos;
      final posState = totalPos & posStateMask;
      if (decodeBit(isMatch, (state << 4) + posState) == 0) {
        final prevByte = totalPos > 0 ? _getByte(1) : 0;
        final litState = ((totalPos & lpMask) << lc) + (prevByte >>> (8 - lc));
        final probsOffset = 0x300 * litState;
        var symbol = 1;
        if (state >= 7) {
          var matchByte = _getByte(reps[0] + 1);
          do {
            final matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            final bit = decodeBit(
              litProbs,
              probsOffset + ((1 + matchBit) << 8) + symbol,
            );
            symbol = (symbol << 1) | bit;
            if (matchBit != bit) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decodeBit(litProbs, probsOffset + symbol);
        }
        _putByte(symbol & 0xff);
        chunkWritten++;
        state = state < 4
            ? 0
            : state < 10
            ? state - 3
            : state - 6;
      } else {
        late final int len;
        if (decodeBit(isRep, state) == 1) {
          if (decodeBit(isRepG0, state) == 0) {
            if (decodeBit(isRep0Long, (state << 4) + posState) == 0) {
              state = state < 7 ? 9 : 11;
              _putByte(_getByte(reps[0] + 1));
              chunkWritten++;
              continue;
            }
          } else {
            late final int dist;
            if (decodeBit(isRepG1, state) == 0) {
              dist = reps[1];
            } else {
              if (decodeBit(isRepG2, state) == 0) {
                dist = reps[2];
              } else {
                dist = reps[3];
                reps[3] = reps[2];
              }
              reps[2] = reps[1];
            }
            reps[1] = reps[0];
            reps[0] = dist;
          }
          len = decodeLen(true, posState) + 2;
          state = state < 7 ? 8 : 11;
        } else {
          reps[3] = reps[2];
          reps[2] = reps[1];
          reps[1] = reps[0];
          len = decodeLen(false, posState) + 2;
          state = state < 7 ? 7 : 10;
          final posSlot = decodeBitTree(
            posSlotDecoder[len - 2 < 4 ? len - 2 : 3],
            6,
          );
          if (posSlot >= 4) {
            final numDirectBits = (posSlot >>> 1) - 1;
            var dist = (2 | (posSlot & 1)) << numDirectBits;
            if (posSlot < 14) {
              dist += decodeReverseBitTree(
                posDecoders,
                dist - posSlot - 1,
                numDirectBits,
              );
            } else {
              dist += decodeDirectBits(numDirectBits - 4) << 4;
              dist += decodeReverseBitTree(alignDecoder, 0, 4);
            }
            reps[0] = dist;
          } else {
            reps[0] = posSlot;
          }
        }
        if (chunkWritten + len > unpackSize) {
          throw const PocketPackageException(
            '7z LZMA match exceeds declared chunk unpack size',
            code: 'bundle-format',
          );
        }
        for (var i = 0; i < len; i++) {
          _putByte(_getByte(reps[0] + 1));
          chunkWritten++;
        }
      }
    }
  }

  Uint8List finish() {
    if (outPos != out.length) {
      throw PocketPackageException(
        '7z decoded $outPos bytes, expected ${out.length}',
        code: 'bundle-format',
      );
    }
    return out;
  }
}

Uint8List _decodeLzma1Stream(
  Uint8List props,
  Uint8List inBuf,
  int expectedSize,
) {
  if (props.length < 5) {
    throw const PocketPackageException(
      '7z LZMA1 coder properties too short',
      code: 'bundle-format',
    );
  }
  if (expectedSize == 0) return Uint8List(0);
  final decoder = _LzmaBufferDecoder(expectedSize)
    ..resetProps(props[0])
    ..resetState()
    ..decodeChunk(inBuf, expectedSize);
  return decoder.finish();
}

Uint8List _decodeLzma2Stream(
  Uint8List props,
  Uint8List inBuf,
  int expectedSize,
) {
  if (props.isEmpty || (props[0] & 0x3f) > 40) {
    throw const PocketPackageException(
      'invalid 7z LZMA2 coder properties',
      code: 'bundle-format',
    );
  }
  final decoder = _LzmaBufferDecoder(expectedSize);
  var pos = 0;
  var sawEnd = false;
  while (pos < inBuf.length) {
    final control = inBuf[pos++];
    if (control == 0x00) {
      sawEnd = true;
      break;
    }
    if (control == 0x01 || control == 0x02) {
      if (pos + 2 > inBuf.length) {
        throw const PocketPackageException(
          'truncated 7z LZMA2 uncompressed chunk header',
          code: 'bundle-format',
        );
      }
      final unpackSize = ((inBuf[pos] << 8) | inBuf[pos + 1]) + 1;
      pos += 2;
      if (control == 0x01) decoder.resetDictionary();
      decoder.copyUncompressed(inBuf, pos, unpackSize);
      pos += unpackSize;
    } else if (control >= 0x80) {
      if (pos + 4 > inBuf.length) {
        throw const PocketPackageException(
          'truncated 7z LZMA2 compressed chunk header',
          code: 'bundle-format',
        );
      }
      final unpackSize =
          (((control & 0x1f) << 16) | (inBuf[pos] << 8) | inBuf[pos + 1]) + 1;
      final packSize = ((inBuf[pos + 2] << 8) | inBuf[pos + 3]) + 1;
      pos += 4;
      final mode = (control >>> 5) & 3;
      if (mode >= 2) {
        if (pos >= inBuf.length) {
          throw const PocketPackageException(
            'missing 7z LZMA2 property byte',
            code: 'bundle-format',
          );
        }
        final propByte = inBuf[pos++];
        if (mode == 3) decoder.resetDictionary();
        decoder
          ..resetProps(propByte)
          ..resetState();
      } else if (mode == 1) {
        decoder.resetState();
      }
      if (pos + packSize > inBuf.length) {
        throw const PocketPackageException(
          'truncated 7z LZMA2 compressed chunk data',
          code: 'bundle-format',
        );
      }
      decoder.decodeChunk(
        Uint8List.sublistView(inBuf, pos, pos + packSize),
        unpackSize,
      );
      pos += packSize;
    } else {
      throw PocketPackageException(
        'invalid 7z LZMA2 control byte 0x${control.toRadixString(16)}',
        code: 'bundle-format',
      );
    }
  }
  if (!sawEnd && expectedSize > 0) {
    throw const PocketPackageException(
      '7z LZMA2 stream missing end marker',
      code: 'bundle-format',
    );
  }
  return decoder.finish();
}

final class _SevenZipHeaderReader {
  _SevenZipHeaderReader(this.buf);

  final Uint8List buf;
  int pos = 0;

  int readByte() {
    if (pos >= buf.length) {
      throw const PocketPackageException(
        'unexpected EOF in 7z header',
        code: 'bundle-format',
      );
    }
    return buf[pos++];
  }

  Uint8List readBytes(int len) {
    if (len < 0 || pos + len > buf.length) {
      throw const PocketPackageException(
        'unexpected EOF in 7z header slice',
        code: 'bundle-format',
      );
    }
    final sub = Uint8List.sublistView(buf, pos, pos + len);
    pos += len;
    return sub;
  }

  int readU32() {
    if (pos + 4 > buf.length) {
      throw const PocketPackageException(
        'unexpected EOF reading 7z uint32',
        code: 'bundle-format',
      );
    }
    final v =
        (buf[pos] |
            (buf[pos + 1] << 8) |
            (buf[pos + 2] << 16) |
            (buf[pos + 3] << 24)) &
        0xffffffff;
    pos += 4;
    return v;
  }

  int readU64() {
    final b0 = readByte();
    var mask = 0x80;
    var extra = 0;
    for (var i = 0; i < 8; i++) {
      if ((b0 & mask) == 0) {
        extra = i;
        break;
      }
      mask >>>= 1;
      if (i == 7) extra = 8;
    }
    var val = 0;
    for (var i = 0; i < extra; i++) {
      val |= readByte() << (8 * i);
    }
    if (extra < 8) {
      final high = b0 & (mask - 1);
      val |= high << (8 * extra);
    }
    if (val < 0) {
      throw const PocketPackageException(
        '7z uint64 overflow',
        code: 'bundle-format',
      );
    }
    return val;
  }

  List<bool> readBitVector(int count) {
    if (count < 0 || count > 0xffff || pos + ((count + 7) >> 3) > buf.length) {
      throw const PocketPackageException(
        '7z bit vector count out of bounds',
        code: 'bundle-format',
      );
    }
    final bits = List<bool>.filled(count, false);
    var mask = 0;
    var cur = 0;
    for (var i = 0; i < count; i++) {
      if (mask == 0) {
        cur = readByte();
        mask = 0x80;
      }
      bits[i] = (cur & mask) != 0;
      mask >>>= 1;
    }
    return bits;
  }

  List<bool> readAllOrBits(int count) {
    if (count < 0 || count > 0xffff) {
      throw const PocketPackageException(
        '7z defined-vector count out of bounds',
        code: 'bundle-format',
      );
    }
    final allDefined = readByte();
    if (allDefined != 0) return List<bool>.filled(count, true);
    return readBitVector(count);
  }

  List<int?> readDigests(int count) {
    final defined = readAllOrBits(count);
    var definedCount = 0;
    for (final isDef in defined) {
      if (isDef) definedCount++;
    }
    if (pos + definedCount * 4 > buf.length) {
      throw const PocketPackageException(
        'unexpected EOF reading 7z CRC digests',
        code: 'bundle-format',
      );
    }
    return <int?>[for (final isDef in defined) isDef ? readU32() : null];
  }
}

final class _BoundedByteSink extends ByteConversionSinkBase {
  _BoundedByteSink({
    required this.maxAllowedBytes,
    required this.declaredUnpackSize,
    required this.exceedsLimitMessage,
    required this.exceedsDeclaredMessage,
  });

  final int maxAllowedBytes;
  final int declaredUnpackSize;
  final String exceedsLimitMessage;
  final String exceedsDeclaredMessage;
  final BytesBuilder _builder = BytesBuilder(copy: false);
  int _produced = 0;

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
      throw PocketPackageException(
        exceedsLimitMessage,
        code: 'manifest-size',
      );
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
  }

  @override
  void close() {}

  Uint8List takeBytes() => _builder.takeBytes();
}

final class _SevenZipCoder {
  const _SevenZipCoder({
    required this.codecId,
    required this.props,
    required this.numInStreams,
    required this.numOutStreams,
  });

  final Uint8List codecId;
  final Uint8List props;
  final int numInStreams;
  final int numOutStreams;
}

final class _SevenZipFolder {
  _SevenZipFolder({
    required this.coders,
    required this.packedStreamIndices,
  });

  final List<_SevenZipCoder> coders;
  final List<int> packedStreamIndices;
  final List<int> unpackSizes = <int>[];
  int unpackSize = 0;
  int? crc;
}

final class _SevenZipStreamsInfo {
  const _SevenZipStreamsInfo({
    required this.packPos,
    required this.packSizes,
    required this.packCrcs,
    required this.folders,
    required this.subStreamSizes,
    required this.subStreamCrcs,
  });

  final int packPos;
  final List<int> packSizes;
  final List<int?> packCrcs;
  final List<_SevenZipFolder> folders;
  final List<List<int>> subStreamSizes;
  final List<List<int?>> subStreamCrcs;
}

_SevenZipStreamsInfo _parse7zStreamsInfo(_SevenZipHeaderReader r) {
  var id = r.readByte();
  var packPos = 0;
  var packSizes = <int>[];
  var packCrcs = <int?>[];
  if (id == 0x06) {
    packPos = r.readU64();
    final numPackStreams = r.readU64();
    if (numPackStreams > 0xffff) {
      throw const PocketPackageException(
        '7z pack stream count exceeds 65535 limit',
        code: 'bundle-format',
      );
    }
    id = r.readByte();
    while (id != 0x00) {
      if (id == 0x09) {
        packSizes = <int>[for (var i = 0; i < numPackStreams; i++) r.readU64()];
      } else if (id == 0x0a) {
        packCrcs = r.readDigests(numPackStreams);
      } else {
        final skip = r.readU64();
        r.readBytes(skip);
      }
      id = r.readByte();
    }
    id = r.readByte();
  }

  final folders = <_SevenZipFolder>[];
  if (id == 0x07) {
    id = r.readByte();
    if (id != 0x0b) {
      throw const PocketPackageException(
        'invalid 7z UnPackInfo folder marker',
        code: 'bundle-format',
      );
    }
    final numFolders = r.readU64();
    if (numFolders > 0xffff) {
      throw const PocketPackageException(
        '7z folder count exceeds 65535 limit',
        code: 'bundle-format',
      );
    }
    if (r.readByte() != 0) {
      throw const PocketPackageException(
        'external 7z folders are not supported',
        code: 'bundle-format',
      );
    }
    for (var f = 0; f < numFolders; f++) {
      final numCoders = r.readU64();
      if (numCoders == 0 || numCoders > 64) {
        throw const PocketPackageException(
          '7z coder count out of bounds',
          code: 'bundle-format',
        );
      }
      final coders = <_SevenZipCoder>[];
      var totalIn = 0;
      var totalOut = 0;
      for (var c = 0; c < numCoders; c++) {
        final flags = r.readByte();
        final idSize = flags & 0x0f;
        final isComplex = (flags & 0x10) != 0;
        final hasAttrs = (flags & 0x20) != 0;
        final codecId = r.readBytes(idSize);
        final numIn = isComplex ? r.readU64() : 1;
        final numOut = isComplex ? r.readU64() : 1;
        if (numIn == 0 || numIn > 64 || numOut == 0 || numOut > 64) {
          throw const PocketPackageException(
            '7z coder stream arity out of bounds',
            code: 'bundle-format',
          );
        }
        final props = hasAttrs ? r.readBytes(r.readU64()) : Uint8List(0);
        coders.add(
          _SevenZipCoder(
            codecId: codecId,
            props: props,
            numInStreams: numIn,
            numOutStreams: numOut,
          ),
        );
        totalIn += numIn;
        totalOut += numOut;
      }
      final numBindPairs = totalOut - 1;
      final boundIn = <int>{};
      for (var b = 0; b < numBindPairs; b++) {
        boundIn.add(r.readU64());
        r.readU64();
      }
      final numPacked = totalIn - numBindPairs;
      final packedIndices = <int>[];
      if (numPacked == 1) {
        for (var i = 0; i < totalIn; i++) {
          if (!boundIn.contains(i)) {
            packedIndices.add(i);
            break;
          }
        }
      } else {
        for (var i = 0; i < numPacked; i++) {
          packedIndices.add(r.readU64());
        }
      }
      folders.add(
        _SevenZipFolder(coders: coders, packedStreamIndices: packedIndices),
      );
    }
    id = r.readByte();
    if (id != 0x0c) {
      throw const PocketPackageException(
        'missing 7z kCodersUnPackSize marker',
        code: 'bundle-format',
      );
    }
    for (final folder in folders) {
      final totalOut = folder.coders.fold<int>(
        0,
        (sum, c) => sum + c.numOutStreams,
      );
      for (var i = 0; i < totalOut; i++) {
        folder.unpackSizes.add(r.readU64());
      }
      folder.unpackSize = folder.unpackSizes.isEmpty
          ? 0
          : folder.unpackSizes.last;
    }
    id = r.readByte();
    if (id == 0x0a) {
      final crcs = r.readDigests(folders.length);
      for (var i = 0; i < folders.length; i++) {
        folders[i].crc = crcs[i];
      }
      id = r.readByte();
    }
    if (id != 0x00) {
      throw const PocketPackageException(
        'missing 7z UnPackInfo end marker',
        code: 'bundle-format',
      );
    }
    id = r.readByte();
  }

  final numUnPackStreams = List<int>.filled(folders.length, 1);
  final subStreamSizes = <List<int>>[
    for (final f in folders) <int>[f.unpackSize],
  ];
  final subStreamCrcs = <List<int?>>[
    for (final f in folders) <int?>[f.crc],
  ];
  if (id == 0x08) {
    var sawSubStreamCrcs = false;
    id = r.readByte();
    while (id != 0x00) {
      if (id == 0x0d) {
        var totalSubStreams = 0;
        for (var i = 0; i < folders.length; i++) {
          final subCount = r.readU64();
          if (subCount > 0xffff || totalSubStreams + subCount > 0xffff) {
            throw const PocketPackageException(
              '7z substream count exceeds 65535 limit',
              code: 'bundle-format',
            );
          }
          totalSubStreams += subCount;
          numUnPackStreams[i] = subCount;
        }
      } else if (id == 0x09) {
        for (var i = 0; i < folders.length; i++) {
          final count = numUnPackStreams[i];
          if (count == 0) {
            subStreamSizes[i] = const <int>[];
            continue;
          }
          final sizes = <int>[];
          var sum = 0;
          for (var j = 0; j < count - 1; j++) {
            final s = r.readU64();
            sizes.add(s);
            sum += s;
          }
          if (sum > folders[i].unpackSize) {
            throw const PocketPackageException(
              '7z substream sizes exceed folder unpack size',
              code: 'bundle-format',
            );
          }
          sizes.add(folders[i].unpackSize - sum);
          subStreamSizes[i] = sizes;
        }
      } else if (id == 0x0a) {
        sawSubStreamCrcs = true;
        var unknownCrcs = 0;
        for (var i = 0; i < folders.length; i++) {
          final count = numUnPackStreams[i];
          if (!(count == 1 && folders[i].crc != null)) {
            unknownCrcs += count;
          }
        }
        final digests = r.readDigests(unknownCrcs);
        var dIdx = 0;
        for (var i = 0; i < folders.length; i++) {
          final count = numUnPackStreams[i];
          if (count == 1 && folders[i].crc != null) {
            subStreamCrcs[i] = <int?>[folders[i].crc];
          } else {
            subStreamCrcs[i] = <int?>[
              for (var j = 0; j < count; j++) digests[dIdx++],
            ];
          }
        }
      } else {
        final skip = r.readU64();
        r.readBytes(skip);
      }
      id = r.readByte();
    }
    for (var i = 0; i < folders.length; i++) {
      if (numUnPackStreams[i] == 1 && subStreamSizes[i].length != 1) {
        subStreamSizes[i] = <int>[folders[i].unpackSize];
      }
      if (!sawSubStreamCrcs && numUnPackStreams[i] != 1) {
        subStreamCrcs[i] = List<int?>.filled(numUnPackStreams[i], null);
      }
    }
    id = r.readByte();
  }
  if (id != 0x00) {
    throw const PocketPackageException(
      'missing 7z StreamsInfo end marker',
      code: 'bundle-format',
    );
  }
  return _SevenZipStreamsInfo(
    packPos: packPos,
    packSizes: packSizes,
    packCrcs: packCrcs,
    folders: folders,
    subStreamSizes: subStreamSizes,
    subStreamCrcs: subStreamCrcs,
  );
}

Uint8List _decode7zFolder(
  Uint8List archive,
  _SevenZipStreamsInfo streams,
  int folderIdx,
  int packStreamOffset,
  int packSize,
  int maxAllowedBytes,
) {
  final folder = streams.folders[folderIdx];
  if (folder.unpackSize > maxAllowedBytes) {
    throw const PocketPackageException(
      '7z uncompressed size exceeds limit',
      code: 'manifest-size',
    );
  }
  final dataStart = 32 + streams.packPos + packStreamOffset;
  if (dataStart < 32 ||
      packSize < 0 ||
      dataStart + packSize > archive.length) {
    throw const PocketPackageException(
      '7z packed stream out of bounds',
      code: 'bundle-format',
    );
  }
  if (folder.coders.length != 1) {
    throw const PocketPackageException(
      'unsupported multi-coder 7z filter chain',
      code: 'bundle-format',
    );
  }
  final coder = folder.coders.single;
  final packed = Uint8List.sublistView(archive, dataStart, dataStart + packSize);
  final expectedPackCrc =
      folderIdx < streams.packCrcs.length ? streams.packCrcs[folderIdx] : null;
  if (expectedPackCrc != null && pocketCrc32(packed) != expectedPackCrc) {
    throw const PocketPackageException(
      '7z packed stream CRC-32 mismatch',
      code: 'bundle-format',
    );
  }
  late final Uint8List unpacked;
  if (coder.codecId.length == 1 && coder.codecId[0] == 0x00) {
    if (packed.length != folder.unpackSize) {
      throw const PocketPackageException(
        '7z Copy coder size mismatch',
        code: 'bundle-format',
      );
    }
    unpacked = Uint8List.fromList(packed);
  } else if (coder.codecId.length == 1 && coder.codecId[0] == 0x21) {
    unpacked = _decodeLzma2Stream(coder.props, packed, folder.unpackSize);
  } else if (coder.codecId.length == 3 &&
      coder.codecId[0] == 0x03 &&
      coder.codecId[1] == 0x01 &&
      coder.codecId[2] == 0x01) {
    unpacked = _decodeLzma1Stream(coder.props, packed, folder.unpackSize);
  } else if (coder.codecId.length == 3 &&
      coder.codecId[0] == 0x04 &&
      coder.codecId[1] == 0x01 &&
      coder.codecId[2] == 0x08) {
    final boundedSink = _BoundedByteSink(
      maxAllowedBytes: maxAllowedBytes,
      declaredUnpackSize: folder.unpackSize,
      exceedsLimitMessage: '7z uncompressed size exceeds limit',
      exceedsDeclaredMessage:
          '7z Deflate stream exceeded declared unpack size',
    );
    final sink = ZLibDecoder(raw: true).startChunkedConversion(boundedSink);
    try {
      const sliceSize = 16 * 1024;
      if (packed.isEmpty) {
        sink.add(const <int>[]);
      } else {
        for (var offset = 0; offset < packed.length; offset += sliceSize) {
          final end = math.min(offset + sliceSize, packed.length);
          sink.addSlice(packed, offset, end, end == packed.length);
        }
      }
      sink.close();
      unpacked = boundedSink.takeBytes();
    } on PocketPackageException {
      rethrow;
    } on Object catch (error) {
      throw PocketPackageException(
        'failed to inflate 7z Deflate stream: $error',
        code: 'bundle-format',
      );
    }
    if (unpacked.length != folder.unpackSize) {
      throw const PocketPackageException(
        '7z Deflate coder size mismatch',
        code: 'bundle-format',
      );
    }
  } else {
    throw const PocketPackageException(
      'unsupported 7z compression coder',
      code: 'bundle-format',
    );
  }
  if (folder.crc != null && pocketCrc32(unpacked) != folder.crc) {
    throw const PocketPackageException(
      '7z folder CRC-32 mismatch',
      code: 'bundle-format',
    );
  }
  return unpacked;
}

/// Validates and extracts a `.7z` archive into memory in pure Dart with strict
/// path, size (`maxTotalBytes`), and CRC-32 verification.
Map<String, Uint8List> decodePocket7z(
  Uint8List archive, {
  int maxTotalBytes = 768 * 1024 * 1024,
}) {
  if (archive.length < 32) {
    throw const PocketPackageException(
      '7z archive is truncated',
      code: 'bundle-format',
    );
  }
  for (var i = 0; i < _sevenZipMagic.length; i++) {
    if (archive[i] != _sevenZipMagic[i]) {
      throw const PocketPackageException(
        'invalid 7z signature magic',
        code: 'bundle-format',
      );
    }
  }
  if (archive[6] != 0) {
    throw PocketPackageException(
      'unsupported 7z major version ${archive[6]}',
      code: 'bundle-format',
    );
  }
  final view = ByteData.sublistView(archive);
  final startHeaderCrc = view.getUint32(8, Endian.little);
  if (pocketCrc32(Uint8List.sublistView(archive, 12, 32)) != startHeaderCrc) {
    throw const PocketPackageException(
      '7z StartHeader CRC-32 mismatch',
      code: 'bundle-format',
    );
  }
  final nextHeaderOffset = view.getUint64(12, Endian.little);
  final nextHeaderSize = view.getUint64(20, Endian.little);
  final nextHeaderCrc = view.getUint32(28, Endian.little);
  if (nextHeaderOffset < 0 ||
      nextHeaderSize < 0 ||
      nextHeaderOffset > archive.length - 32 ||
      nextHeaderSize > archive.length - 32 - nextHeaderOffset) {
    throw const PocketPackageException(
      '7z NextHeader range out of bounds',
      code: 'bundle-format',
    );
  }
  final nextHeaderStart = 32 + nextHeaderOffset;
  var headerSlice = Uint8List.sublistView(
    archive,
    nextHeaderStart,
    nextHeaderStart + nextHeaderSize,
  );
  if (pocketCrc32(headerSlice) != nextHeaderCrc) {
    throw const PocketPackageException(
      '7z NextHeader CRC-32 mismatch',
      code: 'bundle-format',
    );
  }

  var hr = _SevenZipHeaderReader(headerSlice);
  var headerId = hr.readByte();
  if (headerId == 0x17) {
    final encInfo = _parse7zStreamsInfo(hr);
    if (encInfo.folders.length != 1 || encInfo.packSizes.isEmpty) {
      throw const PocketPackageException(
        'unsupported 7z multi-folder EncodedHeader',
        code: 'bundle-format',
      );
    }
    headerSlice = _decode7zFolder(
      archive,
      encInfo,
      0,
      0,
      encInfo.packSizes.first,
      math.min(maxTotalBytes, 16 * 1024 * 1024),
    );
    hr = _SevenZipHeaderReader(headerSlice);
    headerId = hr.readByte();
  }
  if (headerId != 0x01) {
    throw const PocketPackageException(
      'missing 7z kHeader marker',
      code: 'bundle-format',
    );
  }

  var sectionId = hr.readByte();
  if (sectionId == 0x02) {
    var propId = hr.readByte();
    while (propId != 0x00) {
      hr.readBytes(hr.readU64());
      propId = hr.readByte();
    }
    sectionId = hr.readByte();
  }
  if (sectionId == 0x03) {
    throw const PocketPackageException(
      '7z AdditionalStreamsInfo is not supported',
      code: 'bundle-format',
    );
  }

  _SevenZipStreamsInfo? mainStreams;
  if (sectionId == 0x04) {
    mainStreams = _parse7zStreamsInfo(hr);
    sectionId = hr.readByte();
  }

  final extracted = <String, Uint8List>{};
  if (sectionId == 0x00) {
    return extracted;
  }
  if (sectionId != 0x05) {
    throw const PocketPackageException(
      'missing 7z kFilesInfo marker',
      code: 'bundle-format',
    );
  }

  final numFiles = hr.readU64();
  if (numFiles > 0xffff) {
    throw const PocketPackageException(
      '7z file count exceeds 65535 limit',
      code: 'bundle-format',
    );
  }
  var emptyStreams = List<bool>.filled(numFiles, false);
  List<bool>? emptyFiles;
  List<bool>? antiFiles;
  final names = List<String>.filled(numFiles, '');
  var fileCrcs = List<int?>.filled(numFiles, null);

  var propType = hr.readByte();
  while (propType != 0x00) {
    final propSize = hr.readU64();
    final endPos = hr.pos + propSize;
    if (endPos > hr.buf.length) {
      throw const PocketPackageException(
        '7z FilesInfo property exceeds header',
        code: 'bundle-format',
      );
    }
    if (propType == 0x0e) {
      emptyStreams = hr.readBitVector(numFiles);
    } else if (propType == 0x0f) {
      final emptyCount = emptyStreams.where((flag) => flag).length;
      emptyFiles = hr.readBitVector(emptyCount);
    } else if (propType == 0x10) {
      final emptyCount = emptyStreams.where((flag) => flag).length;
      antiFiles = hr.readBitVector(emptyCount);
    } else if (propType == 0x11) {
      if (hr.readByte() != 0) {
        throw const PocketPackageException(
          'external 7z file names are not supported',
          code: 'bundle-format',
        );
      }
      for (var i = 0; i < numFiles; i++) {
        final codeUnits = <int>[];
        while (hr.pos + 2 <= endPos) {
          final unit = hr.buf[hr.pos] | (hr.buf[hr.pos + 1] << 8);
          hr.pos += 2;
          if (unit == 0) break;
          codeUnits.add(unit);
        }
        names[i] = String.fromCharCodes(codeUnits);
      }
    } else if (propType == 0x0a) {
      fileCrcs = hr.readDigests(numFiles);
    }
    hr.pos = endPos;
    propType = hr.readByte();
  }

  var totalUncompressed = 0;
  final unpackedSubStreams = <({Uint8List data, int? crc})>[];
  if (mainStreams != null) {
    var packOffset = 0;
    for (var f = 0; f < mainStreams.folders.length; f++) {
      final packSize = f < mainStreams.packSizes.length
          ? mainStreams.packSizes[f]
          : 0;
      final folderBytes = _decode7zFolder(
        archive,
        mainStreams,
        f,
        packOffset,
        packSize,
        maxTotalBytes - totalUncompressed,
      );
      totalUncompressed += folderBytes.length;
      packOffset += packSize;
      final sizes = mainStreams.subStreamSizes[f];
      final crcs = mainStreams.subStreamCrcs[f];
      var subCursor = 0;
      for (var s = 0; s < sizes.length; s++) {
        final size = sizes[s];
        if (subCursor + size > folderBytes.length) {
          throw const PocketPackageException(
            '7z substream exceeds decoded folder size',
            code: 'bundle-format',
          );
        }
        unpackedSubStreams.add((
          data: Uint8List.sublistView(folderBytes, subCursor, subCursor + size),
          crc: crcs[s],
        ));
        subCursor += size;
      }
    }
  }

  var emptyIdx = 0;
  var streamIdx = 0;
  for (var i = 0; i < numFiles; i++) {
    if (emptyStreams[i]) {
      final isAnti = antiFiles != null && emptyIdx < antiFiles.length
          ? antiFiles[emptyIdx]
          : false;
      final isEmptyFile = emptyFiles != null && emptyIdx < emptyFiles.length
          ? emptyFiles[emptyIdx]
          : false;
      emptyIdx++;
      if (isAnti) {
        throw const PocketPackageException(
          '7z anti-files are not supported',
          code: 'bundle-format',
        );
      }
      if (!isEmptyFile) {
        continue;
      }
      final name = names[i].replaceAll('\\', '/');
      _validateAssetName(name);
      if (extracted.containsKey(name)) {
        throw PocketPackageException(
          'duplicate 7z entry $name',
          code: 'bundle-format',
        );
      }
      extracted[name] = Uint8List(0);
    } else {
      if (streamIdx >= unpackedSubStreams.length) {
        throw const PocketPackageException(
          '7z archive missing substream for non-empty file',
          code: 'bundle-format',
        );
      }
      final name = names[i].replaceAll('\\', '/');
      _validateAssetName(name);
      if (extracted.containsKey(name)) {
        throw PocketPackageException(
          'duplicate 7z entry $name',
          code: 'bundle-format',
        );
      }
      final sub = unpackedSubStreams[streamIdx++];
      final expectedCrc = fileCrcs[i] ?? sub.crc;
      if (expectedCrc != null && pocketCrc32(sub.data) != expectedCrc) {
        throw PocketPackageException(
          '7z entry $name failed CRC-32 check',
          code: 'bundle-format',
        );
      }
      extracted[name] = Uint8List.fromList(sub.data);
    }
  }
  return extracted;
}

/// Validates and extracts a `.7z` or `.zip` bundle archive into memory.
Map<String, Uint8List> decodePocketBundle(
  Uint8List archive, {
  String? format,
  int maxTotalBytes = 768 * 1024 * 1024,
}) {
  final is7z =
      archive.length >= 6 &&
      archive[0] == 0x37 &&
      archive[1] == 0x7a &&
      archive[2] == 0xbc &&
      archive[3] == 0xaf &&
      archive[4] == 0x27 &&
      archive[5] == 0x1c;
  if (format == '7z' || (format == null && is7z)) {
    return decodePocket7z(archive, maxTotalBytes: maxTotalBytes);
  }
  if (format == 'zip' || format == null) {
    return decodePocketZip(archive, maxTotalBytes: maxTotalBytes);
  }
  throw PocketPackageException(
    'unsupported bundle format $format',
    code: 'manifest-bundle',
  );
}
