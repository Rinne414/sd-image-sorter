import { create } from 'zustand'
import { useApp } from '../../../state/store'

// "Which one should I pick?" in the tag panel, the censor detector and the
// mask engine: open the Model Center and bring that model's card into view.

export const useModelFocus = create<{ card: string | null }>(() => ({ card: null }))

export function openModelCenter(card: string): void {
  useModelFocus.setState({ card })
  useApp.getState().openSettings('models')
}
