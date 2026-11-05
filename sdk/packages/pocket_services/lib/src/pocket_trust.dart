import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:path/path.dart' as path;

/// A host-side trust failure.  The package verifier maps this to the existing
/// [PocketPackageException] surface so callers do not need a second state
/// machine for trust decisions.
final class PocketTrustException implements Exception {
  const PocketTrustException(this.message, {this.code = 'trust-policy'});

  final String message;
  final String code;

  @override
  String toString() => 'PocketTrustException($code): $message';
}

/// A release public key certified by the host-owned root policy.
final class PocketReleaseKey {
  const PocketReleaseKey({
    required this.keyId,
    required List<int> publicKey,
    required List<String> appScope,
    required this.notBefore,
    required this.notAfter,
  }) : publicKey = publicKey,
       appScope = appScope;

  factory PocketReleaseKey.fromJson(Object? value) {
    final json = _object(value, 'release key');
    final rawScope = json['appScope'] ?? json['apps'] ?? json['scope'];
    final scope = switch (rawScope) {
      String value => <String>[value],
      List value =>
        value
            .map((item) => _string(item, 'release key appScope'))
            .toList(growable: false),
      _ => throw const PocketTrustException(
        'release key appScope must be a string or list',
        code: 'trust-policy-format',
      ),
    };
    final keyText = json['publicKeyBase64'] ?? json['publicKey'];
    final keyString = _string(keyText, 'release key public key');
    late final List<int> key;
    try {
      key = base64.decode(keyString);
    } on FormatException {
      throw const PocketTrustException(
        'release key public key is not base64',
        code: 'trust-policy-key',
      );
    }
    return PocketReleaseKey(
      keyId: _token(json['keyId'], 'release key id'),
      publicKey: key,
      appScope: scope,
      notBefore: _uint(json['notBefore'], 'release key notBefore'),
      notAfter: _uint(json['notAfter'], 'release key notAfter'),
    );
  }

  final String keyId;
  final List<int> publicKey;
  final List<String> appScope;
  final int notBefore;
  final int notAfter;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'keyId': keyId,
    'publicKeyBase64': base64Encode(publicKey),
    'appScope': List<String>.unmodifiable(appScope),
    'notBefore': notBefore,
    'notAfter': notAfter,
  };

  void validateStructure() {
    if (publicKey.length != 32) {
      throw const PocketTrustException(
        'release key must contain a raw Ed25519 public key',
        code: 'trust-policy-key',
      );
    }
    if (appScope.isEmpty ||
        appScope.any((item) => item.trim() != item || item.isEmpty)) {
      throw const PocketTrustException(
        'release key appScope must not be empty',
        code: 'trust-policy-scope',
      );
    }
    if (notAfter < notBefore) {
      throw const PocketTrustException(
        'release key validity interval is inverted',
        code: 'trust-policy-time',
      );
    }
  }

  void validate({required String appId, required int nowSeconds}) {
    validateStructure();
    if (!_scopeMatches(appScope, appId)) {
      throw PocketTrustException(
        'release key $keyId is not certified for app $appId',
        code: 'trust-policy-scope',
      );
    }
    if (nowSeconds < notBefore || nowSeconds > notAfter) {
      throw PocketTrustException(
        'release key $keyId is outside its validity interval',
        code: 'trust-policy-expired',
      );
    }
  }
}

/// Versioned trust policy signed by a host-owned root key.
///
/// The policy is intentionally a small signed JSON document rather than an
/// X.509 implementation.  The signature covers [payloadBytes] exactly as
/// received; re-encoding the parsed map is never used for verification.
final class PocketTrustPolicy {
  const PocketTrustPolicy({
    this.schemaVersion = 1,
    required this.epoch,
    required this.releaseKeys,
    this.revokedKeys = const <String>{},
    this.revokedPackages = const <String>{},
    this.appId,
    this.issuedAt,
    this.notBefore,
    this.notAfter,
  });

