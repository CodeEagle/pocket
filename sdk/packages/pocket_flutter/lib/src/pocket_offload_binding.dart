part of 'pocket_runtime.dart';

const int _pocketOffloadGeneration = 1;
const int _pocketOffloadBatchLimit = 8;
const int _pocketOffloadMaxPayloadBytes = 1800;
const int _pocketOffloadDefaultTimeoutMs = 10000;

typedef _ConfigureOffloadNative =
    Int32 Function(
      Pointer<Void> host,
      Pointer<Utf8> config,
      Pointer<NativeFunction<_WorkerWakeNative>> notify,
    );
typedef _ConfigureOffloadDart =
    int Function(
      Pointer<Void> host,
      Pointer<Utf8> config,
      Pointer<NativeFunction<_WorkerWakeNative>> notify,
    );
typedef _OffloadTakeNative =
    Pointer<Utf8> Function(Pointer<Void> host, Uint32 cancel);
typedef _OffloadTakeDart =
    Pointer<Utf8> Function(Pointer<Void> host, int cancel);
typedef _OffloadCompleteNative =
    Int32 Function(Pointer<Void> host, Pointer<Utf8> completion);
typedef _OffloadCompleteDart =
    int Function(Pointer<Void> host, Pointer<Utf8> completion);
typedef _OffloadHasRepliesNative = Uint32 Function(Pointer<Void> host);
typedef _OffloadHasRepliesDart = int Function(Pointer<Void> host);

/// Bridges native PocketJS offload records to one trusted async provider.
/// Native notifications are the only drain trigger; there is no timer or poll.
final class _PocketOffloadBinding {
  _PocketOffloadBinding(
    this._owner,
    this._provider, {
    required void Function() onWake,
  }) : _onWake = onWake {
    _owner._checkAlive();
    _session = _provider.session;
    if (_session < 1 || _session > 0xffffffff) {
      throw const FormatException('offload provider session is out of range');
    }
    _methods = _provider.methods.toList()..sort();
    if (_methods.isEmpty ||
        _methods.any((method) => !_validOffloadMethod(method))) {
      throw const FormatException('offload provider methods are invalid');
    }

    _configure = _owner._library
        .lookupFunction<_ConfigureOffloadNative, _ConfigureOffloadDart>(
          'pocket_configure_offload',
        );
    _take = _owner._library
        .lookupFunction<_OffloadTakeNative, _OffloadTakeDart>(
          'pocket_offload_take',
        );
    _complete = _owner._library
        .lookupFunction<_OffloadCompleteNative, _OffloadCompleteDart>(
          'pocket_offload_complete',
        );
    _hasReplies = _owner._library
        .lookupFunction<_OffloadHasRepliesNative, _OffloadHasRepliesDart>(
          'pocket_offload_has_replies',
        );

    final notify = NativeCallable<_WorkerWakeNative>.listener(_onNativeNotify);
    _notify = notify;
    Pointer<Utf8>? config;
    final configFields = <String, Object>{
      'generation': _pocketOffloadGeneration,
      'session': _session,
      'timeoutMs': _pocketOffloadDefaultTimeoutMs,
      'methods': _methods,
    };
    var configured = false;
    Object? failure;
    _owner._traceTransactionBegin();
    try {
      config = jsonEncode(configFields).toNativeUtf8(allocator: malloc);
      final result = _configure(_owner._handle, config, notify.nativeFunction);
      if (result != 0) {
        _owner._throwLastError('pocket_configure_offload failed');
      }
      _configured = true;
      configured = true;
    } catch (error) {
      failure = error;
      notify.close();
      rethrow;
    } finally {
      if (config != null) malloc.free(config);
      final traceClock = _owner._traceTransactionEnd();
      if (_owner._recordingEnabled) {
        _owner._recordTransaction(
          'offloadConfigure',
          args: <String, dynamic>{'config': configFields},
          result: configured
              ? const <String, dynamic>{'configured': true}
              : const <String, dynamic>{},
          error: _owner._errorSummary(failure),
          traceClock: traceClock,
        );
      }
    }
  }

