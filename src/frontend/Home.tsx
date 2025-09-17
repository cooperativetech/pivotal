import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router'
import type { TopicWithState } from '@shared/api-types'
import { unserializeTopicWithState } from '@shared/api-types'
import { useAuth } from './AuthContext'
import { api, authClient } from '@shared/api-client'

interface Profile {
  user: {
    id: string
    email: string
    name: string
  }
  slackAccounts: Array<{
    id: string
    realName: string | null
    teamId: string
  }>
}

function Home() {
  const [topics, setTopics] = useState<TopicWithState[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [userNameMap, setUserNameMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { session } = useAuth()

  const fetchData = useCallback(async () => {
      if (!session) return

      try {
        // Fetch both profile and topics in parallel
        const [profileResponse, topicsResponse] = await Promise.all([
          api.profile.$get(),
          api.profile.topics.$get(),
        ])

        if (!profileResponse.ok) {
          throw new Error('Failed to fetch profile')
        }
        if (!topicsResponse.ok) {
          throw new Error('Failed to fetch topics')
        }

        const profileData = await profileResponse.json()
        const topicData = await topicsResponse.json()
        setProfile(profileData)
        const topicsWithDates = topicData.topics.map(unserializeTopicWithState)
        setTopics(topicsWithDates)
        setUserNameMap(topicData.userNameMap)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
  }, [session])

  useEffect(() => {
    fetchData().catch((err) => {
      console.error('Failed to fetch data:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch data')
    })
  }, [session, fetchData])

  const handleSlackLink = async () => {
    try {
      await authClient.linkSocial({
        provider: 'slack',
      })
      // Refresh data after successful link without reloading the page
      await fetchData()
    } catch (err) {
      setError('Failed to link Slack account')
      console.error(err)
    }
  }

  const handleSlackLinkClick = () => {
    handleSlackLink().catch((err) => {
      console.error('Slack link failed:', err)
      setError('Failed to link Slack account')
    })
  }

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
        <h1 className="text-3xl font-bold mb-6 text-center">Topics</h1>
        {/* New topic creation is only available in local testing UI */}

        {topics.length === 0 ? (
          <div className="text-center py-8">
            {profile && profile.slackAccounts.length === 0 ? (
              <div>
                <div className="text-gray-500 mb-4">
                  Connect your Slack account to see your topics
                </div>
                <button
                  onClick={handleSlackLinkClick}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium cursor-pointer"
                >
                  Link Slack Account
                </button>
              </div>
            ) : (
              <div className="text-gray-500">
                No topics found
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            {topics.map((topic) => (
            <Link
              key={topic.id}
              to={`/topic/${topic.id}`}
              className="block p-6 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 border border-gray-200 w-full max-w-2xl"
            >
              <h2 className="text-xl font-semibold mb-2 text-gray-800">
                {topic.state.summary}
              </h2>

              <div className="flex items-center gap-2 mb-3">
                <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">
                  {topic.workflowType}
                </span>

                <span
                  className={`inline-block px-2 py-1 text-xs font-medium rounded ${
                    topic.state.isActive
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  }`}
                >
                  {topic.state.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="text-sm text-gray-600">
                <div>
                  Users: {topic.state.userIds.map((id) => userNameMap[id]).join(', ')}
                </div>
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

export default Home
