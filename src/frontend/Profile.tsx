import { useState, useEffect } from 'react'

interface UserProfile {
  user: {
    id: string
    email: string
  } | null
  slackAccounts: Array<{
    id: string
    realName: string
    teamId: string
  }>
  message?: string
}

interface Topic {
  id: string
  summary: string
  workflowType: string
  updatedAt: string
}

function Profile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [topics, setTopics] = useState<Topic[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void fetchProfile()
    void fetchUserTopics()
  }, [])

  const fetchProfile = async () => {
    try {
      const response = await fetch('/api/profile')
      if (!response.ok) throw new Error('Failed to fetch profile')

      const data = await response.json() as UserProfile
      setProfile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile')
    }
  }

  const fetchUserTopics = async () => {
    try {
      const response = await fetch('/api/profile/topics')
      if (!response.ok) throw new Error('Failed to fetch topics')

      const data = await response.json() as { topics: Topic[] }
      setTopics(data.topics)
    } catch (err) {
      console.error('Failed to load topics:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSlackLink = () => {
    // TODO: Implement Slack OAuth linking
    console.log('Starting Slack OAuth flow...')
    setError('Slack linking not yet implemented')
  }

  const handleSlackUnlink = (slackUserId: string) => {
    // TODO: Implement Slack account unlinking
    console.log('Unlinking Slack account:', slackUserId)
    setError('Slack unlinking not yet implemented')
  }

  if (isLoading) {
    return <div className="profile-loading">Loading profile...</div>
  }

  return (
    <div className="profile-page">
      <div className="profile-container">
        <h1>Your Profile</h1>

        {error && <div className="error-message">{error}</div>}

        {profile?.message && (
          <div className="info-message">{profile.message}</div>
        )}

        <section className="profile-section">
          <h2>Account Information</h2>
          {profile?.user ? (
            <div className="user-info">
              <p><strong>Email:</strong> {profile.user.email}</p>
              <p><strong>User ID:</strong> {profile.user.id}</p>
            </div>
          ) : (
            <p>Not signed in</p>
          )}
        </section>

        <section className="profile-section">
          <h2>Linked Slack Accounts</h2>

          {profile?.slackAccounts && profile.slackAccounts.length > 0 ? (
            <div className="slack-accounts">
              {profile.slackAccounts.map((account) => (
                <div key={account.id} className="slack-account">
                  <div className="account-info">
                    <strong>{account.realName}</strong>
                    <span className="slack-id">({account.id})</span>
                    <span className="team-id">Team: {account.teamId}</span>
                  </div>
                  <button
                    onClick={() => void handleSlackUnlink(account.id)}
                    className="unlink-button"
                  >
                    Unlink
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p>No Slack accounts linked</p>
          )}

          <button
            onClick={() => void handleSlackLink()}
            className="link-slack-button"
          >
            Link Slack Account
          </button>
        </section>

        <section className="profile-section">
          <h2>Your Topics</h2>

          {topics.length > 0 ? (
            <div className="user-topics">
              {topics.map((topic) => (
                <div key={topic.id} className="topic-item">
                  <h3>{topic.summary}</h3>
                  <p>Type: {topic.workflowType}</p>
                  <p>Updated: {new Date(topic.updatedAt).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          ) : (
            <p>No topics found. Connect your Slack account to see your conversation topics.</p>
          )}
        </section>
      </div>
    </div>
  )
}

export default Profile