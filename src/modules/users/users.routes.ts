import { and, asc, count, eq, ne, or } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Router } from "express";
import { z } from "zod";

import { requirePermission } from "../../auth/current-user";
import { hashPassword, passwordProblems } from "../../auth/passwords";
import { signOutEverywhere } from "../../auth/session";
import type { Database } from "../../db/client";
import {
  clearings,
  containers,
  locations,
  orders,
  payments,
  receipts,
  ROLES,
  type Role,
  STATUSES,
  suppliers,
  transports,
  users,
  userStageGrants,
  warehouseReceipts,
} from "../../db/schema";
import { conflict, GENERIC_MESSAGE, HttpError, notFound, validationFailed } from "../../http/errors";
import { parse } from "../../http/validate";
import { grantableStages, isStaffRole, STAGE_LABEL } from "../../permissions/matrix";
import type { RouteContext } from "../context";

// Owner: A2 (users). USR-1 GET /users, USR-2 GET /users/:id, USR-3 POST /users, USR-4 PATCH /users/:id,
// USR-5 DELETE /users/:id.
// All Management only, guarded per route: this router sits at /api/v1, so router.use() would guard every module.
// Password policy (2026-10-29, supersedes B1 (b), B1.4-B1.9, B1.11, B1.12 and C5 R1): Management types the initial
// password on Add user and may set a new one for another user on Edit user. No links or emails are sent.

/** Approved wording M8, M9 and M13-M20 (docs/batch1-decisions.md, U36.2); `password` and `ownPassword` are proposed. */
export const MESSAGES = {
  password: "Enter a password.", // proposed
  passwordRules: "Use at least 8 characters, a number and a capital letter.", // M8
  passwordTooLong: "Use 128 characters or fewer.", // M9
  ownPassword: "Ask another Management user to set your password.", // proposed
  name: "Enter the full name.", // M13
  email: "Enter a valid email address.", // M14
  emailTaken: "A user with this email already exists.", // M15
  role: "Choose a role.", // M16
  office: "Choose an office from the list.", // M17
  stageOutsideRole: (role: Role, stage: string) => `${role} can't enter data for ${stage}. Untick it first.`, // M18
  stagesNotUsed: (role: Role) => `${role} doesn't use stage access. Untick all stages first.`, // M19
  lastManagement: "At least one active Management user is required.", // M20
  ownDeactivate: "You can't deactivate your own account.", // proposed (D3)
  ownRemove: "You can't remove your own account.", // proposed (D3)
  inUse: (name: string, what: string) => `${name} has ${what}, so they can't be removed. Deactivate them instead.`, // proposed (D3)
};

/**
 * USR-5: every column that holds a user's id as the author or receiver of a record, with the record's name (singular;
 * the plural adds "s"). None has a foreign key, so this list alone keeps a removed user from leaving dangling ids: add
 * any new `*_by` uuid column here (a test compares it with the database). transports.loaded_by/received_by and
 * warehouse_receipts.received_by are typed names, not ids.
 */
export const REFERENCES: { what: string; table: PgTable; columns: PgColumn[] }[] = [
  { what: "user", table: users, columns: [users.createdBy, users.updatedBy] },
  { what: "supplier", table: suppliers, columns: [suppliers.createdBy] },
  { what: "order", table: orders, columns: [orders.createdBy] },
  { what: "payment", table: payments, columns: [payments.createdBy] },
  { what: "receipt", table: receipts, columns: [receipts.receivedBy] },
  { what: "container", table: containers, columns: [containers.createdBy] },
  { what: "clearing", table: clearings, columns: [clearings.createdBy, clearings.updatedBy] },
  { what: "trip", table: transports, columns: [transports.createdBy, transports.updatedBy] },
  { what: "warehouse receipt", table: warehouseReceipts, columns: [warehouseReceipts.createdBy, warehouseReceipts.updatedBy] },
];

const joined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!);

/** The languages form 48 offers. */
export const LANGUAGES = ["English"] as const;

const badRequest = () => new HttpError(400, "bad_request", GENERIC_MESSAGE);
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The message for a password Management types, or undefined when it meets the rules (B9.10). Never trimmed. */
export function passwordMessage(password: string) {
  if (!password) return MESSAGES.password;
  const problems = passwordProblems(password);
  if (problems.includes("too_long")) return MESSAGES.passwordTooLong;
  return problems.length > 0 ? MESSAGES.passwordRules : undefined;
}

