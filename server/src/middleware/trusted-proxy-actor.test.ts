import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { actorMiddleware, resolveTrustedProxyUser } from "./auth.js";

function createFakeDb(options: {
  users?: Array<{ id: string; name: string; email: string }>;
  isInstanceAdmin?: boolean;
  memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
} = {}) {
  const users = [...(options.users ?? [])];
  const inserted: Array<Record<string, unknown>> = [];
  const rowsFor = (table: unknown) => {
    if (table === authUsers) return users;
    if (table === instanceUserRoles) return options.isInstanceAdmin ? [{ id: "role-1" }] : [];
    if (table === companyMemberships) return options.memberships ?? [];
    return [];
  };

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (rows: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === authUsers) inserted.push(row);
        const chain = {
          onConflictDoNothing: () => chain,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
        return chain;
      },
    }),
  } as unknown as Db;

  return { db, inserted };
}

function fakeReq(remoteAddress: string, headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { socket: { remoteAddress }, header: (name: string) => lower[name.toLowerCase()] };
}

function appWith(db: Db) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/api/whoami", (req, res) => res.json(req.actor));
  return app;
}

describe("trusted proxy authentication", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_AUTH_TRUSTED_PROXY_HEADER = "x-forwarded-email";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_AUTH_TRUSTED_PROXY_HEADER;
  });

  it("resolves a loopback request to the existing user with that email", async () => {
    const { db, inserted } = createFakeDb({ users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }] });

    const user = await resolveTrustedProxyUser(db, fakeReq("127.0.0.1", { "X-Forwarded-Email": "Owner@Example.com" }));

    expect(user).toEqual({ id: "user-1", name: "Owner", email: "owner@example.com" });
    expect(inserted).toEqual([]);
  });

  it("accepts IPv6 and IPv4-mapped loopback peers", async () => {
    const { db } = createFakeDb({ users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }] });

    for (const address of ["::1", "::ffff:127.0.0.1"]) {
      expect((await resolveTrustedProxyUser(db, fakeReq(address, { "x-forwarded-email": "owner@example.com" })))?.id).toBe("user-1");
    }
  });

  it("ignores the header when the peer is not loopback", async () => {
    const { db } = createFakeDb({ users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }] });

    expect(await resolveTrustedProxyUser(db, fakeReq("10.0.0.7", { "x-forwarded-email": "owner@example.com" }))).toBeNull();
  });

  it("ignores the header when the feature is not configured", async () => {
    delete process.env.PAPERCLIP_AUTH_TRUSTED_PROXY_HEADER;
    const { db } = createFakeDb({ users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }] });

    expect(await resolveTrustedProxyUser(db, fakeReq("127.0.0.1", { "x-forwarded-email": "owner@example.com" }))).toBeNull();
  });

  it("creates an unknown user with a stable id derived from the email", async () => {
    const first = createFakeDb();
    const second = createFakeDb();

    const a = await resolveTrustedProxyUser(first.db, fakeReq("127.0.0.1", { "x-forwarded-email": "New@Example.com" }));
    const b = await resolveTrustedProxyUser(second.db, fakeReq("127.0.0.1", { "x-forwarded-email": "new@example.com" }));

    expect(a).toEqual(b);
    expect(first.inserted).toEqual([
      expect.objectContaining({ id: a?.id, email: "new@example.com", name: "new@example.com", emailVerified: true }),
    ]);
  });

  it("authenticates the request as a board session actor with the user's memberships", async () => {
    const { db } = createFakeDb({
      users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });

    const res = await request(appWith(db)).get("/api/whoami").set("x-forwarded-email", "owner@example.com");

    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "Owner",
      userEmail: "owner@example.com",
      source: "session",
      sessionId: "trusted-proxy:user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
  });

  it("does not grant instance admin or memberships to a newly created user", async () => {
    const { db } = createFakeDb();

    const res = await request(appWith(db)).get("/api/whoami").set("x-forwarded-email", "new@example.com");

    expect(res.body).toMatchObject({ type: "board", companyIds: [], isInstanceAdmin: false });
  });

  it("leaves requests without the header unauthenticated", async () => {
    const { db } = createFakeDb({ users: [{ id: "user-1", name: "Owner", email: "owner@example.com" }] });

    const res = await request(appWith(db)).get("/api/whoami");

    expect(res.body).toMatchObject({ type: "none" });
  });
});
