import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";

import type { Database } from "../db/client";
import { locations, type LocationType, type Role, users, userStageGrants } from "../db/schema";
import { forbidden, unauthenticated } from "../http/errors";
import {
  type Access,
  accessLabel,
  atLeast,
  type Capability,
  effectiveAccess,
  initials,
  isStaffRole,
  landingPath,
  permissionsFor,
} from "../permissions/matrix";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  office: { id: string; name: string; type: LocationType } | null;
  stages: number[];
};

declare module "express-serve-static-core" {
  interface Request {
    user?: CurrentUser;
  }
}

export async function findCurrentUser(db: Database, userId: string): Promise<CurrentUser | undefined> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
      officeId: locations.id,
      officeName: locations.name,
      officeType: locations.type,
    })
    .from(users)
    .leftJoin(locations, eq(users.locationId, locations.id))
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row || row.status !== "Active") return undefined;
  const grants = await db.select({ stage: userStageGrants.stage }).from(userStageGrants).where(eq(userStageGrants.userId, userId));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    office: row.officeId ? { id: row.officeId, name: row.officeName!, type: row.officeType as LocationType } : null,
    stages: grants.map((grant) => grant.stage).sort((a, b) => a - b),
  };
}

/** The ME-1 body (docs/contracts.md). AUTH-1 returns the same shape as `{ user: toMe(user) }`. */
export function toMe(user: CurrentUser) {
  return {
    id: user.id,
    name: user.name,
    initials: initials(user.name),
    email: user.email,
    role: user.role,
    office: user.office,
    accessLabel: accessLabel(user.role),
    shell: isStaffRole(user.role) ? "staff" : "management",
    landing: landingPath(user.role, user.stages),
    stages: user.stages,
    permissions: permissionsFor(user.role, user.stages),
  };
}

/**
 * Re-reads the signed-in user on every request (B8.4), so role and grant changes apply on the next request and an
 * inactive or deleted user's session is ended at once.
 */
export function loadCurrentUser(db: Database): RequestHandler {
  return async (req, _res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return next();
      const user = await findCurrentUser(db, userId);
      if (user) {
        req.user = user;
        return next();
      }
      req.session.destroy(() => next());
    } catch (error) {
      next(error);
    }
  };
}

export const requireUser: RequestHandler = (req, _res, next) => next(req.user ? undefined : unauthenticated());

/** 401 when signed out; 403 unless the user's effective access (matrix narrowed by grants) is at least `minimum`. */
export function requirePermission(capability: Capability, minimum: Access): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthenticated());
    const access = effectiveAccess(req.user.role, req.user.stages, capability);
    next(atLeast(access, minimum) ? undefined : forbidden());
  };
}
