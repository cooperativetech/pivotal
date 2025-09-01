import { useState, useEffect } from 'react'
import { authClient } from '../shared/auth-client'

interface UserProfile {
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

export default function Profile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    loadProfile().catch((err) => {
      console.error('Failed to load profile:', err)
      setError('Failed to load profile')
    })
  }, [])

  const loadProfile = async () => {
    try {
      const session = await authClient.getSession()
      if (!session.data?.session?.token) {
        setError('Not authenticated')
        return
      }

      const response = await fetch('/api/profile', {
        headers: {
          Authorization: `Bearer ${session.data.session.token}`,
          'ngrok-skip-browser-warning': 'true',
        },
      })

      if (response.ok) {
        const profileData = await response.json() as UserProfile
        setProfile(profileData)
      } else {
        setError('Failed to load profile')
      }
    } catch (err) {
      setError('Error loading profile')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleSlackLink = async () => {
    try {
      await authClient.linkSocial({
        provider: 'slack',
      })
      // Reload profile after successful link (await the OAuth completion)
      await loadProfile()
    } catch (err) {
      setError('Failed to link Slack account')
      console.error(err)
    }
  }

  const handleSignOut = async () => {
    try {
      await authClient.signOut()
      window.location.href = '/login'
    } catch (err) {
      console.error('Sign out error:', err)
    }
  }

  const handleSignOutClick = () => {
    handleSignOut().catch((err) => {
      console.error('Sign out failed:', err)
      setError('Failed to sign out')
    })
  }

  const handleSlackLinkClick = () => {
    handleSlackLink().catch((err) => {
      console.error('Slack link failed:', err)
      setError('Failed to link Slack account')
    })
  }

  if (loading) return <div>Loading...</div>
  if (error) return <div className="error">{error}</div>
  if (!profile) return <div>No profile data</div>

  return (
    <div className="profile-container">
      <div className="profile-header">
        <h1>Profile</h1>
        <button onClick={handleSignOutClick} className="sign-out-btn">Sign Out</button>
      </div>

      <div className="profile-section">
        <h2>Account Information</h2>
        <p><strong>Name:</strong> {profile.user.name}</p>
        <p><strong>Email:</strong> {profile.user.email}</p>
      </div>

      <div className="profile-section">
        <h2>Slack Accounts</h2>
        {profile.slackAccounts.length > 0 ? (
          <ul>
            {profile.slackAccounts.map((account) => (
              <li key={account.id}>
                <strong>{account.realName || account.id}</strong> (Team: {account.teamId})
              </li>
            ))}
          </ul>
        ) : (
          <p>No Slack accounts linked</p>
        )}
        <button onClick={handleSlackLinkClick} className="link-slack-btn">
          Link Slack Account
        </button>
      </div>
    </div>
  )
}