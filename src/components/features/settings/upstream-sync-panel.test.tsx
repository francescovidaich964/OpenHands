import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SelfUpdateBridge,
  SyncAgentInfo,
  SyncPayload,
  SyncRecord,
} from "#/utils/self-update-bridge";
import { UpstreamSyncPanel } from "./upstream-sync-panel";

const record: SyncRecord = {
  latestTag: "v1.35.0",
  backupBranch: "custom/upstream-sync-backup-20261104",
  originSha: "cccccccccc3333",
  startedMs: 1,
  pushed: false,
};

const agent: SyncAgentInfo = {
  kind: "opencode",
  label: "opencode",
  pid: 4242,
  running: true,
  logPath: "C:\\x\\sync-agent-opencode.log",
  log: ["working on it"],
  errLog: [],
};

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    ok: true,
    supported: true,
    packaged: true,
    gitFound: true,
    agents: { opencode: true, claude: false },
    settings: {
      syncBranch: "custom/upstream-sync",
      upstreamRemote: "upstream",
      forkRemote: "origin",
      opencodeModel: "grok",
    },
    state: record,
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
    taskText: "Resolve the rebase of custom/upstream-sync onto v1.35.0.",
    lastSync: null,
    autoMerge: null,
    autoBuildError: null,
    syncRecordCleared: false,
    clearedBackup: null,
    discardPreview: {
      backupBranch: record.backupBranch,
      discardedBranch: "discarded/custom-upstream-sync-20261104-100000",
      commits: ["bbbbbbbbbb2222 fork: keep the custom build"],
      truncated: false,
    },
    ...overrides,
  };
}

// The panel only calls the sync methods; the build ones are inert stubs so the
// bridge satisfies the full preload contract.
function installBridge(next: SyncPayload) {
  const bridge: SelfUpdateBridge = {
    status: vi.fn().mockResolvedValue({ ok: true }),
    build: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    install: vi.fn().mockResolvedValue({ ok: true }),
    listArchive: vi.fn().mockResolvedValue({ ok: true }),
    onLog: vi.fn().mockReturnValue(() => {}),
    syncState: vi.fn().mockResolvedValue(next),
    syncCheck: vi.fn().mockResolvedValue(next),
    syncStart: vi.fn().mockResolvedValue({
      ok: true,
      phase: "rebased",
      buildStarted: true,
    }),
    syncAgent: vi.fn().mockResolvedValue({ ok: true, pid: 4242 }),
    syncAbort: vi.fn().mockResolvedValue({ ok: true }),
    syncDiscard: vi.fn().mockResolvedValue({ ok: true }),
    syncPush: vi.fn().mockResolvedValue({ ok: true, pushedTo: "origin" }),
  };
  window.agentCanvasSelfUpdate = bridge;
  return bridge;
}

function copyToClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  delete window.agentCanvasSelfUpdate;
});

