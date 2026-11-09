import { after, simulationHz, virtualNow } from "@pocketjs/framework/clock";
import type { EngineSnapshot, NovelEngine } from "./types.ts";
import type { NovelAnimationDriver } from "./models.ts";
import { voiceBlocksAutoAdvance } from "./voice.ts";

export function novelNeedsClock(snapshot: EngineSnapshot): boolean {
  if (snapshot.paused || snapshot.phase === "ready" || snapshot.phase === "disposed") return false;
  const active = snapshot.active;
  return Boolean(snapshot.stage.transition && snapshot.stage.transition.elapsedMs < snapshot.stage.transition.durationMs)
    || Boolean(snapshot.stage.camera.motion && snapshot.stage.camera.motion.elapsedMs < snapshot.stage.camera.motion.durationMs)
    || Boolean(snapshot.stage.timeline)
    || active?.kind === "wait"
    || (active?.kind === "choice" && active.timeRemainingMs !== null)
    || (active?.kind === "say" && (active.pause != null
      ? active.pause.remainingMs !== null
      : (!active.complete
        || (snapshot.preferences.mode === "auto" && (active.autoRemainingMs !== 0 || !voiceBlocksAutoAdvance(snapshot.voice)))
        || (snapshot.preferences.mode === "skip" && (!snapshot.preferences.skipSeenOnly || snapshot.meta.readLineIds.includes(active.id))))));
}

/** Uses Pocket's virtual deadlines, so manual reading sleeps between inputs. */
export function attachNovelClock(engine: NovelEngine, options: { animations?: NovelAnimationDriver } = {}): () => void {
  let cancel: (() => void) | undefined;
  let disposed = false;
  const schedule = (snapshot: EngineSnapshot): void => {
    cancel?.(); cancel = undefined;
    const animate = !snapshot.paused && snapshot.phase !== "ready" && snapshot.phase !== "disposed" && options.animations?.needsClock();
    if (disposed || (!novelNeedsClock(snapshot) && !animate)) return;
    const started = virtualNow();
    cancel = after(1 / simulationHz(), () => {
      cancel = undefined;
      if (!disposed) {
        const delta = (virtualNow() - started) * 1000;
        if (!engine.getSnapshot().paused) options.animations?.advance(delta);
        // A model-only frame has no narrative time to advance. Avoid rebuilding
        // the story snapshot and notifying every subscriber while reading.
        if (novelNeedsClock(engine.getSnapshot())) engine.tick(delta);
        // A model can move while the narrative snapshot stays unchanged.
        if (!cancel) schedule(engine.getSnapshot());
      }
    });
  };
  const unsubscribe = engine.subscribe(update => schedule(update.snapshot), { emitCurrent: true });
  const removeAnimations = options.animations?.subscribe(() => schedule(engine.getSnapshot()));
  return () => { disposed = true; cancel?.(); cancel = undefined; unsubscribe(); removeAnimations?.(); };
}