/** Field rules, also used by the profile (PRF-2). */
export const fields = {
  name: z.string({ error: MESSAGES.name }).trim().min(1, MESSAGES.name),
  email: z.string({ error: MESSAGES.email }).trim().toLowerCase().pipe(z.email({ error: MESSAGES.email })),
  phone: z.string().trim(),
  role: z.enum(ROLES, { error: MESSAGES.role }),
  officeId: z.uuid({ error: MESSAGES.office }).nullable(),
  language: z.enum(LANGUAGES),
  status: z.enum(STATUSES),
  stages: z.array(z.number().int().min(2).max(6)).transform((stages) => [...new Set(stages)].sort((a, b) => a - b)),
  password: z.string({ error: MESSAGES.password }).superRefine((value, ctx) => {
    const message = passwordMessage(value);
    if (message) ctx.addIssue({ code: "custom", message });
  }),
};

// Strict objects, so any unknown key is a 400. USR-3 needs the initial password; on USR-4 it is optional.
const createSchema = z.strictObject({
  ...fields,
  phone: fields.phone.default(""),
  officeId: fields.officeId.default(null),
  language: fields.language.default("English"),
  status: fields.status.default("Active"),
  stages: fields.stages.default([]),
});
const updateSchema = z.strictObject(fields).partial();

const listQuery = z.strictObject({ search: z.string().optional(), role: z.enum(ROLES).optional(), status: z.enum(STATUSES).optional() });

// Phone, language, status and stages have no approved message: the form only offers valid values, so a wrong type or
// value there is a bug in the caller (E11) and gets 400 rather than a field message.
const FIXED_FIELDS = ["phone", "language", "status", "stages"];
function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  try {
    return parse(schema, body);
  } catch (error) {
    if (error instanceof HttpError && FIXED_FIELDS.some((key) => key in (error.fields ?? {}))) throw badRequest();
    throw error;
  }
}

/** M18/M19 (Q7, B8.1): a staff role may only hold its own stages; other roles hold none. */
export function stageProblem(role: Role, stages: readonly number[]) {
  if (stages.length === 0) return undefined;
  if (!isStaffRole(role)) return MESSAGES.stagesNotUsed(role);
  const allowed = grantableStages(role);
  const outside = [...stages].sort((a, b) => a - b).find((stage) => !allowed.includes(stage));
  return outside === undefined ? undefined : MESSAGES.stageOutsideRole(role, STAGE_LABEL[outside] ?? `stage ${outside}`);
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");

const listColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  office: locations.name,
  lastSignInAt: users.lastSignInAt,
  status: users.status,
};

async function findUser(db: Database, id: string) {
  if (!isUuid(id)) return undefined;
  const row = (
    await db
      .select({ ...listColumns, phone: users.phone, officeId: users.locationId, language: users.language })
      .from(users)
      .leftJoin(locations, eq(users.locationId, locations.id))
      .where(eq(users.id, id))
  )[0];
  if (!row) return undefined;
  const grants = await db.select({ stage: userStageGrants.stage }).from(userStageGrants).where(eq(userStageGrants.userId, id));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role as Role,
    officeId: row.officeId,
    office: row.office,
    language: row.language,
    status: row.status,
    stages: grants.map((grant) => grant.stage).sort((a, b) => a - b),
    lastSignInAt: row.lastSignInAt,
  };
}

async function isActiveOffice(db: Database, id: string) {
  const rows = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, id), eq(locations.status, "Active")));
  return rows.length > 0;
}

/** M17, M18 and M19 together, so every problem shows under its field at once (E1). */
async function checkRules(db: Database, { role, stages, officeId }: { role: Role; stages: readonly number[]; officeId: string | null }) {
  const problems: Record<string, string> = {};
  if (officeId && !(await isActiveOffice(db, officeId))) problems.officeId = MESSAGES.office;
  const stageMessage = stageProblem(role, stages);
  if (stageMessage) problems.stages = stageMessage;
  if (Object.keys(problems).length > 0) throw validationFailed(problems);
}

const emailTaken = () => conflict("email_exists", MESSAGES.emailTaken, { email: MESSAGES.emailTaken });

