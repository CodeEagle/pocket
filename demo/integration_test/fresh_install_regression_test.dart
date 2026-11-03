import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'duo_resize_test.dart' as duo_resize;
import 'editor_update_check_test.dart' as editor_update;
import 'first_open_regression_test.dart' as first_open;
import 'flutter_fps_test.dart' as flutter_fps;
import 'flutter_keyboard_control_test.dart' as flutter_keyboard;
import 'fps_history_test.dart' as fps_history;
import 'glass_optics_test.dart' as glass;
import 'guest_interaction_test.dart' as guest_interaction;
import 'hardware_native_test.dart' as hardware_native;
import 'interaction_jank_test.dart' as interaction_jank;
import 'multi_app_test.dart' as mini_apps;
import 'page_scroll_test.dart' as scroll;
import 'performance_test.dart' as performance;
import 'recording_replay_test.dart' as recording;
import 'showcase_mobile_test.dart' as showcase;
import 'showcase_visual_review_test.dart' as visual_review;
import 'system_keyboard_lifecycle_test.dart' as keyboard_lifecycle;
import 'system_keyboard_test.dart' as keyboard_client;
import 'update_lifecycle_test.dart' as update_lifecycle;

const _updateUrl = String.fromEnvironment('POCKET_UPDATE_URL');
const _controlUrl = String.fromEnvironment('POCKET_TEST_CONTROL_URL');
const _storeNamespace = String.fromEnvironment('POCKET_STORE_NAMESPACE');

/// Fresh-install phone/simulator coverage assembled from the existing
/// behavior tests.
///
/// The Duo-pose test remains separate because it requires Device Hub poses;
/// the native-resize ABI probe uses a fixed contract geometry rather than an
/// ordinary phone profile. The OTA tests are registered only when their
/// controlled loopback/reachable service defines are supplied; otherwise the
/// skip is explicit instead of turning an ordinary phone run into a false
/// failure.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  // Cold-start and user-visible behavior.
  group('first_open', first_open.main);
  group('showcase', showcase.main);
  group('visual_review', visual_review.main);
  group('keyboard_lifecycle', keyboard_lifecycle.main);
  group('keyboard_client', keyboard_client.main);
  group('scroll', scroll.main);
  group('guest_interaction', guest_interaction.main);
  group('mini_apps', mini_apps.main);
  group('hardware_native', hardware_native.main);

  // Local, reversible recording and rendering/performance behavior. The
  // viewport case exercises generic Flutter constraints and controller
  // retention; it is not a physical Duo hinge/pose test.
  group('recording', recording.main);
  group('duo_resize', duo_resize.main);
  // This remains an independent shader/draw regression, not a Demo route
  // assertion.
  group('glass', glass.main);
  group('flutter_keyboard', flutter_keyboard.main);
  group('flutter_fps', flutter_fps.main);
  group('fps_history', fps_history.main);
  group('performance', performance.main);
  group('interaction_jank', interaction_jank.main);

  // Controlled OTA coverage is opt-in through the same isolated test defines
  // used by test_updates.ts. Its loopback server must be reachable by the
  // target device; these tests never contact a production update endpoint.
  if (_updateUrl.isNotEmpty && _storeNamespace.isNotEmpty) {
    group('editor_update', editor_update.main);
  } else {
    debugPrint(
      'FRESH_INSTALL_OTA_SKIPPED editor_update: set '
      'POCKET_UPDATE_URL and POCKET_STORE_NAMESPACE',
    );
  }
  if (_updateUrl.isNotEmpty &&
      _controlUrl.isNotEmpty &&
      _storeNamespace.isNotEmpty) {
    group('update_lifecycle', update_lifecycle.main);
  } else {
    debugPrint(
      'FRESH_INSTALL_OTA_SKIPPED update_lifecycle: set '
      'POCKET_UPDATE_URL, POCKET_TEST_CONTROL_URL and '
      'POCKET_STORE_NAMESPACE',
    );
  }
}
