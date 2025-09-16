import type { SimpleCalendarEvent } from '../../evals/user-sims'

// Helper function to format calendar events with date and time information
export function formatCalendarEvents(calendar: SimpleCalendarEvent[]): string {
  const calendarText = calendar.map((event) => {
    const startDate = event.start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    })
    const startTime = event.start.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    })
    const endTime = event.end.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    })

    // Check if the event spans multiple days in Eastern Time
    const startDateET = event.start.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
    const endDateET = event.end.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
    const sameDay = startDateET === endDateET

    if (sameDay) {
      return `${startDate} ${startTime}-${endTime}: ${event.summary}`
    } else {
      const endDate = event.end.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      })
      return `${startDate} ${startTime} - ${endDate} ${endTime}: ${event.summary}`
    }
  }).join(', ')

  return calendarText || 'Free all day'
}