/**
 * Renderer view of the fork-only Spaces summariser bridge — see
 * electron/preload-main.cjs and electron/space-summary.mjs. Absent in a browser
 * tab, so callers treat "no bridge" as "summaries unavailable" (the space still
 * works, its members just show up as empty `<session title="…" />` tags).
 */

export interface SpaceSummarySettings {
  /** Claude model for the digest; `opus` means "the latest Opus". */
  model: string;
  enabled: boolean;
}

export interface SpaceSummaryResult {
  ok: boolean;
  summary?: string;
  /** Messages the digest now covers (the cursor the main process stored). */
  messageCount?: number;
  /** True when the digest continued the previous summariser session. */
  incremental?: boolean;
  /** True when there was nothing new to summarize; `summary` is the old one. */
  unchanged?: boolean;
  /** True when the feature is switched off in settings. */
  disabled?: boolean;
  error?: string;
}

import type { TranscriptMessage } from "#/utils/space-transcript";

export interface SpaceSummaryEntry {
  summary: string;
  messageCount: number;
  updatedAt: string;
}

export interface SpaceSummarySettingsResult {
  ok: boolean;
  settings?: SpaceSummarySettings;
  error?: string;
}

export interface SpaceSummaryBridge {
  /**
   * The whole message list goes over the bridge and the MAIN process decides
   * what is new: it owns `{messageCount, claudeSessionId}`, so a cleared
   * localStorage cannot make a digest resume a stale session or skip messages.
   */
  summarize: (request: {
    conversationId: string;
    messages: TranscriptMessage[];
  }) => Promise<SpaceSummaryResult>;
  read: (request: { conversationId: string }) => Promise<SpaceSummaryResult>;
  list: () => Promise<{
    ok: boolean;
    summaries?: Record<string, SpaceSummaryEntry>;
    error?: string;
  }>;
  settings: () => Promise<SpaceSummarySettingsResult>;
  setSettings: (patch: {
    model?: string;
    enabled?: boolean;
  }) => Promise<SpaceSummarySettingsResult>;
}

declare global {
  interface Window {
    agentCanvasSpaces?: SpaceSummaryBridge;
  }
}

export function getSpaceSummaryBridge(): SpaceSummaryBridge | undefined {
  return typeof window === "undefined" ? undefined : window.agentCanvasSpaces;
}

/**
 * One digest request. Throws with the main process' message on failure so the
 * caller can fall back to "continuing without its context".
 */
export async function requestSpaceSummary(request: {
  conversationId: string;
  messages: TranscriptMessage[];
}): Promise<{ summary: string; messageCount: number }> {
  const bridge = getSpaceSummaryBridge();
  if (!bridge) {
    throw new Error("The desktop app is required to summarize a space.");
  }
  const result = await bridge.summarize(request);
  if (!result.ok || !result.summary) {
    throw new Error(result.error ?? "The summariser returned nothing.");
  }
  return {
    summary: result.summary,
    messageCount: result.messageCount ?? request.messages.length,
  };
}

/** Every digest the main process has on disk (`{}` in a browser tab). */
export async function readStoredSpaceSummaries(): Promise<
  Record<string, SpaceSummaryEntry>
> {
  const bridge = getSpaceSummaryBridge();
  if (!bridge) return {};
  const result = await bridge.list();
  return result.ok && result.summaries ? result.summaries : {};
}
