# backend/assets — bundled data files

## danbooru_tags.csv (bundled)

Danbooru tag vocabulary used by `GET /api/tags/suggest` (tag autocomplete).

- Source: [DominikDoom/a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete)
  (`tags/danbooru.csv`), MIT License.
- Shape: `tag,category_code,post_count,"alias1,alias2,..."` sorted by post
  count descending. Category codes: 0 general, 1 artist, 3 copyright,
  4 character, 5 meta.
- Loaded lazily by `services/tag_suggest_service.py`. If the file is
  missing the endpoint degrades to library-tags-only suggestions.

## danbooru_zh.csv (OPTIONAL drop-in — NOT bundled)

Chinese tag translations enabling CJK fuzzy queries (typing 长发 suggests
`long_hair`) and zh subtitles in suggestion dropdowns.

Not shipped: the known public translation datasets (e.g. the
`tags_enhanced.csv` from the DanbooruSearch HuggingFace space) are
GPL-3.0-licensed, which we do not bundle into release packages. Users can
drop a copy in themselves for personal use.

- Search order: `<DATA_DIR>/danbooru_zh.csv` (survives upgrades — preferred),
  then `backend/assets/danbooru_zh.csv`.
- Accepted shape: CSV where column 1 is the tag name and column 2 is a
  comma-joined list of Chinese aliases. A header row is auto-detected.
  `tags_enhanced.csv` (`name,cn_name,wiki,post_count,category,nsfw`) from
  https://huggingface.co/spaces/SAkizuki/DanbooruSearch works unmodified —
  download `origin_database/tags_enhanced.csv` and rename it.
