/// Per-realm native admission limits. These bound QuickJS heap allocations and
/// the PAK admitted at mount; they are not process RSS or GPU-memory counters.
final class PocketMemoryLimits {
  const PocketMemoryLimits({this.heapLimitBytes, this.maxPakBytes});

  static const legacyBaseHeapBytes = 16 * 1024 * 1024;
  static const maximumHeapBytes = 2 * 1024 * 1024 * 1024;
  static const maximumPakBytes = 512 * 1024 * 1024;

  /// Total QuickJS heap, including its immutable PAK copy. When omitted,
  /// native retains its legacy 16 MiB plus PAK-size allowance.
  final int? heapLimitBytes;
  final int? maxPakBytes;
  bool get isEmpty => heapLimitBytes == null && maxPakBytes == null;

  factory PocketMemoryLimits.fromJson(Object? value) {
    if (value is! Map ||
        value.keys.any(
          (key) => key != 'heapLimitBytes' && key != 'maxPakBytes',
        )) {
      throw const FormatException('memory must contain only supported limits');
    }
    int? read(String key) {
      if (!value.containsKey(key)) return null;
      final number = value[key];
      if (number is! int)
        throw FormatException('memory.$key must be an integer');
      return number;
    }

    final limits = PocketMemoryLimits(
      heapLimitBytes: read('heapLimitBytes'),
      maxPakBytes: read('maxPakBytes'),
    );
    limits.validate();
    return limits;
  }

  void validate() {
    final heap = heapLimitBytes;
    final pak = maxPakBytes;
    if (heap != null && (heap < 64 * 1024 || heap > maximumHeapBytes)) {
      throw const FormatException(
        'memory.heapLimitBytes must be 64 KiB..2 GiB',
      );
    }
    if (pak != null && (pak < 1 || pak > maximumPakBytes)) {
      throw const FormatException('memory.maxPakBytes must be 1 byte..512 MiB');
    }
  }

  /// Host-side authorization only. App selection and resource policy stay in
  /// the JS manager; an untrusted request can only tighten approved limits.
  PocketMemoryLimits admit(PocketMemoryLimits requested) {
    validate();
    requested.validate();
    if (requested.heapLimitBytes != null &&
        requested.heapLimitBytes! > (heapLimitBytes ?? legacyBaseHeapBytes)) {
      throw const FormatException('memory heap request exceeds host allowance');
    }
    if (requested.maxPakBytes != null &&
        requested.maxPakBytes! > (maxPakBytes ?? maximumPakBytes)) {
      throw const FormatException('memory PAK request exceeds host allowance');
    }
    return PocketMemoryLimits(
      heapLimitBytes: requested.heapLimitBytes ?? heapLimitBytes,
      maxPakBytes: requested.maxPakBytes ?? maxPakBytes,
    );
  }

  Map<String, int> toJson() => {
    if (heapLimitBytes != null) 'heapLimitBytes': heapLimitBytes!,
    if (maxPakBytes != null) 'maxPakBytes': maxPakBytes!,
  };

  @override
  bool operator ==(Object other) =>
      other is PocketMemoryLimits &&
      heapLimitBytes == other.heapLimitBytes &&
      maxPakBytes == other.maxPakBytes;

  @override
  int get hashCode => Object.hash(heapLimitBytes, maxPakBytes);
}
