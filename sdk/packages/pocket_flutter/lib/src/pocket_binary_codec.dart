import 'dart:convert';
import 'dart:typed_data';

import 'pocket_model.dart';
import 'pocket_offload_runtime.dart';

/// Leading magic byte for binary bridge event/message envelopes (`0xB1`).
const int pocketBinaryMessageMagic = 0xB1;

/// Leading magic byte for binary offload records (`0xB2`).
const int pocketOffloadBinaryMagic = 0xB2;

const int _tagNull = 0x00;
const int _tagFalse = 0x01;
const int _tagTrue = 0x02;
const int _tagInt64 = 0x03;
const int _tagFloat64 = 0x04;
const int _tagString = 0x05;
const int _tagBytes = 0x06;
const int _tagArray = 0x07;
const int _tagObject = 0x08;

const int _maxNestingDepth = 16;
const int _maxDecodeNestingDepth = 128;
const int _defaultMaxMessageBytes = 64 * 1024;
const int _maxCollectionEntries = 100000;

/// Decoded binary offload record from `pocket_offload_take_binary`.
final class PocketBinaryOffloadRecord {
  const PocketBinaryOffloadRecord._({
    required this.key,
    this.request,
    this.validationError,
  });

  final PocketOffloadKey key;
  final PocketOffloadRequest? request;
  final String? validationError;
}

/// Binary TLV codec shared between Dart FFI and the QuickJS native bridge.
///
/// Eliminates intermediate JSON string formatting and parsing across FFI
/// boundaries while supporting raw `Uint8List` <-> `Uint8Array` byte slices.
final class PocketBinaryCodec {
  const PocketBinaryCodec._();

  /// Encodes a Dart message map into a `0xB1`-prefixed binary TLV buffer.
  static Uint8List encodeMessage(
    Map<String, dynamic> message, {
    int maxBytes = _defaultMaxMessageBytes,
  }) {
    final writer = _BinaryTlvWriter(maxBytes: maxBytes);
    writer.writeU8(pocketBinaryMessageMagic);
    writer.writeMap(message, 0);
    return writer.takeBytes();
  }

  /// Decodes a `0xB1`-prefixed binary TLV buffer into a Dart map.
  static Map<String, dynamic> decodeMessage(
    Uint8List bytes, {
    int maxBytes = _defaultMaxMessageBytes,
  }) {
    if (bytes.isEmpty) {
      throw const FormatException('Empty binary bridge message');
    }
    if (bytes.length > maxBytes) {
      throw const FormatException('Binary bridge message exceeds size limit');
    }
    final reader = _BinaryTlvReader(bytes);
    final magic = reader.readU8();
    if (magic != pocketBinaryMessageMagic) {
      throw FormatException(
        'Invalid binary bridge magic: 0x${magic.toRadixString(16)}',
      );
    }
    final root = reader.readValue(0);
    reader.finish();
    if (root is! Map<String, dynamic>) {
      throw const FormatException(
        'Binary bridge message root must be an object',
      );
    }
    return root;
  }

  /// Decodes a binary or legacy UTF-8 JSON event slice from `PFB1` frames.
  static PocketEvent decodeEvent(Uint8List payload) {
    if (payload.isNotEmpty && payload[0] == pocketBinaryMessageMagic) {
      final decoded = decodeMessage(payload);
      return PocketEvent.fromJson(decoded, wireByteLength: payload.length);
    }
    final decoded = jsonDecode(utf8.decode(payload));
    if (decoded is! Map) {
      throw const FormatException('Pocket binary event must be an object');
    }
    return PocketEvent.fromJson(
      Map<String, dynamic>.from(decoded),
      wireByteLength: payload.length,
    );
  }

