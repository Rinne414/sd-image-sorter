/**
 * Runs once per Playwright invocation (before any worker): reset the
 * click-coverage artifacts so a run's ledger never mixes with a previous
 * run's (stale JSONL would inflate the coverage ratchet).
 */
import fs from 'node:fs'
import path from 'node:path'

export default async function globalSetup(): Promise<void> {
    const dir = path.resolve(__dirname, '..', '..', '..', 'artifacts', 'click-coverage')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
}
