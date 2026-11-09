import { expect, test } from "bun:test";
import { novelSayRichIssue, resolveNovelSayRich } from "../src/rich-text.ts";

test("rich annotations use code-point ranges and map whole placeholders through interpolation", () => {
  const source = "港口{{name}}的灯";
  const resolved = resolveNovelSayRich(source, { name: "灯🌙", station: "北岸" }, {
    spans: [{
      id: "name-note",
      start: 2,
      end: 10,
      style: { color: "accent", emphasis: "strong" },
      ruby: "あかり",
      link: { title: "{{station}}记录", text: "{{station}}的灯在等你。" },
    }],
    pauses: [{ id: "after-name", at: 10, durationMs: null }],
  });

  expect(resolved.text).toBe("港口灯🌙的灯");
  expect(resolved.rich).toEqual({
    spans: [{
      id: "name-note", start: 2, end: 4,
      style: { color: "accent", emphasis: "strong" },
      ruby: "あかり",
      link: { title: "北岸记录", text: "北岸的灯在等你。" },
    }],
    pauses: [{ id: "after-name", at: 4, durationMs: null }],
  });
});

test("rich annotations reject overlapping ranges, duplicate IDs, and placeholder-splitting boundaries", () => {
  expect(novelSayRichIssue("ABCDE", {
    spans: [{ id: "first", start: 0, end: 3 }, { id: "second", start: 2, end: 4 }], pauses: [],
  })).toContain("重叠");
  expect(novelSayRichIssue("ABCDE", {
    spans: [{ id: "same", start: 0, end: 1 }], pauses: [{ id: "same", at: 3, durationMs: null }],
  })).toContain("重复");
  expect(() => resolveNovelSayRich("港{{name}}口", { name: "灯" }, {
    spans: [{ id: "split", start: 3, end: 8 }], pauses: [],
  })).toThrow("cannot split a {{variable}} placeholder");
});

test("empty whole-placeholder annotations disappear while pause boundaries stay mapped", () => {
  const resolved = resolveNovelSayRich("港{{name}}口", { name: "" }, {
    spans: [{ id: "empty", start: 1, end: 9, link: { title: "Note", text: "Hidden" } }],
    pauses: [{ id: "after-name", at: 9, durationMs: 25 }],
  });
  expect(resolved).toEqual({ text: "港口", rich: { spans: [], pauses: [{ id: "after-name", at: 1, durationMs: 25 }] } });
});
