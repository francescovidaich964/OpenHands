import { describe, expect, it } from "vitest";

import {
  TRANSLATION_FILE,
  formatTranslations,
  mergeTranslations,
} from "./translation-merge.mjs";

/** The repo's own file format (trailing newline included), so the guard accepts it. */
const file = (object) => `${JSON.stringify(object, null, 2)}\n`;

const LANGS = (en, ja) => ({ en, ja, "zh-CN": en });

describe("formatTranslations", () => {
  it("is two-space JSON plus one trailing newline", () => {
    expect(formatTranslations({ A: LANGS("a", "b") })).toBe(
      `${JSON.stringify({ A: LANGS("a", "b") }, null, 2)}\n`,
    );
  });
});

describe("mergeTranslations", () => {
  it("keeps both sides when each only added keys (the real sync case)", () => {
    const base = { Hello: LANGS("hi", "ya"), Bye: LANGS("bye", "ja") };
    const ours = { ...base, Upstream$NEW: LANGS("new", "new") };
    const theirs = { ...base, SYNC$START: LANGS("sync", "sync") };

    const got = mergeTranslations(file(base), file(ours), file(theirs));

    expect(got.error).toBe(null);
    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({
      Hello: base.Hello,
      Bye: base.Bye,
      Upstream$NEW: ours["Upstream$NEW"],
      SYNC$START: theirs["SYNC$START"],
    });
    // Ours' order first, the fork's new keys appended in theirs' order.
    expect(Object.keys(JSON.parse(got.text))).toEqual([
      "Hello",
      "Bye",
      "Upstream$NEW",
      "SYNC$START",
    ]);
    expect(got.added).toEqual(["SYNC$START"]);
    expect(got.changed).toEqual([]);
    expect(got.removed).toEqual([]);
    expect(got.conflicts).toEqual([]);
  });

  it("takes theirs' edit of an existing key", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file(base),
      file({ Hello: LANGS("hello", "ya") }),
    );

    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({ Hello: LANGS("hello", "ya") });
    expect(got.changed).toEqual(["Hello"]);
  });

  it("takes theirs' deletion of a key neither side else touched", () => {
    const base = { Hello: LANGS("hi", "ya"), Old: LANGS("old", "old") };
    const got = mergeTranslations(
      file(base),
      file(base),
      file({ Hello: base.Hello }),
    );

    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({ Hello: base.Hello });
    expect(got.removed).toEqual(["Old"]);
  });

  it("reports a key both sides changed in different ways", () => {
    const base = { Greeting: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file({ Greeting: LANGS("upstream", "ya") }),
      file({ Greeting: LANGS("fork", "ya") }),
    );

    expect(got.ok).toBe(false);
    expect(got.text).toBe(null);
    expect(got.conflicts).toEqual(["Greeting"]);
  });

  it("reports a key both sides added with different text", () => {
    const got = mergeTranslations(
      null,
      file({ SYNC$START: LANGS("ours", "ours") }),
      file({ SYNC$START: LANGS("theirs", "theirs") }),
    );

    expect(got.ok).toBe(false);
    expect(got.conflicts).toEqual(["SYNC$START"]);
  });

  it("keeps a key both sides changed identically", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const same = { Hello: LANGS("hello", "ya") };
    const got = mergeTranslations(file(base), file(same), file(same));

    expect(got.ok).toBe(true);
    expect(got.conflicts).toEqual([]);
    expect(got.changed).toEqual([]);
    expect(JSON.parse(got.text)).toEqual(same);
  });

  it("does not read a reordered language list as an edit", () => {
    const base = { Hello: { en: "hi", ja: "ya" } };
    const got = mergeTranslations(
      file(base),
      file(base),
      file({ Hello: { ja: "ya", en: "hi" } }),
    );

    expect(got.ok).toBe(true);
    expect(got.changed).toEqual([]);
    expect(got.conflicts).toEqual([]);
  });

  it("reports modify/delete when upstream drops a key the fork edited", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file({ Other: LANGS("o", "o") }),
      file({ Hello: LANGS("hi", "ya-edited") }),
    );

    expect(got.ok).toBe(false);
    expect(got.conflicts).toEqual(["Hello"]);
  });

  it("honours upstream's deletion of a key the fork never touched", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file({ Other: LANGS("o", "o") }),
      file(base),
    );

    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({ Other: LANGS("o", "o") });
    expect(got.conflicts).toEqual([]);
  });

  it("keeps ours' value when theirs did not touch the key", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file({ Hello: LANGS("fork edit", "ya") }),
      file(base),
    );

    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({ Hello: LANGS("fork edit", "ya") });
  });

  it("sorts the conflict list so the report is stable", () => {
    const base = { A: LANGS("a", "a"), B: LANGS("b", "b"), C: LANGS("c", "c") };
    const ours = {
      A: LANGS("ours-a", "a"),
      B: LANGS("ours-b", "b"),
      C: LANGS("ours-c", "c"),
    };
    const theirs = {
      A: LANGS("their-a", "a"),
      B: LANGS("their-b", "b"),
      C: LANGS("their-c", "c"),
    };

    expect(
      mergeTranslations(file(base), file(ours), file(theirs)).conflicts,
    ).toEqual(["A", "B", "C"]);
  });

  it("refuses to reformat ours instead of rewriting the whole file", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const indented = `${JSON.stringify(base, null, 4)}\n`;
    const got = mergeTranslations(file(base), indented, file(base));

    expect(got.ok).toBe(false);
    expect(got.text).toBe(null);
    expect(got.error).toMatch(/reformat/);
  });

  it("refuses ours when it has no final newline", () => {
    const base = { Hello: LANGS("hi", "ya") };
    const got = mergeTranslations(
      file(base),
      file(base).replace(/\n$/, ""),
      file(base),
    );

    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/reformat/);
  });

  it("reports which side it could not read", () => {
    const base = { Hello: LANGS("hi", "ya") };

    expect(mergeTranslations(file(base), "{nope", file(base)).error).toMatch(
      /^ours: not valid JSON/,
    );
    expect(
      mergeTranslations(file(base), file(base), file(["array"])).error,
    ).toMatch(/^theirs: not an object$/);
    expect(mergeTranslations("{bad", file(base), file(base)).error).toMatch(
      /^base: not valid JSON/,
    );
    expect(mergeTranslations(file(base), null, file(base)).error).toMatch(
      /^ours: no text$/,
    );
  });

  it("treats a missing base as an empty file (both sides added it)", () => {
    const got = mergeTranslations(
      null,
      file({ A: LANGS("a", "a") }),
      file({ B: LANGS("b", "b") }),
    );

    expect(got.ok).toBe(true);
    expect(JSON.parse(got.text)).toEqual({
      A: LANGS("a", "a"),
      B: LANGS("b", "b"),
    });
    expect(got.added).toEqual(["B"]);
  });

  it("names the file the whole sync fights over", () => {
    expect(TRANSLATION_FILE).toBe("src/i18n/translation.json");
  });

  it("does not confuse a real null value with a missing key", () => {
    const base = { Hello: { en: null } };
    const got = mergeTranslations(
      file(base),
      file({ Hello: { en: null } }),
      file({}),
    );

    expect(got.ok).toBe(true);
    expect(got.removed).toEqual(["Hello"]);
  });
});
