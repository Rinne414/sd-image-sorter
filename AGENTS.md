# AGENTS.md

The project rules for AI coding agents live in `CLAUDE.md` in this directory. It is kept local (not published) and is the single source of truth: read it before changing anything. Where it names `~/.claude/`, use your own global rules folder instead.

If `CLAUDE.md` is missing (for example in a fresh public clone), the essentials are:

- Desktop and laptop only (about 1280px wide and up). Do no mobile or tablet work.
- FastAPI backend in `backend/`, React + TypeScript frontend in `frontend-v4/` (Vite build), served at `/v4/` on `127.0.0.1:8487` by default. The product is called Vopus (formerly V4); folders, URLs, storage keys and test names keep `v4`.
- The full gate is `python scripts/run_ci.py` (backend pytest in parallel plus Playwright E2E; add `--backend-coverage` for the release gate).
- Never push, tag, publish a release, or change the app version without the owner's explicit approval.
