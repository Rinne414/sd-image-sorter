# CI Protocol (mandatory for every push)

After every `git push` to origin:

1. Run `gh run list --limit 1` to check CI status
2. Wait until it shows `completed / success`
3. If it shows `failure`:
   - Run `gh run view <run_id> --log-failed` to read the error
   - Fix the issue locally
   - Push again
   - Repeat until green
4. **Never deliver a package, tag a release, or tell the user "done" while CI is red**

## Version Sync Checklist

When bumping `backend/app_info.py` APP_VERSION to a new version X.Y.Z:

- [ ] `backend/app_info.py` → `APP_VERSION = "X.Y.Z"`
- [ ] `docs/API.md` → `**Version:** X.Y.Z`
- [ ] `README.md` → badge `version-X.Y.Z-ff8a00`
- [ ] `README.md` → all download links `v{X.Y.Z}`
- [ ] `CHANGELOG.md` → `## [X.Y.Z] - YYYY-MM-DD` entry exists
- [ ] `docs/RELEASE_NOTES_vX.Y.Z.md` exists

The CI test `test_release_public_docs_versions_follow_app_info` enforces most of these.

## What NOT to push to GitHub

- `AGENTS.md` — internal AI agent instructions
- `.kiro/` — local Kiro CLI config (already gitignored)
- `.claude/` — Claude Code session dumps (already gitignored)
- `.plans/` — internal planning docs (already gitignored)
- Session export JSONs (already gitignored via UUID pattern)
- Screenshots at repo root (already gitignored)
