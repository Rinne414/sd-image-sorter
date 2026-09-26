// Where focus goes in a dialog. The header's × is out of the Tab order
// (tabIndex -1) but still a button, so it is skipped by hand: first focus
// lands on the first real control.

/** The first element Tab can reach (tabIndex 0 or more); null when there is none. */
export function firstFocusable<T extends { tabIndex: number }>(elements: readonly T[]): T | null {
  return elements.find((el) => el.tabIndex >= 0) ?? null
}
