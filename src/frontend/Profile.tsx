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
      window.location.href = '/'
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

  if (loading) return <div className="flex justify-center items-center h-52 text-gray-600">Loading...</div>
  if (error) return <div className="text-red-600">{error}</div>
  if (!profile) return <div>No profile data</div>

  return (
    <div className="max-w-3xl mx-auto p-4 mt-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-semibold text-gray-900">Profile</h1>
        <button onClick={handleSignOutClick} className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600">Sign Out</button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Account Information</h2>
        <p><strong>Name:</strong> {profile.user.name}</p>
        <p><strong>Email:</strong> {profile.user.email}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Slack Accounts</h2>
        {profile.slackAccounts.length > 0 ? (
          <ul className="list-none p-0 my-4">
            {profile.slackAccounts.map((account) => (
              <li key={account.id} className="py-2 border-b border-gray-100">
                <strong>{account.realName || account.id}</strong> (Team: {account.teamId})
              </li>
            ))}
          </ul>
        ) : (
          <p>No Slack accounts linked</p>
        )}
        <button onClick={handleSlackLinkClick} className="px-6 py-3 bg-purple-800 text-white rounded font-medium hover:bg-purple-900 mt-4">
          Link Slack Account
        </button>
      </div>
    </div>
  )
}
