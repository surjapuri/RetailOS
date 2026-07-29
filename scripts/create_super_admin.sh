#!/bin/bash
# Creates a new Super Admin with TOTP 2FA
set -euo pipefail
source .env
read -p "Email: " SA_EMAIL
read -s -p "Password: " SA_PASS; echo ""
SA_HASH=$(docker-compose exec -T python-api python3 -c "from passlib.hash import bcrypt; print(bcrypt.hash('$SA_PASS',rounds=12))")
SA_TOTP=$(docker-compose exec -T python-api python3 -c "import pyotp; print(pyotp.random_base32())")
read -p "Allowed IPs (comma-separated, or press Enter for 0.0.0.0/0): " SA_IPS
SA_IPS=${SA_IPS:-"0.0.0.0/0"}
IPS_ARRAY=$(echo "$SA_IPS" | sed "s/,/','/g" | sed "s/^/ARRAY['/;s/$/']/")
docker-compose exec -T postgres psql -U "${DB_USER}" -d "${DB_NAME}" -c \
  "INSERT INTO super_admin_users (email,password_hash,totp_secret,allowed_ips) VALUES ('${SA_EMAIL}','${SA_HASH}','${SA_TOTP}',${IPS_ARRAY}) ON CONFLICT DO NOTHING;"
echo ""
echo "✅ Super Admin created: ${SA_EMAIL}"
echo "🔑 TOTP Secret: ${SA_TOTP}"
echo "   Add to Google Authenticator immediately."
