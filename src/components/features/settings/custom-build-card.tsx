import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { BrandButton } from "#/components/features/settings/brand-button";
import { I18nKey } from "#/i18n/declaration";
import { UpstreamSyncPanel } from "#/components/features/settings/upstream-sync-panel";
import {
  getSelfUpdateBridge,
  type SelfUpdateArchiveEntry,
  type SelfUpdateBuildResult,
  type SelfUpdateStatus,
} from "#/utils/self-update-bridge";

const MAX_LOG_LINES = 2000;
/** Re-read the main process while a build it started could be finishing. */
const BUILD_POLL_MS = 5000;
/** Polls with no build state before the card stops believing a build is running. */
const MAX_BUILD_WAIT_POLLS = 5;
const FAILURE_LOG_LINES = 50;
const SHORT_SHA = 10;

function short(sha: string | null | undefined) {
  return sha ? sha.slice(0, SHORT_SHA) : null;
}

function isInstalledEntry(
  entry: SelfUpdateArchiveEntry,
  installedSha: string | null | undefined,
) {
  return Boolean(entry.sha && installedSha?.startsWith(entry.sha));
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-text-dim">{label}</span>
      <span className="min-w-0 break-all font-mono text-contrast">{value}</span>
    </div>
  );
}

/**
 * Fork-only "Custom build" card: builds a new installer from the local clone
 * and installs it. Rendered only where the Electron bridge exists (see
 * CustomBuildCard below) — the same frontend also runs in a plain browser.
 */
