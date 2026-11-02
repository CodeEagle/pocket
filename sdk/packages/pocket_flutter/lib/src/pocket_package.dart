/// Locations of an already-admitted PocketJS guest package.
///
/// Package download, signatures and update policy belong to the application
/// layer. The renderer only needs these two local files when a host chooses to
/// avoid copying a large PAK through Dart's FFI allocator.
final class PocketPackageSource {
  const PocketPackageSource({
    required this.entryPath,
    required this.pakPath,
    this.entryFormat = 'bytecode',
    this.runtimeAbi,
    this.assetPaths = const <String, String>{},
  });

  factory PocketPackageSource.fromJson(Object? value) {
    if (value is! Map) {
      throw ArgumentError.value(value, 'value', 'must be a Map');
    }
    final json = value.cast<String, dynamic>();
    return PocketPackageSource(
      entryPath: json['entryPath'] as String? ?? '',
      pakPath: json['pakPath'] as String? ?? '',
      entryFormat: json['entryFormat'] as String? ?? 'bytecode',
      runtimeAbi: json['runtimeAbi'] as String?,
      assetPaths: (json['assetPaths'] as Map?)?.cast<String, dynamic>().map(
            (k, v) => MapEntry(k, v.toString()),
          ) ??
          const <String, String>{},
    );
  }

  final String entryPath;
  final String pakPath;
  final String entryFormat;
  final String? runtimeAbi;

  /// Optional paths for non-PAK resources. Package verification and update
  /// policy stay outside this renderer-only value object.
  final Map<String, String> assetPaths;

  String? pathForAsset(String asset) => assetPaths[asset];
}

typedef PocketPackageManifest = PocketPackageSource;
