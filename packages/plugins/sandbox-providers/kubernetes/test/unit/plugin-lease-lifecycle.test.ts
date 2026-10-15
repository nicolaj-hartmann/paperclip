import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      podName,
    },
  };
}

beforeEach(() => {
  h.clients = {};
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease and cancels its idle shutdown", async () => {
    const patchCr = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
        patchNamespacedCustomObject: patchCr,
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(expect.objectContaining({ remoteCwd: "/workspace/repo" }));
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
        // sandbox-cr has a pod-exec channel, so native file sync stays enabled.
        nativeFileSyncUnsupported: false,
      }),
    );
    expect(patchCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc", body: { spec: { shutdownTime: null } } }),
      expect.anything(),
    );
  });

  it("reports the lease expired when the controller removed the Sandbox before its shutdown could be cancelled", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
        patchNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      core: { readNamespacedPod: vi.fn().mockResolvedValue({ metadata: {}, status: { phase: "Running" } }) },
    };
    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config: CONFIG,
      providerLeaseId: "pc-abc", leaseMetadata: leaseMetadata(),
    });
    expect(lease).toEqual({ providerLeaseId: null, metadata: { expired: true, reason: "Sandbox CR no longer exists" } });
  });

  it("flags a resumed job-backend lease as native-sync-unsupported so the server keeps the base64 fallback", async () => {
    h.clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod" }),
    });

    expect(lease.providerLeaseId).toBe("pc-job");
    expect(lease.metadata).toEqual(expect.objectContaining({ remoteCwd: "/workspace/repo" }));
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "job",
        // The job backend has no exec channel; its native sync hook rejects, so
        // the lease must fall back to the byte-identical base64 transport.
        nativeFileSyncUnsupported: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

describe("onEnvironmentReleaseLease", () => {
  function release(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const deleteCr = vi.fn().mockResolvedValue({});
    const patchCr = vi.fn().mockResolvedValue({});
    h.clients = { custom: { deleteNamespacedCustomObject: deleteCr, patchNamespacedCustomObject: patchCr } };
    const done = plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config,
      providerLeaseId: "pc-abc", leaseMetadata: leaseMetadata(), ...extra,
    });
    return { done, deleteCr, patchCr };
  }

  it("deletes the Sandbox CR by default", async () => {
    const { done, deleteCr, patchCr } = release(CONFIG);
    await done;
    expect(deleteCr).toHaveBeenCalledWith(expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }));
    expect(patchCr).not.toHaveBeenCalled();
  });

  it("keeps a reusable sandbox alive and lets the controller delete it after the idle period", async () => {
    const before = Date.now();
    const { done, deleteCr, patchCr } = release({ ...CONFIG, reuseLease: true, idleShutdownSec: 120 });
    await done;
    expect(deleteCr).not.toHaveBeenCalled();
    const shutdownAt = Date.parse((patchCr.mock.calls[0][0].body as { spec: { shutdownTime: string } }).spec.shutdownTime);
    expect(shutdownAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(shutdownAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("deletes a reusable sandbox when the operator cancels active work", async () => {
    const { done, deleteCr, patchCr } = release({ ...CONFIG, reuseLease: true }, { cancelActiveWork: true });
    await done;
    expect(deleteCr).toHaveBeenCalled();
    expect(patchCr).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("deletes the Sandbox CR, pod, and per-run Secret", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: deletePod, deleteNamespacedSecret: deleteSecret },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(deleteCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: { deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: null,
      leaseMetadata: undefined,
    });

    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const deleteJob = vi.fn().mockResolvedValue({});
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
      batch: { deleteNamespacedJob: deleteJob },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    });

    expect(deleteJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(deleteCr).not.toHaveBeenCalled();
  });
});