  factory PocketTrustPolicy.fromJson(Object? value) {
    final json = _object(value, 'trust policy payload');
    final rawKeys = json['releaseKeys'] ?? json['keys'];
    if (rawKeys is! List) {
      throw const PocketTrustException(
        'trust policy releaseKeys must be a list',
        code: 'trust-policy-format',
      );
    }
    final keys = <PocketReleaseKey>[];
    final ids = <String>{};
    for (final item in rawKeys) {
      final key = PocketReleaseKey.fromJson(item);
      if (!ids.add(key.keyId)) {
        throw PocketTrustException(
          'duplicate release key id ${key.keyId}',
          code: 'trust-policy-key',
        );
      }
      keys.add(key);
    }
    Set<String> readSet(Object? value, String field, {bool lower = false}) {
      if (value == null) return const <String>{};
      if (value is! List) {
        throw PocketTrustException(
          'trust policy $field must be a list',
          code: 'trust-policy-format',
        );
      }
      final values = <String>{};
      for (final item in value) {
        final text = _token(item, field);
        values.add(lower ? text.toLowerCase() : text);
      }
      return Set<String>.unmodifiable(values);
    }

    final rawApp = json['appId'] ?? json['appScope'];
    final appId = rawApp == null ? null : _string(rawApp, 'trust policy appId');
    return PocketTrustPolicy(
      schemaVersion: _uint(json['schemaVersion'], 'trust policy schemaVersion'),
      epoch: _uint(json['epoch'] ?? json['policyEpoch'], 'trust policy epoch'),
      releaseKeys: List<PocketReleaseKey>.unmodifiable(keys),
      revokedKeys: readSet(
        json['revokedKeys'] ?? json['revokedKeyIds'],
        'revokedKeys',
      ),
      revokedPackages: readSet(
        json['revokedPackages'] ?? json['revokedPackageIds'],
        'revokedPackages',
        lower: true,
      ),
      appId: appId,
      issuedAt: json['issuedAt'] == null
          ? null
          : _uint(json['issuedAt'], 'trust policy issuedAt'),
      notBefore: json['notBefore'] == null
          ? null
          : _uint(json['notBefore'], 'trust policy notBefore'),
      notAfter: json['notAfter'] == null
          ? null
          : _uint(json['notAfter'], 'trust policy notAfter'),
    );
  }

  final int schemaVersion;
  final int epoch;
  final List<PocketReleaseKey> releaseKeys;
  final Set<String> revokedKeys;
  final Set<String> revokedPackages;
  final String? appId;
  final int? issuedAt;
  final int? notBefore;
  final int? notAfter;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'schemaVersion': schemaVersion,
    'epoch': epoch,
    if (issuedAt != null) 'issuedAt': issuedAt,
    if (appId != null) 'appId': appId,
    if (notBefore != null) 'notBefore': notBefore,
    if (notAfter != null) 'notAfter': notAfter,
    'releaseKeys': releaseKeys
        .map((key) => key.toJson())
        .toList(growable: false),
    if (revokedKeys.isNotEmpty) 'revokedKeys': (revokedKeys.toList()..sort()),
    if (revokedPackages.isNotEmpty)
      'revokedPackages': (revokedPackages.toList()..sort()),
  };

  void validate({required String expectedAppId, required int nowSeconds}) {
    if (schemaVersion != 1) {
      throw PocketTrustException(
        'unsupported trust policy schemaVersion $schemaVersion',
        code: 'trust-policy-schema',
      );
    }
    if (epoch < 0) {
      throw const PocketTrustException(
        'trust policy epoch must not be negative',
        code: 'trust-policy-epoch',
      );
    }
    if (appId != null && appId != expectedAppId) {
      throw PocketTrustException(
        'trust policy appId $appId does not match $expectedAppId',
        code: 'trust-policy-scope',
      );
    }
    if (notBefore != null && notAfter != null && notAfter! < notBefore!) {
      throw const PocketTrustException(
        'trust policy validity interval is inverted',
        code: 'trust-policy-time',
      );
    }
    if (notBefore != null && nowSeconds < notBefore!) {
      throw const PocketTrustException(
        'trust policy is not valid yet',
        code: 'trust-policy-expired',
      );
    }
    if (notAfter != null && nowSeconds > notAfter!) {
      throw const PocketTrustException(
        'trust policy has expired',
        code: 'trust-policy-expired',
      );
    }
    for (final key in releaseKeys) {
      key.validateStructure();
    }
  }
}

