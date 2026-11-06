import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:pocket_flutter/src/pocket_package.dart'
    show PocketPackageSource;

import 'pocket_package.dart';
import 'pocket_trust.dart';

final class PocketDownloadResponse {
  const PocketDownloadResponse({required this.bytes, this.contentLength});

  final Stream<List<int>> bytes;
  final int? contentLength;
}

abstract interface class PocketUpdateTransport {
  Future<PocketDownloadResponse> open(
    Uri uri, {
    required PocketCancellationToken cancellation,
  });
  void close() {}
}

final class HttpPocketUpdateTransport implements PocketUpdateTransport {
  HttpPocketUpdateTransport({
    http.Client? client,
    this.requestTimeout = const Duration(seconds: 20),
    this.bodyTimeout = const Duration(seconds: 20),
  }) : _client = client ?? http.Client();

  http.Client _client;
  final Duration requestTimeout;
  final Duration bodyTimeout;
  bool _closed = false;

  @override
  Future<PocketDownloadResponse> open(
    Uri uri, {
    required PocketCancellationToken cancellation,
  }) async {
    if (_closed) throw StateError('update transport is closed');
    cancellation.throwIfCancelled();
    late final http.StreamedResponse response;
    try {
      response = await _guard(
        _client.send(http.Request('GET', uri)),
        cancellation,
        requestTimeout,
        'HTTP request timeout',
      );
    } catch (_) {
      _resetClient();
      rethrow;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      _resetClient();
      throw PocketPackageException(
        'HTTP ${response.statusCode} for $uri',
        code: 'http',
      );
    }
    return PocketDownloadResponse(
      bytes: _body(response.stream, uri, cancellation),
      contentLength: response.contentLength,
    );
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _client.close();
  }

  void _resetClient() {
    _client.close();
    if (!_closed) _client = http.Client();
  }

  Stream<List<int>> _body(
    Stream<List<int>> source,
    Uri uri,
    PocketCancellationToken cancellation,
  ) async* {
    final iterator = StreamIterator<List<int>>(source);
    try {
      while (await _guard(
        iterator.moveNext(),
        cancellation,
        bodyTimeout,
        'HTTP body timeout for $uri',
      )) {
        yield iterator.current;
      }
    } finally {
      await iterator.cancel();
    }
  }

  Future<T> _guard<T>(
    Future<T> operation,
    PocketCancellationToken cancellation,
    Duration timeout,
    String message,
  ) {
    return Future.any(<Future<T>>[
      operation,
      cancellation.whenCancelled.then<T>(
        (_) => throw const PocketUpdateCancellation(),
      ),
    ]).timeout(
      timeout,
      onTimeout: () =>
          throw PocketPackageException(message, code: 'http-timeout'),
    );
  }
}

enum PocketUpdateStage {
  checking,
  downloading,
  verifying,
  loading,
  ready,
  error,
  retry,
}

final class PocketUpdateProgress {
  const PocketUpdateProgress({
    required this.stage,
    this.downloadedBytes = 0,
    this.totalBytes = 0,
    this.fileSha256,
    this.attempt = 0,
    this.message,
  });

  final PocketUpdateStage stage;
  final int downloadedBytes;
  final int totalBytes;
  final String? fileSha256;
  final int attempt;
  final String? message;
  double? get fraction => totalBytes <= 0
      ? null
      : (downloadedBytes / totalBytes).clamp(0.0, 1.0).toDouble();
}

typedef PocketUpdateProgressCallback =
    void Function(PocketUpdateProgress progress);

enum PocketUpdateMode {
  auto,
  zip,
  granular,
}

enum PocketUpdateScope {
  all,
  code,
  resource,
}

final class PocketUpdateTarget {
  const PocketUpdateTarget._({
    required this.scope,
    this.resource,
  });

  const PocketUpdateTarget.all() : this._(scope: PocketUpdateScope.all);
  const PocketUpdateTarget.codeOnly() : this._(scope: PocketUpdateScope.code);

  factory PocketUpdateTarget.singleResource(String resource) {
    if (resource.trim().isEmpty) {
      throw const PocketPackageException(
        'resource target name must not be empty',
        code: 'update-resource-missing',
      );
    }
    return PocketUpdateTarget._(
      scope: PocketUpdateScope.resource,
      resource: resource,
    );
  }

  final PocketUpdateScope scope;
  final String? resource;
}

final class PocketPreparedPackage {
  const PocketPreparedPackage({
    required this.package,
    required this.needsActivation,
    this.isRollback = false,
    this.deliveryMode = PocketUpdateMode.granular,
    this.target = const PocketUpdateTarget.all(),
    this.downloadedFiles = 0,
    this.reusedFiles = 0,
    this.downloadedBytes = 0,
    this.reusedBytes = 0,
    this.updatedComponents = const <String>[],
  });

  final PocketPackage package;
  final bool needsActivation;
  final bool isRollback;
  final PocketUpdateMode deliveryMode;
  final PocketUpdateTarget target;
  final int downloadedFiles;
  final int reusedFiles;
  final int downloadedBytes;
  final int reusedBytes;
  final List<String> updatedComponents;

