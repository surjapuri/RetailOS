#!/bin/bash
# Run or re-run all database migrations
set -euo pipefail
source .env
echo "[RetailOS] Running migrations on ${DB_NAME}..."
for f in backend/database/migrations/*.sql; do
  echo "  → $f"
  docker-compose exec -T postgres psql -U "${DB_USER:-retailos_user}" -d "${DB_NAME:-retailos}" < "$f"
done
echo "[RetailOS] ✅ All migrations applied"
