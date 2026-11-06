import { beforeEach, describe, expect, it, vi } from "vitest";

import { SPACE_CONTEXT_INTRO } from "#/utils/space-context";
import { spaceContextForFirstMessage } from "#/utils/space-send-context";
import { useSpaceStore } from "#/stores/space-store";

const EMPTY = {
  spaces: {},
  spaceOrder: [],
  members: {},
  titles: {},
  summaries: {},
  contextInjected: {},
  collapsedSpaceIds: [],
};

const state = () => useSpaceStore.getState();

beforeEach(() => {
  localStorage.clear();
  useSpaceStore.setState(EMPTY);
});

/** A two-member space where both members have a digest. */
function seedSpace() {
  const spaceId = state().createSpace("Release prep");
  state().assignSpace("me", spaceId);
  state().assignSpace("other", spaceId);
  state().rememberConversationTitle("other", "Auth work");
  state().setSummary("other", "## Overview\nShipped auth.", 5);
  return spaceId;
}

describe("spaceContextForFirstMessage", () => {
  it("gives a new member of a space the other members' digests", () => {
    seedSpace();
    const block = spaceContextForFirstMessage("me");

    expect(block).not.toBeNull();
    expect(block?.text).toContain('<project_context name="Release prep">');
    expect(block?.text).toContain(SPACE_CONTEXT_INTRO);
    expect(block?.text).toContain('<session title="Auth work">');
    expect(block?.text).toContain("Shipped auth.");
    // the current conversation is never in its own background block
    expect(block?.text).not.toContain('title="me"');
    expect(block?.text.endsWith("</project_context>\n\n")).toBe(true);
  });

  it("is only for the FIRST message", () => {
    seedSpace();
    expect(spaceContextForFirstMessage("me")).not.toBeNull();
    state().markContextInjected("me");
    expect(spaceContextForFirstMessage("me")).toBeNull();
  });

  it("is null for a conversation that is in no space", () => {
    expect(spaceContextForFirstMessage("nobody")).toBeNull();
    expect(spaceContextForFirstMessage(null)).toBeNull();
    expect(spaceContextForFirstMessage(undefined)).toBeNull();
  });

  it("is null when the space has no other member to take context from", () => {
    const spaceId = state().createSpace("Solo");
    state().assignSpace("me", spaceId);
    expect(spaceContextForFirstMessage("me")).toBeNull();
  });

  it("still sends a block when a member has no digest yet", () => {
    const spaceId = seedSpace();
    state().assignSpace("fresh", spaceId);
    state().rememberConversationTitle("fresh", "Just started");

    // asked from the first conversation, so it sees both of the others
    const block = spaceContextForFirstMessage("me");
    expect(block?.text).toContain('<session title="Just started" />');
    expect(block?.text).toContain("Shipped auth.");
    expect(block?.text).not.toContain('title="me"');
    expect(spaceId).toBeTruthy();
  });

  it("uses the conversation id when no title was recorded", () => {
    const spaceId = state().createSpace("S");
    state().assignSpace("me", spaceId);
    state().assignSpace("c-uuid", spaceId);

    expect(spaceContextForFirstMessage("me")?.text).toContain(
      '<session title="c-uuid" />',
    );
  });

  it("names the digests it had to drop instead of trimming silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spaceId = state().createSpace("S");
    state().assignSpace("me", spaceId);
    for (let index = 0; index < 12; index += 1) {
      const id = `big${index}`;
      state().assignSpace(id, spaceId);
      state().setSummary(id, "z".repeat(70_000), 2);
    }

    const block = spaceContextForFirstMessage("me");
    expect(block?.droppedSummaryCount).toBeGreaterThan(0);
    expect(block?.text.length).toBeLessThanOrEqual(160_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped"));
    warn.mockRestore();
  });
});
