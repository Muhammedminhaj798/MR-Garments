import { describe, expect, it } from "vitest";

import { accessLabel, effectiveAccess, grantableStages, initials, landingPath, MATRIX, permissionsFor } from "./matrix";

describe("role matrix (screenshot 49)", () => {
  it("matches the approved matrix row by row", () => {
    const columns = (key: keyof typeof MATRIX) => Object.values(MATRIX[key]);
    expect(columns("dashboard")).toEqual(["Full", "Full", "Full", "None", "None", "None"]);
    expect(columns("ordersView")).toEqual(["Full", "Full", "View", "None", "None", "None"]);
    expect(columns("ordersEdit")).toEqual(["Full", "Enter", "None", "None", "None", "None"]);
    expect(columns("payments")).toEqual(["Full", "View", "Enter", "None", "None", "None"]);
    expect(columns("calendar")).toEqual(["Full", "Full", "None", "None", "None", "None"]);
    expect(columns("receiving")).toEqual(["Full", "View", "None", "Enter", "None", "None"]);
    expect(columns("containers")).toEqual(["Full", "None", "None", "Enter", "None", "None"]);
    expect(columns("clearing")).toEqual(["Full", "None", "None", "None", "Enter", "None"]);
    expect(columns("transport")).toEqual(["Full", "None", "None", "None", "Enter", "None"]);
    expect(columns("warehouse")).toEqual(["Full", "None", "None", "None", "None", "Enter"]);
    for (const key of ["landedCost", "reports", "admin"] as const) expect(columns(key)).toEqual(["Full", "None", "None", "None", "None", "None"]);
  });

  it("lets stage grants narrow staff access but never widen it (Q7)", () => {
    expect(grantableStages("China staff")).toEqual([2, 3]);
    expect(grantableStages("India staff")).toEqual([4, 5]);
    expect(grantableStages("Warehouse staff")).toEqual([6]);
    expect(grantableStages("Management")).toEqual([]);
    expect(effectiveAccess("China staff", [2], "receiving")).toBe("Enter");
    expect(effectiveAccess("China staff", [2], "containers")).toBe("None");
    expect(effectiveAccess("China staff", [2, 3, 4], "clearing")).toBe("None");
    expect(effectiveAccess("Management", [], "receiving")).toBe("Full");
    expect(permissionsFor("Procurement", []).receiving).toBe("View");
  });

  it("derives the sidebar label, initials and landing page (B2, B3)", () => {
    expect(accessLabel("Management")).toBe("Full access");
    expect(accessLabel("Procurement")).toBe("Procurement");
    expect(accessLabel("Accounts")).toBe("Accounts");
    expect(accessLabel("India staff")).toBe("Entry only");
    expect(initials("Suresh Menon")).toBe("SM");
    expect(initials("Chen Yu")).toBe("CY");
    expect(initials("Joseph M")).toBe("JM");
    expect(landingPath("Management", [])).toBe("/");
    expect(landingPath("China staff", [3])).toBe("/home");
    expect(landingPath("India staff", [5, 4])).toBe("/clearing");
    expect(landingPath("Warehouse staff", [6])).toBe("/warehouse");
    expect(landingPath("India staff", [])).toBe("/home");
  });
});
