"""
SQLite database for storing image metadata and tags.

This module provides direct function-based database access for backward compatibility.
For new code, consider using the repository pattern from db_repos:

    from db_repos import ImageRepository, TagRepository, CollectionRepository
    from db_repos import ImageFilters

    # Example usage:
    image_repo = ImageRepository()
    images = image_repo.find_all(filters=ImageFilters(tags=["portrait"]), limit=50)
    image = image_repo.find_by_id(123)

    # Dependency injection with FastAPI:
    def get_image_repo() -> ImageRepository:
        return ImageRepository()

See backend/db_repos/repositories/ for the repository implementations.
"""
import sqlite3
import os
import json
import re
from datetime import datetime
from typing import Optional, List, Dict, Any
from contextlib import contextmanager
import time
import threading

from config import (
    DATABASE_PATH,
    FAVORITES_COLLECTION_SLUG,
    FAVORITES_COLLECTION_NAME,
    FAVORITES_FOLDER_PATH,
)



# ============== Tags Cache ==============
_tags_cache_lock = threading.Lock()
_tags_cache_data = None
_tags_cache_timestamp = 0
_TAGS_CACHE_TTL = 60  # seconds

def _invalidate_tags_cache():
    """Clear the tags cache when tags are modified."""
    global _tags_cache_data, _tags_cache_timestamp
    with _tags_cache_lock:
        _tags_cache_data = None
        _tags_cache_timestamp = 0


def normalize_prompt_token(token: str) -> str:
    """Normalize a prompt token for consistent matching.

    Rules:
    1. Convert to lowercase
    2. Replace underscores with spaces
    3. Strip whitespace

    Example: "Best_quality" = "best quality" = "BeStQualITY" -> "best quality"
    """
    return token.lower().replace('_', ' ').strip()


def escape_like_pattern(value: str) -> str:
    """Escape SQL LIKE wildcard characters to prevent pattern injection.

    Escapes % and _ characters so they are treated as literals in LIKE patterns.

    Example: "test_file" -> "test\\_file" (matches literal "test_file", not "testXfile")
    """
    return value.replace('%', r'\%').replace('_', r'\_')


def normalize_lora_name(lora_name: str) -> str:
    """Normalize a LORA name for consistent matching.
    
    Strips weight notation and file extensions for cleaner display:
    - "my_lora:0.8" -> "my_lora"
    - "my_lora.safetensors" -> "my_lora"
    - "my-lora_v2.ckpt" -> "my-lora_v2"
    - Lowercase for matching
    """
    # Strip weight notation (everything after last colon if it's a number)
    if ':' in lora_name:
        parts = lora_name.rsplit(':', 1)
        # Check if the part after colon is a weight (number)
        try:
            float(parts[1])
            lora_name = parts[0]
        except ValueError:
            pass
    
    # Strip common model file extensions
    extensions_to_strip = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin']
    lora_lower = lora_name.lower()
    for ext in extensions_to_strip:
        if lora_lower.endswith(ext):
            lora_name = lora_name[:-len(ext)]
            break
    
    return lora_name.lower().strip()


def extract_prompt_tokens(prompt: str) -> set:
    """Extract normalized tokens from a prompt string.
    
    Used for exact token matching in filters.
    Splits by comma only, cleans parentheses/weights, normalizes.
    """
    if not prompt:
        return set()
    
    # Remove XML-like tags and lora tags
    clean_prompt = re.sub(r'<[^>]+>[^<]*</[^>]+>', '', prompt)
    clean_prompt = re.sub(r'<lora:[^>]+>', '', clean_prompt)
    clean_prompt = re.sub(r'<[^>]+>', '', clean_prompt)
    
    tokens = set()
    for token in clean_prompt.split(','):
        token = token.strip()
        if not token:
            continue
        # Remove leading/trailing parentheses and weight suffixes
        clean_token = re.sub(r'^\(+|\)+$', '', token)
        clean_token = re.sub(r':\d+\.?\d*\)?$', '', clean_token)
        clean_token = clean_token.strip()
        
        if clean_token and len(clean_token) > 1:
            normalized = normalize_prompt_token(clean_token)
            if normalized and len(normalized) > 1:
                tokens.add(normalized)
    
    return tokens


def extract_lora_names(loras_json: str, prompt: str) -> set:
    """Extract normalized LORA names from loras JSON and prompt.
    
    Used for exact LORA matching in filters.
    """
    loras = set()
    
    # Extract from JSON array
    if loras_json:
        try:
            loras_list = json.loads(loras_json)
            for lora_name in loras_list:
                if lora_name and len(lora_name) > 2:
                    normalized = normalize_lora_name(lora_name)
                    if normalized and len(normalized) > 2:
                        loras.add(normalized)
        except (json.JSONDecodeError, TypeError) as e:
            # Invalid JSON format, skip
            pass
    
    # Extract from prompt (format: <lora:name:weight>)
    if prompt:
        lora_matches = re.findall(r'<lora:([^:>]+)(?::[^>]+)?>', prompt, re.IGNORECASE)
        for lora_name in lora_matches:
            if lora_name and len(lora_name) > 2:
                normalized = normalize_lora_name(lora_name)
                if normalized and len(normalized) > 2:
                    loras.add(normalized)
    
    return loras

