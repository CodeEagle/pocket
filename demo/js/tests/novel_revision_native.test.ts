import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { decodeNovelSaveData } from "../../../sdk/packages/pocket_vn/src/save-codec.ts";
import type { ActiveNovelState, NovelSaveData } from "../../../sdk/packages/pocket_vn/src/types.ts";
import { NativeSession, readNativeArtifacts, textOf, type Frame } from "./native_session.ts";

type RevisionFixture = {
  provenance: {
    bytecodeSha256: string;
    pakSha256: string;
    storyVersion?: number;
    saveFormatVersion?: number;
    activeLineId?: string;
    activeLocation?: { label: string; index: number };
    selectedOptionId?: string;
    inputPath?: string[];
    bytecodeMetadata?: {
      sourceSha256?: string;
      payloadSha256?: string;
      bytecodeBytes?: number;
    };
  };
  storage: Record<string, unknown>;
};

const fixtureInputs = [
  {
    name: "v1",
    storyVersion: 1,
    bytecodeSha256: "748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc",
    pakSha256: "9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1",
    path: "fixtures/lantern-v1-native-save.json",
    activeId: "memory_response",
  },
  {
    name: "v2",
    storyVersion: 2,
    bytecodeSha256: "06656d13ac04a7ceec9931b79c0933dbe6f2b513d48137ca4ba4cb3c6f3e7694",
    pakSha256: "d499c3e7152d42d28bfbcefc1dcc970c62e5f58f36216510fea5d404aa19e323",
    path: "fixtures/lantern-v2-native-save.json",
    activeId: "memory_record_01",
  },
  {
    name: "v3",
    storyVersion: 3,
    bytecodeSha256: "57ba6efd2632292c58c1ff3858b61ee21615e490d5266d8517d5d4e861be511c",
    pakSha256: "bcbe0d4c8c3a32919209c5ffa91980f1a3c7a658955aed7c998c6535196b357b",
    path: "fixtures/lantern-v3-native-save.json",
    activeId: "memory_record_01",
  },
  {
    name: "v4",
    storyVersion: 4,
    bytecodeSha256: "396b07fcebbfc2c74915b220fd685f3fa276fb4f2b3ec900d51a5987158b6329",
    pakSha256: "3d775a1fc3e773d17d73d3d45e73618adbd2a2fa52d5d4785e839fc7bcf48876",
    path: "fixtures/lantern-v4-native-save.json",
    activeId: "memory_record_01",
  },
  {
    name: "v5",
    storyVersion: 5,
    bytecodeSha256: "f40f9d690e6621f98ac69ce0d505fa8c6ae741cc984fec612361ef9342d3167a",
    pakSha256: "339305235efc0b42f98853f6f046a343929533fd30bbea83b738c6817eb8e47f",
    path: "fixtures/lantern-v5-native-save.json",
    activeId: "memory_record_01",
  },
] as const;

const target = JSON.parse(readFileSync(resolve(import.meta.dir, "../apps/lantern/story.json"), "utf8")) as {
  id: string;
  version: number;
};
const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
const key = "lantern.slot.auto";
const normalized = (text: string) => text.replace(/\s/g, "");
const activeId = (active: ActiveNovelState | null) => active && "id" in active ? active.id : undefined;

