// Filters that only see images with colour analysis: an image not analysed yet
// can never match them (the library says how many that leaves out).

const COLOR_FILTER_KEYS = [
  'color_hues',
  'exclude_color_hues',
  'exclude_colors',
  'color_temperature',
  'brightness_distribution',
  'brightness_min',
  'brightness_max',
  'min_saturation',
  'max_saturation',
]

export function usesColorFilter(params: Record<string, unknown>): boolean {
  return COLOR_FILTER_KEYS.some((key) => key in params)
}
