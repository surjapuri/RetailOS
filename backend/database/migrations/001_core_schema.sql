-- ═══════════════════════════════════════════════════════════════
-- RetailOS Database Migration 001 — Core Schema
-- Run order: 001 → 002 → 003
-- PostgreSQL 15+ with PostGIS 3.4 required
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Fast text search on product names

-- ─────────────────────────────────────────────────────────────
-- UTILITY FUNCTIONS
-- ─────────────────────────────────────────────────────────────

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Sequential invoice number generator per store
CREATE OR REPLACE FUNCTION generate_invoice_number(p_store_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_seq  INTEGER;
  v_year TEXT;
BEGIN
  v_year := TO_CHAR(NOW(), 'YYYY');
  -- Atomic increment per store per year
  INSERT INTO invoice_sequences (store_id, year, last_seq)
    VALUES (p_store_id, v_year, 1)
    ON CONFLICT (store_id, year)
    DO UPDATE SET last_seq = invoice_sequences.last_seq + 1
    RETURNING last_seq INTO v_seq;
  RETURN 'INV-' || v_year || '-' || LPAD(v_seq::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- SUPER ADMIN (isolated from all store tables)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE super_admin_users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(100) UNIQUE NOT NULL,
  password_hash  TEXT        NOT NULL,        -- bcrypt, cost=12
  totp_secret    TEXT        NOT NULL,        -- Base32 TOTP secret
  allowed_ips    INET[]      NOT NULL DEFAULT '{}',
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  last_login_ip  INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- TIER CONFIG (Super Admin writes, cached in Redis)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE tier_config (
  tier              VARCHAR(10)    PRIMARY KEY,   -- bronze|silver|gold
  display_name      VARCHAR(50)    NOT NULL,
  monthly_price     NUMERIC(10,2)  NOT NULL,
  crm_limit         INTEGER,                       -- NULL = unlimited
  inbox_msg_limit   INTEGER,
  wa_msg_limit      INTEGER,
  branch_limit      INTEGER,
  can_run_ads       BOOLEAN        NOT NULL DEFAULT FALSE,
  can_use_b2b       BOOLEAN        NOT NULL DEFAULT FALSE,
  can_use_ai_nudge  BOOLEAN        NOT NULL DEFAULT FALSE,
  ad_placement_types TEXT[]        NOT NULL DEFAULT '{}',
  updated_by        UUID           REFERENCES super_admin_users(id),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

INSERT INTO tier_config VALUES
  ('bronze', 'Bronze', 999.00,  1000, 50,   0,    1,    FALSE, FALSE, FALSE, '{}'),
  ('silver', 'Silver', 2499.00, 5000, 500,  500,  3,    FALSE, TRUE,  TRUE,  '{}'),
  ('gold',   'Gold',   5999.00, NULL, NULL, NULL, NULL, TRUE,  TRUE,  TRUE,  ARRAY['map_top','search_suggest','inbox_push']);

-- ─────────────────────────────────────────────────────────────
-- STORES & BRANCHES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE stores (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name     VARCHAR(255) NOT NULL,
  owner_mobile      VARCHAR(15)  UNIQUE NOT NULL,
  gstin             VARCHAR(16)  UNIQUE,
  fssai_number      VARCHAR(20),
  pan               VARCHAR(12),
  -- KYB status
  kyb_status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (kyb_status IN ('pending','under_review','verified','rejected')),
  kyb_rejected_reason TEXT,
  -- Subscription
  subscription_tier VARCHAR(10)  NOT NULL DEFAULT 'bronze'
                    REFERENCES tier_config(tier),
  subscription_status VARCHAR(20) NOT NULL DEFAULT 'trial'
                    CHECK (subscription_status IN ('trial','active','past_due','cancelled')),
  trial_ends_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '14 days',
  -- Bank details (AES-256-GCM encrypted at app layer)
  bank_account_enc  TEXT,
  bank_ifsc_enc     TEXT,
  bank_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Meta
  logo_url          TEXT,
  store_type        VARCHAR(20)  NOT NULL DEFAULT 'kirana'
                    CHECK (store_type IN ('kirana','supermarket','wholesale','pharmacy')),
  is_discoverable   BOOLEAN      NOT NULL DEFAULT TRUE,
  is_suspended      BOOLEAN      NOT NULL DEFAULT FALSE,
  suspension_reason TEXT,
  suspended_until   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TABLE branches (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                VARCHAR(150) NOT NULL,
  address             TEXT        NOT NULL,
  location            GEOMETRY(Point, 4326),   -- PostGIS
  city                VARCHAR(100),
  state               VARCHAR(100),
  pincode             VARCHAR(10),
  gstin               VARCHAR(16),             -- branch-level GST if different
  phone               VARCHAR(15),
  operating_hours     JSONB       NOT NULL DEFAULT '{
    "mon":{"open":"09:00","close":"21:00","closed":false},
    "tue":{"open":"09:00","close":"21:00","closed":false},
    "wed":{"open":"09:00","close":"21:00","closed":false},
    "thu":{"open":"09:00","close":"21:00","closed":false},
    "fri":{"open":"09:00","close":"21:00","closed":false},
    "sat":{"open":"09:00","close":"21:00","closed":false},
    "sun":{"open":"10:00","close":"20:00","closed":false}
  }',
  delivery_radius_km  NUMERIC(5,2)  NOT NULL DEFAULT 3.0,
  wa_catalog_id       TEXT,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX branches_location_gist ON branches USING GIST(location);
CREATE INDEX branches_store_id ON branches(store_id);

CREATE TRIGGER set_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- ─────────────────────────────────────────────────────────────
-- USERS & RBAC
-- ─────────────────────────────────────────────────────────────

CREATE TABLE users (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id              UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id             UUID        REFERENCES branches(id),    -- NULL = all branches
  name                  VARCHAR(100) NOT NULL,
  mobile                VARCHAR(15)  UNIQUE NOT NULL,
  pin_hash              TEXT,                                   -- 4-6 digit PIN (bcrypt)
  role                  VARCHAR(20)  NOT NULL
                        CHECK (role IN ('cashier','head_cashier','buyer','finance','admin')),
  role_level            SMALLINT     NOT NULL
                        CHECK (role_level BETWEEN 1 AND 5),    -- 1=cashier, 5=admin
  -- Supervisor auth methods
  supervisor_card_hash  TEXT,                                   -- HMAC-SHA256 of card barcode
  biometric_enrolled    BOOLEAN      NOT NULL DEFAULT FALSE,
  totp_secret           TEXT,                                   -- For rolling PIN (head_cashier)
  -- FCM push token
  fcm_token             TEXT,
  -- State
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX users_store_id ON users(store_id);
CREATE INDEX users_mobile ON users(mobile);

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- Supervisor authorization sessions (one-time use, 60-second window)
CREATE TABLE supervisor_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  supervisor_id  UUID        NOT NULL REFERENCES users(id),
  requestor_id   UUID        NOT NULL REFERENCES users(id),
  terminal_id    VARCHAR(100) NOT NULL,
  auth_method    VARCHAR(20)  NOT NULL
                 CHECK (auth_method IN ('card','biometric','rolling_pin')),
  expires_at     TIMESTAMPTZ  NOT NULL,
  used           BOOLEAN      NOT NULL DEFAULT FALSE,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Refresh tokens (stored server-side for revocation)
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        UNIQUE NOT NULL,   -- SHA-256 of the token
  device_id   VARCHAR(100),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_token_hash ON refresh_tokens(token_hash);

-- ─────────────────────────────────────────────────────────────
-- INVOICE SEQUENCE (per store per year)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE invoice_sequences (
  store_id  UUID        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  year      CHAR(4)     NOT NULL,
  last_seq  INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, year)
);

-- ─────────────────────────────────────────────────────────────
-- PRODUCTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE products (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  plu_code        VARCHAR(20),                          -- Price Look-Up code
  barcode         VARCHAR(64)  UNIQUE,
  internal_barcode VARCHAR(13),                         -- Custom EAN-13 for loose items
  name            VARCHAR(255) NOT NULL,
  name_local      VARCHAR(255),                         -- Regional language
  description     TEXT,
  image_url       TEXT,
  category        VARCHAR(100),
  brand           VARCHAR(100),
  -- Pricing (server-authoritative — never trust client)
  base_price      NUMERIC(10,2) NOT NULL CHECK (base_price >= 0),
  mrp             NUMERIC(10,2),
  cost_price      NUMERIC(10,2),                        -- For margin calculation
  -- Tax
  hsn_code        VARCHAR(10),
  gst_rate        NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (gst_rate IN (0, 5, 12, 18, 28)),
  -- Unit
  unit_type       VARCHAR(20)  NOT NULL DEFAULT 'piece'
                  CHECK (unit_type IN ('piece','kg','gram','litre','ml','dozen','box')),
  is_loose        BOOLEAN      NOT NULL DEFAULT FALSE,  -- Requires weight/qty input
  is_price_locked BOOLEAN      NOT NULL DEFAULT TRUE,   -- Cashier CANNOT edit
  -- Stock
  stock_qty       NUMERIC(12,3) NOT NULL DEFAULT 0,
  low_stock_at    NUMERIC(12,3) NOT NULL DEFAULT 0,
  -- State
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by      UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX products_store_id ON products(store_id);
CREATE INDEX products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_plu ON products(store_id, plu_code) WHERE plu_code IS NOT NULL;
CREATE INDEX products_name_trgm ON products USING GIN(name gin_trgm_ops);

CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- Volume-Based Auto Discount Rules (Admin-only write)
CREATE TABLE volume_discount_rules (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id      UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty         NUMERIC(10,3) NOT NULL CHECK (min_qty > 0),
  effective_price NUMERIC(10,2) NOT NULL CHECK (effective_price >= 0),
  discount_pct    NUMERIC(5,2)  GENERATED ALWAYS AS (
    ROUND(((1 - effective_price / NULLIF(
      (SELECT base_price FROM products WHERE id = product_id), 0
    )) * 100), 2)
  ) STORED,
  label           VARCHAR(80),
  valid_from      DATE,
  valid_to        DATE,
  created_by      UUID         NOT NULL REFERENCES users(id),
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_valid_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX vdr_product_id ON volume_discount_rules(product_id, is_active);

COMMIT;
