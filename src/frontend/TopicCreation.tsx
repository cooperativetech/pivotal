import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router'
import { api } from '@shared/api-client'
import type { UserContext } from '@shared/api-types'
import { getShortTimezoneFromIANA } from '@shared/utils'
import { UserContextView } from './UserContextView'

interface User {
  id: string
  realName: string | null
  tz: string | null
  isBot: boolean
  context?: UserContext | null
}

function TopicCreation() {
  const [users, setUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api.users.$get({ query: {} })
        if (!response.ok) {
          throw new Error('Failed to fetch users')
        }
        const data = await response.json()
        // Filter out bot users and sort by real name
        const humanUsers = data.users
          .filter((user) => !user.isBot)
          .sort((a, b) => {
            const nameA = a.realName || a.id
            const nameB = b.realName || b.id
            return nameA.localeCompare(nameB)
          })
        setUsers(humanUsers)
        // Default to first user if available
        if (humanUsers.length > 0) {
          setSelectedUserId(humanUsers[0].id)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    void fetchUsers()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedUserId || !message.trim()) return

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
        throw new Error('Failed to send message')
      }

      const data = await response.json()

      // Navigate to the topic page if we have a topicId
      if ('topicId' in data) {
        await navigate(`/topic/${data.topicId}`)
      } else {
        // Clear form on success
        setMessage('')
        setSelectedUserId('')
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

  if (error && users.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center gap-3 mb-6">
            <Link to="/" className="text-blue-600 hover:underline text-sm">
              ← Back to Topics
            </Link>
            <h1 className="text-2xl font-bold">Start a New Conversation</h1>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={(e) => { void handleSubmit(e) }} className="space-y-4">
            <div>
              <label htmlFor="user" className="block text-sm font-medium text-gray-700 mb-2">
                Select User
              </label>
              <select
                id="user"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                disabled={sending}
                required
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.realName || user.id} {user.tz ? `(${getShortTimezoneFromIANA(user.tz)})` : ''}
                  </option>
                ))}
              </select>
              {selectedUserId && (() => {
                const selectedUser = users.find((u) => u.id === selectedUserId)
                if (!selectedUser?.context) return null

                return (
                  <div className="mt-2">
                    <UserContextView
                      context={selectedUser.context}
                      userTimezone={selectedUser.tz}
                    />
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

            <button
              type="submit"
              disabled={!selectedUserId || !message.trim() || sending}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 hover:cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {sending ? 'Sending...' : 'Send Message'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

export default TopicCreation
