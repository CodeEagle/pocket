import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Modifier bits carried by an `input.text` key event (`modifiers`).
const int pocketTextModifierShift = 1;
const int pocketTextModifierControl = 2;
const int pocketTextModifierAlt = 4;
const int pocketTextModifierMeta = 8;

/// Largest UTF-8 payload the native `input.text` admission accepts for one
/// `commit` or `composition` event.
const int pocketRawTextMaxEventBytes = 4096;

/// Current modifier mask from Flutter's hardware keyboard state.
int pocketRawTextModifiers() {
  final keyboard = HardwareKeyboard.instance;
  return (keyboard.isShiftPressed ? pocketTextModifierShift : 0) |
      (keyboard.isControlPressed ? pocketTextModifierControl : 0) |
      (keyboard.isAltPressed ? pocketTextModifierAlt : 0) |
      (keyboard.isMetaPressed ? pocketTextModifierMeta : 0);
}

/// Names a key the way `KeyboardEvent.key` does (`ArrowLeft`, `Enter`, `a`).
///
/// A printable [character] wins, so Shift and layouts are respected. Control
/// characters (Ctrl+letter on some platforms) fall back to the logical key's
/// label. Left/right modifier variants collapse to one name.
String pocketRawKeyName(LogicalKeyboardKey key, String? character) {
  if (character != null && character.isNotEmpty) {
    final unit = character.codeUnitAt(0);
    if (unit >= 0x20 && unit != 0x7f) return character;
  }
  final label = key.keyLabel;
  if (label == ' ') return ' ';
  final name = label.isNotEmpty ? label : (key.debugName ?? '');
  final compact = name.replaceAll(' ', '');
  const modifiers = <String>{'Shift', 'Control', 'Alt', 'Meta'};
  for (final modifier in modifiers) {
    if (compact == '${modifier}Left' || compact == '${modifier}Right') {
      return modifier;
    }
  }
  // Single letters from keyLabel are upper case; KeyboardEvent.key reports the
  // unshifted letter when no character was produced (for example Ctrl+Z).
  if (compact.length == 1) return compact.toLowerCase();
  return compact;
}

/// Splits [text] into pieces of at most [maxBytes] UTF-8 bytes without cutting
/// a code point (and therefore never a surrogate pair).
List<String> pocketSplitUtf8(
  String text, {
  int maxBytes = pocketRawTextMaxEventBytes,
}) {
  final parts = <String>[];
  final buffer = StringBuffer();
  var bytes = 0;
  for (final rune in text.runes) {
    final width = rune < 0x80
        ? 1
        : rune < 0x800
        ? 2
        : rune < 0x10000
        ? 3
        : 4;
    if (bytes + width > maxBytes) {
      parts.add(buffer.toString());
      buffer.clear();
      bytes = 0;
    }
    buffer.writeCharCode(rune);
    bytes += width;
  }
  if (buffer.isNotEmpty) parts.add(buffer.toString());
  return parts;
}

/// Truncates [text] to at most [maxBytes] UTF-8 bytes on a code point boundary.
String pocketTruncateUtf8(
  String text, {
  int maxBytes = pocketRawTextMaxEventBytes,
}) {
  final parts = pocketSplitUtf8(text, maxBytes: maxBytes);
  return parts.isEmpty ? '' : parts.first;
}

/// One event the translator wants delivered to the guest as `input.text`.
final class PocketRawTextOutput {
  const PocketRawTextOutput.commit(this.text)
    : kind = 'commit',
      selectionStart = 0,
      selectionEnd = 0;
  const PocketRawTextOutput.composition(
    this.text,
    this.selectionStart,
    this.selectionEnd,
  ) : kind = 'composition';
  const PocketRawTextOutput.compositionEnd()
    : kind = 'compositionEnd',
      text = '',
      selectionStart = 0,
      selectionEnd = 0;

  final String kind;
  final String text;
  final int selectionStart;
  final int selectionEnd;

  @override
  String toString() => kind == 'composition'
      ? 'composition($text,$selectionStart,$selectionEnd)'
      : kind == 'commit'
      ? 'commit($text)'
      : kind;
}

/// `DeltaTextInputClient` that turns platform IME updates into guest text
/// events. The scratch [TextEditingValue] mirrors what the platform believes
/// it is editing (required by the client contract); it is emptied as soon as
/// text has been committed, so nothing accumulates host-side.
///
/// Event order for one platform update:
/// * composition active: optional `commit` of text finalized before the
///   marked region, then `composition` (marked text and selection relative to
///   it, UTF-16 units);
/// * composition just ended: `compositionEnd`, then `commit` of the final
///   text. A cancelled composition ends with no commit;
/// * no composition: `commit` of the inserted text.
final class PocketRawTextClient implements DeltaTextInputClient {
  PocketRawTextClient({required this.emit, this.onConnectionClosed});

  /// Receives each output event in order.
  final void Function(PocketRawTextOutput output) emit;
  final VoidCallback? onConnectionClosed;

  TextInputConnection? _connection;
  TextEditingValue _value = TextEditingValue.empty;
  // Text before this offset has already been reported as `commit`.
  int _emitted = 0;
  bool _composing = false;
  String? _lastCompositionKey;
  bool _suppressNewline = false;

