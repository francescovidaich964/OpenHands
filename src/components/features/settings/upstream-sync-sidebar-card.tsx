import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import {
  getSelfUpdateBridge,
  type SyncPayload,
} from "#/utils/self-update-bridge";

/**
 * Compact, read-only view of the upstream sync for the sidebar update card:
 * where the fork stands plus a Check button. The full controls (start the sync,
 * conflict agent, push) live in the settings card, where the build log is too.
 * Renders nothing without the desktop bridge. Like the npm card it replaces, it
 * is visible by default (that card's `hideWhenUpToDate` defaults to false) and a
 * caller may ask for the quiet form. A finished sync is still reported: the
 * `lastSync` row is the one thing worth showing there.
 */
export function UpstreamSyncSidebarCard({
  hideWhenUpToDate = false,
}: {
  hideWhenUpToDate?: boolean;
} = {}) {
  const { t } = useTranslation("openhands");
  const bridge = getSelfUpdateBridge();
  const [payload, setPayload] = useState<SyncPayload | null>(null);

  // The snapshot is cheap (it never fetches), so the card shows the real phase
  // instead of waiting for a click.
  useEffect(() => {
    if (!bridge) return;
    void bridge.syncState().then((next) => {
      if (next.ok) setPayload(next);
    });
  }, [bridge]);

  if (!bridge) return null;

  const runCheck = async () => {
    const next = await bridge.syncCheck(true);
    if (next.ok) setPayload(next);
  };

  const tag = payload?.latestTag ?? null;
  // The same rule the npm card applies in the sidebar: an up-to-date fork with
  // nothing to report is a line nobody reads.
  if (
    hideWhenUpToDate &&
    payload?.phase === "upToDate" &&
    !payload.state &&
    !payload.lastSync
  ) {
    return null;
  }
  const detail = payload
    ? ["upToDate", "installed"].includes(payload.phase)
      ? t(I18nKey.SYNC$UP_TO_DATE, { tag: tag ?? "" })
      : ["available", "rebased"].includes(payload.phase)
        ? t(I18nKey.SYNC$AVAILABLE, {
            tag: tag ?? "",
            branch: payload.settings.syncBranch,
            forks: payload.forkCommitCount ?? 0,
          })
        : payload.phase === "conflict"
          ? t(I18nKey.SYNC$CONFLICT, { tag: tag ?? "" })
          : payload.phase === "dirty"
            ? t(I18nKey.SYNC$DIRTY)
            : payload.phase === "wrongBranch"
              ? t(I18nKey.SYNC$WRONG_BRANCH, {
                  branch: payload.branch ?? "",
                  syncBranch: payload.settings.syncBranch,
                })
              : t(I18nKey.SYNC$UNAVAILABLE)
    : null;

  return (
    <div className="flex flex-col gap-2" data-testid="upstream-sync-sidebar">
      <span className="text-xs font-medium text-contrast">
        {t(I18nKey.SYNC$TITLE)}
      </span>
      {detail && (
        <span
          className="text-xs text-muted"
          data-testid="upstream-sync-sidebar-phase"
        >
          {detail}
        </span>
      )}
      <button
        type="button"
        className="w-fit text-xs text-link hover:underline"
        data-testid="upstream-sync-sidebar-check"
        onClick={() => void runCheck()}
      >
        {t(I18nKey.SYNC$CHECK)}
      </button>
    </div>
  );
}
