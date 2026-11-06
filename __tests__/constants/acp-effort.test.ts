import { describe, expect, it } from "vitest";
import {
  getAcpEffortLevels,
  joinAcpModelEffort,
  splitAcpModelEffort,
} from "#/constants/acp-effort";

const CLAUDE = getAcpEffortLevels("claude-code");

describe("getAcpEffortLevels", () => {
  it("knows the providers that declare an effort option", () => {
    expect(CLAUDE).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getAcpEffortLevels("codex")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("has none for a provider without one, a custom command, or no provider", () => {
    expect(getAcpEffortLevels("gemini-cli")).toEqual([]);
    expect(getAcpEffortLevels("opencode")).toEqual([]);
    expect(getAcpEffortLevels("custom")).toEqual([]);
    expect(getAcpEffortLevels(null)).toEqual([]);
    expect(getAcpEffortLevels(undefined)).toEqual([]);
  });
});

describe("splitAcpModelEffort", () => {
  it("splits a suffix the provider declares as a level", () => {
    expect(splitAcpModelEffort("opus[1m]/high", CLAUDE)).toEqual({
      model: "opus[1m]",
      effort: "high",
    });
  });

  it("keeps a slash that is part of the model id", () => {
    expect(splitAcpModelEffort("anthropic/claude-sonnet-4-5", CLAUDE)).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      effort: null,
    });
    // A token that only looks like a level on one provider stays whole on another.
    expect(
      splitAcpModelEffort("sonnet/max", getAcpEffortLevels("codex")),
    ).toEqual({ model: "sonnet/max", effort: null });
  });

  it("keeps the id whole when the provider has no effort levels", () => {
    expect(splitAcpModelEffort("gemini-2.5-pro/high", [])).toEqual({
      model: "gemini-2.5-pro/high",
      effort: null,
    });
  });

  it("keeps an id with no model before the slash", () => {
    expect(splitAcpModelEffort("/high", CLAUDE)).toEqual({
      model: "/high",
      effort: null,
    });
  });

  it("handles the unset model", () => {
    expect(splitAcpModelEffort("", CLAUDE)).toEqual({
      model: "",
      effort: null,
    });
    expect(splitAcpModelEffort(null, CLAUDE)).toEqual({
      model: "",
      effort: null,
    });
  });
});

describe("joinAcpModelEffort", () => {
  it("suffixes only a picked effort", () => {
    expect(joinAcpModelEffort("opus[1m]", "high")).toBe("opus[1m]/high");
    expect(joinAcpModelEffort("opus[1m]", null)).toBe("opus[1m]");
  });

  it("stays unset when there is no model to attach an effort to", () => {
    expect(joinAcpModelEffort("", "high")).toBeNull();
    expect(joinAcpModelEffort(null, null)).toBeNull();
  });

  it("round-trips every level through split", () => {
    for (const effort of CLAUDE) {
      const joined = joinAcpModelEffort("opus[1m]", effort);
      expect(splitAcpModelEffort(joined, CLAUDE)).toEqual({
        model: "opus[1m]",
        effort,
      });
    }
  });
});
