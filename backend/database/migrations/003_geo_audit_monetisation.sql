-- ═══════════════════════════════════════════════════════════════
-- RetailOS Database Migration 003 — Geo, Ratings, Grievance,
--                                   Audit Trails, Monetisation,
--                                   Ads, API Usage
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- GEO DISCOVERY & STORE OFFERS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE store_offers (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id       UUID         NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id      UUID         REFERENCES products(id),
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  offer_price     NUMERIC(10,2),
  original_price  NUMERIC(10,2),
  discount_pct    NUMERIC(5,2),
  image_url       TEXT,
  is_boosted      BOOLEAN      NOT NULL DEFAULT FALSE,
  ad_campaign_id  UUID,                               -- FK after ad_campaigns table
  starts_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ends_at         TIMESTAMPTZ,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  views           INTEGER      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_offer_price CHECK (offer_price IS NULL OR offer_price >= 0)
);

CREATE INDEX offers_branch ON store_offers(branch_id, is_active, ends_at);

-- ─────────────────────────────────────────────────────────────
-- RATINGS & TRUST SCORES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE store_ratings (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id    UUID         NOT NULL REFERENCES customers(id),
  sale_id        UUID         NOT NULL UNIQUE REFERENCES sales(id), -- 1 rating per sale
  rating         SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text    TEXT,
  -- Anti-gaming flags
  is_suspicious  BOOLEAN      NOT NULL DEFAULT FALSE,  -- <5 min post-purchase
  is_verified    BOOLEAN      NOT NULL DEFAULT TRUE,   -- has linked sale_id
  is_hidden      BOOLEAN      NOT NULL DEFAULT FALSE,  -- hidden by Super Admin
  submitted_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  purchase_at    TIMESTAMPTZ  NOT NULL                 -- sale.billed_at (for velocity check)
);

CREATE INDEX ratings_store ON store_ratings(store_id, is_hidden);

CREATE TABLE store_trust_scores (
  store_id          UUID         PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  avg_rating        NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_ratings     INTEGER      NOT NULL DEFAULT 0,
  response_rate     NUMERIC(5,2) NOT NULL DEFAULT 100,  -- % grievances responded to
  resolution_speed  NUMERIC(6,2) NOT NULL DEFAULT 0,    -- avg hours to resolve
  trust_score       NUMERIC(4,2) NOT NULL DEFAULT 5.00, -- composite 0–5
  score_status      VARCHAR(20)  NOT NULL DEFAULT 'good'
                    CHECK (score_status IN ('good','low','review_flag','suspended')),
  last_computed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default trust scores when stores are created
CREATE OR REPLACE FUNCTION init_trust_score()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO store_trust_scores (store_id) VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER init_store_trust_score
  AFTER INSERT ON stores
  FOR EACH ROW EXECUTE FUNCTION init_trust_score();

-- ─────────────────────────────────────────────────────────────
-- GRIEVANCE REDRESSAL
-- ─────────────────────────────────────────────────────────────

CREATE TABLE grievance_tickets (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number    VARCHAR(20)  UNIQUE NOT NULL,         -- GR-2024-000001
  type             VARCHAR(10)  NOT NULL CHECK (type IN ('b2c','b2b')),
  -- Complainant: customer_id (b2c) or store_id (b2b retailer)
  complainant_id   UUID         NOT NULL,
  complainant_type VARCHAR(20)  NOT NULL CHECK (complainant_type IN ('customer','retailer')),
  -- Respondent: store_id (b2c) or supplier store_id (b2b)
  respondent_id    UUID         NOT NULL,
  respondent_type  VARCHAR(20)  NOT NULL CHECK (respondent_type IN ('retailer','wholesaler')),
  -- Evidence
  category         VARCHAR(60)  NOT NULL,
  description      TEXT         NOT NULL,
  evidence_urls    TEXT[]       NOT NULL DEFAULT '{}',
  sale_id          UUID         REFERENCES sales(id),
  po_id            UUID         REFERENCES purchase_orders(id),
  -- Status & SLA
  status           VARCHAR(20)  NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','responded','escalated',
                                     'resolved','closed','fraud_confirmed')),
  severity         VARCHAR(10)  NOT NULL DEFAULT 'medium'
                   CHECK (severity IN ('low','medium','high','fraud')),
  sla_deadline     TIMESTAMPTZ  NOT NULL,
  escalated_at     TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT,
  -- Super Admin
  reviewed_by      UUID         REFERENCES super_admin_users(id),
  admin_notes      TEXT,
  -- Meta
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX grievance_status ON grievance_tickets(status, sla_deadline);
CREATE INDEX grievance_respondent ON grievance_tickets(respondent_id, status);

