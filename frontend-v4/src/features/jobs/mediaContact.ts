// When the program does not answer a GIF / video censor job's progress look.
// It can be busy with the pictures and answer late, so one miss is not the end:
// after LOST_CONTACT_POLLS misses in a row the drawer says it lost contact (once),
// and says when contact is back. Pure, so it can be tested alone.

/** Looks in a row that may go unanswered before the drawer says it lost contact (about 5 s). */
export const LOST_CONTACT_POLLS = 5

/** What a look found, given the misses in a row before it: the count now, and what to say (if anything). */
export function contactChange(before: number, answered: boolean): { next: number; say: 'lost' | 'back' | null } {
  if (answered) return { next: 0, say: before >= LOST_CONTACT_POLLS ? 'back' : null }
  const next = before + 1
  return { next, say: next === LOST_CONTACT_POLLS ? 'lost' : null }
}
