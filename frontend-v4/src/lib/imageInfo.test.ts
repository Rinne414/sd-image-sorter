import { describe, expect, test } from 'vitest'
import { formatScore, modelFilterValue, noParamsReason, readImageInfo } from './imageInfo'

const meta = (parsed: Record<string, unknown>) => JSON.stringify({ _parsed: parsed })
const input = (parsed: Record<string, unknown>, extra: Partial<{ model_hash: string | null; checkpoint: string | null }> = {}) => ({
  metadata_json: meta(parsed),
  model_hash: null,
  checkpoint: null,
  ...extra,
})

describe('img2img', () => {
  test('marked with its kind and every detail, the denoise and noise as numbers', () => {
    const info = readImageInfo(input({ is_img2img: true, img2img_info: { denoising_strength: 0.45, noise: 0.1, source: 'img2img', mask_blur: 4 } }))
    expect(info.img2img).toEqual({ kind: 'img2img', denoise: '0.45', noise: '0.1', other: [['mask_blur', '4']] })
  })

  test('inpaint, hires fix and latent upscale keep their kind; an unknown kind is kept as written', () => {
    expect(readImageInfo(input({ is_img2img: true, img2img_info: { source: 'inpaint' } })).img2img?.kind).toBe('inpaint')
    expect(readImageInfo(input({ is_img2img: true, img2img_info: { source: 'latent upscale', denoising_strength: 0.7 } })).img2img?.kind).toBe('latent upscale')
    expect(readImageInfo(input({ is_img2img: true, img2img_info: { source: 'tile' } })).img2img?.kind).toBe('tile')
  })

  test('not img2img (a hires fix pass on a txt2img image) shows no marker', () => {
    expect(readImageInfo(input({ is_img2img: false, img2img_info: { source: 'hires fix', denoising_strength: 0.4 } })).img2img).toBeNull()
  })

  test('img2img without details still gets the marker', () => {
    expect(readImageInfo(input({ is_img2img: true, img2img_info: null })).img2img).toEqual({ kind: null, denoise: null, noise: null, other: [] })
  })
})

describe('Civitai resources', () => {
  test('name, version, weight, kind from the AIR, and the link', () => {
    const info = readImageInfo(
      input({
        civitai_resources: [
          { model_name: 'Detail Tweaker', version_name: 'v1.0', weight: 0.8, air: 'urn:air:sdxl:lora:civitai:58390@62833', civitai_url: 'https://civitai.red/models/58390?modelVersionId=62833' },
          { model_name: 'Base', version_name: null, weight: null, air: 'urn:air:sdxl:checkpoint:civitai:1@2', civitai_url: null },
        ],
      }),
    )
    expect(info.civitai).toEqual([
      { name: 'Detail Tweaker', version: 'v1.0', weight: '0.8', kind: 'lora', url: 'https://civitai.red/models/58390?modelVersionId=62833' },
      { name: 'Base', version: null, weight: null, kind: 'checkpoint', url: null },
    ])
  })

  test('a link that is not http(s) is dropped, never made clickable', () => {
    const info = readImageInfo(input({ civitai_resources: [{ model_name: 'x', civitai_url: 'javascript:alert(1)', air: '' }] }))
    expect(info.civitai[0]?.url).toBeNull()
  })
})

describe('ComfyUI prompt nodes', () => {
  test('each text node with its id, type and role', () => {
    const info = readImageInfo(
      input({
        prompt_nodes: [
          { node_id: '12', class_type: 'CLIPTextEncode', text: 'score_9, 1girl', role: 'positive' },
          { node_id: '76:6', class_type: 'CLIPTextEncode', text: 'lowres', role: 'negative' },
          { node_id: '9', class_type: 'X', text: '   ', role: 'positive' },
        ],
      }),
    )
    expect(info.nodes).toEqual([
      { id: '12', type: 'CLIPTextEncode', role: 'positive', text: 'score_9, 1girl' },
      { id: '76:6', type: 'CLIPTextEncode', role: 'negative', text: 'lowres' },
    ])
  })
})

