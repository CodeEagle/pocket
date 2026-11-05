import 'dart:ui' show Rect;

import 'package:flutter/widgets.dart';

import 'pocket_model.dart';

const String pocketAccessibilitySnapshotEvent = 'accessibility.snapshot';
const String pocketAccessibilityActionEvent = 'accessibility.action';

typedef PocketSemanticsEventSender =
    bool Function(String method, Map<String, dynamic> params);

/// The only action the thin Flutter overlay sends back to the guest.
final class PocketSemanticsAction {
  const PocketSemanticsAction({
    required this.guestId,
    required this.nativeId,
    required this.generation,
  });

  final String guestId;
  final int nativeId;
  final int generation;

  Map<String, dynamic> toPayload() => <String, dynamic>{
    'action': 'activate',
    'guestId': guestId,
    'nativeId': nativeId,
    'generation': generation,
  };
}

/// Sends one semantic activation over the existing PocketView host-event lane.
bool dispatchPocketSemanticsAction(
  PocketSemanticsEventSender send,
  PocketSemanticsAction action,
) {
  return send(pocketAccessibilityActionEvent, action.toPayload());
}

final class PocketSemanticsNode {
  const PocketSemanticsNode({
    required this.guestId,
    required this.nativeId,
    required this.label,
    required this.role,
    required this.rect,
    required this.selected,
    required this.disabled,
    required this.enabled,
    this.checked,
  });

  final String guestId;
  final int nativeId;
  final String label;
  final String role;
  final Rect rect;
  final bool selected;
  final bool disabled;
  final bool enabled;
  final bool? checked;

  bool get button => role == 'button' || role == 'tab';
}

/// A bounded, direct-object semantic snapshot published by the JS guest.
final class PocketSemanticsSnapshot {
  const PocketSemanticsSnapshot({
    required this.generation,
    required this.nodes,
  });

  static const int maxNodes = 128;

  final int generation;
  final List<PocketSemanticsNode> nodes;

  factory PocketSemanticsSnapshot.fromEvent(PocketEvent event) {
    if (event.method != pocketAccessibilitySnapshotEvent) {
      throw FormatException(
        'Unexpected Pocket semantics event: ${event.method}',
      );
    }
    return PocketSemanticsSnapshot.fromDynamic(event.params);
  }

  static PocketSemanticsSnapshot? tryFromEvent(PocketEvent event) {
    try {
      return PocketSemanticsSnapshot.fromEvent(event);
    } on FormatException {
      return null;
    }
  }

  factory PocketSemanticsSnapshot.fromDynamic(Object? value) {
    if (value is! Map) {
      throw const FormatException(
        'Pocket semantics snapshot must be an object',
      );
    }
    final json = _stringMap(value);
    final generation = _nonNegativeInt(json['generation']) ?? 0;
    final rawNodes = json['controls'] ?? json['nodes'];
    if (rawNodes is! List) {
      throw const FormatException(
        'Pocket semantics snapshot controls must be a list',
      );
    }

    final nodes = <PocketSemanticsNode>[];
    final seen = <String>{};
    for (final raw in rawNodes) {
      if (nodes.length >= maxNodes || raw is! Map) break;
      final node = _parseNode(raw);
      if (node == null || !seen.add(node.guestId)) continue;
      nodes.add(node);
    }
    return PocketSemanticsSnapshot(
      generation: generation,
      nodes: List<PocketSemanticsNode>.unmodifiable(nodes),
    );
  }