for (const input of fixtureInputs) {
  const fixture = JSON.parse(
    readFileSync(resolve(import.meta.dir, input.path), "utf8"),
  ) as RevisionFixture;

  test(
    `native game migrates the real story-v${input.storyVersion} save into revision ${target.version} and retains rollback and call returns`,
    async () => {
      assert.ok(Number.isInteger(target.version), "the built story must declare an integer revision");
      const storage = structuredClone(fixture.storage);
      const legacy = decodeNovelSaveData(storage[key]);
      assert.equal(legacy.storyVersion, input.storyVersion);
      assert.equal(fixture.provenance.bytecodeSha256, input.bytecodeSha256);
      assert.equal(fixture.provenance.pakSha256, input.pakSha256);
      assert.equal(activeId(legacy.state.active), input.activeId);
      assert.equal(legacy.state.callStack.length, 1);
      assert.ok(
        target.version > legacy.storyVersion,
        `fixture v${legacy.storyVersion} must be migrated by the current story revision ${target.version}`,
      );

      if (input.storyVersion === 2) {
        assert.equal(fixture.provenance.storyVersion, 2);
        assert.equal(fixture.provenance.saveFormatVersion, 4);
        assert.equal(fixture.provenance.activeLineId, "memory_record_01");
        assert.deepEqual(fixture.provenance.activeLocation, { label: "memory_record", index: 0 });
        assert.equal(fixture.provenance.selectedOptionId, "keep_record");
        assert.equal(fixture.provenance.inputPath?.length, 5);
        assert.equal(fixture.provenance.bytecodeMetadata?.bytecodeBytes, 1_058_003);
        assert.match(fixture.provenance.bytecodeMetadata?.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
        assert.match(fixture.provenance.bytecodeMetadata?.payloadSha256 ?? "", /^[a-f0-9]{64}$/);
      }

      if (input.storyVersion === 3) {
        assert.equal(fixture.provenance.storyVersion, 3);
        assert.equal(fixture.provenance.saveFormatVersion, 4);
        assert.equal(fixture.provenance.activeLineId, "memory_record_01");
        assert.deepEqual(fixture.provenance.activeLocation, { label: "memory_record", index: 1 });
        assert.equal(fixture.provenance.bytecodeMetadata?.bytecodeBytes, 1_063_700);
        assert.equal(fixture.provenance.inputPath?.length, 5);
      }

      if (input.storyVersion === 4) {
        assert.equal(fixture.provenance.storyVersion, 4);
        assert.equal(fixture.provenance.saveFormatVersion, 4);
        assert.equal(fixture.provenance.activeLineId, "memory_record_01");
        assert.deepEqual(fixture.provenance.activeLocation, { label: "memory_record", index: 1 });
        assert.equal(fixture.provenance.selectedOptionId, "keep_record");
        assert.equal(fixture.provenance.inputPath?.length, 7);
        assert.equal(fixture.provenance.bytecodeMetadata?.bytecodeBytes, 1_062_816);
        assert.equal(fixture.provenance.bytecodeMetadata?.sourceSha256, "18e665536a2c9b70fee5d580c01208726fa65e71e3e12024cbf678131d4a4a3c");
        assert.equal(fixture.provenance.bytecodeMetadata?.payloadSha256, "2fbcb690279133df5fbb2b4f890c64a96fa67602d6a47f1989bd42902603de76");
      }

      const session = new NativeSession(artifacts, {
        width: 360,
        height: 640,
        storage,
        deadlineMs: 90_000,
      });
      const current = () => decodeNovelSaveData(session.storage[key]);
      const waitFor = async (
        initial: Frame,
        predicate: (save: NovelSaveData) => boolean,
      ): Promise<Frame> => {
        let frame = initial;
        for (let attempt = 0; attempt < 300; attempt++) {
          if (predicate(current())) return frame;
          frame = await session.frame();
        }
        throw new Error(
          `revision input did not settle: ${JSON.stringify(current().state.active)}; ${textOf(frame)}`,
        );
      };
      const advanceUntil = async (
        initial: Frame,
        predicate: (save: NovelSaveData) => boolean,
        description: string,
        maxInputs = 500,
      ): Promise<Frame> => {
        let frame = initial;
        for (let attempt = 0; attempt < maxInputs; attempt++) {
          const save = current();
          if (predicate(save)) return frame;
          if (save.state.active?.kind === "say") {
            frame = await session.tapPoint({ x: 180, y: 550 });
          } else if (save.state.active?.kind === "wait") {
            frame = await session.frame();
          } else {
            throw new Error(
              `cannot advance toward ${description} from ${JSON.stringify(save.state.active)}; ${textOf(frame)}`,
            );
          }
        }
        throw new Error(`did not reach ${description}; active=${JSON.stringify(current().state.active)}; ${textOf(frame)}`);
      };

      try {
        let frame = await session.boot();
        frame = await session.tap("续写 · 继续旅程", frame);
        frame = await waitFor(
          frame,
          save => save.storyVersion === target.version && activeId(save.state.active) === input.activeId,
        );
        let migrated = current();
        assert.deepEqual(migrated.state.variables, legacy.state.variables);
        assert.deepEqual(migrated.state.meta.readLineIds, legacy.state.meta.readLineIds);
        assert.deepEqual(migrated.state.meta.persistentVariables, legacy.state.meta.persistentVariables);
        assert.deepEqual(migrated.state.meta.musicIds, legacy.state.meta.musicIds);
        assert.deepEqual(migrated.state.meta.endingIds, legacy.state.meta.endingIds);
        assert.deepEqual(migrated.state.meta.cgIds, legacy.state.meta.cgIds);
        assert.deepEqual(migrated.state.backlog.map(line => line.lineId), legacy.state.backlog.map(line => line.lineId));
        assert.equal(migrated.state.rollbackHistory.length, legacy.state.rollbackHistory.length);
        assert.equal(migrated.state.callStack[0]?.returnTo.label, "arrival.listen_mira");
        if (input.storyVersion < 3) {
          assert.notEqual(
            migrated.state.active?.location.index,
            legacy.state.active?.location.index,
            "v1/v2 fixtures exercise instruction positions shifted by revision 3",
          );
        } else {
          assert.equal(migrated.state.active?.location.index, legacy.state.active?.location.index,
            `v${input.storyVersion}->v5 migration should preserve this memory instruction address`);
        }
        assert.equal(migrated.state.location.index, migrated.state.active!.location.index + 1);
        const migratedAtAnchor = migrated;

        const previousId = activeId(legacy.state.rollbackHistory.at(-1)!.active);
        assert.ok(previousId, "fixture history must retain its preceding dialogue identity");
        if (input.storyVersion >= 2) {
          // This fixture starts inside the keep_record call. Resume through its
          // return to the hub, then use real rollback inputs to reach the
          // pre-branch dialogue and play forward to the original choice again.
          frame = await advanceUntil(
            frame,
            save => activeId(save.state.active) === "investigation_hub",
            "investigation hub after returning from memory_record",
          );
          if (input.storyVersion === 4) {
            assert.equal(current().state.meta.persistentVariables?.record_mira, true,
              "resuming the v4 Mira call must reach the new persistent collection-unlock instruction before its jump");
          }
          for (let attempt = 0; attempt < 80 && activeId(current().state.active) !== previousId; attempt++) {
            frame = await session.tap("回溯", frame);
          }
          assert.equal(activeId(current().state.active), previousId,
            "real rollback from the hub should reach the saved pre-branch dialogue");
        } else {
          frame = await session.tap("回溯", frame);
          frame = await waitFor(
            frame,
            save => save.state.active?.kind === "say" && save.state.active.id === previousId,
          );
        }
        assert.equal(current().state.callStack.length, 1, "rollback keeps the remapped subroutine return");

        frame = await advanceUntil(
          frame,
          save => save.state.active?.kind === "choice" && save.state.active.id === "memory_response",
          "the original memory_response choice after rollback",
        );
        migrated = current();
        assert.equal(migrated.state.active?.kind, "choice");
        const choice = migrated.state.active;
        const option = choice?.kind === "choice"
          ? choice.options.find(value => value.id === "trust_mira")
          : undefined;
        assert.ok(option);
        frame = await session.tap(option.text, frame);
        frame = await advanceUntil(
          frame,
          save => activeId(save.state.active) === "investigation_hub",
          "investigation hub after selecting the original trust_mira option",
        );
        assert.equal(current().state.callStack.length, 0);
        assert.ok(normalized(textOf(frame)).includes("雾港末班信"));
        console.log("NATIVE_STORY_REVISION", JSON.stringify({
          sourceStoryVersion: legacy.storyVersion,
          sourceLocation: legacy.state.active?.location,
          targetStoryVersion: migratedAtAnchor.storyVersion,
          migratedLocation: migratedAtAnchor.state.active?.location,
          originalReturnTo: migratedAtAnchor.state.callStack[0]?.returnTo,
          rollbackTarget: previousId,
          selectedOption: option.id,
          finalActiveId: activeId(current().state.active),
          finalCallStackDepth: current().state.callStack.length,
          preserved: {
            variableCount: Object.keys(migratedAtAnchor.state.variables).length,
            persistentVariableCount: Object.keys(migratedAtAnchor.state.meta.persistentVariables).length,
            readLineCount: migratedAtAnchor.state.meta.readLineIds.length,
            backlogLineCount: migratedAtAnchor.state.backlog.length,
            rollbackEntryCount: migratedAtAnchor.state.rollbackHistory.length,
            musicIds: migratedAtAnchor.state.meta.musicIds,
            endingIds: migratedAtAnchor.state.meta.endingIds,
            cgIds: migratedAtAnchor.state.meta.cgIds,
          },
        }));
      } finally {
        await session.quit();
      }
    },
    120_000,
  );
}
