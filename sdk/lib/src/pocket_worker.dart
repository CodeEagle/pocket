import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pocket_flutter/pocket_flutter.dart'
    show PocketWorkerLimits, PocketWorkerProgram;

/// A bytecode artifact whose outer metadata digest and runtime ABI were
/// checked before it can be passed to the native worker runner.
final class PocketWorkerArtifact {
  const PocketWorkerArtifact({
    required this.bytecodePath,
    required this.sha256,
    required this.program,
  });

  final String bytecodePath;
  final String sha256;
  final PocketWorkerProgram program;

  /// Reads the worker descriptor from the main bytecode metadata and validates
  /// the loaded worker envelope against it.
  ///
  /// [admittedCapabilities] must come from the host's verification of the
  /// signed guest manifest; the worker descriptor cannot grant itself
  /// capabilities. [allowedHttpOrigins] is a separate, trusted host grant and
  /// defaults to denying all HTTP.
  factory PocketWorkerArtifact.verify({
    required String appMetadataJson,
    required Uint8List bytecode,
    required String actualRuntimeAbi,
    required int expectedBindingGeneration,
    required int expectedTickHz,
    required Iterable<String> admittedCapabilities,
    Iterable<String> allowedHttpOrigins = const [],
    PocketWorkerLimits limits = const PocketWorkerLimits(),
  }) {
    final decoded = _decodeObject(appMetadataJson, 'app bytecode metadata');
    final worker = _object(decoded['worker'], 'worker descriptor');
    if (worker['kind'] != 'quickjs-bytecode') {
      throw const FormatException('worker kind must be quickjs-bytecode');
    }
    if (_integer(worker['protocolVersion'], 'worker protocolVersion') != 1) {
      throw const FormatException('unsupported worker protocol version');
    }
    final bytecodeDescriptor = _object(worker['bytecode'], 'worker bytecode');
    final path = _safeRelativePath(
      _string(bytecodeDescriptor['path'], 'worker bytecode path'),
    );
    final byteCount = _integer(bytecodeDescriptor['bytes'], 'worker bytecode bytes');
    if (bytecode.isEmpty || bytecode.length != byteCount) {
      throw const FormatException('worker bytecode length does not match metadata');
    }
    if (bytecode.length > 64 * 1024 * 1024) {
      throw const FormatException('worker bytecode exceeds the 64 MiB limit');
    }
    if (bytecode.length < 4 ||
        bytecode[0] != 0x50 ||
        bytecode[1] != 0x4a ||
        bytecode[2] != 0x42 ||
        bytecode[3] != 0x43) {
      throw const FormatException('worker bytecode is not a PocketJS QJBC envelope');
    }
    final expectedHash = _string(
      bytecodeDescriptor['sha256'],
      'worker bytecode sha256',
    ).toLowerCase();
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedHash)) {
      throw const FormatException('worker bytecode sha256 must be 64 hex digits');
    }
    final actualHash = crypto.sha256.convert(bytecode).toString();
    if (actualHash != expectedHash) {
      throw const FormatException('worker bytecode SHA-256 does not match metadata');
    }

    final runtimeAbi = _string(worker['runtimeAbi'], 'worker runtimeAbi');
    if (runtimeAbi != actualRuntimeAbi) {
      throw const FormatException('worker runtime ABI does not match the native host');
    }
    final bindingGeneration = _integer(
      worker['bindingGeneration'],
      'worker bindingGeneration',
    );
    if (bindingGeneration != expectedBindingGeneration) {
      throw const FormatException('worker binding generation does not match the host');
    }
    final tickHz = _integer(worker['tickHz'], 'worker tickHz');
    if (tickHz != expectedTickHz) {
      throw const FormatException('worker tick rate does not match the host');
    }

    final declaration = _object(worker['declaration'], 'worker declaration');
    final declaredCapabilities = _stringList(
      worker['requiredCaps'],
      'worker requiredCaps',
    ).toSet();
    if (!declaredCapabilities.contains('runtime.worker')) {
      throw const FormatException('worker descriptor must require runtime.worker');
    }
    final admitted = admittedCapabilities.toSet();
    final missing = declaredCapabilities.difference(admitted);
    if (missing.isNotEmpty) {
      throw FormatException(
        'worker requires capabilities not admitted by the guest manifest: '
        '${missing.toList()..sort()}',
      );
    }
    _validateDeclarationShape(declaration);
    final expectedCapabilities = <String>{'runtime.worker'};
    for (final rawNode in declaration['nodes'] as List) {
      final node = _object(rawNode, 'worker node');
      expectedCapabilities.add(switch (node['kind']) {
        'http' => 'net.http',
        'i2c' => 'io.i2c',
        'uart' => 'io.uart',
        _ => throw const FormatException('unsupported worker node kind'),
      });
    }
    if (declaredCapabilities.length != expectedCapabilities.length ||
        !declaredCapabilities.containsAll(expectedCapabilities)) {
      throw const FormatException(
        'worker requiredCaps must match runtime.worker and its declared nodes',
      );
    }

    final program = PocketWorkerProgram(
      bytecode: bytecode,
      declaration: declaration,
      expectedRuntimeAbi: runtimeAbi,
      bindingGeneration: bindingGeneration,
      tickHz: tickHz,
      // The exact signed worker requirements are passed natively. The broader
      // admitted set is only an authorization ceiling.
      requiredCapabilities: declaredCapabilities,
      allowedHttpOrigins: allowedHttpOrigins,
      protocolVersion: 1,
      limits: limits,
    );
    return PocketWorkerArtifact(
      bytecodePath: path,
      sha256: expectedHash,
      program: program,
    );
  }
}