  static PocketSemanticsNode? _parseNode(Map<Object?, Object?> raw) {
    final json = _stringMap(raw);
    final guestId = json['guestId'] ?? json['id'];
    final label = json['label'];
    final nativeId = _nonNegativeInt(json['nativeId']);
    final role = json['role'];
    if (guestId is! String ||
        guestId.isEmpty ||
        label is! String ||
        nativeId == null ||
        role is! String ||
        (role != 'button' && role != 'tab')) {
      return null;
    }

    final rectValue = json['rect'];
    if (rectValue is! Map) return null;
    final rect = _parseRect(rectValue);
    if (rect == null) return null;

    final disabled = json['disabled'] is bool
        ? json['disabled'] as bool
        : false;
    final enabledValue = json['enabled'];
    final enabled = disabled
        ? false
        : enabledValue is bool
        ? enabledValue
        : true;
    final selected = json['selected'] is bool
        ? json['selected'] as bool
        : false;
    final checked = json['checked'] is bool ? json['checked'] as bool : null;
    return PocketSemanticsNode(
      guestId: guestId,
      nativeId: nativeId,
      label: label,
      role: role,
      rect: rect,
      selected: selected,
      disabled: disabled,
      enabled: enabled,
      checked: checked,
    );
  }

  static Rect? _parseRect(Map<Object?, Object?> raw) {
    final json = _stringMap(raw);
    final x = _finiteDouble(json['x'] ?? json['left']);
    final y = _finiteDouble(json['y'] ?? json['top']);
    final width = _finiteDouble(json['width'] ?? json['w']);
    final height = _finiteDouble(json['height'] ?? json['h']);
    if (x == null ||
        y == null ||
        width == null ||
        height == null ||
        width <= 0 ||
        height <= 0) {
      return null;
    }
    return Rect.fromLTWH(x, y, width, height);
  }

  static Map<String, dynamic> _stringMap(Map<Object?, Object?> value) {
    final result = <String, dynamic>{};
    for (final entry in value.entries) {
      if (entry.key is String) result[entry.key as String] = entry.value;
    }
    return result;
  }

  static double? _finiteDouble(Object? value) {
    if (value is! num || !value.isFinite) return null;
    return value.toDouble();
  }

  static int? _nonNegativeInt(Object? value) {
    if (value is int) return value >= 0 ? value : null;
    if (value is num && value.isFinite && value == value.truncate()) {
      final integer = value.toInt();
      return integer >= 0 ? integer : null;
    }
    return null;
  }
}

/// A semantics-only overlay over the JS-owned Pocket canvas.
///
/// The overlay is wrapped in `IgnorePointer(ignoringSemantics: false)`: hit
/// testing continues to the ordinary guest pointer surface, while Flutter's
/// accessibility tree sees the explicit JS controls. Accessibility activation
/// is sent back through [sendEvent] and never becomes Dart UI state.
final class PocketSemanticsOverlay extends StatelessWidget {
  const PocketSemanticsOverlay({
    super.key,
    required this.child,
    required this.snapshot,
    this.sendEvent,
    this.scaleX = 1,
    this.scaleY = 1,
  });

  final Widget child;
  final PocketSemanticsSnapshot snapshot;
  final PocketSemanticsEventSender? sendEvent;

  /// Converts JS guest logical coordinates into the Flutter surface space.
  final double scaleX;
  final double scaleY;

  @override
  Widget build(BuildContext context) {
    final semanticNodes = <Widget>[];
    for (final node in snapshot.nodes) {
      final rect = Rect.fromLTWH(
        node.rect.left * scaleX,
        node.rect.top * scaleY,
        node.rect.width * scaleX,
        node.rect.height * scaleY,
      );
      final activate = node.enabled && sendEvent != null
          ? () {
              dispatchPocketSemanticsAction(
                sendEvent!,
                PocketSemanticsAction(
                  guestId: node.guestId,
                  nativeId: node.nativeId,
                  generation: snapshot.generation,
                ),
              );
            }
          : null;
      semanticNodes.add(
        Positioned(
          key: ValueKey<String>('pocket-semantic:${node.guestId}'),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          child: Semantics(
            key: ValueKey<String>(node.guestId),
            container: true,
            label: node.label,
            button: node.button,
            toggled: node.checked,
            selected: node.selected,
            enabled: node.enabled,
            onTap: activate,
            child: const SizedBox.expand(),
          ),
        ),
      );
    }

    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        child,
        if (semanticNodes.isNotEmpty)
          IgnorePointer(
            ignoring: true,
            ignoringSemantics: false,
            child: Stack(clipBehavior: Clip.none, children: semanticNodes),
          ),
      ],
    );
  }
}