  /// Cached data descriptor, not an ongoing trust grant. Custom hosts must
  /// publish/run it inside [PocketUpdateCoordinator.withVerifiedPrepared]
  /// after asynchronous setup, as PocketSession does.
  PocketPackageSource get source => package.source;
  String get version => package.manifest.payload.version;
  int get build => package.manifest.payload.build;
  /// Reads cached bytes without performing runtime admission. Use the
  /// coordinator's final admission boundary before executing those bytes.
  Future<PocketPackageArtifact> readArtifact() => package.readArtifact();

  Map<String, dynamic> toSummaryJson() => <String, dynamic>{
    'version': version,
    'build': build,
    'deliveryMode': deliveryMode.name,
    'scope': target.scope.name,
    if (target.resource != null) 'targetResource': target.resource,
    'downloadedFiles': downloadedFiles,
    'reusedFiles': reusedFiles,
    'downloadedBytes': downloadedBytes,
    'reusedBytes': reusedBytes,
    'updatedComponents': updatedComponents,
  };
}

/// Pure Dart update coordinator. Flutter host wiring decides when a prepared
/// renderer is healthy and calls [commitHealthy]; this package has no widget
/// or business UI dependency.
final class PocketUpdateCoordinator {
  PocketUpdateCoordinator({
    required this.manifestUri,
    required this.appId,
    required this.trustedKeys,
    required this.store,
    PocketUpdateTransport? transport,
    this.hostVersion = 1,
    this.expectedProtocol = 1,
    this.maxRetries = 2,
    this.retryDelay = const Duration(milliseconds: 250),
    this.maxManifestBytes = 1024 * 1024,
    this.maxFileBytes = 256 * 1024 * 1024,
    this.maxEntryBytes = 16 * 1024 * 1024,
    this.maxPakBytes = 256 * 1024 * 1024,
    this.maxTotalBytes = 768 * 1024 * 1024,
    this.expectedRuntimeAbi,
    this.requireBytecode = false,
    this.minimumBuild = 0,
    this.allowDowngrade = false,
    this.trustStore,
    this.trustPolicyUri,
    Iterable<String> debugHttpHosts = const <String>[],
  }) : transport = transport ?? HttpPocketUpdateTransport(),
       debugHttpHosts = Set<String>.unmodifiable(
         debugHttpHosts.map((host) => host.toLowerCase()),
       );

  final Uri manifestUri;
  final String appId;
  final Map<String, List<int>> trustedKeys;
  final PocketPackageStore store;
  final PocketUpdateTransport transport;
  final int hostVersion;
  final int expectedProtocol;
  final int maxRetries;
  final Duration retryDelay;
  final int maxManifestBytes;
  final int maxFileBytes;
  final int maxEntryBytes;
  final int maxPakBytes;
  final int maxTotalBytes;
  final String? expectedRuntimeAbi;
  final bool requireBytecode;
  final int minimumBuild;
  final bool allowDowngrade;

  /// Explicit root-policy mode.  When present, release keys come only from
  /// the persisted host-owned policy and the legacy [trustedKeys] map is not a
  /// bypass.
  final PocketTrustStore? trustStore;
  final Uri? trustPolicyUri;
  final Set<String> debugHttpHosts;

  PocketPackageStore get _store => store.scoped(appId);

  PocketManifestVerifier get verifier => PocketManifestVerifier(
    trustedKeys: trustedKeys,
    appId: appId,
    hostVersion: hostVersion,
    expectedProtocol: expectedProtocol,
    maxFileBytes: maxFileBytes,
    maxEntryBytes: maxEntryBytes,
    maxPakBytes: maxPakBytes,
    maxTotalBytes: maxTotalBytes,
    expectedRuntimeAbi: expectedRuntimeAbi,
    requireBytecode: requireBytecode,
    trustStore: trustStore,
  );

  void dispose() => transport.close();

