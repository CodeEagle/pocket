import 'dart:ui' show Rect, Size;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show Widget;

/// One real child application surface at its position in the parent's DrawOps.
///
/// Geometry is expressed in the parent's logical viewport. [bounds] retains
/// the child's full coordinate origin while [visibleClip] only limits which
/// part is painted and can receive pointer input. A surface handle identifies
/// a package in the trusted System catalog; it is not a texture ID.
@immutable
final class PocketCompositorSlot {
  const PocketCompositorSlot({
    required this.surfaceHandle,
    required this.bounds,
    required this.visibleClip,
    required this.logicalViewport,
    this.visible = true,
    required this.focused,
    required this.drawIndex,
    this.preserveDisplayGeometry = false,
  });

  /// Stable System catalog handle emitted by SURFACE_QUAD.
  final int surfaceHandle;

  /// Full, unclipped child bounds in parent logical coordinates.
  final Rect bounds;

  /// Visible portion of [bounds], intersected with inherited clip and viewport.
  final Rect visibleClip;

  /// Logical size of the parent DrawOps surface.
  final Size logicalViewport;

  /// Whether this DrawOps contains the surface. False slots are retained
  /// offstage so their runtime can resume without replacing its native realm.
  final bool visible;

  /// Focus fact emitted by the SystemUI retained tree.
  final bool focused;

  /// Zero-based position in the decoded parent DrawOps list.
  final int drawIndex;

  /// Keep the child guest's display/safe-area reference anchored to the
  /// parent's logical viewport while this full-viewport surface is translated
  /// or clipped. Pointer coordinates and [bounds]/[visibleClip] remain the
  /// physical compositor geometry.
  ///
  /// Small embedded surfaces leave this false and continue deriving insets
  /// from their actual RenderBox intersection.
  final bool preserveDisplayGeometry;
}

/// Resolves an official SURFACE_QUAD to a live child guest widget.
///
/// A null result leaves the host's already-painted content visible at the
/// surface position, which is useful while a child is starting or after its
/// generation has been retired.
typedef PocketHostSurfaceBuilder = Widget? Function(PocketCompositorSlot slot);
