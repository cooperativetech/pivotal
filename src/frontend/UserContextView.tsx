import { useMemo, useState } from 'react'
import type { UserContext, CalendarEvent } from '@shared/api-types'
import { getShortTimezone, getShortTimezoneFromIANA, mergeCalendarWithOverrides } from '@shared/utils'

interface ExtendedCalendarEvent extends CalendarEvent {
  isManualOverride?: boolean
}

interface CalendarViewProps {
  events: CalendarEvent[]
  manualOverrides?: CalendarEvent[]
  userTimezone: string | null
}

function CalendarView({ events, manualOverrides, userTimezone }: CalendarViewProps) {
  const [useLocalTime, setUseLocalTime] = useState(!userTimezone)
  const displayTimezone = useLocalTime ? undefined : userTimezone || undefined
  const timezoneLabel = useLocalTime ? getShortTimezone() : (userTimezone ? getShortTimezoneFromIANA(userTimezone) : getShortTimezone())

  const sortedEvents = useMemo(() => {
    // Use mergeCalendarWithOverrides which handles overlap removal
    const mergedCalendar = mergeCalendarWithOverrides(events, manualOverrides || [])

    // Mark which events are manual overrides
    const overrideSet = new Set((manualOverrides || []).map((e) => `${e.start}-${e.end}-${e.summary}`))
    const eventsWithOverrideFlag: ExtendedCalendarEvent[] = mergedCalendar.map((event) => ({
      ...event,
      isManualOverride: overrideSet.has(`${event.start}-${event.end}-${event.summary}`),
    }))

    return eventsWithOverrideFlag
  }, [events, manualOverrides])

  const groupedEvents = useMemo(() => {
    const groups: { [key: string]: ExtendedCalendarEvent[] } = {}
    sortedEvents.forEach((event) => {
      const date = new Date(event.start)
      const dateOptions: Intl.DateTimeFormatOptions = displayTimezone
        ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: displayTimezone }
        : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
      const dateKey = date.toLocaleDateString('en-US', dateOptions)
      if (!groups[dateKey]) {
        groups[dateKey] = []
      }
      groups[dateKey].push(event)
    })
    return groups
  }, [sortedEvents, displayTimezone])

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const timeOptions: Intl.DateTimeFormatOptions = displayTimezone
      ? { hour: 'numeric', minute: '2-digit', timeZone: displayTimezone }
      : { hour: 'numeric', minute: '2-digit' }
    return date.toLocaleTimeString('en-US', timeOptions)
  }

  const formatDuration = (start: string, end: string) => {
    const startDate = new Date(start)
    const endDate = new Date(end)
    const durationMs = endDate.getTime() - startDate.getTime()
    const hours = Math.floor(durationMs / (1000 * 60 * 60))
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
    }
    return `${minutes}m`
  }

  if (events.length === 0 && (!manualOverrides || manualOverrides.length === 0)) {
    return (
      <div className="text-gray-500 text-sm italic">
        No upcoming events
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => setUseLocalTime(!useLocalTime)}
          className="text-xs text-blue-600 hover:text-blue-800 transition-colors cursor-pointer"
        >
          Showing in {timezoneLabel} (click to toggle)
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto space-y-3 pr-1 border border-gray-200 rounded-md p-2">
        {Object.entries(groupedEvents).map(([dateKey, dateEvents]) => (
        <div key={dateKey}>
          <div className="text-xs font-medium text-gray-600 mb-1">{dateKey}</div>
          <div className="space-y-1">
            {dateEvents.map((event, idx) => (
              <div
                key={idx}
                className={`rounded px-2 py-1 ${
                  event.isManualOverride
                    ? 'bg-blue-100 border border-blue-300'
                    : 'bg-gray-50'
                }`}
              >
                <div className={`text-sm font-medium truncate ${
                  event.isManualOverride ? 'text-blue-900' : 'text-gray-900'
                }`}>
                  {event.summary || '(No title)'} {event.isManualOverride && '(Override)'}
                </div>
                <div className={`text-xs ${
                  event.isManualOverride ? 'text-blue-700' : 'text-gray-600'
                }`}>
                  {formatTime(event.start)} - {formatTime(event.end)} ({formatDuration(event.start, event.end)})
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      </div>
    </div>
  )
}

interface UserContextViewProps {
  context: UserContext | null | undefined
  userTimezone: string | null
}

export function UserContextView({ context, userTimezone }: UserContextViewProps) {
  if (!context) {
    return (
      <div className="p-1 bg-gray-50 rounded-lg space-y-2 text-sm">
        <div className="text-amber-600">⚠ Google Calendar not connected</div>
      </div>
    )
  }

  return (
    <div className="p-1 bg-gray-50 rounded-lg space-y-2 text-sm">
      {context.slackUserName && (
        <div>Username: {context.slackUserName}</div>
      )}
      {context.slackDisplayName && (
        <div>Display Name: {context.slackDisplayName}</div>
      )}
      {context.slackTeamId && (
        <div>Team ID: {context.slackTeamId}</div>
      )}
      {!context.googleAccessToken && (
        <div className="text-amber-600">⚠ Google Calendar not connected</div>
      )}
      {(context.calendar && context.calendar.length > 0) || (context.calendarManualOverrides && context.calendarManualOverrides.length > 0) ? (
        <div>
          <CalendarView
            events={context.calendar || []}
            manualOverrides={context.calendarManualOverrides}
            userTimezone={userTimezone}
          />
        </div>
      ) : null}
    </div>
  )
}
