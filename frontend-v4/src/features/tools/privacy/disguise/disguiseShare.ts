import { ApiError } from '../../../../api/client'
import { useToasts } from '../../../../ui/toasts'
import { copyMadeFiles, revealMade } from './disguiseApi'
import { dt, errorText } from './disguiseText'

// Handing a made disguise on: copy it as a FILE (a clipboard picture would
// paste one frame and lose the hidden picture) and show it in the folder.

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

/** Put the made files on the clipboard as files, ready to paste into a chat window. */
export async function copyMade(tokens: string[]): Promise<void> {
  if (!tokens.length) return
  try {
    await copyMadeFiles(tokens)
    toast(dt('disguise.copied'))
  } catch (error) {
    // 501: the program cannot put files on this computer's clipboard; 409: another program holds it
    toast(dt(error instanceof ApiError && error.status === 501 ? 'disguise.copyUnsupported' : 'disguise.copyFailed'), 'error')
  }
}

/** Open the save folder with this file selected. */
export async function revealMadeFile(token: string): Promise<void> {
  try {
    await revealMade(token)
  } catch (error) {
    toast(dt('disguise.revealFailed', { reason: errorText(error) }), 'error')
  }
}
