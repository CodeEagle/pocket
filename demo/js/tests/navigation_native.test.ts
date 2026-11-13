import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { backIconPoint } from "./navigation_geometry.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOp,
  textOps,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const width = 390;
const height = 760;

function findVisibleText(frame: Frame, label: string, predicate?: (op: DrawOp) => boolean): DrawOp | undefined {
  return textOps(frame, label).find((op) => {
    const top = op.y ?? -Infinity;
    const bottom = top + (op.h ?? 0);
    const clipTop = Math.max(0, op.clip?.y ?? 0);
    const clipBottom = Math.min(frame.height ?? height,
      (op.clip?.y ?? 0) + (op.clip?.h ?? Infinity));
    const inViewport = top >= clipTop && bottom <= clipBottom;
    return inViewport && (predicate?.(op) ?? true);
  });
}

async function settle(session: NativeSession, frame: Frame): Promise<Frame> {
  return session.settle(frame, 16);
}

async function settleUntilVisibleText(
  session: NativeSession,
  frame: Frame,
  label: string,
  maxFrames = 60,
): Promise<Frame> {
  let latest = frame;
  for (let index = 0; index < maxFrames; index += 1) {
    if (findVisibleText(latest, label)) return latest;
    latest = await session.frame();
  }
  assert.fail(`timed out waiting for ${label} to become visible\n${textOf(latest)}`);
}

async function settleAnchor(
  session: NativeSession,
  frame: Frame,
  label: string,
  predicate?: (op: DrawOp) => boolean,
): Promise<Frame> {
  let latest = frame;
  let previousY: number | undefined;
  let stableFrames = 0;
  for (let index = 0; index < 120; index += 1) {
    const anchor = textOps(latest, label).find(predicate ?? (() => true));
    if (!anchor) {
      stableFrames = 0;
      latest = await session.frame();
      continue;
    }
    const currentY = anchor.y;
    if (typeof currentY === "number" && previousY !== undefined && Math.abs(currentY - previousY) <= 0.1) {
      stableFrames += 1;
      if (stableFrames >= 3) return latest;
    } else {
      stableFrames = 0;
    }
    previousY = currentY;
    latest = await session.frame();
  }
  assert.fail(`timed out waiting for ${label} to settle\n${textOf(latest)}`);
}

async function revealVisibleText(
  session: NativeSession,
  frame: Frame,
  label: string,
  fromY = 350,
  toY = 650,
): Promise<{ frame: Frame; op: DrawOp }> {
  let latest = frame;
  let visible = findVisibleText(latest, label);
  for (let attempt = 0; !visible && attempt < 5; attempt += 1) {
    latest = await settle(session, await session.drag({ x: 8, y: fromY }, { x: 8, y: toY }, 12, 12));
    visible = findVisibleText(latest, label);
  }
  assert.ok(visible, `${label} must be reachable after a real page scroll`);
  return { frame: latest, op: visible! };
}

async function openMobileUi(session: NativeSession, frame: Frame): Promise<Frame> {
  const revealed = await revealVisibleText(session, frame, "Mobile UI");
  return settle(session, await session.tapPoint(center(revealed.op, "Mobile UI")));
}

async function popSecondary(session: NativeSession, frame: Frame): Promise<Frame> {
  // TransitionsPage also owns a body button labelled "Back". Remove that
  // unrelated text op only for the app-bar geometry helper; the chevron
  // triangle assertion remains intact.
  const geometryFrame: Frame = {
    ...frame,
    ops: (frame.ops ?? []).filter((op) => !(op.type === "text" && op.text === "Back")),
  };
  return settle(session, await session.tapPoint(backIconPoint(geometryFrame)));
}

