import 'dart:async';
import 'dart:ui' show ErrorCallback;

import 'package:flutter/foundation.dart'
    show
        FlutterError,
        FlutterErrorDetails,
        FlutterExceptionHandler,
        PlatformDispatcher;

import 'collector.dart';
import 'types.dart';

abstract interface class FlutterErrorCollectorHandle {
  bool get active;
  void detach();
}

final class FlutterErrorCollector {
  FlutterErrorCollector._();

  static FlutterErrorCollectorHandle attach({
    required DiagnosticsCollector collector,
    DiagnosticContext? context,
    DiagnosticContext Function()? contextProvider,
    bool captureFlutterErrors = true,
    bool capturePlatformDispatcherErrors = true,
    void Function(DiagnosticCrashRecord record)? onCrashRecorded,
    PlatformDispatcher? platformDispatcher,
  }) {
    final dispatcher = platformDispatcher ?? PlatformDispatcher.instance;
    final previousFlutterOnError = FlutterError.onError;
    final previousDispatcherOnError = dispatcher.onError;
    var active = true;

    DiagnosticContext resolveContext() {
      if (contextProvider != null) {
        try {
          return contextProvider();
        } catch (_) {}
      }
      return context ?? const DiagnosticContext();
    }

    void capture(Object error, DiagnosticCrashInput input) {
      try {
        final immediate = collector.tryRecordCrashSync(error, input);
        if (immediate != null) {
          onCrashRecorded?.call(immediate);
          return;
        }
        unawaited(
          collector
              .recordCrash(error, input)
              .then((record) {
                onCrashRecorded?.call(record);
              })
              .catchError((Object _) {}),
        );
      } catch (_) {
        // A storage failure must still hand the original error to its handler.
      }
    }

    late final FlutterExceptionHandler wrappedFlutterOnError;
    wrappedFlutterOnError = (FlutterErrorDetails details) {
      if (active && !collector.closed) {
        final ctx = resolveContext();
        final data = <String, Object?>{
          if (details.library != null) 'library': details.library,
          if (details.context != null)
            'flutterContext': details.context!.toDescription(),
          'silent': details.silent,
        };
        capture(
          details.exception,
          DiagnosticCrashInput(
            stackTrace: details.stack,
            source: ctx.source ?? 'flutter.error',
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            runtimeId: ctx.runtimeId,
            revision: ctx.revision,
            context: ctx,
            tag: 'FlutterError.onError',
            severity: details.silent
                ? DiagnosticSeverity.error
                : DiagnosticSeverity.fatal,
            unhandled: !details.silent,
            message: details.exceptionAsString(),
            data: data,
          ),
        );
      }

      if (previousFlutterOnError != null) {
        previousFlutterOnError(details);
      } else {
        FlutterError.presentError(details);
      }
    };

    late final ErrorCallback wrappedDispatcherOnError;
    wrappedDispatcherOnError = (Object error, StackTrace stack) {
      if (active && !collector.closed) {
        final ctx = resolveContext();
        capture(
          error,
          DiagnosticCrashInput(
            stackTrace: stack,
            source: ctx.source ?? 'flutter.platform_dispatcher',
            projectId: ctx.projectId,
            sessionId: ctx.sessionId,
            runtimeId: ctx.runtimeId,
            revision: ctx.revision,
            context: ctx,
            tag: 'PlatformDispatcher.onError',
            severity: DiagnosticSeverity.fatal,
            unhandled: true,
          ),
        );
      }

      // Preserve existing return semantics without swallowing unhandled errors.
      if (previousDispatcherOnError != null) {
        return previousDispatcherOnError(error, stack);
      }
      return false;
    };

    if (captureFlutterErrors) {
      FlutterError.onError = wrappedFlutterOnError;
    }
    if (capturePlatformDispatcherErrors) {
      dispatcher.onError = wrappedDispatcherOnError;
    }

    return _FlutterErrorCollectorHandleImpl(
      isActive: () => active,
      onDetach: () {
        if (!active) return;
        active = false;
        if (captureFlutterErrors &&
            identical(FlutterError.onError, wrappedFlutterOnError)) {
          FlutterError.onError = previousFlutterOnError;
        }
        if (capturePlatformDispatcherErrors &&
            identical(dispatcher.onError, wrappedDispatcherOnError)) {
          dispatcher.onError = previousDispatcherOnError;
        }
      },
    );
  }
}

final class _FlutterErrorCollectorHandleImpl
    implements FlutterErrorCollectorHandle {
  _FlutterErrorCollectorHandleImpl({
    required bool Function() isActive,
    required void Function() onDetach,
  }) : _isActive = isActive,
       _onDetach = onDetach;

  final bool Function() _isActive;
  final void Function() _onDetach;

  @override
  bool get active => _isActive();

  @override
  void detach() => _onDetach();
}

FlutterErrorCollectorHandle attachFlutterErrorCollector({
  required DiagnosticsCollector collector,
  DiagnosticContext? context,
  DiagnosticContext Function()? contextProvider,
  bool captureFlutterErrors = true,
  bool capturePlatformDispatcherErrors = true,
  void Function(DiagnosticCrashRecord record)? onCrashRecorded,
  PlatformDispatcher? platformDispatcher,
}) => FlutterErrorCollector.attach(
  collector: collector,
  context: context,
  contextProvider: contextProvider,
  captureFlutterErrors: captureFlutterErrors,
  capturePlatformDispatcherErrors: capturePlatformDispatcherErrors,
  onCrashRecorded: onCrashRecorded,
  platformDispatcher: platformDispatcher,
);
