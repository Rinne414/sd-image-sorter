import { useEffect } from 'react'
import { translate, useLang } from '../i18n'
import { installBackNav } from '../lib/backNav'
import { showAddressRoute } from '../state/store'
import { closeTopLayer } from '../ui/layers'
import { useToasts } from '../ui/toasts'

/** Browser and mouse Back go up one level (lib/backNav.ts). Used by every app shell. */
export function useBackNav(): void {
  useEffect(
    () =>
      installBackNav({
        closeTop: closeTopLayer,
        showAddress: showAddressRoute,
        warnLeave: () => useToasts.getState().push(translate(useLang.getState().lang, 'nav.backLeave')),
      }),
    [],
  )
}
