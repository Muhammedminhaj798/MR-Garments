import { asc, desc, eq, sql } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { locations, notifications, shippingAgents, users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs } from "../../test/harness";
import { idOf, indiaDay, makeOrder, receive } from "../stock/fixtures";
import { MESSAGES } from "../stock/stock.routes";
import { cny, day, notify, qty } from "./notify";

const ctx = createTestContext();
const http = api(ctx);
afterAll(() => ctx.pool.end());

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const userId = async (email: string) => (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;

let cookies: Record<keyof typeof SEEDED, string>;
beforeEach(async () => {
  await resetData(ctx);
  cookies = Object.fromEntries(
    await Promise.all(Object.entries(SEEDED).map(async ([key, email]) => [key, await signInAs(ctx, email)])),
  ) as typeof cookies;
});

/** Test fixtures only: rows written straight to the table, oldest first. */
async function seedInbox(email: string, count: number, read = false) {
  const id = await userId(email);
  const rows = Array.from({ length: count }, (_, i) => ({
    userId: id,
    kind: "payment-recorded" as const,
    title: `Fixture ${i}`,
    details: ["a", "b"],
    href: null,
    dedupeKey: `fixture:${email}:${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
    readAt: read ? new Date() : null,
  }));
  return ctx.db.insert(notifications).values(rows).returning({ id: notifications.id });
}

const list = (cookie: string, query = "") => http.get(`/notifications${query}`).set("Cookie", cookie);
const unreadRows = async (email: string) =>
  (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(sql`${notifications.userId} = ${await userId(email)} and read_at is null`))[0]!.n;

describe("signed out", () => {
  it("is 401 on every route", async () => {
    for (const res of [
      await http.get("/notifications"),
      await http.get("/notifications/unread-count"),
      await http.post(`/notifications/${UNKNOWN}/read`),
      await http.post("/notifications/read-all"),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthenticated");
    }
  });
});

describe("NTF-1 GET /notifications", () => {
  it("lists the caller's own, newest first, with the full unread count", async () => {
    await seedInbox(SEEDED.management, 3);
    await seedInbox(SEEDED.accounts, 2);
    const res = await list(cookies.management);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { title: string }) => item.title)).toEqual(["Fixture 2", "Fixture 1", "Fixture 0"]);
    expect(res.body.items[0]).toEqual({
      id: expect.any(String),
      kind: "payment-recorded",
      title: "Fixture 2",
      details: ["a", "b"],
      href: null,
      createdAt: "2026-10-01T00:02:00.000Z",
      read: false,
    });
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.unread).toBe(3);
    expect((await list(cookies.procurement)).body).toEqual({ items: [], nextCursor: null, unread: 0 });
  });

  it("pages with the cursor, including rows created in the same instant", async () => {
    await seedInbox(SEEDED.management, 4);
    const id = await userId(SEEDED.management);
    // One statement: every row gets the same now(), so only the id orders them.
    await ctx.db.insert(notifications).values(
      Array.from({ length: 7 }, (_, i) => ({ userId: id, kind: "short-receipt" as const, title: `Same ${i}`, details: [], dedupeKey: `same:${i}` })),
    );
    const expected = (
      await ctx.db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, id)).orderBy(desc(notifications.createdAt), desc(notifications.id))
    ).map((row) => row.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(cookies.management, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.unread).toBe(11);
      seen.push(...res.body.items.map((item: { id: string }) => item.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toEqual(expected);
  });

  it("defaults to 20 and caps at 50", async () => {
    await seedInbox(SEEDED.management, 51);
    const first = await list(cookies.management);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.nextCursor).toBe(first.body.items[19].id);
    const max = await list(cookies.management, "?limit=50");
    expect(max.body.items).toHaveLength(50);
    expect(max.body.nextCursor).not.toBeNull();
  });

  it("is 400 for a bad limit or cursor", async () => {
    const [others] = await seedInbox(SEEDED.accounts, 1);
    for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?limit=2.5", "?limit=1&limit=2", "?cursor=nope", `?cursor=${UNKNOWN}`, `?cursor=${others!.id}`, "?page=2"]) {
      const res = await list(cookies.management, query);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
  });
});

describe("NTF-2 GET /notifications/unread-count", () => {
  it("equals the caller's real unread rows", async () => {
    await seedInbox(SEEDED.management, 4);
    await ctx.db.insert(notifications).values({ userId: await userId(SEEDED.management), kind: "container-loaded", title: "Read one", details: [], dedupeKey: "read", readAt: new Date() });
    await seedInbox(SEEDED.accounts, 2);
    const res = await http.get("/notifications/unread-count").set("Cookie", cookies.management);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 4 });
    expect(await unreadRows(SEEDED.management)).toBe(4);
  });
});

describe("NTF-3 POST /notifications/:id/read", () => {
  it("marks one read, persists, and is idempotent", async () => {
    const [first, second] = await seedInbox(SEEDED.management, 2);
    const res = await http.post(`/notifications/${first!.id}/read`).set("Cookie", cookies.management);
    expect(res.status).toBe(200);
    expect(res.body.notification).toMatchObject({ id: first!.id, title: "Fixture 0", read: true });
    const readAt = (await ctx.db.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, first!.id)))[0]!.readAt;
    expect(readAt).not.toBeNull();

    const again = await http.post(`/notifications/${first!.id}/read`).set("Cookie", cookies.management);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect((await ctx.db.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, first!.id)))[0]!.readAt).toEqual(readAt);

    const listed = (await list(cookies.management)).body;
    expect(listed.unread).toBe(1);
    expect(listed.items.find((item: { id: string }) => item.id === second!.id).read).toBe(false);
  });

  it("is 404 for another user's, an unknown or a malformed id, and changes nothing", async () => {
    const [others] = await seedInbox(SEEDED.accounts, 1);
    for (const id of [others!.id, UNKNOWN, "not-a-uuid"]) {
      const res = await http.post(`/notifications/${id}/read`).set("Cookie", cookies.management);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    expect(await unreadRows(SEEDED.accounts)).toBe(1);
  });

  it("needs the same-site headers like every POST", async () => {
    const [mine] = await seedInbox(SEEDED.management, 1);
    const cross = await supertest(ctx.app).post(`/api/v1/notifications/${mine!.id}/read`).set("Cookie", cookies.management).set("Origin", "https://evil.example").send({});
    expect(cross.status).toBe(403);
    expect(await unreadRows(SEEDED.management)).toBe(1);
  });
});

describe("NTF-4 POST /notifications/read-all", () => {
  it("marks every unread one of the caller read and reports how many", async () => {
    await seedInbox(SEEDED.management, 3);
    await ctx.db.insert(notifications).values({ userId: await userId(SEEDED.management), kind: "container-loaded", title: "Old", details: [], dedupeKey: "old", readAt: new Date() });
    await seedInbox(SEEDED.accounts, 2);
    const res = await http.post("/notifications/read-all").set("Cookie", cookies.management);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    expect(await unreadRows(SEEDED.management)).toBe(0);
    expect(await unreadRows(SEEDED.accounts)).toBe(2);
    expect((await http.post("/notifications/read-all").set("Cookie", cookies.management)).body).toEqual({ updated: 0 });
  });
});

// Events: who receives what. Matrix (src/permissions/matrix.ts) with the seeded grants: receiving View+ is Management,
// Procurement and China staff granted stage 2 (Wang, Chen, Li); payments View+ is Management, Procurement, Accounts;
// containers View+ is Management and China staff granted stage 3 (Wang, Li).
const inbox = (kind: string) =>
  ctx.db
    .select({ email: users.email, title: notifications.title, details: notifications.details, href: notifications.href, dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.kind, kind))
    .orderBy(asc(users.email));
const LI = "li@mrgarments.com";

describe("short-receipt (REC-3)", () => {
  const receipt = async (cookie: string, quantities: number[], extra: object = {}) => {
    const order = await makeOrder(ctx, {
      lines: [
        { item: "Denim jeans", quantity: 100, rateCny: 12.5 },
        { item: "Cotton fabric", quantity: 500, rateCny: 3 },
      ],
    });
    const res = await http
      .post("/receipts", {
        orderId: order.id,
        receivedOn: indiaDay(-1),
        locationId: await idOf(ctx, locations, "Guangzhou office"),
        bundles: 2,
        deliveryNote: "",
        shortRemark: "Rest next week.",
        lines: quantities.map((quantity, i) => ({ orderLineId: order.lineIds[i]!, quantity })),
        ...extra,
      })
      .set("Cookie", cookie);
    return { res, order };
  };

  it("reaches receiving viewers except the actor, with a page each can open", async () => {
    const { res, order } = await receipt(cookies.chinaStaff, [60, 500]);
    expect(res.status).toBe(201);
    const rows = await inbox("short-receipt");
    expect(rows.map((row) => row.email)).toEqual([LI, SEEDED.procurement, SEEDED.management, SEEDED.chinaStaffTwoStages]);
    for (const row of rows) {
      expect(row.title).toBe(`${order.po} received short`);
      expect(row.details).toEqual(["Guangzhou Textile Co.", "Denim jeans short by 40 pcs"]);
      expect(row.dedupeKey).toBe(`short-receipt:${res.body.receipt.id}`);
      const office = row.email === SEEDED.management || row.email === SEEDED.procurement;
      expect(row.href, row.email).toBe(office ? `/orders/${order.po}/receiving` : "/receiving");
    }
  });

  it("summarises several short lines", async () => {
    await receipt(cookies.management, [10, 0]);
    const rows = await inbox("short-receipt");
    expect(rows.map((row) => row.email)).not.toContain(SEEDED.management);
    expect(rows[0]!.details).toEqual(["Guangzhou Textile Co.", "2 lines short"]);
  });

  it("is not sent when nothing is left short", async () => {
    expect((await receipt(cookies.chinaStaff, [100, 500])).res.status).toBe(201);
    expect(await inbox("short-receipt")).toEqual([]);
  });

  it("is not written when the receipt fails (422 over-receipt or missing remark)", async () => {
    const over = await receipt(cookies.chinaStaff, [101, 0]);
    expect(over.res.status).toBe(422);
    expect(over.res.body.error.fields.lines).toBe(MESSAGES.overReceipt("Denim jeans", 100, "pcs"));
    const noRemark = await receipt(cookies.chinaStaff, [10, 0], { shortRemark: "" });
    expect(noRemark.res.status).toBe(422);
    expect(await ctx.db.select().from(notifications)).toEqual([]);
  });

  it("skips inactive users", async () => {
    await ctx.db.update(users).set({ status: "Inactive" }).where(eq(users.email, LI));
    await receipt(cookies.chinaStaff, [60, 500]);
    expect((await inbox("short-receipt")).map((row) => row.email)).not.toContain(LI);
  });
});

describe("payment-recorded (PAY-2)", () => {
  const pay = async (cookie: string) => {
    const order = await makeOrder(ctx, { lines: [{ item: "Denim jeans", quantity: 1000, rateCny: 10 }] });
    const res = await http
      .post("/payments", { orderId: order.id, kind: "Balance", payeeRole: "supplier", agentId: null, amountCny: 234567.5, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank" })
      .set("Cookie", cookie);
    expect(res.status).toBe(201);
    return { id: res.body.payment.id as string, po: order.po };
  };

  it("by Management reaches Procurement and Accounts, not China staff", async () => {
    const { id, po } = await pay(cookies.management);
    const rows = await inbox("payment-recorded");
    expect(rows.map((row) => row.email)).toEqual([SEEDED.accounts, SEEDED.procurement]);
    for (const row of rows) {
      expect(row).toMatchObject({
        title: `${po} payment recorded`,
        details: ["Balance ¥2,34,567.50", "Guangzhou Textile Co."],
        href: `/orders/${po}/payments`,
        dedupeKey: `payment-recorded:${id}`,
      });
    }
  });

  it("by Accounts reaches Management and Procurement", async () => {
    await pay(cookies.accounts);
    expect((await inbox("payment-recorded")).map((row) => row.email)).toEqual([SEEDED.procurement, SEEDED.management]);
  });

  it("is not written when the payment is refused", async () => {
    const res = await http.post("/payments", { orderId: UNKNOWN, kind: "Balance", payeeRole: "supplier", agentId: null, amountCny: 5, paidOn: indiaDay(-1), rateInr: 12, mode: "Bank" }).set("Cookie", cookies.accounts);
    expect(res.status).toBe(422);
    expect(await ctx.db.select().from(notifications)).toEqual([]);
  });
});

describe("container-loaded, -sailed, -arrived (CON-3, CON-5)", () => {
  const load = async (cookie: string) => {
    const order = await makeOrder(ctx, { stage: 2, lines: [{ item: "Track pants", quantity: 60, rateCny: 5 }] });
    await receive(ctx, order.id, [{ orderLineId: order.lineIds[0]!, quantity: 60 }]);
    const eta = indiaDay(20);
    const res = await http
      .post("/containers", {
        number: "MSCU7000001",
        shippingAgentId: await idOf(ctx, shippingAgents, "Sino Freight"),
        terms: "FOB",
        portOfLoading: "Nansha",
        portOfArrival: "Kochi",
        loadedOn: indiaDay(-2),
        sailedOn: null,
        eta,
        lines: [{ orderLineId: order.lineIds[0]!, bundles: 2, quantity: 60 }],
      })
      .set("Cookie", cookie);
    expect(res.status).toBe(201);
    return { id: res.body.container.id as string, po: order.po, eta };
  };
  const patch = (id: string, body: object, cookie = cookies.chinaStaffTwoStages) => http.patch(`/containers/${id}`, body).set("Cookie", cookie);

  it("loading by Wang reaches Management and Li only", async () => {
    const { id, po, eta } = await load(cookies.chinaStaffTwoStages);
    const rows = await inbox("container-loaded");
    expect(rows.map((row) => row.email)).toEqual([LI, SEEDED.management]);
    for (const row of rows) {
      expect(row).toMatchObject({
        title: "Container MSCU7000001 loaded",
        details: ["Sino Freight", po, `ETA ${day(eta)}`],
        href: `/containers/${id}`,
        dedupeKey: `container-loaded:${id}`,
      });
    }
  });

  it("sailing and arriving notify; a date-only change does not", async () => {
    const { id, po } = await load(cookies.management);
    expect((await patch(id, { eta: indiaDay(25) })).status).toBe(200);
    expect(await inbox("container-sailed")).toEqual([]);

    expect((await patch(id, { status: "sea", sailedOn: indiaDay(-1) })).status).toBe(200);
    const sailed = await inbox("container-sailed");
    expect(sailed.map((row) => row.email)).toEqual([LI, SEEDED.management]);
    expect(sailed[0]).toMatchObject({ title: "Container MSCU7000001 sailed", details: [po, `ETA ${day(indiaDay(25))}`], href: `/containers/${id}` });

    expect((await patch(id, { status: "arrived" }, cookies.management)).status).toBe(200);
    const arrived = await inbox("container-arrived");
    expect(arrived.map((row) => row.email)).toEqual([LI, SEEDED.chinaStaffTwoStages]);
    expect(arrived[0]).toMatchObject({ title: "Container MSCU7000001 arrived", details: [po, "Kochi"], dedupeKey: `container-arrived:${id}` });
  });

  it("a refused change writes nothing", async () => {
    const { id } = await load(cookies.management);
    await ctx.db.delete(notifications);
    expect((await patch(id, { status: "arrived" })).status).toBe(409);
    expect((await patch(id, { status: "sea", sailedOn: indiaDay(3) })).status).toBe(422);
    expect(await ctx.db.select().from(notifications)).toEqual([]);
  });
});

describe("notify()", () => {
  const event = async () => ({
    kind: "container-loaded" as const,
    capability: "containers" as const,
    actorId: await userId(SEEDED.management),
    sourceId: UNKNOWN,
    title: "T",
    details: [],
    href: () => null,
  });

  it("adds nothing when the same event is replayed", async () => {
    await ctx.db.transaction(async (tx) => notify(tx, await event()));
    await ctx.db.transaction(async (tx) => notify(tx, await event()));
    expect((await inbox("container-loaded")).map((row) => row.email)).toEqual([LI, SEEDED.chinaStaffTwoStages]);
  });

  it("is rolled back with the business write", async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        await notify(tx, await event());
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");
    expect(await ctx.db.select().from(notifications)).toEqual([]);
  });

  it("formats like the frontend", () => {
    expect([cny(141000), cny(2345.6), cny(0.5), qty(1800, "pcs"), day("2026-09-30"), day("2026-01-05")]).toEqual([
      "¥1,41,000",
      "¥2,345.60",
      "¥0.50",
      "1,800 pcs",
      "30 Sep 2026",
      "5 Jan 2026",
    ]);
  });
});
