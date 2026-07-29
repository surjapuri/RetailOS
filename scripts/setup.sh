#!/bin/bash
# ═══════════════════════════════════════════════════════════
# RetailOS — First-Time Setup Script
# Run: chmod +x scripts/setup.sh && ./scripts/setup.sh
# ═══════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${BLUE}[RetailOS]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

log "RetailOS Setup — Starting..."

# Check prerequisites
command -v docker      >/dev/null 2>&1 || err "Docker not installed. Install from https://docs.docker.com/get-docker/"
command -v docker-compose >/dev/null 2>&1 || err "Docker Compose not installed."
command -v node        >/dev/null 2>&1 || warn "Node.js not installed (needed for local dev only)"
command -v flutter     >/dev/null 2>&1 || warn "Flutter SDK not found (needed to build mobile app)"

ok "Prerequisites checked"

# Copy env file
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from template. FILL IN ALL VALUES before continuing."
  warn "Edit .env with your actual credentials, then run this script again."
  exit 0
fi

# Validate critical env vars
source .env
[ -z "${DB_PASSWORD:-}" ]             && err "DB_PASSWORD not set in .env"
[ -z "${REDIS_PASSWORD:-}" ]          && err "REDIS_PASSWORD not set in .env"
[ -z "${JWT_ACCESS_SECRET:-}" ]       && err "JWT_ACCESS_SECRET not set in .env"
[ -z "${ENCRYPTION_KEY:-}" ]          && err "ENCRYPTION_KEY not set in .env"
[ "${DB_PASSWORD}" = "CHANGE_ME_STRONG_PASSWORD_32CHARS" ] && err "Change DB_PASSWORD from default value"

ok "Environment variables validated"

# Generate secrets hint
log "Generating secure secret suggestions..."
echo ""
echo "  Suggested secrets (copy into .env):"
echo "  JWT_ACCESS_SECRET=$(openssl rand -hex 64)"
echo "  JWT_REFRESH_SECRET=$(openssl rand -hex 64)"
echo "  JWT_SUPER_ADMIN_SECRET=$(openssl rand -hex 64)"
echo "  ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo ""

# Pull images
log "Pulling Docker images..."
docker-compose pull

# Start infrastructure
log "Starting PostgreSQL and Redis..."
docker-compose up -d postgres redis
sleep 8

# Wait for PostgreSQL
log "Waiting for PostgreSQL to be ready..."
until docker-compose exec -T postgres pg_isready -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" > /dev/null 2>&1; do
  echo -n "."; sleep 2
done
ok "PostgreSQL ready"

# Run migrations
log "Running database migrations..."
docker-compose exec -T postgres psql -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" < backend/database/migrations/001_core_schema.sql
docker-compose exec -T postgres psql -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" < backend/database/migrations/002_sales_inventory_crm.sql
docker-compose exec -T postgres psql -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" < backend/database/migrations/003_geo_audit_monetisation.sql
ok "All migrations applied"

# Start all services
log "Starting all RetailOS services..."
docker-compose up -d
sleep 5

# Health check
log "Checking service health..."
sleep 5
if curl -sf http://localhost:4000/health > /dev/null; then
  ok "Node.js API healthy at http://localhost:4000"
else
  warn "Node.js API not responding yet. Check: docker-compose logs node-api"
fi

if curl -sf http://localhost:8000/health > /dev/null; then
  ok "Python API healthy at http://localhost:8000"
else
  warn "Python API not responding yet. Check: docker-compose logs python-api"
fi

# Create Super Admin (first time only)
log "Creating initial Super Admin account..."
echo ""
read -p "  Super Admin Email: " SA_EMAIL
read -s -p "  Super Admin Password (min 12 chars): " SA_PASS; echo ""
SA_HASH=$(docker-compose exec -T python-api python3 -c "from passlib.hash import bcrypt; print(bcrypt.hash('$SA_PASS', rounds=12))")
SA_TOTP=$(docker-compose exec -T python-api python3 -c "import pyotp; print(pyotp.random_base32())")
docker-compose exec -T postgres psql -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" -c \
  "INSERT INTO super_admin_users (email, password_hash, totp_secret, allowed_ips) VALUES ('${SA_EMAIL}', '${SA_HASH}', '${SA_TOTP}', ARRAY['0.0.0.0/0']) ON CONFLICT DO NOTHING;"
echo ""
ok "Super Admin created: ${SA_EMAIL}"
warn "TOTP Secret for 2FA: ${SA_TOTP}"
warn "Add this to Google Authenticator NOW. It won't be shown again."

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  RetailOS is LIVE!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  🚀 Node.js API:  http://localhost:4000"
echo "  🐍 Python API:   http://localhost:8000"
echo "  📊 Health:       http://localhost:4000/health"
echo "  🔑 Super Admin:  http://localhost:4000/api/v1/superadmin/login"
echo ""
echo "  Flutter (dev):   cd frontend/retailos_app && flutter run"
echo ""
echo "  Logs:            docker-compose logs -f [service]"
echo "  Stop:            docker-compose down"
echo "  Restart:         docker-compose restart [service]"
echo ""
