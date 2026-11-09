// Device facts only. Button bits and packed axes follow the pinned
// contracts/spec/spec.ts BTN / analog frame contract.
const BTN = Object.freeze({ SELECT: 1, START: 8, UP: 16, RIGHT: 32, DOWN: 64, LEFT: 128,
  LTRIGGER: 256, RTRIGGER: 512, ZL: 1024, ZR: 2048,
  TRIANGLE: 4096, CIRCLE: 8192, CROSS: 16384, SQUARE: 32768 });
const KEYS = Object.freeze({ ArrowUp: BTN.UP, ArrowRight: BTN.RIGHT, ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT, KeyW: BTN.UP, KeyD: BTN.RIGHT, KeyS: BTN.DOWN, KeyA: BTN.LEFT,
  KeyZ: BTN.CROSS, Space: BTN.CROSS, KeyX: BTN.CIRCLE, Escape: BTN.CIRCLE,
  KeyJ: BTN.SQUARE, KeyK: BTN.TRIANGLE, KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER,
  Enter: BTN.START, Tab: BTN.SELECT });
const PAD_BUTTONS = [BTN.CROSS, BTN.CIRCLE, BTN.SQUARE, BTN.TRIANGLE,
  BTN.LTRIGGER, BTN.RTRIGGER, BTN.ZL, BTN.ZR, BTN.SELECT, BTN.START,
  0, 0, BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT];
const NEUTRAL = Object.freeze({ buttons: 0, analog: 0x8080, rightAnalog: 0x8080 });

function axis(value, deadzone) {
  const finite = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  if (Math.abs(finite) <= deadzone) return 128;
  const normalized = Math.sign(finite) * (Math.abs(finite) - deadzone) / (1 - deadzone);
  return normalized < 0 ? Math.round(128 + normalized * 128) : Math.round(128 + normalized * 127);
}

class BrowserGameInput {
  constructor({ canvas, onChange, environment = globalThis, deadzone = 0.15 }) {
    if (!(deadzone >= 0 && deadzone < 1)) throw new RangeError("Gamepad deadzone must be in [0, 1)");
    this.canvas = canvas; this.environment = environment; this.onChange = onChange;
    this.deadzone = deadzone; this.keys = new Set(); this.value = { ...NEUTRAL };
    this.active = false; this.disposed = false; this.raf = null;
    this.originalTabIndex = canvas.getAttribute?.("tabindex") ?? null;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    this.keyDown = (event) => {
      if (!this.focused() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !KEYS[event.code]) return;
      this.keys.add(event.code); event.preventDefault(); this.sample();
    };
    this.keyUp = (event) => {
      if (!this.keys.delete(event.code)) return;
      event.preventDefault(); this.sample();
    };
    this.focus = () => { this.sample(); this.poll(); };
    this.blur = () => { this.keys.clear(); this.stopPoll(); this.publish(NEUTRAL); };
    this.deviceChanged = () => { this.sample(); this.poll(); };
    canvas.addEventListener("keydown", this.keyDown);
    canvas.addEventListener("focus", this.focus);
    canvas.addEventListener("blur", this.blur);
    environment.addEventListener("keyup", this.keyUp);
    environment.addEventListener("blur", this.blur);
    environment.addEventListener("focus", this.focus);
    environment.addEventListener("gamepadconnected", this.deviceChanged);
    environment.addEventListener("gamepaddisconnected", this.deviceChanged);
  }

  focused() {
    const document = this.environment.document;
    return this.active && !this.disposed && document?.activeElement === this.canvas
      && (!document.hasFocus || document.hasFocus());
  }
  state() { return { ...this.value }; }
  pads() {
    try { return Array.from(this.environment.navigator?.getGamepads?.() || []).filter(pad => pad?.connected && pad.mapping === "standard"); }
    catch (_) { return []; }
  }
  publish(value) {
    if (this.value.buttons === value.buttons && this.value.analog === value.analog && this.value.rightAnalog === value.rightAnalog) return;
    this.value = { ...value }; this.onChange?.(this.state());
  }
  sample() {
    if (!this.focused()) { this.publish(NEUTRAL); return; }
    let buttons = 0;
    for (const key of this.keys) buttons |= KEYS[key] || 0;
    // The first connected standard controller owns axes; keyboard buttons
    // can coexist without inventing analog values from digital keys.
    const pad = this.pads()[0];
    if (pad) for (let index = 0; index < PAD_BUTTONS.length; index++) {
      if (pad.buttons[index]?.pressed) buttons |= PAD_BUTTONS[index];
    }
    const packed = offset => pad
      ? (axis(pad.axes[offset], this.deadzone) << 8) | axis(pad.axes[offset + 1], this.deadzone)
      : 0x8080;
    this.publish({ buttons, analog: packed(0), rightAnalog: packed(2) });
  }
  poll() {
    if (this.raf !== null || !this.focused() || !this.pads().length) return;
    this.raf = this.environment.requestAnimationFrame(() => {
      this.raf = null; this.sample(); this.poll();
    });
  }
  stopPoll() {
    if (this.raf !== null) this.environment.cancelAnimationFrame(this.raf);
    this.raf = null;
  }
  setActive(value) {
    this.active = !!value;
    if (!this.active) this.blur();
    else { this.sample(); this.poll(); }
  }
  dispose() {
    if (this.disposed) return;
    this.setActive(false); this.disposed = true;
    this.canvas.removeEventListener("keydown", this.keyDown);
    this.canvas.removeEventListener("focus", this.focus);
    this.canvas.removeEventListener("blur", this.blur);
    for (const [name, listener] of [["keyup", this.keyUp], ["blur", this.blur], ["focus", this.focus],
      ["gamepadconnected", this.deviceChanged], ["gamepaddisconnected", this.deviceChanged]]) {
      this.environment.removeEventListener(name, listener);
    }
    if (this.originalTabIndex === null) this.canvas.removeAttribute?.("tabindex");
    else this.canvas.setAttribute?.("tabindex", this.originalTabIndex);
  }
}

module.exports = { BrowserGameInput, BTN };
