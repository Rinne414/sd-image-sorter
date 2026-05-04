# SQLite Migration Policy

This project now treats SQLite schema changes as versioned application code, not startup-time repair logic.

## Rules

1. Every schema change must ship as a new numbered migration under `backend/migrations/`.
2. Do not add new `PRAGMA table_info` probing or ad hoc `ALTER TABLE` patching back into `database.init_db()`.
3. Do not edit an already-shipped migration to change its meaning. Add a new migration instead.
4. Keep migration numbering strictly increasing and unique.
5. Fresh databases should be creatable from the current migration set alone.

## Runtime Behavior

- `database.init_db()` ensures the `schema_version` ledger exists, then applies pending migrations in version order.
- Each migration runs inside its own SQLite `SAVEPOINT`.
- If one migration fails, that migration is rolled back without advancing `schema_version`, and startup fails loudly.

## Current Scope

- The migration runner is forward-only.
- There is no automated downgrade path today.
- If a future change needs downgrade support or destructive schema replacement, document that rollout explicitly before shipping it.

## Testing Expectations

- Add or update tests for:
  - fresh DB creation
  - representative legacy DB upgrade paths
  - failed migration rollback behavior
  - version monotonicity / duplicate-version guardrails
