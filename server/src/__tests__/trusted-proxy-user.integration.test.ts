import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authUsers, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolveTrustedProxyUser } from "../middleware/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

function loopbackReq(email: string) {
  return { socket: { remoteAddress: "127.0.0.1" }, header: () => email };
}

(support.supported ? describe : describe.skip)("resolveTrustedProxyUser against Postgres", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-trusted-proxy-");
    db = createDb(database.connectionString);
  }, 90000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });
  beforeEach(() => {
    process.env.PAPERCLIP_AUTH_TRUSTED_PROXY_HEADER = "x-forwarded-email";
  });
  afterEach(async () => {
    delete process.env.PAPERCLIP_AUTH_TRUSTED_PROXY_HEADER;
    await db.delete(authUsers);
  });

  it("matches an existing user whose stored email differs only in case", async () => {
    const now = new Date();
    await db.insert(authUsers).values({ id: "admin-1", name: "Admin", email: "Admin@Example.com", createdAt: now, updatedAt: now });

    const user = await resolveTrustedProxyUser(db, loopbackReq("admin@example.com"));

    expect(user?.id).toBe("admin-1");
    expect(await db.select().from(authUsers)).toHaveLength(1);
  });

  it("creates one user for concurrent first requests", async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, () => resolveTrustedProxyUser(db, loopbackReq("new@example.com"))),
    );

    expect(new Set(users.map((user) => user?.id)).size).toBe(1);
    expect(await db.select().from(authUsers).where(eq(authUsers.email, "new@example.com"))).toHaveLength(1);
  });
});
