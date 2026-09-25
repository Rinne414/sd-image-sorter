// Image URLs, kept apart from the API client so pure code (and its tests)
// can build them without loading the app state.

export const thumbnailUrl = (id: number, size: number) => `/api/image-thumbnail/${id}?size=${size}`
export const imageFileUrl = (id: number) => `/api/image-file/${id}`
