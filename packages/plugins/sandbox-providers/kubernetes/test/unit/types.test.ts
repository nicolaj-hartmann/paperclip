import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects reuseLease on the job backend", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: true, backend: "job", reuseLease: true })).toThrow(/sandbox-cr/);
    expect(parseKubernetesProviderConfig({ inCluster: true, reuseLease: true }).idleShutdownSec).toBe(600);
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });

  it("accepts compose-style services and defaults their env and volumes", () => {
    const parsed = kubernetesProviderConfigSchema.parse({
      inCluster: true,
      services: [{ name: "postgres", image: "postgres:18", readyCommand: ["pg_isready"] }],
    });
    expect(parsed.services).toEqual([
      { name: "postgres", image: "postgres:18", env: {}, volumes: [], readyCommand: ["pg_isready"] },
    ]);
  });

  it("defaults services to an empty list and rejects a service name that is not a DNS label", () => {
    expect(kubernetesProviderConfigSchema.parse({ inCluster: true }).services).toEqual([]);
    expect(() =>
      kubernetesProviderConfigSchema.parse({ inCluster: true, services: [{ name: "Post_gres", image: "postgres:18" }] }),
    ).toThrow();
  });
});
