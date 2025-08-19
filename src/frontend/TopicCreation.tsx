import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '@shared/api-client'

interface User {
  id: string
  realName: string | null
  tz: string | null
  isBot: boolean
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
                    {user.realName || user.id} {user.tz ? `(${user.tz})` : ''}
                  </option>
                ))}
              </select>
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