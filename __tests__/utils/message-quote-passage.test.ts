import { describe, it, expect } from "vitest";
import {
  MAX_PASSAGE_BODY,
  buildQuoteEnvelope,
  hasQuoteEnvelope,
  splitQuoteEnvelopesFromText,
  stripQuoteEnvelopes,
  type PassageQuote,
} from "#/utils/message-quote";

const quote: PassageQuote = {
  eventId: "evt-1",
  author: "agent",
  caption: "why this part?",
  content: "some **passage** & <code>",
  startLine: 3,
  endLine: 4,
  truncated: false,
};

describe("passage quote envelope", () => {
  it("builds the envelope the agent expects", () => {
    expect(buildQuoteEnvelope(quote)).toBe(
      '<quoted_artifact kind="message" event_id="evt-1" author="agent" start_line="3" end_line="4">\n' +
        "<caption>why this part?</caption>\n" +
        "<content>\nsome **passage** &amp; &lt;code&gt;\n</content>\n" +
        "</quoted_artifact>",
    );
  });

  it("omits the caption when there is none", () => {
    expect(buildQuoteEnvelope({ ...quote, caption: "" })).not.toContain(
      "<caption>",
    );
  });

  it("round-trips a comment plus its quote", () => {
    const text = `look here\n\n${buildQuoteEnvelope(quote)}`;
    const { quotes, rest } = splitQuoteEnvelopesFromText(text);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      eventId: "evt-1",
      author: "agent",
      caption: "why this part?",
      content: "some **passage** & <code>",
      startLine: 3,
      endLine: 4,
      truncated: false,
    });
    expect(rest).toBe("look here");
  });

  it("keeps only the comment in the text a reader sees", () => {
    const text = `look here\n\n${buildQuoteEnvelope(quote)}`;
    expect(stripQuoteEnvelopes(text)).toBe("look here");
    expect(hasQuoteEnvelope(text)).toBe(true);
    expect(hasQuoteEnvelope("plain text")).toBe(false);
  });

  it("leaves a malformed envelope as ordinary text", () => {
    const broken = '<quoted_artifact kind="message">never closed';
    expect(stripQuoteEnvelopes(broken)).toBe(broken);
  });

  it("carries the truncation flag across the wire", () => {
    const clipped = buildQuoteEnvelope({
      ...quote,
      content: "x".repeat(MAX_PASSAGE_BODY),
      truncated: true,
    });
    expect(clipped).toContain('truncated="true"');
    expect(splitQuoteEnvelopesFromText(clipped).quotes[0].truncated).toBe(true);
  });

  it("reads a quote made by another client (no line anchors)", () => {
    const foreign =
      '<quoted_artifact kind="message" event_id="e2" author="user">\n' +
      "<content>\nsome text\n</content>\n</quoted_artifact>";
    const { quotes, rest } = splitQuoteEnvelopesFromText(foreign);
    expect(quotes[0]).toMatchObject({
      eventId: "e2",
      author: "user",
      caption: "",
      content: "some text",
      truncated: false,
    });
    expect(quotes[0].startLine).toBeUndefined();
    expect(rest).toBe("");
  });
});
