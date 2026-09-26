import { create } from 'zustand'

/** Whether the library report is open (the rail status and Ctrl K open it). */
export const useStatusDialogs = create<{ report: boolean; setReport: (open: boolean) => void }>((set) => ({
  report: false,
  setReport: (report) => set({ report }),
}))
