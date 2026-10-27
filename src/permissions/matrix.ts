import { ROLES, type Role } from "../db/schema";

// Roles matrix from screenshot 49 (frontend src/mocks/data/master.ts:79-93). Roles are fixed in this first version,
// so the matrix lives in code. Coordinator-owned: agents use the helpers below and never write their own checks.

export const ACCESS_LEVELS = ["None", "View", "Enter", "Full"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export const CAPABILITIES = [
  { key: "dashboard", label: "Dashboard" },
  { key: "ordersView", label: "Orders: view" },
  { key: "ordersEdit", label: "Orders: create and edit" },
  { key: "payments", label: "Deposits and payments" },
  { key: "calendar", label: "Delivery calendar" },
  { key: "receiving", label: "Receiving (China)" },
  { key: "containers", label: "Container loading" },
  { key: "clearing", label: "Clearing (India)" },
  { key: "transport", label: "Transport" },
  { key: "warehouse", label: "Warehouse" },
  { key: "landedCost", label: "Landed cost" },
  { key: "reports", label: "Reports" },
  { key: "admin", label: "Settings and users" },
] as const;
export type Capability = (typeof CAPABILITIES)[number]["key"];

// Columns in ROLES order: Management, Procurement, Accounts, China staff, India staff, Warehouse staff.
const ROWS: Record<Capability, Access[]> = {
  dashboard: ["Full", "Full", "Full", "None", "None", "None"],
  ordersView: ["Full", "Full", "View", "None", "None", "None"],
  ordersEdit: ["Full", "Enter", "None", "None", "None", "None"],
  payments: ["Full", "View", "Enter", "None", "None", "None"],
  calendar: ["Full", "Full", "None", "None", "None", "None"],
  receiving: ["Full", "View", "None", "Enter", "None", "None"],
  containers: ["Full", "None", "None", "Enter", "None", "None"],
  clearing: ["Full", "None", "None", "None", "Enter", "None"],
  transport: ["Full", "None", "None", "None", "Enter", "None"],
  warehouse: ["Full", "None", "None", "None", "None", "Enter"],
  landedCost: ["Full", "None", "None", "None", "None", "None"],
  reports: ["Full", "None", "None", "None", "None", "None"],
  admin: ["Full", "None", "None", "None", "None", "None"],
};

export const MATRIX: Record<Capability, Record<Role, Access>> = Object.fromEntries(
  CAPABILITIES.map(({ key }) => [key, Object.fromEntries(ROLES.map((role, i) => [role, ROWS[key][i] as Access]))]),
) as Record<Capability, Record<Role, Access>>;

/** Stage number for each stage capability (stages 2-6). */
export const STAGE_CAPABILITY: Record<number, Capability> = { 2: "receiving", 3: "containers", 4: "clearing", 5: "transport", 6: "warehouse" };
export const STAGE_PATH: Record<number, string> = { 2: "/receiving", 3: "/containers", 4: "/clearing", 5: "/transport", 6: "/warehouse" };
export const STAGE_LABEL: Record<number, string> = {
  2: "Receiving (China)",
  3: "Container loading",
  4: "Clearing (India)",
  5: "Transport",
  6: "Warehouse",
};

export const STAFF_ROLES: readonly Role[] = ["China staff", "India staff", "Warehouse staff"];
export const isStaffRole = (role: Role) => STAFF_ROLES.includes(role);

/** Stages a role may be granted (Q7: grants can only narrow these). Empty for non-staff roles. */
export function grantableStages(role: Role): number[] {
  if (!isStaffRole(role)) return [];
  return Object.entries(STAGE_CAPABILITY)
    .filter(([, capability]) => MATRIX[capability][role] === "Enter")
    .map(([stage]) => Number(stage));
}

/** Effective access: the matrix, narrowed by stage grants for staff roles (Q7). */
export function effectiveAccess(role: Role, stages: readonly number[], capability: Capability): Access {
  const access = MATRIX[capability][role];
  if (!isStaffRole(role)) return access;
  const stage = Object.entries(STAGE_CAPABILITY).find(([, cap]) => cap === capability)?.[0];
  if (stage === undefined) return access;
  return stages.includes(Number(stage)) ? access : "None";
}

export const atLeast = (access: Access, minimum: Access) => ACCESS_LEVELS.indexOf(access) >= ACCESS_LEVELS.indexOf(minimum);

export function permissionsFor(role: Role, stages: readonly number[]): Record<Capability, Access> {
  return Object.fromEntries(CAPABILITIES.map(({ key }) => [key, effectiveAccess(role, stages, key)])) as Record<Capability, Access>;
}

/** B2: second-line access label. The office type is added by the frontend when the user has an office. */
export function accessLabel(role: Role) {
  if (role === "Management") return "Full access";
  if (isStaffRole(role)) return "Entry only";
  return role;
}

/** B2.3: first letters of the first and last words of the name. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** B3.1 (L-b): China staff land on /home; India and Warehouse staff on their first granted stage; others on /. */
export function landingPath(role: Role, stages: readonly number[]) {
  if (!isStaffRole(role)) return "/";
  if (role === "China staff") return "/home";
  const first = [...stages].sort((a, b) => a - b)[0];
  return first === undefined ? "/home" : (STAGE_PATH[first] ?? "/home");
}