/// Root-signed policy envelope.  Its [payloadBytes] are the exact bytes that
/// the root signed, including JSON whitespace and key order.
final class PocketSignedTrustPolicy {
  const PocketSignedTrustPolicy({
    required this.rootKeyId,
    required this.payloadBytes,
    required this.signatureBytes,
    required this.policy,
    required this.envelopeBytes,
  });

  factory PocketSignedTrustPolicy.fromBytes(Uint8List bytes) {
    late final Map<String, dynamic> envelope;
    try {
      envelope = _object(
        jsonDecode(utf8.decode(bytes)),
        'signed trust policy envelope',
      );
    } on FormatException catch (error) {
      throw PocketTrustException(
        'invalid trust policy envelope: $error',
        code: 'trust-policy-encoding',
      );
    }
    final rootKeyId = _token(
      envelope['keyId'] ?? envelope['rootKeyId'],
      'trust policy root key id',
    );
    final payloadText = _string(envelope['payload'], 'trust policy payload');
    final signatureText = _string(
      envelope['signature'],
      'trust policy signature',
    );
    try {
      final payloadBytes = Uint8List.fromList(base64.decode(payloadText));
      final signatureBytes = Uint8List.fromList(base64.decode(signatureText));
      return PocketSignedTrustPolicy(
        rootKeyId: rootKeyId,
        payloadBytes: payloadBytes,
        signatureBytes: signatureBytes,
        policy: PocketTrustPolicy.fromJson(
          jsonDecode(utf8.decode(payloadBytes)),
        ),
        envelopeBytes: Uint8List.fromList(bytes),
      );
    } on FormatException catch (error) {
      throw PocketTrustException(
        'invalid trust policy encoding: $error',
        code: 'trust-policy-encoding',
      );
    }
  }

  final String rootKeyId;
  final Uint8List payloadBytes;
  final Uint8List signatureBytes;
  final PocketTrustPolicy policy;
  final Uint8List envelopeBytes;

  Future<void> verifyRoot({
    required String rootKeyId,
    required List<int> rootPublicKey,
  }) async {
    if (this.rootKeyId != rootKeyId ||
        rootPublicKey.length != 32 ||
        signatureBytes.length != 64) {
      throw const PocketTrustException(
        'trust policy root key is unknown or malformed',
        code: 'trust-policy-root',
      );
    }
    final valid = await Ed25519().verify(
      payloadBytes,
      signature: Signature(
        signatureBytes,
        publicKey: SimplePublicKey(rootPublicKey, type: KeyPairType.ed25519),
      ),
    );
    if (!valid) {
      throw const PocketTrustException(
        'trust policy root signature is invalid',
        code: 'trust-policy-root',
      );
    }
  }

  String get payloadHash => crypto.sha256.convert(payloadBytes).toString();
}

/// Persistent, app-scoped release trust state.
///
/// The state stores the latest root-signed policy, its epoch/hash, and the
/// union of all revocations observed so far.  Installing a policy never
/// changes the package build floor; that remains owned by the existing
/// healthy-first package activation path.
final class PocketTrustStore {
  static final Map<String, Future<void>> _stateLocks = <String, Future<void>>{};

  PocketTrustStore({
    required this.directory,
    required this.appId,
    required this.rootKeyId,
    required List<int> rootPublicKey,
    DateTime Function()? clock,
  }) : rootPublicKey = List<int>.unmodifiable(rootPublicKey),
       _clock = clock ?? DateTime.now {
    if (rootKeyId.trim().isEmpty || rootPublicKey.length != 32) {
      throw const FormatException('A raw Ed25519 host trust root is required');
    }
    if (appId.trim().isEmpty) {
      throw const FormatException('Trust store appId must not be empty');
    }
  }