CREATE SEQUENCE grievance_seq;
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS TEXT AS $$
BEGIN
  RETURN 'GR-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
         LPAD(NEXTVAL('grievance_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

CREATE TABLE grievance_messages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID         NOT NULL REFERENCES grievance_tickets(id) ON DELETE CASCADE,
  author_id    UUID         NOT NULL,
  author_type  VARCHAR(20)  NOT NULL
               CHECK (author_type IN ('customer','retailer','wholesaler','super_admin')),
  message      TEXT         NOT NULL,
  attachments  TEXT[]       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- IMMUTABLE AUDIT TRAILS
-- ─────────────────────────────────────────────────────────────

-- Void audit log — append-only, no DELETE, no UPDATE for any role
CREATE TABLE void_audit_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  original_sale_id UUID         NOT NULL REFERENCES sales(id),
  store_id         UUID         NOT NULL REFERENCES stores(id),
  branch_id        UUID         NOT NULL REFERENCES branches(id),
  cashier_id       UUID         NOT NULL REFERENCES users(id),
  supervisor_id    UUID         NOT NULL REFERENCES users(id),
  auth_method_used VARCHAR(20)  NOT NULL
                   CHECK (auth_method_used IN ('card','biometric','rolling_pin')),
  void_reason      VARCHAR(200) NOT NULL,
  void_amount      NUMERIC(10,2) NOT NULL,
  voided_items     JSONB        NOT NULL DEFAULT '[]',
  shift_id         UUID         REFERENCES shifts(id),
  device_id        VARCHAR(100),
  ip_address       INET,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Security event log — append-only
CREATE TABLE security_event_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID         REFERENCES stores(id),
  user_id     UUID         REFERENCES users(id),
  event_type  VARCHAR(60)  NOT NULL,
  -- PRICE_TAMPER | VOID | DISCOUNT_OVERRIDE | CASH_ANOMALY
  -- SUPERVISOR_AUTH_FAIL | RATE_LIMIT_HIT | UNKNOWN_DEVICE
  severity    VARCHAR(10)  NOT NULL DEFAULT 'info'
              CHECK (severity IN ('info','warning','critical')),
  shift_id    UUID         REFERENCES shifts(id),
  meta        JSONB        NOT NULL DEFAULT '{}',
  device_id   VARCHAR(100),
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX sec_log_store ON security_event_log(store_id, created_at DESC);
CREATE INDEX sec_log_event_type ON security_event_log(event_type, created_at DESC);

-- Platform actions log — Super Admin actions (append-only)
CREATE TABLE platform_actions_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  super_admin_id   UUID         NOT NULL REFERENCES super_admin_users(id),
  action_type      VARCHAR(30)  NOT NULL
                   CHECK (action_type IN ('warning','suspend','ban','unsuspend',
                                          'platform_credit','tier_change',
                                          'ad_approve','ad_reject','ad_pause')),
  target_type      VARCHAR(20)  NOT NULL CHECK (target_type IN ('store','customer','campaign')),
  target_id        UUID         NOT NULL,
  ticket_id        UUID         REFERENCES grievance_tickets(id),
  reason           TEXT,
  credit_amount    NUMERIC(10,2),
  suspension_days  INTEGER,
  meta             JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  -- NO DELETE, NO UPDATE — immutable
);

-- Store suspensions
CREATE TABLE store_suspensions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID         NOT NULL REFERENCES stores(id),
  reason          TEXT         NOT NULL,
  suspension_type VARCHAR(10)  NOT NULL CHECK (suspension_type IN ('temporary','permanent')),
  suspended_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  suspended_until TIMESTAMPTZ,                          -- NULL = permanent
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  lifted_by       UUID         REFERENCES super_admin_users(id),
  lifted_at       TIMESTAMPTZ,
  action_log_id   UUID         NOT NULL REFERENCES platform_actions_log(id)
);

