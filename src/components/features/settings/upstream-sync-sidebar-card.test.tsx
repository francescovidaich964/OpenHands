import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfUpdateBridge, SyncPayload } from "#/utils/self-update-bridge";
import { UpstreamSyncSidebarCard } from "./upstream-sync-sidebar-card";

// The compact card reads phase/latestTag/forkCommitCount/settings only; the rest
// of the payload has to be present to satisfy the preload contract.
function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    ok: true,
    supported: true,
    packaged: true,
    gitFound: true,
    agents: { opencode: true, claude: true },
    settings: {
      syncBranch: "custom/upstream-sync",
      upstreamRemote: "upstream",
      forkRemote: "origin",
      opencodeModel: "grok",
    },
    state: null,
    phase: "available",
    installedUpstreamTag: "v1.34.0",
    installedSha: "aaaaaaaaaa1111",
    buildTime: "2026-10-30T00:00:00.000Z",
    lastCheckError: null,
    lastFetchMs: 1,
    building: false,
    agent: null,
    repoPath: "C:\\Projects\\personal\\OpenHands",
    branch: "custom/upstream-sync",
    headSha: "bbbbbbbbbb2222",
    onSyncBranch: true,
    clean: true,
    latestTag: "v1.35.0",
    cloneBaseTag: "v1.34.0",
    forkCommitCount: 3,
    rebaseInProgress: false,
    conflictedFiles: [],
    updateAvailable: true,
    branchContainsTarget: false,
    taskText: "",
    lastSync: null,
    autoBuildError: null,
    syncRecordCleared: false,
    clearedBackup: null,
    discardPreview: null,
    ...overrides,
  };
}

function installBridge(next: SyncPayload) {
  const syncCheck = vi.fn().mockResolvedValue(next);
  const bridge: SelfUpdateBridge = {
    status: vi.fn().mockResolvedValue({ ok: true }),
    build: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    install: vi.fn().mockResolvedValue({ ok: true }),
    listArchive: vi.fn().mockResolvedValue({ ok: true }),
    onLog: vi.fn().mockReturnValue(() => {}),
    syncState: vi.fn().mockResolvedValue(next),
    syncCheck,
    syncStart: vi.fn().mockResolvedValue({ ok: true }),
    syncAgent: vi.fn().mockResolvedValue({ ok: true }),
    syncAbort: vi.fn().mockResolvedValue({ ok: true }),
    syncDiscard: vi.fn().mockResolvedValue({ ok: true }),
    syncPush: vi.fn().mockResolvedValue({ ok: true }),
  };
  window.agentCanvasSelfUpdate = bridge;
  return syncCheck;
}

afterEach(() => {
  delete window.agentCanvasSelfUpdate;
});

describe("UpstreamSyncSidebarCard", () => {
  it("renders nothing in a plain browser", async () => {
    const { container } = render(<UpstreamSyncSidebarCard />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the phase and re-fetches upstream on Check", async () => {
    const syncCheck = installBridge(payload());
    render(<UpstreamSyncSidebarCard />);
    expect(
      await screen.findByTestId("upstream-sync-sidebar-phase"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("upstream-sync-sidebar-check"));
    await waitFor(() => expect(syncCheck).toHaveBeenCalledWith(true));
  });

  it("hides itself while the fork is up to date when asked to be quiet", async () => {
    // Hiding is the caller's choice; the default matches the npm card, which is
    // always visible.
    installBridge(payload({ phase: "upToDate" }));
    const { container } = render(<UpstreamSyncSidebarCard hideWhenUpToDate />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays visible while the fork is up to date by default", async () => {
    installBridge(payload({ phase: "upToDate" }));
    render(<UpstreamSyncSidebarCard />);
    const phase = await screen.findByTestId("upstream-sync-sidebar-phase");
    expect(phase).toHaveTextContent("SYNC$UP_TO_DATE");
  });

  it("still shows the card for the record it just pushed", async () => {
    installBridge(
      payload({
        phase: "upToDate",
        lastSync: {
          tag: "v1.35.0",
          pushedMs: 1,
          backupBranch: "custom/upstream-sync-backup-20261104",
        },
      }),
    );
    render(<UpstreamSyncSidebarCard />);
    expect(
      await screen.findByTestId("upstream-sync-sidebar"),
    ).toBeInTheDocument();
  });

  it("says it is unavailable instead of inventing a phase", async () => {
    // This is what the main process sends when the app has no build-info clone:
    // repoPath null, so deriveSyncPhase answers "unavailable".
    installBridge(payload({ repoPath: null, phase: "unavailable" }));
    render(<UpstreamSyncSidebarCard />);
    const phase = await screen.findByTestId("upstream-sync-sidebar-phase");
    expect(phase).toHaveTextContent("SYNC$UNAVAILABLE");
  });
});
