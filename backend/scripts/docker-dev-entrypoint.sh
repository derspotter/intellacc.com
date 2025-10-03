#!/bin/sh
set -e

# Wait for Postgres to become available
until pg_isready -h db -p 5432 >/dev/null 2>&1; do
  echo "Waiting for DB"
  sleep 2
done

echo "Ensuring schema_migrations table exists"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

run_migration() {
  file="$1"
  name="$(basename "$file")"
  # Escape any single quotes in the filename for SQL insertion
  escaped_name="$(printf "%s" "$name" | sed "s/'/''/g")"

  already_applied=$(psql "$DATABASE_URL" -Atq -c "SELECT 1 FROM schema_migrations WHERE filename = '$escaped_name'" || true)

  if [ "$already_applied" = "1" ]; then
    echo "Skipping already applied migration: $name"
    return
  fi

  echo "Applying migration: $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations (filename) VALUES ('$escaped_name') ON CONFLICT (filename) DO NOTHING;"
}

migrations_dir="migrations"
initial_migration="$migrations_dir/initial_migration.sql"

if [ -f "$initial_migration" ]; then
  run_migration "$initial_migration"
fi

for migration in "$migrations_dir"/*.sql; do
  [ -e "$migration" ] || continue
  base_name="$(basename "$migration")"
  [ "$base_name" = "initial_migration.sql" ] && continue
  case "$base_name" in
    *backup*) continue ;;
  esac
  run_migration "$migration"
done

# Ensure npm dependencies are present (helps when the image cache is stale)
if [ ! -d node_modules ] || ! npm ls --depth=0 >/dev/null 2>&1; then
  echo "Installing npm dependencies"
  npm install --no-fund --no-audit
fi

echo "Starting backend in watch mode"
exec npm run dev
