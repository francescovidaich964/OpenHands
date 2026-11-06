import type { Root } from "hast";

/**
 * rehype plugin: put each top-level block's markdown source lines in the DOM.
 *
 * It cannot put them ON the block element: our markdown components (`ul`,
 * `blockquote`, `table`, the headings …) pick the props they render and drop
 * unknown ones, so an attribute set on the node never reaches the DOM. Instead
 * a hidden marker is injected in front of each block and
 * {@link applySourceLineMarkers} moves it onto the block it belongs to. Markers
 * are `display: none`, so a surface that never runs that step is unaffected.
 *
 * Why the source lines are worth this: the rendered DOM of a list is "foo bar",
 * the source is "- foo\n- bar". Quoting the source keeps the structure, code
 * fences and table pipes that the selection itself has already lost.
 */
export function rehypeSourceLineMarkers() {
  return (tree: Root): void => {
    const children = tree.children;
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      const start = node.position?.start.line;
      const end = node.position?.end.line;
      if (start == null || end == null) continue;
      children.splice(i, 0, {
        type: "element",
        tagName: "div",
        properties: {
          className: ["hidden"],
          // Hyphenated, not camelCase: hast passes an unknown attribute through
          // verbatim, so this is exactly the attribute name the DOM gets.
          "data-md-marker": "",
          "data-md-source-start": String(start),
          "data-md-source-end": String(end),
        },
        children: [],
      });
      i++;
    }
  };
}

/**
 * Moves every marker's line range onto the block that follows it and drops the
 * marker. Run after render, from the message bubble. A block with no marker in
 * front of it (raw HTML the parser merged, a surface that opted out) simply
 * gets no anchor, and quoting that block falls back to the selection's own
 * text — the same thing a plain selection would produce.
 */
export function applySourceLineMarkers(root: ParentNode | null): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-md-marker]").forEach((marker) => {
    const block = marker.nextElementSibling;
    if (block instanceof HTMLElement) {
      block.dataset.mdSourceStart = marker.dataset.mdSourceStart ?? "";
      block.dataset.mdSourceEnd = marker.dataset.mdSourceEnd ?? "";
    }
    marker.remove();
  });
}
