import { describe, expect, test } from 'vitest'
import { MODIFIERS, PLURALS } from './plural'

// The owner's rules for the words on screen, held for EVERY pack under
// i18n/ (the ones spread into the main packs and the ones read through a
// helper, such as artistText.ts and homeText.ts):
//   a. zh-CN and en have the same keys, pack by pack;
//   b. Chinese has no English words, except real jargon (JARGON below);
//   c. Chinese is simplified and mainland: no traditional-only characters,
//      no Taiwan wording (TAIWAN_WORDS);
//   d. English counts read right when the count is 1.
// Each rule lists every offending key at once.

type Pack = Record<string, string>

const files = import.meta.glob<Record<string, unknown>>(['./zh-CN*.ts', './en*.ts'], { eager: true })

/** The message object a pack file exports. */
const packOf = (mod: Record<string, unknown> | undefined): Pack =>
  (Object.values(mod ?? {}).find((v) => v !== null && typeof v === 'object') ?? {}) as Pack

const zhFiles = Object.keys(files).filter((path) => path.startsWith('./zh-CN'))
const subKeys = new Set(zhFiles.filter((path) => path !== './zh-CN.ts').flatMap((path) => Object.keys(packOf(files[path]))))

/** Every pack: its name, and its own keys (the main pack without the ones it spreads in). */
const PACKS = zhFiles.map((path) => {
  const suffix = path.slice('./zh-CN'.length)
  const name = suffix === '.ts' ? 'main' : suffix.slice(1, -'.ts'.length)
  const zh = packOf(files[path])
  const en = packOf(files[`./en${suffix}`])
  const own = (pack: Pack) => Object.keys(pack).filter((key) => name !== 'main' || !subKeys.has(key))
  return { name, zh, en, zhKeys: own(zh), enKeys: own(en) }
})

// ---- b. English words in Chinese ------------------------------------------

/** Real jargon a Chinese reader sees as it is. */
const JARGON = new Set([
  // models, products, services
  ...['LoRA', 'ONNX', 'WD14', 'WD', 'VLM', 'CLIP', 'CCIP', 'TIPO', 'ToriiGate', 'Ollama', 'Kaloscope', 'PixAI', 'Camie', 'kohya'],
  ...['ComfyUI', 'NovelAI', 'NAI', 'Pixiv', 'Krea', 'Flux', 'FLUX', 'YOLO', 'SAM', 'SAM3', 'NudeNet', 'OppaiOracle', 'Anima', 'Danbooru'],
  ...['Booru', 'Civitai', 'GitHub', 'HuggingFace', 'ModelScope', 'NVIDIA', 'OpenAI', 'Gemini', 'Anthropic', 'Claude', 'Google', 'Vertex'],
  ...['OpenRouter', 'Qwen', 'JoyCaption', 'EVA02', 'SwinV2', 'ViT', 'U2Net', 'UNet', 'rembg', 'Lucida', 'LSNet', 'PyTorch', 'Python'],
  ...['OneTrainer', 'SDXL', 'SD', 'Pony', 'Illustrious', 'NoobAI', 'A1111', 'WebUI', 'Forge', 'SynthID', 'ControlNet', 'FastEmbed', 'T5'],
  ...['VAE', 'MoE', 'GGUF', 'vLLM', 'GPT', 'Excel', 'Windows', 'Linux', 'JavaScript', 'AI', 'seg'],
  // keys
  ...['Ctrl', 'Shift', 'Alt', 'Enter', 'Esc', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'WASD', 'F2', 'F12'],
  // files and formats
  ...['PNG', 'JPEG', 'JPG', 'jpg', 'WebP', 'JSON', 'json', 'JSONL', 'CSV', 'ZIP', 'zip', 'RAR', 'txt', 'onnx', 'pt', 'EXIF'],
  // hardware, web, units
  ...['GPU', 'CPU', 'CUDA', 'API', 'URL', 'HTTP', 'HTTPS', 'http', 'https', 'localhost', 'SOCKS', 'socks5', 'VPN', 'SSD', 'RGB', 'HDR', 'DPI'],
  ...['GB', 'MB', 'KB', 'B', 'MP', 'px', 'ms', 'ID', 'MIT', 'NSFW'],
  // generation and training words
  ...['SEED', 'CFG', 'caption', 'Caption', 'token', 'tokens', 'V3.5', 'Vopus'],
  // a language named in its own language (the language picker)
  'English',
])

