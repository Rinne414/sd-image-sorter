"""One V4 dataset batch per Dataset Maker project.

A dataset batch keeps its name, items, order and V1 settings in the linked
``dataset_projects`` row, so two batches pointing at one project would be two
views that fight over the same data. The unique partial index makes linking
race-free: ``POST /api/batches`` with a ``dataset_project_id`` that is already
linked returns the existing batch instead of creating another.

No released build wrote ``batches.dataset_project_id`` before this migration,
so duplicates can only come from hand-edited databases. If there are any, the
oldest batch keeps the link and the others become orphaned dataset batches
(the state a batch is in after V3.5 deletes its project); no row is deleted.
"""

from __future__ import annotations

import sqlite3

from migrations._schema_common import table_exists


VERSION = 61
NAME = "dataset_batch_link"


def apply(conn: sqlite3.Connection) -> bool:
    if not table_exists(conn, "batches"):
        raise RuntimeError("Cannot link dataset batches: the batches table is missing")
    conn.execute(
        """
        UPDATE batches SET dataset_project_id = NULL
        WHERE dataset_project_id IS NOT NULL
          AND id != (
              SELECT MIN(other.id) FROM batches other
              WHERE other.dataset_project_id = batches.dataset_project_id
          )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_dataset_project_id
        ON batches(dataset_project_id)
        WHERE dataset_project_id IS NOT NULL
        """
    )
    return False