async function ensureEmailFree(db: Database, email: string, exceptId?: string) {
  const sameEmail = exceptId ? and(eq(users.email, email), ne(users.id, exceptId)) : eq(users.email, email);
  if ((await db.select({ id: users.id }).from(users).where(sameEmail)).length > 0) throw emailTaken();
}

/** A race past ensureEmailFree still hits the unique index: report it as the same 409 (M15). */
function duplicateEmailAsConflict(error: unknown): never {
  type PgError = { code?: string; constraint?: string; cause?: PgError };
  const pg = (error as PgError)?.cause ?? (error as PgError);
  if (pg?.code === "23505" && pg.constraint === "users_email_unique") throw emailTaken();
  throw error;
}

export function usersRoutes({ db, pool }: RouteContext) {
  const router = Router();
  const admin = requirePermission("admin", "Full");

  // USR-1. Search, role and status filter the rows; the counts always cover every user. Rows in creation order.
  router.get("/users", admin, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) throw badRequest();
    const { search, role, status } = query.data;
    // ponytail: filters run in memory over the whole table (a handful of staff); move them into SQL if users grow large.
    const rows = await db
      .select(listColumns)
      .from(users)
      .leftJoin(locations, eq(users.locationId, locations.id))
      .orderBy(asc(users.createdAt), asc(users.name));
    const needle = squash(search ?? "");
    const data = rows.filter(
      (row) =>
        (!needle || squash(row.name).includes(needle) || squash(row.email).includes(needle)) &&
        (!role || row.role === role) &&
        (!status || row.status === status),
    );
    const counts = {
      active: rows.filter((row) => row.status === "Active").length,
      inactive: rows.filter((row) => row.status === "Inactive").length,
    };
    res.json({ data, counts });
  });

  // USR-2. The user plus what the edit form offers.
  router.get("/users/:id", admin, async (req, res) => {
    const user = await findUser(db, String(req.params.id));
    if (!user) throw notFound("User");
    const offices = await db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(eq(locations.status, "Active"))
      .orderBy(asc(locations.createdAt), asc(locations.name));
    res.json({ user, options: { roles: ROLES, offices, languages: LANGUAGES } });
  });

  // USR-3. The user signs in with the password Management typed. Only its argon2id hash is stored; nothing is sent.
  router.post("/users", admin, async (req, res) => {
    const input = parseBody(createSchema, req.body);
    await checkRules(db, input);
    await ensureEmailFree(db, input.email);
    const { officeId, stages, password, ...values } = input;
    const passwordHash = await hashPassword(password);
    const id = await db
      .transaction(async (tx) => {
        const created = await tx
          .insert(users)
          .values({
            ...values,
            passwordHash,
            passwordChangedAt: new Date(),
            locationId: officeId,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          })
          .returning({ id: users.id });
        const userId = created[0]!.id;
        if (stages.length > 0) await tx.insert(userStageGrants).values(stages.map((stage) => ({ userId, stage })));
        return userId;
      })
      .catch(duplicateEmailAsConflict);
    res.status(201).json({ user: await findUser(db, id) });
  });

  // USR-4. Only the keys sent change. B8.1-B8.4 apply. A `password` sets a new one for another user and signs them out
  // everywhere; for one's own account it is a self-change, which nobody may make in the application (403).
  router.patch("/users/:id", admin, async (req, res) => {
    // Checked before the body, so an empty or weak password for oneself is the same 403, not a rules message.
    if (Object.hasOwn(req.body ?? {}, "password") && String(req.params.id).toLowerCase() === req.user!.id) {
      throw new HttpError(403, "password_change_disabled", MESSAGES.ownPassword);
    }
    const input = parseBody(updateSchema, req.body);
    // D3: nobody deactivates themselves (the caller is always active, so this is never a no-op save).
    if (input.status === "Inactive" && String(req.params.id).toLowerCase() === req.user!.id) {
      throw conflict("own_account", MESSAGES.ownDeactivate, { status: MESSAGES.ownDeactivate });
    }
    const current = await findUser(db, String(req.params.id));
    if (!current) throw notFound("User");
    const role = input.role ?? current.role;
    const status = input.status ?? current.status;
    // An unchanged office is not re-checked, so a user whose office was closed later can still be saved.
    const officeChanged = input.officeId !== undefined && input.officeId !== current.officeId;
    await checkRules(db, { role, stages: input.stages ?? current.stages, officeId: officeChanged ? (input.officeId ?? null) : null });
    if (input.email && input.email !== current.email.toLowerCase()) await ensureEmailFree(db, input.email, current.id);

    // B8.2/B8.3: leaving Management or going inactive (also to oneself) must leave another active Management user.
    // The Management rows are locked first, so of two simultaneous demotions the second sees the first (AT-R6).
    const leavesManagement = current.role === "Management" && current.status === "Active" && (role !== "Management" || status !== "Active");
    const { officeId, stages, password, ...values } = input;
    const newPassword = password === undefined ? {} : { passwordHash: await hashPassword(password), passwordChangedAt: new Date() };
    await db
      .transaction(async (tx) => {
        if (leavesManagement) {
          const managers = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, "Management"), eq(users.status, "Active")))
            .for("update");
          if (!managers.some((manager) => manager.id !== current.id)) {
            throw conflict("last_management", MESSAGES.lastManagement, {
              ...(role !== "Management" ? { role: MESSAGES.lastManagement } : {}),
              ...(status !== "Active" ? { status: MESSAGES.lastManagement } : {}),
            });
          }
        }
        await tx
          .update(users)
          .set({ ...values, ...newPassword, locationId: officeId, updatedBy: req.user!.id })
          .where(eq(users.id, current.id));
        if (stages) {
          await tx.delete(userStageGrants).where(eq(userStageGrants.userId, current.id));
          if (stages.length > 0) await tx.insert(userStageGrants).values(stages.map((stage) => ({ userId: current.id, stage })));
        }
      })
      .catch(duplicateEmailAsConflict);

    // B8.4: deactivating, or a new password, signs the user out at once; role and grant changes apply on their next request.
    if (password !== undefined || (current.status === "Active" && status === "Inactive")) await signOutEverywhere(pool, current.id);
    res.json({ user: await findUser(db, current.id) });
  });

  // USR-5 (D3). Only an account nobody uses is removed; one that is used gets 409 `in_use` and is deactivated instead.
  // Grants, password links and the user's own notifications go with it (ON DELETE CASCADE); nothing else is deleted.
  router.delete("/users/:id", admin, async (req, res) => {
    const id = String(req.params.id).toLowerCase();
    if (!isUuid(id)) throw notFound("User");
    if (id === req.user!.id) throw conflict("own_account", MESSAGES.ownRemove);
    await db.transaction(async (tx) => {
      // Locked, so the user can't sign in (which sets last_sign_in_at) between the checks and the delete. Every
      // reference column is written with the signed-in user's id, so a user who never signed in can't gain one meanwhile.
      const user = (
        await tx
          .select({ name: users.name, role: users.role, status: users.status, lastSignInAt: users.lastSignInAt })
          .from(users)
          .where(eq(users.id, id))
          .for("update")
      )[0];
      if (!user) throw notFound("User");
      // B8.2, as on USR-4. The caller is another active Management user, so only a race reaches this.
      if (user.role === "Management" && user.status === "Active") {
        const managers = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "Management"), eq(users.status, "Active")))
          .for("update");
        if (!managers.some((manager) => manager.id !== id)) throw conflict("last_management", MESSAGES.lastManagement);
      }
      const recorded: string[] = [];
      for (const use of REFERENCES) {
        const of = or(...use.columns.map((column) => eq(column, id)));
        // A user's own row may name them (they saved their own profile); deleting it leaves nothing behind.
        const where = use.table === users ? and(of, ne(users.id, id)) : of;
        const n = (await tx.select({ n: count() }).from(use.table).where(where))[0]!.n;
        if (n > 0) recorded.push(`${n} ${use.what}${n === 1 ? "" : "s"}`);
      }
      const used = [...(user.lastSignInAt ? ["signed in"] : []), ...(recorded.length > 0 ? [`recorded ${joined(recorded)}`] : [])];
      if (used.length > 0) throw conflict("in_use", MESSAGES.inUse(user.name, joined(used)));
      await tx.delete(users).where(eq(users.id, id));
    });
    res.status(204).end();
  });

  return router;
}