  final FfiPocketRuntime _owner;
  final PocketOffloadProvider _provider;
  final void Function() _onWake;
  late final int _session;
  late final List<String> _methods;
  late final _ConfigureOffloadDart _configure;
  late final _OffloadTakeDart _take;
  late final _OffloadCompleteDart _complete;
  late final _OffloadHasRepliesDart _hasReplies;
  late final NativeCallable<_WorkerWakeNative> _notify;
  final Map<PocketOffloadKey, _PocketOffloadPending> _pending =
      <PocketOffloadKey, _PocketOffloadPending>{};
  bool _configured = false;
  bool _disposing = false;
  bool _callbackClosed = false;

  /// Cancel Dart work and close the provider before the runtime destroys its
  /// native handle. Provider close is invoked synchronously and observed even
  /// when its Future completes after native teardown.
  void disposeBeforeNative() {
    if (_disposing) return;
    _disposing = true;
    final pending = _pending.values.toList(growable: false);
    _pending.clear();
    for (final item in pending) {
      item.cancellation.cancel();
      try {
        _provider.cancel(item.request);
      } on Object {
        // Teardown continues for the other outstanding provider operations.
      }
    }
    try {
      unawaited(_provider.close().catchError((Object _) {}));
    } on Object {
      // Native teardown must still run if a provider fails to close.
    }
  }

  /// Close the retained Dart callback after pocket_destroy has stopped native
  /// notifications. Calling this earlier could leave a native thread holding
  /// a pointer to a closed NativeCallable.
  void disposeAfterNative() {
    if (_callbackClosed) return;
    if (!_disposing) disposeBeforeNative();
    _callbackClosed = true;
    _notify.close();
  }

  void _onNativeNotify() {
    if (_disposing || !_configured || _callbackClosed || _owner._disposed) {
      return;
    }
    var drained = 0;
    var hadError = false;

    // Cancellations free native/provider slots. Apply them before accepting
    // replacement requests from the same notification batch.
    while (drained < _pocketOffloadBatchLimit) {
      String? record;
      try {
        record = _takeRecord(cancel: true);
      } on Object {
        hadError = true;
        break;
      }
      if (record == null) break;
      drained++;
      try {
        _cancelRecord(record);
      } on Object {
        hadError = true;
      }
    }
    while (drained < _pocketOffloadBatchLimit) {
      String? record;
      try {
        record = _takeRecord(cancel: false);
      } on Object {
        hadError = true;
        break;
      }
      if (record == null) break;
      drained++;
      try {
        _requestRecord(record);
      } on Object {
        hadError = true;
      }
    }

    var hasReplies = false;
    try {
      hasReplies = _hasReplies(_owner._handle) != 0;
    } on Object {
      hadError = true;
    }
    if (hadError || hasReplies) _wakeOwner();
  }

  String? _takeRecord({required bool cancel}) {
    if (_disposing || _owner._disposed) return null;
    final pointer = _take(_owner._handle, cancel ? 1 : 0);
    if (pointer.address == 0) return null;
    return _copyString(pointer);
  }

  void _cancelRecord(String source) {
    final record = _decodeRecord(source);
    final key = _readKey(record);
    if (key == null)
      throw const FormatException('invalid offload cancellation key');
    final active = _pending.remove(key);
    if (active == null) return;
    active.cancellation.cancel();
    try {
      _provider.cancel(active.request);
    } on Object {
      // Cancellation is best effort; the token already notifies cooperative
      // providers and the native side has retired this request identity.
    }
  }

