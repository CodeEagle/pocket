import { describe, expect, test } from "bun:test";
import { createManualTimers } from "../src/state/env.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createSelfUpdate, type UpdateBackend, type UpdateStatus } from "../src/state/self-update.ts";
import { flush } from "./fake_client.ts";

const base: UpdateStatus = { configured: true, stage: "ready", activeVersion: "0.1.0", activeBuild: 1, preparedUpdate: null, lastError: null };

function harness(over: Partial<UpdateBackend> & { status?: UpdateStatus; checked?: UpdateStatus } = {}) {
  const calls: string[] = [];
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const backend: UpdateBackend = {
    status: async () => { calls.push("status"); return over.status ?? base; },
    check: async () => { calls.push("check"); return over.checked ?? base; },
    apply: async () => { calls.push("apply"); return { scheduled: true, version: "0.1.0-test.2" }; },
    ...(over.ready ? { ready: over.ready } : {}),
    ...(over.check ? { check: over.check } : {}),
    ...(over.apply ? { apply: over.apply } : {}),
  };
  const update = createSelfUpdate({ backend, toasts });
  return { update, calls, toasts };
}

describe("self-update", () => {
  test("load shows the host's facts; an unconfigured host is reported as unavailable, never as success", async () => {
    const h = harness();
    await h.update.load();
    expect(h.update.state()).toMatchObject({ phase: "idle", activeVersion: "0.1.0", activeBuild: 1, stage: "ready" });
    const off = harness({ status: { ...base, configured: false, stage: "not_configured" } });
    await off.update.load();
    expect(off.update.state().phase).toBe("unavailable");
    expect(off.update.state().message).toContain("未配置");
    const none = createSelfUpdate({ toasts: createToasts(createManualTimers()) });
    await none.load();
    expect(none.state().phase).toBe("unavailable");
    await none.check();
    await none.apply();
    expect(none.state().phase).toBe("unavailable");
  });

  test("check finds a higher signed build; apply is only possible after a check found one", async () => {
    const h = harness({ checked: { ...base, preparedUpdate: { version: "0.1.0-test.2", build: 2 } } });
    await h.update.apply();
    expect(h.calls).toEqual([]);
    await h.update.check();
    expect(h.update.state()).toMatchObject({ phase: "available", candidateVersion: "0.1.0-test.2", candidateBuild: 2 });
    await h.update.apply();
    expect(h.calls).toEqual(["check", "apply"]);
    expect(h.update.state().phase).toBe("applying");
  });

  test("a candidate equal to the active package is not an update", async () => {
    const h = harness({ checked: { ...base, preparedUpdate: { version: "0.1.0", build: 1 } } });
    await h.update.check();
    expect(h.update.state().phase).toBe("current");
    expect(h.update.state().candidateVersion).toBeUndefined();
  });

  test("check and apply failures are shown and toasted; they never become a success", async () => {
    const failing = harness({ check: async () => { throw Object.assign(new Error("signature invalid"), { code: "manifest-signature" }); } });
    await failing.update.check();
    expect(failing.update.state()).toMatchObject({ phase: "error", message: "manifest-signature: signature invalid" });
    expect(failing.toasts.items().some((t) => t.tone === "danger" && t.message.includes("检查 Studio 更新失败"))).toBe(true);
    const applyFails = harness({
      checked: { ...base, preparedUpdate: { version: "0.1.0-test.2", build: 2 } },
      apply: async () => { throw Object.assign(new Error("busy"), { code: "busy" }); },
    });
    await applyFails.update.check();
    await applyFails.update.apply();
    expect(applyFails.update.state().phase).toBe("error");
    expect(applyFails.toasts.items().some((t) => t.message.includes("应用 Studio 更新失败"))).toBe(true);
  });

  test("a rolled-back build keeps the host's last error visible next to the running version", async () => {
    const h = harness({ status: { ...base, activeVersion: "0.1.0-test.2", activeBuild: 2, lastError: "Guest crashed at startup" } });
    await h.update.load();
    expect(h.update.state()).toMatchObject({ phase: "idle", activeBuild: 2, lastError: "Guest crashed at startup" });
  });

  test("a restored handoff toasts once; a failed handoff is ignored", async () => {
    const ok = harness({ ready: Promise.resolve(true) });
    await flush();
    expect(ok.toasts.items().some((t) => t.message.includes("界面状态已恢复"))).toBe(true);
    const no = harness({ ready: Promise.reject(new Error("storage")) });
    await flush();
    expect(no.toasts.items()).toHaveLength(0);
    const unchanged = harness({ ready: Promise.resolve(false) });
    await flush();
    expect(unchanged.toasts.items()).toHaveLength(0);
  });
});
