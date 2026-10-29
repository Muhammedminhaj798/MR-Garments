import { and, eq, ne } from "drizzle-orm";

import type { Database } from "../../db/client";
import { NOTIFICATION_KINDS, type NotificationKind, notifications, type Role, users, userStageGrants } from "../../db/schema";
import { atLeast, type Capability, effectiveAccess } from "../../permissions/matrix";

// Owner: Agent 2 (notifications). Business routes call notify() inside their own transaction, so a rolled-back write
// leaves no notification (D:\SDEC\MR Garments\docs\notifications-contract.md, "Rules the backend guarantees").

/**
 * What each kind is about. Recipients are the active users with at least View on it (matrix plus stage grants),
 * except the actor; and a reader sees a kind only while they still have that access, so a payment amount stops
 * showing to someone moved out of payments.
 */
export const KIND_CAPABILITY: Record<NotificationKind, Capability> = {
  "short-receipt": "receiving",
  "payment-recorded": "payments",
  "container-loaded": "containers",
  "container-sailed": "containers",
  "container-arrived": "containers",
};

/** The kinds this role and these stage grants may read now. */
export const readableKinds = (role: Role, stages: number[]) =>
  NOTIFICATION_KINDS.filter((kind) => atLeast(effectiveAccess(role, stages, KIND_CAPABILITY[kind]), "View"));

export type NotificationEvent = {
  kind: NotificationKind;
  actorId: string;
  /** The source record's id; the dedupe key is `<kind>:<sourceId>`. */
  sourceId: string;
  title: string;
  details: string[];
  /** The page this recipient can open, from what they can view, or null. */
  href: (canView: (capability: Capability) => boolean) => string | null;
};

/** One notification per recipient, written with the caller's transaction; a repeated event adds nothing. */
export async function notify(tx: Pick<Database, "select" | "insert">, event: NotificationEvent) {
  // ponytail: every active user with their grants in memory; fine for an office-sized user list.
  const rows = await tx
    .select({ id: users.id, role: users.role, stage: userStageGrants.stage })
    .from(users)
    .leftJoin(userStageGrants, eq(userStageGrants.userId, users.id))
    .where(and(eq(users.status, "Active"), ne(users.id, event.actorId)));
  const people = new Map<string, { role: Role; stages: number[] }>();
  for (const row of rows) {
    const person = people.get(row.id) ?? { role: row.role as Role, stages: [] };
    if (row.stage !== null) person.stages.push(row.stage);
    people.set(row.id, person);
  }
  const values = [...people].flatMap(([userId, { role, stages }]) => {
    const canView = (capability: Capability) => atLeast(effectiveAccess(role, stages, capability), "View");
    if (!canView(KIND_CAPABILITY[event.kind])) return [];
    const { kind, title, details } = event;
    return [{ userId, kind, title, details, href: event.href(canView), dedupeKey: `${kind}:${event.sourceId}` }];
  });
  if (values.length > 0) await tx.insert(notifications).values(values).onConflictDoNothing();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ¥1,41,000 or ¥2,345.60: Indian digit grouping, as the frontend shows money. */
export const cny = (amount: number) =>
  `¥${amount.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
/** 1,800 pcs */
export const qty = (value: number, unit: string) => `${value.toLocaleString("en-IN")} ${unit}`;
/** 30 Sep 2026, from YYYY-MM-DD (the frontend's formatDate). */
export const day = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
