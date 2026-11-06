import { describe, it, expect, afterEach } from "vitest";
import {
  messageSourceFor,
  rangeCoversElement,
  registerMessageSource,
  selectQuotedPassage,
  selectionText,
} from "#/utils/quote-anchor";

function makeBubble() {
  const bubble = document.createElement("article");
  bubble.setAttribute("data-message-event-id", "evt-1");
  bubble.innerHTML =
    '<p data-md-source-start="3" data-md-source-end="3">First paragraph.</p>' +
    '<p data-md-source-start="5" data-md-source-end="6">Second paragraph.</p>' +
    '<button type="button" data-quote-exclude="">Copy</button>';
  document.body.appendChild(bubble);
  return bubble;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("quote anchors", () => {
  it("drops in-bubble controls from the selected text", () => {
    const bubble = makeBubble();
    const range = document.createRange();
    range.selectNodeContents(bubble);
    const text = selectionText(range);
    expect(text).toContain("First paragraph.");
    expect(text).not.toContain("Copy");
  });

  it("tells a range inside one block from one that crosses blocks", () => {
    const bubble = makeBubble();
    const [first, second] = [...bubble.querySelectorAll("p")];
    const inside = document.createRange();
    inside.setStart(first.firstChild as Node, 0);
    inside.setEndAfter(first.lastChild as Node);
    expect(rangeCoversElement(inside, first)).toBe(true);

    const across = document.createRange();
    across.setStart(first.firstChild as Node, 0);
    across.setEnd(second.lastChild as Node, second.textContent?.length ?? 0);
    expect(rangeCoversElement(across, first)).toBe(false);
  });

  it("re-selects a quoted passage from its markdown line anchors", () => {
    const bubble = makeBubble();
    const range = selectQuotedPassage(bubble, "Second paragraph.", 5, 6);
    expect(range?.toString()).toBe("Second paragraph.");
  });

  it("falls back to the text when the quote carries no anchors", () => {
    const bubble = makeBubble();
    const range = selectQuotedPassage(bubble, "First paragraph.", 9, 9);
    expect(range?.toString()).toBe("First paragraph.");
  });

  it("remembers the markdown source the bubble was rendered from", () => {
    const bubble = makeBubble();
    registerMessageSource(bubble, "First paragraph.\n\nSecond paragraph.");
    expect(messageSourceFor(bubble)).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });
});
