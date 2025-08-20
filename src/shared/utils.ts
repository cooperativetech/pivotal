export function getShortTimezoneFromIANA(iana: string): string {
  try {
    const date = new Date()
    const timeString = date.toLocaleTimeString('en-US', {
      timeZoneName: 'short',
      timeZone: iana,
    })
    const match = timeString.match(/[A-Z]{2,4}$/)
    return match ? match[0] : iana
  } catch {
    return iana
  }
}

export function getShortTimezone(): string {
  return getShortTimezoneFromIANA(Intl.DateTimeFormat().resolvedOptions().timeZone)
}