export function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000)
}