import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'collector.dart';
import 'types.dart';

String _validateFilename(String name) {
  final trimmed = name.trim();
  if (trimmed.isEmpty ||
      trimmed.contains('/') ||
      trimmed.contains('\\') ||
      trimmed == '.' ||
      trimmed == '..' ||
      trimmed.contains('\x00')) {
    throw ArgumentError.value(
      name,
      'filename',
      'Invalid diagnostics journal filename',
    );
  }
  return trimmed;
}

final class _ParsedFileResult {
  const _ParsedFileResult({
    required this.records,
    required this.hadTrailingPartialLine,
    required this.corruptLines,
    required this.validLinesText,
  });

  final List<DiagnosticRecord> records;
  final bool hadTrailingPartialLine;
  final int corruptLines;
  final String validLinesText;
}

_ParsedFileResult _parseJsonlContent(String raw) {
  if (raw.isEmpty) {
    return const _ParsedFileResult(
      records: <DiagnosticRecord>[],
      hadTrailingPartialLine: false,
      corruptLines: 0,
      validLinesText: '',
    );
  }

  final endsWithNewline = raw.endsWith('\n');
  final lines = raw.split(RegExp(r'\r?\n'));
  if (endsWithNewline && lines.isNotEmpty && lines.last.isEmpty) {
    lines.removeLast();
  }

  final records = <DiagnosticRecord>[];
  final validSerialized = <String>[];
  var hadTrailingPartialLine = false;
  var corruptLines = 0;

  for (var i = 0; i < lines.length; i += 1) {
    final line = lines[i].trim();
    if (line.isEmpty) continue;
    final isLastLine = i == lines.length - 1;
    try {
      final Object? parsed = jsonDecode(line);
      final record = DiagnosticRecord.tryFromJson(parsed);
      if (record != null) {
        records.add(record);
        validSerialized.add(jsonEncode(record.toJson()));
      } else {
        if (isLastLine && !endsWithNewline) {
          hadTrailingPartialLine = true;
        } else {
          corruptLines += 1;
        }
      }
    } catch (_) {
      if (isLastLine && !endsWithNewline) {
        hadTrailingPartialLine = true;
      } else {
        corruptLines += 1;
      }
    }
  }

  return _ParsedFileResult(
    records: records,
    hadTrailingPartialLine: hadTrailingPartialLine,
    corruptLines: corruptLines,
    validLinesText: validSerialized.isNotEmpty
        ? '${validSerialized.join('\n')}\n'
        : '',
  );
}

final class FileDiagnosticsStorage implements SynchronousDiagnosticsStorage {
  FileDiagnosticsStorage({
    required Directory directory,
    String filename = defaultJournalFilename,
    int maxFileBytes = defaultMaxFileBytes,
    int maxRotatedFiles = defaultMaxRotatedFiles,
    int maxRecords = defaultMaxRecords,
    this.syncOnLog = false,
  }) : _resolvedDirectory = directory.absolute,
       filename = _validateFilename(filename),
       maxFileBytes = maxFileBytes >= 1024 ? maxFileBytes : defaultMaxFileBytes,
       maxRotatedFiles = math.max(0, math.min(32, maxRotatedFiles)),
       maxRecords = maxRecords >= 1 ? maxRecords : defaultMaxRecords;

  final Directory _resolvedDirectory;
  final String filename;
  final int maxFileBytes;
  final int maxRotatedFiles;
  final int maxRecords;
  final bool syncOnLog;

  bool _initialized = false;
  late String _canonicalDirPath = _resolvedDirectory.path;
  int _recoveredPartialLines = 0;
  int _droppedCorruptLines = 0;
  int _totalWriteCount = 0;
  int _tempSeq = 0;

  Future<void> _opQueue = Future<void>.value();

  @override
  bool get preservesLogHistory => true;

  String get directory => _canonicalDirPath;

  String get journalPath =>
      '$_canonicalDirPath${Platform.pathSeparator}$filename';

  int get recoveredPartialLines => _recoveredPartialLines;

  int get droppedCorruptLines => _droppedCorruptLines;

  String _rotatedPath(int index) =>
      '$_canonicalDirPath${Platform.pathSeparator}$filename.$index';

