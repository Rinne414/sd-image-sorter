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
    V321Integration?: any
    CaptionCore?: any
    // app.js is a classic script, so its top-level functions are globals.
    getSelectedGalleryCount?: any
    showBatchExportModal?: any
    __taggerSystemInfoStatus?: any
  }
}
