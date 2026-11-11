import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show FlutterErrorDetails;
import 'package:flutter/services.dart' show PlatformException;

import 'types.dart';

final class ResolvedNormalizationLimits {
  const ResolvedNormalizationLimits({
    required this.maxDepth,
    required this.maxNodes,
    required this.maxArrayLength,
    required this.maxObjectKeys,
    required this.maxStringLength,
    required this.maxStackLength,
    required this.maxCauseDepth,
    required this.maxDataBytes,
  });

  final int maxDepth;
  final int maxNodes;
  final int maxArrayLength;
  final int maxObjectKeys;
  final int maxStringLength;
  final int maxStackLength;
  final int maxCauseDepth;
  final int maxDataBytes;
}

int _clampPositiveInt(int? value, int fallback, int min, int max) {
  if (value == null) return fallback;
  return math.max(min, math.min(max, value));
}

ResolvedNormalizationLimits resolveNormalizationLimits([
  DiagnosticNormalizationLimits? limits,
]) => ResolvedNormalizationLimits(
  maxDepth: _clampPositiveInt(limits?.maxDepth, defaultMaxDepth, 1, 32),
  maxNodes: _clampPositiveInt(limits?.maxNodes, defaultMaxNodes, 8, 8192),
  maxArrayLength: _clampPositiveInt(
    limits?.maxArrayLength,
    defaultMaxArrayLength,
    1,
    1024,
  ),
  maxObjectKeys: _clampPositiveInt(
    limits?.maxObjectKeys,
    defaultMaxObjectKeys,
    1,
    1024,
  ),
  maxStringLength: _clampPositiveInt(
    limits?.maxStringLength,
    defaultMaxStringLength,
    32,
    256 * 1024,
  ),
  maxStackLength: _clampPositiveInt(
    limits?.maxStackLength,
    defaultMaxStackLength,
    128,
    512 * 1024,
  ),
  maxCauseDepth: _clampPositiveInt(
    limits?.maxCauseDepth,
    defaultMaxCauseDepth,
    1,
    16,
  ),
  maxDataBytes: _clampPositiveInt(
    limits?.maxDataBytes,
    defaultMaxDataBytes,
    256,
    512 * 1024,
  ),
);

