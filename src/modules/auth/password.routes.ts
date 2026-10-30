import { Router } from "express";

import { HttpError } from "../../http/errors";

// Owner: A5 (passwords). Nobody sets their own password in the application (password policy, 2026-10-29): Management
// sets passwords on Add user and Edit user (USR-3, USR-4), and operators use scripts/reset-admin-password.ts.
// AUTH-5 POST /auth/change-password and AUTH-4 POST /auth/reset-password therefore answer 403 to everyone, signed in
// or not, without reading the body. Password links are no longer issued anywhere.

export const PASSWORD_CHANGE_DISABLED = "Passwords are set by a Management user.";

export function passwordRoutes() {
  const router = Router();
  router.post(["/auth/change-password", "/auth/reset-password"], () => {
    throw new HttpError(403, "password_change_disabled", PASSWORD_CHANGE_DISABLED);
  });
  return router;
}
