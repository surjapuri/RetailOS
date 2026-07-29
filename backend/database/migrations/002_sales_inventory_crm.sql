-- ═══════════════════════════════════════════════════════════════
-- RetailOS Database Migration 002 — Sales, Payments, Inventory,
--                                   Customers, CRM
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- SALES & POS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE shifts (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID         NOT NULL REFERENCES branches(id),
  cashier_id     UUID         NOT NULL REFERENCES users(id),
  terminal_id    VARCHAR(100),
  opening_cash   NUMERIC(12,2) NOT NULL CHECK (opening_cash >= 0),
  closing_cash   NUMERIC(12,2) CHECK (closing_cash >= 0),
  expected_cash  NUMERIC(12,2),
  cash_variance  NUMERIC(12,2),    -- negative = short
  total_sales    NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_refunds  NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_voids    NUMERIC(14,2) NOT NULL DEFAULT 0,
  cash_sales     NUMERIC(14,2) NOT NULL DEFAULT 0,
  upi_sales      NUMERIC(14,2) NOT NULL DEFAULT 0,
  card_sales     NUMERIC(14,2) NOT NULL DEFAULT 0,
  status         VARCHAR(10)   NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','closed')),
  notes          TEXT,
  started_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX shifts_branch_id ON shifts(branch_id, status);

CREATE TABLE sales (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  VARCHAR(30)  UNIQUE NOT NULL,       -- INV-2024-000001
  store_id        UUID         NOT NULL REFERENCES stores(id),
  branch_id       UUID         NOT NULL REFERENCES branches(id),
  cashier_id      UUID         REFERENCES users(id),
  shift_id        UUID         REFERENCES shifts(id),
  customer_id     UUID,                               -- FK added after customers table
  -- Amounts
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  taxable_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  cgst_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  sgst_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  igst_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Type & status
  bill_type       VARCHAR(10)   NOT NULL DEFAULT 'sale'
                  CHECK (bill_type IN ('sale','return','void')),
  payment_status  VARCHAR(20)   NOT NULL DEFAULT 'pending'
                  CHECK (payment_status IN ('pending','paid','partial','refunded')),
  -- GST
  is_gst_bill     BOOLEAN       NOT NULL DEFAULT FALSE,
  buyer_gstin     VARCHAR(16),                        -- For B2B GST invoices
  place_of_supply VARCHAR(2),                         -- State code
  irn             TEXT,                               -- E-invoice IRN
  irn_ack_no      TEXT,
  -- Offline sync
  sync_status     VARCHAR(20)   NOT NULL DEFAULT 'synced'
                  CHECK (sync_status IN ('pending','synced','failed')),
  device_id       VARCHAR(100),
  offline_at      TIMESTAMPTZ,
  -- Discount tracking
  discount_reason TEXT,
  discount_approved_by UUID     REFERENCES users(id),
  -- Reference (for returns)
  original_sale_id UUID         REFERENCES sales(id),
  notes           TEXT,
  billed_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX sales_store_id ON sales(store_id, billed_at DESC);
CREATE INDEX sales_customer_id ON sales(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_shift_id ON sales(shift_id);
CREATE INDEX sales_sync_status ON sales(sync_status) WHERE sync_status = 'pending';

CREATE TABLE sale_items (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             UUID         NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id          UUID         REFERENCES products(id),
  product_name        VARCHAR(255) NOT NULL,           -- snapshot at time of sale
  product_barcode     VARCHAR(64),
  hsn_code            VARCHAR(10),
  quantity            NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  unit_type           VARCHAR(20),
  base_price_snapshot NUMERIC(10,2) NOT NULL,          -- server price at time of sale
  effective_price     NUMERIC(10,2) NOT NULL,           -- after volume discount
  applied_rule_id     UUID         REFERENCES volume_discount_rules(id),
  gst_rate            NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  line_total          NUMERIC(12,2) NOT NULL,           -- effective_price * qty
  is_voided           BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX sale_items_sale_id ON sale_items(sale_id);

-- ─────────────────────────────────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────────────────────────────────

CREATE TABLE payments (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id           UUID         NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  store_id          UUID         NOT NULL REFERENCES stores(id),
  method            VARCHAR(20)  NOT NULL
                    CHECK (method IN ('cash','upi','card','khata','platform_credit')),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status            VARCHAR(20)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','failed','refunded')),
  -- Gateway
  gateway           VARCHAR(30)   CHECK (gateway IN ('razorpay','cashfree','payu')),
  gateway_txn_id    TEXT,
  gateway_order_id  TEXT,
  -- UPI specific
  upi_vpa_merchant  VARCHAR(100),
  upi_vpa_payer     VARCHAR(100),
  upi_rrn           VARCHAR(50),                       -- NPCI reference
  -- Card specific (only masked data — PCI-DSS)
  card_last4        CHAR(4),
  card_scheme       VARCHAR(20),                       -- visa|mastercard|rupay|amex
  card_type         VARCHAR(10),                       -- credit|debit|prepaid
  edc_terminal_id   VARCHAR(30),
  edc_approval_code VARCHAR(30),
  -- Audit
  soundbox_ack      BOOLEAN       NOT NULL DEFAULT FALSE,
  webhook_raw       JSONB,                             -- Raw webhook payload
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX payments_sale_id ON payments(sale_id);
CREATE INDEX payments_gateway_txn ON payments(gateway_txn_id) WHERE gateway_txn_id IS NOT NULL;

-- Pending offline sync queue
CREATE TABLE pending_sync_queue (
  id                  UUID         PRIMARY KEY,         -- Client-generated (idempotency key)
  store_id            UUID         NOT NULL REFERENCES stores(id),
  branch_id           UUID         NOT NULL REFERENCES branches(id),
  device_id           VARCHAR(100) NOT NULL,
  payload             JSONB        NOT NULL,
  sync_status         VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (sync_status IN ('pending','synced','failed','duplicate')),
  retry_count         SMALLINT     NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_offline_at  TIMESTAMPTZ  NOT NULL,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX psq_status ON pending_sync_queue(sync_status, store_id)
  WHERE sync_status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- INVENTORY
-- ─────────────────────────────────────────────────────────────

CREATE TABLE suppliers (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  contact     VARCHAR(15),
  gstin       VARCHAR(16),
  platform    VARCHAR(30)  DEFAULT 'local'
              CHECK (platform IN ('local','udaan','jiomart','kirana_king','manual')),
  address     TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_batches (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id        UUID         NOT NULL REFERENCES stores(id),
  batch_number    VARCHAR(50),
  qty_received    NUMERIC(12,3) NOT NULL CHECK (qty_received > 0),
  qty_remaining   NUMERIC(12,3) NOT NULL CHECK (qty_remaining >= 0),
  purchase_price  NUMERIC(10,2),
  selling_price_override NUMERIC(10,2),               -- Batch-specific price if needed
  mfg_date        DATE,
  expiry_date     DATE,
  supplier_id     UUID         REFERENCES suppliers(id),
  po_id           UUID,                               -- FK added after purchase_orders
  alert_sent_7d   BOOLEAN      NOT NULL DEFAULT FALSE,
  alert_sent_15d  BOOLEAN      NOT NULL DEFAULT FALSE,
  alert_sent_30d  BOOLEAN      NOT NULL DEFAULT FALSE,
  received_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_expiry CHECK (expiry_date IS NULL OR expiry_date > mfg_date)
);

CREATE INDEX inv_batches_product ON inventory_batches(product_id, expiry_date ASC NULLS LAST);
CREATE INDEX inv_batches_expiry ON inventory_batches(expiry_date) WHERE qty_remaining > 0;

CREATE TABLE purchase_orders (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID         NOT NULL REFERENCES stores(id),
  branch_id         UUID         REFERENCES branches(id),
  platform          VARCHAR(30)  NOT NULL DEFAULT 'manual'
                    CHECK (platform IN ('udaan','jiomart','kirana_king','local','manual')),
  platform_order_id TEXT         UNIQUE,
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','submitted','confirmed','dispatched',
                                      'delivered','cancelled','disputed')),
  items             JSONB        NOT NULL DEFAULT '[]', -- [{product_id, name, qty, unit_price}]
  total_amount      NUMERIC(12,2),
  tax_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_charges  NUMERIC(10,2) NOT NULL DEFAULT 0,
  grand_total       NUMERIC(12,2),
  ordered_by        UUID         REFERENCES users(id),
  supplier_id       UUID         REFERENCES suppliers(id),
  expected_at       DATE,
  delivered_at      TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE inventory_batches
  ADD CONSTRAINT fk_batch_po FOREIGN KEY (po_id) REFERENCES purchase_orders(id);

CREATE TABLE stock_alerts (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID         NOT NULL REFERENCES products(id),
  store_id      UUID         NOT NULL REFERENCES stores(id),
  alert_type    VARCHAR(20)  NOT NULL
                CHECK (alert_type IN ('low_stock','expiry_7d','expiry_15d','expiry_30d')),
  current_qty   NUMERIC(12,3),
  expiry_date   DATE,
  batch_id      UUID         REFERENCES inventory_batches(id),
  is_acknowledged BOOLEAN    NOT NULL DEFAULT FALSE,
  ack_by        UUID         REFERENCES users(id),
  ack_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- CUSTOMERS & CRM
-- ─────────────────────────────────────────────────────────────

CREATE TABLE customers (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  mobile            VARCHAR(15)  NOT NULL,
  name              VARCHAR(100),
  dob               DATE,
  -- DPDP Compliance
  dpdp_consent      BOOLEAN      NOT NULL DEFAULT FALSE,
  consent_given_at  TIMESTAMPTZ,
  preferred_channel VARCHAR(20)  NOT NULL DEFAULT 'inbox'
                    CHECK (preferred_channel IN ('inbox','whatsapp','sms','none')),
  -- Financials
  khata_balance     NUMERIC(12,2) NOT NULL DEFAULT 0,  -- Running credit balance
  platform_credit   NUMERIC(10,2) NOT NULL DEFAULT 0,  -- Super Admin issued credit
  total_spend       NUMERIC(14,2) NOT NULL DEFAULT 0,
  visit_count       INTEGER       NOT NULL DEFAULT 0,
  -- Customer tier
  customer_tier     VARCHAR(20)   NOT NULL DEFAULT 'regular'
                    CHECK (customer_tier IN ('regular','silver','gold','platinum')),
  -- Notifications
  fcm_token         TEXT,
  -- State
  is_blocked        BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, mobile)
);

CREATE INDEX customers_store_id ON customers(store_id);
CREATE INDEX customers_mobile ON customers(mobile);

CREATE TRIGGER set_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- Add FK from sales to customers (now that customers table exists)
ALTER TABLE sales ADD CONSTRAINT fk_sale_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id);

-- DPDP consent audit log — IMMUTABLE
CREATE TABLE dpdp_consent_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID         NOT NULL REFERENCES customers(id),
  action       VARCHAR(20)  NOT NULL
               CHECK (action IN ('consent_given','opt_out','re_consent','data_deletion_request')),
  consented_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip_address   INET,
  device_id    VARCHAR(100),
  cashier_id   UUID         REFERENCES users(id)
  -- NO UPDATE, NO DELETE
);

-- Loyalty rules
CREATE TABLE loyalty_rules (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID         NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  earn_per_rupee    NUMERIC(8,4) NOT NULL DEFAULT 0.02,   -- Points per ₹1
  rupees_per_point  NUMERIC(8,4) NOT NULL DEFAULT 0.10,   -- ₹ per redeemed point
  min_bill_for_earn NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_redeem_pct    NUMERIC(5,2)  NOT NULL DEFAULT 20,    -- Max 20% of bill
  min_redeem_points INTEGER       NOT NULL DEFAULT 100,
  birthday_bonus    INTEGER       NOT NULL DEFAULT 50,
  weekend_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Loyalty transaction ledger (points are computed as SUM — no mutable balance)
CREATE TABLE loyalty_transactions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id     UUID         NOT NULL REFERENCES stores(id),
  sale_id      UUID         REFERENCES sales(id),
  type         VARCHAR(10)  NOT NULL
               CHECK (type IN ('earn','redeem','expire','bonus','platform_credit')),
  points       INTEGER      NOT NULL,                    -- negative for redeem/expire
  description  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX lt_customer_id ON loyalty_transactions(customer_id, created_at DESC);

-- Native In-App Inbox
CREATE TABLE customer_inbox (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  store_id     UUID         NOT NULL REFERENCES stores(id),
  msg_type     VARCHAR(20)  NOT NULL
               CHECK (msg_type IN ('receipt','points','offer','khata','reorder',
                                   'broadcast','grievance_update','platform_credit')),
  title        VARCHAR(200) NOT NULL,
  body         TEXT         NOT NULL,
  action_url   TEXT,                                    -- PDF link, deep-link, etc.
  metadata     JSONB        NOT NULL DEFAULT '{}',      -- {amount, points, offer_id, ...}
  is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
  read_at      TIMESTAMPTZ,
  channel_sent TEXT[]       NOT NULL DEFAULT ARRAY['inbox'],
  expires_at   TIMESTAMPTZ,                             -- NULL = never expires
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX inbox_customer_id ON customer_inbox(customer_id, is_read, created_at DESC);

-- Khata (Digital Ledger) Transactions
CREATE TABLE khata_transactions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID         NOT NULL REFERENCES customers(id),
  store_id      UUID         NOT NULL REFERENCES stores(id),
  sale_id       UUID         REFERENCES sales(id),      -- NULL for direct payment
  type          VARCHAR(10)  NOT NULL CHECK (type IN ('debit','credit')),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(12,2) NOT NULL,                 -- Running balance snapshot
  notes         TEXT,
  collected_by  UUID         REFERENCES users(id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX khata_customer ON khata_transactions(customer_id, created_at DESC);

-- Khata reminder log
CREATE TABLE khata_reminders (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID         NOT NULL REFERENCES customers(id),
  store_id        UUID         NOT NULL REFERENCES stores(id),
  balance_at_send NUMERIC(12,2) NOT NULL,
  channel         VARCHAR(20)  NOT NULL,
  was_opened      BOOLEAN      NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Predictive AI — purchase cadence
CREATE TABLE purchase_cadence (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             UUID         NOT NULL REFERENCES customers(id),
  product_id              UUID         NOT NULL REFERENCES products(id),
  store_id                UUID         NOT NULL REFERENCES stores(id),
  data_points             INTEGER      NOT NULL DEFAULT 0,
  median_interval_days    NUMERIC(6,2),
  avg_qty_per_purchase    NUMERIC(10,3),
  last_purchase_at        TIMESTAMPTZ,
  next_predicted_at       TIMESTAMPTZ,
  nudge_sent_at           TIMESTAMPTZ,
  consecutive_dismissals  INTEGER      NOT NULL DEFAULT 0,
  is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
  computed_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(customer_id, product_id, store_id)
);

COMMIT;
