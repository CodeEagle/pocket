import 'dart:typed_data';
import 'dart:ui' as ui;

import 'pocket_model.dart';

/// A decoded PocketJS IMG entry. PocketJS stores packed pixels in the PAK so
/// native can upload them without a PNG/JPEG decoder; Flutter needs RGBA for
/// `CustomPainter`, so the small format conversion lives at this boundary.
final class PocketPakImage {
  const PocketPakImage({
    required this.width,
    required this.height,
    required this.rgba,
  });

  final int width;
  final int height;
  final Uint8List rgba;

  Future<ui.Image> decode() async {
    // Flutter's rgba8888 descriptor is premultiplied-alpha. PocketJS PAK
    // pixels are straight RGBA because the native texture path samples them
    // directly; feeding those bytes to Skia leaves transparent white RGB in
    // the texture (visible as white fringes around antialiased masks).
    // Keep [rgba] in the source format for the native contract and make one
    // premultiplied copy only at the Flutter image boundary.
    return _decodePremultipliedRgba(width, height, _premultiplyRgba(rgba));
  }
}

Uint8List _premultiplyRgba(Uint8List source) {
  final result = Uint8List.fromList(source);
  _premultiplyRgbaInPlace(result);
  return result;
}

void _premultiplyRgbaInPlace(Uint8List rgba) {
  for (var offset = 0; offset + 3 < rgba.length; offset += 4) {
    final alpha = rgba[offset + 3];
    if (alpha == 255) continue;
    rgba[offset] = (rgba[offset] * alpha + 127) ~/ 255;
    rgba[offset + 1] = (rgba[offset + 1] * alpha + 127) ~/ 255;
    rgba[offset + 2] = (rgba[offset + 2] * alpha + 127) ~/ 255;
  }
}

Future<ui.Image> _decodePremultipliedRgba(
  int width,
  int height,
  Uint8List rgba,
) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(rgba);
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  try {
    descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: width,
      height: height,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    codec = await descriptor.instantiateCodec();
    final frame = await codec.getNextFrame();
    return frame.image;
  } finally {
    codec?.dispose();
    descriptor?.dispose();
    buffer.dispose();
  }
}

/// Reads only `ui:img.*` records from a PocketJS PAK. Invalid or unrelated
/// records are ignored here; native remains the authority for package
/// admission and will report malformed packages through the FFI error path.
final class PocketPakImages {
  const PocketPakImages._();

  /// Decodes a frame resource without retaining an intermediate straight-RGBA
  /// image. The new conversion buffer is exclusively owned here, so it can be
  /// premultiplied in place. The resource's pixels and palette stay unchanged.
  /// Unsupported or truncated resources return null, as [fromResource] does.
  static Future<ui.Image>? decodeResource(PocketImageResource resource) {
    final image = fromResource(resource);
    if (image == null) return null;
    _premultiplyRgbaInPlace(image.rgba);
    return _decodePremultipliedRgba(image.width, image.height, image.rgba);
  }

  /// Converts the native texture-table representation emitted in a frame
  /// resource into the RGBA form consumed by Flutter's image decoder. Native
  /// has already removed IMG PackBits compression before this boundary.
  static PocketPakImage? fromResource(PocketImageResource resource) {
    if (resource.width <= 0 || resource.height <= 0) return null;
    final expected = resource.width * resource.height;
    final source = resource.pixels;
    final rgba = Uint8List(expected * 4);
    switch (resource.psm) {
      case 0:
        if (source.length < expected * 2) return null;
        _decode5650(Uint8List.sublistView(source, 0, expected * 2), rgba);
      case 2:
        if (source.length < expected * 2) return null;
        _decode4444(Uint8List.sublistView(source, 0, expected * 2), rgba);
      case 3:
        if (source.length < expected * 4) return null;
        rgba.setRange(0, expected * 4, source);
      case 5:
        final palette = resource.palette;
        if (palette == null ||
            palette.length < 1024 ||
            source.length < expected) {
          return null;
        }
        _decodeT8(palette, Uint8List.sublistView(source, 0, expected), rgba);
      default:
        return null;
    }
    return PocketPakImage(
      width: resource.width,
      height: resource.height,
      rgba: rgba,
    );
  }

  static Map<String, PocketPakImage> extract(Uint8List pak) {
    if (pak.length < _pakHeaderSize || _u32(pak, 0) != _pakMagic) {
      return const <String, PocketPakImage>{};
    }
    if (_u16(pak, 4) != _pakVersion) {
      return const <String, PocketPakImage>{};
    }
    final count = _u32(pak, 8);
    final directory = _u32(pak, 12);
    final names = _u32(pak, 16);
    final directoryEnd = directory + count * _pakEntrySize;
    if (directory > pak.length ||
        directoryEnd > pak.length ||
        names > pak.length) {
      return const <String, PocketPakImage>{};
    }

    final result = <String, PocketPakImage>{};
    for (var index = 0; index < count; index++) {
      final entry = directory + index * _pakEntrySize;
      final blobOffset = _u32(pak, entry + 4);
      final blobLength = _u32(pak, entry + 8);
      final nameOffset = _u32(pak, entry + 12);
      final nameLength = _u16(pak, entry + 16);
      final nameStart = names + nameOffset;
      final nameEnd = nameStart + nameLength;
      final blobEnd = blobOffset + blobLength;
      if (nameStart > pak.length ||
          nameEnd > pak.length ||
          blobOffset > pak.length ||
          blobEnd > pak.length) {
        continue;
      }
      final name = String.fromCharCodes(
        Uint8List.sublistView(pak, nameStart, nameEnd),
      );
      if (!name.startsWith('ui:img.')) continue;
      final image = _decodeEntry(
        Uint8List.sublistView(pak, blobOffset, blobEnd),
      );
      if (image == null) continue;
      final key = name.substring('ui:img.'.length);
      result[key] = image;
      // Keep both forms available because hosts may report either the
      // logical registry name or the original PAK key in a frame op.
      result[name] = image;
    }
    return result;
  }

