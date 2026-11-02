import 'dart:typed_data';

/// Native binary endpoint for the fixed-size Pocket duplex transport.
///
/// Implementations own cursor publication. Returned views contain payloads
/// only; ring cursors and counters are never exposed to Dart. Native
/// implementations publish/consume with acquire/release atomics, so Dart
/// never races on a cursor through [ByteData]. The endpoint is SPSC: one
/// ingress producer and one egress consumer. A returned view is borrowed and
/// becomes invalid after its matching publish/consume, a later reservation, or
/// [close]; callers must not retain, mutate, or read it afterwards. The
/// endpoint lease is isolate affine unless a native embedding supplies an
/// explicit opaque retain/claim transfer API; in particular, the returned
/// [Uint8List] must never be sent through a [SendPort]. QuickJS is still
/// stepped only by the runtime owner thread.
abstract interface class PocketDuplexEndpoint {
  static const int messageByteSize = 16;

  bool get isNativeZeroCopy;

  /// Returns a borrowed writable view for up to [maxMessages] contiguous
  /// ingress slots. The view is valid only until [publishIngress], a later
  /// reservation, or [close].
  Uint8List? reserveIngress(int maxMessages);

  /// Atomically publishes [messageCount] previously reserved records.
  void publishIngress(int messageCount);

  /// Returns a borrowed view for up to [maxMessages] contiguous egress slots.
  /// The view is valid only until [consumeEgress], a later peek, or [close].
  Uint8List? peekEgress(int maxMessages);

  /// Atomically releases [messageCount] previously peeked records.
  void consumeEgress(int messageCount);

  /// Closes this retained endpoint and rejects all future operations.
  void close();
}

/// Optional binary transport implemented by the real native PocketJS runtime.
///
/// The raw ring/header view is deliberately absent: its cursors are native
/// atomics and must never be mapped as Dart [ByteData]. New native runtimes
/// expose only [duplexEndpoint].
abstract interface class PocketBinaryDuplexRuntime {
  PocketDuplexEndpoint? get duplexEndpoint => null;

  /// Drains host-written records on the QuickJS owner thread.
  int duplexStep();

  bool get duplexRuntimeAlive;
}

/// A lock-free SPSC host↔PocketJS channel.
///
/// Native channels publish cursors through [PocketDuplexEndpoint]; Dart only
/// writes/reads payload bytes while owning a reserved slot. Returned event
/// objects are consumer allocations and are excluded from the zero-copy claim.
/// A channel is bound to the runtime generation from which it was acquired:
/// close it before loading/reloading a guest and create a new channel for the
/// new generation. A retained old endpoint may keep native storage alive for
/// safety, but it must never be used as the new runtime's channel.
final class PocketDuplexChannel {
  static const int ringCapacity = 256;
  static const int messageByteSize = PocketDuplexEndpoint.messageByteSize;

  /// Reserved host-system record. The native runtime adapts this record to
  /// the canonical `input.pointer` event/GuestFrame path. Other application
  /// records should use a different message type; type 1 with a phase flag
  /// is not available for arbitrary guest-defined messages.
  static const int pointerMessageType = 1;
  static const int pointerDownFlag = 1;
  static const int pointerMoveFlag = 2;
  static const int pointerUpFlag = 3;
  static const int pointerCancelFlag = 4;
  static const int pointerAuxiliaryFlag = 0x0100;
  static const double _maxFloat32 = 3.4028234663852886e38;

  PocketDuplexChannel._({
    required PocketDuplexEndpoint endpoint,
    required PocketBinaryDuplexRuntime? runtime,
  }) : _endpoint = endpoint,
       _runtime = runtime,
       isNativeZeroCopy = endpoint.isNativeZeroCopy;

  /// Creates a channel over the runtime's atomic native endpoint.
  ///
  /// There is intentionally no implicit in-memory fallback. Use
  /// [PocketDuplexChannel.inMemory] explicitly for tests/non-native hosts.
  factory PocketDuplexChannel.fromRuntime(PocketBinaryDuplexRuntime runtime) {
    final endpoint = runtime.duplexEndpoint;
    if (endpoint == null) {
      throw UnsupportedError(
        'Pocket native runtime does not expose the lock-free duplex endpoint',
      );
    }
    return PocketDuplexChannel._(endpoint: endpoint, runtime: runtime);
  }

  /// Explicit deterministic endpoint for tests and non-native hosts.
  factory PocketDuplexChannel.inMemory() =>
      PocketDuplexChannel._(endpoint: _MemoryDuplexEndpoint(), runtime: null);

  final PocketDuplexEndpoint _endpoint;
  final PocketBinaryDuplexRuntime? _runtime;
  bool _closed = false;
  bool _ingressReserved = false;
  bool _egressPeeked = false;

  final bool isNativeZeroCopy;
  bool get isClosed => _closed;

