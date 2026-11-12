import 'dart:collection' show LinkedHashMap;
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui show FontFeature;

import 'package:flutter/painting.dart';

import 'pocket_runtime.dart';

/// Active PocketJS font slots (`0..20`).
const int pocketHostFontSlotCount = 21;

/// First printable ASCII scalar warmed into the host advance table.
const int pocketHostAsciiStart = 0x20;

/// Printable ASCII count (`0x20..=0x7E`).
const int pocketHostAsciiCount = 95;

/// Canonical logical pixel size per PocketJS font slot (`0..20`).
const List<double> pocketFontSlotSizes = <double>[
  12,
  14,
  16,
  18,
  20,
  24,
  36,
  12,
  14,
  16,
  18,
  20,
  24,
  36,
  54,
  54,
  12,
  14,
  16,
  10,
  10,
];

/// Disables ligatures and kerning so PocketJS's additive per-scalar layout
/// advances match whole-run `TextPainter` widths 1:1.
const List<ui.FontFeature> pocketAdditiveFontFeatures = <ui.FontFeature>[
  ui.FontFeature.disable('liga'),
  ui.FontFeature.disable('clig'),
  ui.FontFeature.disable('dlig'),
  ui.FontFeature.disable('kern'),
];

const List<String> _defaultMonoFallback = <String>[
  'Menlo',
  'Consolas',
  'Roboto Mono',
  'Courier New',
];

bool pocketIsMonoSlot(int? slot) => slot != null && slot >= 16 && slot <= 18;

double pocketFontSizeForSlot(int? slot) {
  if (slot != null && slot >= 0 && slot < pocketFontSlotSizes.length) {
    return pocketFontSlotSizes[slot];
  }
  return 16.0;
}

FontWeight? pocketFontWeightForSlot(int? slot) {
  if (slot == 7 ||
      slot == 8 ||
      slot == 9 ||
      slot == 10 ||
      slot == 11 ||
      slot == 12 ||
      slot == 13 ||
      slot == 15 ||
      slot == 20) {
    return FontWeight.w700;
  }
  return null;
}

/// Constructs the canonical host [TextStyle] shared by both FFI metric
/// pre-warming/lazy measurement and [PocketCanvasPainter] rendering.
TextStyle pocketTextStyleForSlot({
  required int? slot,
  required double fontSize,
  Color? color,
  List<String> fontFamilyFallback = const <String>[],
  double? height,
  double letterSpacing = 0.0,
}) {
  final isMono = pocketIsMonoSlot(slot);
  final List<String>? effectiveFallback;
  if (isMono) {
    effectiveFallback = fontFamilyFallback.isEmpty
        ? _defaultMonoFallback
        : <String>[..._defaultMonoFallback, ...fontFamilyFallback];
  } else {
    effectiveFallback = fontFamilyFallback.isEmpty ? null : fontFamilyFallback;
  }
  return TextStyle(
    color: color,
    fontSize: fontSize,
    fontFamily: isMono ? 'monospace' : null,
    fontFamilyFallback: effectiveFallback,
    fontWeight: pocketFontWeightForSlot(slot),
    height: height,
    letterSpacing: letterSpacing == 0.0 ? null : letterSpacing,
    fontFeatures: pocketAdditiveFontFeatures,
  );
}

