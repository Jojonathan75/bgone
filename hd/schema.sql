-- Base D1 du HD payant. À coller une seule fois dans Cloudflare :
-- Storage & Databases → D1 → poppix-hd → Console, puis « Execute ».
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0)
);
CREATE TABLE IF NOT EXISTS purchases (
  session_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_code ON purchases (code);
