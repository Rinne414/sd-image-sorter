import { create } from 'zustand'
import { api, unwrap } from '../../../api/client'
import { useToasts } from '../../../ui/toasts'
import { installQueue, type InstallTarget } from '../../jobs/installJob'
import { clearResume, loadResume, saveResume, withTargets } from '../../jobs/installResume'
import { useJobs } from '../../jobs/jobs'
import { restartApp } from '../restart'
import { mt } from './modelText'

// The Model Center's downloads of several models: one after another in the
// Jobs drawer, what is left kept in `sd-v4-model-resume` until done. A model
// that needs a restart pauses the run; "Restart now and continue" restarts
// with the list marked, and the next start carries on by itself.

interface QueueView {
  running: boolean
  index: number
  total: number
  label: string
  /** "Not now" on the restart banner, until something new needs a restart. */
  bannerHidden: boolean
}

export const useModelQueue = create<QueueView>(() => ({ running: false, index: 0, total: 0, label: '', bannerHidden: false }))

function toast(text: string, tone: 'info' | 'error' = 'info', withJobs = false) {
  const action = withJobs ? { label: mt('mc.queue.show'), run: () => useJobs.getState().setDrawerOpen(true) } : undefined
  useToasts.getState().push(text, tone, action)
}

async function currentBoot(): Promise<string | null> {
  try {
    const res = unwrap<{ boot_id?: unknown }>(await api.GET('/api/updates/boot-id'))
    return typeof res.boot_id === 'string' ? res.boot_id : null
  } catch {
    return null
  }
}

const names = (items: readonly InstallTarget[]) => items.map((i) => i.label).join(mt('mc.listSep'))

/** Download the models one after another. What is left stays saved, so a closed tab or a restart can continue. */
export async function downloadModels(targets: readonly InstallTarget[]): Promise<void> {
  if (!targets.length || useModelQueue.getState().running) return
  useModelQueue.setState({ running: true, index: 0, total: targets.length, label: targets[0]?.label ?? '' })
  try {
    await installQueue(targets, {
      onStep: (index, target) => {
        useModelQueue.setState({ index, label: target.label })
        saveResume({ items: targets.slice(index), restart: false, bootId: null })
      },
      onRestart: async (rest, target) => {
        saveResume({ items: rest, restart: true, bootId: await currentBoot() })
        useModelQueue.setState({ bannerHidden: false })
        toast(mt('mc.queue.paused', { name: target.label, n: rest.length }), 'error')
      },
      onBlocked: (rest) => {
        saveResume({ items: rest, restart: false, bootId: null })
        toast(mt('mc.queue.blocked', { n: rest.length }), 'error')
      },
      onEnd: (failed) => {
        clearResume()
        const n = targets.length
        if (failed.length) toast(mt('mc.queue.mixed', { ok: n - failed.length, n, failed: names(failed) }), 'error', true)
        else toast(mt('mc.queue.done', { n }))
      },
    })
  } finally {
    useModelQueue.setState({ running: false, index: 0, total: 0, label: '' })
  }
}

/**
 * Restart the app, then download `first` (the models waiting on the restart)
 * and whatever was left. The list is saved before the restart is asked for.
 */
export async function restartAndContinue(first: readonly InstallTarget[]): Promise<void> {
  const items = withTargets(first, loadResume()?.items ?? [])
  saveResume({ items, restart: true, bootId: await currentBoot() })
  await restartApp({ reason: 'model_dependency_install', askFirst: false })
}

/** At start-up after a restart (a new boot id): carry on with the saved list. */
export async function resumeAfterRestart(): Promise<void> {
  const saved = loadResume()
  if (!saved?.restart) return
  const boot = await currentBoot()
  if (saved.bootId && boot === saved.bootId) return
  saveResume({ items: saved.items, restart: false, bootId: null })
  toast(mt('mc.queue.resumed', { n: saved.items.length }))
  await downloadModels(saved.items)
}

/** "Continue downloading" on the banner. */
export function continueSaved(): void {
  const saved = loadResume()
  if (saved) void downloadModels(saved.items)
}