def get_connection() -> sqlite3.Connection:
    """Get a database connection with row factory and performance optimizations."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Performance optimizations
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
    return conn


@contextmanager
def get_db():
    """Context manager for database connections."""
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Initialize the database schema."""
    with get_db() as conn:
        cursor = conn.cursor()

        # Images table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                generator TEXT DEFAULT 'unknown',
                prompt TEXT,
                negative_prompt TEXT,
                metadata_json TEXT,
                width INTEGER,
                height INTEGER,
                file_size INTEGER,
                checkpoint TEXT,
                loras TEXT, -- JSON array of lora names
                created_at DATETIME,
                indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                tagged_at DATETIME
            )
        """)

        # Schema Migration: Add columns if they don't exist
        cursor.execute("PRAGMA table_info(images)")
        columns = [row[1] for row in cursor.fetchall()]
        if 'checkpoint' not in columns:
            cursor.execute("ALTER TABLE images ADD COLUMN checkpoint TEXT")
        if 'loras' not in columns:
            cursor.execute("ALTER TABLE images ADD COLUMN loras TEXT")
        if 'embedding' not in columns:
            cursor.execute("ALTER TABLE images ADD COLUMN embedding BLOB")

        # Collections table (Favorites MVP uses a built-in collection)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Snapshot entries for collection items
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS collection_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                source_image_id INTEGER NOT NULL,
                copied_path TEXT NOT NULL,
                prompt TEXT,
                negative_prompt TEXT,
                checkpoint TEXT,
                loras TEXT,
                metadata_json TEXT,
                created_at DATETIME,
                width INTEGER,
                height INTEGER,
                file_size INTEGER,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(collection_id, source_image_id),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (source_image_id) REFERENCES images(id) ON DELETE CASCADE
            )
        """)

        # Tags table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
            )
        """)

        # === Tag categorization tables ===

        # Tag category mapping (built-in + user-customizable)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                subcategory TEXT,
                is_user_defined INTEGER DEFAULT 0
            )
        """)

        # Tag sets (tags that should appear together, e.g. "school uniform" set)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_sets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                category TEXT NOT NULL
            )
        """)

        # Members of tag sets
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_set_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                set_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                is_required INTEGER DEFAULT 1,
                FOREIGN KEY (set_id) REFERENCES tag_sets(id) ON DELETE CASCADE
            )
        """)

        # Tag exclusion rules
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_exclusions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_name TEXT NOT NULL,
                description TEXT
            )
        """)

        # Conditions that trigger an exclusion rule
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_exclusion_conditions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exclusion_id INTEGER NOT NULL,
                condition_tag TEXT NOT NULL,
                condition_type TEXT DEFAULT 'present',
                FOREIGN KEY (exclusion_id) REFERENCES tag_exclusions(id) ON DELETE CASCADE
            )
        """)

        # Tags or categories excluded when rule is triggered
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tag_exclusion_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exclusion_id INTEGER NOT NULL,
                excluded_tag TEXT,
                excluded_category TEXT,
                FOREIGN KEY (exclusion_id) REFERENCES tag_exclusions(id) ON DELETE CASCADE
            )
        """)

        # Prompt generation presets (saved configurations)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS prompt_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                config_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Artist predictions (LSNet-style artist identification)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS artist_predictions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL UNIQUE,
                artist TEXT NOT NULL,
                confidence REAL NOT NULL,
                top_predictions TEXT,
                identified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
            )
        """)

        # Create indexes for fast searching
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tags_image_id ON tags(image_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_generator ON images(generator)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_path ON images(path)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tag_categories_tag ON tag_categories(tag)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tag_categories_category ON tag_categories(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tag_set_members_set ON tag_set_members(set_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_embedding ON images(embedding IS NOT NULL) WHERE embedding IS NOT NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_artist_predictions_artist ON artist_predictions(artist)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_artist_predictions_image_id ON artist_predictions(image_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_collections_slug ON collections(slug)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_collection_items_source_image_id ON collection_items(source_image_id)")

        # Performance-critical indexes for common queries
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_checkpoint ON images(checkpoint) WHERE checkpoint IS NOT NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_images_tagged_at ON images(tagged_at) WHERE tagged_at IS NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tags_tag_image ON tags(tag, image_id)")
        # Optimized index for rating and tag_count queries (covers common correlated subqueries)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_tags_image_id_tag ON tags(image_id, tag)")

        # Junction table for normalized lora names (for efficient lora filtering)
        # This avoids LIKE queries on the loras column which requires full table scans
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS image_loras (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id INTEGER NOT NULL,
                lora_name TEXT NOT NULL,
                FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
                UNIQUE(image_id, lora_name)
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_image_loras_lora_name ON image_loras(lora_name)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_image_loras_image_id ON image_loras(image_id)")

        cursor.execute(
            """
            INSERT OR IGNORE INTO collections (slug, name, folder_path)
            VALUES (?, ?, ?)
            """,
            (FAVORITES_COLLECTION_SLUG, FAVORITES_COLLECTION_NAME, FAVORITES_FOLDER_PATH)
        )

        # Migrate existing loras to junction table (if not already done)
        cursor.execute("SELECT COUNT(*) FROM image_loras")
        if cursor.fetchone()[0] == 0:
            cursor.execute("SELECT id, loras, prompt FROM images WHERE loras IS NOT NULL OR prompt LIKE '%<lora:%'")
            for row in cursor.fetchall():
                image_id = row[0]
                loras_json = row[1] or ''
                prompt = row[2] or ''
                lora_names = extract_lora_names(loras_json, prompt)
                for lora_name in lora_names:
                    cursor.execute(
                        "INSERT OR IGNORE INTO image_loras (image_id, lora_name) VALUES (?, ?)",
                        (image_id, lora_name)
                    )

        conn.commit()


def add_image(
    path: str,
    filename: str,
    generator: str = "unknown",
    prompt: Optional[str] = None,
    negative_prompt: Optional[str] = None,
    metadata_json: Optional[str] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    file_size: Optional[int] = None,
    checkpoint: Optional[str] = None,
    loras: Optional[List[str]] = None,
    created_at: Optional[datetime] = None
) -> int:
    """Add an image to the database. Returns the image ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO images 
            (path, filename, generator, prompt, negative_prompt, metadata_json, 
             width, height, file_size, checkpoint, loras, created_at, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (path, filename, generator, prompt, negative_prompt, metadata_json,
              width, height, file_size, checkpoint, json.dumps(loras) if loras else None, created_at))
        image_id = cursor.lastrowid
        
        # Populate image_loras junction table for efficient filtering
        if loras or (prompt and '<lora:' in prompt):
            lora_names = extract_lora_names(
                json.dumps(loras) if loras else '',
                prompt or ''
            )
            for lora_name in lora_names:
                cursor.execute(
                    "INSERT OR IGNORE INTO image_loras (image_id, lora_name) VALUES (?, ?)",
                    (image_id, lora_name)
                )
        
        return image_id


def add_tags(image_id: int, tags: List[Dict[str, Any]]) -> None:
    """Add tags for an image. Each tag dict should have 'tag' and optionally 'confidence'.

    Uses executemany for batch insert performance.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        # Clear existing tags
        cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
        # Batch insert new tags (N+1 fix: use executemany instead of loop)
        tag_values = [
            (image_id, tag_data.get("tag", ""), tag_data.get("confidence", 1.0))
            for tag_data in tags
            if tag_data.get("tag")
        ]
        if tag_values:
            cursor.executemany(
                "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                tag_values
            )
        # Update tagged timestamp
        cursor.execute(
            "UPDATE images SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?",
            (image_id,)
        )


def add_tags_batch(image_tags_list: List[Dict[str, Any]]) -> None:
    """Add tags for multiple images in a single transaction.
    
    More efficient than calling add_tags() repeatedly for batch tagging operations.
    Uses a single database connection and commits once at the end.
    
    Args:
        image_tags_list: List of dicts, each with:
            - image_id: int
            - tags: List[Dict] with 'tag' and 'confidence' keys
    """
    if not image_tags_list:
        return
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        for item in image_tags_list:
            image_id = item["image_id"]
            tags = item["tags"]
            
            # Clear existing tags
            cursor.execute("DELETE FROM tags WHERE image_id = ?", (image_id,))
            
            # Batch insert new tags
            tag_values = [
                (image_id, tag_data.get("tag", ""), tag_data.get("confidence", 1.0))
                for tag_data in tags
                if tag_data.get("tag")
            ]
            if tag_values:
                cursor.executemany(
                    "INSERT INTO tags (image_id, tag, confidence) VALUES (?, ?, ?)",
                    tag_values
                )
            
            # Update tagged timestamp
            cursor.execute(
                "UPDATE images SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?",
                (image_id,)
            )
        
        # Single commit at the end (automatic with context manager)


# =============================================================================
# Query Building Helpers for get_images()
# =============================================================================

VALID_SORT_OPTIONS = {
    "newest", "oldest", "name_asc", "name_desc", "generator",
    "prompt_length", "tag_count", "rating", "character_count",
    "random", "file_size", "file_size_asc",
}


def _build_base_query(sort_by: str, select_cols: str) -> str:
    """Build the base SELECT query with optional subqueries for tag-based sorting.

    Args:
        sort_by: Sorting method identifier
        select_cols: Column selection string

    Returns:
        Base SQL query string
    """
    if sort_by not in VALID_SORT_OPTIONS:
        sort_by = "newest"

    if sort_by == "tag_count":
        return f"""SELECT DISTINCT {select_cols},
                   (SELECT COUNT(*) FROM tags t WHERE t.image_id = i.id) as tag_count
                   FROM images i"""
    elif sort_by == "character_count":
        return f"""SELECT DISTINCT {select_cols},
                   (SELECT COUNT(*) FROM tags t WHERE t.image_id = i.id AND t.tag LIKE '%character%') as char_count
                   FROM images i"""
    elif sort_by == "rating":
        # Priority: explicit > questionable > sensitive > general > unrated
        return f"""SELECT DISTINCT {select_cols},
                   CASE
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'explicit') THEN 1
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'questionable') THEN 2
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'sensitive') THEN 3
                       WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'general') THEN 4
                       ELSE 5
                   END as rating_order
                   FROM images i"""
    else:
        return f"SELECT DISTINCT {select_cols} FROM images i"


def _apply_tag_filter(query: str, tags: Optional[List[str]], params: List[Any]) -> tuple:
    """Apply tag filtering with JOINs (AND logic).

    Args:
        query: Current query string
        tags: List of tags to filter by
        params: Current parameter list

    Returns:
        Tuple of (modified query, modified params)
    """
    if not tags:
        return query, params

    for i, tag in enumerate(tags):
        alias = f"t{i}"
        query += f" INNER JOIN tags {alias} ON i.id = {alias}.image_id AND {alias}.tag = ?"
        params.append(tag)


    return query, params


def _apply_generator_filter(conditions: List[str], params: List[Any],
                            generators: Optional[List[str]]) -> tuple:
    """Apply generator filtering (OR logic).

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        generators: List of generators to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not generators:
        return conditions, params

    placeholders = ",".join("?" * len(generators))
    conditions.append(f"i.generator IN ({placeholders})")
    params.extend(generators)

    return conditions, params


def _apply_rating_filter(conditions: List[str], params: List[Any],
                         ratings: Optional[List[str]]) -> tuple:
    """Apply rating filtering (OR logic with untagged fallback).

    When all 4 ratings are selected, don't filter at all (show everything).
    When some ratings are selected, show images with those rating tags OR untagged images.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        ratings: List of ratings to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not ratings:
        return conditions, params

    all_ratings = {'general', 'sensitive', 'questionable', 'explicit'}
    selected_ratings = set(ratings)

    # Only apply filter if not all ratings are selected
    if selected_ratings == all_ratings:
        return conditions, params

    rating_placeholders = ",".join("?" * len(ratings))
    # Image has one of the selected ratings OR image has no tags at all (untagged)
    conditions.append(f"""(
        EXISTS (SELECT 1 FROM tags rt WHERE rt.image_id = i.id AND rt.tag IN ({rating_placeholders}))
        OR i.tagged_at IS NULL
    )""")
    params.extend(ratings)

    return conditions, params


def _apply_checkpoint_filter(conditions: List[str], params: List[Any],
                             checkpoints: Optional[List[str]]) -> tuple:
    """Apply checkpoint filtering (OR logic).

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        checkpoints: List of checkpoints to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not checkpoints:
        return conditions, params

    placeholders = ",".join("?" * len(checkpoints))
    conditions.append(f"i.checkpoint IN ({placeholders})")
    params.extend(checkpoints)

    return conditions, params


def _apply_lora_filter(conditions: List[str], params: List[Any],
                       loras: Optional[List[str]]) -> tuple:
    """Apply LoRA filtering (OR logic - image has ANY of the selected loras).

    Matches on lora name in loras column, metadata_json, or prompt.
    Uses same normalization as library: strip weight notation and lowercase.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        loras: List of loras to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not loras:
        return conditions, params

    lora_conditions = []
    for lora in loras:
        # Strip weight notation (name:0.8 -> name) and lowercase
        lora_normalized = normalize_lora_name(lora)
        # Match lora name in loras column, metadata_json, or prompt
        lora_conditions.append("(LOWER(i.loras) LIKE ? ESCAPE '\\' OR LOWER(i.metadata_json) LIKE ? ESCAPE '\\' OR LOWER(i.prompt) LIKE ? ESCAPE '\\')")
        params.append(f"%{escape_like_pattern(lora_normalized)}%")
        params.append(f"%{escape_like_pattern(lora_normalized)}%")
        params.append(f"%{escape_like_pattern(lora_normalized)}%")

    conditions.append(f"({' OR '.join(lora_conditions)})")

    return conditions, params


def _apply_search_filter(conditions: List[str], params: List[Any],
                         search_query: Optional[str]) -> tuple:
    """Apply prompt search filtering with normalization.

    Normalizes: lowercase and replace underscore with space.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        search_query: Search term to look for

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not search_query:
        return conditions, params

    normalized_search = normalize_prompt_token(search_query)
    conditions.append("(REPLACE(LOWER(i.prompt), '_', ' ') LIKE ? ESCAPE '\\' OR LOWER(i.filename) LIKE ? ESCAPE '\\')")
    params.extend([f"%{escape_like_pattern(normalized_search)}%", f"%{escape_like_pattern(search_query.lower())}%"])

    return conditions, params


def _apply_prompt_terms_filter(conditions: List[str], params: List[Any],
                               prompt_terms: Optional[List[str]]) -> tuple:
    """Apply multi-prompt filter (AND logic - prompt must contain ALL terms).

    Uses substring matching (LIKE %term%) with normalization.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        prompt_terms: List of prompt terms to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if not prompt_terms:
        return conditions, params

    for term in prompt_terms:
        normalized_term = normalize_prompt_token(term)
        conditions.append("REPLACE(LOWER(i.prompt), '_', ' ') LIKE ? ESCAPE '\\'")
        params.append(f"%{escape_like_pattern(normalized_term)}%")

    return conditions, params


def _apply_dimension_filters(conditions: List[str], params: List[Any],
                             min_width: Optional[int], max_width: Optional[int],
                             min_height: Optional[int], max_height: Optional[int],
                             aspect_ratio: Optional[str]) -> tuple:
    """Apply dimension and aspect ratio filters.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        min_width, max_width: Width range constraints
        min_height, max_height: Height range constraints
        aspect_ratio: One of 'square', 'landscape', 'portrait'

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if min_width:
        conditions.append("i.width >= ?")
        params.append(min_width)
    if max_width:
        conditions.append("i.width <= ?")
        params.append(max_width)
    if min_height:
        conditions.append("i.height >= ?")
        params.append(min_height)
    if max_height:
        conditions.append("i.height <= ?")
        params.append(max_height)

    # Aspect ratio filter
    if aspect_ratio:
        if aspect_ratio == 'square':
            conditions.append("i.height > 0 AND ABS(CAST(i.width AS FLOAT) / i.height - 1.0) < 0.1")
        elif aspect_ratio == 'landscape':
            conditions.append("i.height > 0 AND CAST(i.width AS FLOAT) / i.height > 1.1")
        elif aspect_ratio == 'portrait':
            conditions.append("i.height > 0 AND CAST(i.width AS FLOAT) / i.height < 0.9")

    return conditions, params


def _apply_artist_filter(query: str, conditions: List[str], params: List[Any],
                         artist: Optional[str]) -> tuple:
    """Apply artist filter by joining with artist_predictions table.

    Args:
        query: Current query string
        conditions: Current WHERE conditions list
        params: Current parameter list
        artist: Artist name to filter by

    Returns:
        Tuple of (modified query, modified conditions, modified params)
    """
    if not artist:
        return query, conditions, params

    query += " INNER JOIN artist_predictions ap ON i.id = ap.image_id"
    conditions.append("ap.artist = ?")
    params.append(artist)

    return query, conditions, params


def _apply_image_ids_filter(conditions: List[str], params: List[Any],
                            image_ids: Optional[List[int]]) -> tuple:
    """Filter by specific image IDs.

    Args:
        conditions: Current WHERE conditions list
        params: Current parameter list
        image_ids: List of image IDs to filter by

    Returns:
        Tuple of (modified conditions, modified params)
    """
    if image_ids is None:
        return conditions, params

    placeholders = ",".join("?" * len(image_ids))
    conditions.append(f"i.id IN ({placeholders})")
    params.extend(image_ids)

    return conditions, params

def _get_order_clause(sort_by: str) -> str:
    """Get the ORDER BY clause for a given sort method.

    Args:
        sort_by: Sorting method identifier

    Returns:
        SQL ORDER BY clause string
    """
    sort_options = {
        "newest": "i.created_at DESC, i.id DESC",
        "oldest": "i.created_at ASC, i.id ASC",
        "name_asc": "i.filename ASC, i.id ASC",
        "name_desc": "i.filename DESC, i.id DESC",
        "generator": "i.generator ASC, i.created_at DESC, i.id DESC",
        "prompt_length": "LENGTH(COALESCE(i.prompt, '')) DESC, i.id DESC",
        "tag_count": "tag_count DESC, i.id DESC",
        "rating": "rating_order ASC, i.id ASC",
        "character_count": "char_count DESC, i.id DESC",
        "random": "RANDOM()",
        "file_size": "i.file_size DESC, i.id DESC",
        "file_size_asc": "i.file_size ASC, i.id ASC",
    }
    return sort_options.get(sort_by, "i.created_at DESC, i.id DESC")


def _supports_cursor_sort(sort_by: str) -> bool:
    """Return True when cursor pagination is safe for the requested sort."""
    return sort_by in {"newest", "oldest"}


def _fetch_post_filtered_page(
    conn,
    base_query: str,
    base_params: List[Any],
    order_clause: str,
    prompt_terms: Optional[List[str]],
    loras: Optional[List[str]],
    limit: int,
) -> List[Dict[str, Any]]:
    """Fetch enough rows for a post-filtered page without fixed heuristic truncation."""
    cursor = conn.cursor()
    fetch_size = max(limit * 2, 50)
    offset = 0
    collected: List[Dict[str, Any]] = []

    while True:
        query = f"{base_query} ORDER BY {order_clause} LIMIT ? OFFSET ?"
        params = list(base_params) + [fetch_size, offset]
        cursor.execute(query, params)
        rows = cursor.fetchall()
        if not rows:
            break

        batch = _post_filter_results([dict(row) for row in rows], prompt_terms, loras, 0, 0)
        collected.extend(batch)
        if limit and len(collected) > limit:
            break

        if len(rows) < fetch_size:
            break
        offset += fetch_size

    return collected


def _post_filter_results(results: List[Dict[str, Any]],
                         prompt_terms: Optional[List[str]],
                         loras: Optional[List[str]],
                         offset: int,
                         limit: int) -> List[Dict[str, Any]]:
    """Apply in-memory post-filtering for exact matching."""
    if not prompt_terms and not loras:
        return results[offset:offset + limit] if limit else results[offset:]

    filtered_results = []
    normalized_prompt_terms = [normalize_prompt_token(t) for t in (prompt_terms or [])]
    normalized_loras = [normalize_lora_name(l) for l in (loras or [])]
    early_stop_count = offset + limit if limit else None

    for img in results:
        if normalized_prompt_terms:
            image_tokens = extract_prompt_tokens(img.get('prompt', ''))
            if not all(term in image_tokens for term in normalized_prompt_terms):
                continue

        if normalized_loras:
            image_loras = extract_lora_names(img.get('loras', ''), img.get('prompt', ''))
            if not any(lora in image_loras for lora in normalized_loras):
                continue

        filtered_results.append(img)

        if early_stop_count and len(filtered_results) >= early_stop_count:
            break

    return filtered_results[offset:offset + limit] if limit else filtered_results[offset:]


def get_images(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    limit: int = 100,
    offset: int = 0,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,  # Multi-prompt filter (AND logic)
    aspect_ratio: Optional[str] = None,  # 'square', 'landscape', 'portrait'
    artist: Optional[str] = None,  # Artist filter
    image_ids: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    """
    Get images with optional filters.
    
    .. deprecated::
        Use get_images_paginated() for better performance with large datasets.
        OFFSET pagination becomes slow for large offsets as SQLite must scan
        all preceding rows. Cursor-based pagination in get_images_paginated()
        uses indexed lookups for constant-time page fetching.
    
    Args:
        generators: Filter by generator type (OR logic)
        tags: Filter by tags (AND logic - image must have ALL tags)
        ratings: Filter by rating tags (OR logic - image must have ANY rating OR be untagged)
        checkpoints: Filter by checkpoint names (OR logic)
        loras: Filter by lora names (AND logic - image must have ALL loras)
        search_query: Search in prompt text
        artist: Filter by artist name (from artist_predictions table)
        sort_by: Sorting method (newest, oldest, name_asc, name_desc, generator, prompt_length, tag_count, rating, character_count, random, file_size)
        min_width, max_width, min_height, max_height: Dimension filters
        aspect_ratio: Filter by aspect ratio ('square', 'landscape', 'portrait')
    
    Returns:
        List of image dictionaries matching the filters.
    """
    if image_ids is not None and len(image_ids) == 0:
        return []

    with get_db() as conn:
        cursor = conn.cursor()

        # Determine if post-filtering is needed (for exact matching)
        needs_post_filter = bool(prompt_terms) or bool(loras)
        # Include prompt fields when searching or post-filtering
        needs_prompt_fields = bool(search_query) or needs_post_filter
        select_lightweight = """i.id, i.filename, i.path, i.generator, i.width, i.height,
                       i.file_size, i.checkpoint, i.loras, i.created_at, i.tagged_at"""
        select_with_prompt = """i.id, i.filename, i.path, i.generator, i.prompt, i.negative_prompt, i.width, i.height,
                       i.file_size, i.checkpoint, i.loras, i.created_at, i.tagged_at"""
        select_full = "i.*"
        if needs_post_filter:
            select_cols = select_full
        elif needs_prompt_fields:
            select_cols = select_with_prompt
        else:
            select_cols = select_lightweight

        # Build base query with sorting subqueries
        query = _build_base_query(sort_by, select_cols)

        # Initialize conditions and params
        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params)

        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause and append to query
        order_clause = _get_order_clause(sort_by)

        if needs_post_filter:
            results = _fetch_post_filtered_page(conn, query, params, order_clause, prompt_terms, loras, limit)
        else:
            query += f" ORDER BY {order_clause} LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            cursor.execute(query, params)
            rows = cursor.fetchall()
            results = [dict(row) for row in rows]

        return results


def get_filtered_image_count(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
) -> int:
    """Get count of images matching filters without loading image data.

    Memory-efficient: Only returns a count, doesn't load any image rows.
    For filters requiring post-filtering (prompt_terms, loras), this returns
    an approximate count based on SQL-level filtering.

    Args:
        Same filters as get_images()

    Returns:
        Number of matching images
    """
    if image_ids is not None and len(image_ids) == 0:
        return 0

    with get_db() as conn:
        cursor = conn.cursor()

        # Build count query
        query = "SELECT COUNT(DISTINCT i.id) FROM images i"

        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        if tags:
            for i, tag in enumerate(tags):
                alias = f"t{i}"
                query += f" INNER JOIN tags {alias} ON i.id = {alias}.image_id AND {alias}.tag = ?"
                params.append(tag)


        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        cursor.execute(query, params)
        return cursor.fetchone()[0]


def get_filtered_image_ids(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    image_ids: Optional[List[int]] = None,
) -> List[int]:
    """Get list of image IDs matching filters without loading full image data.

    Memory-efficient: Returns only IDs, not full image dictionaries.
    Used by sort session to minimize memory footprint.

    Args:
        Same filters as get_images()

    Returns:
        List of image IDs matching the filters
    """
    if image_ids is not None and len(image_ids) == 0:
        return []

    with get_db() as conn:
        cursor = conn.cursor()

        # Determine if post-filtering is needed
        needs_post_filter = bool(prompt_terms) or bool(loras)

        # Build base query selecting only IDs
        if sort_by == "tag_count":
            query = """SELECT DISTINCT i.id,
                       (SELECT COUNT(*) FROM tags t WHERE t.image_id = i.id) as tag_count
                       FROM images i"""
        elif sort_by == "rating":
            query = """SELECT DISTINCT i.id,
                       CASE
                           WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'explicit') THEN 1
                           WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'questionable') THEN 2
                           WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'sensitive') THEN 3
                           WHEN EXISTS (SELECT 1 FROM tags t WHERE t.image_id = i.id AND t.tag = 'general') THEN 4
                           ELSE 5
                       END as rating_order
                       FROM images i"""
        else:
            query = "SELECT DISTINCT i.id FROM images i"

        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params)

        # Apply image IDs filter
        conditions, params = _apply_image_ids_filter(conditions, params, image_ids)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Build WHERE clause
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause
        order_clause = _get_order_clause(sort_by)
        query += f" ORDER BY {order_clause}"

        cursor.execute(query, params)
        
        # Memory optimization: Use generator to avoid loading all rows at once
        # For very large datasets, fetch in batches instead of all at once
        ids = []
        batch_fetch_size = 5000  # Fetch in chunks to limit memory usage
        while True:
            rows = cursor.fetchmany(batch_fetch_size)
            if not rows:
                break
            ids.extend(row[0] for row in rows)

        # Post-filtering for exact matching if needed
        if needs_post_filter and ids:
            filtered_ids = []
            batch_size = 500

            for i in range(0, len(ids), batch_size):
                batch_ids = ids[i:i + batch_size]
                placeholders = ",".join("?" * len(batch_ids))
                cursor.execute(
                    f"SELECT id, prompt, loras FROM images WHERE id IN ({placeholders})",
                    batch_ids
                )
                batch_data = {row[0]: {'prompt': row[1], 'loras': row[2]} for row in cursor.fetchall()}

                for img_id in batch_ids:
                    if img_id not in batch_data:
                        continue

                    img = batch_data[img_id]

                    # Check prompt tokens (AND logic)
                    if prompt_terms:
                        normalized_prompt_terms = [normalize_prompt_token(t) for t in prompt_terms]
                        image_tokens = extract_prompt_tokens(img.get('prompt', '') or '')
                        if not all(term in image_tokens for term in normalized_prompt_terms):
                            continue

                    # Check LORAs (OR logic)
                    if loras:
                        normalized_loras = [normalize_lora_name(l) for l in loras]
                        image_loras = extract_lora_names(img.get('loras', '') or '', img.get('prompt', '') or '')
                        if not any(lora in image_loras for lora in normalized_loras):
                            continue

                    filtered_ids.append(img_id)

            return filtered_ids

        return ids


def get_images_paginated(
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    sort_by: str = "newest",
    limit: int = 100,
    cursor_id: Optional[int] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    prompt_terms: Optional[List[str]] = None,
    aspect_ratio: Optional[str] = None,
    artist: Optional[str] = None,
    skip_count: bool = False,  # Option to skip expensive COUNT query
) -> Dict[str, Any]:
    """
    Get images with cursor-based pagination for efficient handling of large datasets.

    Uses image ID as the cursor, which works with the primary key index for fast lookups.
    The cursor represents the last image ID from the previous page.

    Args:
        generators: Filter by generator type (OR logic)
        tags: Filter by tags (AND logic - image must have ALL tags)
        ratings: Filter by rating tags (OR logic)
        checkpoints: Filter by checkpoint names (OR logic)
        loras: Filter by lora names (OR logic)
        search_query: Search in prompt text
        sort_by: Sorting method
        limit: Number of images to return (default 100)
        cursor_id: Last image ID from previous page (None for first page)
        min_width, max_width, min_height, max_height: Dimension filters
        prompt_terms: Multi-prompt filter (AND logic)
        aspect_ratio: Filter by aspect ratio
        artist: Filter by artist name
        skip_count: Skip expensive COUNT query (default False for backward compatibility)

    Returns:
        Dictionary with:
        - images: List of image objects
        - next_cursor: ID to use as cursor for next page (None if no more)
        - has_more: Boolean indicating if more pages exist
        - total: Total count matching filters (-1 if skip_count=True)
    """
    with get_db() as conn:
        cursor = conn.cursor()

        # Determine if post-filtering is needed
        needs_post_filter = bool(prompt_terms) or bool(loras)
        select_lightweight = """i.id, i.filename, i.path, i.generator, i.width, i.height,
                       i.file_size, i.checkpoint, i.loras, i.created_at, i.tagged_at"""
        select_full = "i.*"
        select_cols = select_full if needs_post_filter else select_lightweight

        # Build base query with sorting subqueries
        query = _build_base_query(sort_by, select_cols)

        # Initialize conditions and params
        conditions: List[str] = []
        params: List[Any] = []

        # Apply tag filter (JOIN)
        query, params = _apply_tag_filter(query, tags, params)

        # Apply generator filter
        conditions, params = _apply_generator_filter(conditions, params, generators)

        # Apply rating filter
        conditions, params = _apply_rating_filter(conditions, params, ratings)

        # Apply checkpoint filter
        conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

        # Apply lora filter (SQL-level)
        conditions, params = _apply_lora_filter(conditions, params, loras)

        # Apply search filter
        conditions, params = _apply_search_filter(conditions, params, search_query)

        # Apply prompt terms filter
        conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

        # Apply dimension filters
        conditions, params = _apply_dimension_filters(
            conditions, params,
            min_width, max_width, min_height, max_height, aspect_ratio
        )

        # Apply artist filter (JOIN)
        query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

        # Apply cursor condition for pagination
        # Note: Random sort cannot use cursor pagination effectively (each page is truly random)
        # For random sort, we ignore the cursor and return fresh random results
        if cursor_id is not None and sort_by != "random":
            if not _supports_cursor_sort(sort_by):
                raise ValueError(f"Cursor pagination does not support sort_by={sort_by}")
            if sort_by == "newest":
                conditions.append("(i.created_at < (SELECT created_at FROM images WHERE id = ?) OR (i.created_at = (SELECT created_at FROM images WHERE id = ?) AND i.id < ?))")
                params.extend([cursor_id, cursor_id, cursor_id])
            else:
                conditions.append("(i.created_at > (SELECT created_at FROM images WHERE id = ?) OR (i.created_at = (SELECT created_at FROM images WHERE id = ?) AND i.id > ?))")
                params.extend([cursor_id, cursor_id, cursor_id])
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Get order clause and append to query
        order_clause = _get_order_clause(sort_by)

        if needs_post_filter:
            # For post-filtering, fetch more items to ensure we get enough after filtering
            # We fetch limit * 3 to account for filtering
            fetch_limit = limit * 3 + 1
            query += f" ORDER BY {order_clause} LIMIT ?"
            params.append(fetch_limit)
        else:
            # Fetch one extra to check if there are more pages
            query += f" ORDER BY {order_clause} LIMIT ?"
            params.append(limit + 1)

        cursor.execute(query, params)
        rows = cursor.fetchall()
        results = [dict(row) for row in rows]

        # Apply post-filtering for exact matching if needed
        if needs_post_filter:
            results = _post_filter_results(results, prompt_terms, loras, 0, limit + 1)

        # Check if there are more results
        has_more = len(results) > limit
        if has_more:
            results = results[:limit]  # Remove the extra item

        # Get total count for the filter combination
        # Performance optimization: skip expensive COUNT query when not needed
        # Cursor pagination doesn't need total count for navigation
        if skip_count:
            total_count = -1  # Indicate count was skipped
        else:
            total_count = _get_filtered_count(
                conn, generators, tags, ratings, checkpoints, loras,
                search_query, prompt_terms, artist, min_width, max_width,
                min_height, max_height, aspect_ratio
            )

        # Determine next cursor (last item's ID)
        # For random sort, cursor is None since pagination doesn't work with random
        next_cursor = None
        if has_more and results and sort_by != "random":
            next_cursor = str(results[-1]["id"])

        return {
            "images": results,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "total": total_count
        }


def _get_filtered_count(
    conn,
    generators: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
    ratings: Optional[List[str]] = None,
    checkpoints: Optional[List[str]] = None,
    loras: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    prompt_terms: Optional[List[str]] = None,
    artist: Optional[str] = None,
    min_width: Optional[int] = None,
    max_width: Optional[int] = None,
    min_height: Optional[int] = None,
    max_height: Optional[int] = None,
    aspect_ratio: Optional[str] = None,
) -> int:
    """Get total count for filtered images.

    Uses simplified query for performance on large datasets.
    """
    cursor = conn.cursor()

    query = "SELECT COUNT(DISTINCT i.id) FROM images i"
    conditions: List[str] = []
    params: List[Any] = []

    # Apply tag filter (JOIN)
    query, params = _apply_tag_filter(query, tags, params)

    # Apply generator filter
    conditions, params = _apply_generator_filter(conditions, params, generators)

    # Apply rating filter
    conditions, params = _apply_rating_filter(conditions, params, ratings)

    # Apply checkpoint filter
    conditions, params = _apply_checkpoint_filter(conditions, params, checkpoints)

    # Apply lora filter (SQL-level)
    conditions, params = _apply_lora_filter(conditions, params, loras)

    # Apply search filter
    conditions, params = _apply_search_filter(conditions, params, search_query)

    # Apply prompt terms filter
    conditions, params = _apply_prompt_terms_filter(conditions, params, prompt_terms)

    # Apply dimension filters
    conditions, params = _apply_dimension_filters(
        conditions, params,
        min_width, max_width, min_height, max_height, aspect_ratio
    )

    # Apply artist filter (JOIN)
    query, conditions, params = _apply_artist_filter(query, conditions, params, artist)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    cursor.execute(query, params)
    result = cursor.fetchone()
    return result[0] if result else 0


def get_image_by_id(image_id: int) -> Optional[Dict[str, Any]]:
    """Get a single image by ID."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM images WHERE id = ?", (image_id,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_images_by_ids(image_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """Get multiple images by IDs in a single query (avoids N+1).

    Args:
        image_ids: List of image IDs to fetch

    Returns:
        Dictionary mapping image_id -> image data
    """
    if not image_ids:
        return {}

    with get_db() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" * len(image_ids))
        cursor.execute(
            f"SELECT * FROM images WHERE id IN ({placeholders})",
            image_ids
        )
        return {row['id']: dict(row) for row in cursor.fetchall()}


def get_image_tags(image_id: int) -> List[Dict[str, Any]]:
    """Get all tags for an image."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tag, confidence FROM tags WHERE image_id = ? ORDER BY confidence DESC",
            (image_id,)
        )
        return [dict(row) for row in cursor.fetchall()]


def get_all_tags() -> List[Dict[str, Any]]:
    """Get all unique tags with their counts.
    
    Uses in-memory caching with TTL to reduce database load.
    Cache is invalidated after 60 seconds or when tags are modified.
    """
    global _tags_cache_data, _tags_cache_timestamp
    
    current_time = time.time()
    
    # Check cache
    with _tags_cache_lock:
        if _tags_cache_data is not None and (current_time - _tags_cache_timestamp) < _TAGS_CACHE_TTL:
            return _tags_cache_data
    
    # Fetch from database
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT tag, COUNT(*) as count 
            FROM tags 
            GROUP BY tag 
            ORDER BY count DESC
        """)
        result = [dict(row) for row in cursor.fetchall()]
    
    # Update cache
    with _tags_cache_lock:
        _tags_cache_data = result
        _tags_cache_timestamp = current_time
    
    return result


def get_all_generators() -> List[Dict[str, Any]]:
    """Get all generators with their counts."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT generator, COUNT(*) as count 
            FROM images 
            GROUP BY generator 
            ORDER BY count DESC
        """)
        return [dict(row) for row in cursor.fetchall()]


def get_untagged_images(limit: int = 100) -> List[Dict[str, Any]]:
    """Get images that haven't been tagged yet."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM images WHERE tagged_at IS NULL LIMIT ?",
            (limit,)
        )
        return [dict(row) for row in cursor.fetchall()]


def get_all_image_ids() -> List[int]:
    """Return all image IDs (lightweight — no row data loaded).

    Used by the tagging pipeline to avoid loading all image rows into
    memory at once. Callers fetch full rows in small batches.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def get_untagged_image_ids() -> List[int]:
    """Return IDs of images that have not been tagged yet.

    Lightweight counterpart to get_untagged_images(); callers fetch
    full rows in small batches to avoid OOM on large libraries.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM images WHERE tagged_at IS NULL ORDER BY id")
        return [row[0] for row in cursor.fetchall()]


def update_image_path(image_id: int, new_path: str):
    """Update the path of an image (after moving)."""
    with get_db() as conn:
        cursor = conn.cursor()
        normalized_path = os.path.abspath(new_path)
        new_filename = os.path.basename(normalized_path)
        cursor.execute(
            "UPDATE images SET path = ?, filename = ? WHERE id = ?",
            (normalized_path, new_filename, image_id)
        )


def update_image_metadata(
    image_id: int,
    generator: str,
    prompt: Optional[str],
    negative_prompt: Optional[str],
    metadata_json: Optional[str],
    width: Optional[int],
    height: Optional[int],
    file_size: Optional[int],
    checkpoint: Optional[str],
    loras: Optional[List[str]],
):
    """Update parsed metadata fields for an existing image without replacing the row."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE images
            SET generator = ?,
                prompt = ?,
                negative_prompt = ?,
                metadata_json = ?,
                width = ?,
                height = ?,
                file_size = ?,
                checkpoint = ?,
                loras = ?,
                indexed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                generator,
                prompt,
                negative_prompt,
                metadata_json,
                width,
                height,
                file_size,
                checkpoint,
                json.dumps(loras) if loras else None,
                image_id,
            )
        )


