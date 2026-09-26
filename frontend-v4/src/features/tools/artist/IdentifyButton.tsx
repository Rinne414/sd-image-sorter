import { useT } from '../../../i18n'
import { useJobs } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { identifyArtists } from './identify'

/** The generation card's "识别画风": this one image, as a job (its result comes back as a toast). */
export function IdentifyButton({ id }: { id: number }) {
  const t = useT()
  const running = useJobs((s) => s.jobs.some((j) => j.kind === 'artist' && !isFinished(j.progress.status)))
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => void identifyArtists([id])}
      disabled={running}
      data-testid="card-identify-artist"
    >
      {t('tools.artist.identify')}
    </button>
  )
}