  /// Writes one host→guest record and atomically publishes it.
  bool pushToPocketJs({
    required int msgType,
    int flags = 0,
    required int targetId,
    double arg0 = 0.0,
    double arg1 = 0.0,
  }) {
    _ensureOpen();
    if (_ingressReserved) {
      throw StateError('an ingress reservation is already active');
    }
    _validateFields(msgType, flags, targetId, arg0, arg1);
    Uint8List? view;
    try {
      view = _endpoint.reserveIngress(1);
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    }
    if (view == null || view.isEmpty) return false;
    try {
      if (view.length != messageByteSize) {
        throw StateError('native ingress view is not message aligned');
      }
      _ingressReserved = true;
      _writeFields(
        ByteData.sublistView(view),
        0,
        msgType,
        flags,
        targetId,
        arg0,
        arg1,
      );
      _endpoint.publishIngress(1);
      return true;
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    } finally {
      _ingressReserved = false;
    }
  }

  /// Writes as many records as the endpoint can reserve in one publish pair.
  /// Returns the number accepted. A [List] is used directly; other iterables
  /// are materialized once, so the native cursor is never advanced for a
  /// record that was not written.
  int pushBatch(Iterable<PocketDuplexMessage> messages) {
    _ensureOpen();
    if (_ingressReserved) {
      throw StateError('an ingress reservation is already active');
    }
    final pending = messages is List<PocketDuplexMessage>
        ? messages
        : messages.toList(growable: false);
    if (pending.isEmpty) return 0;
    // Validate before reserving native slots. A failed conversion must never
    // leave an atomic reservation that the producer cannot publish.
    for (final message in pending) {
      _validateMessage(message);
    }
    Uint8List? view;
    try {
      view = _endpoint.reserveIngress(pending.length);
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    }
    if (view == null || view.isEmpty) return 0;
    try {
      if (view.length % messageByteSize != 0) {
        throw StateError('native ingress view is not message aligned');
      }
      final accepted = view.length ~/ messageByteSize;
      if (accepted > pending.length) {
        throw StateError('native ingress view exceeds requested batch');
      }
      _ingressReserved = true;
      final bytes = ByteData.sublistView(view);
      for (var index = 0; index < accepted; index++) {
        _writeMessage(bytes, index * messageByteSize, pending[index]);
      }
      _endpoint.publishIngress(accepted);
      return accepted;
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    } finally {
      _ingressReserved = false;
    }
  }

  /// Runs the QuickJS owner-thread drain. Background producers must not call it.
  int step() {
    _ensureOpen();
    return _runtime?.duplexStep() ?? 0;
  }

  /// Reads and releases up to [maxBatch] guest→host records.
  List<PocketDuplexEvent> drainFromPocketJs({int maxBatch = 64}) {
    _ensureOpen();
    if (maxBatch < 1) {
      throw RangeError.value(maxBatch, 'maxBatch', 'must be at least 1');
    }
    if (_egressPeeked) {
      throw StateError('an egress reservation is already active');
    }
    Uint8List? view;
    try {
      view = _endpoint.peekEgress(maxBatch);
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    }
    if (view == null || view.isEmpty) return <PocketDuplexEvent>[];
    try {
      if (view.length % messageByteSize != 0) {
        throw StateError('native egress view is not message aligned');
      }
      final count = view.length ~/ messageByteSize;
      if (count > maxBatch) {
        throw StateError('native egress view exceeds batch');
      }
      _egressPeeked = true;
      final bytes = ByteData.sublistView(view);
      final events = List<PocketDuplexEvent>.generate(
        count,
        (index) => _readEvent(bytes, index * messageByteSize),
        growable: false,
      );
      _endpoint.consumeEgress(count);
      return events;
    } catch (error, stack) {
      _closeAndRethrow(error, stack);
    } finally {
      _egressPeeked = false;
    }
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _endpoint.close();
  }

  void _ensureOpen() {
    if (_closed) throw StateError('Pocket duplex channel is closed');
    final runtime = _runtime;
    if (runtime != null && !runtime.duplexRuntimeAlive) {
      close();
      throw StateError('Pocket duplex runtime is disposed');
    }
  }

  Never _closeAndRethrow(Object error, StackTrace stack) {
    try {
      close();
    } catch (_) {
      // Preserve the operation that lost the native reservation. close() is
      // best-effort here; a native endpoint must never remain half-reserved.
    }
    Error.throwWithStackTrace(error, stack);
  }

  static void _writeMessage(
    ByteData bytes,
    int offset,
    PocketDuplexMessage message,
  ) => _writeFields(
    bytes,
    offset,
    message.msgType,
    message.flags,
    message.targetId,
    message.arg0,
    message.arg1,
  );

