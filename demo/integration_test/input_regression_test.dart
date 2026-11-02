// Focused regression for system IME, layout stability, and guest scrolling.
import 'editor_update_check_test.dart' as editor_update;
import 'page_scroll_test.dart' as scroll;
import 'system_keyboard_lifecycle_test.dart' as keyboard;
import 'system_keyboard_test.dart' as text;

void main() {
  keyboard.main();
  text.main();
  scroll.main();
  editor_update.main();
}
