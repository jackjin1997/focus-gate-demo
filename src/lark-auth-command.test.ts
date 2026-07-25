import { describe, expect, it } from 'vitest'
import { buildLarkAuthCommand } from './lark-auth-command'

describe('buildLarkAuthCommand', () => {
  it('builds the minimal message-search authorization command for a pinned profile', () => {
    expect(buildLarkAuthCommand('focus-profile')).toBe(
      "lark-cli --profile 'focus-profile' auth login --scope 'search:message'",
    )
  })

  it('shell-quotes single quotes in an untrusted profile name', () => {
    expect(buildLarkAuthCommand("focus'; echo pwn #")).toBe(
      "lark-cli --profile 'focus'\\''; echo pwn #' auth login --scope 'search:message'",
    )
  })

  it('does not fabricate a command without a pinned profile', () => {
    expect(buildLarkAuthCommand(null)).toBeNull()
  })
})
