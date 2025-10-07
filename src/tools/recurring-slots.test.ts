import test from 'node:test'
import assert from 'node:assert/strict'

import type { CalendarEvent, RecurringSlotDescriptor } from '@shared/api-types'
import { scoreRecurringSlots } from './recurring-slots'

test('scoreRecurringSlots handles weekly slots without conflicts', () => {
  const slot: RecurringSlotDescriptor = { dayOfWeek: 'MO', time: '10:00', timezone: 'America/Los_Angeles' }
  const result = scoreRecurringSlots({
    slots: [slot],
    durationMinutes: 60,
    frequency: 'WEEKLY',
    startDate: '2025-01-06',
    endDate: '2025-02-28',
    sampleWeeks: 4,
    userCalendars: new Map<string, CalendarEvent[]>([
      ['Alice Smith', []],
      ['Bob Jones', []],
    ]),
  })

  assert.equal(result.length, 1)
  const [score] = result
  assert.equal(score.totalConflicts, 0)
  assert.equal(score.perPersonConflicts['Alice Smith'], 0)
  assert.equal(score.perPersonConflicts['Bob Jones'], 0)
  assert.equal(score.tradeoffSummary, 'Works great for everyone — no conflicts detected.')
})

test('scoreRecurringSlots surfaces dominant blocker', () => {
  const slot: RecurringSlotDescriptor = { dayOfWeek: 'TU', time: '09:00', timezone: 'America/New_York' }
  const busyEvent: CalendarEvent = {
    start: '2025-01-07T14:00:00.000Z',
    end: '2025-01-07T15:00:00.000Z',
    summary: 'Weekly conflict',
    free: false,
  }

  const result = scoreRecurringSlots({
    slots: [slot],
    durationMinutes: 60,
    frequency: 'WEEKLY',
    startDate: '2025-01-06',
    endDate: '2025-02-28',
    sampleWeeks: 4,
    userCalendars: new Map<string, CalendarEvent[]>([
      ['Alice Smith', [busyEvent, { ...busyEvent, start: '2025-01-14T14:00:00.000Z', end: '2025-01-14T15:00:00.000Z' }]],
      ['Bob Jones', []],
    ]),
  })

  assert.equal(result.length, 1)
  const [score] = result
  assert.ok(score.totalConflicts > 0)
  assert.ok(score.tradeoffSummary.includes('Alice Smith'))
  assert.equal(score.perPersonConflicts['Alice Smith'], 2)
  assert.equal(score.perPersonConflicts['Bob Jones'], 0)
})
