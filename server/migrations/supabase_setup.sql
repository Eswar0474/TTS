-- Sonora Voice Studio — Supabase Setup Script
-- You can run this script directly in the Supabase SQL Editor (Dashboard -> SQL Editor)
-- or let Sonora apply migrations automatically upon connection.

-- 1. Schema Migrations Table
CREATE TABLE IF NOT EXISTS sonora_schema_migrations (
  migration TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Daily Word Usage Quota Table
CREATE TABLE IF NOT EXISTS daily_word_usage (
  usage_date DATE NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('ip', 'user')),
  subject_hash CHAR(64) NOT NULL,
  words_used INTEGER NOT NULL CHECK (words_used >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usage_date, subject_type, subject_hash)
);

CREATE INDEX IF NOT EXISTS idx_daily_word_usage_date ON daily_word_usage (usage_date);

-- Upgrade databases created with the original 1,000-word storage constraint.
ALTER TABLE daily_word_usage
  DROP CONSTRAINT IF EXISTS daily_word_usage_words_used_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'daily_word_usage'::regclass
      AND conname = 'daily_word_usage_words_used_nonnegative'
  ) THEN
    ALTER TABLE daily_word_usage
      ADD CONSTRAINT daily_word_usage_words_used_nonnegative
      CHECK (words_used >= 0);
  END IF;
END $$;

-- Mark base migration as applied
INSERT INTO sonora_schema_migrations (migration)
VALUES ('001_daily_word_usage.sql'), ('005_expand_daily_word_quota.sql')
ON CONFLICT (migration) DO NOTHING;

-- 3. Users Table (Google Sign-In accounts; legacy columns are retained)
CREATE TABLE IF NOT EXISTS users (
  google_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  expire_date TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

INSERT INTO sonora_schema_migrations (migration)
VALUES ('002_users.sql'), ('003_add_expire_date_to_users.sql')
ON CONFLICT (migration) DO NOTHING;

-- 4. Session Store Table (for Google Sign-In with connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
