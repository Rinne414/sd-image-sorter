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
- If the database schema is newer than the latest bundled migration, startup fails before persistent connection PRAGMAs, migrations, or recovery writes run.

## Downgrade Policy

The migration runner is intentionally forward-only. An older application must
never open a database whose `schema_version` is newer than the latest migration
bundled by that application. There is no automatic or in-place downgrade path.

When startup reports an unsupported newer schema:

1. Stop using the older application with that database. Do not edit
   `schema_version`, delete tables, or run ad hoc `ALTER TABLE` statements to
   force startup.
2. Reopen the database with the newer SD Image Sorter version that created it,
   or restore a backup made by a version compatible with the older application.
3. If work must move to an older version, make and verify a separate compatible
   backup first. Use a supported export/import workflow when one exists; never
   overwrite the newer database in place.

The newer-schema guard fails before persistent PRAGMAs, migration writes, or
stale-row recovery, so the refused database remains unchanged. Any future
downgrade feature must be a separately designed, opt-in rollout with an
explicit backup and data-loss policy; it must not be inferred from the
forward migration list.

## Testing Expectations

- Add or update tests for:
  - fresh DB creation
  - every shipped historical schema boundary (v0 and each numbered boundary
    before the current version)
  - failed migration rollback behavior
  - version monotonicity / duplicate-version guardrails
  - newer-schema rejection without PRAGMA, migration, or recovery writes
