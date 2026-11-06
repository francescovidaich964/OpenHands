import { describe, expect, it } from "vitest";

import { RESERVED_CONVERSATION_TAG_KEYS } from "#/api/agent-server-adapter";
import {
  SPACE_TAG_KEY,
  spaceIdFromTags,
  withSpaceTag,
} from "#/utils/space-tags";

describe("spaceIdFromTags", () => {
  it("reads the space link", () => {
    expect(spaceIdFromTags({ [SPACE_TAG_KEY]: "sp_1", pinned: "true" })).toBe(
      "sp_1",
    );
  });

  it("is null without a usable value", () => {
    expect(spaceIdFromTags(null)).toBeNull();
    expect(spaceIdFromTags(undefined)).toBeNull();
    expect(spaceIdFromTags({})).toBeNull();
    expect(spaceIdFromTags({ [SPACE_TAG_KEY]: "   " })).toBeNull();
    expect(spaceIdFromTags({ plannerparent: "sp_1" })).toBeNull();
  });
});

describe("withSpaceTag", () => {
  it("keeps the other tags (the PATCH replaces the whole map)", () => {
    expect(withSpaceTag({ pinned: "true", repo: "x" }, "sp_2")).toEqual({
      pinned: "true",
      repo: "x",
      [SPACE_TAG_KEY]: "sp_2",
    });
  });

  it("replaces an existing space rather than adding a second one", () => {
    expect(
      withSpaceTag({ [SPACE_TAG_KEY]: "sp_1" }, "sp_2")[SPACE_TAG_KEY],
    ).toBe("sp_2");
  });

  it("moves a conversation out by deleting the key only", () => {
    const next = withSpaceTag(
      { [SPACE_TAG_KEY]: "sp_1", archived: "true" },
      null,
    );
    expect(next).toEqual({ archived: "true" });
    expect(SPACE_TAG_KEY in next).toBe(false);
  });

  it("accepts a missing tag map", () => {
    expect(withSpaceTag(null, "sp_1")).toEqual({ [SPACE_TAG_KEY]: "sp_1" });
    expect(withSpaceTag(undefined, null)).toEqual({});
  });

  it("never renders the membership as a tag chip", () => {
    expect(RESERVED_CONVERSATION_TAG_KEYS.has(SPACE_TAG_KEY)).toBe(true);
  });

  it("does not reuse the planner key (its tag drives a delete cascade)", () => {
    expect(SPACE_TAG_KEY).not.toBe("plannerparent");
    expect(SPACE_TAG_KEY).not.toBe("localplannerparent");
  });
});
