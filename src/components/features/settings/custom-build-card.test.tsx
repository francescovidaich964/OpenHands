import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SelfUpdateBridge,
  SelfUpdateStatus,
  SyncPayload,
} from "#/utils/self-update-bridge";
import { CustomBuildCard } from "./custom-build-card";

// The card mounts the upstream-sync panel, and these tests are only about the
// build, so the sync bridge just reports "not usable on this clone".
const unsupportedSync = { ok: true, supported: false } as SyncPayload;

const baseStatus: SelfUpdateStatus = {
  ok: true,
  error: null,
  supported: true,
  packaged: true,
  repoPath: "C:\\Projects\\personal\\OpenHands",
  installedSha: "aaaaaaaaaa1111",
  installedBranch: "custom/self-update",
  buildTime: "2026-10-30T00:00:00.000Z",
  gitFound: true,
  npmFound: true,
  branch: "custom/self-update",
  headSha: "bbbbbbbbbb2222",
  clean: true,
  pendingCommits: ["bbbbbbbbbb add a thing"],
  pendingCommitsError: null,
  lastInstall: [],
  build: { running: false, log: [], result: null },
};

function archiveEntry(sha: string, mtimeMs: number) {
  const name = `Agent-Canvas-Setup-1.0.0-${sha}.exe`;
  return {
    path: `C:\\x\\AgentCanvasBuilds\\${name}`,
    name,
    mtimeMs,
    size: 1,
    version: "1.0.0",
    sha,
  };
}