  void _requestRecord(String source) {
    final fields = _decodeRecord(source);
    final key = _readKey(fields);
    if (key == null) throw const FormatException('invalid offload request key');

    late final PocketOffloadRequest request;
    try {
      request = PocketOffloadRequest.fromJson(fields);
    } on Object catch (error) {
      _completeFailure(key, 'invalid offload request: $error');
      return;
    }
    if (request.generation != _pocketOffloadGeneration ||
        request.session != _session) {
      // A request from a retired native generation/session cannot be completed
      // against this provider. Native owns its timeout and stale cleanup.
      return;
    }
    if (_pending.containsKey(request.key)) {
      // Completing a duplicate id could incorrectly settle the original
      // Future, so ignore the malformed second record.
      return;
    }
    if (_pending.length >= _pocketOffloadBatchLimit) {
      _completeFailure(request.key, 'offload provider is at capacity');
      return;
    }
    if (!_methods.contains(request.method)) {
      _completeFailure(request.key, 'offload method is unavailable');
      return;
    }

    final active = _PocketOffloadPending(
      request,
      PocketOffloadCancellationToken(),
    );
    _pending[request.key] = active;
    unawaited(_execute(active));
  }

  Future<void> _execute(_PocketOffloadPending active) async {
    try {
      final payload = await _provider.execute(
        active.request,
        active.cancellation,
      );
      if (!_isCurrent(active)) return;
      final completion =
          utf8.encode(payload).length <= _pocketOffloadMaxPayloadBytes
          ? PocketOffloadCompletion.success(active.request.key, payload)
          : PocketOffloadCompletion.failure(
              active.request.key,
              'offload payload exceeds response budget',
            );
      _sendCompletion(completion);
    } on Object catch (error) {
      if (!_isCurrent(active) || active.cancellation.isCancelled) return;
      final completion = PocketOffloadCompletion.failure(
        active.request.key,
        error.toString(),
      );
      _sendCompletion(completion);
    } finally {
      if (identical(_pending[active.request.key], active)) {
        _pending.remove(active.request.key);
      }
    }
  }

  void _completeFailure(PocketOffloadKey key, String error) {
    _sendCompletion(PocketOffloadCompletion.failure(key, error));
  }

  bool _sendCompletion(PocketOffloadCompletion completion) {
    // Async provider results can arrive after either the Dart owner or its
    // native handle has been disposed. Never cross FFI after that boundary.
    if (_disposing || _owner._disposed || !_configured) return false;
    final source = completion.toNativeRecord();
    final pointer = source.toNativeUtf8(allocator: malloc);
    try {
      return _complete(_owner._handle, pointer) == 0;
    } on Object {
      return false;
    } finally {
      malloc.free(pointer);
    }
  }

  bool _isCurrent(_PocketOffloadPending active) =>
      !_disposing &&
      !_owner._disposed &&
      identical(_pending[active.request.key], active);

  void _wakeOwner() {
    if (_disposing || _owner._disposed) return;
    try {
      _owner._notifyExternalWork(source: 'offload');
    } on Object {
      // Continue to the embedding callback if the native scheduler hint fails.
    }
    try {
      _onWake();
    } on Object {
      // An embedding callback cannot terminate the native offload bridge.
    }
  }

  static Map<String, Object?> _decodeRecord(String source) {
    final decoded = jsonDecode(source);
    if (decoded is! Map)
      throw const FormatException('offload record is not an object');
    return Map<String, Object?>.from(decoded);
  }

  static PocketOffloadKey? _readKey(Map<String, Object?> value) {
    final generation = value['generation'];
    final session = value['session'];
    final id = value['id'];
    if (generation is! int ||
        generation < 1 ||
        generation > 0xffffffff ||
        session is! int ||
        session < 1 ||
        session > 0xffffffff ||
        id is! int ||
        id < 1 ||
        id > 9007199254740991) {
      return null;
    }
    return PocketOffloadKey(generation: generation, session: session, id: id);
  }

  static bool _validOffloadMethod(String method) =>
      RegExp(r'^[a-z][a-z0-9_.-]{0,63}$').hasMatch(method);
}

final class _PocketOffloadPending {
  _PocketOffloadPending(this.request, this.cancellation);

  final PocketOffloadRequest request;
  final PocketOffloadCancellationToken cancellation;
}
