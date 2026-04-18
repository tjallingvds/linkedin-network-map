/**
 * Minimal migration runner built on Kysely's Migrator + FileMigrationProvider.
 *
 * Usage:
 *   npm run migrate           → apply all pending
 *   npm run migrate:down      → revert last
 *   npm run migrate:make foo  → create empty migration 20260101000000_foo.ts
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Migrator, FileMigrationProvider } from "kysely";
import { db } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.join(__dirname, "migrations");

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({ fs, path, migrationFolder }),
});

async function up() {
  const { error, results } = await migrator.migrateToLatest();
  results?.forEach((r) => {
    if (r.status === "Success") console.log(`✓ migrated up: ${r.migrationName}`);
    if (r.status === "Error") console.error(`✗ failed:     ${r.migrationName}`);
  });
  if (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
  console.log("Migrations up to date.");
}

async function down() {
  const { error, results } = await migrator.migrateDown();
  results?.forEach((r) => {
    if (r.status === "Success") console.log(`✓ reverted: ${r.migrationName}`);
  });
  if (error) {
    console.error(error);
    process.exit(1);
  }
}

async function make(name: string) {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const file = path.join(migrationFolder, `${ts}_${name}.ts`);
  const stub = `import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // TODO
}

export async function down(db: Kysely<any>): Promise<void> {
  // TODO
}
`;
  await fs.mkdir(migrationFolder, { recursive: true });
  await fs.writeFile(file, stub);
  console.log(`Created ${file}`);
}

const cmd = process.argv[2];
const arg = process.argv[3];

try {
  if (cmd === "up") await up();
  else if (cmd === "down") await down();
  else if (cmd === "make") {
    if (!arg) {
      console.error("Usage: migrate make <name>");
      process.exit(1);
    }
    await make(arg);
  } else {
    console.error("Unknown command. Use: up | down | make <name>");
    process.exit(1);
  }
} finally {
  await db.destroy();
}