test("native route stack preserves page scroll/local state and isolates popped routes", { timeout: 30_000 }, async () => {
  const artifacts = readNativeArtifacts();

  // Home has a real scroll extent. Push Mobile UI with its painted card and
  // pop it through the secondary app-bar icon; the Home scroller must return
  // at the same offset instead of remounting at zero.
  const homeSession = new NativeSession(artifacts, { width, height });
  try {
    let frame = await homeSession.boot();
    const initialPlayground = textOp(frame, "Playground");
    frame = await homeSession.settle(
      await homeSession.drag({ x: 195, y: 650 }, { x: 195, y: 600 }, 12),
      120,
    );
    const scrolledPlayground = textOp(frame, "Playground");
    assert.ok(
      scrolledPlayground.y! < initialPlayground.y! - 20,
      `Home pointer drag must change the Playground coordinate (${initialPlayground.y} -> ${scrolledPlayground.y})`,
    );
    frame = await settle(homeSession, await homeSession.tap("UI", frame, (op) => (op.y ?? 0) > (frame.height ?? height) - 100));
    assert.match(textOf(frame), /UI Collection/);
    frame = await settleAnchor(homeSession, await homeSession.tap("Home", frame, (op) => (op.y ?? 0) > (frame.height ?? height) - 100), "Playground");
    const restoredFromPrimaryTab = textOp(frame, "Playground");
    assert.ok(
      Math.abs(restoredFromPrimaryTab.y! - scrolledPlayground.y!) <= 2,
      `Home scroll offset was not restored after primary UI tab switch (${scrolledPlayground.y} -> ${restoredFromPrimaryTab.y})`,
    );
    const homeCard = await revealVisibleText(homeSession, frame, "Mobile UI");
    frame = await settleAnchor(homeSession, homeCard.frame, "Mobile UI");
    const homeBeforePush = frame;
    frame = await settle(homeSession, await homeSession.tapPoint(center(textOp(frame, "Mobile UI"), "Mobile UI")));
    assert.match(textOf(frame), /Mobile UI/);
    assert.ok(textOps(frame, "Scaffold + AppBar").length, `Mobile UI did not open: ${JSON.stringify(textOp(homeBeforePush, "Mobile UI"))}\n${textOf(frame)}`);
    const initialMobileAnchor = textOp(frame, "Scaffold + AppBar");
    // Pause the real contact before release so a fling cannot carry this
    // top-of-page anchor outside the clip as the showcase grows below it.
    frame = await settleAnchor(homeSession, await homeSession.drag({ x: 8, y: 600 }, { x: 8, y: 560 }, 12, 12), "Scaffold + AppBar");
    const scrolledMobileAnchor = textOp(frame, "Scaffold + AppBar");
    assert.ok(
      scrolledMobileAnchor.y! < initialMobileAnchor.y! - 20,
      `Mobile UI pointer drag must move the active page (${initialMobileAnchor.y} -> ${scrolledMobileAnchor.y})`,
    );
    frame = await settleAnchor(homeSession, await popSecondary(homeSession, frame), "Mobile UI");
    const restoredHomeCard = textOp(frame, "Mobile UI");
    assert.ok(
      Math.abs(restoredHomeCard.y! - textOp(homeBeforePush, "Mobile UI").y!) <= 2,
      `Home scroll offset was not restored after Mobile UI pop (${textOp(homeBeforePush, "Mobile UI").y} -> ${restoredHomeCard.y})`,
    );
  } finally {
    await homeSession.quit();
  }

  // Mobile UI owns local signals for its selected section, switch, stepper,
  // input and scroller. Push a new route after changing all of them, then pop
  // with the real back chevron and assert that the same JS subtree is active.
  const stateSession = new NativeSession(artifacts, { width, height });
  try {
    let frame = await stateSession.boot();
    frame = await openMobileUi(stateSession, frame);
    frame = await settle(stateSession, await stateSession.tap("Controls", frame, (op) => (op.y ?? 0) < 150));
    assert.equal(textOps(frame, "Scaffold + AppBar").length, 0, "Controls selection must hide the overview section");

    frame = await settle(stateSession, await stateSession.tap("Enabled", frame));
    assert.ok(findVisibleText(frame, "Disabled"), "switch must visibly turn off");
    assert.ok(findVisibleText(frame, "3"), "stepper must start at three");
    frame = await settle(stateSession, await stateSession.tap("+", frame));
    frame = await settle(stateSession, await stateSession.tap("+", frame));
    assert.ok(findVisibleText(frame, "5"), "both pointer taps must increment the visible stepper");

    let input = findVisibleText(frame, "System keyboard input");
    if (!input) {
      frame = await settle(stateSession, await stateSession.drag({ x: 8, y: 650 }, { x: 8, y: 420 }, 12, 12));
      input = findVisibleText(frame, "System keyboard input");
    }
    assert.ok(input, "Mobile UI input must be reachable after a real page scroll");
    frame = await stateSession.tapPoint(center(input, "System keyboard input"));
    let openEvent = (frame.events ?? []).find((item) => item.name === "textInput.open");
    if (!openEvent) {
      frame = await stateSession.frame();
      openEvent = (frame.events ?? []).find((item) => item.name === "textInput.open");
    }
    assert.ok(openEvent?.payload, "Mobile UI input must emit textInput.open from a real pointer tap");
    const inputId = String(openEvent!.payload!.id);
    const editingSession = String(openEvent!.payload!.editingSession);
    stateSession.sendEvent("textInput.edit", {
      id: inputId,
      editingSession,
      revision: 1,
      text: "navigation draft",
      selectionBase: 16,
      selectionExtent: 16,
      composingBase: -1,
      composingExtent: -1,
    });
    frame = await stateSession.frame();
    stateSession.sendEvent("textInput.submit", {
      id: inputId,
      editingSession,
      revision: 2,
      text: "navigation draft",
      selectionBase: 16,
      selectionExtent: 16,
      composingBase: -1,
      composingExtent: -1,
    });
    frame = await settle(stateSession, await stateSession.frame());
    const draftLabel = await revealVisibleText(stateSession, frame, "Draft · navigation draft", 650, 420);
    frame = await settleAnchor(stateSession, draftLabel.frame, "Draft · navigation draft");
    const draftBeforePush = textOp(frame, "Draft · navigation draft");

    stateSession.sendEvent("demo.navigate", { route: "transitions" });
    frame = await settle(stateSession, await stateSession.frame());
    assert.match(textOf(frame), /Route stack/);
    assert.match(textOf(frame), /transitions/);
    assert.doesNotMatch(textOf(frame), /More actions|Reset control state/, "Mobile UI overlays must not paint on Transitions");

    frame = await settleAnchor(stateSession, await popSecondary(stateSession, frame), "Draft · navigation draft");
    assert.equal(textOps(frame, "Scaffold + AppBar").length, 0, "selected Mobile UI section was lost after Transitions pop");
    const draftAfterPop = textOp(frame, "Draft · navigation draft");
    assert.ok(
      Math.abs(draftAfterPop.y! - draftBeforePush.y!) <= 2,
      `Mobile UI scroll offset was not restored after Transitions pop (${draftBeforePush.y} -> ${draftAfterPop.y})`,
    );
    // Check restoration before scrolling to controls above the retained draft.
    // The expanded form showcase can place that summary outside the clip.
    frame = (await revealVisibleText(stateSession, frame, "State · off · level 5 · layout adaptive")).frame;
    assert.match(textOf(frame), /State · off · level 5 · layout adaptive/);
  } finally {
    await stateSession.quit();
  }

  // Explicitly open the Mobile UI popup, push Transitions, and prove that the
  // cached inactive route cannot leak its overlay into the new route. Then
  // change Transitions' local progress, pop it, and push it again: a popped
  // secondary route must be destroyed rather than resurrecting its progress.
  const popupSession = new NativeSession(artifacts, { width, height });
  try {
    let frame = await popupSession.boot();
    frame = await openMobileUi(popupSession, frame);
    frame = await settle(popupSession, await popupSession.tap("Feedback", frame, (op) => (op.y ?? 0) < 150));
    let openPopup = findVisibleText(frame, "Open Popup");
    for (let attempt = 0; !openPopup && attempt < 5; attempt += 1) {
      frame = await settle(popupSession, await popupSession.drag({ x: 195, y: 650 }, { x: 195, y: 390 }, 12));
      openPopup = findVisibleText(frame, "Open Popup");
    }
    assert.ok(openPopup, "Mobile UI popup control must be reachable after a real page scroll");
    frame = await settleUntilVisibleText(
      popupSession,
      await popupSession.tapPoint(center(openPopup, "Open Popup")),
      "More actions",
    );
    assert.match(textOf(frame), /More actions/);

    popupSession.sendEvent("demo.navigate", { route: "transitions" });
    frame = await settle(popupSession, await popupSession.frame());
    assert.doesNotMatch(textOf(frame), /More actions|Reset control state/, "inactive Mobile UI popup leaked into Transitions");

    for (let index = 0; index < 5; index += 1) {
      frame = await settle(popupSession, await popupSession.tap("+", frame));
    }
    assert.match(textOf(frame), /Progress 60%/);

    frame = await popSecondary(popupSession, frame);
    popupSession.sendEvent("demo.navigate", { route: "transitions" });
    frame = await settle(popupSession, await popupSession.frame());
    assert.match(textOf(frame), /Progress 55%/, "popped Transitions route must reset its local progress on re-push");
    assert.doesNotMatch(textOf(frame), /More actions|Reset control state/, "inactive Mobile UI popup leaked into re-pushed Transitions");
  } finally {
    await popupSession.quit();
  }

  // A delayed native camera start may resolve after Hardware has been popped.
  // The app-level route gate must stop that late preview instead of leaving a
  // live texture owned by an inactive/destroyed secondary route.
  const hardwareSession = new NativeSession(artifacts, {
    width,
    height,
    deferCapabilities: ["hardware.camera.preview.start"],
  });
  try {
    let frame = await hardwareSession.boot();
    hardwareSession.sendEvent("demo.navigate", { route: "hardware" });
    frame = await settle(hardwareSession, await hardwareSession.frame());
    let startPreview = findVisibleText(frame, "Start preview");
    for (let attempt = 0; !startPreview && attempt < 5; attempt += 1) {
      frame = await settle(hardwareSession, await hardwareSession.drag({ x: 195, y: 650 }, { x: 195, y: 360 }, 12));
      startPreview = findVisibleText(frame, "Start preview");
    }
    assert.ok(startPreview, "Hardware preview control must be reachable after a real page scroll");
    frame = await hardwareSession.tapPoint(center(startPreview, "Start preview"));
    assert.ok(
      hardwareSession.requests.some((request) => request.capability === "hardware.camera.preview.start"),
      "Start preview pointer must emit the native capability request",
    );

    frame = await popSecondary(hardwareSession, frame);
    hardwareSession.respondPending("hardware.camera.preview.start", {
      lens: "back",
      textureId: 1,
      width: 640,
      height: 480,
    });
    for (let index = 0; index < 8; index += 1) frame = await hardwareSession.frame();
    assert.ok(
      hardwareSession.requests.some((request) => request.capability === "hardware.camera.preview.stop"),
      "late camera preview start after Hardware pop must emit preview.stop",
    );
  } finally {
    await hardwareSession.quit();
  }
});

