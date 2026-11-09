import { expect, test } from "bun:test";
import { createNovelEngine } from "../src/engine.ts";
import { parseNovelManuscript, MANUSCRIPT_MAX_LINES } from "../src/manuscript.ts";

test("manuscript retains source lines, Unicode, unknown colon text and collision-free canonical dialogue", () => {
  const result = parseNovelManuscript("\uFEFF23:08，灯还亮着。\r\n\r\nMira：别把回声当成答案。\r\n【陌生人】我看见了你。🕯️\r\nhttps://example.test/a\r\n未登记：保留整行", {
    idPrefix: "chapter", speakerNames: ["Mira"], existingLineIds: ["chapter_0001"],
  });
  expect(result.sourceLines).toEqual([1, 3, 4, 5, 6]);
  expect(result.instructions?.map(line => line.id)).toEqual(["chapter_0002", "chapter_0003", "chapter_0004", "chapter_0005", "chapter_0006"]);
  expect(result.instructions?.[0]?.text).toBe("23:08，灯还亮着。");
  expect(result.instructions?.[1]?.speaker).toBe("Mira");
  expect(result.instructions?.[2]).toMatchObject({ speaker: "陌生人", text: "我看见了你。🕯️" });
  expect(result.instructions?.[3]?.text).toBe("https://example.test/a");
  expect(result.instructions?.[4]?.text).toBe("未登记：保留整行");
  expect(result.diagnostics).toHaveLength(1);
  const engine = createNovelEngine({ id: "manuscript", version: 1, start: "chapter", script: { chapter: result.instructions! } });
  try {
    engine.newGame(); engine.advance(); engine.advance();
    expect(engine.getSnapshot().active).toMatchObject({ kind: "say", speaker: "Mira", text: "别把回声当成答案。" });
  } finally { engine.dispose(); }
});

test("malformed or bounded input never returns a partial chapter", () => {
  for (const input of ["\n\t", "before\n【Mira】", "a\0b", "x".repeat(1_000_001), Array(MANUSCRIPT_MAX_LINES + 1).fill("line").join("\n")]) {
    const result = parseNovelManuscript(input, { idPrefix: "chapter" });
    expect(result.instructions).toBeUndefined();
    expect(result.diagnostics.some(item => item.severity === "error")).toBe(true);
  }
  expect(parseNovelManuscript("a", { idPrefix: "../chapter" }).instructions).toBeUndefined();
});
