# RetailOS — The Kirana Super-App v2.0

> **B2B2C Retail Management & Ad-Network Ecosystem**
> Flutter (Mobile/POS/Web) · Node.js/Express · Python/FastAPI · PostgreSQL/PostGIS · Redis

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FLUTTER CLIENTS                          │
│  Android POS Terminal │ Cashier Mobile │ Admin Web │ Customer PWA│
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS/WSS (Nginx)
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐   ┌─────────▼──────┐   ┌──────────▼──────────┐
│  Node.js API   │   │  Python API    │   │    Socket.io RT     │
│  (Express)     │   │  (FastAPI)     │   │    (bill_paid,      │
│  Port 4000     │   │  Port 8000     │   │     soundbox, etc.) │
│                │   │                │   └─────────────────────┘
│  Auth/RBAC     │   │  B2B Prices    │
│  POS/Billing   │   │  AI Cadence    │
│  Payments      │   │  TrustScores   │
│  CRM/Inbox     │   │  Celery Tasks  │
│  Geo/Ratings   │   └────────────────┘
│  Grievance     │
│  Ads/Admin     │
└───────┬────────┘
        │
┌───────▼────────────────────────────────────────────────────────┐
│                         DATA LAYER                             │
│  PostgreSQL 15 + PostGIS  │  Redis 7  │  AWS S3  │  Firebase  │
│  (RLS enabled, encrypted) │  (6-layer │  (PDFs)  │  (FCM/Auth)│
│                           │   cache)  │          │            │
└────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone and enter
git clone <repo-url> retailos && cd retailos

# 2. Run setup (creates .env, runs migrations, starts services)
./scripts/setup.sh

