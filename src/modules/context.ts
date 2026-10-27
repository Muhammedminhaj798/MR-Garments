import type pg from "pg";

import type { Config } from "../config";
import type { Database } from "../db/client";

/** What every module router receives. Coordinator-owned. */
export type RouteContext = { db: Database; pool: pg.Pool; config: Config };