  Future<PocketPreparedPackage> prepare({
    PocketCancellationToken? cancellation,
    PocketUpdateProgressCallback? onProgress,
    PocketUpdateMode mode = PocketUpdateMode.auto,
    PocketUpdateTarget target = const PocketUpdateTarget.all(),

    /// A package that the host has already mounted in memory but has not yet
    /// promoted to the store's healthy pointer. This is a trusted runtime
    /// fact, not a new store pointer: it participates in baseline reuse and
    /// downgrade/replay admission without changing disk promotion semantics.
    PocketPackage? mountedPackage,
  }) async {
    final token = cancellation ?? PocketCancellationToken();
    _validateManifestUri();
    _validateTrustPolicyUri();
    if (target.scope != PocketUpdateScope.all && mode == PocketUpdateMode.zip) {
      throw PocketPackageException(
        'granular target scope ${target.scope.name} cannot use zip mode',
        code: 'update-mode-conflict',
      );
    }
    _report(
      onProgress,
      const PocketUpdateProgress(stage: PocketUpdateStage.checking),
    );
    await _refreshTrustPolicy(token, onProgress);
    final signed = await _fetchManifest(token, onProgress);
    await verifier.verify(signed);
    final currentGood = await _store.lastGood(verifier: verifier);
    final currentActive = await _store.active(verifier: verifier);
    // A hidden prewarm can have a fully admitted package in memory while both
    // disk pointers are still empty. Diff against the package this session is
    // actually running; the disk pointers still contribute independently to
    // the anti-downgrade floor below. Never write this fact back to the store.
    final effectiveActive = mountedPackage ?? currentActive;
    final baselinePackage = effectiveActive ?? currentGood;
    if (target.scope != PocketUpdateScope.all && baselinePackage == null) {
      throw PocketPackageException(
        'granular ${target.scope.name} update requires an already-downloaded package baseline',
        code: 'update-baseline-missing',
      );
    }
    final floorBuild = math.max(
      minimumBuild,
      math.max(
        currentGood?.manifest.payload.build ?? 0,
        math.max(
          currentActive?.manifest.payload.build ?? 0,
          mountedPackage?.manifest.payload.build ?? 0,
        ),
      ),
    );
    final establishedIdsAtFloor = <String>{
      if (currentGood != null &&
          currentGood.manifest.payload.build == floorBuild)
        currentGood.versionId,
      if (currentActive != null &&
          currentActive.manifest.payload.build == floorBuild)
        currentActive.versionId,
      if (mountedPackage != null &&
          mountedPackage.manifest.payload.build == floorBuild)
        mountedPackage.versionId,
    };
    final hasBaseline = minimumBuild > 0 || baselinePackage != null;
    final manifestVersionId = pocketVersionId(signed.payload);
    if (!allowDowngrade && hasBaseline) {
      if (signed.payload.build < floorBuild ||
          (signed.payload.build == floorBuild &&
              (establishedIdsAtFloor.isEmpty ||
                  !establishedIdsAtFloor.every(
                    (id) => id == manifestVersionId,
                  )))) {
        throw PocketPackageFormatException(
          'Refusing downgrade or replay: package build ${signed.payload.build} is not newer than current build $floorBuild',
        );
      }
    }
    if (baselinePackage != null) {
      await _store.seedBlobsFromPackage(baselinePackage, cancellation: token);
    }
    final diff = _computeManifestDiff(
      baselinePackage?.manifest.payload,
      signed.payload,
    );
    _enforceTargetScope(
      target: target,
      baseline: baselinePackage?.manifest.payload,
      candidate: signed.payload,
      diff: diff,
    );
    if (effectiveActive != null &&
        effectiveActive.manifest.payload.contentHash ==
            signed.payload.contentHash) {
      _report(
        onProgress,
        const PocketUpdateProgress(stage: PocketUpdateStage.loading),
      );
      return PocketPreparedPackage(
        package: effectiveActive,
        needsActivation: false,
        deliveryMode: PocketUpdateMode.granular,
        target: target,
        downloadedFiles: 0,
        reusedFiles: signed.payload.files.length,
        downloadedBytes: 0,
        reusedBytes: signed.payload.files.fold<int>(
          0,
          (sum, file) => sum + file.size,
        ),
        updatedComponents: const <String>[],
      );
    }
    final files = signed.payload.files;
    final total = files.fold<int>(0, (sum, file) => sum + file.size);
    if (total > maxTotalBytes)
      throw const PocketPackageException(
        'manifest total exceeds limit',
        code: 'manifest-size',
      );
    final PocketUpdateMode resolvedMode;
    if (mode == PocketUpdateMode.zip) {
      if (signed.payload.bundle == null) {
        throw const PocketPackageException(
          'zip mode requested, but manifest does not declare a bundle',
          code: 'update-bundle-missing',
        );
      }
      resolvedMode = PocketUpdateMode.zip;
    } else if (mode == PocketUpdateMode.granular ||
        target.scope != PocketUpdateScope.all) {
      resolvedMode = PocketUpdateMode.granular;
    } else {
      resolvedMode =
          (baselinePackage == null && signed.payload.bundle != null)
              ? PocketUpdateMode.zip
              : PocketUpdateMode.granular;
    }

    final blobs = <String, File>{};
    var downloadedFiles = 0;
    var reusedFiles = 0;
    var downloadedBytes = 0;
    var reusedBytes = 0;

    if (resolvedMode == PocketUpdateMode.zip) {
      final bundle = signed.payload.bundle!;
      _report(
        onProgress,
        PocketUpdateProgress(
          stage: PocketUpdateStage.downloading,
          totalBytes: bundle.size,
          fileSha256: bundle.sha256,
        ),
      );
      final included = bundle.blobs?.toSet();
      blobs.addAll(
        await _downloadBundleZip(
          bundle: bundle,
          expectedFiles: included == null
              ? files
              : files.where((file) => included.contains(file.sha256)).toList(),
          token: token,
          callback: onProgress,
        ),
      );
      downloadedFiles = 1;
      reusedFiles = 0;
      downloadedBytes = bundle.size;
      reusedBytes = 0;
      _report(
        onProgress,
        PocketUpdateProgress(
          stage: PocketUpdateStage.downloading,
          downloadedBytes: bundle.size,
          totalBytes: bundle.size,
          fileSha256: bundle.sha256,
        ),
      );
    }
    // A partial base archive is an explicitly signed subset, never an excuse
    // to accept an incomplete archive. Fetch its remaining declared blobs via
    // the same cache/downloader as granular updates, then stage the full PAK.
    if (resolvedMode != PocketUpdateMode.zip ||
        signed.payload.bundle!.blobs != null) {
      final missingFiles = <PocketManifestFile>[];
      for (final file in files) {
        token.throwIfCancelled();
        if (blobs.containsKey(file.sha256)) continue;
        final cached = await _store.validBlob(file, cancellation: token);
        if (cached != null) {
          blobs[file.sha256] = cached;
          reusedFiles += 1;
          reusedBytes += file.size;
        } else {
          missingFiles.add(file);
        }
      }
      final totalToDownload = missingFiles.fold<int>(
        downloadedBytes,
        (sum, file) => sum + file.size,
      );
      _report(
        onProgress,
        PocketUpdateProgress(
          stage: PocketUpdateStage.downloading,
          downloadedBytes: downloadedBytes,
          totalBytes: totalToDownload,
        ),
      );
      for (final file in missingFiles) {
        token.throwIfCancelled();
        final blob = await _download(
          file,
          token,
          onProgress,
          downloadedBytes,
          totalToDownload,
        );
        blobs[file.sha256] = blob;
        downloadedFiles += 1;
        downloadedBytes += file.size;
        _report(
          onProgress,
          PocketUpdateProgress(
            stage: PocketUpdateStage.downloading,
            downloadedBytes: downloadedBytes,
            totalBytes: totalToDownload,
            fileSha256: file.sha256,
          ),
        );
      }
    }
    token.throwIfCancelled();
    _report(
      onProgress,
      const PocketUpdateProgress(stage: PocketUpdateStage.verifying),
    );
    final entryBlob = blobs[signed.payload.entry.sha256];
    if (entryBlob == null)
      throw const PocketPackageException(
        'entry blob missing',
        code: 'entry-file',
      );
    final package = await _store.stage(
      signed: signed,
      verifier: verifier,
      entryBlob: entryBlob,
      blobs: blobs,
      cancellation: token,
    );
    return PocketPreparedPackage(
      package: package,
      needsActivation: true,
      deliveryMode: resolvedMode,
      target: target,
      downloadedFiles: downloadedFiles,
      reusedFiles: reusedFiles,
      downloadedBytes: downloadedBytes,
      reusedBytes: reusedBytes,
      updatedComponents: List<String>.unmodifiable(diff.updatedComponents),
    );
  }

