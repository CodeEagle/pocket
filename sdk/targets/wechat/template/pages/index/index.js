const { PocketWechatHost } = require("../../wechat-host.js");
const config = require("../../pocket.config.js");

Page({
  data: { screenWidth: 1, screenHeight: 1, input: { visible: false }, error: "" },
  onLoad() {
    this._active = false;
    this._disposed = false;
    this._touches = new Map();
    this._keyboardHeight = 0;
    this._host = null;
    const base = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this._width = Math.max(1, Math.floor(base.windowWidth));
    this._height = Math.max(1, Math.floor(base.windowHeight));
    this._dpr = Math.min(4, Math.max(1, Math.floor(base.pixelRatio || 1)));
    this._setCanvasSize(this._width, this._height);
    if (wx.onKeyboardHeightChange) {
      this._keyboardListener = ({ height = 0 } = {}) => {
        this._keyboardHeight = Math.max(0, Number(height) || 0);
        const nextHeight = Math.max(1, this._height - this._keyboardHeight);
        this._setCanvasSize(this._width, nextHeight);
        this._host?.resize(this._width, nextHeight);
        this._host?.wake();
      };
      wx.onKeyboardHeightChange(this._keyboardListener);
    }
    if (wx.onWindowResize) {
      this._resizeListener = ({ size } = {}) => {
        if (!size) return;
        this._width = Math.max(1, Math.floor(size.windowWidth));
        this._height = Math.max(1, Math.floor(size.windowHeight));
        this._setCanvasSize(this._width, Math.max(1, this._height - this._keyboardHeight));
        this._host?.resize(this._width, Math.max(1, this._height - this._keyboardHeight));
        this._host?.wake();
      };
      wx.onWindowResize(this._resizeListener);
    }
    this._createHost();
  },
  onShow() {
    this._active = true;
    this._host?.show();
  },
  onHide() {
    const cancelled = [...this._touches.values()].map((touch) => ({ surface: 0, id: touch.id >>> 0, x: touch.x, y: touch.y, cancelled: true }));
    this._touches.clear();
    if (cancelled.length) this._host?.inputFrame(cancelled);
    this._active = false;
    this._host?.hide();
  },
  onUnload() {
    this._disposed = true;
    if (this._keyboardListener && wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._keyboardListener);
    if (this._resizeListener && wx.offWindowResize) wx.offWindowResize(this._resizeListener);
    this._host?.dispose();
    this._host = null;
  },
  _setCanvasSize(width, height) {
    this.setData({ screenWidth: width, screenHeight: height });
  },
  _createHost() {
    if (!wx.WXWebAssembly || typeof wx.WXWebAssembly.instantiate !== "function") {
      this.setData({ error: "PocketJS requires WeChat base library 2.14.0 or newer (WXWebAssembly with Brotli WASM paths)." });
      return;
    }
    wx.createSelectorQuery().in(this).select("#pocket-canvas").fields({ node: true, size: true }).exec((result) => {
      if (this._disposed || !result || !result[0] || !result[0].node) return;
      const canvas = result[0].node;
      const context = canvas.getContext("2d");
      this._host = new PocketWechatHost({
        wx,
        config,
        canvas,
        context,
        onInput: (input) => this.setData({ input }),
        onError: (error) => this.setData({ error: String(error && error.message || error) }),
        isActive: () => this._active && !this._disposed,
      });
      this._host.start(this._width, Math.max(1, this._height - this._keyboardHeight), this._dpr)
        .then(() => { if (this._active) this._host.show(); })
        .catch((error) => this.setData({ error: String(error && error.message || error) }));
    });
  },
  _contacts(event, cancelChanged) {
    const changed = (event.changedTouches || []).map((touch) => ({
      id: Number(touch.identifier ?? touch.id ?? 0),
      x: Number(touch.x ?? touch.clientX ?? 0),
      y: Number(touch.y ?? touch.clientY ?? 0),
    }));
    const active = (event.touches || []).map((touch) => ({
      id: Number(touch.identifier ?? touch.id ?? 0),
      x: Number(touch.x ?? touch.clientX ?? 0),
      y: Number(touch.y ?? touch.clientY ?? 0),
    }));
    const type = event.type;
    if (type === "touchstart" || type === "touchmove") {
      for (const touch of active) this._touches.set(touch.id, touch);
    } else if (type === "touchend") {
      for (const touch of changed) this._touches.delete(touch.id);
      for (const touch of active) this._touches.set(touch.id, touch);
    } else if (type === "touchcancel") {
      for (const touch of changed) this._touches.delete(touch.id);
    }
    const cancelledIds = new Set(type === "touchcancel" && cancelChanged ? changed.map((touch) => touch.id) : []);
    const contacts = [...this._touches.values()].map((touch) => ({ surface: 0, id: touch.id >>> 0, x: touch.x, y: touch.y, cancelled: cancelledIds.has(touch.id) }));
    for (const touch of changed) {
      if (cancelledIds.has(touch.id)) contacts.push({ surface: 0, id: touch.id >>> 0, x: touch.x, y: touch.y, cancelled: true });
    }
    this._host?.inputFrame(contacts);
  },
  onTouchStart(event) { this._contacts(event, false); },
  onTouchMove(event) { this._contacts(event, false); },
  onTouchEnd(event) { this._contacts(event, false); },
  onTouchCancel(event) { this._contacts(event, true); },
  onImeInput(event) {
    this._host?.imeEdit(event.detail || {});
  },
  onImeConfirm(event) {
    this._host?.imeSubmit(event.detail || {});
    if (wx.hideKeyboard) wx.hideKeyboard({ complete: () => {} });
  },
  onImeBlur(event) {
    this._host?.imeDismiss(event.detail || {});
  },
});
