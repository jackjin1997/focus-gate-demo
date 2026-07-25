const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function buildLarkAuthCommand(
  profileName: string | null | undefined,
): string | null {
  if (!profileName) return null

  return [
    'lark-cli',
    '--profile',
    shellQuote(profileName),
    'auth',
    'login',
    '--scope',
    shellQuote('search:message'),
  ].join(' ')
}
