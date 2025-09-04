import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { local_api } from '@shared/api-client'
import type { WorkflowType } from '@shared/api-types'

interface Topic {
  id: string
  summary: string
  workflowType: WorkflowType
  isActive: boolean
  createdAt: string
  updatedAt: string
  userIds: string[]
}

function LocalHome() {
  const [topics, setTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchTopics = async () => {
      try {
        const response = await local_api.topics.$get({ query: {} })
        if (!response.ok) {
          throw new Error('Failed to fetch topics')
        }
        const data = await response.json()
        setTopics(data.topics)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchTopics().catch((err) => {
      console.error('Failed to fetch topics:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch topics')
    })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-6xl">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800">Flack Testing Interface</h1>
          <p className="text-gray-600 mt-2">Testing mode - no authentication required</p>
        </div>

        <div className="flex justify-center mb-4">
          <Link
            to="/local/create-topic"
            className="block w-full max-w-2xl px-4 py-2 bg-green-600 text-white text-center rounded-lg shadow-md hover:shadow-lg hover:bg-green-700 transition-all duration-200 font-medium"
          >
            + New Topic
          </Link>
        </div>

        {topics.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-gray-500">
              No topics found
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            {topics.map((topic) => (
              <Link
                key={topic.id}
                to={`/local/topic/${topic.id}`}
                className="block p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 border border-gray-200 w-full max-w-2xl"
              >
                <h2 className="text-xl font-semibold mb-2 text-gray-800">
                  {topic.summary}
                </h2>

                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">
                    {topic.workflowType}
                  </span>

                  <span
                    className={`inline-block px-2 py-1 text-xs font-medium rounded ${
                      topic.isActive
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {topic.isActive ? 'Active' : 'Inactive'}
                  </span>

                  <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-purple-100 text-purple-800">
                    Local
                  </span>
                </div>

                <div className="text-sm text-gray-600">
                  <div>Users: {topic.userIds.length}</div>
                  <div>Created: {new Date(topic.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default LocalHome