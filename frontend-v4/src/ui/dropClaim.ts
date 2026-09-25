// Files dragged in from outside the browser go to the Library import by
// default. A view that takes such drops itself (a dataset batch's pick step)
// claims them while it is shown, and the Library import stands aside.

let claims = 0

/** Claim file drops; call the returned function to give them back. */
export function claimFileDrops(): () => void {
  claims += 1
  let released = false
  return () => {
    if (released) return
    released = true
    claims -= 1
  }
}

export const fileDropsClaimed = (): boolean => claims > 0
