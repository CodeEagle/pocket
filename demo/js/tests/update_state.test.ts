import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { initialDemoState, type DemoState, type Route } from "../state.ts";
import { showcaseUpdateState } from "../update-state.ts";

const routes = new Set<Route>([
  "home", "gallery", "about", "bytecode", "updates", "plugins", "stress",
  "performance", "mobile", "transitions", "hardware", "video", "settings",
]);

function parseRoute(value: unknown): Route | undefined {
  return typeof value === "string" && routes.has(value as Route) ? value as Route : undefined;
}

function storage() {
  return {
    get: async () => undefined,
    set: async () => undefined,
    remove: async () => undefined,
  };
}

test("showcase update state migrates only portable UI fields", () => {
  let state: DemoState = initialDemoState();
  state.mobileDark = true;
  state.accentColor = "rose";
  state.interfaceDensity = "touch";
  state.runtimeInfo = {
    phase: "ready",
    requestId: "runtime-1",
    result: { provider: "native" },
    error: null,
  };
  state.cameraPreview = {
    phase: "ready",
    lens: "back",
    surfaceId: 42,
    width: 390,
    height: 844,
  };
  const options = showcaseUpdateState(storage(), () => state, (update) => { state = update(state); }, parseRoute);

  assert.deepEqual(options.capture(), {
    routeStack: ["home"],
    count: 0,
    draft: "",
    selectedComponent: null,
    detailsOpen: false,
    lazyVisible: false,
    transitionMode: "IOS_SPRING_PARALLAX",
  });

  assert.equal(options.restore({
    routeStack: ["home", "gallery"],
    count: 7,
    draft: "portable draft",
    selectedComponent: "Card",
    detailsOpen: true,
    lazyVisible: true,
    transitionMode: "SHARED_AXIS_Z",
    mobileDark: false,
    accentColor: "blue",
    runtimeInfo: { phase: "idle" },
    cameraPreview: { phase: "idle", surfaceId: 1 },
  }), true);
  assert.equal(state.route, "gallery");
  assert.deepEqual(state.routeStack, ["home", "gallery"]);
  assert.equal(state.count, 7);
  assert.equal(state.draft, "portable draft");
  assert.equal(state.selectedComponent, "Card");
  assert.equal(state.detailsOpen, true);
  assert.equal(state.lazyVisible, true);
  assert.equal(state.transitionMode, "SHARED_AXIS_Z");
  assert.equal(state.mobileDark, true);
  assert.equal(state.accentColor, "rose");
  assert.equal(state.interfaceDensity, "touch");
  assert.equal(state.runtimeInfo.requestId, "runtime-1");
  assert.equal(state.cameraPreview.surfaceId, 42);
});

test("showcase update state rejects unsupported routes and malformed records", () => {
  let state: DemoState = initialDemoState();
  const options = showcaseUpdateState(storage(), () => state, (update) => { state = update(state); }, parseRoute);
  const before = options.capture();

  assert.equal(options.restore({
    routeStack: ["home", "not-a-demo-route"],
    count: 1,
    draft: "bad route",
    selectedComponent: null,
    detailsOpen: false,
    lazyVisible: false,
    transitionMode: "IOS_SPRING_PARALLAX",
  }), false);
  assert.equal(options.restore({
    routeStack: ["home"],
    count: 1.5,
    draft: "bad count",
    selectedComponent: null,
    detailsOpen: false,
    lazyVisible: false,
    transitionMode: "IOS_SPRING_PARALLAX",
  }), false);
  assert.equal(options.restore({
    routeStack: new Array(33).fill("home"),
    count: 1,
    draft: "too deep",
    selectedComponent: null,
    detailsOpen: false,
    lazyVisible: false,
    transitionMode: "IOS_SPRING_PARALLAX",
  }), false);
  assert.deepEqual(options.capture(), before);
});
