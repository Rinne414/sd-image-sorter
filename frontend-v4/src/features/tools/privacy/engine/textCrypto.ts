// The generation-details crypto, ported from V3.5's obfuscate-engine.js and
// locked to the Big Tomato site by the golden vectors: every UTF-16 unit is
// shifted by the password key. The modern mode shifts the UTF-8 base64 of the
// text; the legacy mode ("旧版 PNG Info 算法") shifts the text itself.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Text(value: string): string {
  const bytes = encoder.encode(value)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function fromBase64Text(value: string): string | null {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return decoder.decode(bytes)
}

function shift(value: string, key: readonly number[], sign: 1 | -1): string {
  return value
    .split('')
    .map((char, index) => String.fromCharCode(char.charCodeAt(0) + sign * key[index % key.length]!))
    .join('')
}

export function encryptText(value: string, key: readonly number[], legacy: boolean): string {
  return shift(legacy ? value : toBase64Text(value), key, 1)
}

/** A wrong key in the modern mode gives '' (not valid base64), as in V3.5. */
export function decryptText(value: string, key: readonly number[], legacy: boolean): string {
  const decoded = shift(value, key, -1)
  if (legacy) return decoded
  return fromBase64Text(decoded) || ''
}
