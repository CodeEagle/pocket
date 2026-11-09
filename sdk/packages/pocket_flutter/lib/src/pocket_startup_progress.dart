import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// Observed stage while Pocket prepares a guest's first visible frame.
///
/// Package transfer facts are supplied by the upper SDK before a
/// [PocketView] is created. A view then reports its actual runtime, initial
/// image-resource, and display-geometry work. There is no synthetic timer or
/// estimated percentage.
enum PocketStartupStage {
  /// The upper SDK is reading, verifying, or transferring the app package.
  preparingPackage,

  /// PocketView is reading its inputs and starting the native guest runtime.
  startingRuntime,

  /// PocketView is decoding unique image/mask assets used by the first frame.
  decodingInitialResources,

  /// PocketView is applying current host display facts and required resources.
  applyingDisplayGeometry,
}

/// Immutable facts observed while a Pocket guest is starting.
@immutable
final class PocketStartupProgress {
  const PocketStartupProgress({
    required this.stage,
    this.packageStage,
    this.downloadedBytes,
    this.totalBytes,
    this.resourcesDecoded,
    this.resourcesTotal,
  });

  final PocketStartupStage stage;

  /// Raw stage from the existing package-transfer boundary, when applicable.
  ///
  /// PocketView does not create or interpret package stages.
  final String? packageStage;

  /// Bytes actually read or downloaded so far, or null when unavailable.
  final int? downloadedBytes;

  /// Known total bytes, or null when the source does not provide one.
  final int? totalBytes;

  /// Number of unique first-frame image/mask resources that decoded
  /// successfully. Failed or still-pending resources are not counted.
  final int? resourcesDecoded;

  /// Number of unique image/mask resources referenced by the first-frame
  /// primary and auxiliary DrawLists. This is not a whole-package count.
  final int? resourcesTotal;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PocketStartupProgress &&
          other.stage == stage &&
          other.packageStage == packageStage &&
          other.downloadedBytes == downloadedBytes &&
          other.totalBytes == totalBytes &&
          other.resourcesDecoded == resourcesDecoded &&
          other.resourcesTotal == resourcesTotal;

  @override
  int get hashCode => Object.hash(
    stage,
    packageStage,
    downloadedBytes,
    totalBytes,
    resourcesDecoded,
    resourcesTotal,
  );
}

/// Builds a loading surface from current, observed Pocket startup facts.
typedef PocketLoadingBuilder =
    Widget Function(BuildContext context, PocketStartupProgress progress);
