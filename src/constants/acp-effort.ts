/**
 * Reasoning-effort levels for ACP harnesses that declare them, and the
 * `<model>/<effort>` id helpers the pickers share.
 *
 * The backend contract (OpenHands/software-agent-sdk#6107) is that an ACP model
 * id may carry an effort suffix: the SDK splits it off and applies it as two
 * config options (`model` + the provider's effort option), so the suffixed id
 * travels over the existing `switch_acp_model` / `acp_model` paths untouched and
 * comes back on `conversation.llm_model` still combined. The level list lives in
 * the SDK provider registry; these constants mirror it for the UI until the
 * client ships it (see the shortcut below).
 */

// shortcut: hand-mirrored copy of the SDK registry's `effort_levels`
// (software-agent-sdk#6107). Delete this map and read
// `ACPProviderInfo.effort_levels` from @openhands/typescript-client once the
// installed client carries the field — it is absent in 1.59.0.
const ACP_EFFORT_LEVELS: Record<string, readonly string[]> = {
  // claude-agent-acp `effort`
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  // codex-acp `reasoning_effort`
  codex: ["low", "medium", "high", "xhigh"],
};

/** The effort levels the provider accepts; empty when it has no effort option. */
export function getAcpEffortLevels(
  providerKey: string | null | undefined,
): readonly string[] {
  return (providerKey && ACP_EFFORT_LEVELS[providerKey]) || [];
}

export interface AcpModelEffort {
  /** The bare model id the model pickers list ("" when no model is chosen). */
  model: string;
  /** The effort suffix, or null when the agent's own default is used. */
  effort: string | null;
}

/**
 * Split a stored model id into `model` + `effort`. Mirrors the SDK's rule: only
 * a trailing token the provider actually declares is stripped, so ids that
 * legitimately contain a slash ("anthropic/claude-sonnet-4-5") stay whole.
 */
export function splitAcpModelEffort(
  modelId: string | null | undefined,
  effortLevels: readonly string[],
): AcpModelEffort {
  const id = modelId?.trim() ?? "";
  const cut = id.lastIndexOf("/");
  const effort = cut > 0 ? id.slice(cut + 1) : "";
  if (!effort || !effortLevels.includes(effort)) {
    return { model: id, effort: null };
  }
  return { model: id.slice(0, cut), effort };
}

/** Build the id to send/store for a `model` + `effort` choice. */
export function joinAcpModelEffort(
  model: string | null | undefined,
  effort: string | null,
): string | null {
  const base = model?.trim() ?? "";
  if (!base) return null;
  return effort ? `${base}/${effort}` : base;
}
