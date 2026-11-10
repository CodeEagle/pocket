import { test, expect } from "bun:test";
import { createPocketBackNavigation } from "../src/back-navigation.ts";
import type { BridgeObject, HostEvent } from "../src/host.ts";

function harness() {
  let listener: ((event: HostEvent) => void) | undefined;
  const responses: { method: string; params?: BridgeObject }[] = [];
  const navigation = createPocketBackNavigation({
    onEvent(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    emit(method, params) {
      responses.push({ method, params });
      return true;
    },
  });
  return {
    navigation,
    responses,
    request(requestId: string) {
      listener?.({ method: "platform.back.request", params: { requestId } });
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("back requests report consumption, unhandled requests and failures on the event lane", async () => {
  const h = harness();
  h.request("unregistered");
  await flush();
  let pages = ["root", "details"];
  h.navigation.setHandler(() => {
    if (pages.length === 1) return false;
    pages.pop();
    return true;
  });
  h.request("details");
  await flush();
  expect(pages).toEqual(["root"]);
  h.request("root");
  await flush();
  h.navigation.setHandler(async () => { throw new Error("page disposed"); });
  h.request("failed");
  await flush();
  expect(h.responses).toEqual([
    { method: "platform.back.response", params: { requestId: "unregistered", handled: false } },
    { method: "platform.back.response", params: { requestId: "details", handled: true } },
    { method: "platform.back.response", params: { requestId: "root", handled: false } },
    { method: "platform.back.response", params: { requestId: "failed", handled: false } },
  ]);
  h.navigation.dispose();
});

test("disposing a back handler suppresses a late response and removes its listener", async () => {
  const h = harness();
  let finish!: (value: boolean) => void;
  h.navigation.setHandler(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  h.request("pending");
  await flush();
  h.navigation.dispose();
  finish(true);
  h.request("after-dispose");
  await flush();
  expect(h.responses).toEqual([]);
});