  final Directory directory;
  final String appId;
  final String rootKeyId;
  final List<int> rootPublicKey;
  final DateTime Function() _clock;

  Directory get stateDirectory =>
      Directory(path.join(directory.path, 'apps', _safePart(appId)));

  File get stateFile =>
      File(path.join(stateDirectory.path, 'trust-policy.json'));

  int get nowSeconds => _clock().toUtc().millisecondsSinceEpoch ~/ 1000;

  /// Internal admission boundary shared with policy installation. Callers must
  /// take any package-store lock first and must not install a policy or acquire
  /// another package lock from [action]. Verification itself does not re-lock.
  Future<T> withPolicyAdmission<T>(Future<T> Function() action) =>
      _withStateLock(action);

  Future<void> installBytes(Uint8List bytes) async {
    await install(PocketSignedTrustPolicy.fromBytes(bytes));
  }

  Future<void> install(PocketSignedTrustPolicy signed) async {
    await _withStateLock(() async {
      await signed.verifyRoot(
        rootKeyId: rootKeyId,
        rootPublicKey: rootPublicKey,
      );
      signed.policy.validate(expectedAppId: appId, nowSeconds: nowSeconds);
      final old = await _readState();
      if (old != null) {
        if (signed.policy.epoch < old.epoch) {
          throw PocketTrustException(
            'trust policy epoch ${signed.policy.epoch} is older than persisted ${old.epoch}',
            code: 'trust-policy-rollback',
          );
        }
        if (signed.policy.epoch == old.epoch &&
            signed.payloadHash != old.payloadHash) {
          throw const PocketTrustException(
            'different trust policy payloads share the same epoch',
            code: 'trust-policy-conflict',
          );
        }
      }
      final revokedKeys = <String>{
        ...?old?.revokedKeys,
        ...signed.policy.revokedKeys,
      };
      final revokedPackages = <String>{
        ...?old?.revokedPackages,
        ...signed.policy.revokedPackages,
      };
      await _writeState(
        _TrustState(
          epoch: signed.policy.epoch,
          payloadHash: signed.payloadHash,
          envelopeBytes: signed.envelopeBytes,
          revokedKeys: revokedKeys,
          revokedPackages: revokedPackages,
        ),
      );
    });
  }

  /// Loads and validates the persisted policy.  New-mode callers use this on
  /// restart before reading cached packages, so revoked packages cannot return
  /// through `active`, fallback, or rollback pointers.
  Future<PocketTrustPolicy> current() async {
    final state = await _readState();
    if (state == null) {
      throw const PocketTrustException(
        'no persisted trust policy is available',
        code: 'trust-policy-missing',
      );
    }
    final signed = PocketSignedTrustPolicy.fromBytes(state.envelopeBytes);
    await signed.verifyRoot(rootKeyId: rootKeyId, rootPublicKey: rootPublicKey);
    if (signed.policy.epoch != state.epoch ||
        signed.payloadHash != state.payloadHash) {
      throw const PocketTrustException(
        'persisted trust policy state is inconsistent',
        code: 'trust-policy-state',
      );
    }
    signed.policy.validate(expectedAppId: appId, nowSeconds: nowSeconds);
    return signed.policy;
  }

