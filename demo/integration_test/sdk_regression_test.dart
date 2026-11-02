// Run the existing device scenarios in one build against the public SDK.
// Keep their assertions in the individual files so each can also run alone.
import 'duo_resize_test.dart' as resize;
import 'fps_history_test.dart' as performance;
import 'glass_optics_test.dart' as glass;
import 'guest_interaction_test.dart' as interaction;
import 'page_scroll_test.dart' as scroll;
import 'showcase_mobile_test.dart' as showcase;
import 'system_keyboard_lifecycle_test.dart' as keyboard;
import 'system_keyboard_test.dart' as text;

void main() {
  showcase.main();
  resize.main();
  interaction.main();
  keyboard.main();
  text.main();
  scroll.main();
  performance.main();
  glass.main();
}
