import { openModelCenter } from './focus'
import { censorCard } from './modelCards'
import styles from './ModelGuideLink.module.css'
import { useMT } from './modelText'

/**
 * "Which one should I pick?" beside a model choice (tag panel, censor
 * detector, mask engine): opens the Model Center at that model's card.
 * `onGo` closes whatever the link sits in first.
 */
export function ModelGuideLink({ card, onGo }: { card: string; onGo?: () => void }) {
  const mt = useMT()
  const go = () => {
    onGo?.()
    openModelCenter(card)
  }
  return (
    <p className={styles.wrap}>
      <button type="button" className={styles.link} onClick={go} title={mt('mc.guide.title')} data-testid="model-guide-link">
        {mt('mc.guide.link')}
      </button>
    </p>
  )
}

/** The same link beside the censor detector choice: the card of the chosen detector. */
export function DetectorGuideLink({ detector }: { detector: string }) {
  return <ModelGuideLink card={censorCard(detector)} />
}