  /// Reads a healthy package. The active-pointer fallback remains available
  /// for legacy embedded clients; remote-only cold opens disable it because
  /// a staged/externally activated package may never have passed health.
  Future<PocketPreparedPackage?> lastGood({
    PocketCancellationToken? cancellation,
    bool allowActiveFallback = true,
  }) async {
    cancellation?.throwIfCancelled();
    final healthy = await _store.lastGood(verifier: verifier);
    final package =
        healthy ??
        (allowActiveFallback ? await _store.active(verifier: verifier) : null);
    return package == null
        ? null
        : PocketPreparedPackage(package: package, needsActivation: false);
  }

  Future<void> commitHealthy(PocketPreparedPackage prepared) {
    if (prepared.isRollback) {
      return _store.rollback(
        versionId: prepared.package.versionId,
        verifier: verifier,
      );
    }
    return _store.commitHealthy(
      prepared.package,
      verifier: verifier,
      minimumBuild: minimumBuild,
      allowDowngrade: allowDowngrade,
    );
  }
  Future<void> activate(PocketPreparedPackage prepared) =>
      commitHealthy(prepared);

  /// Validates cached bytes and current trust immediately before a host
  /// publishes a candidate, without advancing the healthy package pointers.
  /// [use] must not start another package or trust-policy operation.
  Future<T> withVerifiedPrepared<T>(
    PocketPreparedPackage prepared,
    FutureOr<T> Function() use,
  ) => _store.withVerifiedPackage(
    prepared.package,
    verifier: verifier,
    use: use,
  );

  Future<PocketPreparedPackage?> fallbackFor(
    PocketPreparedPackage failed,
  ) async {
    final pkg = await _store.fallbackFor(
      failed.package.versionId,
      verifier: verifier,
    );
    return pkg == null
        ? null
        : PocketPreparedPackage(package: pkg, needsActivation: false);
  }

  Future<List<PocketVersionInfo>> listVersions() =>
      _store.listVersions(verifier: verifier);
  Future<void> rollback({String? versionId}) =>
      _store.rollback(versionId: versionId, verifier: verifier);

  /// Resets only activation state. Version history and content-addressed
  /// blobs remain available for diagnostics or a later explicit rollback.
  Future<void> resetToEmbedded() => _store.clearActivation();

  Future<PocketSignedManifest> _fetchManifest(
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
  ) async {
    final response = await _openWithRetry(manifestUri, token, callback);
    if (response.contentLength != null &&
        response.contentLength! > maxManifestBytes) {
      throw const PocketPackageException(
        'manifest exceeds size limit',
        code: 'manifest-size',
      );
    }
    final builder = BytesBuilder(copy: false);
    var length = 0;
    await for (final chunk in response.bytes) {
      token.throwIfCancelled();
      length += chunk.length;
      if (length > maxManifestBytes)
        throw const PocketPackageException(
          'manifest exceeds size limit',
          code: 'manifest-size',
        );
      builder.add(chunk);
    }
    return PocketSignedManifest.fromBytes(builder.takeBytes());
  }