  /// Decodes a `0xB2`-prefixed binary offload record from native FFI.
  ///
  /// Layout (matches `binary_bridge::encode_offload_request` in Rust):
  /// - `u8` magic (`0xB2`)
  /// - `u32` generation LE
  /// - `u32` session LE
  /// - `u64` id LE
  /// - `u64` timeout_micros LE
  /// - `u32` method_len LE + UTF-8 method bytes
  /// - `u32` payload_len LE + UTF-8 payload bytes
  static PocketBinaryOffloadRecord decodeOffloadRecord(
    Uint8List bytes, {
    bool isCancel = false,
  }) {
    final reader = _BinaryTlvReader(bytes);
    final magic = reader.readU8();
    if (magic != pocketOffloadBinaryMagic) {
      throw FormatException(
        'Invalid binary offload magic: 0x${magic.toRadixString(16)}',
      );
    }
    final generation = reader.readU32();
    final session = reader.readU32();
    final id = reader.readU64();
    final timeoutMicros = reader.readU64();
    final method = reader.readString();
    final payload = reader.readString();
    reader.finish();
    if (generation < 1 ||
        session < 1 ||
        id < 1 ||
        id > 9007199254740991) {
      throw const FormatException('Invalid binary offload key');
    }
    final key = PocketOffloadKey(
      generation: generation,
      session: session,
      id: id,
    );
    if (isCancel) {
      return PocketBinaryOffloadRecord._(key: key);
    }
    try {
      final request = PocketOffloadRequest.fromJson(<String, Object?>{
        'generation': generation,
        'session': session,
        'id': id,
        'method': method,
        'payload': payload,
        'timeoutMicros': timeoutMicros,
      });
      return PocketBinaryOffloadRecord._(
        key: key,
        request: request,
      );
    } on Object catch (error) {
      return PocketBinaryOffloadRecord._(
        key: key,
        validationError: 'invalid offload request: $error',
      );
    }
  }

  /// Encodes a `0xB2`-prefixed binary offload completion record for native FFI.
  ///
  /// Layout (matches `binary_bridge::decode_offload_completion` in Rust):
  /// - `u8` magic (`0xB2`)
  /// - `u32` generation LE
  /// - `u32` session LE
  /// - `u64` id LE
  /// - `u8` status (`1 = Ok(payload)`, `0 = Err(error)`)
  /// - `u32` text_len LE + UTF-8 text bytes
  static Uint8List encodeOffloadCompletion(PocketOffloadCompletion completion) {
    final writer = _BinaryTlvWriter(maxBytes: _defaultMaxMessageBytes);
    final key = completion.key;
    writer.writeU8(pocketOffloadBinaryMagic);
    writer.writeU32(key.generation);
    writer.writeU32(key.session);
    writer.writeU64(key.id);
    if (completion.error != null) {
      final truncatedError = completion.error!.length > 160
          ? completion.error!.substring(0, 160)
          : completion.error!;
      writer.writeU8(0);
      writer.writeString(truncatedError);
    } else {
      writer.writeU8(1);
      writer.writeString(completion.payload ?? 'null');
    }
    return writer.takeBytes();
  }
}

final class _BinaryTlvWriter {
  _BinaryTlvWriter({required this.maxBytes});

  final int maxBytes;
  final BytesBuilder _builder = BytesBuilder(copy: false);
  final Uint8List _scratch = Uint8List(8);
  late final ByteData _scratchData = ByteData.sublistView(_scratch);

  void _checkLimit(int additional) {
    if (_builder.length + additional > maxBytes) {
      throw const FormatException('Binary bridge message exceeds size limit');
    }
  }

  void writeU8(int value) {
    _checkLimit(1);
    _builder.addByte(value & 0xff);
  }

  void writeU32(int value) {
    _checkLimit(4);
    _scratchData.setUint32(0, value, Endian.little);
    _builder.add(Uint8List.fromList(_scratch.sublist(0, 4)));
  }

  void writeU64(int value) {
    _checkLimit(8);
    _scratchData.setUint64(0, value, Endian.little);
    _builder.add(Uint8List.fromList(_scratch));
  }

  void writeI64(int value) {
    _checkLimit(8);
    _scratchData.setInt64(0, value, Endian.little);
    _builder.add(Uint8List.fromList(_scratch));
  }

  void writeF64(double value) {
    if (!value.isFinite) {
      throw const FormatException('Binary bridge float must be finite');
    }
    _checkLimit(8);
    _scratchData.setFloat64(0, value, Endian.little);
    _builder.add(Uint8List.fromList(_scratch));
  }

  void writeBytes(Uint8List bytes) {
    writeU32(bytes.length);
    _checkLimit(bytes.length);
    _builder.add(bytes);
  }

  void writeString(String value) {
    final encoded = utf8.encode(value);
    writeU32(encoded.length);
    _checkLimit(encoded.length);
    _builder.add(encoded);
  }

