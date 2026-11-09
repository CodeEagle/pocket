import 'dart:io';

import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

/// Redirects only the app-support directory used by the real platform store.
/// All other path-provider calls continue through the registered plugin.
final class IsolatedNovelSupportDirectory {
  PathProviderPlatform? _previous;
  Directory? _directory;
  late _IsolatedPathProvider _provider;

  String get path => _directory!.path;

  Future<void> install() async {
    if (_previous != null) {
      throw StateError(
        'The isolated app-support directory is already installed',
      );
    }
    _previous = PathProviderPlatform.instance;
    _directory = await Directory.systemTemp.createTemp(
      'pocket-novel-performance-support-',
    );
    _provider = _IsolatedPathProvider(_previous!, path);
    PathProviderPlatform.instance = _provider;
  }

  Future<void> restore() async {
    final previous = _previous;
    final directory = _directory;
    if (previous == null || directory == null) return;
    PathProviderPlatform.instance = previous;
    _previous = null;
    _directory = null;
    if (await directory.exists()) await directory.delete(recursive: true);
  }
}

final class _IsolatedPathProvider extends PathProviderPlatform {
  _IsolatedPathProvider(this.delegate, this.supportPath);

  final PathProviderPlatform delegate;
  final String supportPath;

  @override
  Future<String?> getApplicationSupportPath() async => supportPath;

  @override
  Future<String?> getTemporaryPath() => delegate.getTemporaryPath();

  @override
  Future<String?> getLibraryPath() => delegate.getLibraryPath();

  @override
  Future<String?> getApplicationDocumentsPath() =>
      delegate.getApplicationDocumentsPath();

  @override
  Future<String?> getApplicationCachePath() =>
      delegate.getApplicationCachePath();

  @override
  Future<String?> getExternalStoragePath() => delegate.getExternalStoragePath();

  @override
  Future<List<String>?> getExternalCachePaths() =>
      delegate.getExternalCachePaths();

  @override
  Future<List<String>?> getExternalStoragePaths({StorageDirectory? type}) =>
      delegate.getExternalStoragePaths(type: type);

  @override
  Future<String?> getDownloadsPath() => delegate.getDownloadsPath();
}
