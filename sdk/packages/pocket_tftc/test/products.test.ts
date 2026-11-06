import { expect, test } from "bun:test";
import {
  DATA_KEYS,
  PRODUCT_IDS,
  getProductProfile,
  productSupports,
  resolveProductCommands,
  resolveProductOperation,
} from "../src/products.js";

const pairs = (result: any) => result.writes.map((write: any) => [write.code, write.value]);

test("resolves PT3MAX app identifiers without guessing a broadcast PID", () => {
  expect(getProductProfile(PRODUCT_IDS.DKPT3MAX)?.name).toBe("DK-PT3MAX");
  expect(getProductProfile("PT3MAX")?.id).toBe(PRODUCT_IDS.DKPT3MAX);
  expect(getProductProfile(0x00012101)).toBeNull();
});

test("PT3MAX clamps levels and maps zero to standby switches", () => {
  const result = resolveProductCommands(PRODUCT_IDS.DKPT3MAX, [
    ["SUCTION_LEVEL", 99],
    ["VIBRATION_LEVEL", 0],
    ["SUCTION_AMP", 4],
    ["VIBRATION_AMP", 101],
    ["VIBRATION_SWITCH", 0],
  ]);
  expect(pairs(result)).toEqual([
    [DATA_KEYS.SUCTION_LEVEL, 4],
    [DATA_KEYS.VIBRATION_SWITCH, 2],
    [DATA_KEYS.SUCTION_AMP, 1],
    [DATA_KEYS.VIBRATION_AMP, 100],
    [DATA_KEYS.VIBRATION_SWITCH, 2],
  ]);
  expect(result.batches).toHaveLength(1);
  expect(result.unsupported).toEqual([]);
});

test("PT3MAX pause and resume independently preserve app switch semantics", () => {
  const paused = resolveProductOperation("DKPT3MAX", "pause", {
    vibrationSwitch: 1,
    suctionSwitch: 1,
  });
  expect(pairs(paused)).toEqual([
    [DATA_KEYS.VIBRATION_SWITCH, 2],
    [DATA_KEYS.SUCTION_SWITCH, 2],
  ]);
  const resumed = resolveProductOperation("DKPT3MAX", "resume", {
    vibrationSwitch: 2,
    suctionSwitch: 2,
  });
  expect(pairs(resumed)).toEqual([
    [DATA_KEYS.VIBRATION_SWITCH, 1],
    [DATA_KEYS.SUCTION_SWITCH, 1],
  ]);
});

test("PT3MAX all stop is the documented custom FF write", () => {
  const result = resolveProductOperation("DKPT3MAX", "stop");
  expect(pairs(result)).toEqual([[DATA_KEYS.CUSTOM_FF, 0]]);
  expect(result.writes[0].standalone).toBe(false);
});

test("NAV command normalization keeps FE and FF standalone", () => {
  const result = resolveProductCommands("DK-ASTP", [
    ["CUSTOM_FE", 7],
    ["VIBRATION_LEVEL", 0],
    ["TELESCOPIC_LEVEL", 10],
    ["VIBRATION_AMP", 101],
    ["CUSTOM_FF", 99],
  ]);
  expect(pairs(result)).toEqual([
    [DATA_KEYS.CUSTOM_FE, 1],
    [DATA_KEYS.VIBRATION_SWITCH, 2],
    [DATA_KEYS.TELESCOPIC_LEVEL, 9],
    [DATA_KEYS.VIBRATION_AMP, 100],
    [DATA_KEYS.CUSTOM_FF, 0],
  ]);
  expect(result.writes.map((write: any) => write.standalone)).toEqual([true, false, false, false, true]);
  expect(result.batches.map((batch: any[]) => batch.length)).toEqual([1, 3, 1]);
});

test("NAV switch values follow documented running/pause states", () => {
  const result = resolveProductCommands(PRODUCT_IDS.DKASTP, {
    VIBRATION_SWITCH: 1,
    TELESCOPIC_SWITCH: 0,
  });
  expect(pairs(result)).toEqual([
    [DATA_KEYS.VIBRATION_SWITCH, 3],
    [DATA_KEYS.TELESCOPIC_SWITCH, 2],
  ]);
});

test("NAV pause uses all-stop during burst mode and switches otherwise", () => {
  const burst = resolveProductOperation("NAV", "pause", { customFE: 1, vibrationSwitch: 1, telescopicSwitch: 1 });
  expect(pairs(burst)).toEqual([[DATA_KEYS.CUSTOM_FF, 0]]);
  expect(burst.writes[0].standalone).toBe(true);
  const ordinary = resolveProductOperation("NAV", "pause", { customFE: 0, vibrationSwitch: 1, telescopicSwitch: 1 });
  expect(pairs(ordinary)).toEqual([
    [DATA_KEYS.VIBRATION_SWITCH, 2],
    [DATA_KEYS.TELESCOPIC_SWITCH, 2],
  ]);
});

test("NAV resume uses value 3 only for paused motors", () => {
  const result = resolveProductOperation("DKASTP", "resume", { vibrationSwitch: 2, telescopicSwitch: 1 });
  expect(pairs(result)).toEqual([[DATA_KEYS.VIBRATION_SWITCH, 3]]);
});

test("unknown products and operations are explicit unsupported results", () => {
  const unknown = resolveProductCommands("DK-UNKNOWN", [["VIBRATION_LEVEL", 1]]);
  expect(unknown.writes).toEqual([]);
  expect(unknown.unsupported[0].reason).toBe("unsupported_product");
  const unsupported = resolveProductOperation(PRODUCT_IDS.DKPT3MAX, "scan");
  expect(unsupported.unsupported[0].reason).toBe("unsupported_operation");
  expect(productSupports(PRODUCT_IDS.DKASTP, "pause")).toBe(true);
  expect(productSupports(PRODUCT_IDS.DKASTP, "scan")).toBe(false);
});
