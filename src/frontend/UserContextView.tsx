import { useMemo, useState } from 'react'
import type { UserContext, CalendarEvent } from '@shared/api-types'
import { getShortTimezone, getShortTimezoneFromIANA } from './utils'

interface CalendarViewProps {
  events: CalendarEvent[]
  userTimezone: string | null
}

function CalendarView({ events, userTimezone }: CalendarViewProps) {
  const [useLocalTime, setUseLocalTime] = useState(true)
  const displayTimezone = useLocalTime ? undefined : userTimezone || undefined
  const timezoneLabel = useLocalTime ? getShortTimezone() : (userTimezone ? getShortTimezoneFromIANA(userTimezone) : getShortTimezone())
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime(),
    )
  }, [events])

  const groupedEvents = useMemo(() => {
    const groups: { [key: string]: CalendarEvent[] } = {}
    sortedEvents.forEach((event) => {
      const date = new Date(event.start)
      const dateOptions: Intl.DateTimeFormatOptions = displayTimezone
        ? { weekday: 'short', month: 'short', day: 'numeric', timeZone: displayTimezone }
        : { weekday: 'short', month: 'short', day: 'numeric' }
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

  if (events.length === 0) {
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
              <div key={idx} className="bg-gray-50 rounded px-2 py-1">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {event.summary || '(No title)'}
                </div>
                <div className="text-xs text-gray-600">
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
      <div className="p-2 bg-gray-50 rounded-lg">
        <div className="text-sm text-gray-500">No user context available</div>
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
      {context.calendarLastFetched && (
        <div className="text-xs text-gray-600">Calendar last synced: {new Date(context.calendarLastFetched).toLocaleString()} ({getShortTimezone()})</div>
      )}
      {context.calendar && context.calendar.length > 0 && (
        <div>
          <CalendarView events={context.calendar} userTimezone={userTimezone} />
        </div>
      )}
    </div>
  )
}
