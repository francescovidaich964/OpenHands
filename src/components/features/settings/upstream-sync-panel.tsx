import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import {
  getSelfUpdateBridge,
  type SyncAgentKind,
  type SyncPayload,
} from "#/utils/self-update-bridge";

/** Re-read the main process while a build or an agent could be finishing. */
const POLL_MS = 5000;
const COPIED_FEEDBACK_MS = 2000;
const SHORT_SHA = 10;
const AGENT_KINDS: SyncAgentKind[] = ["opencode", "claude"];

// Product names, shown as-is in every language.
const AGENT_LABELS: Record<SyncAgentKind, string> = {
  opencode: "opencode",
  claude: "Claude Code",
};
/** Phases whose facts can change without the user pressing anything. */
const LIVE_PHASES: SyncPayload["phase"][] = [
  "conflict",
  "rebased",
  "dirty",
  "installed",
];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-text-dim">{label}</span>
      <span className="min-w-0 break-all font-mono text-contrast">{value}</span>
    </div>
  );
}

/**
 * Phase -> the one sentence the user needs. Everything else on the panel is
 * derived from the same payload, so the main process owns the decisions.
 */
function PhaseMessage({ data }: { data: SyncPayload }) {
  const { t } = useTranslation("openhands");
  const tag = data.state?.latestTag ?? data.latestTag ?? "";
  const text = {
    unavailable: t(I18nKey.SYNC$UNAVAILABLE),
    wrongBranch: t(I18nKey.SYNC$WRONG_BRANCH, {
      branch: data.branch ?? "",
      syncBranch: data.settings.syncBranch,
    }),
    upToDate: t(I18nKey.SYNC$UP_TO_DATE, { tag: data.latestTag ?? "" }),
    available: t(I18nKey.SYNC$AVAILABLE, {
      tag: data.latestTag ?? "",
      branch: data.settings.syncBranch,
      forks: data.forkCommitCount ?? 0,
    }),
    // A rebase git stopped between commits, with no conflicted files yet, is not
    // a conflict the user can look at: say what git is doing instead.
    conflict:
      data.conflictedFiles.length > 0
        ? t(I18nKey.SYNC$CONFLICT, { tag })
        : t(I18nKey.SYNC$REBASING, { tag }),
    rebased: t(I18nKey.SYNC$REBASED, { tag }),
    dirty: t(I18nKey.SYNC$DIRTY),
    installed: t(I18nKey.SYNC$INSTALLED, {
      tag,
      remote: data.settings.forkRemote,
    }),
  }[data.phase];

  const tone =
    data.phase === "conflict" || data.phase === "dirty"
      ? "border-warning/40 bg-warning/10 text-warning"
      : data.phase === "installed"
        ? "border-status-success/30 bg-status-success/10 text-status-success"
        : "border-border bg-base-secondary text-muted";

  return (
    <p
      data-testid="upstream-sync-phase"
      data-phase={data.phase}
      className={`rounded-lg border px-3 py-2 text-xs ${tone}`}
    >
      {text}
    </p>
  );
}

/**
 * Fork-only "Upstream sync" panel: rebases the fork's sync branch onto the
 * newest upstream release, rebuilds the app, and pushes the result to the
 * fork. Conflicts are handed to a CLI agent or to the user as a copyable task.
 * Rendered only when the Electron bridge exists (see CustomBuildCard).
 */
