import 'dart:convert';

/// Immutable host-selected limits for a PocketJS guest realm.
///
/// The policy is admitted before the guest is loaded and is passed to native
/// once for that realm. It does not represent app/business state and cannot be
/// changed after [FfiPocketRuntime.open] returns.
final class PocketGuestSecurityPolicy {
  const PocketGuestSecurityPolicy({
    this.hardenBuiltins = false,
    this.maxNodes,
    this.maxDrawOps,
  });

  static const int maximumLimit = 1_000_000;

  final bool hardenBuiltins;
  final int? maxNodes;
  final int? maxDrawOps;

  /// Whether the policy is the compatibility default. The Dart bridge does
  /// not even look up the optional native symbol for this policy.
  bool get isDefault =>
      !hardenBuiltins && maxNodes == null && maxDrawOps == null;

  /// Validates optional positive integer limits before opening native state.
  void validate() {
    _validateLimit('maxNodes', maxNodes);
    _validateLimit('maxDrawOps', maxDrawOps);
  }

  Map<String, Object> toJson() {
    validate();
    return <String, Object>{
      'hardenBuiltins': hardenBuiltins,
      if (maxNodes != null) 'maxNodes': maxNodes!,
      if (maxDrawOps != null) 'maxDrawOps': maxDrawOps!,
    };
  }

  String toJsonString() => jsonEncode(toJson());

  @override
  bool operator ==(Object other) =>
      other is PocketGuestSecurityPolicy &&
      hardenBuiltins == other.hardenBuiltins &&
      maxNodes == other.maxNodes &&
      maxDrawOps == other.maxDrawOps;

  @override
  int get hashCode => Object.hash(hardenBuiltins, maxNodes, maxDrawOps);

  void _validateLimit(String name, int? value) {
    if (value != null && (value < 1 || value > maximumLimit)) {
      throw FormatException(
        'guestSecurity.$name must be a positive integer <= $maximumLimit',
      );
    }
  }
}