/** Jargon of more than one word. */
const JARGON_PHRASES = ['PNG Info', 'GPT Image', 'Clip skip', 'Hugging Face', 'LM Studio', 'SD Image Sorter', 'Class Token', 'Florence-2 Base', 'CL Tagger']

/** Words typed exactly so: the search line's words (V4's search syntax) and folder names on disk. */
const TYPED = new Set([
  ...['general', 'sensitive', 'questionable', 'explicit', 'comfyui', 'nai', 'webui', 'forge', 'square', 'portrait', 'landscape'],
  ...['warm', 'cool', 'neutral', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'brown', 'white', 'black', 'gray'],
  ...['today', '7d', 'YYYY-MM-DD', 'YYYY-MM', 'YYYY', 'score', 'width', 'height', 'brightness', 'saturation', 'unrated'],
  ...['off', 'data', 'models', 'imports', 'kaloscope2.0', 'mychar'],
])

/** Danbooru tags given as examples: tags are English by nature. */
const TAG_EXAMPLES = new Set(['masterpiece', 'solo', 'anime', 'monochrome', 'cat', 'ears', 'animal', 'long', 'hair', 'blue', 'sky', '1girl'])

/** Jargon by shape: a key letter, a version, a size, a model size, a file name, or a name written with _ or - (a tag, a file, a setting). */
const JARGON_SHAPES = [
  /^[A-Za-z]$/,
  /^[vV]\d+(\.\d+)*$/,
  /^\d+x\d+$/,
  /^\d+(\.\d+)?[BMK](-\w+)?$/,
  /^[\w-]+(\.[\w-]+)*\.(txt|json|jsonl|csv|png|jpe?g|webp|db|bat|sh|toml|onnx|pt|pth|com)$/i,
  /^[A-Za-z0-9]+([_-][A-Za-z0-9.]+)+$/,
]

const isJargon = (word: string) => JARGON.has(word) || TYPED.has(word) || TAG_EXAMPLES.has(word) || JARGON_SHAPES.some((shape) => shape.test(word))

/** Written code, left out before words are read: placeholders, search syntax (tag:1girl, score>=7, <lora:…>) and paths (models/yolo). */
const CODE = [/\{[\w.:]+\}/g, /-?[A-Za-z][\w-]*(?::+|>=|<=)[^\s，。、；：（）()]*/g, /[\w.-]+(?:\/[\w.*-]+)+/g]

