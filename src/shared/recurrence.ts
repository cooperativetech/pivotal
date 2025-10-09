import type { RecurringMetadata } from './api-types'

export const RECURRENCE_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type RecurrenceDayCode = typeof RECURRENCE_DAY_CODES[number]

export const WEEKDAY_LABELS: Record<RecurrenceDayCode, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

const RECOMMENDATION_LABEL_MAP: Record<NonNullable<RecurringMetadata['recommendation']>, string> = {
  proceed: 'Proceed',
  dm_blocker: 'DM blocker',
  present_options: 'Present options',
  suggest_alternatives: 'Suggest alternatives',
}

export function getWeekdayLabel(code: string): string {
  const upper = code.toUpperCase() as RecurrenceDayCode
  return WEEKDAY_LABELS[upper] || code
}

export function getRecurringRecommendationLabel(
  recommendation: RecurringMetadata['recommendation'] | null | undefined,
): string | null {
  if (!recommendation) return null
  return RECOMMENDATION_LABEL_MAP[recommendation] ?? recommendation
}

export const RECURRENCE_DAY_CODE_SET = new Set<RecurrenceDayCode>(RECURRENCE_DAY_CODES)

export function isRecurrenceDayCode(value: unknown): value is RecurrenceDayCode {
  return typeof value === 'string' && RECURRENCE_DAY_CODE_SET.has(value as RecurrenceDayCode)
}
