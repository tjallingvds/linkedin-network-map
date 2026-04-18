import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { env } from "../env.js";
import type { Database } from "./types.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // Neon / managed Postgres usually requires SSL; allow self-signed in dev.
  ssl: env.DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export type { Database };