  Future<T> _serialize<T>(Future<T> Function() fn) {
    final completer = Completer<T>();
    final next = _opQueue.then((_) async {
      try {
        completer.complete(await fn());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    _opQueue = next.catchError((Object _) {});
    return completer.future;
  }

  String _ensureSafeDirectory() {
    final dirType = FileSystemEntity.typeSync(
      _resolvedDirectory.path,
      followLinks: false,
    );
    if (dirType == FileSystemEntityType.link ||
        dirType == FileSystemEntityType.file) {
      throw FileSystemException(
        'Diagnostics directory must be a real directory',
        _resolvedDirectory.path,
      );
    }
    if (dirType == FileSystemEntityType.notFound) {
      _resolvedDirectory.createSync(recursive: true);
    }
    final checkType = FileSystemEntity.typeSync(
      _resolvedDirectory.path,
      followLinks: false,
    );
    if (checkType != FileSystemEntityType.directory) {
      throw FileSystemException(
        'Diagnostics directory must be a real directory',
        _resolvedDirectory.path,
      );
    }
    return _resolvedDirectory.resolveSymbolicLinksSync();
  }

  bool _assertRegularOrMissing(String filePath) {
    final type = FileSystemEntity.typeSync(filePath, followLinks: false);
    if (type == FileSystemEntityType.notFound) return false;
    if (type != FileSystemEntityType.file) {
      throw FileSystemException(
        'Diagnostics journal path is not a regular file',
        filePath,
      );
    }
    return true;
  }

  void _atomicWriteFile(String targetPath, String content) {
    _assertRegularOrMissing(targetPath);
    final tempName =
        '.diag-${DateTime.now().microsecondsSinceEpoch}-${++_tempSeq}.tmp';
    final tempPath = '$_canonicalDirPath${Platform.pathSeparator}$tempName';
    final tempFile = File(tempPath);
    RandomAccessFile? raf;
    try {
      raf = tempFile.openSync(mode: FileMode.writeOnly);
      raf.writeStringSync(content);
      raf.flushSync();
    } catch (error) {
      try {
        raf?.closeSync();
      } catch (_) {}
      try {
        if (tempFile.existsSync()) tempFile.deleteSync();
      } catch (_) {}
      rethrow;
    }
    raf.closeSync();
    try {
      _assertRegularOrMissing(targetPath);
      tempFile.renameSync(targetPath);
    } catch (error) {
      try {
        if (tempFile.existsSync()) tempFile.deleteSync();
      } catch (_) {}
      rethrow;
    }
  }

  void _cleanupTempFiles(String dirPath) {
    try {
      final dir = Directory(dirPath);
      for (final entity in dir.listSync(followLinks: false)) {
        final name = entity.uri.pathSegments.isEmpty
            ? ''
            : entity.uri.pathSegments.last;
        if (name.startsWith('.diag-') && name.endsWith('.tmp')) {
          try {
            entity.deleteSync();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  void _initIfNeeded() {
    if (_initialized) return;
    _canonicalDirPath = _ensureSafeDirectory();
    _cleanupTempFiles(_canonicalDirPath);

    final activePath = journalPath;
    if (_assertRegularOrMissing(activePath)) {
      final raw = File(activePath).readAsStringSync();
      final parsed = _parseJsonlContent(raw);
      if (parsed.hadTrailingPartialLine) {
        _recoveredPartialLines += 1;
      }
      if (parsed.corruptLines > 0) {
        _droppedCorruptLines += parsed.corruptLines;
      }
      if (parsed.hadTrailingPartialLine || parsed.corruptLines > 0) {
        _atomicWriteFile(activePath, parsed.validLinesText);
      }
    }
    _initialized = true;
  }

  List<String> _getSegmentPathsOldestFirst() => <String>[
    for (var i = maxRotatedFiles; i >= 1; i -= 1) _rotatedPath(i),
    journalPath,
  ];

  List<DiagnosticRecord> _readAllInternal() {
    _initIfNeeded();
    final paths = _getSegmentPathsOldestFirst();
    final allRecords = <DiagnosticRecord>[];

    for (final segPath in paths) {
      if (!_assertRegularOrMissing(segPath)) continue;
      final raw = File(segPath).readAsStringSync();
      final parsed = _parseJsonlContent(raw);
      if (parsed.hadTrailingPartialLine) {
        _recoveredPartialLines += 1;
      }
      if (parsed.corruptLines > 0) {
        _droppedCorruptLines += parsed.corruptLines;
      }
      if (segPath == journalPath &&
          (parsed.hadTrailingPartialLine || parsed.corruptLines > 0)) {
        _atomicWriteFile(segPath, parsed.validLinesText);
      }
      allRecords.addAll(parsed.records);
    }

    if (allRecords.length > maxRecords) {
      return List<DiagnosticRecord>.unmodifiable(
        allRecords.sublist(allRecords.length - maxRecords),
      );
    }
    return List<DiagnosticRecord>.unmodifiable(allRecords);
  }

  void _rotateSegments() {
    final activePath = journalPath;
    if (maxRotatedFiles <= 0) {
      if (!_assertRegularOrMissing(activePath)) return;
      final raw = File(activePath).readAsStringSync();
      final parsed = _parseJsonlContent(raw);
      final keepCount = math.max(
        1,
        math.min(maxRecords ~/ 2, parsed.records.length ~/ 2),
      );
      final kept = parsed.records.length > keepCount
          ? parsed.records.sublist(parsed.records.length - keepCount)
          : parsed.records;
      final content = kept.isNotEmpty
          ? '${kept.map((r) => jsonEncode(r.toJson())).join('\n')}\n'
          : '';
      _atomicWriteFile(activePath, content);
      return;
    }

    final oldestRotated = _rotatedPath(maxRotatedFiles);
    if (_assertRegularOrMissing(oldestRotated)) {
      File(oldestRotated).deleteSync();
    }

    for (var i = maxRotatedFiles - 1; i >= 1; i -= 1) {
      final src = _rotatedPath(i);
      final dst = _rotatedPath(i + 1);
      if (_assertRegularOrMissing(src)) {
        File(src).renameSync(dst);
      }
    }

    if (_assertRegularOrMissing(activePath)) {
      File(activePath).renameSync(_rotatedPath(1));
    }
  }

  void _compactToRecords(List<DiagnosticRecord> records) {
    final bounded = records.length > maxRecords
        ? records.sublist(records.length - maxRecords)
        : records;
    for (var i = 1; i <= maxRotatedFiles; i += 1) {
      final p = _rotatedPath(i);
      if (_assertRegularOrMissing(p)) {
        File(p).deleteSync();
      }
    }
    final activePath = journalPath;
    if (bounded.isEmpty) {
      if (_assertRegularOrMissing(activePath)) {
        File(activePath).deleteSync();
      }
      return;
    }

    final chunks = <List<String>>[<String>[]];
    var currentBytes = 0;
    for (final rec in bounded) {
      final line = jsonEncode(rec.toJson());
      final lineBytes = utf8.encode(line).length + 1;
      if (chunks.last.isNotEmpty && currentBytes + lineBytes > maxFileBytes) {
        chunks.add(<String>[]);
        currentBytes = 0;
      }
      chunks.last.add(line);
      currentBytes += lineBytes;
    }

    final maxTotalSegments = maxRotatedFiles + 1;
    final retainedChunks = chunks.length > maxTotalSegments
        ? chunks.sublist(chunks.length - maxTotalSegments)
        : chunks;
    final activeLines = retainedChunks.removeLast();
    _atomicWriteFile(
      activePath,
      activeLines.isNotEmpty ? '${activeLines.join('\n')}\n' : '',
    );

    for (var i = 0; i < retainedChunks.length; i += 1) {
      final chunk = retainedChunks[retainedChunks.length - 1 - i];
      final rotPath = _rotatedPath(i + 1);
      _atomicWriteFile(rotPath, '${chunk.join('\n')}\n');
    }
  }

  @override
  Future<void> append(
    DiagnosticRecord record, {
    DiagnosticsStorageAppendOptions options =
        const DiagnosticsStorageAppendOptions(),
  }) => _serialize(() async => appendSync(record, options: options));

  @override
  void appendSync(
    DiagnosticRecord record, {
    DiagnosticsStorageAppendOptions options =
        const DiagnosticsStorageAppendOptions(),
  }) {
    _initIfNeeded();
    final activePath = journalPath;
    final line = '${jsonEncode(record.toJson())}\n';
    final lineBytes = utf8.encode(line);

    if (_assertRegularOrMissing(activePath)) {
      final currentLength = File(activePath).lengthSync();
      if (currentLength > 0 &&
          currentLength + lineBytes.length > maxFileBytes) {
        _rotateSegments();
      }
    }

    final file = File(activePath);
    final raf = file.openSync(mode: FileMode.writeOnlyAppend);
    try {
      raf.writeFromSync(lineBytes);
      if (options.sync ||
          record.kind == DiagnosticRecordKind.crash ||
          syncOnLog) {
        raf.flushSync();
      }
    } finally {
      raf.closeSync();
    }

    _totalWriteCount += 1;
    if (_totalWriteCount >= maxRecords) {
      _totalWriteCount = 0;
      final all = _readAllInternal();
      if (all.length >= maxRecords) {
        _compactToRecords(all);
      }
    }
  }

  @override
  Future<List<DiagnosticRecord>> readAll() =>
      _serialize(() async => _readAllInternal());

  @override
  Future<int> clear([DiagnosticClearFilter? filter]) => _serialize(() async {
    _initIfNeeded();
    final all = _readAllInternal();
    if (filter == null) {
      _compactToRecords(const <DiagnosticRecord>[]);
      return all.length;
    }
    final kept = <DiagnosticRecord>[
      for (final rec in all)
        if (!matchesClearFilter(rec, filter)) rec,
    ];
    final removed = all.length - kept.length;
    if (removed > 0) {
      _compactToRecords(kept);
    }
    return removed;
  });

  @override
  Future<void> flush() => _serialize(() async {
    _initIfNeeded();
    final activePath = journalPath;
    if (!_assertRegularOrMissing(activePath)) return;
    final raf = File(activePath).openSync(mode: FileMode.writeOnlyAppend);
    try {
      raf.flushSync();
    } finally {
      raf.closeSync();
    }
  });

  @override
  Future<void> close() => _serialize(() async {
    if (!_initialized) return;
    final activePath = journalPath;
    if (!_assertRegularOrMissing(activePath)) return;
    final raf = File(activePath).openSync(mode: FileMode.writeOnlyAppend);
    try {
      raf.flushSync();
    } finally {
      raf.closeSync();
    }
  });
}

final class FileDiagnosticsCollector extends DiagnosticsCollector {
  FileDiagnosticsCollector({
    required Directory directory,
    String filename = defaultJournalFilename,
    int maxFileBytes = defaultMaxFileBytes,
    int maxRotatedFiles = defaultMaxRotatedFiles,
    int maxRecords = defaultMaxRecords,
    bool syncOnLog = false,
    DiagnosticContext? context,
    int recentLogLimit = defaultRecentLogLimit,
    RecentLogCaptureMode recentLogMode = RecentLogCaptureMode.auto,
    DiagnosticNormalizationLimits? normalization,
    DateTime Function()? now,
    String Function()? idGenerator,
  }) : this._(
         fileStorage: FileDiagnosticsStorage(
           directory: directory,
           filename: filename,
           maxFileBytes: maxFileBytes,
           maxRotatedFiles: maxRotatedFiles,
           maxRecords: maxRecords,
           syncOnLog: syncOnLog,
         ),
         context: context,
         maxRecords: maxRecords,
         recentLogLimit: recentLogLimit,
         recentLogMode: recentLogMode,
         normalization: normalization,
         now: now,
         idGenerator: idGenerator,
       );

  FileDiagnosticsCollector._({
    required this.fileStorage,
    super.context,
    super.maxRecords = defaultMaxRecords,
    super.recentLogLimit = defaultRecentLogLimit,
    super.recentLogMode = RecentLogCaptureMode.auto,
    super.normalization,
    super.now,
    super.idGenerator,
  }) : super(storage: fileStorage);

  final FileDiagnosticsStorage fileStorage;

  @override
  FileDiagnosticsStorage get storage => fileStorage;

  DiagnosticsCollector get collector => this;
  String get directory => fileStorage.directory;
  String get journalPath => fileStorage.journalPath;
}

FileDiagnosticsStorage createFileDiagnosticsStorage({
  required Directory directory,
  String filename = defaultJournalFilename,
  int maxFileBytes = defaultMaxFileBytes,
  int maxRotatedFiles = defaultMaxRotatedFiles,
  int maxRecords = defaultMaxRecords,
  bool syncOnLog = false,
}) => FileDiagnosticsStorage(
  directory: directory,
  filename: filename,
  maxFileBytes: maxFileBytes,
  maxRotatedFiles: maxRotatedFiles,
  maxRecords: maxRecords,
  syncOnLog: syncOnLog,
);

FileDiagnosticsCollector createFileDiagnostics({
  required Directory directory,
  String filename = defaultJournalFilename,
  int maxFileBytes = defaultMaxFileBytes,
  int maxRotatedFiles = defaultMaxRotatedFiles,
  int maxRecords = defaultMaxRecords,
  bool syncOnLog = false,
  DiagnosticContext? context,
  int recentLogLimit = defaultRecentLogLimit,
  RecentLogCaptureMode recentLogMode = RecentLogCaptureMode.auto,
  DiagnosticNormalizationLimits? normalization,
  DateTime Function()? now,
  String Function()? idGenerator,
}) => FileDiagnosticsCollector(
  directory: directory,
  filename: filename,
  maxFileBytes: maxFileBytes,
  maxRotatedFiles: maxRotatedFiles,
  maxRecords: maxRecords,
  syncOnLog: syncOnLog,
  context: context,
  recentLogLimit: recentLogLimit,
  recentLogMode: recentLogMode,
  normalization: normalization,
  now: now,
  idGenerator: idGenerator,
);
