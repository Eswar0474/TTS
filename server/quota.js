import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAILY_WORD_LIMIT = 1_000;
export const GUEST_DAILY_WORD_LIMIT = 50;

const limitForSubject = subjectType => subjectType === 'user' ? DAILY_WORD_LIMIT : GUEST_DAILY_WORD_LIMIT;

const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrations = readdirSync(migrationsPath)
  .filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
  .sort()
  .map(name => ({ name, sql: readFileSync(path.join(migrationsPath, name), 'utf8') }));
const migrationLockId = 531_240_019;

async function initializeSchema(pool) {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    try {
      await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
      lockAcquired = true;
    } catch {
      // Supabase / PgBouncer / Supavisor transaction poolers (port 6543) do not support
      // session-level advisory locks. Proceed with idempotent DDL and transactional updates.
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS sonora_schema_migrations (
        migration TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    for (const migration of migrations) {
      const applied = await client.query(
        'SELECT migration FROM sonora_schema_migrations WHERE migration = $1',
        [migration.name]
      );
      if (applied.rows.length) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO sonora_schema_migrations (migration) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query("DELETE FROM daily_word_usage WHERE usage_date < CURRENT_DATE - INTERVAL '90 days'");
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
      }
    } catch {}
    client.release();
  }
}

export function createPostgresDailyWordQuota({ pool, secret, now = () => new Date() }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL connection pool is required.');
  if (typeof secret !== 'string' || !secret) throw new TypeError('A stable quota hashing secret is required.');

  const ready = initializeSchema(pool);
  ready.catch(() => {});
  const today = () => now().toISOString().slice(0, 10);
  const hashedSubject = (type, value) => createHmac('sha256', secret)
    .update(`${type}:${String(value)}`)
    .digest('hex');
  const formatUsage = (used, day, limit) => {
    const reset = new Date(`${day}T00:00:00.000Z`);
    reset.setUTCDate(reset.getUTCDate() + 1);
    const boundedUsed = Math.min(used, limit);
    return { limit, used: boundedUsed, remaining: limit - boundedUsed, resetsAt: reset.toISOString() };
  };
  const readUsage = async (subjectType, subjectHash, day, limit) => {
    const result = await pool.query(
      'SELECT words_used FROM daily_word_usage WHERE usage_date = $1 AND subject_type = $2 AND subject_hash = $3',
      [day, subjectType, subjectHash]
    );
    return formatUsage(Number(result.rows[0]?.words_used ?? 0), day, limit);
  };

  const getUsageFor = async (subjectType, subjectId) => {
    if (!['ip', 'user'].includes(subjectType) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid quota subject.');
    await ready;
    const day = today();
    return readUsage(subjectType, hashedSubject(subjectType, subjectId), day, limitForSubject(subjectType));
  };
  const consumeFor = async (subjectType, subjectId, words) => {
    if (!['ip', 'user'].includes(subjectType) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid quota subject.');
    if (!Number.isSafeInteger(words) || words <= 0) throw new RangeError('Word usage must be a positive integer.');
    await ready;
    const day = today();
    const hash = hashedSubject(subjectType, subjectId);
    const limit = limitForSubject(subjectType);
    const result = await pool.query(
      `INSERT INTO daily_word_usage (usage_date, subject_type, subject_hash, words_used)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usage_date, subject_type, subject_hash)
       DO UPDATE SET words_used = daily_word_usage.words_used + EXCLUDED.words_used
       WHERE daily_word_usage.words_used + EXCLUDED.words_used <= $5
       RETURNING words_used`,
      [day, subjectType, hash, words, limit]
    );
    if (result.rows.length) {
      return { allowed: true, dailyWordQuota: formatUsage(Number(result.rows[0].words_used), day, limit) };
    }
    return { allowed: false, dailyWordQuota: await readUsage(subjectType, hash, day, limit) };
  };
  return {
    getUsageFor,
    consumeFor,
    getUsage: ip => getUsageFor('ip', ip),
    consume: (ip, words) => consumeFor('ip', ip, words)
  };
}

export function createMemoryDailyWordQuota({ secret, now = () => new Date() }) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('A quota hashing secret is required.');
  const usage = new Map();
  const keyFor = (type, subjectId, day) => `${day}:${createHmac('sha256', secret).update(`${type}:${String(subjectId)}`).digest('hex')}`;
  const snapshot = (type, subjectId) => {
    const day = now().toISOString().slice(0, 10);
    const key = keyFor(type, subjectId, day);
    const used = usage.get(key) ?? 0;
    const reset = new Date(`${day}T00:00:00.000Z`);
    reset.setUTCDate(reset.getUTCDate() + 1);
    const limit = limitForSubject(type);
    const boundedUsed = Math.min(used, limit);
    return { key, dailyWordQuota: { limit, used: boundedUsed, remaining: limit - boundedUsed, resetsAt: reset.toISOString() } };
  };
  const getUsageFor = async (type, subjectId) => {
    if (!['ip', 'user'].includes(type) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid quota subject.');
    return snapshot(type, subjectId).dailyWordQuota;
  };
  const consumeFor = async (type, subjectId, words) => {
    if (!['ip', 'user'].includes(type) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid quota subject.');
      if (!Number.isSafeInteger(words) || words <= 0) throw new RangeError('Word usage must be a positive integer.');
      const current = snapshot(type, subjectId);
      if (words > current.dailyWordQuota.remaining) return { allowed: false, dailyWordQuota: current.dailyWordQuota };
      const used = current.dailyWordQuota.used + words;
      usage.set(current.key, used);
      return {
        allowed: true,
        dailyWordQuota: { ...current.dailyWordQuota, used, remaining: current.dailyWordQuota.limit - used }
      };
  };
  return {
    getUsageFor,
    consumeFor,
    getUsage: ip => getUsageFor('ip', ip),
    consume: (ip, words) => consumeFor('ip', ip, words)
  };
}

export function createUnavailableDailyWordQuota() {
  const unavailable = async () => { throw new Error('PostgreSQL is required for daily quota storage.'); };
  return { getUsageFor: unavailable, consumeFor: unavailable, getUsage: unavailable, consume: unavailable };
}
