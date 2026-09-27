// Tests only: files of the repository (fixtures, V3.5's reference engine) read from disk.
// This app's tsconfig has no Node types, so fs is loaded untyped; vitest runs
// the tests in Node.

interface NodeFs {
  readFileSync(path: URL): Uint8Array
  readFileSync(path: URL, encoding: 'utf8'): string
}

const FS_MODULE: string = 'node:fs'
const fs = (await import(/* @vite-ignore */ FS_MODULE)) as NodeFs

/** The worktree root, from src/features/tools/privacy/engine/. */
const ROOT = new URL('../../../../../../', import.meta.url)

export const repoBytes = (relative: string): Uint8Array => new Uint8Array(fs.readFileSync(new URL(relative, ROOT)))
export const repoText = (relative: string): string => fs.readFileSync(new URL(relative, ROOT), 'utf8')