  /// Called after an Enter keyDown was forwarded as a key event: a lone "\n"
  /// insertion in the next IME update is the same keystroke and is dropped, so
  /// the guest receives Enter exactly once. Cleared by any update, by
  /// [cancelNewlineSuppression] (Enter keyUp) and by [detach].
  void suppressNextNewline() => _suppressNewline = true;
  void cancelNewlineSuppression() => _suppressNewline = false;

  /// True while a marked (composing) region is active.
  bool get isComposing => _composing;

  bool get isAttached => _connection?.attached ?? false;

  @visibleForTesting
  TextEditingValue get debugValue => _value;

  static const TextInputConfiguration configuration = TextInputConfiguration(
    inputType: TextInputType.multiline,
    inputAction: TextInputAction.newline,
    enableDeltaModel: true,
    autocorrect: false,
    enableSuggestions: true,
    enableIMEPersonalizedLearning: false,
  );

  void attach() {
    if (isAttached) return;
    _reset();
    _connection = TextInput.attach(this, configuration)
      ..show()
      ..setEditingState(TextEditingValue.empty);
  }

  void setGeometry({
    required Size size,
    required Matrix4 transform,
    required Rect caretRect,
  }) {
    final connection = _connection;
    if (connection == null || !connection.attached) return;
    connection
      ..setEditableSizeAndTransform(size, transform)
      ..setCaretRect(caretRect)
      ..setComposingRect(caretRect);
  }

  /// Ends the platform session. Pending composition is not committed: the
  /// guest requested the stop and owns the policy.
  void detach() {
    final connection = _connection;
    _connection = null;
    if (connection != null && connection.attached) connection.close();
    _reset();
  }

  void _reset() {
    _value = TextEditingValue.empty;
    _emitted = 0;
    _composing = false;
    _lastCompositionKey = null;
    _suppressNewline = false;
  }

  @override
  TextEditingValue get currentTextEditingValue => _value;

  @override
  AutofillScope? get currentAutofillScope => null;

  @override
  void updateEditingValueWithDeltas(List<TextEditingDelta> textEditingDeltas) {
    var next = _value;
    for (final delta in textEditingDeltas) {
      next = delta.apply(next);
    }
    _process(next);
  }

  @override
  void updateEditingValue(TextEditingValue value) => _process(value);

  void _process(TextEditingValue value) {
    final text = value.text;
    final composing = value.composing;
    final marked =
        composing.isValid &&
        !composing.isCollapsed &&
        composing.end <= text.length;
    if (marked) {
      if (composing.start > _emitted) {
        _commit(text.substring(_emitted, composing.start));
      }
      _emitted = composing.start;
      final marker = text.substring(composing.start, composing.end);
      final selection = value.selection;
      final length = marker.length;
      int relative(int offset) => (offset - composing.start).clamp(0, length);
      var start = selection.isValid ? relative(selection.start) : length;
      var end = selection.isValid ? relative(selection.end) : length;
      if (start > end) {
        final swap = start;
        start = end;
        end = swap;
      }
      var shown = marker;
      if (pocketTruncateUtf8(marker) != marker) {
        shown = pocketTruncateUtf8(marker);
        start = start.clamp(0, shown.length);
        end = end.clamp(0, shown.length);
      }
      final key = '$shown\u0000$start\u0000$end';
      if (!_composing || key != _lastCompositionKey) {
        emit(PocketRawTextOutput.composition(shown, start, end));
        _lastCompositionKey = key;
      }
      _composing = true;
      _value = value;
      return;
    }
    if (_composing) {
      emit(const PocketRawTextOutput.compositionEnd());
      _composing = false;
      _lastCompositionKey = null;
    }
    if (text.length > _emitted) {
      final inserted = text.substring(_emitted);
      if (!(_suppressNewline && inserted == '\n')) _commit(inserted);
    }
    _suppressNewline = false;
    // Everything is reported; hand the platform an empty scratch buffer so a
    // later deletion cannot reach text the guest already owns.
    _value = TextEditingValue.empty;
    _emitted = 0;
    final connection = _connection;
    if (connection != null && connection.attached && text.isNotEmpty) {
      connection.setEditingState(TextEditingValue.empty);
    }
  }

  void _commit(String text) {
    for (final part in pocketSplitUtf8(text)) {
      emit(PocketRawTextOutput.commit(part));
    }
  }

  @override
  void connectionClosed() {
    _connection = null;
    _reset();
    onConnectionClosed?.call();
  }

  // Return/newline arrive as text (or a key event); the guest owns policy.
  @override
  void performAction(TextInputAction action) {}

  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {}

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {}

  @override
  void showAutocorrectionPromptRect(int start, int end) {}

  @override
  void didChangeInputControl(
    TextInputControl? oldControl,
    TextInputControl? newControl,
  ) {}

  @override
  void insertContent(KeyboardInsertedContent content) {}

  @override
  void performSelector(String selectorName) {}

  @override
  void showToolbar() {}

  @override
  void insertTextPlaceholder(Size size) {}

  @override
  void removeTextPlaceholder() {}

  @override
  bool onFocusReceived() => false;
}
