/**
 * Everything the passage-quote feature needs from the DOM: which message a
 * selection belongs to, that message's markdown source, and how to highlight a
 * quoted passage again. Kept out of the components so the selection hook, the
 * popup and the quote card all read the same anchors.
 *
 * The anchors are set by the chat bubble:
 *   [data-message-event-id|author|ts]  on the bubble
 *   [data-md-source-start|end]         on each markdown block (see
 *                                      rehype-source-line-markers)
 *   [data-quote-exclude]               on in-bubble controls (copy, reply …)
 */

/** Added for ~1 s to the source message when a card is clicked. */
export const QUOTE_FLASH_CLASS = "quote-flash";

const messageSources = new WeakMap<Element, string>();

/** Remembers the markdown a bubble renders (see `messageSourceFor`). */
export function registerMessageSource(element: Element, source: string): void {
  messageSources.set(element, source);
}

/**
 * The markdown source of a message. The DOM cannot answer this — a rendered
 * list has lost its `-`, a code block its fences — and the quote wants the
 * source, so the bubble hands it over here instead of duplicating it into an
 * attribute on every block.
 */
export function messageSourceFor(element: Element): string | undefined {
  return messageSources.get(element);
}

/** The bubble a node sits in, if it is inside a quotable message. */
export function messageBubbleFor(
  node: Node,
  within: HTMLElement,
): HTMLElement | null {
  let current: Node | null = node;
  if (current.nodeType === Node.TEXT_NODE) current = current.parentElement;
  if (!(current instanceof HTMLElement)) return null;
  const bubble = current.closest<HTMLElement>("[data-message-event-id]");
  return bubble && within.contains(bubble) ? bubble : null;
}

/** The lines a block covers in the source, or null when it is not anchored. */
export function sourceLinesFor(
  node: Node,
): { start: number; end: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    return parent ? sourceLinesFor(parent) : null;
  }
  if (!(node instanceof HTMLElement)) return null;
  const start = Number(node.dataset.mdSourceStart);
  const end = Number(node.dataset.mdSourceEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1)
    return null;
  return { start, end };
}

/**
 * True when the range reaches no further than `element`: both of its endpoints
 * are inside the element's subtree (an endpoint sitting on the element itself
 * counts, which is what a triple-click produces). Endpoint checks rather than
 * comparePoint, because a range whose end is exactly the element's last position
 * is neither before nor after itself in practice.
 */
export function rangeCoversElement(
  range: Range,
  element: HTMLElement,
): boolean {
  return (
    element.contains(range.startContainer) &&
    element.contains(range.endContainer)
  );
}

/**
 * Lines of the source a whole-block selection spans. Returns null when the
 * selection starts or ends in the middle of a block (or the blocks are not
 * anchored), in which case the caller quotes the selection's own text.
 */
export function wholeBlockLines(
  range: Range,
  text: string,
): { start: number; end: number; content: string } | null {
  const startLines = sourceLinesFor(range.startContainer);
  const endLines = sourceLinesFor(range.endContainer);
  if (!startLines || !endLines) return null;

  const startBlock = topBlockOf(range.startContainer);
  const endBlock = topBlockOf(range.endContainer);
  if (!startBlock || !endBlock) return null;
  if (
    !rangeCoversElement(range, startBlock) ||
    !rangeCoversElement(range, endBlock)
  ) {
    return null;
  }

  const lines = text.split("\n");
  const slice = lines.slice(startLines.start - 1, endLines.end);
  if (slice.length === 0) return null;

  return {
    start: startLines.start,
    end: endLines.end,
    content: slice.join("\n").replace(/\s+$/, ""),
  };
}

/** The anchored element that is a direct block of the message (a list item's block is its `ul`). */
function topBlockOf(node: Node): HTMLElement | null {
  let current: Node | null = node;
  let found: HTMLElement | null = null;
  while (current?.nodeType === Node.ELEMENT_NODE) {
    const el = current as HTMLElement;
    if (el.hasAttribute("data-md-source-start")) found = el;
    if (el.hasAttribute("data-message-event-id")) break;
    current = current.parentNode;
  }
  if (!found && node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    found = parent ? topBlockOf(parent) : null;
  }
  return found;
}

/** The selection the user can see, or null when there is nothing to quote. */
export function readSelection(): Selection | null {
  const selection =
    typeof window === "undefined" ? null : window.getSelection();
  return selection && selection.rangeCount > 0 && !selection.isCollapsed
    ? selection
    : null;
}

