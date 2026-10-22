import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDailyWordQuota, PLAN_WORD_LIMITS } from '../server/quota.js';

function createFakePostgresPool() {
  const usage = new Map();
  const migrations = new Set();
  const calls = [];
  const query = async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS sonora_schema_migrations') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS daily_word_usage') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS users') ||
          sql.startsWith('ALTER TABLE users ADD COLUMN') ||
          sql.includes('session') ||
          sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
          sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' ||
          sql.startsWith('DELETE FROM daily_word_usage')) return { rows: [] };
      if (sql.includes('SELECT migration FROM sonora_schema_migrations')) {
        return { rows: migrations.has(values[0]) ? [{ migration: values[0] }] : [] };
      }
      if (sql.includes('INSERT INTO sonora_schema_migrations')) {
        migrations.add(values[0]);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO daily_word_usage')) {
        const [day, subjectType, subjectHash, words, limit] = values;
        const key = `${day}:${subjectType}:${subjectHash}`;
        const current = usage.get(key) ?? 0;
        if (current + words > limit) return { rows: [] };
        const wordsUsed = current + words;
        usage.set(key, wordsUsed);
        return { rows: [{ words_used: wordsUsed }] };
      }
      if (sql.includes('SELECT words_used FROM daily_word_usage')) {
        const [day, subjectType, subjectHash] = values;
        const wordsUsed = usage.get(`${day}:${subjectType}:${subjectHash}`);
        return { rows: wordsUsed === undefined ? [] : [{ words_used: wordsUsed }] };
      }
      throw new Error(`Unexpected SQL query: ${sql}`);
  };
  const client = { query, release() {} };
  return {
    calls,
    query,
    async connect() { return client; }
  };
}

test('PostgreSQL quota applies separate atomic guest and account limits', async () => {
  const pool = createFakePostgresPool();
  let currentTime = new Date('2026-10-12T12:00:00.000Z');
  const quota = createPostgresDailyWordQuota({
    pool,
    secret: 'stable-test-secret',
    now: () => currentTime
  });
  const secondInstance = createPostgresDailyWordQuota({
    pool,
    secret: 'stable-test-secret',
    now: () => currentTime
  });
  const userId = 'account-123';

  const first = await quota.consumeFor('user', userId, 999);
  assert.equal(first.allowed, true);
  assert.equal(first.dailyWordQuota.remaining, 1);
  const concurrent = await Promise.all([
    quota.consumeFor('user', userId, 1),
    secondInstance.consumeFor('user', userId, 1)
  ]);
  assert.equal(concurrent.filter(({ allowed }) => allowed).length, 1);
  assert.equal((await secondInstance.getUsageFor('user', userId)).used, 1000);
  assert.equal((await quota.getUsageFor('ip', userId)).used, 0);
  const guest = await quota.consumeFor('ip', userId, 50);
  assert.equal(guest.allowed, true);
  assert.equal(guest.dailyWordQuota.limit, 50);
  assert.equal(guest.dailyWordQuota.remaining, 0);
  assert.equal((await quota.consumeFor('ip', userId, 1)).allowed, false);
  assert.equal((await quota.getUsageFor('user', userId)).limit, 1000);
  assert.ok(pool.calls.some(({ sql }) => sql.includes("CHECK (subject_type IN ('ip', 'user'))")));
  assert.ok(pool.calls.filter(({ sql }) => sql.includes('INSERT INTO daily_word_usage'))
    .every(({ values }) => values[2] !== userId && /^[a-f0-9]{64}$/.test(values[2])));

  currentTime = new Date('2026-10-13T00:00:00.000Z');
  assert.equal((await quota.getUsageFor('user', userId)).used, 0);
});

test('PostgreSQL schema initialization succeeds when transaction poolers reject advisory locks', async () => {
  const pool = createFakePostgresPool();
  const innerClientQuery = (await pool.connect()).query;
  const poolClient = {
    release() {},
    query: async (sql, values) => {
      if (sql.includes('pg_advisory_lock')) {
        const error = new Error('pg_advisory_lock is not supported in transaction pooling mode');
        error.code = '0A000';
        throw error;
      }
      return innerClientQuery(sql, values);
    }
  };
  const poolerPool = {
    calls: pool.calls,
    query: pool.query,
    async connect() { return poolClient; }
  };
  const quota = createPostgresDailyWordQuota({
    pool: poolerPool,
    secret: 'pooler-test-secret',
    now: () => new Date('2026-10-12T12:00:00.000Z')
  });
  const result = await quota.getUsageFor('ip', '192.0.2.1');
  assert.equal(result.used, 0);
  assert.equal(result.limit, 50);
});

test('plan word limits apply custom quotas for plus, pro, and studio', async () => {
  const pool = createFakePostgresPool();
  const quota = createPostgresDailyWordQuota({
    pool,
    secret: 'plan-test-secret',
    now: () => new Date('2026-10-12T12:00:00.000Z')
  });

  const plusUsage = await quota.getUsageFor('user', 'user_plus', 2000);
  assert.equal(plusUsage.limit, 2000);
  assert.equal(plusUsage.remaining, 2000);

  const plusConsume = await quota.consumeFor('user', 'user_plus', 1500, 2000);
  assert.equal(plusConsume.allowed, true);
  assert.equal(plusConsume.dailyWordQuota.used, 1500);
  assert.equal(plusConsume.dailyWordQuota.remaining, 500);

  const proUsage = await quota.getUsageFor('user', 'user_pro', 3000);
  assert.equal(proUsage.limit, 3000);
  assert.equal(proUsage.remaining, 3000);

  const proConsume = await quota.consumeFor('user', 'user_pro', 2500, 3000);
  assert.equal(proConsume.allowed, true);
  assert.equal(proConsume.dailyWordQuota.used, 2500);
  assert.equal(proConsume.dailyWordQuota.remaining, 500);

  const studioUsage = await quota.getUsageFor('user', 'user_studio', 5000);
  assert.equal(studioUsage.limit, 5000);
  assert.equal(studioUsage.remaining, 5000);

  const studioConsume = await quota.consumeFor('user', 'user_studio', 4500, 5000);
  assert.equal(studioConsume.allowed, true);
  assert.equal(studioConsume.dailyWordQuota.used, 4500);
  assert.equal(studioConsume.dailyWordQuota.remaining, 500);

  assert.equal(PLAN_WORD_LIMITS.guest, 50);
  assert.equal(PLAN_WORD_LIMITS.free, 1000);
  assert.equal(PLAN_WORD_LIMITS.plus, 2000);
  assert.equal(PLAN_WORD_LIMITS.pro, 3000);
  assert.equal(PLAN_WORD_LIMITS.studio, 5000);
});
