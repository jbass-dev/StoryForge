import pg from "pg";

const { Pool } = pg;

// Railway's Postgres plugin injects DATABASE_URL automatically once it's
// attached to this service - nothing else to configure. Locally, falls back
// to undefined/null and DB_ENABLED is false, so the routes can keep working
// against the old flat-file feed.json for anyone running without Postgres.
const DATABASE_URL = process.env.DATABASE_URL;

export const DB_ENABLED = Boolean(DATABASE_URL);

let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Managed Postgres (Neon, Supabase, Render, Railway) all require SSL and
      // present certs Node won't validate by default. Enable SSL for any
      // non-local database; local dev over localhost stays plaintext.
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

let initialized = null;
// Whole reel is stored as one JSONB blob keyed by id - the app never needs
// to query into individual fields (title/scenes/etc.) server-side, it just
// reads/writes a full reel object exactly like it did with feed.json. This
// keeps the migration to Postgres about durability, not a schema rewrite.
export async function ensureSchema() {
  if (!DB_ENABLED) return;
  if (initialized) return initialized;
  initialized = getPool().query(`
    CREATE TABLE IF NOT EXISTS reels (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  return initialized;
}

export async function listReels() {
  await ensureSchema();
  const { rows } = await getPool().query("SELECT data FROM reels ORDER BY created_at ASC");
  return rows.map((r) => r.data);
}

export async function getReelById(id) {
  await ensureSchema();
  const { rows } = await getPool().query("SELECT data FROM reels WHERE id = $1", [id]);
  return rows[0]?.data || null;
}

export async function insertReel(reel) {
  await ensureSchema();
  await getPool().query(
    "INSERT INTO reels (id, data, created_at) VALUES ($1, $2, $3)",
    [reel.id, reel, reel.createdAt || new Date().toISOString()]
  );
}

export async function updateReel(reel) {
  await ensureSchema();
  await getPool().query("UPDATE reels SET data = $2 WHERE id = $1", [reel.id, reel]);
}

export async function deleteReelById(id) {
  await ensureSchema();
  await getPool().query("DELETE FROM reels WHERE id = $1", [id]);
}