# 3. Flutter app (dev)
cd frontend/retailos_app && flutter pub get && flutter run
```

## Project Structure

```
retailos/
├── backend/
│   ├── database/migrations/          # 3 SQL migration files (ordered)
│   ├── node-api/                     # Express.js primary API
│   │   └── src/
│   │       ├── app.js                # Entry point
│   │       ├── config/               # DB, Redis, Firebase, Queues
│   │       ├── middleware/           # Auth, Rate limit, Error handler
│   │       ├── modules/              # Feature modules (12 modules)
│   │       │   ├── auth/             # OTP login, JWT, Super Admin
│   │       │   ├── pos/              # PLU, Price engine, Billing, Sync
│   │       │   ├── payments/         # UPI QR, Webhook, Card, Subscription
│   │       │   ├── rbac/             # Roles, Supervisor card/PIN/biometric
│   │       │   ├── crm/              # Customers, Loyalty, Inbox, Broadcast
│   │       │   ├── inventory/        # Products, Batches, Expiry, B2B orders
│   │       │   ├── geo/              # PostGIS discovery, Ratings, TrustScore
│   │       │   ├── khata/            # Digital ledger, Reminders
│   │       │   ├── grievance/        # Ticket system, SLA watchdog
│   │       │   ├── ads/              # CPC/CPM auction, Quality scores
│   │       │   ├── sync/             # Offline bill sync, Catalog sync
│   │       │   └── admin/            # Super Admin panel (TOTP + IP gated)
│   │       ├── socket/               # Socket.io real-time events
│   │       ├── utils/                # JWT, Logger, FCM, AppError
│   │       └── workers/              # BullMQ (Receipts, Loyalty, WA, FCM)
│   └── python-api/                   # FastAPI secondary services
│       ├── app/
│       │   ├── b2b/router.py         # UDAAN/JioMart parallel price fetch
│       │   ├── ai/router.py          # Purchase cadence + reorder nudges
│       │   ├── ads/router.py         # TrustScore nightly recompute
│       │   └── workers/scheduled.py  # Celery Beat daily/nightly jobs
│       └── celery_app.py             # Celery + Beat schedule
├── frontend/retailos_app/            # Flutter app (Mobile/POS/Web)
│   └── lib/
│       ├── core/                     # Theme, Router (GoRouter), API Client
│       ├── features/                 # 10 feature modules
│       │   ├── pos/                  # POS Screen, Cart Provider (Riverpod)
│       │   ├── auth/                 # Login (OTP), Splash
│       │   ├── crm/                  # Customer management
│       │   ├── inbox/                # Native in-app message inbox
│       │   ├── geo/                  # Map discovery (flutter_map + OSM)
│       │   ├── khata/                # Digital Khata ledger
│       │   ├── payments/             # UPI QR, Payment bottom sheet
│       │   ├── inventory/            # Stock management
│       │   ├── grievance/            # Complaint filing
│       │   └── admin/                # Admin dashboard
│       └── shared/                   # Models, Services, Widgets
│           ├── services/             # Auth, Local DB (sqflite), Offline Sync
│           └── models/               # Product, CartItem, etc.
├── docker/                           # Nginx config
├── scripts/                          # setup.sh, db_migrate.sh
├── docker-compose.yml                # Full stack orchestration
└── .env.example                      # All required environment variables
```

## Key Features Implemented

### 🏪 POS Engine
- PLU code lookup (offline-first via SQLite cache)
- **Server-authoritative pricing** — client price always ignored
- Volume-based auto-discount rule engine (cached in Redis)
- GST/CGST/SGST auto-calculation per HSN code
- Offline bill creation → background sync with idempotency keys
- Shift management with cash drawer variance alerting

### 💳 Payments
- Dynamic UPI QR (NPCI standard — no API needed)
- Razorpay webhook with HMAC-SHA256 verification
- Real-time bill-close via Socket.io → Flutter
- Soundbox BLE trigger + flutter_tts fallback
- Pinelabs EDC card terminal integration
- Split payments (Cash + UPI on one bill)

### 🔐 Security & RBAC
- 5-tier role hierarchy, server-enforced on every request
- Supervisor auth: Physical card (HMAC) / Biometric / Rolling TOTP PIN
- Immutable audit tables (void_audit_log, security_event_log) — no DELETE/UPDATE ever
- PostgreSQL Row-Level Security (RLS) enforces store_id isolation at DB level
- JWT RS256 access tokens (15 min) + rotating refresh tokens (7 days)
- Super Admin: isolated auth system + mandatory TOTP 2FA + IP whitelist

### 📱 Native Inbox (replaces WhatsApp dependency)
- Persistent message feed stored in `customer_inbox` table
- 6 message types: receipt, points, offer, khata, reorder, platform_credit
- FCM push notification → opens specific inbox card in app
- WhatsApp as optional parallel channel for Silver/Gold tier

### 🤖 Predictive AI (no heavy ML model)
- Statistical purchase cadence per customer-product pair
- Median inter-purchase interval → predicted next purchase date
- Reorder nudge sent 3 days before predicted date via FCM + Inbox
- Retailer-side demand forecasting feeds B2B procurement suggestions

### ⭐ Ratings & TrustScore
- 1 rating per `sale_id` — prevents fake reviews
- Anti-gaming: ratings within 5 minutes flagged suspicious
- Composite TrustScore: `rating×0.6 + response_rate×0.2 + resolution_speed×0.2`
- Drives organic map ranking (ad-boost modifiers capped at 25%)

### 📢 Ad Network
- B2B ads: Wholesalers → Retailers (B2B map top, price comparison)
- B2C ads: Retailers → Customers (map top, search, inbox push)
- CPC/CPM auction: `rank = bid × quality_score` (CTR-driven)
- Daily budget enforced atomically in Redis (DECR)
- All rates hidden from advertisers — Super Admin sets floor CPC/CPM

### 🛡️ Grievance Redressal
- B2C: Customer vs. Retailer with 48h SLA watchdog
- B2B: Retailer vs. Wholesaler with 72h SLA watchdog
- Auto-escalation on breach → TrustScore penalty
- Super Admin: warnings, suspensions, bans, platform credits
- Platform actions immutably logged

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `DB_PASSWORD` | ✅ | PostgreSQL password |
| `REDIS_PASSWORD` | ✅ | Redis auth password |
| `JWT_ACCESS_SECRET` | ✅ | JWT signing secret (min 64 chars) |
| `JWT_REFRESH_SECRET` | ✅ | Separate refresh token secret |
| `JWT_SUPER_ADMIN_SECRET` | ✅ | Super Admin JWT (isolated) |
| `ENCRYPTION_KEY` | ✅ | AES-256 key for PII fields |
| `RAZORPAY_KEY_ID` | Payments | Razorpay live key |
| `WA_ACCESS_TOKEN` | WhatsApp | Meta API token |
| `FCM_SERVER_KEY` | Push | Firebase Admin key |
| `UDAAN_CLIENT_ID` | B2B | UDAAN partner credentials |
| `AWS_ACCESS_KEY_ID` | Receipts | S3 for PDF storage |

## Database Migrations (run in order)

```bash
# 001 — Core: stores, branches, users, products, volume_discount_rules
# 002 — Sales: POS bills, payments, inventory, customers, CRM, khata, AI cadence
# 003 — Geo: PostGIS, ratings, TrustScore, grievance, audit logs, ads, subscriptions
./scripts/db_migrate.sh
```

## API Endpoints Summary

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/auth/otp/send` | Send OTP to mobile |
| POST | `/api/v1/auth/login` | Login with OTP |
| POST | `/api/v1/auth/register` | Register new store |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| POST | `/api/v1/auth/superadmin/login` | Super Admin login (TOTP) |