-- ─────────────────────────────────────────────────────────────
-- MONETISATION — SUBSCRIPTIONS & ADS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE subscriptions (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id              UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  tier                  VARCHAR(10)  NOT NULL REFERENCES tier_config(tier),
  status                VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','past_due','cancelled','expired')),
  current_period_start  DATE         NOT NULL,
  current_period_end    DATE         NOT NULL,
  amount_paid           NUMERIC(10,2) NOT NULL,
  gateway               VARCHAR(20)  NOT NULL DEFAULT 'razorpay',
  gateway_sub_id        TEXT         UNIQUE,            -- Razorpay subscription ID
  gateway_plan_id       TEXT,
  failed_payments       SMALLINT     NOT NULL DEFAULT 0,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX subs_store ON subscriptions(store_id, status);

-- Ad rate config (Super Admin only — cached in Redis)
CREATE TABLE ad_rate_config (
  placement     VARCHAR(40)   PRIMARY KEY,
  -- map_top | search_suggest | inbox_push | b2b_map_top | b2b_search
  floor_cpc     NUMERIC(8,4)  NOT NULL DEFAULT 1.0000,
  floor_cpm     NUMERIC(8,4)  NOT NULL DEFAULT 10.0000,
  description   VARCHAR(100),
  updated_by    UUID          REFERENCES super_admin_users(id),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO ad_rate_config (placement, floor_cpc, floor_cpm, description) VALUES
  ('map_top',        2.00, 20.00, 'Top pin on customer map search'),
  ('search_suggest', 1.50, 15.00, 'Search autocomplete suggestion'),
  ('inbox_push',     0.50, 5.00,  'Push notification to customer inbox'),
  ('b2b_map_top',    3.00, 25.00, 'Top pin on retailer B2B map'),
  ('b2b_search',     2.00, 18.00, 'B2B price comparison sponsored card');

CREATE TABLE ad_campaigns (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  campaign_name       VARCHAR(150) NOT NULL,
  campaign_type       VARCHAR(20)  NOT NULL
                      CHECK (campaign_type IN ('b2c_retail','b2b_wholesale')),
  placement           VARCHAR(40)  NOT NULL REFERENCES ad_rate_config(placement),
  -- Targeting
  target_lat          NUMERIC(10,8),
  target_lng          NUMERIC(11,8),
  target_radius_km    NUMERIC(5,2)  NOT NULL DEFAULT 5.0,
  target_categories   TEXT[],
  -- Budget & bidding
  daily_budget        NUMERIC(10,2) NOT NULL CHECK (daily_budget >= 100),
  total_budget        NUMERIC(12,2),
  bid_amount          NUMERIC(8,4)  NOT NULL,
  bid_type            VARCHAR(5)    NOT NULL DEFAULT 'cpc' CHECK (bid_type IN ('cpc','cpm')),
  -- Creative
  headline            VARCHAR(80)   NOT NULL,
  description         VARCHAR(150),
  image_url           TEXT,
  cta_text            VARCHAR(30),
  cta_url             TEXT,
  -- Performance
  quality_score       NUMERIC(5,4)  NOT NULL DEFAULT 1.0000,
  impressions         BIGINT        NOT NULL DEFAULT 0,
  clicks              BIGINT        NOT NULL DEFAULT 0,
  spend_to_date       NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Status
  status              VARCHAR(30)   NOT NULL DEFAULT 'pending_approval'
                      CHECK (status IN ('pending_approval','active','paused',
                                        'budget_exhausted','rejected','completed')),
  approved_by         UUID          REFERENCES super_admin_users(id),
  approved_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  starts_at           DATE          NOT NULL,
  ends_at             DATE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX campaigns_store ON ad_campaigns(store_id, status);
CREATE INDEX campaigns_active ON ad_campaigns(status, placement, starts_at, ends_at)
  WHERE status = 'active';

ALTER TABLE store_offers
  ADD CONSTRAINT fk_offer_campaign
  FOREIGN KEY (ad_campaign_id) REFERENCES ad_campaigns(id);

-- Ad impressions & clicks (time-series — written via Redis stream batch)
CREATE TABLE ad_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID         NOT NULL REFERENCES ad_campaigns(id),
  event_type   VARCHAR(10)  NOT NULL CHECK (event_type IN ('impression','click')),
  viewer_type  VARCHAR(20)  NOT NULL CHECK (viewer_type IN ('customer','retailer')),
  viewer_id    UUID,
  lat          NUMERIC(10,8),
  lng          NUMERIC(11,8),
  charge       NUMERIC(8,4) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Partitions (monthly — create via migration or cron)
CREATE TABLE ad_events_2024_01 PARTITION OF ad_events
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE ad_events_2024_default PARTITION OF ad_events DEFAULT;

-- ─────────────────────────────────────────────────────────────
-- API USAGE TRACKING (rate limit management)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE api_usage_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID         REFERENCES stores(id),
  api_name     VARCHAR(60)  NOT NULL,
  endpoint     VARCHAR(200),
  call_count   INTEGER      NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ  NOT NULL,
  window_end   TIMESTAMPTZ  NOT NULL,
  cached_hit   BOOLEAN      NOT NULL DEFAULT FALSE,
  error_count  INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX api_usage_store ON api_usage_log(store_id, api_name, window_start DESC);

-- ─────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY (RLS) — Database-level store isolation
-- ─────────────────────────────────────────────────────────────

-- Enable RLS on all store-scoped tables
ALTER TABLE products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_offers       ENABLE ROW LEVEL SECURITY;

-- App user sees only their store's rows
-- (JWT store_id is set as session variable by middleware)
CREATE POLICY store_isolation ON products
  USING (store_id = current_setting('app.current_store_id', TRUE)::UUID);

CREATE POLICY store_isolation ON sales
  USING (store_id = current_setting('app.current_store_id', TRUE)::UUID);

CREATE POLICY store_isolation ON customers
  USING (store_id = current_setting('app.current_store_id', TRUE)::UUID);

CREATE POLICY store_isolation ON inventory_batches
  USING (store_id = current_setting('app.current_store_id', TRUE)::UUID);

-- Super Admin bypasses RLS
CREATE ROLE retailos_app;
CREATE ROLE retailos_superadmin BYPASSRLS;
GRANT ALL ON ALL TABLES IN SCHEMA public TO retailos_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO retailos_superadmin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO retailos_app;

-- ─────────────────────────────────────────────────────────────
-- INDEXES FOR COMMON QUERY PATTERNS
-- ─────────────────────────────────────────────────────────────

-- Sales dashboard queries
CREATE INDEX sales_billed_at ON sales(store_id, billed_at DESC, bill_type);
CREATE INDEX sales_payment_status ON sales(store_id, payment_status);

-- Customer search
CREATE INDEX customers_name ON customers(store_id, name);

-- Inventory expiry monitoring
CREATE INDEX inv_expiry_monitor ON inventory_batches(expiry_date, store_id)
  WHERE qty_remaining > 0 AND expiry_date IS NOT NULL;

-- Trust score for map ranking
CREATE INDEX trust_score_ranking ON store_trust_scores(trust_score DESC);

COMMIT;
