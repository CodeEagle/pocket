// Rendering/input regressions for the keyboard performance work.
// Keep the signed Editor update smoke test separate: these scenarios need
// only the packaged guest and the device's real rendering/input pipeline.
import 'page_scroll_test.dart' as scroll;
import 'showcase_mobile_test.dart' as mobile;
import 'system_keyboard_lifecycle_test.dart' as keyboard;
import 'system_keyboard_test.dart' as ime;

void main() {
  keyboard.main();
  ime.main();
  scroll.main();
  mobile.main();
}
