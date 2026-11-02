/// PocketJS raster resources use integral densities; layout stays logical.
/// Flutter's canvas itself always uses the exact current FlutterView DPR.
int pocketRasterDensity(double devicePixelRatio) {
  if (!devicePixelRatio.isFinite || devicePixelRatio <= 0) return 1;
  return devicePixelRatio.ceil().clamp(1, 4);
}