/// Measures a single Unicode scalar's unscaled advance width in logical pixels
/// for [slot]. Returns `-1.0` for invalid slots or surrogate code points.
double measurePocketHostScalarAdvance(
  int slot,
  int codepoint, {
  List<String> fontFamilyFallback = const <String>[],
}) {
  if (slot < 0 || slot >= pocketHostFontSlotCount) return -1.0;
  if (codepoint < 0 ||
      codepoint > 0x10ffff ||
      (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
    return -1.0;
  }
  if (codepoint < 0x20 || codepoint == 0x7f) return 0.0;
  final style = pocketTextStyleForSlot(
    slot: slot,
    fontSize: pocketFontSizeForSlot(slot),
    fontFamilyFallback: fontFamilyFallback,
  );
  final painter = TextPainter(
    text: TextSpan(text: String.fromCharCode(codepoint), style: style),
    textDirection: TextDirection.ltr,
    textScaler: TextScaler.noScaling,
  )..layout();
  try {
    final width = painter.width;
    return width.isFinite && width >= 0.0 ? width : -1.0;
  } finally {
    painter.dispose();
  }
}

/// Pre-warmed 21-slot host font metric table pushed once per font stack to the
/// native PocketJS layout engine.
final class PocketHostFontMetrics {
  PocketHostFontMetrics._({
    required this.lineHeights,
    required this.cjkAdvances,
    required this.asciiAdvances,
  });

  static const int _maxCachedStacks = 16;
  static final LinkedHashMap<String, PocketHostFontMetrics> _cache =
      LinkedHashMap<String, PocketHostFontMetrics>();

  final Float32List lineHeights;
  final Float32List cjkAdvances;
  final Float32List asciiAdvances;

  /// Returns cached or freshly measured 21-slot host font metrics for
  /// [fontFamilyFallback].
  static PocketHostFontMetrics forFallback([
    List<String> fontFamilyFallback = const <String>[],
  ]) {
    final key = fontFamilyFallback.join('\u0000');
    final existing = _cache.remove(key);
    if (existing != null) {
      _cache[key] = existing;
      return existing;
    }
    final computed = _measureAllSlots(fontFamilyFallback);
    if (_cache.length >= _maxCachedStacks) {
      _cache.remove(_cache.keys.first);
    }
    _cache[key] = computed;
    return computed;
  }

  static void clearCache() => _cache.clear();

  static PocketHostFontMetrics _measureAllSlots(
    List<String> fontFamilyFallback,
  ) {
    final lineHeights = Float32List(pocketHostFontSlotCount);
    final cjkAdvances = Float32List(pocketHostFontSlotCount);
    final asciiAdvances = Float32List(
      pocketHostFontSlotCount * pocketHostAsciiCount,
    );
    final painter = TextPainter(
      textDirection: TextDirection.ltr,
      textScaler: TextScaler.noScaling,
    );
    try {
      for (var slot = 0; slot < pocketHostFontSlotCount; slot++) {
        final slotSize = pocketFontSlotSizes[slot];
        final style = pocketTextStyleForSlot(
          slot: slot,
          fontSize: slotSize,
          fontFamilyFallback: fontFamilyFallback,
        );

        painter.text = TextSpan(text: 'Mg\u6C38', style: style);
        painter.layout();
        final naturalHeight = painter.height;
        final minLineHeight = (slotSize * 1.2).ceilToDouble();
        lineHeights[slot] = naturalHeight.isFinite && naturalHeight > 0.0
            ? math.max(naturalHeight.ceilToDouble(), minLineHeight)
            : minLineHeight;

        painter.text = TextSpan(text: '\u6C38', style: style);
        painter.layout();
        final cjkWidth = painter.width;
        cjkAdvances[slot] =
            cjkWidth.isFinite && cjkWidth > 0.0 ? cjkWidth : slotSize;

        final baseOffset = slot * pocketHostAsciiCount;
        for (var i = 0; i < pocketHostAsciiCount; i++) {
          final charText = String.fromCharCode(pocketHostAsciiStart + i);
          painter.text = TextSpan(text: charText, style: style);
          painter.layout();
          final width = painter.width;
          asciiAdvances[baseOffset + i] =
              width.isFinite && width >= 0.0 ? width : slotSize * 0.56;
        }
      }
    } finally {
      painter.dispose();
    }
    return PocketHostFontMetrics._(
      lineHeights: lineHeights,
      cjkAdvances: cjkAdvances,
      asciiAdvances: asciiAdvances,
    );
  }
}

/// Synchronizes OS/Flutter font metrics and on-demand glyph advance lookup into
/// [runtime] when backed by [FfiPocketRuntime] outside deterministic replay.
bool syncPocketHostFonts(
  PocketRuntime runtime, {
  List<String> fontFamilyFallback = const <String>[],
}) {
  if (runtime is FfiPocketRuntime) {
    return runtime.syncHostFonts(fontFamilyFallback: fontFamilyFallback);
  }
  return false;
}
