import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@shared/api-client'
import type { UserContext, CalendarEvent } from '@shared/api-types'

interface User {
  id: string
  realName: string | null
  tz: string | null
  isBot: boolean
  context?: UserContext | null
}

function getShortTimezone(): string {
  const date = new Date()
  const timeString = date.toLocaleTimeString('en-US', { timeZoneName: 'short' })
  const match = timeString.match(/[A-Z]{2,4}$/)
  return match ? match[0] : 'Local'
}

function getShortTimezoneFromIANA(iana: string): string {
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

function CalendarView({ events, userTimezone }: { events: CalendarEvent[], userTimezone: string | null }) {
  const [useLocalTime, setUseLocalTime] = useState(true)
  const displayTimezone = useLocalTime ? undefined : userTimezone || undefined
  const timezoneLabel = useLocalTime ? getShortTimezone() : (userTimezone ? getShortTimezoneFromIANA(userTimezone) : getShortTimezone())
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime(),
    )
  }, [events])

  const groupedEvents = useMemo(() => {
    const groups: Record<string, CalendarEvent[]> = {}

    sortedEvents.forEach((event) => {
      const options: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }
      if (displayTimezone) {
        options.timeZone = displayTimezone
      }
      const date = new Date(event.start).toLocaleDateString('en-US', options)
      if (!groups[date]) {
        groups[date] = []
      }
      groups[date].push(event)
    })

    return groups
  }, [sortedEvents, displayTimezone])

  const formatTime = (dateStr: string) => {
    const options: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }
    if (displayTimezone) {
      options.timeZone = displayTimezone
    }
    return new Date(dateStr).toLocaleTimeString('en-US', options)
  }

  const getDuration = (start: string, end: string) => {
    const startDate = new Date(start)
    const endDate = new Date(end)
    const diffMs = endDate.getTime() - startDate.getTime()
    const diffMins = Math.round(diffMs / 60000)

    if (diffMins < 60) {
      return `${diffMins}m`
    }
    const hours = Math.floor(diffMins / 60)
    const mins = diffMins % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }

  if (events.length === 0) {
    return (
      <div className="text-gray-500 text-sm italic">
        No upcoming events
      </div>
    )
  }

  return (
    <div>
      {userTimezone && userTimezone !== Intl.DateTimeFormat().resolvedOptions().timeZone && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-600">Display times in:</span>
          <button
            type="button"
            onClick={() => setUseLocalTime(!useLocalTime)}
            className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 hover:border-gray-400 transition-colors cursor-pointer"
          >
            {timezoneLabel}
          </button>
        </div>
      )}
      <div className="space-y-3 max-h-64 overflow-y-auto border border-gray-200 rounded p-2">
      {Object.entries(groupedEvents).map(([date, dayEvents]) => (
        <div key={date}>
          <div className="font-medium text-gray-700 text-xs uppercase tracking-wider mb-1">
            {date}
          </div>
          <div className="space-y-1">
            {dayEvents.map((event, idx) => (
              <div
                key={`${event.start}-${idx}`}
                className="bg-white border border-gray-200 rounded px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 text-sm truncate">
                      {event.summary || '(No title)'}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatTime(event.start)} - {formatTime(event.end)}
                      <span className="text-gray-400 ml-1">({getDuration(event.start, event.end)})</span>
                    </div>
                  </div>
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

function TopicCreation() {
  const navigate = useNavigate()
  const [users, setUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api.users.$get()
        if (!response.ok) {
          throw new Error('Failed to fetch users')
        }
        const data = await response.json()
        setUsers(data.users)
        if (data.users.length > 0) {
          setSelectedUserId(data.users[0].id)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users')
      } finally {
        setLoading(false)
      }
    }

    void fetchUsers()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!selectedUserId || !message.trim()) {
      setError('Please select a user and enter a message')
      return
    }

    setSending(true)
    setError(null)

    try {
      const response = await api.message.$post({
        json: {
          userId: selectedUserId,
          text: message.trim(),
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error((errorData as { error?: string }).error || 'Failed to send message')
      }

      const result = await response.json() as { topicId?: string }

      // Redirect to the topic page if a new topic was created
      if (result.topicId) {
        void navigate(`/topic/${result.topicId}`)
      } else {
        setError('Message sent but no topic created')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading users...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-bold mb-8 text-center">Create New Topic</h1>

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {users.length === 0 ? (
          <div className="text-gray-500 text-center py-8">
            No users available. Please create users first.
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
            <div>
              <label htmlFor="user" className="block text-sm font-medium text-gray-700 mb-2">
                Select User
              </label>
              <select
                id="user"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                disabled={sending}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.realName || user.id} {user.tz ? `(${getShortTimezoneFromIANA(user.tz)})` : ''}
                  </option>
                ))}
              </select>
              {selectedUserId && (() => {
                const selectedUser = users.find((u) => u.id === selectedUserId)
                const context = selectedUser?.context
                if (!context || Object.keys(context).length === 0) return null

                return (
                  <div className="mt-2 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
                    {context.slackUserName && (
                      <div>Slack Username: {context.slackUserName}</div>
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
                      <div>Calendar last synced: {new Date(context.calendarLastFetched).toLocaleString()} ({getShortTimezone()})</div>
                    )}
                    {context.calendar && context.calendar.length > 0 && (
                      <div className="mt-2">
                        <div className="font-medium text-gray-700 mb-2">Calendar Events:</div>
                        <CalendarView events={context.calendar} userTimezone={selectedUser?.tz || null} />
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
            <div>
              <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                Message
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="Type your message here..."
                disabled={sending}
              />
            </div>

            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => void navigate('/')}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors duration-200 font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                disabled={sending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-200 font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={sending || !selectedUserId || !message.trim()}
              >
                {sending ? 'Sending...' : 'Send Message'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default TopicCreation