  Future<void> _refreshTrustPolicy(
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
  ) async {
    final store = trustStore;
    if (store == null) return;
    final uri = trustPolicyUri;
    if (uri == null) {
      // This is the restart/offline path: a configured trust store is still
      // fail-closed when no signed policy has been persisted.
      try {
        await store.current();
      } on PocketTrustException catch (error) {
        throw PocketPackageException(error.message, code: error.code);
      }
      return;
    }
    final response = await _openWithRetry(
      uri,
      token,
      callback,
      resource: 'trust policy',
    );
    if (response.contentLength != null &&
        response.contentLength! > maxManifestBytes) {
      throw const PocketPackageException(
        'trust policy exceeds size limit',
        code: 'trust-policy-size',
      );
    }
    final builder = BytesBuilder(copy: false);
    var length = 0;
    await for (final chunk in response.bytes) {
      token.throwIfCancelled();
      length += chunk.length;
      if (length > maxManifestBytes) {
        throw const PocketPackageException(
          'trust policy exceeds size limit',
          code: 'trust-policy-size',
        );
      }
      builder.add(chunk);
    }
    try {
      await store.installBytes(builder.takeBytes());
    } on PocketTrustException catch (error) {
      throw PocketPackageException(error.message, code: error.code);
    }
  }

  static bool _isDeterministicValidationError(Object error) =>
      error is PocketPackageException &&
      const <String>{
        'bundle-format',
        'bundle-content',
        'manifest-size',
        'manifest-url',
        'manifest-assets',
        'download-hash',
        'download-size',
      }.contains(error.code);

