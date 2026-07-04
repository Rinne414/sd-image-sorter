/**
 * Gallery search query language (owner request 2026-07-05, "killer function").
 *
 * Pure parser — no DOM, no fetch. gallery-toolbar.js owns the UI (input,
 * parse-preview chips, autocomplete, help modal) and applies the parse result
 * onto the SAME FilterStore fields the filter modal writes; the backend query
 * params are untouched (everything here maps onto filters that already
 * exist). Grammar:
 *
 *   key:value          assign (":" "=" "==" are equivalent)
 *   key>=n key<=n      numeric bounds ("<" and ">" are treated as the
 *                      inclusive bound — the preview chip shows ≥/≤ so the
 *                      user always sees what actually applies)
 *   key:a..b           numeric range
 *   -key:value         negate (tag/generator/rating/checkpoint/lora/prompt/
 *                      color only)
 *   "quoted value"     values with spaces
 *   contains(text)     sugar for free text
 *   anything else      free text (searches filename / checkpoint / prompt)
 *
 * Chinese key + enum-value aliases are first-class so the zh-CN placeholder
 * examples work as typed.
 */
(function () {
    'use strict';

    const GENERATOR_VALUES = [
        'comfyui', 'nai', 'webui', 'forge', 'reforge', 'fooocus',
        'easy-diffusion', 'invokeai', 'swarmui', 'drawthings', 'gemini',
        'gpt-image', 'others', 'unknown',
    ];

    const RATING_ALIASES = {
        general: 'general', g: 'general', 普通: 'general',
        sensitive: 'sensitive', s: 'sensitive', 敏感: 'sensitive',
        questionable: 'questionable', q: 'questionable', 可疑: 'questionable',
        explicit: 'explicit', e: 'explicit', 限制级: 'explicit',
    };

    const ASPECT_ALIASES = {
        square: 'square', 方图: 'square', 方: 'square',
        portrait: 'portrait', 竖图: 'portrait', 竖: 'portrait',
        landscape: 'landscape', 横图: 'landscape', 横: 'landscape',
    };

    const TEMPERATURE_ALIASES = {
        warm: 'warm', 暖: 'warm', 暖色: 'warm',
        cool: 'cool', 冷: 'cool', 冷色: 'cool',
        neutral: 'neutral', 中性: 'neutral',
    };

    // v3.5.0: dominant-hue values for color:. Backed by the
    // dominant_color_tags column (write-time classification of the top-5
    // dominant colors). Temperature words above keep their old meaning.
    const HUE_ALIASES = {
        red: 'red', 红: 'red', 红色: 'red',
        orange: 'orange', 橙: 'orange', 橙色: 'orange',
        yellow: 'yellow', 黄: 'yellow', 黄色: 'yellow',
        green: 'green', 绿: 'green', 绿色: 'green',
        cyan: 'cyan', 青: 'cyan', 青色: 'cyan',
        blue: 'blue', 蓝: 'blue', 蓝色: 'blue',
        purple: 'purple', 紫: 'purple', 紫色: 'purple',
        pink: 'pink', 粉: 'pink', 粉色: 'pink', 粉红: 'pink',
        brown: 'brown', 棕: 'brown', 棕色: 'brown', 褐色: 'brown',
        white: 'white', 白: 'white', 白色: 'white',
        black: 'black', 黑: 'black', 黑色: 'black',
        gray: 'gray', grey: 'gray', 灰: 'gray', 灰色: 'gray',
    };
    const HUE_VALUES = [
        'red', 'orange', 'yellow', 'green', 'cyan', 'blue',
        'purple', 'pink', 'brown', 'white', 'black', 'gray',
    ];

    const DISTRIBUTION_VALUES = [
        'left_heavy', 'right_heavy', 'middle_heavy', 'edge_heavy', 'balanced',
    ];

    // canonical key -> handler kind. Aliases (en + zh) resolve into these.
    const KEY_ALIASES = {
        tag: 'tag', 标签: 'tag',
        checkpoint: 'checkpoint', model: 'checkpoint', 模型: 'checkpoint',
        lora: 'lora',
        prompt: 'prompt', 提示词: 'prompt', 提示: 'prompt',
        generator: 'generator', gen: 'generator', 生成器: 'generator',
        rating: 'rating', 分级: 'rating',
        score: 'score', aesthetic: 'score', 美学: 'score',
        stars: 'stars', star: 'stars', 星级: 'stars',
        width: 'width', 宽: 'width', 宽度: 'width',
        height: 'height', 高: 'height', 高度: 'height',
        size: 'size', 尺寸: 'size',
        aspect: 'aspect', ratio: 'aspect', 比例: 'aspect',
        color: 'color', theme: 'color', temp: 'color', temperature: 'color',
        颜色: 'color', 主题: 'color', 色温: 'color',
        light: 'light', dist: 'light', 光影: 'light',
        brightness: 'brightness', bright: 'brightness', 亮度: 'brightness',
        saturation: 'saturation', sat: 'saturation', 饱和度: 'saturation',
        seed: 'seed', 种子: 'seed',
        artist: 'artist', 画师: 'artist',
        folder: 'folder', 文件夹: 'folder',
        has: 'has', 有: 'has',
        no: 'no', 无: 'no',
    };

    // Keys whose values autocomplete from a library endpoint (toolbar uses this).
    const AUTOCOMPLETE_KEYS = {
        tag: 'tags',
        checkpoint: 'checkpoints',
        lora: 'loras',
        prompt: 'prompts',
    };

    // Static value suggestions for enum keys (toolbar autocomplete).
    const ENUM_SUGGESTIONS = {
        generator: GENERATOR_VALUES,
        rating: ['general', 'sensitive', 'questionable', 'explicit'],
        aspect: ['square', 'portrait', 'landscape'],
        color: ['warm', 'cool', 'neutral',
            'red', 'orange', 'yellow', 'green', 'cyan', 'blue',
            'purple', 'pink', 'brown', 'white', 'black', 'gray'],
        light: DISTRIBUTION_VALUES,
        has: ['params'],
        no: ['params', 'caption'],
        score: ['none'],
    };

    const NEGATABLE = new Set(['tag', 'checkpoint', 'lora', 'prompt', 'generator', 'rating', 'color']);

    // Help-modal rows. `syntax`/`example` are literal; desc comes from i18n.
    const SYNTAX_ROWS = [
        { syntax: 'free text', example: 'silver hair', descKey: 'searchHelp.free' },
        { syntax: 'tag:VALUE', example: 'tag:silver_hair', descKey: 'searchHelp.tag' },
        { syntax: '-tag:VALUE', example: '-tag:blurry', descKey: 'searchHelp.negate' },
        { syntax: 'prompt:VALUE', example: 'prompt:"long hair"', descKey: 'searchHelp.prompt' },
        { syntax: 'checkpoint:VALUE', example: 'model:noobai', descKey: 'searchHelp.checkpoint' },
        { syntax: 'lora:VALUE', example: 'lora:detailer', descKey: 'searchHelp.lora' },
        { syntax: 'generator:VALUE', example: 'gen:nai', descKey: 'searchHelp.generator' },
        { syntax: 'rating:VALUE', example: 'rating:general', descKey: 'searchHelp.rating' },
        { syntax: 'score OP N', example: 'score>=7', descKey: 'searchHelp.score' },
        { syntax: 'score:none', example: 'score:none', descKey: 'searchHelp.scoreNone' },
        { syntax: 'stars>=N', example: 'stars>=4', descKey: 'searchHelp.stars' },
        { syntax: 'width / height OP N', example: 'width>=1024 height<=2048', descKey: 'searchHelp.dimensions' },
        { syntax: 'size:WxH', example: 'size:1024x1536', descKey: 'searchHelp.size' },
        { syntax: 'aspect:VALUE', example: 'aspect:portrait', descKey: 'searchHelp.aspect' },
        { syntax: 'color:VALUE', example: 'color:warm', descKey: 'searchHelp.color' },
        { syntax: 'brightness / saturation OP N', example: 'brightness>=180 sat<=60', descKey: 'searchHelp.brightness' },
        { syntax: 'seed:N', example: 'seed:314159', descKey: 'searchHelp.seed' },
        { syntax: 'artist:VALUE', example: 'artist:wlop', descKey: 'searchHelp.artist' },
        { syntax: 'folder:VALUE', example: 'folder:keep', descKey: 'searchHelp.folder' },
        { syntax: 'has:params / no:params', example: 'has:params', descKey: 'searchHelp.hasParams' },
        { syntax: 'no:caption', example: 'no:caption', descKey: 'searchHelp.noCaption' },
        { syntax: 'key:a..b', example: 'score:6..8', descKey: 'searchHelp.range' },
        { syntax: 'contains(text)', example: 'contains(red)', descKey: 'searchHelp.contains' },
    ];

    function emptyResult() {
        return {
            tags: [], excludeTags: [],
            checkpoints: [], excludeCheckpoints: [],
            loras: [], excludeLoras: [],
            prompts: [], excludePrompts: [],
            generators: [], excludeGenerators: [],
            ratings: [], excludeRatings: [],
            excludeColors: [],
            colorHues: [], excludeColorHues: [],
            scalars: {},
            freeText: [],
            parts: [],
            warnings: [],
        };
    }

    function stripQuotes(value) {
        return String(value || '').replace(/^"|"$/g, '').trim();
    }

    function toNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    /** `score >= 7` → `score>=7` so whitespace around operators is legal. */
    function tightenOperators(raw) {
        let text = String(raw || '');
        text = text.replace(/([A-Za-z一-鿿_]+)\s*(>=|<=|==|!=)\s*/g, '$1$2');
        text = text.replace(/([A-Za-z一-鿿_]+)\s*([<>])\s*(?=[\d"])/g, '$1$2');
        return text;
    }

    function pushFilterPart(result, key, op, value) {
        result.parts.push({ kind: 'filter', key, op, value });
    }

    function pushWarning(result, raw, reasonKey, hint) {
        result.warnings.push({ raw, reasonKey, hint: hint || '' });
        result.parts.push({ kind: 'warn', key: null, op: '', value: raw, reasonKey, hint: hint || '' });
    }

    function pushFree(result, text) {
        if (!text) return;
        result.freeText.push(text);
    }

    function setBound(result, minField, maxField, op, num, key) {
        if (op === '>=' || op === '>') {
            result.scalars[minField] = num;
            pushFilterPart(result, key, '≥', String(num));
        } else if (op === '<=' || op === '<') {
            result.scalars[maxField] = num;
            pushFilterPart(result, key, '≤', String(num));
        } else {
            result.scalars[minField] = num;
            result.scalars[maxField] = num;
            pushFilterPart(result, key, '=', String(num));
        }
    }

    function setRange(result, minField, maxField, lo, hi, key) {
        result.scalars[minField] = Math.min(lo, hi);
        result.scalars[maxField] = Math.max(lo, hi);
        pushFilterPart(result, key, '=', `${Math.min(lo, hi)}..${Math.max(lo, hi)}`);
    }

    /** Parse `a..b` → [a, b] or null. */
    function parseRange(value) {
        const m = String(value).match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
        if (!m) return null;
        const lo = toNumber(m[1]);
        const hi = toNumber(m[2]);
        return lo != null && hi != null ? [lo, hi] : null;
    }

    function handleNumericKey(result, key, op, value, minField, maxField, raw) {
        const range = parseRange(value);
        if (range) {
            setRange(result, minField, maxField, range[0], range[1], key);
            return;
        }
        const num = toNumber(value);
        if (num == null) {
            pushWarning(result, raw, 'searchWarn.number');
            return;
        }
        setBound(result, minField, maxField, op, num, key);
    }

    function handleToken(result, token) {
        // contains(text) sugar → free text.
        const containsMatch = token.match(/^contains\((.*)\)$/i);
        if (containsMatch) {
            const inner = stripQuotes(containsMatch[1]);
            if (inner) {
                pushFree(result, inner);
                result.parts.push({ kind: 'free', key: null, op: '', value: inner });
            }
            return;
        }

        let body = token;
        let negated = false;
        if (body.startsWith('-') && body.length > 1) {
            negated = true;
            body = body.slice(1);
        }

        // Longest operators first; ":" and "=" are the assign forms.
        const opMatch = body.match(/^([^:<>=!]+?)(>=|<=|==|!=|:|=|>|<)(.*)$/);
        if (!opMatch) {
            const text = stripQuotes(token);
            pushFree(result, text);
            if (text) result.parts.push({ kind: 'free', key: null, op: '', value: text });
            return;
        }

        const rawKey = opMatch[1].trim().toLowerCase();
        let op = opMatch[2];
        const value = stripQuotes(opMatch[3]);
        const key = KEY_ALIASES[rawKey] || KEY_ALIASES[opMatch[1].trim()];

        if (!key || !value) {
            // Unknown key or empty value: keep the old behavior (free text).
            const text = stripQuotes(token);
            pushFree(result, text);
            if (text) result.parts.push({ kind: 'free', key: null, op: '', value: text });
            return;
        }

        if (op === '!=') {
            negated = true;
            op = ':';
        }
        if (op === '==' || op === '=') op = ':';

        if (negated && !NEGATABLE.has(key)) {
            pushWarning(result, token, 'searchWarn.notNegatable');
            return;
        }

        switch (key) {
            case 'tag':
                (negated ? result.excludeTags : result.tags).push(value);
                pushFilterPart(result, negated ? '-tag' : 'tag', '', value);
                return;
            case 'checkpoint':
                (negated ? result.excludeCheckpoints : result.checkpoints).push(value);
                pushFilterPart(result, negated ? '-checkpoint' : 'checkpoint', '', value);
                return;
            case 'lora':
                (negated ? result.excludeLoras : result.loras).push(value);
                pushFilterPart(result, negated ? '-lora' : 'lora', '', value);
                return;
            case 'prompt':
                (negated ? result.excludePrompts : result.prompts).push(value);
                pushFilterPart(result, negated ? '-prompt' : 'prompt', '', value);
                return;
            case 'generator': {
                const gen = value.toLowerCase();
                if (!GENERATOR_VALUES.includes(gen)) {
                    pushWarning(result, token, 'searchWarn.generator', GENERATOR_VALUES.slice(0, 6).join(', ') + '…');
                    return;
                }
                (negated ? result.excludeGenerators : result.generators).push(gen);
                pushFilterPart(result, negated ? '-generator' : 'generator', '', gen);
                return;
            }
            case 'rating': {
                const rating = RATING_ALIASES[value.toLowerCase()];
                if (!rating) {
                    pushWarning(result, token, 'searchWarn.rating', 'general / sensitive / questionable / explicit');
                    return;
                }
                (negated ? result.excludeRatings : result.ratings).push(rating);
                pushFilterPart(result, negated ? '-rating' : 'rating', '', rating);
                return;
            }
            case 'score': {
                if (value.toLowerCase() === 'none') {
                    result.scalars.aestheticUnscored = true;
                    pushFilterPart(result, 'score', '=', 'none');
                    return;
                }
                handleNumericKey(result, 'score', op, value, 'minAesthetic', 'maxAesthetic', token);
                return;
            }
            case 'stars': {
                const num = toNumber(value);
                if (num == null) {
                    pushWarning(result, token, 'searchWarn.number');
                    return;
                }
                if (op === '<=' || op === '<') {
                    pushWarning(result, token, 'searchWarn.starsMinOnly');
                    return;
                }
                result.scalars.minUserRating = Math.max(1, Math.min(5, Math.trunc(num)));
                pushFilterPart(result, 'stars', '≥', String(result.scalars.minUserRating));
                return;
            }
            case 'width':
                handleNumericKey(result, 'width', op, value, 'minWidth', 'maxWidth', token);
                return;
            case 'height':
                handleNumericKey(result, 'height', op, value, 'minHeight', 'maxHeight', token);
                return;
            case 'size': {
                const m = value.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
                if (!m) {
                    pushWarning(result, token, 'searchWarn.size');
                    return;
                }
                result.scalars.minWidth = Number(m[1]);
                result.scalars.maxWidth = Number(m[1]);
                result.scalars.minHeight = Number(m[2]);
                result.scalars.maxHeight = Number(m[2]);
                pushFilterPart(result, 'size', '=', `${m[1]}x${m[2]}`);
                return;
            }
            case 'aspect': {
                const aspect = ASPECT_ALIASES[value.toLowerCase()];
                if (!aspect) {
                    pushWarning(result, token, 'searchWarn.aspect', 'square / portrait / landscape');
                    return;
                }
                result.scalars.aspectRatio = aspect;
                pushFilterPart(result, 'aspect', '', aspect);
                return;
            }
            case 'color': {
                const lowered = value.toLowerCase();
                const temperature = TEMPERATURE_ALIASES[lowered];
                if (temperature) {
                    if (negated) {
                        result.excludeColors.push(temperature);
                        pushFilterPart(result, '-color', '', temperature);
                    } else {
                        result.scalars.colorTemperature = temperature;
                        pushFilterPart(result, 'color', '', temperature);
                    }
                    return;
                }
                const hue = HUE_ALIASES[lowered];
                if (!hue) {
                    pushWarning(result, token, 'searchWarn.color',
                        `warm / cool / neutral / ${HUE_VALUES.join(' / ')}`);
                    return;
                }
                if (negated) {
                    result.excludeColorHues.push(hue);
                    pushFilterPart(result, '-color', '', hue);
                } else {
                    result.colorHues.push(hue);
                    pushFilterPart(result, 'color', '', hue);
                }
                return;
            }
            case 'light': {
                const dist = value.toLowerCase();
                if (!DISTRIBUTION_VALUES.includes(dist)) {
                    pushWarning(result, token, 'searchWarn.light', DISTRIBUTION_VALUES.join(' / '));
                    return;
                }
                result.scalars.brightnessDistribution = dist;
                pushFilterPart(result, 'light', '', dist);
                return;
            }
            case 'brightness':
                handleNumericKey(result, 'brightness', op, value, 'brightnessMin', 'brightnessMax', token);
                return;
            case 'saturation':
                handleNumericKey(result, 'saturation', op, value, 'minSaturation', 'maxSaturation', token);
                return;
            case 'seed': {
                const num = toNumber(value);
                if (num == null) {
                    pushWarning(result, token, 'searchWarn.number');
                    return;
                }
                result.scalars.seed = Math.trunc(num);
                pushFilterPart(result, 'seed', '=', String(Math.trunc(num)));
                return;
            }
            case 'artist':
                result.scalars.artist = value;
                pushFilterPart(result, 'artist', '', value);
                return;
            case 'folder':
                result.scalars.folder = value;
                pushFilterPart(result, 'folder', '', value);
                return;
            case 'has': {
                const what = value.toLowerCase();
                if (what === 'params' || what === 'metadata' || what === '参数') {
                    result.scalars.hasMetadata = true;
                    pushFilterPart(result, 'has', '', 'params');
                    return;
                }
                pushWarning(result, token, 'searchWarn.has', 'has:params');
                return;
            }
            case 'no': {
                const what = value.toLowerCase();
                if (what === 'params' || what === 'metadata' || what === '参数') {
                    result.scalars.hasMetadata = false;
                    pushFilterPart(result, 'no', '', 'params');
                    return;
                }
                if (what === 'caption' || what === '字幕' || what === '描述') {
                    result.scalars.noCaption = true;
                    pushFilterPart(result, 'no', '', 'caption');
                    return;
                }
                pushWarning(result, token, 'searchWarn.no', 'no:params / no:caption');
                return;
            }
            default:
                pushFree(result, stripQuotes(token));
        }
    }

    function parse(raw) {
        const result = emptyResult();
        const tightened = tightenOperators(raw);
        const tokens = tightened.match(/(?:[^\s"]+"[^"]*"|[^\s"]+|"[^"]*")+/g) || [];
        tokens.forEach((token) => handleToken(result, token));
        return result;
    }

    /** Token boundaries around a caret position — the autocomplete anchor. */
    function tokenAtCaret(text, caret) {
        const value = String(text || '');
        const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
        let start = position;
        while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
        let end = position;
        while (end < value.length && !/\s/.test(value[end])) end += 1;
        return { start, end, token: value.slice(start, end) };
    }

    /**
     * If the caret token looks like `key:partial`, describe what to suggest.
     * Returns { source: 'library'|'enum', endpointKey|values, key, prefix,
     * negated, valueStart, tokenStart, tokenEnd } or null.
     */
    function suggestionContext(text, caret) {
        const { start, end, token } = tokenAtCaret(text, caret);
        if (!token) return null;
        let body = token;
        let negated = false;
        if (body.startsWith('-') && body.length > 1) {
            negated = true;
            body = body.slice(1);
        }
        const m = body.match(/^([^:<>=!]+?)(:|==|=)(.*)$/);
        if (!m) return null;
        const key = KEY_ALIASES[m[1].trim().toLowerCase()] || KEY_ALIASES[m[1].trim()];
        if (!key) return null;
        const prefix = stripQuotes(m[3]);
        const valueStart = start + (negated ? 1 : 0) + m[1].length + m[2].length;
        if (AUTOCOMPLETE_KEYS[key]) {
            if (!prefix) return null; // wait for at least one char before hitting the API
            return { source: 'library', endpointKey: AUTOCOMPLETE_KEYS[key], key, prefix, negated, valueStart, tokenStart: start, tokenEnd: end };
        }
        if (ENUM_SUGGESTIONS[key]) {
            return { source: 'enum', values: ENUM_SUGGESTIONS[key], key, prefix, negated, valueStart, tokenStart: start, tokenEnd: end };
        }
        return null;
    }

    window.GallerySearchQuery = {
        parse,
        tokenAtCaret,
        suggestionContext,
        SYNTAX_ROWS,
        ENUM_SUGGESTIONS,
        AUTOCOMPLETE_KEYS,
    };
})();
