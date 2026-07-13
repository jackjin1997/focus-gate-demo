import { createHash } from 'node:crypto'

type CanonicalPrimitive = null | boolean | number | string
export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

export function canonicalStringify(input: unknown): string {
  return serialize(input, new WeakSet<object>())
}

export function canonicalDigest(input: unknown): string {
  const digest = createHash('sha256')
    .update(canonicalStringify(input), 'utf8')
    .digest('hex')

  return `sha256:${digest}`
}

function serialize(input: unknown, ancestors: WeakSet<object>): string {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return JSON.stringify(input)
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new TypeError('Canonical numbers must be finite')
    }

    return JSON.stringify(Object.is(input, -0) ? 0 : input)
  }

  if (typeof input !== 'object') {
    throw new TypeError(`Unsupported canonical value: ${typeof input}`)
  }

  if (ancestors.has(input)) {
    throw new TypeError('Cannot canonicalize cyclic input')
  }

  const prototype = Object.getPrototypeOf(input)
  if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical objects must be plain objects')
  }

  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new TypeError('Canonical objects cannot contain symbol keys')
  }

  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      return `[${input.map((value) => serialize(value, ancestors)).join(',')}]`
    }

    const object = input as Record<string, unknown>
    const entries = Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(object[key], ancestors)}`,
      )

    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(input)
  }
}