  static void _writeFields(
    ByteData bytes,
    int offset,
    int msgType,
    int flags,
    int targetId,
    double arg0,
    double arg1,
  ) {
    bytes.setUint16(offset, msgType, Endian.little);
    bytes.setUint16(offset + 2, flags, Endian.little);
    bytes.setUint32(offset + 4, targetId, Endian.little);
    bytes.setFloat32(offset + 8, arg0, Endian.little);
    bytes.setFloat32(offset + 12, arg1, Endian.little);
  }

  static void _validateMessage(PocketDuplexMessage message) {
    _validateFields(
      message.msgType,
      message.flags,
      message.targetId,
      message.arg0,
      message.arg1,
    );
  }

  static void _validateFields(
    int msgType,
    int flags,
    int targetId,
    double arg0,
    double arg1,
  ) {
    _checkUint(msgType, 0xffff, 'msgType');
    _checkUint(flags, 0xffff, 'flags');
    _checkUint(targetId, 0xffffffff, 'targetId');
    _checkFloat32(arg0, 'arg0');
    _checkFloat32(arg1, 'arg1');
  }

  static PocketDuplexEvent _readEvent(ByteData bytes, int offset) =>
      PocketDuplexEvent(
        msgType: bytes.getUint16(offset, Endian.little),
        flags: bytes.getUint16(offset + 2, Endian.little),
        targetId: bytes.getUint32(offset + 4, Endian.little),
        arg0: bytes.getFloat32(offset + 8, Endian.little),
        arg1: bytes.getFloat32(offset + 12, Endian.little),
      );

  static void _checkUint(int value, int max, String name) {
    if (value < 0 || value > max) throw RangeError.range(value, 0, max, name);
  }

  static void _checkFloat32(double value, String name) {
    if (!value.isFinite || value.abs() > _maxFloat32) {
      throw RangeError('$name must be a finite float32');
    }
  }
}

class PocketDuplexMessage {
  const PocketDuplexMessage({
    required this.msgType,
    this.flags = 0,
    required this.targetId,
    this.arg0 = 0.0,
    this.arg1 = 0.0,
  });

  final int msgType;
  final int flags;
  final int targetId;
  final double arg0;
  final double arg1;
}

final class PocketDuplexEvent extends PocketDuplexMessage {
  const PocketDuplexEvent({
    required super.msgType,
    super.flags,
    required super.targetId,
    super.arg0,
    super.arg1,
  });
}

/// Single-isolate fallback implementing the same reservation protocol. It is
/// intentionally private: callers opt in through [PocketDuplexChannel.inMemory]
/// and cannot confuse it with a native lock-free endpoint.
final class _MemoryDuplexEndpoint implements PocketDuplexEndpoint {
  static const int _capacity = 256;
  final Uint8List _ingress = Uint8List(
    _capacity * PocketDuplexEndpoint.messageByteSize,
  );
  final Uint8List _egress = Uint8List(
    _capacity * PocketDuplexEndpoint.messageByteSize,
  );
  var _ingressWrite = 0;
  var _ingressRead = 0;
  var _egressWrite = 0;
  var _egressRead = 0;
  var _closed = false;

  @override
  bool get isNativeZeroCopy => false;

  @override
  Uint8List? reserveIngress(int maxMessages) {
    if (_closed || maxMessages < 1) return null;
    final available =
        (_ingressRead - _ingressWrite - 1 + _capacity) % _capacity;
    final requested = available < maxMessages ? available : maxMessages;
    if (requested == 0) return null;
    final contiguous = _capacity - _ingressWrite;
    final slots = requested < contiguous ? requested : contiguous;
    return Uint8List.sublistView(
      _ingress,
      _ingressWrite * PocketDuplexEndpoint.messageByteSize,
      (_ingressWrite + slots) * PocketDuplexEndpoint.messageByteSize,
    );
  }

  @override
  void publishIngress(int messageCount) {
    if (_closed) throw StateError('endpoint is closed');
    if (messageCount < 1 || messageCount >= _capacity) {
      throw RangeError.value(messageCount, 'messageCount');
    }
    _ingressWrite = (_ingressWrite + messageCount) % _capacity;
  }

  @override
  Uint8List? peekEgress(int maxMessages) {
    if (_closed || maxMessages < 1 || _egressRead == _egressWrite) {
      return null;
    }
    final available = (_egressWrite - _egressRead + _capacity) % _capacity;
    final requested = available < maxMessages ? available : maxMessages;
    final contiguous = _capacity - _egressRead;
    final slots = requested < contiguous ? requested : contiguous;
    return Uint8List.sublistView(
      _egress,
      _egressRead * PocketDuplexEndpoint.messageByteSize,
      (_egressRead + slots) * PocketDuplexEndpoint.messageByteSize,
    );
  }

  @override
  void consumeEgress(int messageCount) {
    if (_closed) throw StateError('endpoint is closed');
    if (messageCount < 1 || messageCount >= _capacity) {
      throw RangeError.value(messageCount, 'messageCount');
    }
    _egressRead = (_egressRead + messageCount) % _capacity;
  }

  @override
  void close() => _closed = true;
}
