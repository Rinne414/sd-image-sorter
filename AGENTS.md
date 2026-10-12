# AGENTS.md

The project rules for AI coding agents live in `CLAUDE.md` in this directory. It is kept local (not published) and is the single source of truth: read it before changing anything. Where it names `~/.claude/`, use your own global rules folder instead.

If `CLAUDE.md` is missing (for example in a fresh public clone), the essentials are:

- Desktop and laptop only (about 1280px wide and up). Do no mobile or tablet work.
- FastAPI backend in `backend/` serving two interfaces on `127.0.0.1:8487` by default: the classic vanilla HTML/JS/CSS frontend in `frontend/` (no build step) at `/`, and the V Opus React + TypeScript frontend in `frontend-v4/` (Vite build) at `/vopus/` (old `/v4/` addresses redirect there). Settings in either interface chooses which one `/` opens (`/api/interface`, kept in `data/config/interface.json`; `/?ui=classic` always opens the classic one). Folders, storage keys and test names of V Opus keep `v4`. New features land in the classic UI first; V Opus gets them only on request.
- The full gate is `python scripts/run_ci.py` (backend pytest in parallel; V Opus type check, unit tests and build; then Playwright E2E for both interfaces; add `--backend-coverage` for the release gate). It needs `npm ci` in `tests/e2e` and `frontend-v4`.
- `python scripts/build_release_packages.py` needs Node.js: it runs `npm ci` and `npm run build` in `frontend-v4` first, and every package ships only that build (`frontend-v4/dist`, no sources or source maps).
- Never push, tag, publish a release, or change the app version without the owner's explicit approval.
