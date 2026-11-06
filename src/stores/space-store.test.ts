import { beforeEach, describe, expect, it } from "vitest";

import {
  selectOrderedSpaces,
  selectSpaceMemberIds,
  useSpaceStore,
} from "#/stores/space-store";

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

describe("space objects", () => {
  it("creates a trimmed, titled space and keeps creation order", () => {
    const first = state().createSpace("  Release prep  ");
    const second = state().createSpace("Research");

    expect(state().spaces[first].title).toBe("Release prep");
    expect(state().spaceOrder).toEqual([first, second]);
    expect(selectOrderedSpaces(state()).map((space) => space.title)).toEqual([
      "Release prep",
      "Research",
    ]);
  });

  it("renames without touching membership", () => {
    const id = state().createSpace("Old");
    state().assignSpace("c1", id);
    state().renameSpace(id, "New");

    expect(state().spaces[id].title).toBe("New");
    expect(state().members.c1).toBe(id);
    state().renameSpace("missing", "ignored");
    expect(state().spaces.missing).toBeUndefined();
  });

  it("forgets the group on delete and keeps every conversation", () => {
    const keep = state().createSpace("Keep");
    const gone = state().createSpace("Gone");
    state().assignSpace("c1", gone);
    state().assignSpace("c2", gone);
    state().assignSpace("c3", keep);
    state().toggleSpaceCollapsed(gone);

    state().deleteSpace(gone);

    expect(state().spaces[gone]).toBeUndefined();
    expect(state().spaceOrder).toEqual([keep]);
    expect(state().collapsedSpaceIds).toEqual([]);
    // the members of the deleted space are ungrouped, not removed: their only
    // record outside this store is the conversation itself, which we never touch
    expect(state().members).toEqual({ c3: keep });
    // and the digests stay on disk for the next space they join
    state().setSummary("c1", "digest", 4);
    expect(state().summaries.c1.summary).toBe("digest");
  });

  it("collapses and expands a folder", () => {
    const id = state().createSpace("S");
    state().toggleSpaceCollapsed(id);
    expect(state().collapsedSpaceIds).toEqual([id]);
    state().toggleSpaceCollapsed(id);
    expect(state().collapsedSpaceIds).toEqual([]);
  });

  it("keeps spaces the order does not know about (a tag from another device)", () => {
    useSpaceStore.setState({
      spaces: { sp_b: { id: "sp_b", title: "B", createdAt: "" } },
      spaceOrder: [],
    });
    expect(selectOrderedSpaces(state()).map((space) => space.id)).toEqual([
      "sp_b",
    ]);
  });
});

describe("membership", () => {
  it("moves a conversation between spaces, never holding two at once", () => {
    const a = state().createSpace("A");
    const b = state().createSpace("B");

    state().assignSpace("c1", a);
    expect(selectSpaceMemberIds(state(), a)).toEqual(["c1"]);

    state().assignSpace("c1", b);
    expect(selectSpaceMemberIds(state(), a)).toEqual([]);
    expect(selectSpaceMemberIds(state(), b)).toEqual(["c1"]);

    state().assignSpace("c1", null);
    expect("c1" in state().members).toBe(false);
  });

  it("folds membership in from the server tags", () => {
    const id = state().createSpace("S");
    state().syncMembershipFromTags([
      { id: "c1", title: "First", tags: { canvasspace: id } },
      { id: "c2", title: "Second", tags: {} },
    ]);

    expect(state().members).toEqual({ c1: id });
    expect(state().titles.c1).toBe("First");
    expect(selectSpaceMemberIds(state(), id)).toEqual(["c1"]);
  });

  it("adopts a space id it has never seen (another device made it)", () => {
    state().syncMembershipFromTags([
      { id: "c1", title: "First", tags: { canvasspace: "sp_remote" } },
    ]);
    expect(state().members.c1).toBe("sp_remote");
    expect(state().spaces.sp_remote).toMatchObject({
      id: "sp_remote",
      title: "",
    });
  });

  it("drops a membership whose tag disappeared", () => {
    const id = state().createSpace("S");
    state().assignSpace("c1", id);
    state().syncMembershipFromTags([{ id: "c1", title: "First", tags: null }]);
    expect("c1" in state().members).toBe(false);
  });

  it("leaves conversations it was not shown alone", () => {
    const id = state().createSpace("S");
    state().assignSpace("c-off-page", id);
    state().syncMembershipFromTags([
      { id: "c1", title: "One", tags: { canvasspace: id } },
    ]);
    expect(state().members["c-off-page"]).toBe(id);
  });

  it("returns the same object when nothing changed (no needless re-render)", () => {
    const id = state().createSpace("S");
    state().assignSpace("c1", id);
    state().rememberConversationTitle("c1", "First");
    const before = state();
    state().syncMembershipFromTags([
      { id: "c1", title: "First", tags: { canvasspace: id } },
    ]);
    expect(state()).toBe(before);
  });

  it('remembers titles for the <session title="…"> attribute', () => {
    state().rememberConversationTitle("c1", "Renamed later");
    expect(state().titles.c1).toBe("Renamed later");
    state().rememberConversationTitle("c1", "   ");
    expect(state().titles.c1).toBe("Renamed later");
  });
});

describe("digests and the one-shot flag", () => {
  it("stores the digest with the message count it covers", () => {
    state().setSummary("c1", "## Overview\ndid it", 7);
    expect(state().summaries.c1).toMatchObject({
      summary: "## Overview\ndid it",
      messageCount: 7,
    });
    expect(Date.parse(state().summaries.c1.updatedAt)).not.toBeNaN();
  });

  it("marks a conversation as already carrying the block, once", () => {
    expect(state().contextInjected.c1).toBeUndefined();
    state().markContextInjected("c1");
    expect(state().contextInjected.c1).toBe(true);
    state().markContextInjected("c1");
    expect(state().contextInjected.c1).toBe(true);
  });
});
