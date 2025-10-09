import { Temporal } from '@js-temporal/polyfill'

import type { CalendarEvent, RecurringSlotDescriptor, RecurringSlotScore } from '@shared/api-types'

const DAY_TO_TEMPORAL: Record<RecurringSlotDescriptor['dayOfWeek'], number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
}

type BusyRange = { start: number; end: number }

type Occurrence = {
  start: number
  end: number
  weekKey: string
}

type ScoreParams = {
  slots: RecurringSlotDescriptor[]
  durationMinutes: number
  frequency: 'WEEKLY' | 'BIWEEKLY'
  startDate: string
  endDate: string
  sampleWeeks?: number
  userCalendars: Map<string, CalendarEvent[] | null>
}

const DEFAULT_SAMPLE_WEEKS = 12

function clampEndDate(start: Temporal.PlainDate, end: Temporal.PlainDate, sampleWeeks: number): Temporal.PlainDate {
  if (sampleWeeks <= 0) return end
  const limit = start.add({ days: sampleWeeks * 7 })
  return Temporal.PlainDate.compare(limit, end) < 0 ? limit : end
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = time.split(':')
  const hour = Number.parseInt(hourStr, 10)
  const minute = Number.parseInt(minuteStr ?? '0', 10)
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Invalid time format: ${time}`)
  }
  return { hour, minute }
}

function startOfWeek(date: Temporal.PlainDate): Temporal.PlainDate {
  const offset = (date.dayOfWeek + 6) % 7 // convert so Monday is 0
  return date.subtract({ days: offset })
}

function enumerateOccurrences(
  slot: RecurringSlotDescriptor,
  durationMinutes: number,
  frequency: 'WEEKLY' | 'BIWEEKLY',
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): Occurrence[] {
  const targetDow = DAY_TO_TEMPORAL[slot.dayOfWeek]
  const timeParts = parseTime(slot.time)

  let cursor = start
  const deltaDays = (targetDow + 7 - cursor.dayOfWeek) % 7
  if (deltaDays > 0) {
    cursor = cursor.add({ days: deltaDays })
  }

  const occurrences: Occurrence[] = []
  const stepDays = frequency === 'BIWEEKLY' ? 14 : 7

  while (Temporal.PlainDate.compare(cursor, end) <= 0) {
    const zonedStart = Temporal.ZonedDateTime.from({
      timeZone: slot.timezone,
      year: cursor.year,
      month: cursor.month,
      day: cursor.day,
      hour: timeParts.hour,
      minute: timeParts.minute,
    })
    const zonedEnd = zonedStart.add({ minutes: durationMinutes })

    occurrences.push({
      start: zonedStart.epochMilliseconds,
      end: zonedEnd.epochMilliseconds,
      weekKey: startOfWeek(zonedStart.toPlainDate()).toString(),
    })

    cursor = cursor.add({ days: stepDays })
  }

  return occurrences
}

function toBusyRanges(events: CalendarEvent[]): BusyRange[] {
  return events
    .filter((event) => event.free !== true)
    .map((event) => ({
      start: new Date(event.start).getTime(),
      end: new Date(event.end).getTime(),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

function describeRate(rate: number): string {
  if (rate <= 0.05) return 'works great for everyone'
  if (rate <= 0.1) return 'everyone can make almost every meeting'
  if (rate <= 0.2) return 'expect occasional misses spread across the team'
  if (rate <= 0.3) return 'about one in four meetings would have someone missing'
  if (rate <= 0.5) return 'roughly a third of meetings would be tough for someone'
  return 'this slot rarely works for the group'
}

function describeIndividual(name: string, rate: number): string {
  if (rate <= 0.05) return `${name} can attend nearly every meeting`
  if (rate <= 0.1) return `${name} would miss a few meetings`
  if (rate <= 0.2) return `${name} would miss about one in five meetings`
  if (rate <= 0.3) return `${name} would miss roughly one in four meetings`
  if (rate <= 0.5) return `${name} would miss around a third of the meetings`
  return `${name} would miss about half of the meetings`
}

function buildTradeoffSummary(
  totalOccurrences: number,
  perPersonConflicts: Record<string, number>,
  participantCount: number,
  unknownParticipants: string[],
): string {
  if (participantCount === 0) {
    if (unknownParticipants.length === 0) {
      return 'No calendar data available to evaluate this slot.'
    }
    return `Need availability from ${unknownParticipants.join(', ')} before we can score this slot.`
  }

  if (totalOccurrences === 0) return 'No viable occurrences within the sampled range.'

  const totalConflicts = Object.values(perPersonConflicts).reduce((acc, value) => acc + value, 0)
  if (totalConflicts === 0) {
    const base = 'Works great for everyone — no conflicts detected.'
    if (unknownParticipants.length > 0) {
      return `${base} Waiting on availability from ${unknownParticipants.join(', ')}.`
    }
    return base
  }

  const rate = totalConflicts / totalOccurrences
  const entries = Object.entries(perPersonConflicts)
  entries.sort((a, b) => b[1] - a[1])
  const [topName, topConflicts] = entries[0]
  const topRate = topConflicts / totalOccurrences
  const secondRate = entries[1] ? entries[1][1] / totalOccurrences : 0

  const generalPhrase = describeRate(rate)
  const lines: string[] = [generalPhrase.charAt(0).toUpperCase() + generalPhrase.slice(1) + '.']

  if (topConflicts === 0) {
    return lines[0]
  }

  if (topRate - secondRate >= 0.12 && topRate >= 0.12) {
    lines.push(describeIndividual(topName, topRate) + '.')
  } else {
    const highlights = entries
      .filter(([, conflicts]) => conflicts > 0)
      .map(([name, conflicts]) => describeIndividual(name, conflicts / totalOccurrences))
    if (highlights.length > 0) {
      lines.push(`${highlights.join('; ')}.`)
    }
  }

  if (unknownParticipants.length > 0) {
    lines.push(`Still need input from ${unknownParticipants.join(', ')}.`)
  }

  return lines.join(' ')
}

export function scoreRecurringSlots({
  slots,
  durationMinutes,
  frequency,
  startDate,
  endDate,
  sampleWeeks = DEFAULT_SAMPLE_WEEKS,
  userCalendars,
}: ScoreParams): RecurringSlotScore[] {
  if (slots.length === 0) return []
  if (!['WEEKLY', 'BIWEEKLY'].includes(frequency)) {
    throw new Error(`Unsupported frequency: ${frequency}`)
  }

  const start = Temporal.PlainDate.from(startDate)
  const rawEnd = Temporal.PlainDate.from(endDate)
  const effectiveEnd = clampEndDate(start, rawEnd, sampleWeeks)

  const entries = Array.from(userCalendars.entries())
  const knownEntries = entries.filter(([, events]) => events !== null) as Array<[string, CalendarEvent[]]>
  const unknownParticipants = entries.filter(([, events]) => events === null).map(([name]) => name)

  const busyRanges = new Map<string, BusyRange[]>(
    knownEntries.map(([name, events]) => [name, toBusyRanges(events)]),
  )

  return slots.flatMap((slot) => {
    const occurrences = enumerateOccurrences(slot, durationMinutes, frequency, start, effectiveEnd)
    if (occurrences.length === 0) return []

    const perPersonConflicts: Record<string, number> = {}
    busyRanges.forEach((_ranges, name) => {
      perPersonConflicts[name] = 0
    })

    let totalConflicts = 0
    const conflictWeeks = new Set<string>()

    for (const occurrence of occurrences) {
      let occurrenceHadConflict = false
      busyRanges.forEach((ranges, name) => {
        for (const range of ranges) {
          if (rangesOverlap(range.start, range.end, occurrence.start, occurrence.end)) {
            perPersonConflicts[name] += 1
            totalConflicts += 1
            occurrenceHadConflict = true
            break
          }
        }
      })

      if (occurrenceHadConflict) {
        conflictWeeks.add(occurrence.weekKey)
      }
    }

    const participantCount = busyRanges.size
    const maxAttendanceSlots = occurrences.length * participantCount
    let percentAvailable = participantCount === 0
      ? 0
      : Math.max(0, maxAttendanceSlots - totalConflicts) / Math.max(1, maxAttendanceSlots) * 100

    if (unknownParticipants.length > 0) {
      percentAvailable = 0
    }

    const tradeoffSummary = buildTradeoffSummary(
      occurrences.length,
      perPersonConflicts,
      participantCount,
      unknownParticipants,
    )

    const score: RecurringSlotScore = {
      slot,
      durationMinutes,
      totalOccurrences: occurrences.length,
      totalConflicts,
      perPersonConflicts,
      percentAvailable,
      conflictWeeks: Array.from(conflictWeeks).sort(),
      tradeoffSummary,
      unknownParticipants: unknownParticipants.length > 0 ? unknownParticipants : undefined,
    }

    return [score]
  })
}

export function summarizeIndividualConflicts(perPersonConflicts: Record<string, number>, totalOccurrences: number): string[] {
  return Object.entries(perPersonConflicts)
    .filter(([, conflicts]) => conflicts > 0)
    .map(([name, conflicts]) => describeIndividual(name, conflicts / Math.max(1, totalOccurrences)))
}
