import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/pod-exec.js", () => ({
  execInPod: vi.fn(),
  execInPodStreaming: vi.fn(),
  wrapCommandWithEnv: vi.fn(),
}));

import { execInPod } from "../../src/pod-exec.js";
import { prepareSandboxWorkspace } from "../../src/plugin.js";

describe("prepareSandboxWorkspace", () => {
  it("marks every directory safe for git inside the sandbox", async () => {
    vi.mocked(execInPod).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    await prepareSandboxWorkspace({} as never, "pc-acme", "pc-abc");
    expect(execInPod).toHaveBeenCalledWith(
      expect.anything(), "pc-acme", "pc-abc", "agent",
      ["git", "config", "--global", "--add", "safe.directory", "*"],
    );
  });

  it("fails loud when git config cannot be written", async () => {
    vi.mocked(execInPod).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "read-only" } as never);
    await expect(prepareSandboxWorkspace({} as never, "pc-acme", "pc-abc")).rejects.toThrow(/safe for git/);
  });
});