test("Apple Glass is a secondary UI route and returns to the four primary tabs", { timeout: 30_000 }, async () => {
  const artifacts = readNativeArtifacts();
  const session = new NativeSession(artifacts, { width, height });
  try {
    let frame = await session.boot();
    const navBottom = (op: DrawOp): boolean => (op.y ?? 0) > (frame.height ?? height) - 90;

    textOp(frame, "Home", navBottom);
    textOp(frame, "UI", navBottom);
    textOp(frame, "Host", navBottom);
    textOp(frame, "Settings", navBottom);

    frame = await session.tap("UI", frame, navBottom);
    frame = await session.settle(frame);
    assert.match(textOf(frame), /UI Collection/);

    const appleEntry = await revealVisibleText(session, frame, "Open Apple Glass");
    frame = await session.settle(session.tapPoint(center(appleEntry.op, "Open Apple Glass")));
    assert.match(textOf(frame), /Apple Glass/);
    for (const label of ["Home", "UI", "Host", "Settings"]) {
      assert.equal(
        textOps(frame, label).some((op) => (op.y ?? 0) > (frame.height ?? height) - 90),
        false,
        `secondary Apple Glass route must hide the primary ${label} tab`,
      );
    }

    frame = await session.settle(session.tapPoint(backIconPoint(frame)));
    assert.match(textOf(frame), /UI Collection/);
    for (const label of ["Home", "UI", "Host", "Settings"]) textOp(frame, label, navBottom);
  } finally {
    await session.quit();
  }
});