function installBridge(
  status: Partial<SelfUpdateStatus> = {},
  overrides: Partial<SelfUpdateBridge> = {},
) {
  const bridge: SelfUpdateBridge = {
    status: vi.fn().mockResolvedValue({ ...baseStatus, ...status }),
    build: vi.fn().mockResolvedValue({
      ok: true,
      installerPath:
        "C:\\Users\\me\\AppData\\Local\\AgentCanvasBuilds\\Agent-Canvas-Setup-1.0.0-bbbbbbb.exe",
      version: "1.0.0",
      sha: "bbbbbbb",
    }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    install: vi.fn().mockResolvedValue({ ok: true }),
    listArchive: vi.fn().mockResolvedValue({ ok: true, archive: [] }),
    onLog: vi.fn().mockReturnValue(() => {}),
    syncState: vi.fn().mockResolvedValue(unsupportedSync),
    syncCheck: vi.fn().mockResolvedValue(unsupportedSync),
    syncStart: vi.fn().mockResolvedValue({ ok: true }),
    syncAgent: vi.fn().mockResolvedValue({ ok: true }),
    syncAbort: vi.fn().mockResolvedValue({ ok: true }),
    syncDiscard: vi.fn().mockResolvedValue({ ok: true }),
    syncPush: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  window.agentCanvasSelfUpdate = bridge;
  return bridge;
}

afterEach(() => {
  delete window.agentCanvasSelfUpdate;
});

describe("CustomBuildCard", () => {
  it("renders nothing without the Electron bridge (plain browser)", () => {
    const { container } = render(<CustomBuildCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows clone status and the commits not yet installed", async () => {
    installBridge();
    render(<CustomBuildCard />);
    expect(await screen.findByTestId("custom-build-card")).toBeInTheDocument();
    expect(
      screen.getByText("C:\\Projects\\personal\\OpenHands"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("custom-build-pending-commits"),
    ).toHaveTextContent("add a thing");
    expect(screen.getByTestId("custom-build-build-button")).toBeEnabled();
  });

  it("warns and disables Build when the working tree is dirty", async () => {
    installBridge({ clean: false });
    render(<CustomBuildCard />);
    expect(
      await screen.findByTestId("custom-build-dirty-warning"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("custom-build-build-button")).toBeDisabled();
  });

  it("offers Restart to install after a successful build and installs that path", async () => {
    const bridge = installBridge();
    render(<CustomBuildCard />);
    fireEvent.click(await screen.findByTestId("custom-build-build-button"));
    const install = await screen.findByTestId("custom-build-install-button");
    fireEvent.click(install);
    await waitFor(() =>
      expect(bridge.install).toHaveBeenCalledWith(
        "C:\\Users\\me\\AppData\\Local\\AgentCanvasBuilds\\Agent-Canvas-Setup-1.0.0-bbbbbbb.exe",
      ),
    );
  });

  it("shows the failure and the last log lines when the build fails", async () => {
    installBridge(
      {},
      {
        build: vi
          .fn()
          .mockResolvedValue({ ok: false, error: "Build exited with code 1" }),
        onLog: vi.fn().mockReturnValue(() => {}),
      },
    );
    render(<CustomBuildCard />);
    fireEvent.click(await screen.findByTestId("custom-build-build-button"));
    const failure = await screen.findByTestId("custom-build-failure");
    expect(failure).toHaveTextContent("Build exited with code 1");
  });

  it("lets the user reinstall an archived build", async () => {
    const path =
      "C:\\x\\AgentCanvasBuilds\\Agent-Canvas-Setup-1.0.0-aaaaaaa.exe";
    const bridge = installBridge(
      {},
      {
        listArchive: vi.fn().mockResolvedValue({
          ok: true,
          archive: [
            {
              path,
              name: "Agent-Canvas-Setup-1.0.0-aaaaaaa.exe",
              mtimeMs: 1,
              size: 1,
              version: "1.0.0",
              sha: "aaaaaaa",
            },
          ],
        }),
      },
    );
    render(<CustomBuildCard />);
    fireEvent.click(await screen.findByTestId("custom-build-reinstall-button"));
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith(path));
  });

  it("disables install buttons while an install is starting, re-enables on failure", async () => {
    let finish: (v: { ok: boolean; error?: string }) => void = () => {};
    installBridge(
      {},
      {
        install: vi.fn(
          () =>
            new Promise<{ ok: boolean; error?: string }>((r) => {
              finish = r;
            }),
        ),
        listArchive: vi.fn().mockResolvedValue({
          ok: true,
          archive: [archiveEntry("ccccccc", 1)],
        }),
      },
    );
    render(<CustomBuildCard />);
    const button = await screen.findByTestId("custom-build-reinstall-button");
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    finish({ ok: false, error: "Could not start the install helper" });
    expect(
      await screen.findByTestId("custom-build-install-error"),
    ).toHaveTextContent("Could not start the install helper");
    expect(button).toBeEnabled();
  });

  it("defaults the rollback to the newest build that is not installed", async () => {
    // installedSha is aaaaaaaaaa1111; the installed build is the newest archive.
    const installed = archiveEntry("aaaaaaa", 3);
    const previous = archiveEntry("ccccccc", 2);
    installBridge(
      {},
      {
        listArchive: vi.fn().mockResolvedValue({
          ok: true,
          archive: [installed, previous, archiveEntry("ddddddd", 1)],
        }),
      },
    );
    render(<CustomBuildCard />);
    const select = (await screen.findByTestId(
      "custom-build-archive-select",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(previous.path));
    expect(select.options[0].textContent).toContain(
      "SELF_UPDATE$INSTALLED_TAG",
    );
    expect(select.options[1].textContent).not.toContain(
      "SELF_UPDATE$INSTALLED_TAG",
    );
  });

  it("says so when the build was cancelled", async () => {
    installBridge(
      {},
      {
        build: vi.fn().mockResolvedValue({
          ok: false,
          cancelled: true,
          error: "Build cancelled",
        }),
      },
    );
    render(<CustomBuildCard />);
    fireEvent.click(await screen.findByTestId("custom-build-build-button"));
    expect(
      await screen.findByTestId("custom-build-cancelled"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("custom-build-failure")).toBeNull();
  });

  it("adopts a build that is already running when the card mounts", async () => {
    // The upstream sync starts a build this card never asked for. The card reads
    // the main process's build state on mount and on every poll, so that build
    // shows up here as a build of its own, log included.
    installBridge(
      {},
      {
        status: vi.fn().mockResolvedValue({
          ...baseStatus,
          build: {
            running: true,
            log: ["upstream sync: starting the build"],
            result: null,
          },
        }),
      },
    );
    render(<CustomBuildCard />);
    expect(await screen.findByTestId("custom-build-log")).toHaveTextContent(
      "upstream sync: starting the build",
    );
  });

  it("shows how a build it did not start ended", async () => {
    // The same read the mount and the 5 s poll do: the result the main process
    // holds has to reach the screen even though Build was never pressed here.
    installBridge(
      {},
      {
        status: vi.fn().mockResolvedValue({
          ...baseStatus,
          build: {
            running: false,
            log: ["npm run build:desktop"],
            result: { ok: false, error: "Build exited with code 1" },
          },
        }),
      },
    );
    render(<CustomBuildCard />);
    expect(await screen.findByTestId("custom-build-failure")).toHaveTextContent(
      "Build exited with code 1",
    );
  });

  it("keeps Build enabled when only the pending-commit list failed", async () => {
    installBridge({
      pendingCommits: [],
      pendingCommitsError: "fatal: bad revision 'aaaaaaaaaa1111..HEAD'",
    });
    render(<CustomBuildCard />);
    expect(
      await screen.findByTestId("custom-build-pending-error"),
    ).toHaveTextContent("bad revision");
    expect(screen.getByTestId("custom-build-build-button")).toBeEnabled();
  });

  it("shows the last install attempt from install.log", async () => {
    installBridge({
      lastInstall: [
        "2026-11-04 10:00:00  helper started: installer=X",
        "2026-11-04 10:00:30  installer exit code: 0",
      ],
    });
    render(<CustomBuildCard />);
    expect(
      await screen.findByTestId("custom-build-last-install"),
    ).toHaveTextContent("installer exit code: 0");
  });

  it("keeps waiting through the poll that sees no result yet", async () => {
    // self-update.mjs clears `running` a moment before it stores `result`. Adopting
    // that pair would end the poll and leave the card with nothing to show, so a
    // poll that expects a build only ends on a running build or a real result.
    vi.useFakeTimers();
    try {
      const status = vi
        .fn()
        .mockResolvedValueOnce({
          ...baseStatus,
          build: {
            running: true,
            log: ["npm run build:desktop"],
            result: null,
          },
        })
        .mockResolvedValue({
          ...baseStatus,
          build: {
            running: false,
            log: ["npm run build:desktop"],
            result: null,
          },
        });
      installBridge({}, { status });
      render(<CustomBuildCard />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByTestId("custom-build-cancel-button"),
      ).toBeInTheDocument();

      const calls = status.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      // Still building (the cancel button is the building state) and still polled.
      expect(
        screen.getByTestId("custom-build-cancel-button"),
      ).toBeInTheDocument();
      expect(status.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait when a poll reports the build finished with a result", async () => {
    vi.useFakeTimers();
    try {
      const status = vi
        .fn()
        .mockResolvedValueOnce({
          ...baseStatus,
          build: { running: true, log: [], result: null },
        })
        .mockResolvedValue({
          ...baseStatus,
          build: {
            running: false,
            log: ["done"],
            result: { ok: false, error: "Build exited with code 1" },
          },
        });
      installBridge({}, { status });
      render(<CustomBuildCard />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.queryByTestId("custom-build-cancel-button"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("custom-build-failure")).toHaveTextContent(
        "Build exited with code 1",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
