// ============================================================================
// MIGRATION SCRIPT — applies schema.sql and credit_functions.sql to
// whatever database DATABASE_URL points at. Run once on initial setup
// (and again any time you add a new migration file in this directory).
//
// This is intentionally simple — no migration framework, no version
// tracking table. For a project at this stage that's a reasonable
// tradeoff: simplicity over the production-grade migration tooling
// (Flyway, node-pg-migrate, Prisma Migrate) you'd want once the schema
// is changing frequently across a team. Revisit this once you have
// more than one person deploying schema changes.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// This script intentionally creates its own one-off Pool rather than
// importing src/db/pool.js — it's a standalone CLI tool that runs once
// and exits, not a long-lived server process, so the "many files sharing
// one pool" concern that pool.js solves doesn't apply here. It still
// needs the same SSL setting to connect through Supabase's pooler.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration(filename) {
  const filePath = path.join(__dirname, '..', 'src', 'db', filename);
  const sql = fs.readFileSync(filePath, 'utf8');
  console.log(`Running ${filename}...`);
  await pool.query(sql);
  console.log(`✓ ${filename} applied successfully.`);
}

async function main() {
  try {
    await runMigration('schema.sql');
    await runMigration('credit_functions.sql');
    console.log('\nAll migrations applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