/** The Latin words in a Chinese string that are not code or jargon phrases. */
function latinWords(text: string): string[] {
  let rest = text
  for (const code of CODE) rest = rest.replace(code, ' ')
  for (const phrase of JARGON_PHRASES) rest = rest.split(phrase).join(' ')
  return rest.match(/[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*(?:[._'-][A-Za-z0-9]+)*/g) ?? []
}

// ---- c. traditional characters and Taiwan wording --------------------------

/** Characters written only in traditional Chinese (their simplified forms differ). */
const TRADITIONAL =
  '這個們說時會從對開關後還與點圖標籤選擇顯載儲錄為無當將過裡體實應並單處請讓間認數據讀寫刪變換動產區條項況態類網絡碼義號級發現環驗證確視頁線鍵螢軟覽設訊檔資準隱複製貼輸錯誤記憶執緒務陣啟結繼續暫總計術雙擊壓縮檢測試進權帳戶聯匯導幀擷儘僅盡來麼嗎邊頭興歷紀較達運轉專業習慣獲難題簡極協議勢備邏輯隨種劃擴屬節詞彙譯響傳鏈寬顏暈臉髮膚鏡攝畫風語狀調頻預夾範盤機歡謝殘須筆濾濃淺襯衛'

/** Taiwan wording, in the simplified characters a mainland reader would still stumble on. */
const TAIWAN_WORDS = [
  '档案', '资料夹', '资料', '设定', '程式', '影片', '视窗', '选单', '软体', '硬碟', '网路', '萤幕', '滑鼠', '资讯', '讯息',
  '储存', '重新整理', '缩图', '套件', '伺服器', '列印', '游标', '物件', '支援', '记忆体', '使用者', '帐号', '帐户', '介面',
  '品质', '解析度', '自订', '连结', '汇入', '汇出', '贴上', '快取', '登入', '登出', '撷取', '位元', '数位', '相容', '执行绪',
  '影像', '图档', '透过', '即时', '效能', '显示卡', '晶片', '范例', '搜寻', '档名', '点选', '预设值',
]

// ---- d. English counts -----------------------------------------------------

/**
 * A count with a plural noun after it reads right when format() writes the
 * singular for 1 (plural.ts): the noun is in PLURALS, and a word between the
 * count and the noun is in MODIFIERS. A plural-looking word right after a
 * count must be one of those nouns, or no noun at all (NOT_NOUNS). A fixed
 * "1" is never followed by a plural.
 */
const NOT_NOUNS = new Set(['is', 'as', 'has', 'was', 'this', 'its', 'ms', 's', 'yes', 'plus', 'less', 'across', 'unless', 'thus', 'whose', 'does', 'needs'])

/** Words that start a phrase after a count but never modify its noun ("{n} from folders"). */
const NOT_MODIFIERS = new Set(['from', 'with', 'without', 'of', 'in', 'into', 'to', 'for', 'on', 'at', 'by', 'and', 'or', 'as', 'than', 'the'])

function countProblems(text: string): string[] {
  const problems: string[] = []
  for (const [phrase, next, after] of text.matchAll(/\{\w+\} ([a-z-]+)(?: ([a-z]+))?/g)) {
    if (!next || PLURALS[next]) continue
    if (after && PLURALS[after]) {
      if (!MODIFIERS.has(next) && !NOT_MODIFIERS.has(next)) problems.push(`"${phrase}": add "${next}" to MODIFIERS or reword`)
    } else if (next.endsWith('s') && !NOT_NOUNS.has(next)) {
      problems.push(`"${phrase}": add "${next}" to PLURALS or reword`)
    }
  }
  for (const [phrase, noun] of text.matchAll(/\b1 ([a-z]+)\b/g)) if (noun && PLURALS[noun]) problems.push(`"${phrase}": a fixed 1 before a plural`)
  for (const [phrase] of text.matchAll(/\bthese \{\w+\}/g)) problems.push(`"${phrase}": write "the {n}" ("these 1" reads wrong)`)
  // "1 of 5 images are": format() does not reach a verb past "of", so such a sentence is reworded
  for (const [phrase] of text.matchAll(/\{\w+\} of [^,.;:!?]*? (?:are|were|have)\b/g)) problems.push(`"${phrase}": reword, the count takes a singular verb when it is 1`)
  return problems
}

const report = (rows: string[][]) => rows.flat()

describe('the language packs', () => {
  test('a. zh-CN and en have the same keys, pack by pack', () => {
    const rows = PACKS.map(({ name, zhKeys, enKeys }) => {
      const en = new Set(enKeys)
      const zh = new Set(zhKeys)
      return [...zhKeys.filter((k) => !en.has(k)).map((k) => `${name}: ${k} is missing in en`), ...enKeys.filter((k) => !zh.has(k)).map((k) => `${name}: ${k} is only in en`)]
    })
    expect(PACKS.length).toBeGreaterThan(20)
    expect(report(rows)).toEqual([])
  })

  test('b. Chinese has no English words except the jargon list', () => {
    const rows = PACKS.map(({ name, zh, zhKeys }) =>
      zhKeys.flatMap((key) => {
        const words = latinWords(zh[key] ?? '').filter((w) => !isJargon(w))
        return words.length ? [`${name}: ${key}: ${[...new Set(words)].join(', ')}`] : []
      }),
    )
    expect(report(rows)).toEqual([])
  })

  test('c. Chinese is simplified and mainland: no traditional characters, no Taiwan wording', () => {
    const rows = PACKS.map(({ name, zh, zhKeys }) =>
      zhKeys.flatMap((key) => {
        const text = zh[key] ?? ''
        const found = [...new Set([...text].filter((ch) => TRADITIONAL.includes(ch))), ...TAIWAN_WORDS.filter((w) => text.includes(w))]
        return found.length ? [`${name}: ${key}: ${found.join(', ')}`] : []
      }),
    )
    expect(report(rows)).toEqual([])
  })

  test('d. English counts read right when the count is 1', () => {
    const rows = PACKS.map(({ name, en, enKeys }) =>
      enKeys.flatMap((key) => countProblems(en[key] ?? '').map((p) => `${name}: ${key}: ${p}`)),
    )
    expect(report(rows)).toEqual([])
  })
})
