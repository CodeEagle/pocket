/// Removes absolute filesystem paths and secrets from everything that is
/// handed to the Studio guest. Rules (see studio/docs/ARCHITECTURE.md):
///
/// 1. JSON keys `workspace`, `projectRoot`, `flutterRoot`, `sdkRoot`,
///    `csrfToken`, `absolutePath` are dropped at any depth.
/// 2. Known roots (service workspace, project root, flutter root, SDK root,
///    host temp directories) are replaced by `<workspace>`, `<project>`,
///    `<flutter>`, `<sdk>`, `<tmp>`; `<workspace>/projects/<id>` becomes
///    `<project>`. `/private` aliases are handled.
/// 3. Any other absolute path under a well-known system top level directory
///    (or a Windows drive path, or a `file://` URI) becomes `<path>/<last>`.
/// 4. The CSRF token value is replaced by `<redacted>` wherever it appears.
/// 5. Signing key material never reaches the guest: keys named like a private key / seed are dropped at any
///    depth and PEM or OpenSSH private-key blocks inside any string become `<redacted-key>`. The service
///    does not return such fields (keys stay in its workspace); this is the provider-side backstop.
final class StudioPathScrubber {
  StudioPathScrubber({Iterable<MapEntry<String, String>> roots = const []}) {
    for (final root in roots) {
      addRoot(root.key, root.value);
    }
  }

  static const Set<String> droppedKeys = <String>{
    'workspace',
    'projectRoot',
    'flutterRoot',
    'sdkRoot',
    'csrfToken',
    'absolutePath',
    // Signing material (rule 5).
    'privateKey',
    'private_key',
    'privateKeyPem',
    'privateKeyBase64',
    'secretKey',
    'signingKey',
    'signingSeed',
    'seed',
  };

  static final RegExp _privateKeyBlock = RegExp(
    r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
  );

  static final RegExp _fileUri = RegExp(r'file://(?:localhost)?/[^\s"' "'" r'`<>|;,()\[\]{}\\]*');
  static final RegExp _posix = RegExp(
    r'(?<![A-Za-z0-9_.~<>\-/])/(?:Users|home|var|private|tmp|opt|usr|Volumes|root|mnt|srv|nix|snap|run|Library|Applications|System|proc|etc|workspace)(?:/[^\s"' "'" r'`<>|;,()\[\]{}\\]*)?',
  );
  static final RegExp _windows = RegExp(r'(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"' "'" r'<>|;,()]*');
  static final RegExp _projectDir = RegExp(r'<workspace>/projects/[a-z][a-z0-9-]*');

  final Map<String, String> _roots = <String, String>{};
  List<String> _ordered = const <String>[];
  final Set<String> _secrets = <String>{};

  /// Registers an absolute root and its label. Safe to call repeatedly.
  void addRoot(String path, String label) {
    var normalized = path.replaceAll('\\', '/');
    while (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.substring(0, normalized.length - 1);
    }
    if (normalized.length < 2 || !normalized.startsWith('/')) return;
    final variants = <String>{normalized};
    if (normalized.startsWith('/private/')) {
      variants.add(normalized.substring('/private'.length));
    } else if (normalized.startsWith('/var/') ||
        normalized.startsWith('/tmp') ||
        normalized.startsWith('/etc/')) {
      variants.add('/private$normalized');
    }
    for (final variant in variants) {
      _roots.putIfAbsent(variant, () => label);
    }
    _ordered = _roots.keys.toList()..sort((a, b) => b.length.compareTo(a.length));
  }

  void addSecret(String value) {
    if (value.length >= 8) _secrets.add(value);
  }

  String scrubString(String input) {
    var text = input.replaceAll(_privateKeyBlock, '<redacted-key>');
    for (final secret in _secrets) {
      text = text.replaceAll(secret, '<redacted>');
    }
    for (final root in _ordered) {
      final label = _roots[root]!;
      text = text.replaceAllMapped(
        RegExp('${RegExp.escape(root)}(?=/|\$|[^A-Za-z0-9._-])'),
        (_) => label,
      );
    }
    text = text.replaceAll(_projectDir, '<project>');
    text = text.replaceAll(_fileUri, 'file://<path>');
    text = text.replaceAllMapped(_posix, (m) => _withLast(m[0]!));
    text = text.replaceAllMapped(_windows, (m) => _withLast(m[0]!));
    return text;
  }

  static String _withLast(String path) {
    final cut = path.lastIndexOf(RegExp(r'[\\/]'));
    final last = cut < 0 ? '' : path.substring(cut + 1);
    final bare = path.length <= 1 || last.isEmpty || cut == 0;
    return bare ? '<path>' : '<path>/$last';
  }

  /// Returns a scrubbed deep copy of JSON-like [value].
  Object? scrubJson(Object? value) {
    if (value is String) return scrubString(value);
    if (value is List) return <Object?>[for (final item in value) scrubJson(item)];
    if (value is Map) {
      return <String, Object?>{
        for (final entry in value.entries)
          if (!droppedKeys.contains('${entry.key}'))
            '${entry.key}': scrubJson(entry.value),
      };
    }
    return value;
  }
}