int estimateUtf8Bytes(String text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i += 1) {
    final code = text.codeUnitAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

final class TruncationTracker {
  bool truncated = false;
}

String truncateString(
  String value,
  int maxLength, [
  TruncationTracker? tracker,
]) {
  if (value.length <= maxLength) return value;
  tracker?.truncated = true;
  final suffix = '... [truncated ${value.length - maxLength} chars]';
  if (maxLength <= suffix.length) return value.substring(0, maxLength);
  return '${value.substring(0, maxLength - suffix.length)}$suffix';
}

final class _WalkState {
  _WalkState(this.limits);

  int nodes = 0;
  int bytes = 0;
  final TruncationTracker tracker = TruncationTracker();
  final Set<Object> ancestors = HashSet<Object>.identity();
  final ResolvedNormalizationLimits limits;
}

Object? _walkDataValue(Object? value, int depth, _WalkState state) {
  if (value == null || value is bool) {
    state.bytes += 5;
    return value;
  }
  if (value is num) {
    if (!value.isFinite) {
      state.bytes += 10;
      return '$value';
    }
    state.bytes += 12;
    return value;
  }
  if (value is String) {
    final str = truncateString(
      value,
      state.limits.maxStringLength,
      state.tracker,
    );
    final len = estimateUtf8Bytes(str) + 2;
    if (state.bytes + len > state.limits.maxDataBytes) {
      state.tracker.truncated = true;
      final remaining = math.max(0, state.limits.maxDataBytes - state.bytes);
      if (remaining < 16) return '[MaxBytes]';
      final clipped = truncateString(str, remaining, state.tracker);
      state.bytes += estimateUtf8Bytes(clipped) + 2;
      return clipped;
    }
    state.bytes += len;
    return str;
  }
  if (value is BigInt) {
    final str = '${value}n';
    state.bytes += str.length + 2;
    return str;
  }
  if (value is DateTime) {
    final iso = value.toUtc().toIso8601String();
    state.bytes += iso.length + 2;
    return iso;
  }
  if (value is Uint8List) {
    final str = '[Uint8Array(${value.lengthInBytes} bytes)]';
    state.bytes += str.length + 2;
    return str;
  }
  if (value is TypedData) {
    final str = '[${value.runtimeType}(${value.lengthInBytes} bytes)]';
    state.bytes += str.length + 2;
    return str;
  }

  if (state.ancestors.contains(value)) {
    state.bytes += 12;
    return '[Circular]';
  }
  if (state.nodes >= state.limits.maxNodes) {
    state.tracker.truncated = true;
    return '[MaxNodes]';
  }
  if (state.bytes >= state.limits.maxDataBytes) {
    state.tracker.truncated = true;
    return '[MaxBytes]';
  }
  if (depth > state.limits.maxDepth) {
    state.tracker.truncated = true;
    return '[MaxDepth]';
  }

  state.nodes += 1;
  state.ancestors.add(value);
  try {
    if (value is Iterable) {
      final list = value is List ? value : value.toList(growable: false);
      final out = <Object?>[];
      final limit = math.min(list.length, state.limits.maxArrayLength);
      state.bytes += 2;
      for (var i = 0; i < limit; i += 1) {
        if (state.bytes >= state.limits.maxDataBytes ||
            state.nodes >= state.limits.maxNodes) {
          state.tracker.truncated = true;
          out.add('[Truncated]');
          break;
        }
        final item = _walkDataValue(list[i], depth + 1, state);
        out.add(item);
      }
      if (list.length > limit) {
        state.tracker.truncated = true;
        out.add('... [${list.length - limit} more items]');
      }
      return List<Object?>.unmodifiable(out);
    }

    if (value is Map) {
      final out = <String, Object?>{};
      final entries = value.entries.toList(growable: false);
      final limit = math.min(entries.length, state.limits.maxObjectKeys);
      state.bytes += 2;
      for (var i = 0; i < limit; i += 1) {
        if (state.bytes >= state.limits.maxDataBytes ||
            state.nodes >= state.limits.maxNodes) {
          state.tracker.truncated = true;
          out['__truncated__'] = true;
          break;
        }
        final entry = entries[i];
        final rawKey = '${entry.key}';
        if (rawKey == '__proto__' ||
            rawKey == 'constructor' ||
            rawKey == 'prototype') {
          continue;
        }
        final key = truncateString(rawKey, 256, state.tracker);
        state.bytes += estimateUtf8Bytes(key) + 4;
        final child = _walkDataValue(entry.value, depth + 1, state);
        out[key] = child;
      }
      if (entries.length > limit) {
        state.tracker.truncated = true;
        out['__truncatedKeys__'] = entries.length - limit;
      }
      return Map<String, Object?>.unmodifiable(out);
    }

    // Fallback for custom objects: try toJson() if available, else toString()
    try {
      final dynamic dyn = value;
      final Object? jsonVal = dyn.toJson();
      if (!identical(jsonVal, value)) {
        return _walkDataValue(jsonVal, depth + 1, state);
      }
    } catch (_) {}

    final str = truncateString(
      _safeToString(value),
      state.limits.maxStringLength,
      state.tracker,
    );
    state.bytes += estimateUtf8Bytes(str) + 2;
    return str;
  } finally {
    state.ancestors.remove(value);
  }
}

Object? normalizeDiagnosticData(
  Object? value, [
  DiagnosticNormalizationLimits? limits,
]) {
  if (value == null) return null;
  final resolved = resolveNormalizationLimits(limits);
  final state = _WalkState(resolved);
  return _walkDataValue(value, 0, state);
}

NormalizedDiagnosticError normalizeDiagnosticError(
  Object? error, {
  StackTrace? stackTrace,
  DiagnosticNormalizationLimits? limits,
}) {
  final resolved = resolveNormalizationLimits(limits);
  return _normalizeErrorInternal(
    error,
    stackTrace,
    0,
    HashSet<Object>.identity(),
    resolved,
  );
}

NormalizedDiagnosticError _normalizeErrorInternal(
  Object? input,
  StackTrace? explicitStack,
  int causeDepth,
  Set<Object> seenCauses,
  ResolvedNormalizationLimits limits,
) {
  final tracker = TruncationTracker();

  if (input == null) {
    final stackStr = explicitStack == null
        ? null
        : truncateString(
            explicitStack.toString(),
            limits.maxStackLength,
            tracker,
          );
    return NormalizedDiagnosticError(
      name: 'Error',
      message: 'null',
      stack: stackStr != null && stackStr.isNotEmpty ? stackStr : null,
      truncated: tracker.truncated ? true : null,
    );
  }

  if (input is NormalizedDiagnosticError) {
    return input;
  }

  if (input is String) {
    final stackStr = explicitStack == null
        ? null
        : truncateString(
            explicitStack.toString(),
            limits.maxStackLength,
            tracker,
          );
    return NormalizedDiagnosticError(
      name: 'Error',
      message: truncateString(input, limits.maxStringLength, tracker),
      stack: stackStr != null && stackStr.isNotEmpty ? stackStr : null,
      truncated: tracker.truncated ? true : null,
    );
  }

  if (input is num || input is bool) {
    return NormalizedDiagnosticError(
      name: input.runtimeType.toString(),
      message: truncateString('$input', limits.maxStringLength, tracker),
      truncated: tracker.truncated ? true : null,
    );
  }

  if (seenCauses.contains(input)) {
    return const NormalizedDiagnosticError(
      name: 'CircularError',
      message: '[Circular Error Cause]',
      truncated: true,
    );
  }

  seenCauses.add(input);
  try {
    if (input is FlutterErrorDetails) {
      final exception = input.exception;
      final inner = _normalizeErrorInternal(
        exception,
        input.stack ?? explicitStack,
        causeDepth,
        seenCauses,
        limits,
      );
      final detailsMap = <String, Object?>{
        if (input.library != null) 'library': input.library,
        if (input.context != null)
          'context': input.context!.toDescription(),
        'silent': input.silent,
        if (inner.details is Map) ...(inner.details as Map).cast<String, Object?>(),
      };
      final walkState = _WalkState(limits);
      final normalizedDetails = detailsMap.isEmpty
          ? null
          : _walkDataValue(detailsMap, 0, walkState);
      return NormalizedDiagnosticError(
        name: inner.name,
        message: inner.message,
        stack: inner.stack,
        code: inner.code,
        cause: inner.cause,
        details: normalizedDetails,
        truncated:
            (inner.truncated == true ||
                tracker.truncated ||
                walkState.tracker.truncated)
            ? true
            : null,
      );
    }

    if (input is Map) {
      final map = Map<String, Object?>.from(input);
      final rawName = map['name'] ?? map['type'];
      final nameStr = rawName is String && rawName.trim().isNotEmpty
          ? truncateString(rawName.trim(), 256, tracker)
          : 'Error';
      final rawMsg = map['message'];
      final messageStr = rawMsg is String
          ? truncateString(rawMsg, limits.maxStringLength, tracker)
          : truncateString(_safeToString(rawMsg ?? map), limits.maxStringLength, tracker);
      final rawStack = map['stack'] ?? explicitStack?.toString();
      final stackStr = rawStack is String && rawStack.isNotEmpty
          ? truncateString(rawStack, limits.maxStackLength, tracker)
          : null;
      final rawCode = map['code'];
      final Object? codeVal = rawCode is String
          ? truncateString(rawCode, 256, tracker)
          : (rawCode is num && rawCode.isFinite ? rawCode : null);

      NormalizedDiagnosticError? causeVal;
      final rawCause = map['cause'];
      if (rawCause != null) {
        if (causeDepth + 1 >= limits.maxCauseDepth) {
          tracker.truncated = true;
          causeVal = const NormalizedDiagnosticError(
            name: 'MaxCauseDepth',
            message: '[Max cause depth reached]',
            truncated: true,
          );
        } else {
          causeVal = _normalizeErrorInternal(
            rawCause,
            null,
            causeDepth + 1,
            seenCauses,
            limits,
          );
          if (causeVal.truncated == true) tracker.truncated = true;
        }
      }

      final extra = <String, Object?>{};
      for (final entry in map.entries) {
        if (!const <String>{
              'name',
              'type',
              'message',
              'stack',
              'code',
              'cause',
            }.contains(entry.key) &&
            entry.value != null) {
          extra[entry.key] = entry.value;
        }
      }
      Object? detailsVal;
      if (extra.isNotEmpty) {
        final state = _WalkState(limits);
        detailsVal = _walkDataValue(extra, 0, state);
        if (state.tracker.truncated) tracker.truncated = true;
      }

      return NormalizedDiagnosticError(
        name: nameStr,
        message: messageStr,
        stack: stackStr,
        code: codeVal,
        cause: causeVal,
        details: detailsVal,
        truncated: tracker.truncated ? true : null,
      );
    }

    final runtimeTypeStr = input.runtimeType.toString();
    String nameStr = truncateString(runtimeTypeStr, 256, tracker);
    String messageStr = '';
    Object? codeVal;
    Object? rawCause;
    StackTrace? embeddedStack;
    final extraDetails = <String, Object?>{};

    if (input is PlatformException) {
      codeVal = truncateString(input.code, 256, tracker);
      messageStr = truncateString(
        input.message ?? input.toString(),
        limits.maxStringLength,
        tracker,
      );
      if (input.details != null) {
        extraDetails['details'] = input.details;
      }
      if (input.stacktrace != null && input.stacktrace!.isNotEmpty) {
        embeddedStack = StackTrace.fromString(input.stacktrace!);
      }
    } else if (input is FormatException) {
      messageStr = truncateString(
        input.message.isNotEmpty ? input.message : input.toString(),
        limits.maxStringLength,
        tracker,
      );
      if (input.offset != null) extraDetails['offset'] = input.offset;
    } else {
      final dynamic dyn = input;
      try {
        final Object? candidateName = dyn.name;
        if (candidateName is String && candidateName.trim().isNotEmpty) {
          nameStr = truncateString(candidateName.trim(), 256, tracker);
        }
      } catch (_) {}

      try {
        final Object? candidateCode = dyn.code;
        if (candidateCode is String && candidateCode.isNotEmpty) {
          codeVal = truncateString(candidateCode, 256, tracker);
        } else if (candidateCode is num && candidateCode.isFinite) {
          codeVal = candidateCode;
        }
      } catch (_) {}

      try {
        final Object? candidateMsg = dyn.message;
        if (candidateMsg is String && candidateMsg.isNotEmpty) {
          messageStr = truncateString(
            candidateMsg,
            limits.maxStringLength,
            tracker,
          );
        }
      } catch (_) {}

      try {
        rawCause = dyn.cause;
      } catch (_) {}

      try {
        final Object? st = dyn.stackTrace;
        if (st is StackTrace) embeddedStack = st;
      } catch (_) {}
    }

    if (messageStr.isEmpty) {
      messageStr = truncateString(
        _safeToString(input),
        limits.maxStringLength,
        tracker,
      );
    }

    final effectiveStack =
        explicitStack ??
        embeddedStack ??
        (input is Error ? input.stackTrace : null);
    final rawStackStr = effectiveStack?.toString();
    final stackStr = rawStackStr != null && rawStackStr.isNotEmpty
        ? truncateString(rawStackStr, limits.maxStackLength, tracker)
        : null;

    NormalizedDiagnosticError? causeVal;
    if (rawCause != null) {
      if (causeDepth + 1 >= limits.maxCauseDepth) {
        tracker.truncated = true;
        causeVal = const NormalizedDiagnosticError(
          name: 'MaxCauseDepth',
          message: '[Max cause depth reached]',
          truncated: true,
        );
      } else {
        causeVal = _normalizeErrorInternal(
          rawCause,
          null,
          causeDepth + 1,
          seenCauses,
          limits,
        );
        if (causeVal.truncated == true) tracker.truncated = true;
      }
    }

    Object? detailsVal;
    if (extraDetails.isNotEmpty) {
      final state = _WalkState(limits);
      detailsVal = _walkDataValue(extraDetails, 0, state);
      if (state.tracker.truncated) tracker.truncated = true;
    }

    return NormalizedDiagnosticError(
      name: nameStr,
      message: messageStr,
      stack: stackStr,
      code: codeVal,
      cause: causeVal,
      details: detailsVal,
      truncated: tracker.truncated ? true : null,
    );
  } finally {
    seenCauses.remove(input);
  }
}

String _safeToString(Object? value) {
  try {
    return value.toString();
  } catch (error) {
    return '[Thrown in toString: ${error.runtimeType}]';
  }
}

String? normalizeContextString(Object? value, [int maxLength = 256]) {
  if (value is! String) return null;
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;
  return trimmed.length <= maxLength
      ? trimmed
      : trimmed.substring(0, maxLength);
}

Object? normalizeRevision(Object? value) {
  if (value is int) return value;
  if (value is num && value.isFinite) {
    return value == value.truncateToDouble() ? value.toInt() : value;
  }
  if (value is String) {
    final trimmed = value.trim();
    if (trimmed.isNotEmpty) {
      return trimmed.length <= 128 ? trimmed : trimmed.substring(0, 128);
    }
  }
  return null;
}

DiagnosticContext normalizeDiagnosticContext(DiagnosticContext? context) {
  if (context == null) return const DiagnosticContext();
  return DiagnosticContext(
    source: normalizeContextString(context.source),
    projectId: normalizeContextString(context.projectId),
    sessionId: normalizeContextString(context.sessionId),
    runtimeId: normalizeContextString(context.runtimeId),
    revision: normalizeRevision(context.revision),
    extra: context.extra,
  );
}

String normalizeTimestamp(Object? value, DateTime Function() fallbackNow) {
  final candidate = value ?? fallbackNow();
  if (candidate is DateTime) {
    return candidate.toUtc().toIso8601String();
  }
  if (candidate is int) {
    return DateTime.fromMillisecondsSinceEpoch(
      candidate,
      isUtc: true,
    ).toIso8601String();
  }
  if (candidate is num && candidate.isFinite) {
    return DateTime.fromMillisecondsSinceEpoch(
      candidate.toInt(),
      isUtc: true,
    ).toIso8601String();
  }
  if (candidate is String && candidate.trim().isNotEmpty) {
    final parsed = DateTime.tryParse(candidate.trim());
    if (parsed != null) return parsed.toUtc().toIso8601String();
    final trimmed = candidate.trim();
    return trimmed.length <= 64 ? trimmed : trimmed.substring(0, 64);
  }
  return fallbackNow().toUtc().toIso8601String();
}