describe("UpstreamSyncPanel", () => {
  it("renders nothing in a plain browser (no Electron bridge)", async () => {
    const { container } = render(<UpstreamSyncPanel />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the clone is not usable", async () => {
    installBridge(payload({ supported: false }));
    const { container } = render(<UpstreamSyncPanel />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the facts and enables Start when a tag is pending", async () => {
    installBridge(payload());
    render(<UpstreamSyncPanel />);
    expect(
      await screen.findByTestId("upstream-sync-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("upstream-sync-start-button")).toBeEnabled();
    expect(
      screen.queryByTestId("upstream-sync-agent-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("upstream-sync-push-button"),
    ).not.toBeInTheDocument();
  });

  it("disables Start while a build runs or the tree is dirty", async () => {
    installBridge(payload({ building: true }));
    const { rerender } = render(<UpstreamSyncPanel />);
    expect(
      await screen.findByTestId("upstream-sync-start-button"),
    ).toBeDisabled();

    installBridge(payload({ clean: false, phase: "dirty" }));
    rerender(<UpstreamSyncPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("upstream-sync-start-button")).toBeDisabled(),
    );
    expect(
      screen.getByTestId("upstream-sync-discard-button"),
    ).toBeInTheDocument();
  });

  it("offers the conflict tools and disables agents that were not found", async () => {
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: ["src/a.tsx", "electron/main.mjs"],
      }),
    );
    render(<UpstreamSyncPanel />);
    const select = (await screen.findByTestId(
      "upstream-sync-agent-select",
    )) as HTMLSelectElement;
    expect((select.options[0] as HTMLOptionElement).disabled).toBe(false);
    expect((select.options[1] as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByTestId("upstream-sync-abort-button")).toBeEnabled();
    expect(
      screen.getByTestId("upstream-sync-conflict-files"),
    ).toHaveTextContent("electron/main.mjs");

    // opencode is on PATH, so its button is usable; claude is not.
    expect(screen.getByTestId("upstream-sync-agent-button")).toBeEnabled();
    fireEvent.change(select, { target: { value: "claude" } });
    expect(screen.getByTestId("upstream-sync-agent-button")).toBeDisabled();
  });

  it("says the i18n file was auto-merged, with the fork's key count", async () => {
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: ["electron/main.mjs"],
        autoMerge: { stops: 2, keys: 55, conflicts: [], error: null, ms: 12 },
      }),
    );
    render(<UpstreamSyncPanel />);
    // Tests do not load the translation files, so this names the branch that rendered.
    expect(
      await screen.findByTestId("upstream-sync-auto-merge"),
    ).toHaveTextContent("SYNC$AUTO_MERGED");
  });

  it("says when the merge left the i18n file for the user", async () => {
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: ["src/i18n/translation.json"],
        autoMerge: {
          stops: 0,
          keys: 0,
          conflicts: ["SYNC$START"],
          error: null,
          ms: 3,
        },
      }),
    );
    render(<UpstreamSyncPanel />);
    expect(
      await screen.findByTestId("upstream-sync-auto-merge"),
    ).toHaveTextContent("SYNC$TRANSLATION_LEFT");
  });

  it("says nothing about the i18n merge when it never ran", async () => {
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: ["electron/main.mjs"],
      }),
    );
    render(<UpstreamSyncPanel />);
    await screen.findByTestId("upstream-sync-conflict-files");
    expect(
      screen.queryByTestId("upstream-sync-auto-merge"),
    ).not.toBeInTheDocument();
  });

  it("copies the task text to the clipboard", async () => {
    installBridge(payload({ phase: "conflict", rebaseInProgress: true }));
    const writeText = copyToClipboard();
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-copy-button"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Resolve the rebase of custom/upstream-sync onto v1.35.0.",
      ),
    );
  });

  it("shows the running agent and blocks the mutating buttons", async () => {
    installBridge(payload({ phase: "conflict", agent }));
    render(<UpstreamSyncPanel />);
    // In tests t() returns the key, so only the presence of the status line is
    // assertable; the pid interpolation is covered by the logic unit tests.
    expect(
      await screen.findByTestId("upstream-sync-agent-status"),
    ).toBeInTheDocument();
    // F4: a running agent's log is open without a click (opencode writes almost
    // everything to stderr, so a collapsed block reads as an empty one).
    expect(
      await screen.findByTestId("upstream-sync-agent-log"),
    ).toHaveTextContent("working on it");
    // The toggle stays usable: it closes the log and the next poll leaves it shut.
    fireEvent.click(screen.getByText("SYNC$AGENT_LOG"));
    expect(
      screen.queryByTestId("upstream-sync-agent-log"),
    ).not.toBeInTheDocument();
    // A running agent blocks the mutating buttons, but Check stays usable so the
    // user can watch progress.
    expect(screen.getByTestId("upstream-sync-abort-button")).toBeDisabled();
    expect(screen.getByTestId("upstream-sync-agent-button")).toBeDisabled();
    expect(screen.getByTestId("upstream-sync-check-button")).toBeEnabled();
  });

  it("pushes the sync branch from the installed phase", async () => {
    const bridge = installBridge(
      payload({ phase: "installed", branchContainsTarget: true }),
    );
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-push-button"));
    await waitFor(() => expect(bridge.syncPush).toHaveBeenCalled());
  });

  it("starts the sync and tells the parent the build began", async () => {
    const bridge = installBridge(payload());
    const onBuildStarted = vi.fn();
    render(<UpstreamSyncPanel onBuildStarted={onBuildStarted} />);
    fireEvent.click(await screen.findByTestId("upstream-sync-start-button"));
    await waitFor(() => {
      expect(bridge.syncStart).toHaveBeenCalled();
      expect(onBuildStarted).toHaveBeenCalled();
    });
  });

  it("does not promise a build the sync never started", async () => {
    // F4: a sync that stopped on conflicts starts no build, so the parent card must
    // not switch to its "building" state on the strength of a green reply.
    const bridge = installBridge(payload());
    vi.mocked(bridge.syncStart).mockResolvedValueOnce({
      ok: true,
      phase: "conflict",
      buildStarted: false,
    });
    const onBuildStarted = vi.fn();
    render(<UpstreamSyncPanel onBuildStarted={onBuildStarted} />);
    fireEvent.click(await screen.findByTestId("upstream-sync-start-button"));
    await waitFor(() => expect(bridge.syncStart).toHaveBeenCalled());
    expect(onBuildStarted).not.toHaveBeenCalled();
  });

  it("only claims a rebuild is running when one actually started", async () => {
    installBridge(payload({ phase: "rebased", building: true }));
    const { unmount } = render(<UpstreamSyncPanel />);
    await screen.findByTestId("upstream-sync-panel");
    expect(screen.getByTestId("upstream-sync-phase").textContent).toBe(
      "SYNC$REBASED",
    );
    unmount();

    installBridge(payload({ phase: "rebased", building: false }));
    render(<UpstreamSyncPanel />);
    await screen.findByTestId("upstream-sync-panel");
    expect(screen.getByTestId("upstream-sync-phase").textContent).toBe(
      "SYNC$REBASED_NO_BUILD",
    );
  });

  it("names the git error when the auto-merge could not continue the rebase", async () => {
    // F4: a failed `git rebase --continue` is not a translation problem, and the
    // old sentence sent the reader to the i18n file.
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: [],
        autoMerge: {
          stops: 1,
          keys: 0,
          conflicts: [],
          error: "git rebase --continue failed:\nhint: Disable this message",
          ms: 4,
        },
      }),
    );
    render(<UpstreamSyncPanel />);
    expect(
      await screen.findByTestId("upstream-sync-auto-merge"),
    ).toHaveTextContent("SYNC$REBASE_STOPPED");
  });

  it("only reports the last sync when it belongs to the branch you are on", async () => {
    const lastSync = {
      tag: "v1.35.0",
      pushedMs: 1762000000000,
      backupBranch: "backup/custom/upstream-sync-20261104-100000",
      branch: "custom/upstream-sync",
    };
    installBridge(payload({ lastSync }));
    const { unmount } = render(<UpstreamSyncPanel />);
    expect(await screen.findByText("SYNC$LAST_SYNC")).toBeInTheDocument();
    unmount();

    // F4: a sync pushed from another branch says nothing about this one.
    installBridge(
      payload({ lastSync: { ...lastSync, branch: "custom/other-branch" } }),
    );
    render(<UpstreamSyncPanel />);
    await screen.findByTestId("upstream-sync-panel");
    expect(screen.queryByText("SYNC$LAST_SYNC")).not.toBeInTheDocument();
  });

  it("labels the discard confirmation with its own text", async () => {
    // F4: the confirm button reused the key of the sentence above it, so the two
    // read as one run-on string in the UI.
    installBridge(payload({ phase: "installed", branchContainsTarget: true }));
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-discard-button"));
    const yes = await screen.findByTestId(
      "upstream-sync-discard-confirm-button",
    );
    expect(yes).toHaveTextContent("SYNC$DISCARD_YES");
  });

  it("says what happened when a later check finds the sync already merged", async () => {
    // The finished record is dropped from the payload, so without a mark the
    // panel would fall back to "no sync in flight" without a word about the
    // sync it was showing a second ago.
    installBridge(
      payload({ state: null, phase: "upToDate", syncRecordCleared: true }),
    );
    render(<UpstreamSyncPanel />);
    expect(
      await screen.findByTestId("upstream-sync-cleared"),
    ).toBeInTheDocument();
  });

  it("shows why a build the sync asked for could not start", async () => {
    installBridge(
      payload({ autoBuildError: "another build is already running" }),
    );
    render(<UpstreamSyncPanel />);
    expect(await screen.findByTestId("upstream-sync-error")).toHaveTextContent(
      "another build is already running",
    );
  });

  it("asks before it discards, and only the second click throws work away", async () => {
    const bridge = installBridge(
      payload({ phase: "installed", branchContainsTarget: true }),
    );
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-discard-button"));
    // The first click only shows what would be lost.
    expect(
      await screen.findByTestId("upstream-sync-discard-preview"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("upstream-sync-discard-commits"),
    ).toHaveTextContent("fork: keep the custom build");
    expect(bridge.syncDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("upstream-sync-discard-confirm-button"));
    await waitFor(() => expect(bridge.syncDiscard).toHaveBeenCalled());
  });

  it("shows the conflict controls and the task with the paths it needs", async () => {
    const bridge = installBridge(payload());
    vi.mocked(bridge.syncStart).mockResolvedValueOnce({
      ok: false,
      error: "dirty tree",
    });
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-start-button"));
    expect(await screen.findByTestId("upstream-sync-error")).toHaveTextContent(
      "dirty tree",
    );
  });

  it("Check re-fetches upstream", async () => {
    const bridge = installBridge(payload());
    render(<UpstreamSyncPanel />);
    fireEvent.click(await screen.findByTestId("upstream-sync-check-button"));
    await waitFor(() => expect(bridge.syncCheck).toHaveBeenCalledWith(true));
  });

  it("names the backup branch of the record it just cleared", async () => {
    // The record is gone from the payload, so the backup branch it carried is the
    // only pointer left to the work.
    installBridge(
      payload({
        state: null,
        phase: "upToDate",
        syncRecordCleared: true,
        clearedBackup: "custom/upstream-sync-backup-20261104",
      }),
    );
    render(<UpstreamSyncPanel />);
    const notice = await screen.findByTestId("upstream-sync-cleared");
    // The test i18n mock does not interpolate, so the pointer is read off the node.
    expect(notice).toHaveAttribute(
      "data-backup",
      "custom/upstream-sync-backup-20261104",
    );
  });

  it("keeps the cleared notice when the record had no backup branch", async () => {
    installBridge(
      payload({ state: null, phase: "upToDate", syncRecordCleared: true }),
    );
    render(<UpstreamSyncPanel />);
    const notice = await screen.findByTestId("upstream-sync-cleared");
    expect(notice).toBeInTheDocument();
    expect(notice).not.toHaveTextContent("undefined");
  });

  it("says git is rebasing when the rebase stopped with no files yet", async () => {
    installBridge(
      payload({
        phase: "conflict",
        rebaseInProgress: true,
        conflictedFiles: [],
      }),
    );
    render(<UpstreamSyncPanel />);
    expect(await screen.findByTestId("upstream-sync-phase")).toHaveTextContent(
      "SYNC$REBASING",
    );
  });

  it("names the conflicts when git has files to show", async () => {
    installBridge(
      payload({ phase: "conflict", conflictedFiles: ["electron/main.mjs"] }),
    );
    render(<UpstreamSyncPanel />);
    expect(await screen.findByTestId("upstream-sync-phase")).toHaveTextContent(
      "SYNC$CONFLICT",
    );
  });
});
