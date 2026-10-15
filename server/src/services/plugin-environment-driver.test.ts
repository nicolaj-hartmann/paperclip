import { describe, expect, it } from "vitest";
import { resolvePluginExecuteRpcTimeoutMs } from "./plugin-environment-driver.js";

describe("resolvePluginExecuteRpcTimeoutMs", () => {
  it("adds the driver's pod readiness budget so a short probe survives a cold image pull", () => {
    expect(resolvePluginExecuteRpcTimeoutMs({ requestedTimeoutMs: 15_000, config: { podReadyTimeoutSec: 300 } })).toBe(345_000);
    expect(resolvePluginExecuteRpcTimeoutMs({ requestedTimeoutMs: 15_000, config: {} })).toBe(45_000);
    expect(resolvePluginExecuteRpcTimeoutMs({ config: { timeoutMs: 10_000, podReadyTimeoutSec: 60 } })).toBe(100_000);
    expect(resolvePluginExecuteRpcTimeoutMs({ config: { podReadyTimeoutSec: 300 } })).toBeUndefined();
  });
});
