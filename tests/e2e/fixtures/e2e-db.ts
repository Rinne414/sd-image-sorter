/**
 * Python lines that give a fixture script `delete_images(conn, where, params)`
 * from fixtures/e2e_db.py: it deletes images the way the app does, taking
 * every row that points at them along (a bare DELETE FROM images on a plain
 * sqlite3 connection leaves tags, scores and prompt words behind). Put it at
 * the top level of the script, then call
 * `delete_images(conn, "filename LIKE ?", (prefix + "%",))`.
 */
export const PY_DELETE_IMAGES = [
  'import sys as _e2e_sys',
  `_e2e_sys.path.insert(0, ${JSON.stringify(__dirname)})`,
  'from e2e_db import delete_images',
].join('\n')
