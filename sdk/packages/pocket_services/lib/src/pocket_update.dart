import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:pocket_flutter/src/pocket_package.dart'
    show PocketPackageSource;

import 'pocket_package.dart';

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
      Future<T>.delayed(
        timeout,
        () => throw PocketPackageException(message, code: 'http-timeout'),
      ),
    ]);
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

final class PocketPreparedPackage {
  const PocketPreparedPackage({
    required this.package,
    required this.needsActivation,
    this.isRollback = false,
  });

  final PocketPackage package;
  final bool needsActivation;
  final bool isRollback;
  PocketPackageSource get source => package.source;
  String get version => package.manifest.payload.version;
  int get build => package.manifest.payload.build;
  Future<PocketPackageArtifact> readArtifact() => package.readArtifact();
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
  );

  void dispose() => transport.close();

  Future<PocketPreparedPackage> prepare({
    PocketCancellationToken? cancellation,
    PocketUpdateProgressCallback? onProgress,
  }) async {
    final token = cancellation ?? PocketCancellationToken();
    _validateManifestUri();
    _report(
      onProgress,
      const PocketUpdateProgress(stage: PocketUpdateStage.checking),
    );
    final signed = await _fetchManifest(token, onProgress);
    await verifier.verify(signed);
    final currentGood = await _store.lastGood(verifier: verifier);
    final currentActive = await _store.active(verifier: verifier);
    final floorBuild = math.max(
      minimumBuild,
      math.max(
        currentGood?.manifest.payload.build ?? 0,
        currentActive?.manifest.payload.build ?? 0,
      ),
    );
    final establishedIdsAtFloor = <String>{
      if (currentGood != null &&
          currentGood.manifest.payload.build == floorBuild)
        currentGood.versionId,
      if (currentActive != null &&
          currentActive.manifest.payload.build == floorBuild)
        currentActive.versionId,
    };
    final hasBaseline =
        minimumBuild > 0 || currentGood != null || currentActive != null;
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
    if (currentActive != null &&
        currentActive.manifest.payload.contentHash ==
            signed.payload.contentHash) {
      _report(
        onProgress,
        const PocketUpdateProgress(stage: PocketUpdateStage.loading),
      );
      return PocketPreparedPackage(
        package: currentActive,
        needsActivation: false,
      );
    }
    final files = signed.payload.files;
    final total = files.fold<int>(0, (sum, file) => sum + file.size);
    if (total > maxTotalBytes)
      throw const PocketPackageException(
        'manifest total exceeds limit',
        code: 'manifest-size',
      );
    final blobs = <String, File>{};
    var completed = 0;
    _report(
      onProgress,
      PocketUpdateProgress(
        stage: PocketUpdateStage.downloading,
        totalBytes: total,
      ),
    );
    for (final file in files) {
      token.throwIfCancelled();
      final cached = await _store.validBlob(file, cancellation: token);
      if (cached != null) {
        blobs[file.sha256] = cached;
        completed += file.size;
        _report(
          onProgress,
          PocketUpdateProgress(
            stage: PocketUpdateStage.downloading,
            downloadedBytes: completed,
            totalBytes: total,
            fileSha256: file.sha256,
          ),
        );
        continue;
      }
      final blob = await _download(file, token, onProgress, completed);
      blobs[file.sha256] = blob;
      completed += file.size;
      _report(
        onProgress,
        PocketUpdateProgress(
          stage: PocketUpdateStage.downloading,
          downloadedBytes: completed,
          totalBytes: total,
          fileSha256: file.sha256,
        ),
      );
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
    return PocketPreparedPackage(package: package, needsActivation: true);
  }

  Future<PocketPreparedPackage?> lastGood({
    PocketCancellationToken? cancellation,
  }) async {
    cancellation?.throwIfCancelled();
    final package =
        await _store.lastGood(verifier: verifier) ??
        await _store.active(verifier: verifier);
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

  Future<File> _download(
    PocketManifestFile file,
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
    int completed,
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
              totalBytes: 0,
              fileSha256: file.sha256,
              attempt: attempt,
            ),
          ),
        );
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
    throw PocketPackageException(
      'failed to download ${file.sha256}: $lastError',
      code: 'download',
    );
  }

  Future<PocketDownloadResponse> _openWithRetry(
    Uri uri,
    PocketCancellationToken token,
    PocketUpdateProgressCallback? callback,
  ) async {
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
      'failed to fetch manifest: $lastError',
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

  static void _report(
    PocketUpdateProgressCallback? callback,
    PocketUpdateProgress progress,
  ) => callback?.call(progress);
}
