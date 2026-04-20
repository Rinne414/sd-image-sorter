"""
Aesthetic scoring endpoints.
Uses LAION Aesthetic Predictor (CLIP + linear head) to score images 1-10.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

import database as db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["aesthetic"])


@router.get("/aesthetic/status")
def aesthetic_status():
    """Check if the aesthetic predictor is available and how many images are scored."""
    scored_count = 0
    try:
        conn = db.get_connection()
        try:
            scored_count = conn.execute("SELECT COUNT(*) FROM images WHERE aesthetic_score IS NOT NULL").fetchone()[0]
        finally:
            conn.close()
    except Exception:
        pass

    try:
        from aesthetic import is_available
        available = is_available()
        return {
            "available": available,
            "message": None if available else "Aesthetic predictor dependencies are not installed",
            "scored_count": scored_count,
        }
    except ImportError:
        return {
            "available": False,
            "message": "Aesthetic predictor dependencies are not installed",
            "scored_count": scored_count,
        }


@router.post("/aesthetic/score/{image_id}")
def score_single_image(image_id: int):
    """Score a single image by database ID."""
    try:
        from aesthetic import predict_score
    except ImportError:
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")

    conn = db.get_connection()
    try:
        row = conn.execute("SELECT path FROM images WHERE id = ?", (image_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Image not found")

        score = predict_score(row["path"])
        if score is None:
            raise HTTPException(status_code=500, detail="Scoring failed")

        conn.execute("UPDATE images SET aesthetic_score = ? WHERE id = ?", (score, image_id))
        conn.commit()
        return {"image_id": image_id, "aesthetic_score": score}
    finally:
        conn.close()


# Background task state
_scoring_state = {
    "running": False,
    "total": 0,
    "completed": 0,
    "current": "",
    "errors": 0,
}


@router.post("/aesthetic/score-all")
def score_all_images(background_tasks: BackgroundTasks, force: bool = Query(False)):
    """Score all unscored images in background. Use force=true to rescore all."""
    if _scoring_state["running"]:
        return {"status": "already_running", **_scoring_state}

    try:
        from aesthetic import predict_score, is_available
        if not is_available():
            raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")
    except ImportError:
        raise HTTPException(status_code=503, detail="Aesthetic predictor dependencies not installed")

    conn = db.get_connection()
    try:
        if force:
            total = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        else:
            total = conn.execute("SELECT COUNT(*) FROM images WHERE aesthetic_score IS NULL").fetchone()[0]
    finally:
        conn.close()

    background_tasks.add_task(_score_batch, force)
    return {"status": "started", "total": total}


def _score_batch(force: bool = False):
    """Background task to score all images."""
    import gc
    from aesthetic import predict_score

    _scoring_state["running"] = True
    _scoring_state["completed"] = 0
    _scoring_state["errors"] = 0

    COMMIT_INTERVAL = 20
    CACHE_CLEAR_INTERVAL = 50

    conn = db.get_connection()
    try:
        if force:
            rows = conn.execute("SELECT id, path FROM images").fetchall()
        else:
            rows = conn.execute("SELECT id, path FROM images WHERE aesthetic_score IS NULL").fetchall()

        _scoring_state["total"] = len(rows)
        pending_commits = 0

        for i, row in enumerate(rows):
            _scoring_state["current"] = row["path"]
            try:
                score = predict_score(row["path"])
                if score is not None:
                    conn.execute("UPDATE images SET aesthetic_score = ? WHERE id = ?", (score, row["id"]))
                    pending_commits += 1
                else:
                    _scoring_state["errors"] += 1
            except Exception as e:
                logger.error(f"Error scoring {row['path']}: {e}")
                _scoring_state["errors"] += 1

            _scoring_state["completed"] = i + 1

            if pending_commits >= COMMIT_INTERVAL:
                conn.commit()
                pending_commits = 0

            if (i + 1) % CACHE_CLEAR_INTERVAL == 0:
                gc.collect()
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass

        if pending_commits > 0:
            conn.commit()
    finally:
        conn.close()
        _scoring_state["running"] = False
        _scoring_state["current"] = ""
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


@router.get("/aesthetic/progress")
def scoring_progress():
    """Get the progress of background aesthetic scoring."""
    return _scoring_state