  /// Returns the certified public key for a package, after applying all
  /// policy, scope, validity and persistent revocation checks.
  Future<List<int>> publicKeyForPackage({
    required String keyId,
    required String packageAppId,
    required int? signedAt,
    required String contentHash,
    required Uint8List payloadBytes,
  }) async {
    final state = await _readState();
    if (state == null) {
      throw const PocketTrustException(
        'no persisted trust policy is available',
        code: 'trust-policy-missing',
      );
    }
    final signed = PocketSignedTrustPolicy.fromBytes(state.envelopeBytes);
    await signed.verifyRoot(rootKeyId: rootKeyId, rootPublicKey: rootPublicKey);
    if (signed.policy.epoch != state.epoch ||
        signed.payloadHash != state.payloadHash) {
      throw const PocketTrustException(
        'persisted trust policy state is inconsistent',
        code: 'trust-policy-state',
      );
    }
    signed.policy.validate(expectedAppId: appId, nowSeconds: nowSeconds);
    if (packageAppId != appId) {
      throw const PocketTrustException(
        'package app scope does not match trust store',
        code: 'trust-policy-scope',
      );
    }
    if (state.revokedKeys.contains(keyId)) {
      throw PocketTrustException(
        'release key $keyId is revoked',
        code: 'trust-revoked-key',
      );
    }
    final payloadHash = crypto.sha256.convert(payloadBytes).toString();
    final identities = <String>{contentHash.toLowerCase(), payloadHash};
    if (identities.any(state.revokedPackages.contains)) {
      throw const PocketTrustException(
        'package is revoked',
        code: 'trust-revoked-package',
      );
    }
    if (signedAt == null) {
      throw const PocketTrustException(
        'new trust policy mode requires a signedAt timestamp in the package payload',
        code: 'trust-signed-at',
      );
    }
    if ((signed.policy.notBefore != null &&
            signedAt < signed.policy.notBefore!) ||
        (signed.policy.notAfter != null &&
            signedAt > signed.policy.notAfter!)) {
      throw const PocketTrustException(
        'package signedAt is outside the trust policy validity interval',
        code: 'trust-certificate-expired',
      );
    }
    final release = signed.policy.releaseKeys.where(
      (key) => key.keyId == keyId,
    );
    if (release.length != 1) {
      throw PocketTrustException(
        'release key $keyId is not certified by the current policy',
        code: 'trust-key-unknown',
      );
    }
    final key = release.single;
    key.validateStructure();
    if (nowSeconds < key.notBefore || nowSeconds > key.notAfter) {
      throw PocketTrustException(
        'release key $keyId is not currently valid',
        code: 'trust-certificate-expired',
      );
    }
    if (signedAt > nowSeconds) {
      throw PocketTrustException(
        'package signedAt $signedAt is in the future',
        code: 'trust-signed-at',
      );
    }
    if (signedAt < key.notBefore || signedAt > key.notAfter) {
      throw PocketTrustException(
        'package signedAt $signedAt is outside release key $keyId validity',
        code: 'trust-certificate-expired',
      );
    }
    if (!_scopeMatches(key.appScope, packageAppId)) {
      throw PocketTrustException(
        'release key $keyId is not certified for app $packageAppId',
        code: 'trust-certificate-scope',
      );
    }
    return key.publicKey;
  }

  Future<_TrustState?> _readState() async {
    if (!await stateFile.exists()) return null;
    try {
      final json = _object(
        jsonDecode(await stateFile.readAsString()),
        'trust state',
      );
      if (_uint(json['schemaVersion'], 'trust state schemaVersion') != 1) {
        throw const PocketTrustException(
          'unsupported persisted trust state schema',
          code: 'trust-policy-state',
        );
      }
      final envelopeText = _string(json['envelope'], 'trust state envelope');
      final envelopeBytes = Uint8List.fromList(base64.decode(envelopeText));
      final signed = PocketSignedTrustPolicy.fromBytes(envelopeBytes);
      await signed.verifyRoot(
        rootKeyId: rootKeyId,
        rootPublicKey: rootPublicKey,
      );
      final epoch = _uint(json['epoch'], 'trust state epoch');
      final hash = _string(json['payloadHash'], 'trust state payloadHash');
      if (epoch != signed.policy.epoch || hash != signed.payloadHash) {
        throw const PocketTrustException(
          'persisted trust policy state is inconsistent',
          code: 'trust-policy-state',
        );
      }
      Set<String> readSet(Object? value, String field) {
        if (value is! List) {
          throw PocketTrustException(
            'trust state $field must be a list',
            code: 'trust-policy-state',
          );
        }
        return value.map((item) => _token(item, field)).toSet();
      }

      return _TrustState(
        epoch: epoch,
        payloadHash: hash,
        envelopeBytes: envelopeBytes,
        revokedKeys: readSet(json['revokedKeys'], 'revokedKeys'),
        revokedPackages: readSet(
          json['revokedPackages'],
          'revokedPackages',
        ).map((item) => item.toLowerCase()).toSet(),
      );
    } on PocketTrustException {
      rethrow;
    } on Object catch (error) {
      throw PocketTrustException(
        'unable to read trust state: $error',
        code: 'trust-policy-state',
      );
    }
  }

