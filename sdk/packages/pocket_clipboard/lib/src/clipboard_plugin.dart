import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

const String pocketClipboardPluginId = 'flutter.clipboard';

/// Host-granted permission names. Reading is sensitive and is a separate
/// grant from writing.
abstract final class PocketClipboardPermissions {
  static const String read = 'clipboard.read';
  static const String write = 'clipboard.write';
}

abstract final class PocketClipboardCapabilities {
  static const String readText = 'clipboard.readText';
  static const String writeText = 'clipboard.writeText';
  static const String hasText = 'clipboard.hasText';

  static const Set<String> all = <String>{readText, writeText, hasText};
}

/// Largest accepted/returned UTF-8 text payload (192 KiB). It leaves room for
/// JSON escaping and the envelope under the 256 KiB control message.
const int pocketClipboardMaxTextBytes = 192 * 1024;

/// Descriptor response quota. The framework charges `{"text":<json string>}`
/// (9 bytes of object framing plus the JSON-encoded string) against it, and the
/// bridge message cap is 256 KiB including the response envelope, so this is
/// 250 KiB: well above the 192 KiB raw limit plus quotes, with 6 KiB spare.
const int _responseQuotaBytes = 250 * 1024;

/// Reads additionally require the JSON-encoded string to fit the response
/// quota minus the framework's object framing (with margin), because control
/// characters and quotes expand when escaped. Being below the quota, this
/// check always fires first and reports `too_large` instead of the
/// framework's `plugin_payload_quota`.
const int _maxEncodedReadBytes = _responseQuotaBytes - 16;

const PocketPluginSchema _textSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{'text': PocketPluginSchema.string()},
  required: <String>{'text'},
);

const Map<String, PocketPluginCapability> _capabilities =
    <String, PocketPluginCapability>{
      PocketClipboardCapabilities.readText: PocketPluginCapability(
        name: PocketClipboardCapabilities.readText,
        kind: PocketCapabilityKind.request,
        description: 'Reads plain text from the system clipboard',
        permissions: <String>{PocketClipboardPermissions.read},
        schema: PocketPluginCapabilitySchema(
          parameters: PocketPluginSchema.object(),
          result: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'text': PocketPluginSchema.unknown(),
            },
          ),
        ),
      ),
      PocketClipboardCapabilities.writeText: PocketPluginCapability(
        name: PocketClipboardCapabilities.writeText,
        kind: PocketCapabilityKind.request,
        description: 'Writes plain text to the system clipboard',
        permissions: <String>{PocketClipboardPermissions.write},
        schema: PocketPluginCapabilitySchema(
          parameters: _textSchema,
          result: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'ok': PocketPluginSchema.boolean(),
            },
            required: <String>{'ok'},
          ),
        ),
      ),
      PocketClipboardCapabilities.hasText: PocketPluginCapability(
        name: PocketClipboardCapabilities.hasText,
        kind: PocketCapabilityKind.request,
        description: 'Reports whether the clipboard holds text',
        permissions: <String>{PocketClipboardPermissions.read},
        schema: PocketPluginCapabilitySchema(
          parameters: PocketPluginSchema.object(),
          result: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'hasText': PocketPluginSchema.boolean(),
            },
            required: <String>{'hasText'},
          ),
        ),
      ),
    };

/// Text-only system clipboard provider backed by Flutter's [Clipboard].
///
/// No policy lives here beyond bounds: which app may read or write is decided
/// by the host's `allowedPermissions`, the guest manifest and the capability
/// grant. Oversized writes are refused (`too_large`); an oversized clipboard
/// read fails with `too_large` rather than being truncated.
final class PocketClipboardPlugin extends PocketPlugin {
  PocketClipboardPlugin({int maxTextBytes = pocketClipboardMaxTextBytes})
    : maxTextBytes = _boundedLimit(maxTextBytes);

  final int maxTextBytes;

  static int _boundedLimit(int value) {
    if (value <= 0 || value > pocketClipboardMaxTextBytes) {
      throw ArgumentError.value(
        value,
        'maxTextBytes',
        'must be between 1 and $pocketClipboardMaxTextBytes',
      );
    }
    return value;
  }

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketClipboardPluginId,
    version: '0.1.0',
    description: 'Bounded plain-text system clipboard read and write',
    optionalPermissions: <String>{
      PocketClipboardPermissions.read,
      PocketClipboardPermissions.write,
    },
    limits: PocketPluginLimits(
      maxConcurrentRequests: 4,
      maxResponseBytes: _responseQuotaBytes,
    ),
    capabilities: _capabilities,
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(PocketClipboardCapabilities.readText, readText);
    context.registerRequest(PocketClipboardCapabilities.writeText, writeText);
    context.registerRequest(PocketClipboardCapabilities.hasText, hasText);
  }

  Future<Object?> readText(Map<String, dynamic> params) async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null) return <String, dynamic>{'text': null};
    if (utf8.encode(text).length > maxTextBytes ||
        utf8.encode(jsonEncode(text)).length > _maxEncodedReadBytes) {
      throw PocketCapabilityException(
        'too_large',
        'clipboard text exceeds $maxTextBytes bytes',
      );
    }
    return <String, dynamic>{'text': text};
  }

  Future<Object?> writeText(Map<String, dynamic> params) async {
    final text = params['text'];
    if (text is! String) {
      throw const PocketCapabilityException(
        'invalid_params',
        'text must be a string',
      );
    }
    if (utf8.encode(text).length > maxTextBytes) {
      throw PocketCapabilityException(
        'too_large',
        'clipboard text exceeds $maxTextBytes bytes',
      );
    }
    await Clipboard.setData(ClipboardData(text: text));
    return const <String, dynamic>{'ok': true};
  }

  Future<Object?> hasText(Map<String, dynamic> params) async =>
      <String, dynamic>{'hasText': await Clipboard.hasStrings()};
}
