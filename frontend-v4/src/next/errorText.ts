/** Personal paths out of an error text before it is shown or copied. */
export function hidePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>')
    .replace(/\/(?:home|Users|mnt|media)\/[^\s"'<>|]*/g, '<path>')
}
