import { pathToFileURL } from "node:url";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { config } from "../config";
import { hashPassword, passwordProblems } from "../auth/passwords";
import { createDatabase, databaseName, type Database } from "./client";
import {
  clearingAgents,
  items,
  locations,
  shippingAgents,
  suppliers,
  teams,
  transportCompanies,
  users,
  userStageGrants,
} from "./schema";
import {
  SEED_CLEARING_AGENTS,
  SEED_ITEMS,
  SEED_LOCATIONS,
  SEED_SHIPPING_AGENTS,
  SEED_SUPPLIERS,
  SEED_TEAMS,
  SEED_TRANSPORT_COMPANIES,
  SEED_USERS,
} from "./seed-data";

export type SeedOptions = {
  nodeEnv: "development" | "test" | "production";
  /** Given to seeded users that have no password (B1.3). Never allowed in production (B1.2). */
  devPassword?: string;
};

/**
 * Inserts the master data and users that are missing. Safe to run again: existing rows, including anything changed
 * while testing, are left alone, and stage grants are only added for users created by this run.
 */
export async function seed(db: Database, { nodeEnv, devPassword }: SeedOptions) {
  if (devPassword && nodeEnv === "production") {
    throw new Error("SEED_DEV_PASSWORD must not be set in production. The seed refused to run.");
  }
  if (devPassword && passwordProblems(devPassword).length > 0) {
    throw new Error("SEED_DEV_PASSWORD does not meet the password rules (8-128 characters, a number and a capital letter).");
  }

  // Lists are returned in creation order (docs/contracts.md), so each seeded row gets its own created_at, 1 ms apart
  // in master.ts order. That reproduces the reference order; now() alone is the same for the whole transaction.
  const seededAt = Date.now();
  const at = (index: number) => new Date(seededAt + index);
  const inOrder = <T extends object>(rows: readonly T[]) => rows.map((row, index) => ({ ...row, createdAt: at(index) }));

  await db.transaction(async (tx) => {
    await tx.insert(locations).values(inOrder(SEED_LOCATIONS)).onConflictDoNothing();
    await tx.insert(suppliers).values(inOrder(SEED_SUPPLIERS)).onConflictDoNothing();
    await tx.insert(shippingAgents).values(inOrder(SEED_SHIPPING_AGENTS)).onConflictDoNothing();
    await tx.insert(clearingAgents).values(inOrder(SEED_CLEARING_AGENTS)).onConflictDoNothing();
    await tx.insert(transportCompanies).values(inOrder(SEED_TRANSPORT_COMPANIES)).onConflictDoNothing();
    await tx.insert(teams).values(inOrder(SEED_TEAMS)).onConflictDoNothing();
    await tx.insert(items).values(inOrder(SEED_ITEMS)).onConflictDoNothing();

    const locationRows = await tx.select({ id: locations.id, name: locations.name }).from(locations);
    const locationId = (name: string | null) => (name ? locationRows.find((row) => row.name === name)?.id ?? null : null);

    for (const [index, user] of SEED_USERS.entries()) {
      const created = await tx
        .insert(users)
        .values({ name: user.name, email: user.email, role: user.role, locationId: locationId(user.office), createdAt: at(index) })
        .onConflictDoNothing()
        .returning({ id: users.id });
      const id = created[0]?.id;
      if (id && user.stages.length > 0) {
        await tx.insert(userStageGrants).values(user.stages.map((stage) => ({ userId: id, stage })));
      }
    }

    if (devPassword) {
      const hash = await hashPassword(devPassword);
      const emails = SEED_USERS.map((user) => user.email);
      await tx
        .update(users)
        .set({ passwordHash: hash, passwordChangedAt: new Date() })
        .where(and(isNull(users.passwordHash), inArray(users.email, emails)));
    }
  });
}

export const countUsers = async (db: Database) => (await db.select({ id: users.id }).from(users)).length;
export const findUserByEmail = async (db: Database, email: string) =>
  (await db.select().from(users).where(eq(users.email, email)))[0];

// Run directly (npm run db:seed). pathToFileURL encodes spaces ("MR Garments") the way import.meta.url does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const settings = config();
  const { pool, db } = createDatabase(settings.DATABASE_URL);
  try {
    await seed(db, { nodeEnv: settings.NODE_ENV, devPassword: settings.SEED_DEV_PASSWORD || undefined });
    console.info(
      `Seed applied to ${databaseName(settings.DATABASE_URL)}.` +
        (settings.SEED_DEV_PASSWORD ? " Development password set for seeded users that had none." : " No development password set."),
    );
  } finally {
    await pool.end();
  }
}
