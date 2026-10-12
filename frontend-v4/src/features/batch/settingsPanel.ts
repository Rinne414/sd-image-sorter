import { create } from 'zustand'

/** Whether the dataset settings panel is open (one batch view shows at a time); a step can open it. */
export const useSettingsPanel = create<{ open: boolean }>(() => ({ open: false }))

export const setSettingsPanel = (open: boolean) => useSettingsPanel.setState({ open })
