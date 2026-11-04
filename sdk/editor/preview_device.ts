import { DEFAULT_DEVICE } from "@open-wxa/wxa-runner-core";

/** Same pinned profile used by the official WeChat runner. Shell measurements
 * come from its PhoneShell presentation CSS, not from a second layout engine. */
export const previewDevice = Object.freeze({
  ...DEFAULT_DEVICE,
  safeArea: Object.freeze({ top: DEFAULT_DEVICE.statusBarHeight, right: 0, bottom: DEFAULT_DEVICE.safeAreaBottom, left: 0 }),
  shell: Object.freeze({
    bezel: 13,
    borderRadius: 40,
    notchWidth: 209,
    notchHeight: 30,
    homeIndicatorWidth: 134,
    homeIndicatorHeight: 5,
    homeIndicatorBottom: 8,
  }),
});
