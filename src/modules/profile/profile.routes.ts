import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requireUser } from "../../auth/current-user";
import type { Database } from "../../db/client";
import { locations, users } from "../../db/schema";
import { GENERIC_MESSAGE, HttpError } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";
import { LANGUAGES, fields } from "../users/users.routes";

// PRF-1 GET /profile, PRF-2 PATCH /profile (D:\SDEC\MR Garments\docs\profile-contract.md).
// Always the caller's own row: the id comes from the session only.

// Not yet approved wording: the form only offers valid languages, so a user should never see it.
const LANGUAGE_MESSAGE = "Choose a language from the list.";

// Strict: email, role, officeId, status, stages, password, id or any other key is a 400.
const updateSchema = z
  .strictObject({ name: fields.name, phone: fields.phone, language: z.enum(LANGUAGES, { error: LANGUAGE_MESSAGE }) })
  .partial();

async function findProfile(db: Database, id: string) {
  const row = (
    await db
      .select({
        name: users.name,
        email: users.email,
        phone: users.phone,
        role: users.role,
        officeId: locations.id,
        officeName: locations.name,
        language: users.language,
        passwordChangedAt: users.passwordChangedAt,
      })
      .from(users)
      .leftJoin(locations, eq(users.locationId, locations.id))
      .where(eq(users.id, id))
  )[0]!;
  const { officeId, officeName, ...profile } = row;
  return { ...profile, office: officeId ? { id: officeId, name: officeName! } : null };
}

export function profileRoutes({ db }: RouteContext) {
  const router = Router();

  router.get("/profile", requireUser, async (req, res) => {
    res.json({ profile: await findProfile(db, req.user!.id), options: { languages: LANGUAGES } });
  });

  // Only the keys sent change; an empty body is a 400 like an unknown key.
  router.patch("/profile", requireUser, async (req, res) => {
    const input = parse(updateSchema, req.body);
    if (Object.keys(input).length === 0) throw new HttpError(400, "bad_request", GENERIC_MESSAGE);
    await db
      .update(users)
      .set({ ...input, updatedBy: req.user!.id })
      .where(eq(users.id, req.user!.id));
    res.json({ profile: await findProfile(db, req.user!.id) });
  });

  return router;
}
