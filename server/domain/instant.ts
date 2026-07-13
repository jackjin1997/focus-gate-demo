export function parseInstant(label: string, value: string): number {
  const milliseconds = Date.parse(value)

  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO-8601 instant`)
  }

  return milliseconds
}

export function assertChronological(
  earlierLabel: string,
  earlier: string,
  laterLabel: string,
  later: string,
): void {
  const earlierMs = parseInstant(earlierLabel, earlier)
  const laterMs = parseInstant(laterLabel, later)

  if (laterMs < earlierMs) {
    throw new RangeError(`${laterLabel} must not be before ${earlierLabel}`)
  }
}
