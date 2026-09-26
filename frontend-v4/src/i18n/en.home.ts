import type { zhCNHome } from './zh-CN.home'

export const enHome: Record<keyof typeof zhCNHome, string> = {
  'home.film.label': '★5 and newest images',
  'home.film.seeAll': 'See all ★5 in the library',
  'home.film.noStars': 'No ★5 images yet',
  'home.film.noStarsHint': 'Press 5 while viewing an image to rate it; ★5 images come first here.',
  'home.film.error': 'Could not load the library’s images: {reason}',
}
