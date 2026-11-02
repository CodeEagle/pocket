import 'dart:collection';

import 'package:flutter/painting.dart';

/// A bounded cache of laid-out Flutter text.
///
/// PocketJS emits retained TEXT_RUN strings. Their coordinates are not part of
/// layout, so blocks can share one [TextPainter] when all text/style/constraint
/// inputs match. The cache owns every painter it stores and disposes evicted
/// entries; callers must call [dispose] when the owning surface is destroyed.
final class PocketTextLayoutCache {
  PocketTextLayoutCache({this.capacity = 256})
    : assert(capacity > 0, 'capacity must be positive');

  final int capacity;
  final LinkedHashMap<_PocketTextLayoutKey, TextPainter> _entries =
      LinkedHashMap<_PocketTextLayoutKey, TextPainter>();
  bool _disposed = false;

  /// Number of actual TextPainter.layout calls performed by this cache.
  int layoutCount = 0;

  /// Number of lookups served by an existing entry.
  int hitCount = 0;

  /// Number of entries evicted by the capacity bound.
  int evictionCount = 0;

  int get length => _entries.length;

  /// Returns a laid-out painter, promoting cache hits to most-recently-used.
  ///
  /// No position is included in the key. [minWidth] and [maxWidth] are
  /// included because they affect paragraph layout even though the current
  /// PocketCanvas path uses an unbounded width.
  TextPainter obtain({
    required String text,
    required TextStyle style,
    TextDirection textDirection = TextDirection.ltr,
    TextAlign textAlign = TextAlign.start,
    double minWidth = 0,
    double maxWidth = double.infinity,
  }) {
    if (_disposed) {
      throw StateError('PocketTextLayoutCache has been disposed');
    }
    final key = _PocketTextLayoutKey(
      text: text,
      style: style,
      textDirection: textDirection,
      textAlign: textAlign,
      minWidth: minWidth,
      maxWidth: maxWidth,
    );
    final cached = _entries.remove(key);
    if (cached != null) {
      _entries[key] = cached;
      hitCount++;
      return cached;
    }

    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: textDirection,
      textAlign: textAlign,
    )..layout(minWidth: minWidth, maxWidth: maxWidth);
    layoutCount++;
    _entries[key] = painter;
    while (_entries.length > capacity) {
      final oldestKey = _entries.keys.first;
      final evicted = _entries.remove(oldestKey);
      evicted?.dispose();
      evictionCount++;
    }
    return painter;
  }

  /// Drops every cached painter. Counters intentionally remain available for
  /// profiling/tests until [resetStats] or disposal.
  void clear() {
    for (final painter in _entries.values) {
      painter.dispose();
    }
    _entries.clear();
  }

  void resetStats() {
    layoutCount = 0;
    hitCount = 0;
    evictionCount = 0;
  }

  void dispose() {
    if (_disposed) return;
    clear();
    _disposed = true;
  }
}

final class _PocketTextLayoutKey {
  _PocketTextLayoutKey({
    required this.text,
    required this.style,
    required this.textDirection,
    required this.textAlign,
    required this.minWidth,
    required this.maxWidth,
  });

  final String text;
  // TextStyle equality/hashCode include paint and layout fields (including
  // fallback fonts, line height, shadows, decorations and font features).
  // Keeping the complete immutable style here prevents a future TEXT_RUN
  // field from silently colliding with an older cached paragraph.
  final TextStyle style;
  final TextDirection textDirection;
  final TextAlign textAlign;
  final double minWidth;
  final double maxWidth;

  @override
  bool operator ==(Object other) {
    if (other is! _PocketTextLayoutKey ||
        text != other.text ||
        style != other.style ||
        textDirection != other.textDirection ||
        textAlign != other.textAlign ||
        minWidth != other.minWidth ||
        maxWidth != other.maxWidth) {
      return false;
    }
    return true;
  }

  @override
  int get hashCode =>
      Object.hash(text, style, textDirection, textAlign, minWidth, maxWidth);
}