  void writeValue(Object? value, int depth) {
    if (depth > _maxNestingDepth) {
      throw const FormatException('Binary bridge message nesting is too deep');
    }
    if (value == null) {
      writeU8(_tagNull);
      return;
    }
    if (value is bool) {
      writeU8(value ? _tagTrue : _tagFalse);
      return;
    }
    if (value is int) {
      writeU8(_tagInt64);
      writeI64(value);
      return;
    }
    if (value is double) {
      writeU8(_tagFloat64);
      writeF64(value);
      return;
    }
    if (value is num) {
      writeU8(_tagFloat64);
      writeF64(value.toDouble());
      return;
    }
    if (value is String) {
      writeU8(_tagString);
      writeString(value);
      return;
    }
    if (value is Uint8List) {
      writeU8(_tagBytes);
      writeBytes(value);
      return;
    }
    if (value is Map) {
      writeMap(value, depth);
      return;
    }
    if (value is Iterable) {
      final list = value is List ? value : value.toList(growable: false);
      if (list.length > _maxCollectionEntries) {
        throw const FormatException('Binary bridge array is too large');
      }
      writeU8(_tagArray);
      writeU32(list.length);
      for (final item in list) {
        writeValue(item, depth + 1);
      }
      return;
    }
    throw FormatException(
      'Unsupported binary bridge value type: ${value.runtimeType}',
    );
  }

  void writeMap(Map<Object?, Object?> map, int depth) {
    if (depth > _maxNestingDepth) {
      throw const FormatException('Binary bridge message nesting is too deep');
    }
    if (map.length > _maxCollectionEntries) {
      throw const FormatException('Binary bridge object has too many entries');
    }
    writeU8(_tagObject);
    writeU32(map.length);
    for (final entry in map.entries) {
      final key = entry.key;
      if (key is! String) {
        throw const FormatException('Binary bridge object key must be a String');
      }
      writeString(key);
      writeValue(entry.value, depth + 1);
    }
  }

  Uint8List takeBytes() => _builder.takeBytes();
}

final class _BinaryTlvReader {
  _BinaryTlvReader(this.data) : _byteData = ByteData.sublistView(data);

  final Uint8List data;
  final ByteData _byteData;
  int offset = 0;

  int get remaining => data.length - offset;

  void _require(int length) {
    if (length < 0 || length > remaining) {
      throw const FormatException('Binary bridge payload is truncated');
    }
  }

  int readU8() {
    _require(1);
    return data[offset++];
  }

  int readU32() {
    _require(4);
    final value = _byteData.getUint32(offset, Endian.little);
    offset += 4;
    return value;
  }

  int readU64() {
    _require(8);
    final value = _byteData.getUint64(offset, Endian.little);
    offset += 8;
    return value;
  }

  int readI64() {
    _require(8);
    final value = _byteData.getInt64(offset, Endian.little);
    offset += 8;
    return value;
  }

  double readF64() {
    _require(8);
    final value = _byteData.getFloat64(offset, Endian.little);
    offset += 8;
    if (!value.isFinite) {
      throw const FormatException('Binary bridge float is not finite');
    }
    return value;
  }

  Uint8List readBytesView() {
    final length = readU32();
    _require(length);
    final slice = Uint8List.sublistView(data, offset, offset + length);
    offset += length;
    return slice;
  }

  Uint8List readBytesOwned() => Uint8List.fromList(readBytesView());

  String readString() => utf8.decode(readBytesView());

  Object? readValue(int depth) {
    if (depth > _maxDecodeNestingDepth) {
      throw const FormatException('Binary bridge message nesting is too deep');
    }
    final tag = readU8();
    switch (tag) {
      case _tagNull:
        return null;
      case _tagFalse:
        return false;
      case _tagTrue:
        return true;
      case _tagInt64:
        return readI64();
      case _tagFloat64:
        return readF64();
      case _tagString:
        return readString();
      case _tagBytes:
        return readBytesOwned();
      case _tagArray:
        final count = readU32();
        if (count > _maxCollectionEntries || count > remaining) {
          throw const FormatException('Binary bridge array count is invalid');
        }
        return List<Object?>.generate(
          count,
          (_) => readValue(depth + 1),
          growable: false,
        );
      case _tagObject:
        final count = readU32();
        if (count > _maxCollectionEntries || count > remaining) {
          throw const FormatException('Binary bridge object count is invalid');
        }
        final result = <String, dynamic>{};
        for (var i = 0; i < count; i++) {
          final key = readString();
          result[key] = readValue(depth + 1);
        }
        return result;
      default:
        throw FormatException(
          'Unknown binary bridge value tag: 0x${tag.toRadixString(16)}',
        );
    }
  }

  void finish() {
    if (offset != data.length) {
      throw const FormatException('Binary bridge payload has trailing bytes');
    }
  }
}