function CustomBuildCardInner() {
  const { t } = useTranslation("openhands");
  const bridge = getSelfUpdateBridge()!;
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [building, setBuilding] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [result, setResult] = useState<SelfUpdateBuildResult | null>(null);
  const [archive, setArchive] = useState<SelfUpdateArchiveEntry[]>([]);
  const [selectedArchive, setSelectedArchive] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  // `adoptBuild`: take the main process's build state (running / log / last
  // result) — on mount, so the card reattaches after navigating away. After a
  // build this card already holds the fresh result and log.
  // `expectRunning`: the caller believes a build is running (the poll). See the
  // guard below.
  const refresh = useCallback(
    async (adoptBuild: boolean, expectRunning = false) => {
      const s = await bridge.status();
      setStatus(s);
      if (adoptBuild && s.build) {
        // A build that just finished reads running:false for a moment *before* its
        // result is stored (self-update.mjs still reads the sha in between).
        // Adopting that pair would end the poll and leave the card with nothing to
        // show, so while a build is expected only a running build or a real result
        // may end it.
        const keepWaiting =
          expectRunning && !s.build.running && !s.build.result;
        if (!keepWaiting) {
          setBuilding(s.build.running);
          setLog(s.build.log);
          setResult(s.build.result);
          if (s.build.running) setLogOpen(true);
        }
      }
      const a = await bridge.listArchive();
      const entries = a.archive ?? [];
      setArchive(entries);
      // Default to the newest build that is not the installed one: that is
      // what "go back" means.
      const fallback =
        entries.find((e) => !isInstalledEntry(e, s.installedSha)) ?? entries[0];
      setSelectedArchive((cur) =>
        entries.some((e) => e.path === cur) ? cur : (fallback?.path ?? ""),
      );
      // The caller decides whether a build is still worth waiting for (see below).
      return s;
    },
    [bridge],
  );

  useEffect(() => {
    void refresh(true);
    return bridge.onLog((lines) =>
      setLog((prev) => [...prev, ...lines].slice(-MAX_LOG_LINES)),
    );
  }, [bridge, refresh]);

  // The upstream sync starts a build this card did not ask for (it only says
  // "a build started"). Keep adopting the main process's build state while one is
  // running, so the card also learns when that build ended and what it returned.
  // The wait is bounded: a build the sync promised but never started (a guard in the
  // main process refused it) would otherwise leave this card on "Building..." with
  // nothing to show. Any real build state resets the count.
  useEffect(() => {
    if (!building) return;
    let stalled = 0;
    const tick = async () => {
      const s = await refresh(true, true);
      const noState = !s.build || (!s.build.running && !s.build.result);
      stalled = noState ? stalled + 1 : 0;
      if (stalled >= MAX_BUILD_WAIT_POLLS) setBuilding(false);
    };
    const id = window.setInterval(() => void tick(), BUILD_POLL_MS);
    return () => window.clearInterval(id);
  }, [building, refresh]);

  const build = async () => {
    setBuilding(true);
    setResult(null);
    setInstallError(null);
    setLog([]);
    setLogOpen(true);
    const r = await bridge.build();
    setResult(r);
    setBuilding(false);
    await refresh(false);
  };

  const install = async (path: string) => {
    setInstallError(null);
    setInstalling(true);
    const r = await bridge.install(path);
    // On success the app is about to quit, so the buttons stay disabled.
    if (!r.ok) {
      setInstallError(r.error ?? "");
      setInstalling(false);
    }
  };

  if (!status) return null;
  if (!status.supported) return null;

  const dirty = status.clean === false;
  const canBuild =
    !building &&
    !installing &&
    !dirty &&
    !status.error &&
    status.gitFound &&
    status.npmFound &&
    status.clean === true;
  const unknown = t(I18nKey.SELF_UPDATE$UNKNOWN);

  return (
    <section
      data-testid="custom-build-card"
      className="flex flex-col gap-3 rounded-md border border-border bg-base-secondary px-4 py-3"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-contrast">
          {t(I18nKey.SELF_UPDATE$CARD_TITLE)}
        </h3>
        <p className="text-xs text-muted">
          {t(I18nKey.SELF_UPDATE$DESCRIPTION)}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <Row
          label={t(I18nKey.SELF_UPDATE$REPO_PATH)}
          value={status.repoPath ?? unknown}
        />
        <Row
          label={t(I18nKey.SELF_UPDATE$BRANCH)}
          value={status.branch ?? status.installedBranch ?? unknown}
        />
        <Row
          label={t(I18nKey.SELF_UPDATE$INSTALLED_COMMIT)}
          value={short(status.installedSha) ?? unknown}
        />
        <Row
          label={t(I18nKey.SELF_UPDATE$HEAD_COMMIT)}
          value={short(status.headSha) ?? unknown}
        />
      </div>

      {status.error && (
        <p
          data-testid="custom-build-status-error"
          className="text-xs text-danger"
        >
          {t(I18nKey.SELF_UPDATE$STATUS_ERROR, { error: status.error })}
        </p>
      )}

      {(!status.gitFound || !status.npmFound) && (
        <p className="text-xs text-danger">
          {t(I18nKey.SELF_UPDATE$TOOLS_MISSING)}
        </p>
      )}

      {dirty && (
        <div
          data-testid="custom-build-dirty-warning"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>{t(I18nKey.SELF_UPDATE$DIRTY_WARNING)}</span>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-contrast">
          {t(I18nKey.SELF_UPDATE$PENDING_COMMITS)}
        </span>
        {status.pendingCommits.length > 0 ? (
          <ul
            data-testid="custom-build-pending-commits"
            className="flex flex-col gap-0.5 font-mono text-xs text-muted"
          >
            {status.pendingCommits.map((c) => (
              <li key={c} className="break-all">
                {c}
              </li>
            ))}
          </ul>
        ) : (
          !status.pendingCommitsError && (
            <span className="text-xs text-muted">
              {t(I18nKey.SELF_UPDATE$UP_TO_DATE)}
            </span>
          )
        )}
        {status.pendingCommitsError && (
          <span
            data-testid="custom-build-pending-error"
            className="break-all text-xs text-muted"
          >
            {status.pendingCommitsError}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <BrandButton
          testId="custom-build-build-button"
          type="button"
          variant="primary"
          isDisabled={!canBuild}
          onClick={() => void build()}
        >
          {t(
            building ? I18nKey.SELF_UPDATE$BUILDING : I18nKey.SELF_UPDATE$BUILD,
          )}
        </BrandButton>
        {building && (
          <BrandButton
            testId="custom-build-cancel-button"
            type="button"
            variant="secondary"
            onClick={() => void bridge.cancel()}
          >
            {t(I18nKey.BUTTON$CANCEL)}
          </BrandButton>
        )}
      </div>

      {(building || log.length > 0) && (
        <div className="flex flex-col gap-1">
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
            {t(I18nKey.SELF_UPDATE$BUILD_LOG)}
          </button>
          {logOpen && (
            <pre
              data-testid="custom-build-log"
              className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-deep p-2 font-mono text-xs text-muted"
            >
              {log.join("\n")}
            </pre>
          )}
        </div>
      )}

      {result?.ok && result.installerPath && (
        <div
          data-testid="custom-build-success"
          className="flex flex-col gap-2 rounded-lg border border-status-success/30 bg-status-success/10 px-3 py-2 text-xs text-status-success"
        >
          <span>
            {t(I18nKey.SELF_UPDATE$BUILD_SUCCESS, {
              version: result.version,
              sha: result.sha,
            })}
          </span>
          <BrandButton
            testId="custom-build-install-button"
            type="button"
            variant="primary"
            className="w-fit"
            isDisabled={installing}
            onClick={() => void install(result.installerPath!)}
          >
            {t(I18nKey.SELF_UPDATE$RESTART_TO_INSTALL)}
          </BrandButton>
        </div>
      )}

      {result && !result.ok && !result.cancelled && (
        <div
          data-testid="custom-build-failure"
          className="flex flex-col gap-1 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <span>{t(I18nKey.SELF_UPDATE$BUILD_FAILED)}</span>
          {result.error && <span>{result.error}</span>}
          <pre className="max-h-48 overflow-auto font-mono text-xs">
            {log.slice(-FAILURE_LOG_LINES).join("\n")}
          </pre>
        </div>
      )}

      {result?.cancelled && !building && (
        <p data-testid="custom-build-cancelled" className="text-xs text-muted">
          {t(I18nKey.SELF_UPDATE$BUILD_CANCELLED)}
        </p>
      )}

      {installError && (
        <p
          className="text-xs text-danger"
          data-testid="custom-build-install-error"
        >
          {installError}
        </p>
      )}

      <UpstreamSyncPanel
        onBuildStarted={() => {
          setBuilding(true);
          setLogOpen(true);
        }}
      />

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <span className="text-xs font-medium text-contrast">
          {t(I18nKey.SELF_UPDATE$REINSTALL_PREVIOUS)}
        </span>
        {archive.length === 0 ? (
          <span className="text-xs text-muted">
            {t(I18nKey.SELF_UPDATE$NO_ARCHIVE)}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              data-testid="custom-build-archive-select"
              value={selectedArchive}
              onChange={(e) => setSelectedArchive(e.target.value)}
              className="min-w-0 rounded-md border border-border bg-surface-deep px-2 py-1 font-mono text-xs text-contrast"
            >
              {archive.map((e) => (
                <option key={e.path} value={e.path}>
                  {`${e.version ?? "?"} · ${short(e.sha) ?? "?"}${e.branch ? ` · ${e.branch}` : ""} · ${new Date(e.mtimeMs).toLocaleString()}`}
                  {isInstalledEntry(e, status.installedSha)
                    ? ` (${t(I18nKey.SELF_UPDATE$INSTALLED_TAG)})`
                    : ""}
                </option>
              ))}
            </select>
            <BrandButton
              testId="custom-build-reinstall-button"
              type="button"
              variant="secondary"
              isDisabled={!selectedArchive || building || installing}
              onClick={() => void install(selectedArchive)}
            >
              {t(I18nKey.SELF_UPDATE$REINSTALL)}
            </BrandButton>
          </div>
        )}
        {status.lastInstall.length > 0 && (
          <details data-testid="custom-build-last-install">
            <summary className="cursor-pointer text-xs font-medium text-contrast">
              {t(I18nKey.SELF_UPDATE$LAST_INSTALL_LOG)}
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-surface-deep p-2 font-mono text-xs text-muted">
              {status.lastInstall.join("\n")}
            </pre>
          </details>
        )}
      </div>
    </section>
  );
}

/** Renders nothing unless the Electron self-update bridge is present. */
export function CustomBuildCard() {
  if (!getSelfUpdateBridge()) return null;
  return <CustomBuildCardInner />;
}