describe('models', () => {
  test('the hash comes from the image, else from the parameters', () => {
    expect(readImageInfo(input({}, { model_hash: '04ba0dfcc1' })).modelHash).toBe('04ba0dfcc1')
    expect(readImageInfo(input({ generation_params: { model_hash: 'abc123' } })).modelHash).toBe('abc123')
    expect(readImageInfo(input({})).modelHash).toBeNull()
  })

  test('LoRA strengths from the ComfyUI loaders, matched by file name', () => {
    const info = readImageInfo(
      input({
        generation_params: {
          lora_details: [
            { name: 'styles\\Detail.safetensors', strength_model: 0.8, strength_clip: 0.8 },
            { name: 'eyes.safetensors', strength_model: 1, strength_clip: 0.5 },
          ],
        },
      }),
    )
    expect(info.loraWeight('Detail')).toBe('0.8')
    expect(info.loraWeight('EYES.safetensors')).toBe('1 / 0.5')
    expect(info.loraWeight('other')).toBeNull()
  })

  test('the other models of a workflow, each once, the main model left out; guessed ones kept apart', () => {
    const info = readImageInfo(
      input(
        {
          model_assets: {
            primary_model_name: 'anima.safetensors',
            checkpoint_candidates: [{ name: 'anima.safetensors' }, { name: 'sam_vit_b.pth' }, { name: 'sam_vit_b.pth' }],
            vae_candidates: [{ name: 'ae.safetensors' }],
            clip_candidates: [{ name: 'qwen.safetensors' }],
            model_candidates: [{ name: 'RealESRGAN_x4plus.pth' }],
            yolo_models: ['face_yolov8m.pt'],
            global_lora_candidates: [{ name: 'unused_lora' }],
          },
        },
        { checkpoint: 'anima.safetensors' },
      ),
    )
    expect(info.otherModels).toEqual([
      { group: 'checkpoint', names: ['sam_vit_b.pth'] },
      { group: 'vae', names: ['ae.safetensors'] },
      { group: 'clip', names: ['qwen.safetensors'] },
      { group: 'other', names: ['RealESRGAN_x4plus.pth'] },
      { group: 'detector', names: ['face_yolov8m.pt'] },
      { group: 'guessLora', names: ['unused_lora'] },
    ])
  })

  test('no metadata at all is nothing to show, not an error', () => {
    const info = readImageInfo({ metadata_json: 'not json', model_hash: null, checkpoint: null })
    expect(info).toMatchObject({ img2img: null, civitai: [], nodes: [], otherModels: [], modelHash: null })
  })

  test('the filter value of a model is its file name without folder, hash suffix or extension', () => {
    expect(modelFilterValue('Anima\\anima_baseV10.safetensors')).toBe('anima_baseV10')
    expect(modelFilterValue('waiNSFW_v70 [04ba0dfcc1]')).toBe('waiNSFW_v70')
    expect(modelFilterValue('NovelAI Diffusion V4 37442FCA')).toBe('NovelAI Diffusion V4 37442FCA')
    expect(modelFilterValue('detail:0.8')).toBe('detail')
  })
})

describe('why an image shows no parameters', () => {
  test('Gemini and GPT Image never embed them', () => {
    expect(noParamsReason({ generator: 'gemini', hasPrompt: false })).toBe('gemini')
    expect(noParamsReason({ generator: 'gpt-image', hasPrompt: false })).toBe('gptImage')
  })

  test('ComfyUI without a prompt was likely built at run time; anything else carries none', () => {
    expect(noParamsReason({ generator: 'comfyui', hasPrompt: false })).toBe('runtime')
    expect(noParamsReason({ generator: 'unknown', hasPrompt: false })).toBe('none')
    expect(noParamsReason({ generator: null, hasPrompt: false })).toBe('none')
  })

  test('an image with a prompt needs no note', () => {
    expect(noParamsReason({ generator: 'nai', hasPrompt: true })).toBeNull()
    expect(noParamsReason({ generator: 'gemini', hasPrompt: true })).toBeNull()
  })
})

test('an aesthetic score reads with two decimals', () => {
  expect(formatScore(6.4178)).toBe('6.42')
  expect(formatScore(7)).toBe('7.00')
  expect(formatScore(null)).toBeNull()
})
