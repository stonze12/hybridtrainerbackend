// ============================================================================
// SHARED DATABASE POOL — import this everywhere instead of each file
// creating its own `new Pool(...)`. This matters more on Supabase than
// it would on a raw Postgres box: Supabase's pooler (PgBouncer, in
// transaction mode on port 6543) has a real, fairly low ceiling on
// concurrent connections on the free tier. Ten different files each
// opening their own pool of, say, 10 connections each is 100 connections
// from one server process — that exhausts the pooler fast under any
// real traffic, even with a single Node instance. One shared pool, sized
// sensibly, is the fix.
//
// max: 10 is intentionally conservative for Supabase's free tier. If you
// upgrade your Supabase plan (which raises the pooler's connection
// ceiling) or run multiple server instances, revisit this number — but
// raise it deliberately, not by accident from copy-pasted pool creation
// scattered across files.
// ============================================================================

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set.');
}

// Supabase's pooler requires SSL. `rejectUnauthorized: false` is the
// standard setting for connecting through Supabase's pooler from a
// typical app server — Supabase manages the actual certificate chain
// on their end; this just tells the `pg` driver not to fail the
// handshake on Supabase's intermediate cert setup. This is the
// configuration Supabase's own docs recommend for this exact connection
// path, not a security shortcut specific to this app.
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,                       // see note above — conservative for the free-tier pooler
  idleTimeoutMillis: 30000,       // close idle connections after 30s rather than holding them open
  connectionTimeoutMillis: 10000, // fail fast (10s) rather than hanging if the pooler is saturated
});

pool.on('error', (err) => {
  // Without this handler, an idle client erroring out (e.g. Supabase
  // recycling a connection) can crash the whole Node process with an
  // unhandled error event — same failure mode you'd see from ioredis
  // without its own error handler.
  console.error('Unexpected Postgres pool error:', err.message);
});

module.exports = pool;