def get_collection_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    """Get a collection by slug."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM collections WHERE slug = ?", (slug,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_collection_item(collection_id: int, source_image_id: int) -> Optional[Dict[str, Any]]:
    """Get a collection item by collection and source image IDs."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def add_collection_item(
    collection_id: int,
    source_image_id: int,
    copied_path: str,
    prompt: Optional[str],
    negative_prompt: Optional[str],
    checkpoint: Optional[str],
    loras: Optional[str],
    metadata_json: Optional[str],
    created_at: Optional[datetime],
    width: Optional[int],
    height: Optional[int],
    file_size: Optional[int],
) -> int:
    """Insert or replace a collection snapshot item."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO collection_items (
                collection_id, source_image_id, copied_path, prompt, negative_prompt,
                checkpoint, loras, metadata_json, created_at, width, height, file_size
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(collection_id, source_image_id) DO UPDATE SET
                copied_path = excluded.copied_path,
                prompt = excluded.prompt,
                negative_prompt = excluded.negative_prompt,
                checkpoint = excluded.checkpoint,
                loras = excluded.loras,
                metadata_json = excluded.metadata_json,
                created_at = excluded.created_at,
                width = excluded.width,
                height = excluded.height,
                file_size = excluded.file_size,
                added_at = CURRENT_TIMESTAMP
            """,
            (
                collection_id,
                source_image_id,
                copied_path,
                prompt,
                negative_prompt,
                checkpoint,
                loras,
                metadata_json,
                created_at,
                width,
                height,
                file_size,
            )
        )
        return cursor.lastrowid


def remove_collection_item(collection_id: int, source_image_id: int):
    """Remove a collection item without deleting the copied file."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND source_image_id = ?",
            (collection_id, source_image_id)
        )


def get_favorite_source_ids() -> List[int]:
    """Get all source image IDs currently in Favorites."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT ci.source_image_id
            FROM collection_items ci
            INNER JOIN collections c ON c.id = ci.collection_id
            WHERE c.slug = ?
            """,
            (FAVORITES_COLLECTION_SLUG,)
        )
        return [row[0] for row in cursor.fetchall()]


def get_favorites_count() -> int:
    """Get Favorites item count."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM collection_items ci
            INNER JOIN collections c ON c.id = ci.collection_id
            WHERE c.slug = ?
            """,
            (FAVORITES_COLLECTION_SLUG,)
        )
        return cursor.fetchone()[0]


def delete_image(image_id: int):
    """Delete an image from the database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM images WHERE id = ?", (image_id,))


def get_image_count() -> int:
    """Get total number of images in database."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM images")
        return cursor.fetchone()[0]


# NOTE: init_db() is called by the lifespan handler in main.py.
# Do not call it at module import time to avoid side effects.
