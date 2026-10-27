import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { requireUser } from "../../auth/current-user";
import { hashPassword, passwordProblems, verifyPassword } from "../../auth/passwords";
import { renewSessionId, signOutEverywhere } from "../../auth/session";
import { completePasswordWithLink, LINK_INVALID_MESSAGE } from "../../auth/tokens";
import { users } from "../../db/schema";
import { HttpError } from "../../http/errors";
import { parse } from "../../http/validate";
import type { RouteContext } from "../context";

// Owner: A5 (passwords). Endpoints: AUTH-5 POST /auth/change-password, AUTH-4 POST /auth/reset-password.

// Approved wording (U36.2), word for word.
export const M = {
  currentEmpty: "Enter your current password.", // M5
  currentWrong: "Current password is incorrect.", // M6
  newEmpty: "Enter a new password.", // M7
  rules: "Use at least 8 characters, a number and a capital letter.", // M8
  tooLong: "Use 128 characters or fewer.", // M9
  confirmEmpty: "Confirm your new password.", // M10
  confirmMismatch: "New passwords do not match.", // M11
} as const;

const FIELDS_MESSAGE = "Some fields need attention.";

// A missing field counts as empty, so it gets the field's own message.
const changeSchema = z.strictObject({
  currentPassword: z.string({ error: M.currentEmpty }),
  newPassword: z.string({ error: M.newEmpty }),
  confirmPassword: z.string({ error: M.confirmEmpty }),
});

// A missing or non-text token is just an invalid link (M12).
const resetSchema = z.strictObject({
  token: z.string().catch(""),
  newPassword: z.string({ error: M.newEmpty }),
});

/** M7 when empty, M9 when over 128 characters, M8 for any other broken rule (B9.10). */
export function newPasswordMessage(password: string) {
  if (!password) return M.newEmpty;
  const problems = passwordProblems(password);
  if (problems.includes("too_long")) return M.tooLong;
  return problems.length > 0 ? M.rules : undefined;
}

export function passwordRoutes({ db, pool }: RouteContext) {
  const router = Router();

  router.post("/auth/change-password", requireUser, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = parse(changeSchema, req.body);
    const userId = req.user!.id;
    const fields: Record<string, string> = {};
    let code: string | undefined; // the first rule broken, in field order; empty fields alone are validation_failed

    if (!currentPassword) fields.currentPassword = M.currentEmpty;
    else {
      const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
      if (!(await verifyPassword(row?.passwordHash ?? null, currentPassword))) {
        fields.currentPassword = M.currentWrong;
        code ??= "wrong_current_password";
      }
    }
    const newMessage = newPasswordMessage(newPassword);
    if (newMessage) {
      fields.newPassword = newMessage;
      if (newPassword) code ??= "password_rules";
    }
    if (!confirmPassword) fields.confirmPassword = M.confirmEmpty;
    else if (confirmPassword !== newPassword) {
      fields.confirmPassword = M.confirmMismatch;
      code ??= "confirm_mismatch";
    }
    if (Object.keys(fields).length > 0) throw new HttpError(422, code ?? "validation_failed", FIELDS_MESSAGE, fields);

    const passwordHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, userId));
    // B9.11: every other session ends; this one stays signed in under a new ID.
    await signOutEverywhere(pool, userId, req.sessionID);
    await renewSessionId(req);
    res.status(204).end();
  });

  router.post("/auth/reset-password", async (req, res) => {
    const { token, newPassword } = parse(resetSchema, req.body);
    const newMessage = newPasswordMessage(newPassword);
    if (newMessage) {
      throw new HttpError(422, newPassword ? "password_rules" : "validation_failed", FIELDS_MESSAGE, { newPassword: newMessage });
    }
    try {
      // Atomic and single use; ends every session of the user (B1.6, B1.11, B9.12).
      await completePasswordWithLink(db, pool, token, newPassword);
    } catch (error) {
      // The shared helper calls this "link_invalid"; the AUTH-4 contract calls it "token_invalid".
      if (error instanceof HttpError && error.code === "link_invalid") throw new HttpError(422, "token_invalid", LINK_INVALID_MESSAGE);
      throw error;
    }
    res.status(204).end();
  });

  return router;
}
