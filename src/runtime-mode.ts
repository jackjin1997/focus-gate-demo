export function isRealRuntimeLocation(location: {
  hostname: string
  port: string
  search: string
}) {
  const loopback = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  if (!loopback) return false
  return location.port === '4317' || new URLSearchParams(location.search).get('mode') === 'real'
}
