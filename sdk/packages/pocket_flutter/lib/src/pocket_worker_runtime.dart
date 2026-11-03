import 'dart:convert';
import 'dart:typed_data';

/// Process limits passed to PocketJS's pinned worker runner.
///
/// The runner enforces request/event/channel quotas from the upstream worker
/// protocol. These values bound the independent QuickJS realm and its CPU
/// scheduling; they do not create a Dart-side worker loop.
final class PocketWorkerLimits {
  const PocketWorkerLimits({
    this.heapBytes = 16 * 1024 * 1024,
    this.stackBytes = 1024 * 1024,
    this.turnBudgetMicros = 10000,
    this.windowMicros = 50000,
    this.quotaMicros = 10000,
  });

  final int heapBytes;
  final int stackBytes;
  final int turnBudgetMicros;
  final int windowMicros;
  final int quotaMicros;

  void validate() {
    if (heapBytes < 64 * 1024 || heapBytes > 256 * 1024 * 1024) {
      throw const FormatException('worker heapBytes is out of range');
    }
    if (stackBytes < 64 * 1024 || stackBytes > 16 * 1024 * 1024) {
      throw const FormatException('worker stackBytes is out of range');
    }
    if (turnBudgetMicros < 1 || turnBudgetMicros > 100000) {
      throw const FormatException('worker turnBudgetMicros is out of range');
    }
    if (windowMicros < 1 ||
        quotaMicros < 1 ||
        quotaMicros > windowMicros) {
      throw const FormatException('worker CPU quota is out of range');
    }
  }

  Map<String, Object> toJson() => {
    'heapBytes': heapBytes,
    'stackBytes': stackBytes,
    'turnBudgetMicros': turnBudgetMicros,
    'windowMicros': windowMicros,
    'quotaMicros': quotaMicros,
  };
}

/// Validated bytecode and signed worker declaration passed to the native host.
///
/// The object keeps an immutable JSON encoding and a private byte copy. It
/// intentionally exposes no QuickJS context or Dart worker scheduler. The
/// native host owns the independent runner, UI channel attachment, frame latch,
/// cancellation, and teardown sequence.
final class PocketWorkerProgram {
  PocketWorkerProgram({
    required Uint8List bytecode,
    required Map<String, Object?> declaration,
    required this.expectedRuntimeAbi,
    required this.bindingGeneration,
    required this.tickHz,
    required Iterable<String> requiredCapabilities,
    Iterable<String> allowedHttpOrigins = const [],
    this.protocolVersion = 1,
    this.limits = const PocketWorkerLimits(),
  }) : _bytecode = Uint8List.fromList(bytecode),
       _declarationJson = jsonEncode(declaration),
       requiredCapabilities = List<String>.unmodifiable(
         requiredCapabilities.toSet().toList()..sort(),
       ),
       allowedHttpOrigins = List<String>.unmodifiable(
         allowedHttpOrigins.toSet().toList()..sort(),
       ) {
    if (protocolVersion != 1) {
      throw const FormatException('unsupported PocketJS worker protocol');
    }
    if (bytecode.isEmpty) {
      throw const FormatException('worker QJBC bytecode is empty');
    }
    if (expectedRuntimeAbi.trim().isEmpty) {
      throw const FormatException('worker runtime ABI is required');
    }
    if (bindingGeneration < 1 || bindingGeneration > 0xffffffff) {
      throw const FormatException('worker bindingGeneration is out of range');
    }
    if (tickHz < 1 || tickHz > 120) {
      throw const FormatException('worker tickHz is out of range');
    }
    limits.validate();
  }

  final Uint8List _bytecode;
  final String _declarationJson;
  final String expectedRuntimeAbi;
  final int bindingGeneration;
  final int tickHz;
  final int protocolVersion;
  final List<String> requiredCapabilities;

  /// Exact HTTP(S) origins granted by the host. Empty denies every HTTP node.
  final List<String> allowedHttpOrigins;
  final PocketWorkerLimits limits;

  Uint8List get bytecode => Uint8List.fromList(_bytecode);

  Map<String, Object?> get declaration =>
      (jsonDecode(_declarationJson) as Map).cast<String, Object?>();

  /// The stable native configuration schema consumed alongside QJBC bytes.
  ///
  /// [nativeGeneration] is allocated by the host for each runtime lifetime;
  /// late callbacks from another generation must be discarded by the host.
  String nativeConfigJson({required int nativeGeneration}) {
    if (nativeGeneration < 1 || nativeGeneration > 0xffffffff) {
      throw const FormatException('worker nativeGeneration is out of range');
    }
    return jsonEncode({
      'protocolVersion': protocolVersion,
      'nativeGeneration': nativeGeneration,
      'bindingGeneration': bindingGeneration,
      'tickHz': tickHz,
      'expectedRuntimeAbi': expectedRuntimeAbi,
      'declaration': jsonDecode(_declarationJson),
      'policy': {
        'requiredCapabilities': requiredCapabilities,
        'allowedHttpOrigins': allowedHttpOrigins,
      },
      'limits': limits.toJson(),
    });
  }
}

/// Optional native runtime capability for attaching a worker before UI eval.
///
/// A concrete FFI host retains the native wake callback (and its
/// NativeCallable) until worker teardown. The host attaches the channel bridge
/// before evaluating UI bytecode and latches worker output before each frame.
abstract interface class PocketWorkerRuntime {
  void configureWorker(
    PocketWorkerProgram program, {
    required void Function() onWake,
  });
}
