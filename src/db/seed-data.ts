import type { LocationType, Role } from "./schema";

// Master data transcribed from the frontend's src/mocks/data/master.ts (decision Q11: master data only).
// Not seeded: the Head office location (city deferred, U28) and every value derived from orders or stock.

export const SEED_LOCATIONS: { name: string; type: LocationType; country: "China" | "India"; address: string }[] = [
  { name: "Guangzhou office", type: "China office", country: "China", address: "Guangzhou" },
  { name: "India office", type: "India office", country: "India", address: "Kochi" },
  { name: "Main warehouse", type: "Warehouse", country: "India", address: "Kochi" },
];

export const SEED_SUPPLIERS = [
  { name: "Guangzhou Textile Co.", contactPerson: "Mr. Zhao Lin", phone: "+86 138 0013 2244", city: "Guangzhou" },
  { name: "Shenzhen Apparel", contactPerson: "Ms. Liu Yan", phone: "+86 139 2266 8810", city: "Shenzhen" },
  { name: "Foshan Fabrics", contactPerson: "Mr. Chen Hao", phone: "+86 137 2288 5501", city: "Foshan" },
  { name: "Yiwu Trims Ltd.", contactPerson: "Ms. Wu Mei", phone: "+86 135 5799 3120", city: "Yiwu" },
  { name: "Hangzhou Knits", contactPerson: "Mr. Sun Jie", phone: "+86 136 5711 4092", city: "Hangzhou" },
];

export const SEED_SHIPPING_AGENTS = [
  { name: "Sino Freight", contactPerson: "Ms. Zhang Min", phone: "+86 20 8123 4567", officeCity: "Guangzhou" },
  { name: "Dragon Cargo", contactPerson: "Mr. Huang Bo", phone: "+86 755 8899 1200", officeCity: "Shenzhen" },
];

export const SEED_CLEARING_AGENTS = [
  { name: "Kochi Clearing Services", contactPerson: "Mr. Anil Kumar", phone: "+91 98470 12345", port: "Kochi" },
  { name: "Southern Port Agents", contactPerson: "Mr. Rajesh Nair", phone: "+91 98950 44210", port: "Kochi" },
];

export const SEED_TRANSPORT_COMPANIES = [
  { name: "Kerala Roadways", contactPerson: "Mr. Biju Thomas", phone: "+91 94470 30011" },
  { name: "Malabar Carriers", contactPerson: "Mr. Salim P", phone: "+91 98460 77120" },
];

export const SEED_TEAMS = [{ name: "Retail team" }, { name: "Wholesale team" }, { name: "Online team" }];

export const SEED_ITEMS: { name: string; countedIn: "Pieces" | "Metres"; perBundle: number | null; bundleLabel: string | null }[] = [
  { name: "Denim jeans", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Track pants", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Kids t-shirts", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Ladies kurtis", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Polo shirts", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Men's shorts", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Men's jackets", countedIn: "Pieces", perBundle: 50, bundleLabel: null },
  { name: "Cotton fabric", countedIn: "Metres", perBundle: null, bundleLabel: "Roll" },
];

/** `office` is a location name, or null for the Head office users (deferred, U28). `stages` follows decision B7. */
export const SEED_USERS: { name: string; email: string; role: Role; office: string | null; stages: number[] }[] = [
  { name: "Suresh Menon", email: "suresh@mrgarments.com", role: "Management", office: null, stages: [] },
  { name: "Priya Nair", email: "priya@mrgarments.com", role: "Procurement", office: null, stages: [] },
  { name: "Anita Joseph", email: "anita@mrgarments.com", role: "Accounts", office: null, stages: [] },
  { name: "Wang Fang", email: "wang@mrgarments.com", role: "China staff", office: "Guangzhou office", stages: [2, 3] },
  { name: "Chen Yu", email: "chen@mrgarments.com", role: "China staff", office: "Guangzhou office", stages: [2] },
  { name: "Li Wei", email: "li@mrgarments.com", role: "China staff", office: "Guangzhou office", stages: [2, 3] },
  { name: "Anil Sharma", email: "anil@mrgarments.com", role: "India staff", office: "India office", stages: [4, 5] },
  { name: "Joseph M", email: "joseph@mrgarments.com", role: "Warehouse staff", office: "Main warehouse", stages: [6] },
];
