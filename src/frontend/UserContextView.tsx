import { useMemo, useState } from 'react'
import type { UserContext, CalendarEvent, TopicUserContext } from '@shared/api-types'
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
      <div className="text-sm italic text-muted-foreground">
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
          className="text-xs text-accent transition-colors hover:text-accent/80"
        >
          Showing in {timezoneLabel} (click to toggle)
        </button>
      </div>
      <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-token bg-background/70 p-3">
        {Object.entries(groupedEvents).map(([dateKey, dateEvents]) => (
        <div key={dateKey}>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{dateKey}</div>
          <div className="space-y-1">
            {dateEvents.map((event) => (
              <div
                key={`${event.start}-${event.end}-${event.summary ?? ''}`}
                className={`rounded px-2 py-1 ${
                  event.isManualOverride
                    ? 'border border-accent/40 bg-accent/15'
                    : 'bg-muted'
                }`}
              >
                <div className={`text-sm font-medium truncate ${
                  event.isManualOverride ? 'text-accent-foreground' : 'text-foreground'
                }`}>
                  {event.summary || '(No title)'} {event.isManualOverride && '(Override)'}
                </div>
                <div className={`text-xs ${
                  event.isManualOverride ? 'text-accent-foreground/80' : 'text-muted-foreground'
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
  calendar: CalendarEvent[] | null
  context: UserContext | null | undefined
  topicContext?: TopicUserContext | null | undefined
  userTimezone: string | null
  onConnectClick?: (() => void) | null
}

export function UserContextView({ calendar, context, topicContext, userTimezone, onConnectClick }: UserContextViewProps) {
  const manualOverrides = topicContext?.calendarManualOverrides
  return (
    <div className="space-y-2 rounded-xl border border-token bg-background/70 p-3 text-sm text-muted-foreground">
      {context?.slackUserName && (
        <div className="text-foreground">Username: {context.slackUserName}</div>
      )}
      {context?.slackDisplayName && (
        <div className="text-foreground">Display Name: {context.slackDisplayName}</div>
      )}
      {context?.slackTeamId && (
        <div className="text-foreground">Team ID: {context.slackTeamId}</div>
      )}
      {calendar !== null ? (
        <div className="flex items-center gap-2 text-accent">
          <span>✓ Google Calendar connected.</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-amber-500">
          <span>⚠ Google Calendar not connected.</span>
          {onConnectClick && (
            <button
              type="button"
              onClick={onConnectClick}
              className="text-amber-600 underline transition-colors hover:text-amber-500"
            >
              Click to connect
            </button>
          )}
        </div>
      )}
      {(calendar !== null && calendar.length > 0) || (manualOverrides && manualOverrides.length > 0) ? (
        <div>
          <CalendarView
            events={calendar || []}
            manualOverrides={manualOverrides}
            userTimezone={userTimezone}
          />
        </div>
      ) : null}
    </div>
  )
}