### POS
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/pos/products/lookup` | PLU / barcode / text search |
| POST | `/api/v1/pos/line-item/preview` | Server-compute price + discount |
| POST | `/api/v1/pos/bills` | Create bill (price enforced server-side) |
| POST | `/api/v1/pos/bills/:id/void` | Void bill (supervisor session required) |
| POST | `/api/v1/pos/shifts/open` | Open cashier shift |
| POST | `/api/v1/pos/shifts/:id/close` | Close shift with reconciliation |
| POST | `/api/v1/sync/bills` | Offline bill batch sync |
| GET | `/api/v1/sync/catalog` | Download product catalog + rules |

### Payments
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/payments/upi-qr/:saleId` | Generate UPI QR for bill |
| POST | `/api/v1/payments/record` | Record cash/khata payment |
| POST | `/webhooks/razorpay` | Razorpay webhook (HMAC verified) |

### RBAC
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/rbac/supervisor/request` | Request supervisor (sends FCM PIN) |
| POST | `/api/v1/rbac/supervisor/validate/card` | Validate barcode card scan |
| POST | `/api/v1/rbac/supervisor/validate/pin` | Validate rolling TOTP PIN |
| POST | `/api/v1/rbac/employees` | Create employee (Admin only) |
| POST | `/api/v1/rbac/employees/:id/supervisor-card` | Issue supervisor card |

### CRM & Inbox
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/crm/customers/lookup` | Find or create customer at checkout |
| GET | `/api/v1/crm/customers/:id/inbox` | Get native inbox messages |
| POST | `/api/v1/crm/customers/:id/points/redeem` | Redeem loyalty points |
| POST | `/api/v1/crm/broadcast` | Send campaign (Gold tier) |

### Geo & Discovery
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/geo/discover` | PostGIS radius store search |
| GET | `/api/v1/geo/offers` | Nearby live offers |
| POST | `/api/v1/geo/store/:id/rate` | Submit rating (sale_id required) |

### Khata & Grievance
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/khata/customers/:id/statement` | Khata ledger statement |
| POST | `/api/v1/khata/customers/:id/pay` | Record Khata payment |
| POST | `/api/v1/grievance` | File complaint ticket |
| POST | `/api/v1/grievance/:id/messages` | Add message to ticket thread |

### Super Admin (TOTP + IP gated)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/superadmin/dashboard` | Platform metrics |
| PATCH | `/api/v1/superadmin/tiers/:tier` | Update SaaS tier config |
| PATCH | `/api/v1/superadmin/ad-rates/:placement` | Set floor CPC/CPM |
| POST | `/api/v1/superadmin/campaigns/:id/approve` | Approve ad creative |
| POST | `/api/v1/superadmin/stores/:id/suspend` | Suspend store |
| POST | `/api/v1/superadmin/customers/:id/credit` | Issue platform credit |

### Python API (B2B + AI)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/b2b/compare-prices` | Parallel UDAAN + JioMart price fetch |
| POST | `/api/v1/b2b/orders` | Place B2B purchase order |
| GET | `/api/v1/ai/nudges/pending` | Get pending reorder nudges |
| POST | `/api/v1/ai/cadence/compute/:store_id` | Trigger cadence recompute |
| GET | `/api/v1/ads/trust-scores/recompute/:store_id` | Recompute TrustScore |

## License

MIT — For educational and commercial use. API keys and secrets must never be committed to version control.
