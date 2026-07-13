import { describe, expect, it } from 'vitest'

import { canonicalDigest, canonicalStringify } from './canonical'

describe('canonical representation', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const left = {
      z: [{ second: 2, first: 1 }, 'tail'],
      a: { enabled: true, count: 3 },
    }
    const right = {
      a: { count: 3, enabled: true },
      z: [{ first: 1, second: 2 }, 'tail'],
    }

    expect(canonicalStringify(left)).toBe(
      '{"a":{"count":3,"enabled":true},"z":[{"first":1,"second":2},"tail"]}',
    )
    expect(canonicalDigest(left)).toBe(canonicalDigest(right))
  })

  it('keeps semantically different values distinguishable', () => {
    expect(canonicalDigest({ order: ['a', 'b'] })).not.toBe(
      canonicalDigest({ order: ['b', 'a'] }),
    )
    expect(canonicalDigest({ value: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it.each([
    { label: 'undefined', value: { value: undefined } },
    { label: 'non-finite number', value: { value: Number.POSITIVE_INFINITY } },
    { label: 'non-plain object', value: { value: new Date('2026-07-12T00:00:00Z') } },
  ])('rejects $label instead of silently changing the signed payload', ({ value }) => {
    expect(() => canonicalStringify(value)).toThrow(/canonical/i)
  })

  it('rejects cyclic input', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => canonicalStringify(cyclic)).toThrow(/cyclic/i)
  })
})