export function UpstreamSyncPanel({
  onBuildStarted,
}: {
  /** Notifies the Custom build card so it shows the build it now owns. */
  onBuildStarted?: () => void;
}) {
  const { t } = useTranslation("openhands");
  const bridge = getSelfUpdateBridge();
  const [data, setData] = useState<SyncPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentKind, setAgentKind] = useState<SyncAgentKind>("opencode");
  const [copied, setCopied] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  /** Discard is two steps: the first click only shows what it would drop. */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /**
   * Kept across polls: the payload that cleared the record is a one-off. Holds the
   * cleared record's backup branch (the recovery pointer the record took with it),
   * "" when it had none; null = nothing to show.
   */
  const [recordCleared, setRecordCleared] = useState<string | null>(null);

  const load = useCallback(
    async (check: boolean) => {
      if (!bridge) return;
      const next = check
        ? await bridge.syncCheck(true)
        : await bridge.syncState();
      setData(next);
      // A build the sync started that never ran is the panel's to report; the card
      // shows one that ran and failed.
      setError(
        next.ok
          ? (next.autoBuildError ?? next.checkError ?? null)
          : (next.error ?? null),
      );
      if (next.syncRecordCleared) setRecordCleared(next.clearedBackup ?? "");
      if (check) setConfirmDiscard(false);
    },
    [bridge],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Nothing pushes events from the sync, so the panel polls while anything
  // long-running could still be going on.
  const live =
    data !== null &&
    (data.building ||
      Boolean(data.agent?.running) ||
      LIVE_PHASES.includes(data.phase));
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void load(false), POLL_MS);
    return () => window.clearInterval(id);
  }, [live, load]);

  if (!bridge || !data?.supported) return null;

  /** One action at a time; every button reloads the facts when it is done. */
  const act = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
    startedBuild = false,
  ) => {
    setBusy(true);
    setError(null);
    setConfirmDiscard(false);
    setRecordCleared(null);
    let failed: string | null = null;
    try {
      const r = await fn();
      if (!r.ok) failed = r.error ?? "";
      else if (startedBuild) onBuildStarted?.();
    } finally {
      setBusy(false);
    }
    // The reload reports git facts, not the failed action: set it afterwards.
    await load(false);
    if (failed !== null) setError(failed);
  };

  const agentRunning = Boolean(data.agent?.running);
  const locked = busy || data.building;
  const canStart =
    data.phase === "available" &&
    !locked &&
    data.clean === true &&
    data.packaged;
  const showDiscard = ["rebased", "dirty", "installed"].includes(data.phase);

  return (
    <div
      data-testid="upstream-sync-panel"
      className="flex flex-col gap-2 border-t border-border pt-3"
    >
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold text-contrast">
          {t(I18nKey.SYNC$TITLE)}
        </h4>
        <p className="text-xs text-muted">{t(I18nKey.SYNC$DESCRIPTION)}</p>
      </div>

      <div className="flex flex-col gap-1">
        <Row
          label={t(I18nKey.SYNC$LATEST_TAG)}
          value={data.latestTag ?? t(I18nKey.SELF_UPDATE$UNKNOWN)}
        />
        <Row
          label={t(I18nKey.SYNC$INSTALLED_BASE)}
          value={
            data.installedUpstreamTag ??
            (data.cloneBaseTag
              ? `${data.cloneBaseTag} · ${data.installedSha?.slice(0, SHORT_SHA) ?? ""}`
              : t(I18nKey.SELF_UPDATE$UNKNOWN))
          }
        />
        {data.state?.backupBranch && (
          <Row
            label={t(I18nKey.SYNC$BACKUP_BRANCH)}
            value={data.state.backupBranch}
          />
        )}
        {data.lastSync && (
          <Row
            label={t(I18nKey.SYNC$LAST_SYNC)}
            value={`${data.lastSync.tag} · ${new Date(
              data.lastSync.pushedMs,
            ).toLocaleString()}`}
          />
        )}
      </div>

      <PhaseMessage data={data} />

      {recordCleared !== null && (
        <p
          data-testid="upstream-sync-cleared"
          data-backup={recordCleared}
          className="break-all text-xs text-muted"
        >
          {t(I18nKey.SYNC$RECORD_CLEARED, { backup: recordCleared || "-" })}
        </p>
      )}

      {data.phase === "conflict" && data.conflictedFiles.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-contrast">
            {t(I18nKey.SYNC$CONFLICT_FILES)}
          </span>
          <ul
            data-testid="upstream-sync-conflict-files"
            className="flex flex-col gap-0.5 font-mono text-xs text-muted"
          >
            {data.conflictedFiles.map((f) => (
              <li key={f} className="break-all">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.autoMerge && (
        <p
          data-testid="upstream-sync-auto-merge"
          className="break-words text-xs text-muted"
        >
          {data.autoMerge.conflicts.length > 0 || data.autoMerge.error
            ? t(I18nKey.SYNC$TRANSLATION_LEFT, {
                reason:
                  data.autoMerge.conflicts.join(", ") || data.autoMerge.error,
              })
            : t(I18nKey.SYNC$AUTO_MERGED, { keys: data.autoMerge.keys })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <BrandButton
          testId="upstream-sync-check-button"
          type="button"
          variant="secondary"
          isDisabled={locked}
          onClick={() => void load(true)}
        >
          {t(I18nKey.SYNC$CHECK)}
        </BrandButton>
        <BrandButton
          testId="upstream-sync-start-button"
          type="button"
          variant="primary"
          isDisabled={!canStart}
          onClick={() => void act(() => bridge.syncStart(), true)}
        >
          {t(I18nKey.SYNC$START)}
        </BrandButton>
        {data.phase === "conflict" && (
          <>
            <select
              data-testid="upstream-sync-agent-select"
              aria-label={t(I18nKey.SYNC$START_AGENT, { agent: "" }).trim()}
              value={agentKind}
              onChange={(e) => setAgentKind(e.target.value as SyncAgentKind)}
              className="min-w-0 rounded-md border border-border bg-surface-deep px-2 py-1 text-xs text-contrast"
            >
              {AGENT_KINDS.map((kind) => (
                <option key={kind} value={kind} disabled={!data.agents[kind]}>
                  {AGENT_LABELS[kind]}
                </option>
              ))}
            </select>
            <BrandButton
              testId="upstream-sync-agent-button"
              type="button"
              variant="primary"
              isDisabled={locked || agentRunning || !data.agents[agentKind]}
              onClick={() => void act(() => bridge.syncAgent(agentKind))}
            >
              {t(I18nKey.SYNC$START_AGENT, {
                agent: data.agent?.label ?? agentKind,
              })}
            </BrandButton>
            {data.taskText && (
              <BrandButton
                testId="upstream-sync-copy-button"
                type="button"
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(data.taskText).then(() => {
                    setCopied(true);
                    window.setTimeout(
                      () => setCopied(false),
                      COPIED_FEEDBACK_MS,
                    );
                  })
                }
              >
                {t(copied ? I18nKey.SYNC$TASK_COPIED : I18nKey.SYNC$COPY_TASK)}
              </BrandButton>
            )}
            <BrandButton
              testId="upstream-sync-abort-button"
              type="button"
              variant="secondary"
              isDisabled={locked || agentRunning}
              onClick={() => void act(() => bridge.syncAbort())}
            >
              {t(I18nKey.SYNC$ABORT)}
            </BrandButton>
          </>
        )}
        {data.phase === "installed" && (
          <BrandButton
            testId="upstream-sync-push-button"
            type="button"
            variant="primary"
            isDisabled={locked}
            onClick={() => void act(() => bridge.syncPush())}
          >
            {t(I18nKey.SYNC$PUSH)}
          </BrandButton>
        )}
        {showDiscard && !confirmDiscard && (
          <BrandButton
            testId="upstream-sync-discard-button"
            type="button"
            variant="secondary"
            isDisabled={locked}
            onClick={() => setConfirmDiscard(true)}
          >
            {t(I18nKey.SYNC$DISCARD)}
          </BrandButton>
        )}
      </div>

      {showDiscard && confirmDiscard && (
        <div
          data-testid="upstream-sync-discard-preview"
          className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <span data-testid="upstream-sync-discard-target">
            {t(I18nKey.SYNC$DISCARD_CONFIRM, {
              branch: data.settings.syncBranch,
              backup:
                data.discardPreview?.backupBranch ??
                data.state?.backupBranch ??
                "",
            })}
          </span>
          {(data.discardPreview?.commits.length ?? 0) > 0 && (
            <div className="flex flex-col gap-0.5">
              <span>{t(I18nKey.SYNC$DISCARD_COMMITS)}</span>
              <ul
                data-testid="upstream-sync-discard-commits"
                className="flex flex-col gap-0.5 font-mono text-muted"
              >
                {data.discardPreview?.commits.map((c) => (
                  <li key={c} className="break-all">
                    {c}
                  </li>
                ))}
                {data.discardPreview?.truncated && (
                  <li>{t(I18nKey.SYNC$DISCARD_MORE)}</li>
                )}
              </ul>
            </div>
          )}
          <div className="flex gap-2">
            <BrandButton
              testId="upstream-sync-discard-confirm-button"
              type="button"
              variant="primary"
              isDisabled={locked}
              onClick={() => void act(() => bridge.syncDiscard())}
            >
              {t(I18nKey.SYNC$DISCARD)}
            </BrandButton>
            <BrandButton
              testId="upstream-sync-discard-keep-button"
              type="button"
              variant="secondary"
              isDisabled={busy}
              onClick={() => setConfirmDiscard(false)}
            >
              {t(I18nKey.BUTTON$CANCEL)}
            </BrandButton>
          </div>
        </div>
      )}

      {data.agent && (
        <div className="flex flex-col gap-1">
          <span
            data-testid="upstream-sync-agent-status"
            className="text-xs text-muted"
          >
            {t(I18nKey.SYNC$AGENT_RUNNING, {
              agent: data.agent.label,
              pid: data.agent.pid,
            })}
          </span>
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            aria-expanded={logOpen}
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-contrast"
          >
            {logOpen ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {t(I18nKey.SYNC$AGENT_LOG)}
          </button>
          {logOpen && (
            <pre
              data-testid="upstream-sync-agent-log"
              className="max-h-48 overflow-auto rounded-lg border border-border bg-surface-deep p-2 font-mono text-xs text-muted"
            >
              {[...data.agent.log, ...data.agent.errLog].join("\n")}
            </pre>
          )}
        </div>
      )}

      {error && (
        <p
          data-testid="upstream-sync-error"
          className="break-all text-xs text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
