import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requireUser } from "../../auth/current-user";
import { notifications } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError, notFound } from "../../http/errors";
import type { RouteContext } from "../context";

// Owner: Agent 2 (notifications). NTF-1 GET /notifications, NTF-2 GET /notifications/unread-count,
// NTF-3 POST /notifications/:id/read, NTF-4 POST /notifications/read-all (docs/live-screens-contracts.md,
// "Notifications"). Every query is scoped to the signed-in user.

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});
const isUuid = (value: string) => z.uuid().safeParse(value).success;
const badRequest = () => new HttpError(400, "bad_request", GENERIC_MESSAGE);

const shape = {
  id: notifications.id,
  kind: notifications.kind,
  title: notifications.title,
  details: notifications.details,
  href: notifications.href,
  createdAt: notifications.createdAt,
  readAt: notifications.readAt,
};
const toNotification = <T extends { readAt: Date | null; createdAt: Date }>({ readAt, createdAt, ...row }: T) => ({
  ...row,
  createdAt: createdAt.toISOString(),
  read: readAt !== null,
});

export function notificationsRoutes({ db }: RouteContext) {
  const router = Router();
  const mine = (userId: string) => eq(notifications.userId, userId);
  const unread = async (userId: string) =>
    (await db.select({ unread: count() }).from(notifications).where(and(mine(userId), isNull(notifications.readAt))))[0]!.unread;

  // NTF-1. Newest first; the cursor is the last item's id, so the next page starts strictly after that row.
  router.get("/notifications", requireUser, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) throw badRequest();
    const { limit, cursor } = query.data;
    const me = req.user!.id;
    let after;
    if (cursor) {
      // created_at as text keeps the microseconds a JS Date would drop.
      const at = (await db.select({ at: sql<string>`${notifications.createdAt}::text` }).from(notifications).where(and(mine(me), eq(notifications.id, cursor))))[0];
      if (!at) throw badRequest();
      after = sql`(${notifications.createdAt}, ${notifications.id}) < (${at.at}::timestamptz, ${cursor}::uuid)`;
    }
    const rows = await db
      .select(shape)
      .from(notifications)
      .where(and(mine(me), after))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toNotification);
    res.json({ items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null, unread: await unread(me) });
  });

  // NTF-2. Served by the partial index on unread rows.
  router.get("/notifications/unread-count", requireUser, async (req, res) => {
    res.json({ unread: await unread(req.user!.id) });
  });

  // NTF-4.
  router.post("/notifications/read-all", requireUser, async (req, res) => {
    const result = await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(mine(req.user!.id), isNull(notifications.readAt)));
    res.json({ updated: result.rowCount ?? 0 });
  });

  // NTF-3. Idempotent: the first read time is kept. Someone else's id is 404, never 403.
  router.post("/notifications/:id/read", requireUser, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("Notification");
    const row = (
      await db
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(mine(req.user!.id), eq(notifications.id, id)))
        .returning(shape)
    )[0];
    if (!row) throw notFound("Notification");
    res.json({ notification: toNotification(row) });
  });

  return router;
}
