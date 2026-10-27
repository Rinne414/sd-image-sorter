import { create } from 'zustand'

// Which picture the "Send to generator" dialog is open for. The right-click
// menu, the picture's info card and Ctrl K all open it through here.

interface State {
  imageId: number | null
  open: (imageId: number) => void
  close: () => void
}

export const useGeneratorDialog = create<State>((set) => ({
  imageId: null,
  open: (imageId) => set({ imageId }),
  close: () => set({ imageId: null }),
}))

/** Open the dialog for one picture. */
export const sendToGenerator = (imageId: number): void => useGeneratorDialog.getState().open(imageId)
