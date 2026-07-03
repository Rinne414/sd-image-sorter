// Ambient window surface for page.evaluate() callbacks.
// The product frontend is deliberately framework-free vanilla JS with no type
// definitions, so the app globals the e2e suite pokes at are declared as `any`.
export {}

declare global {
  interface Window {
    App?: any
    Gallery?: any
    UiScale?: any
    ArtistIdent?: any
    CensorEdit?: any
    EntryPage?: any
    __taggerSystemInfoStatus?: any
  }
}