  Future<File> _download(
    PocketManifestFile file,
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
    int completed,
    int totalToDownload,
  ) async {
    final declared = Uri.tryParse(file.url);
    if (declared == null ||
        declared.hasScheme ||
        declared.host.isNotEmpty ||
        declared.path.startsWith('/')) {
      throw const PocketPackageException(
        'manifest file URL must be relative',
        code: 'manifest-url',
      );
    }
    final uri = manifestUri.resolve(file.url);
    if (uri.scheme != manifestUri.scheme ||
        uri.host != manifestUri.host ||
        uri.port != manifestUri.port) {
      throw const PocketPackageException(
        'manifest file escaped manifest origin',
        code: 'manifest-url',
      );
    }
    Object? lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        final response = await transport.open(uri, cancellation: token);
        if (response.contentLength != null &&
            response.contentLength != file.size) {
          throw const PocketPackageException(
            'download size differs from manifest',
            code: 'download-size',
          );
        }
        return await _store.writeBlob(
          file: file,
          bytes: response.bytes,
          cancellation: token,
          maxBytes: maxFileBytes,
          onBytes: (received) => _report(
            callback,
            PocketUpdateProgress(
              stage: attempt == 0
                  ? PocketUpdateStage.downloading
                  : PocketUpdateStage.retry,
              downloadedBytes: completed + received,
              totalBytes: totalToDownload,
              fileSha256: file.sha256,
              attempt: attempt,
            ),
          ),
        );
      } on PocketUpdateCancellation {
        rethrow;
      } catch (error) {
        if (_isDeterministicValidationError(error)) {
          rethrow;
        }
        lastError = error;
        if (attempt >= maxRetries) break;
        _report(
          callback,
          PocketUpdateProgress(
            stage: PocketUpdateStage.retry,
            downloadedBytes: completed,
            totalBytes: totalToDownload,
            attempt: attempt + 1,
            fileSha256: file.sha256,
          ),
        );
        await Future.any(<Future<void>>[
          Future<void>.delayed(retryDelay),
          token.whenCancelled.then<void>(
            (_) => throw const PocketUpdateCancellation(),
          ),
        ]);
      }
    }
    if (lastError is PocketPackageException &&
        lastError.code != 'http' &&
        lastError.code != 'http-timeout') {
      throw lastError;
    }
    throw PocketPackageException(
      'failed to download ${file.sha256}: $lastError',
      code: 'download',
    );
  }

  Future<Map<String, File>> _downloadBundleZip({
    required PocketManifestBundle bundle,
    required List<PocketManifestFile> expectedFiles,
    required PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
  }) async {
    final declared = Uri.tryParse(bundle.url);
    if (declared == null ||
        declared.hasScheme ||
        declared.host.isNotEmpty ||
        declared.path.startsWith('/')) {
      throw const PocketPackageException(
        'manifest bundle URL must be relative',
        code: 'manifest-url',
      );
    }
    final uri = manifestUri.resolve(bundle.url);
    if (uri.scheme != manifestUri.scheme ||
        uri.host != manifestUri.host ||
        uri.port != manifestUri.port) {
      throw const PocketPackageException(
        'manifest bundle escaped manifest origin',
        code: 'manifest-url',
      );
    }
    Object? lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        final response = await transport.open(uri, cancellation: token);
        if (response.contentLength != null &&
            response.contentLength != bundle.size) {
          throw const PocketPackageException(
            'bundle download size differs from manifest',
            code: 'download-size',
          );
        }
        return await _store.writeBundleZip(
          bundle: bundle,
          expectedFiles: expectedFiles,
          bytes: response.bytes,
          cancellation: token,
          maxArchiveBytes: maxTotalBytes,
          maxTotalBytes: maxTotalBytes,
          onBytes: (received) => _report(
            callback,
            PocketUpdateProgress(
              stage: attempt == 0
                  ? PocketUpdateStage.downloading
                  : PocketUpdateStage.retry,
              downloadedBytes: received,
              totalBytes: bundle.size,
              fileSha256: bundle.sha256,
              attempt: attempt,
            ),
          ),
        );
      } on PocketUpdateCancellation {
        rethrow;
      } catch (error) {
        if (_isDeterministicValidationError(error)) {
          rethrow;
        }
        lastError = error;
        if (attempt >= maxRetries) break;
        _report(
          callback,
          PocketUpdateProgress(
            stage: PocketUpdateStage.retry,
            attempt: attempt + 1,
            fileSha256: bundle.sha256,
          ),
        );
        await Future.any(<Future<void>>[
          Future<void>.delayed(retryDelay),
          token.whenCancelled.then<void>(
            (_) => throw const PocketUpdateCancellation(),
          ),
        ]);
      }
    }
    if (lastError is PocketPackageException &&
        lastError.code != 'http' &&
        lastError.code != 'http-timeout') {
      throw lastError;
    }
    throw PocketPackageException(
      'failed to download bundle ${bundle.sha256}: $lastError',
      code: 'download',
    );
  }

  _ManifestComponentDiff _computeManifestDiff(
    PocketPackageManifest? baseline,
    PocketPackageManifest candidate,
  ) {
    final entryChanged =
        baseline == null ||
        baseline.entry.sha256 != candidate.entry.sha256 ||
        baseline.entry.size != candidate.entry.size ||
        baseline.entryFormat != candidate.entryFormat ||
        (baseline.runtimeAbi ?? '') != (candidate.runtimeAbi ?? '');
    final workerChanged =
        _canonicalWorker(baseline) != _canonicalWorker(candidate);
    final codeChanged = entryChanged || workerChanged;
    final policyChanged =
        baseline != null &&
        _canonicalGuestPolicy(baseline) != _canonicalGuestPolicy(candidate);
    final pakChanged =
        baseline == null ||
        baseline.pak.sha256 != candidate.pak.sha256 ||
        baseline.pak.size != candidate.pak.size;

    final changedPakEntries = <String>[];
    if (baseline == null) {
      changedPakEntries.addAll(_pakBlobMap(candidate).keys);
    } else if (pakChanged) {
      final basePakBlobs = _pakBlobMap(baseline);
      final nextPakBlobs = _pakBlobMap(candidate);
      if (basePakBlobs.isEmpty && nextPakBlobs.isEmpty) {
        final baseHashes =
            baseline.pak.parts.map((part) => part.sha256).toSet();
        for (final part in candidate.pak.parts) {
          if (!baseHashes.contains(part.sha256)) {
            changedPakEntries.add(part.key ?? 'offset:${part.offset}');
          }
        }
      } else if (basePakBlobs.isEmpty) {
        final baseAlignedParts = baseline.pak.parts
            .where(
              (part) =>
                  part.kind != 'metadata' &&
                  part.offset > 0 &&
                  part.offset % 16 == 0,
            )
            .toList();
        final baseCandidateParts =
            baseAlignedParts.isNotEmpty ? baseAlignedParts : baseline.pak.parts;
        final baseCounts = <String, int>{};
        for (final part in baseCandidateParts) {
          final token = '${part.sha256}:${part.size}';
          baseCounts[token] = (baseCounts[token] ?? 0) + 1;
        }
        var unmatchedBase = baseCandidateParts.length;
        final nextKeys = nextPakBlobs.keys.toList()..sort();
        for (final key in nextKeys) {
          final next = nextPakBlobs[key]!;
          final token = '${next.sha256}:${next.size}';
          final remaining = baseCounts[token] ?? 0;
          if (remaining > 0) {
            baseCounts[token] = remaining - 1;
            unmatchedBase -= 1;
          } else {
            changedPakEntries.add(key);
          }
        }
        for (var i = 0; i < unmatchedBase; i++) {
          changedPakEntries.add('legacy-removed#$i');
        }
      } else {
        final allKeys = <String>{
          ...basePakBlobs.keys,
          ...nextPakBlobs.keys,
        }.toList()
          ..sort();
        for (final key in allKeys) {
          final prev = basePakBlobs[key];
          final next = nextPakBlobs[key];
          if (prev == null ||
              next == null ||
              prev.sha256 != next.sha256 ||
              prev.size != next.size ||
              (prev.dtype ?? 0) != (next.dtype ?? 0)) {
            changedPakEntries.add(key);
          }
        }
      }
    }

    final changedAssets = <String>[];
    if (baseline == null) {
      changedAssets.addAll(_looseAssetMap(candidate).keys);
    } else {
      final baseAssets = _looseAssetMap(baseline);
      final nextAssets = _looseAssetMap(candidate);
      final allNames = <String>{
        ...baseAssets.keys,
        ...nextAssets.keys,
      }.toList()
        ..sort();
      for (final name in allNames) {
        final prev = baseAssets[name];
        final next = nextAssets[name];
        if (prev == null ||
            next == null ||
            prev.sha256 != next.sha256 ||
            prev.size != next.size) {
          changedAssets.add(name);
        }
      }
    }

    final updatedComponents = <String>[
      if (entryChanged) 'code',
      if (workerChanged) 'worker',
      if (policyChanged) 'policy',
      for (final key in changedPakEntries) 'pak:$key',
      for (final name in changedAssets) 'asset:$name',
    ];
    return _ManifestComponentDiff(
      entryChanged: entryChanged,
      workerChanged: workerChanged,
      codeChanged: codeChanged,
      policyChanged: policyChanged,
      pakChanged: pakChanged,
      changedPakEntries: changedPakEntries,
      changedAssets: changedAssets,
      updatedComponents: updatedComponents,
    );
  }

  void _enforceTargetScope({
    required PocketUpdateTarget target,
    required PocketPackageManifest? baseline,
    required PocketPackageManifest candidate,
    required _ManifestComponentDiff diff,
  }) {
    if (target.scope == PocketUpdateScope.all) return;
    if (target.scope == PocketUpdateScope.code) {
      if (diff.changedPakEntries.isNotEmpty ||
          diff.changedAssets.isNotEmpty ||
          (diff.pakChanged && diff.changedPakEntries.isEmpty)) {
        throw const PocketPackageException(
          'code-only update rejected because resource files also changed',
          code: 'update-target-scope',
        );
      }
      return;
    }
    if (target.scope == PocketUpdateScope.resource) {
      final rawTarget = target.resource ?? '';
      final resolved = _resolveResourceTarget(rawTarget, baseline, candidate);
      if (diff.codeChanged) {
        throw PocketPackageException(
          'single-resource update for $rawTarget rejected because code also changed',
          code: 'update-target-scope',
        );
      }
      if (diff.policyChanged) {
        throw PocketPackageException(
          'single-resource update for $rawTarget rejected because guest policy also changed',
          code: 'update-target-scope',
        );
      }
      final unexpectedPak = diff.changedPakEntries.where(
        (key) => !(resolved.isPak && key == resolved.id),
      );
      final unexpectedAssets = diff.changedAssets.where(
        (name) => !(!resolved.isPak && name == resolved.id),
      );
      final unattributedPakChange =
          diff.pakChanged &&
          (!resolved.isPak || !diff.changedPakEntries.contains(resolved.id));
      if (unexpectedPak.isNotEmpty ||
          unexpectedAssets.isNotEmpty ||
          unattributedPakChange) {
        throw PocketPackageException(
          'single-resource update for $rawTarget rejected because other resources also changed',
          code: 'update-target-scope',
        );
      }
    }
  }

  static _ResolvedResourceTarget _resolveResourceTarget(
    String raw,
    PocketPackageManifest? baseline,
    PocketPackageManifest candidate,
  ) {
    if (raw.trim().isEmpty) {
      throw const PocketPackageException(
        'resource target name must not be empty',
        code: 'update-resource-missing',
      );
    }
    final candidateAssets = _looseAssetMap(candidate);
    final baselineAssets =
        baseline == null
            ? const <String, PocketManifestAsset>{}
            : _looseAssetMap(baseline);
    final candidatePak = _pakBlobMap(candidate);
    final baselinePak =
        baseline == null
            ? const <String, PocketPakPart>{}
            : _pakBlobMap(baseline);

    bool hasAsset(String name) =>
        candidateAssets.containsKey(name) || baselineAssets.containsKey(name);
    bool hasPak(String key) =>
        candidatePak.containsKey(key) || baselinePak.containsKey(key);

    if (raw.startsWith('asset:')) {
      final exact = raw.substring('asset:'.length);
      final name = hasAsset(exact)
          ? exact
          : hasAsset(exact.trim())
              ? exact.trim()
              : exact;
      if (name.trim().isEmpty || !hasAsset(name)) {
        throw PocketPackageException(
          'target asset $name does not exist in manifest',
          code: 'update-resource-missing',
        );
      }
      return _ResolvedResourceTarget(isPak: false, id: name);
    }
    if (raw.startsWith('pak:')) {
      final exact = raw.substring('pak:'.length);
      final key = hasPak(exact)
          ? exact
          : hasPak(exact.trim())
              ? exact.trim()
              : exact;
      if (key.trim().isEmpty || !hasPak(key)) {
        throw PocketPackageException(
          'target PAK entry $key does not exist in manifest',
          code: 'update-resource-missing',
        );
      }
      return _ResolvedResourceTarget(isPak: true, id: key);
    }
    if (hasAsset(raw)) {
      return _ResolvedResourceTarget(isPak: false, id: raw);
    }
    if (hasPak(raw)) {
      return _ResolvedResourceTarget(isPak: true, id: raw);
    }
    final trimmed = raw.trim();
    if (trimmed.startsWith('asset:')) {
      final name = trimmed.substring('asset:'.length);
      if (name.isNotEmpty && hasAsset(name)) {
        return _ResolvedResourceTarget(isPak: false, id: name);
      }
    }
    if (trimmed.startsWith('pak:')) {
      final key = trimmed.substring('pak:'.length);
      if (key.isNotEmpty && hasPak(key)) {
        return _ResolvedResourceTarget(isPak: true, id: key);
      }
    }
    if (hasAsset(trimmed)) {
      return _ResolvedResourceTarget(isPak: false, id: trimmed);
    }
    if (hasPak(trimmed)) {
      return _ResolvedResourceTarget(isPak: true, id: trimmed);
    }
    throw PocketPackageException(
      'target resource $raw was not found in assets or PAK entries',
      code: 'update-resource-missing',
    );
  }

  static String? _workerPath(PocketPackageManifest? manifest) {
    final bytecode = manifest?.worker?['bytecode'];
    if (bytecode is Map && bytecode['path'] is String) {
      return bytecode['path'] as String;
    }
    return null;
  }

  static Object? _canonicalizeValue(Object? value) {
    if (value is Map) {
      final keys = value.keys.map((k) => k.toString()).toList()..sort();
      return <String, Object?>{
        for (final key in keys)
          if (value[key] != null) key: _canonicalizeValue(value[key]),
      };
    }
    if (value is List) {
      return value.map(_canonicalizeValue).toList(growable: false);
    }
    return value;
  }

  static String _canonicalWorker(PocketPackageManifest? manifest) {
    final worker = manifest?.worker;
    if (worker == null) return '';
    return jsonEncode(_canonicalizeValue(worker));
  }

  static String _canonicalGuestPolicy(PocketPackageManifest? manifest) {
    if (manifest == null) return '';
    return jsonEncode(_canonicalizeValue(manifest.guestManifest.toJson()));
  }

  static Map<String, PocketPakPart> _pakBlobMap(
    PocketPackageManifest manifest,
  ) {
    final result = <String, PocketPakPart>{};
    var unnamedIndex = 0;
    for (final part in manifest.pak.parts) {
      if (part.kind == 'metadata') continue;
      if (part.key != null && part.key!.isNotEmpty) {
        result[part.key!] = part;
      } else if (part.kind == 'blob') {
        result['blob#$unnamedIndex'] = part;
        unnamedIndex += 1;
      }
    }
    return result;
  }

  static Map<String, PocketManifestAsset> _looseAssetMap(
    PocketPackageManifest manifest,
  ) {
    final workerPath = _workerPath(manifest);
    return <String, PocketManifestAsset>{
      for (final item in manifest.assets.entries)
        if (workerPath == null || item.key != workerPath) item.key: item.value,
    };
  }

  Future<PocketDownloadResponse> _openWithRetry(
    Uri uri,
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback, {
    String resource = 'manifest',
  }) async {
    Object? lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await transport.open(uri, cancellation: token);
      } on PocketUpdateCancellation {
        rethrow;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
        _report(
          callback,
          PocketUpdateProgress(
            stage: PocketUpdateStage.retry,
            attempt: attempt + 1,
          ),
        );
        await Future.any(<Future<void>>[
          Future<void>.delayed(retryDelay),
          token.whenCancelled.then<void>(
            (_) => throw const PocketUpdateCancellation(),
          ),
        ]);
      }
    }
    throw PocketPackageException(
      'failed to fetch $resource: $lastError',
      code: 'manifest-download',
    );
  }

  void _validateManifestUri() {
    final scheme = manifestUri.scheme.toLowerCase();
    final loopback =
        manifestUri.host == '127.0.0.1' ||
        manifestUri.host == 'localhost' ||
        manifestUri.host == '::1';
    final debug =
        scheme == 'http' &&
        (loopback || debugHttpHosts.contains(manifestUri.host.toLowerCase()));
    if (scheme != 'https' && !debug) {
      throw const PocketPackageException(
        'manifest URL must use HTTPS or an allowed debug host',
        code: 'manifest-url',
      );
    }
  }

  void _validateTrustPolicyUri() {
    final uri = trustPolicyUri;
    if (uri == null) return;
    final scheme = uri.scheme.toLowerCase();
    final loopback =
        uri.host == '127.0.0.1' || uri.host == 'localhost' || uri.host == '::1';
    final debug =
        scheme == 'http' &&
        (loopback || debugHttpHosts.contains(uri.host.toLowerCase()));
    if (scheme != 'https' && !debug) {
      throw const PocketPackageException(
        'trust policy URL must use HTTPS or an allowed debug host',
        code: 'trust-policy-url',
      );
    }
  }

  static void _report(
    PocketUpdateProgressCallback? callback,
    PocketUpdateProgress progress,
  ) => callback?.call(progress);
}

final class _ManifestComponentDiff {
  const _ManifestComponentDiff({
    required this.entryChanged,
    required this.workerChanged,
    required this.codeChanged,
    required this.policyChanged,
    required this.pakChanged,
    required this.changedPakEntries,
    required this.changedAssets,
    required this.updatedComponents,
  });

  final bool entryChanged;
  final bool workerChanged;
  final bool codeChanged;
  final bool policyChanged;
  final bool pakChanged;
  final List<String> changedPakEntries;
  final List<String> changedAssets;
  final List<String> updatedComponents;
}

final class _ResolvedResourceTarget {
  const _ResolvedResourceTarget({required this.isPak, required this.id});

  final bool isPak;
  final String id;
}
