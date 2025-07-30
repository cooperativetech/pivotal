import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { User, GetUsersResponse, CreateChatRequest, CreateChatResponse } from '../shared/api-types'

export default function CreateGroupChat() {
  const [users, setUsers] = useState<User[]>([])
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
  const [chatName, setChatName] = useState('')
  const [publicContext, setPublicContext] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    void fetchUsers()
  }, [])

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/users', {
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to fetch users')
      const data = await response.json() as GetUsersResponse
      setUsers(data)
    } catch {
      setError('Failed to load users')
    }
  }

  const toggleUser = (userId: string) => {
    const newSelected = new Set(selectedUsers)
    if (newSelected.has(userId)) {
      newSelected.delete(userId)
    } else {
      newSelected.add(userId)
    }
    setSelectedUsers(newSelected)
  }

  const handleCreateChat = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatName.trim() || selectedUsers.size === 0) {
      setError('Please enter a chat name and select at least one user')
      return
    }

    setLoading(true)
    setError('')

    try {
      const request: CreateChatRequest = {
        name: chatName,
        selectedUserIds: Array.from(selectedUsers),
        publicContext: publicContext.trim(),
      }

      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(request),
      })

      if (!response.ok) throw new Error('Failed to create chat')

      const chat = await response.json() as CreateChatResponse
      void navigate(`/chat/${chat.id}`)
    } catch {
      setError('Failed to create chat')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto my-8 p-8 bg-white rounded-lg shadow-md">
      <h1 className="text-3xl font-semibold mb-6">Create Group Chat</h1>

      {error && (
        <div className="bg-red-50 text-red-800 p-3 rounded-md mb-4">
          {error}
        </div>
      )}

      <form onSubmit={(e) => void handleCreateChat(e)} className="space-y-6">
        <div>
          <label htmlFor="chatName" className="block text-sm font-medium text-gray-700 mb-2">
            Chat Name
          </label>
          <input
            id="chatName"
            type="text"
            value={chatName}
            onChange={(e) => setChatName(e.target.value)}
            placeholder="Enter chat name"
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor="publicContext" className="block text-sm font-medium text-gray-700 mb-2">
            Public Context (optional)
          </label>
          <textarea
            id="publicContext"
            value={publicContext}
            onChange={(e) => setPublicContext(e.target.value)}
            placeholder="Enter context for the LLM"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Users
          </label>
          <div className="max-h-72 overflow-y-auto border border-gray-300 rounded-md p-2">
            {users.map((user) => (
              <div key={user.id} className="py-2 px-2 border-b border-gray-100 last:border-b-0">
                <label className="flex items-center cursor-pointer hover:bg-gray-50 p-1 rounded">
                  <input
                    type="checkbox"
                    checked={selectedUsers.has(user.id)}
                    onChange={() => toggleUser(user.id)}
                    className="mr-3 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm">
                    {user.name} <span className="text-gray-500">({user.email})</span>
                  </span>
                </label>
              </div>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Creating...' : 'Create Chat'}
        </button>
      </form>
    </div>
  )
}
