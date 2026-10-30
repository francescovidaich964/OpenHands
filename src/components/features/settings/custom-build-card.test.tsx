import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SelfUpdateBridge,
  SelfUpdateStatus,
} from "#/utils/self-update-bridge";
import { CustomBuildCard } from "./custom-build-card";

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
  build: { running: false, log: [], result: null },
};

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
});
