import { expect, test } from "bun:test";
import { BrowserGameInput, BTN } from "../../targets/web/game_input.js";
import { BTN as OFFICIAL_BTN } from "../../.cache/pocketjs/contracts/spec/spec.ts";

class Surface extends EventTarget {
  tabIndex = -1;
  attributes = new Map<string, string>();
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); this.tabIndex = -1; }
}
function setup() {
  const canvas = new Surface();
  const environment = new EventTarget() as any;
  const callbacks = new Map<number, () => void>();
  let id = 0;
  const pads: any[] = [];
  environment.document = { activeElement: canvas, hasFocus: () => true };
  environment.navigator = { getGamepads: () => pads };
  environment.requestAnimationFrame = (callback: () => void) => { callbacks.set(++id, callback); return id; };
  environment.cancelAnimationFrame = (id: number) => callbacks.delete(id);
  const changes: any[] = [];
  const input = new BrowserGameInput({ canvas, environment, onChange: (state: any) => changes.push(state) });
  const key = (type: string, code: string, target: EventTarget = canvas, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { code, ...extra });
    target.dispatchEvent(event); return event;
  };
  const tick = () => { const current = [...callbacks.values()]; callbacks.clear(); for (const callback of current) callback(); };
  return { canvas, environment, callbacks, pads, changes, input, key, tick };
}

test("keyboard facts preserve official bits, aliases, release and focus ownership", () => {
  expect(BTN).toEqual(OFFICIAL_BTN);
  const { input, canvas, environment, changes, key } = setup();
  expect(key("keydown", "KeyZ").defaultPrevented).toBe(false);
  input.setActive(true);
  key("keydown", "KeyZ"); key("keydown", "Space");
  expect(input.state().buttons).toBe(BTN.CROSS);
  expect(changes).toHaveLength(1); // repeat/aliases do not synthesize new edges
  key("keyup", "KeyZ", environment);
  expect(input.state().buttons).toBe(BTN.CROSS);
  key("keyup", "Space", environment);
  expect(input.state().buttons).toBe(0);
  expect(key("keydown", "KeyZ", canvas, { isComposing: true }).defaultPrevented).toBe(false);
  expect(key("keydown", "KeyZ", canvas, { ctrlKey: true }).defaultPrevented).toBe(false);
  key("keydown", "ArrowDown"); canvas.dispatchEvent(new Event("blur"));
  expect(input.state().buttons).toBe(0);
  environment.document.activeElement = {};
  key("keydown", "KeyZ"); expect(input.state().buttons).toBe(0);
  input.dispose();
  expect(canvas.tabIndex).toBe(-1);
});

test("standard controller axes, deadzone, disconnect and visibility release use one device fact stream", () => {
  const { input, pads, environment, callbacks, key, tick } = setup();
  pads.push({ connected: true, mapping: "standard", axes: [-1, 1, 0.1, -0.1],
    buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: index === 0 || index === 15 })) });
  input.setActive(true);
  expect(input.state()).toEqual({ buttons: BTN.CROSS | BTN.RIGHT, analog: 0x00ff, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(1);
  key("keydown", "ArrowLeft");
  pads[0].connected = false; tick();
  expect(input.state()).toEqual({ buttons: BTN.LEFT, analog: 0x8080, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(0);
  input.setActive(false);
  expect(input.state().buttons).toBe(0);
  input.dispose();
  environment.dispatchEvent(new Event("gamepadconnected"));
  expect(callbacks.size).toBe(0);
});

test("unknown controller mappings are not advertised through fabricated standard axes", () => {
  const { input, pads, callbacks } = setup();
  pads.push({ connected: true, mapping: "", axes: [1, 1], buttons: [{ pressed: true }] });
  input.setActive(true);
  expect(input.state()).toEqual({ buttons: 0, analog: 0x8080, rightAnalog: 0x8080 });
  expect(callbacks.size).toBe(0);
  input.dispose();
});
