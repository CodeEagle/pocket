/// Backward-compatible export; the shared monitor implementation lives in the
/// Pocket Flutter SDK so PocketView and the Demo use the same collector and HUD.
export 'package:pocket_flutter/pocket_flutter.dart'
    show FlutterFrameMonitor, FlutterFrameMonitorController,
        FlutterFrameTimingSample, FlutterFrameWindow;