/**
 * Text of a range with the parts the user did not select out of the bubble
 * removed: copy and reply buttons sit inside the bubble, and a triple-click
 * that reaches one must not put its label into the quote.
 */
export function selectionText(range: Range): string {
  const fragment = range.cloneContents();
  fragment
    .querySelectorAll("[data-quote-exclude]")
    .forEach((node) => node.parentNode?.removeChild(node));
  return fragment.textContent?.replace(/\u00a0/g, " ") ?? "";
}

/**
 * Re-selects a quoted passage inside its source message, so clicking a quote
 * card shows exactly what was quoted. Line anchors first; a card whose envelope
 * has none (a quote made by another client) falls back to finding the text.
 */
export function selectQuotedPassage(
  bubble: HTMLElement,
  passage: string,
  startLine?: number,
  endLine?: number,
): Range | null {
  const blocks = [
    ...bubble.querySelectorAll<HTMLElement>("[data-md-source-start]"),
  ];
  let range: Range | null = null;

  if (startLine != null && endLine != null) {
    const inside = blocks.filter(
      (block) =>
        sourceLinesFor(block)!.end >= startLine &&
        sourceLinesFor(block)!.start <= endLine,
    );
    if (inside.length > 0) range = rangeAround(inside);
  }

  if (!range) range = rangeForText(bubble, passage);
  if (!range) return null;

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  programmatic = { start: range.startContainer, end: range.endContainer };
  return range;
}

/**
 * The selection this feature highlighted itself (clicking a quote card). A user
 * must not be able to quote our own highlight: Devin ignores programmatic
 * selections, and so do we.
 */
export function isProgrammaticSelection(selection: Selection): boolean {
  if (!programmatic) return false;
  const same =
    selection.anchorNode === programmatic.start &&
    selection.focusNode === programmatic.end;
  if (!same) programmatic = null; // some later selection has replaced it
  return same;
}

let programmatic: { start: Node; end: Node } | null = null;

/** A range that spans `elements` end to end, at the text-node edges. */
function rangeAround(elements: HTMLElement[]): Range | null {
  const first = elements[0];
  const last = elements[elements.length - 1];
  const range = document.createRange();
  const startText = firstText(first);
  if (!startText) return null;
  range.setStart(startText, 0);
  const endText = lastText(last) ?? startText;
  range.setEnd(endText, endText.textContent?.length ?? 0);
  return range;
}

function firstText(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return (walker.nextNode() as Text) ?? null;
}

/** Deepest last text node, so the range does not run past the block's end. */
function lastText(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let found: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    found = node as Text;
  }
  return found;
}

/**
 * Finds the passage in the rendered text and selects it (no line anchors).
 * Exact text only: a card that quotes markdown source of a message rendered
 * without anchors cannot be re-selected from the DOM, and scrolling to the
 * message with the quote visible in the card is a better failure than
 * highlighting the wrong characters.
 */
function rangeForText(bubble: HTMLElement, passage: string): Range | null {
  const needle = passage.trim();
  if (!needle) return null;
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  let haystack = "";
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.parentElement?.closest("[data-quote-exclude]")) continue;
    nodes.push(text);
    haystack += text.textContent ?? "";
    const at = haystack.indexOf(needle);
    if (at === -1) continue;
    const range = document.createRange();
    // Step back from the match's end to the node its first character lives in.
    let offset = at;
    for (let i = 0; i < nodes.length; i++) {
      const length = nodes[i].textContent?.length ?? 0;
      if (offset < length || i === nodes.length - 1) {
        range.setStart(nodes[i], offset);
        break;
      }
      offset -= length;
    }
    let remaining = offset + needle.length;
    for (
      let i = nodes.indexOf(range.startContainer as Text);
      i < nodes.length;
      i++
    ) {
      const length = nodes[i].textContent?.length ?? 0;
      if (remaining <= length || i === nodes.length - 1) {
        range.setEnd(nodes[i], Math.min(remaining, length));
        break;
      }
      remaining -= length;
    }
    return range;
  }
  return null;
}

/** Scrolls a message into view and highlights it for a moment. */
export function flashMessage(element: HTMLElement): void {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add(QUOTE_FLASH_CLASS);
  window.setTimeout(() => element.classList.remove(QUOTE_FLASH_CLASS), 1200);
}