  Future<void> _writeState(_TrustState state) async {
    await stateDirectory.create(recursive: true);
    final json = <String, dynamic>{
      'schemaVersion': 1,
      'epoch': state.epoch,
      'payloadHash': state.payloadHash,
      'envelope': base64Encode(state.envelopeBytes),
      'revokedKeys': state.revokedKeys.toList()..sort(),
      'revokedPackages': state.revokedPackages.toList()..sort(),
    };
    final temporary = File(
      '${stateFile.path}.tmp-${DateTime.now().microsecondsSinceEpoch}',
    );
    await temporary.writeAsString(jsonEncode(json), flush: true);
    try {
      await temporary.rename(stateFile.path);
    } catch (_) {
      if (await stateFile.exists()) await stateFile.delete();
      await temporary.rename(stateFile.path);
    }
  }

  Future<T> _withStateLock<T>(Future<T> Function() action) {
    final lockKey = path.normalize(stateFile.absolute.path);
    final previous = _stateLocks[lockKey] ?? Future<void>.value();
    final release = Completer<void>();
    _stateLocks[lockKey] = release.future;
    final operation = previous.then<T>((_) => Future<T>.sync(action));
    return operation.whenComplete(() {
      if (!release.isCompleted) release.complete();
      if (identical(_stateLocks[lockKey], release.future)) {
        _stateLocks.remove(lockKey);
      }
    });
  }
}

final class _TrustState {
  const _TrustState({
    required this.epoch,
    required this.payloadHash,
    required this.envelopeBytes,
    required this.revokedKeys,
    required this.revokedPackages,
  });

  final int epoch;
  final String payloadHash;
  final Uint8List envelopeBytes;
  final Set<String> revokedKeys;
  final Set<String> revokedPackages;
}

bool _scopeMatches(Iterable<String> scopes, String appId) {
  for (final scope in scopes) {
    if (scope == '*' || scope == appId) return true;
    if (scope.endsWith('.*') &&
        appId.startsWith(scope.substring(0, scope.length - 2)) &&
        appId.length > scope.length - 2 &&
        appId[scope.length - 2] == '.') {
      return true;
    }
  }
  return false;
}

Map<String, dynamic> _object(Object? value, String field) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map)
    return value.map((key, value) => MapEntry(key.toString(), value));
  throw PocketTrustException(
    '$field must be an object',
    code: 'trust-policy-format',
  );
}

String _string(Object? value, String field) {
  if (value is String && value.isNotEmpty) return value;
  throw PocketTrustException(
    '$field must be a non-empty string',
    code: 'trust-policy-format',
  );
}

String _token(Object? value, String field) {
  final text = _string(value, field);
  if (text.trim() != text ||
      text.contains('/') ||
      text.contains('\\') ||
      text.contains('\u0000')) {
    throw PocketTrustException(
      '$field contains an unsafe token',
      code: 'trust-policy-format',
    );
  }
  return text;
}

int _uint(Object? value, String field) {
  if (value is int && value >= 0) return value;
  if (value is num &&
      value.isFinite &&
      value >= 0 &&
      value == value.truncateToDouble()) {
    return value.toInt();
  }
  throw PocketTrustException(
    '$field must be a non-negative integer',
    code: 'trust-policy-format',
  );
}

String _safePart(String value) {
  final normalized = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
  return normalized.isEmpty ? 'app' : normalized;
}
