// PocketSystem transport only. App policy, stack, LRU and transitions remain
// in the existing JS SystemUI kernel inside the real QuickJS Guest.
const { decodeMessage } = require("./binary-bridge.js");

class PocketWechatSystem {
  constructor(root, createHost) {
    this.root = root;
    root.instanceId = 'system-ui';
    root.runtimeGeneration = 1;
    this.createHost = createHost;
    this.apps = root.config.system.apps;
    this.runtimes = new Map();
    this.pending = new Map();
    this.captures = new Map();
    this.sequence = 0;
    this.generation = 1;
    this.compositing = false;
    this.configured = false;
    this.disposed = false;
  }

  handles(capability) {
    return capability.startsWith('system.runtime.') || capability.startsWith('system.storage.') ||
      capability.startsWith('platform.apps.') || capability.startsWith('platform.storage.') || capability.startsWith('platform.messages.') ||
      isWechatBuiltinCapability(capability);
  }

  async request(source, request, signal) {
    const cap = request.capability;
    const p = request.params || {};
    if (this.disposed) throw this.root.error('cancelled', 'System disposed');
    if (isWechatBuiltinCapability(cap)) {
      return wechatBuiltinCapability(source, cap, p);
    }
    if (cap.startsWith('system.')) {
      if (source !== this.root) throw this.root.error('system_context_denied', 'System controls are restricted to SystemUI');
      if (cap === 'system.runtime.configure') {
        if (p.systemUI !== this.root.config.appId) throw this.root.error('system_context_denied', 'SystemUI does not match the project');
        this.configured = true;
        return { systemInstanceId: 'system-ui', generation: 1 };
      }
      if (!this.configured) throw this.root.error('system_not_configured', 'SystemUI must configure its runtime first');
      if (cap === 'system.runtime.prepareOpen') {
        const runtime = this.instance(p.instanceId);
        if (!runtime || runtime === this.root) throw this.root.error('runtime_destroyed', 'App runtime is not live');
        if (Number(p.generation) !== runtime.runtimeGeneration) throw this.root.error('runtime_destroyed', 'App generation is no longer live');
        // The generated WeChat package has no trusted OTA resolver. Keep the
        // resident Guest and generation unchanged instead of claiming an
        // update was configured or applied.
        return {
          instanceId: runtime.instanceId,
          appId: runtime.config.appId,
          previousGeneration: runtime.runtimeGeneration,
          generation: runtime.runtimeGeneration,
          updated: false,
          configured: false,
        };
      }
      if (cap === 'system.runtime.create') {
        const app = this.apps.find(app => app.appId === p.appId && app.index !== 0);
        if (!app) throw this.root.error('app_not_found', 'App is outside the installed project catalog');
        if (this.runtimes.has(app.appId)) throw this.root.error('runtime_exists', 'App runtime already exists');
        const runtime = this.createHost(app, this);
        runtime.instanceId = `wechat-${++this.sequence}`;
        runtime.runtimeGeneration = ++this.generation;
        this.runtimes.set(app.appId, runtime);
        try {
          // Headless children still render at the root's physical density.
          // Passing 1 here silently produced a low-resolution child raster on
          // Retina/HiDPI devices even though the root Canvas was scaled.
          await runtime.start(this.root.logicalWidth, this.root.logicalHeight, this.root.scale || 1);
          if (signal.aborted || this.disposed || runtime.disposed) throw this.root.error('cancelled', 'App launch cancelled');
          runtime.started = true;
          runtime.stopScheduled();
          runtime.visible = false;
          return {
            instanceId: runtime.instanceId,
            appId: app.appId,
            generation: runtime.runtimeGeneration,
            ...(p.prepareForOpen === true ? { preparedForOpen: true } : {}),
          };
        } catch (error) {
          this.runtimes.delete(app.appId);
          runtime.dispose();
          throw error;
        }
      }
      if (cap === 'system.runtime.awaitFirstFrame') {
        const runtime = this.instance(p.instanceId);
        if (!runtime || runtime === this.root || Number(p.generation) !== runtime.runtimeGeneration) throw this.root.error('runtime_destroyed', 'App generation is no longer live');
        // Native boot already rendered the first frame. Upload it before
        // acknowledging so SystemUI reveals a real child raster, never a stub.
        this.upload(runtime);
        return { ready: true, generation: runtime.runtimeGeneration };
      }
      if (cap === 'system.runtime.destroy') {
        const runtime = this.instance(p.instanceId);
        if (!runtime || runtime === this.root) throw this.root.error('runtime_destroyed', 'App runtime is not live');
        this.runtimes.delete(runtime.config.appId);
        this.root.exports.web_free_surface(this.root.host, runtime.config.surfaceHandle);
        this.rejectSource(runtime);
        for (const [id, capture] of this.captures) if (capture.runtime === runtime) this.captures.delete(id);
        runtime.dispose();
        return { destroyed: true };
      }
      if (cap === 'system.runtime.post') {
        const runtime = this.instance(p.instanceId);
        if (!runtime || typeof p.event !== 'string') throw this.root.error('runtime_destroyed', 'App event target is not live');
        runtime.deliverGuestEvent(p.event, p.params || {});
        return { accepted: true };
      }
      if (cap === 'system.runtime.respond') {
        const pending = this.pending.get(p.requestId);
        if (!pending) return { accepted: true, stale: true };
        this.pending.delete(p.requestId);
        pending.cleanup();
        if (p.ok === true) pending.resolve(p.value === undefined ? null : p.value);
        else pending.reject(this.root.error(p.error?.code || 'system_request_failed', p.error?.message || 'SystemUI rejected the request'));
        return { accepted: true };
      }
      if (cap.startsWith('system.storage.')) {
        const receiver = { wx: this.root.wx, config: { appId: p.namespace ? '__shared__' : p.appId },
          error: this.root.error, storageKey: this.root.storageKey };
        return this.root.storage.call(receiver, cap.replace('system.storage.', 'platform.storage.'), p);
      }
      throw this.root.error('unsupported', `Unsupported System transport: ${cap}`);
    }
    if (!this.configured) throw this.root.error('system_not_configured', 'SystemUI is not ready');
    return new Promise((resolve, reject) => {
      const requestId = `wechat-system-${++this.sequence}`;
      const abort = () => { this.pending.delete(requestId); reject(this.root.error('cancelled', 'System request cancelled')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort);
      this.pending.set(requestId, { source, resolve, reject, cleanup });
      try {
        this.root.deliverGuestEvent('system.request', {
          requestId, sourceAppId: source.config.appId,
          sourceInstanceId: source === this.root ? 'system-ui' : source.instanceId,
          sourceGeneration: source === this.root ? 1 : source.runtimeGeneration,
          capability: cap, params: p,
        });
      } catch (error) { this.pending.delete(requestId); cleanup(); reject(error); }
    });
  }

  instance(id) { return id === 'system-ui' ? this.root : [...this.runtimes.values()].find(runtime => runtime.instanceId === id); }

  frames() {
    const root = this.root;
    root.check(root.exports.web_compositor_frames(root.host), 'System compositor frames unavailable');
    const bytes = new Uint8Array(root.exports.memory.buffer, root.exports.web_result_ptr(root.host), root.exports.web_result_len(root.host));
    const packet = decodeMessage(bytes);
    if (!Array.isArray(packet.frames)) throw root.error('render_failed', 'Invalid binary compositor frame packet');
    return packet.frames;
  }

  upload(runtime) {
    if (runtime.disposed || !runtime.exports || runtime.surfaceUploaded && !runtime.surfaceDirty) return;
    const density = Math.max(1, Number(runtime.scale || this.root.scale || 1));
    const width = runtime.logicalWidth, height = runtime.logicalHeight;
    const physicalWidth = Math.max(1, Math.ceil(width * density));
    const physicalHeight = Math.max(1, Math.ceil(height * density));
    const pointer = runtime.exports.web_capture(runtime.host, density, 2);
    if (!pointer) throw this.root.error('render_failed', 'Child raster capture failed');
    const bytes = new Uint8Array(runtime.exports.memory.buffer, pointer, physicalWidth * physicalHeight * 4);
    const root = this.root;
    const buffer = root.exports.web_alloc(bytes.length);
    if (!buffer) throw root.error('allocation_failed', 'System surface allocation failed');
    try {
      new Uint8Array(root.exports.memory.buffer, buffer, bytes.length).set(bytes);
      const handle = root.exports.web_wechat_upload_surface(root.host, runtime.config.surfaceHandle, buffer, bytes.length, physicalWidth, physicalHeight, density);
      if (handle !== runtime.config.surfaceHandle) throw root.error('render_failed', 'System surface upload failed');
      runtime.surfaceUploaded = true;
      runtime.surfaceDirty = false;
    } finally { root.exports.web_free(buffer, bytes.length); }
  }

  composite() {
    if (this.compositing || this.disposed || !this.root.exports) return 0;
    this.compositing = true;
    try {
      const frames = this.frames();
      for (const runtime of this.runtimes.values()) {
        const candidates = frames.filter(frame => frame.handle === runtime.config.surfaceHandle);
        const slot = candidates.find(frame => frame.focused) || candidates[0];
        runtime.mounted = !!slot;
        if (slot && slot.full[2] > 0 && slot.full[3] > 0) {
          runtime.resize(Math.ceil(slot.full[2]), Math.ceil(slot.full[3]));
          if (slot.focused && this.root.visible && !runtime.visible) runtime.show();
          else if (!slot.focused && runtime.visible) runtime.hide();
          this.upload(runtime);
        } else if (runtime.started && runtime.visible) runtime.hide();
      }
      return this.root.exports.web_capture(this.root.host, this.root.scale, 3);
    } finally { this.compositing = false; }
  }

  childFrame(runtime) {
    runtime.surfaceDirty = true;
    if (runtime.mounted && !this.compositing && !this.disposed && this.root.exports) this.root.draw();
  }

  input(contacts) {
    const rootContacts = [], childContacts = new Map();
    const live = new Set(contacts.filter(contact => !contact.cancelled).map(contact => contact.id));
    const frames = this.frames();
    for (const contact of contacts) {
      let target = this.captures.get(contact.id);
      if (!target) {
        const handle = this.root.exports.web_wechat_hit_surface(this.root.host, contact.x, contact.y);
        const slot = frames.find(frame => frame.handle === handle && frame.focused);
        const runtime = slot && [...this.runtimes.values()].find(child => child.config.surfaceHandle === handle);
        target = runtime ? { runtime, full: [...slot.full] } : { runtime: this.root };
        this.captures.set(contact.id, target);
      }
      if (target.runtime === this.root) rootContacts.push(contact);
      else {
        const list = childContacts.get(target.runtime) || [];
        list.push({ ...contact, x: contact.x - target.full[0], y: contact.y - target.full[1] });
        childContacts.set(target.runtime, list);
      }
    }
    for (const target of this.captures.values()) if (target.runtime !== this.root && !childContacts.has(target.runtime)) childContacts.set(target.runtime, []);
    for (const [id] of this.captures) if (!live.has(id)) this.captures.delete(id);
    for (const [runtime, input] of childContacts) runtime.inputFrame(input);
    this.root.advance(rootContacts);
    this.root.schedule();
  }

  suspend() { for (const runtime of this.runtimes.values()) if (runtime.visible) runtime.hide(); }

  rejectSource(source) {
    for (const [id, pending] of this.pending) if (pending.source === source) {
      this.pending.delete(id); pending.cleanup(); pending.reject(this.root.error('runtime_destroyed', 'App runtime destroyed'));
    }
  }

  dispose() {
    this.disposed = true;
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(this.root.error('cancelled', 'System disposed')); }
    this.pending.clear(); this.captures.clear();
  }
}
const BUILTIN_CAPABILITIES = new Set(['runtime.info', 'runtime.performance', 'plugins.list', 'plugins.packageInfo', 'updates.status']);
function isWechatBuiltinCapability(capability) { return BUILTIN_CAPABILITIES.has(capability); }
function wechatBuiltinCapability(source, capability, params = {}) {
    const value = source.config.metadata;
    const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const appId = String(source.config.appId);
    const qjbc = metadata.qjbc && typeof metadata.qjbc === 'object' && !Array.isArray(metadata.qjbc)
      ? metadata.qjbc : {};
    const version = metadata.version === undefined ? qjbc.version : metadata.version;
    const build = metadata.build === undefined ? qjbc.build : metadata.build;
    if (capability === 'runtime.info') {
      return {
        appId,
        provider: 'wechat',
        host: 'wechat',
        source: 'embedded',
        entryFormat: qjbc.entryFormat || 'quickjs-bytecode',
        runtimeAbi: qjbc.runtimeAbi || null,
        engineAbi: qjbc.engineAbi || null,
        version: version === undefined ? null : version,
        build: build === undefined ? null : build,
        entryBytes: qjbc.bytecodeBytes === undefined ? null : qjbc.bytecodeBytes,
        tickHz: source?.config?.tickHz || qjbc.tickHz || 60,
        hostRuntime: 'WXWebAssembly + Canvas2D',
        logicalWidth: Number(source?.logicalWidth || 0),
        logicalHeight: Number(source?.logicalHeight || 0),
        scale: Number(source?.scale || 1),
        assetRasterDensity: Number(source.config.rasterDensity || source.system?.root?.config?.rasterDensity || 1),
        nativeFlutterTiming: false,
        features: { recording: false, flutterFrameTiming: false, nativeHardware: false },
      };
    }
    if (capability === 'runtime.performance') {
      return {
        supported: false,
        nativeFlutterTiming: false,
        provider: 'wechat',
        reason: 'WXWebAssembly target does not expose Flutter FrameTiming',
        context: params && params.context === undefined ? null : (params || {}).context,
      };
    }
    if (capability === 'plugins.list') {
      return { protocolVersion: 1, appId, provider: 'wechat', plugins: [] };
    }
    if (capability === 'plugins.packageInfo') {
      const packageInfo = metadata.package && typeof metadata.package === 'object' && !Array.isArray(metadata.package)
        ? metadata.package : {};
      let miniProgram = {};
      try {
        const account = source?.wx?.getAccountInfoSync?.();
        if (account?.miniProgram && typeof account.miniProgram === 'object') {
          const value = account.miniProgram;
          miniProgram = {
            ...(value.appId === undefined ? {} : { appId: String(value.appId) }),
            ...(value.envVersion === undefined ? {} : { envVersion: String(value.envVersion) }),
            ...(value.version === undefined ? {} : { version: String(value.version) }),
          };
        }
      } catch (_) { /* Older base libraries may not expose account metadata. */ }
      return {
        provider: 'wechat',
        appId,
        appName: packageInfo.name || packageInfo.title || appId,
        packageName: appId,
        version: version === undefined ? null : version,
        buildNumber: build === undefined || build === null ? null : String(build),
        // Guest package identity and the WeChat container identity are kept
        // separate; a container appId must never replace the Pocket appId.
        miniProgram,
      };
    }
    if (capability === 'updates.status') {
      const active = { version: version === undefined ? null : version, build: build === undefined ? null : build, source: 'embedded', active: true };
      return {
        configured: false,
        stage: 'disabled',
        activeVersion: active.version,
        activeBuild: active.build,
        availableVersion: null,
        preparedUpdate: null,
        versions: [active],
        lastError: null,
        provider: 'wechat',
      };
    }
    throw source.error('unsupported', `Unsupported WeChat builtin capability: ${capability}`);
}

module.exports = { PocketWechatSystem, wechatBuiltinCapability, isWechatBuiltinCapability };
