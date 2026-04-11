#!/bin/sh

set -eu

FAILED_MIGRATION="20251124132000_sync_inventory_itemid_unique"

should_resolve="$(FAILED_MIGRATION="$FAILED_MIGRATION" bun -e '
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const migrationName = process.env.FAILED_MIGRATION;

if (!databaseUrl || !migrationName) {
  console.log("skip");
  process.exit(0);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const result = await client.query(
    `SELECT finished_at IS NULL AS unfinished
     FROM "_prisma_migrations"
     WHERE migration_name = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [migrationName]
  );

  if (result.rowCount > 0 && result.rows[0]?.unfinished) {
    console.log("resolve");
  } else {
    console.log("skip");
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "42P01") {
      console.log("skip");
      process.exit(0);
    }
  }

  throw error;
} finally {
  await client.end().catch(() => {});
}
')"

if [ "$should_resolve" = "resolve" ]; then
  echo "Resolving failed Prisma migration: $FAILED_MIGRATION"
  bunx prisma migrate resolve --applied "$FAILED_MIGRATION"
fi

echo "Applying Prisma migrations"
bunx prisma migrate deploy

exec bun run start
