#!/usr/bin/env bash
#
# Update a running Bills Hub deployment. Run it ON the server, from the
# checkout:
#
#     cd /var/www/BillHub && bash scripts/deploy.sh
#
# Reports what the deployment is before it touches anything, pulls, migrates,
# runs the read-only preflight, restarts, and reports again.
#
# Safe to re-run: every column change checks information_schema first, and
# the preflight makes no Xero call, so a borrowed refresh token is never
# rotated by running this.
#
# The migration mostly adds, but it is no longer only-adds: a few retired
# columns are dropped, and each of those first counts the rows that would
# lose something and does nothing if there are any. Read what it prints.
#
# It will not run with uncommitted changes in the checkout: on a server those
# are usually a hand-edit someone made under pressure and forgot, and a pull
# would either clobber them or fail halfway.

set -euo pipefail

cd "$(dirname "$0")/.."
APP="${PM2_APP:-billhub}"

rule() { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }

rule "Before"
echo "  checkout   $(pwd)"
echo "  branch     $(git rev-parse --abbrev-ref HEAD)"
echo "  at         $(git log --oneline -1)"

if [ -n "$(git status --porcelain)" ]; then
  warn ""
  warn "  Uncommitted changes in the checkout:"
  git status --short | sed 's/^/    /'
  warn ""
  warn "  Stash or commit them first (git stash), then run this again."
  exit 1
fi

# Read straight out of .env rather than guessing. These decide how much damage
# a mistake could do, so they are stated before anything changes.
MODE="$(grep -E '^XERO_GRANT_SOURCE=' .env 2>/dev/null | cut -d= -f2- || true)"
ALLOW="$(grep -E '^XERO_TENANT_ALLOWLIST=' .env 2>/dev/null | cut -d= -f2- || true)"
echo "  grant      ${MODE:-own (default)}"
if [ "${MODE:-own}" = "wazzocr" ]; then
  if [ -z "$ALLOW" ]; then
    warn "  allowlist  NOT SET — writes are permitted to every organisation on the borrowed grant"
  else
    echo "  allowlist  $(echo "$ALLOW" | tr ',' '\n' | grep -c . ) organisation(s)"
  fi
fi

rule "Fetching"
git fetch --quiet origin

# Resolve the upstream explicitly. @{u} on a branch with no tracking ref fails,
# and swallowing that would have this report "already up to date" and skip the
# pull — the one outcome a deploy script must never produce quietly.
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$UPSTREAM" ]; then
  warn "  this branch tracks nothing, so there is no way to tell what to pull."
  warn "  Set it once:  git branch --set-upstream-to=origin/$(git rev-parse --abbrev-ref HEAD)"
  exit 1
fi
echo "  tracking   $UPSTREAM"

BEHIND="$(git rev-list --count "HEAD..$UPSTREAM")"
if [ "$BEHIND" = "0" ]; then
  echo "  already up to date"
else
  echo "  $BEHIND commit(s) to apply:"
  git --no-pager log --oneline "HEAD..$UPSTREAM" | sed 's/^/    /'
  git merge --ff-only "$UPSTREAM"
fi

rule "Dependencies"
npm ci --omit=dev --silent
echo "  installed"

rule "Database"
npm run --silent db:migrate

rule "Preflight (read-only, makes no Xero call)"
node scripts/preflight.js || warn "  preflight reported problems — read them before going further"

rule "Restart"
if pm2 describe "$APP" >/dev/null 2>&1; then
  pm2 restart "$APP" --update-env >/dev/null
  echo "  pm2 restarted $APP"
else
  warn "  no pm2 process named \"$APP\" — start it yourself, or set PM2_APP"
fi

rule "After"
sleep 3
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || echo 3000)"
echo "  health     $(curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/api/health" || echo 'no response')"
echo "  at         $(git log --oneline -1)"

if [ "${MODE:-own}" = "wazzocr" ] && [ -z "$ALLOW" ]; then
  warn ""
  warn "  Reminder: XERO_TENANT_ALLOWLIST is still unset, so this deployment can"
  warn "  write to all the organisations on WazzOCR's grant. Either set it, or"
  warn "  turn Testing mode on from the Bank files tab before touching anything."
fi

printf '\n'
