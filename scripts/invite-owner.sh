#!/bin/sh
# Creates (or resets) an owner account and writes a one-time setup link to a private file.
# The link is never printed: it goes (mode 0600) to --out FILE, or by default to
# ~/.hermes/secrets/betics-admin-setup-link-<email>.txt
# Resetting an existing owner also signs them out everywhere (their sessions are deleted).
# Usage: scripts/invite-owner.sh email "Name" [--remote] [--persist-to DIR] [--out FILE]
set -e
EMAIL=$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d "'"); NAME=$(printf '%s' "$2" | sed "s/'/''/g"); shift 2
TARGET="--local"; EXTRA=""; BASE="http://127.0.0.1:8790"; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in --remote) TARGET="--remote"; BASE="https://admin.betics.io";; --persist-to) EXTRA="--persist-to $2"; shift;; --out) OUT="$2"; shift;; esac; shift
done
if [ -z "$OUT" ]; then
  mkdir -p "$HOME/.hermes/secrets" && chmod 700 "$HOME/.hermes/secrets"
  OUT="$HOME/.hermes/secrets/betics-admin-setup-link-$(printf '%s' "$EMAIL" | tr -c 'a-z0-9.@' '_').txt"
fi
TOKEN=$(openssl rand -hex 24)
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
SQL="INSERT INTO admins (email, name, role) VALUES ('$EMAIL', '$NAME', 'owner') ON CONFLICT(email) DO UPDATE SET role = 'owner', active = 1;
UPDATE admins SET setup_token_hash = '$HASH', setup_expires_at = datetime('now', '+48 hours') WHERE email = '$EMAIL';
DELETE FROM admin_sessions WHERE admin_id = (SELECT id FROM admins WHERE email = '$EMAIL');
INSERT INTO admin_audit (admin_email, action, target, after_json) VALUES ('system', 'admin.invite_owner', 'admin:$EMAIL', '{\"via\":\"cli\",\"sessionsCleared\":true}');
INSERT OR IGNORE INTO alerts (type, severity, title, details, dedupe_key) VALUES ('admin_owner_invited', 'critical', 'An owner setup link was made from the command line: $EMAIL', 'Their sessions were ended. If you did not do this, remove them in Settings at once.', 'admin_owner_cli:$EMAIL:$HASH');"
CI=true wrangler d1 execute betics-db $TARGET $EXTRA --command "$SQL" >/dev/null
( umask 077; printf '%s\n' "$BASE/#/setup/$TOKEN" > "$OUT" )
chmod 600 "$OUT"
echo "Setup link for $EMAIL written to $OUT (mode 600, one use, 48 hours)."