  static PocketPakImage? _decodeEntry(Uint8List blob) {
    if (blob.length < 8) return null;
    final width = _u16(blob, 0);
    final height = _u16(blob, 2);
    final psm = blob[4];
    final flags = blob[5];
    if (width <= 0 || height <= 0) return null;

    final bytesPerPixel = switch (psm) {
      0 || 2 => 2, // PSM_5650 / PSM_4444
      3 => 4, // PSM_8888
      5 => 1, // PSM_T8
      _ => 0,
    };
    if (bytesPerPixel == 0) return null;
    final paletteBytes = psm == 5 ? 1024 : 0;
    if (blob.length < 8 + paletteBytes) return null;
    final expected = width * height * bytesPerPixel;
    final encoded = Uint8List.sublistView(blob, 8 + paletteBytes);
    final pixels = flags & 1 == 0
        ? (encoded.length < expected
              ? null
              : Uint8List.sublistView(encoded, 0, expected))
        : _decodePackBits(encoded, expected);
    if (pixels == null) return null;

    final rgba = Uint8List(width * height * 4);
    switch (psm) {
      case 3:
        rgba.setAll(0, pixels);
      case 0:
        _decode5650(pixels, rgba);
      case 2:
        _decode4444(pixels, rgba);
      case 5:
        _decodeT8(Uint8List.sublistView(blob, 8, 8 + 1024), pixels, rgba);
    }
    return PocketPakImage(width: width, height: height, rgba: rgba);
  }

  static Uint8List? _decodePackBits(Uint8List source, int expected) {
    final output = Uint8List(expected);
    var input = 0;
    var out = 0;
    while (input < source.length) {
      final control = source[input++];
      if (control < 128) {
        final length = control + 1;
        if (input + length > source.length || out + length > expected) {
          return null;
        }
        output.setRange(out, out + length, source, input);
        input += length;
        out += length;
      } else {
        final length = control - 126;
        if (input >= source.length || out + length > expected) return null;
        output.fillRange(out, out + length, source[input++]);
        out += length;
      }
    }
    return out == expected ? output : null;
  }

  static void _decode5650(Uint8List source, Uint8List rgba) {
    for (var i = 0; i < source.length; i += 2) {
      final value = source[i] | source[i + 1] << 8;
      final pixel = i ~/ 2 * 4;
      final r = value & 0x1f;
      final g = (value >> 5) & 0x3f;
      final b = (value >> 11) & 0x1f;
      rgba[pixel] = (r << 3) | (r >> 2);
      rgba[pixel + 1] = (g << 2) | (g >> 4);
      rgba[pixel + 2] = (b << 3) | (b >> 2);
      rgba[pixel + 3] = 0xff;
    }
  }

  static void _decode4444(Uint8List source, Uint8List rgba) {
    for (var i = 0; i < source.length; i += 2) {
      final value = source[i] | source[i + 1] << 8;
      final pixel = i ~/ 2 * 4;
      rgba[pixel] = (value & 0x0f) * 17;
      rgba[pixel + 1] = ((value >> 4) & 0x0f) * 17;
      rgba[pixel + 2] = ((value >> 8) & 0x0f) * 17;
      rgba[pixel + 3] = ((value >> 12) & 0x0f) * 17;
    }
  }

  static void _decodeT8(Uint8List palette, Uint8List indices, Uint8List rgba) {
    for (var i = 0; i < indices.length; i++) {
      final source = indices[i] * 4;
      final target = i * 4;
      // The PAK palette is an ABGR u32 in little-endian memory, whose byte
      // order is already RGBA for Flutter's decoder.
      rgba[target] = palette[source];
      rgba[target + 1] = palette[source + 1];
      rgba[target + 2] = palette[source + 2];
      rgba[target + 3] = palette[source + 3];
    }
  }

  static int _u16(Uint8List bytes, int offset) =>
      bytes[offset] | bytes[offset + 1] << 8;

  static int _u32(Uint8List bytes, int offset) =>
      bytes[offset] |
      bytes[offset + 1] << 8 |
      bytes[offset + 2] << 16 |
      bytes[offset + 3] << 24;
}

const _pakMagic = 0x4b504344; // 'DCPK' little-endian
const _pakVersion = 1;
const _pakHeaderSize = 32;
const _pakEntrySize = 24;
