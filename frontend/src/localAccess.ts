/** True only when this browser tab is opened on the host machine itself. */
export function isLocalConsole(): boolean {
  const host = window.location.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