Map<String, Object?> _decodeObject(String source, String label) {
  final value = jsonDecode(source);
  return _object(value, label);
}

Map<String, Object?> _object(Object? value, String label) {
  if (value is! Map) throw FormatException('$label must be an object');
  final result = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) throw FormatException('$label keys must be strings');
    result[entry.key as String] = entry.value;
  }
  return result;
}

String _string(Object? value, String label) {
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('$label must be a non-empty string');
  }
  return value;
}

int _integer(Object? value, String label) {
  if (value is! num || !value.isFinite || value % 1 != 0) {
    throw FormatException('$label must be an integer');
  }
  return value.toInt();
}

List<String> _stringList(Object? value, String label) {
  if (value is! List || value.any((item) => item is! String)) {
    throw FormatException('$label must be a string array');
  }
  final result = value.cast<String>();
  if (result.toSet().length != result.length) {
    throw FormatException('$label must not contain duplicates');
  }
  return List<String>.unmodifiable(result);
}

String _safeRelativePath(String path) {
  if (path.isEmpty || path.startsWith('/') || path.contains(r'\')) {
    throw const FormatException('worker bytecode path must be relative');
  }
  final segments = path.split('/');
  if (segments.any((part) => part.isEmpty || part == '.' || part == '..')) {
    throw const FormatException('worker bytecode path is not canonical');
  }
  return path;
}

void _validateDeclarationShape(Map<String, Object?> declaration) {
  if (_string(declaration['entry'], 'worker declaration entry').isEmpty) {
    throw const FormatException('worker entry is required');
  }
  final nodes = declaration['nodes'];
  final channels = declaration['channels'] ?? const [];
  if (nodes is! List || nodes.length > 8) {
    throw const FormatException('worker declaration must contain at most 8 nodes');
  }
  if (channels is! List || channels.length > 8) {
    throw const FormatException(
      'worker declaration must contain at most 8 channels',
    );
  }
  final nodeNames = <String>{};
  for (final raw in nodes) {
    final node = _object(raw, 'worker node');
    final name = _string(node['name'], 'worker node name');
    final kind = _string(node['kind'], 'worker node kind');
    if (!nodeNames.add(name) || !const {'i2c', 'uart', 'http'}.contains(kind)) {
      throw const FormatException('worker node declaration is invalid');
    }
  }
  final channelNames = <String>{};
  for (final raw in channels) {
    final channel = _object(raw, 'worker channel');
    final name = _string(channel['name'], 'worker channel name');
    final kind = _string(channel['kind'], 'worker channel kind');
    final direction = _string(channel['direction'], 'worker channel direction');
    final recordBytes = _integer(channel['recordBytes'], 'channel recordBytes');
    final capacity = _integer(channel['capacity'], 'channel capacity');
    if (!channelNames.add(name) ||
        !const {'snapshot', 'ring'}.contains(kind) ||
        !const {'ui-to-worker', 'worker-to-ui'}.contains(direction) ||
        recordBytes < 1 ||
        recordBytes > 1024 ||
        capacity < 1 ||
        capacity > 8) {
      throw const FormatException('worker channel declaration is invalid');
    }
  }
}
