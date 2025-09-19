import { useState, useEffect } from 'react'
import { api, authClient } from '@shared/api-client'

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
    teamName?: string | null
  }>
  githubAccount: {
    accountId: string
    username: string
    orgName: string | null
    repositories: Array<{
      id: string
      name: string
      owner: string
      fullName: string
      invitationId: string | null
    }>
    linkedRepo: {
      id: string
      name: string
      owner: string
      fullName: string
      invitationId: string | null
    } | null
    linkableRepos: Array<{
      id: string
      name: string
      owner: string
      fullName: string
      invitationId: string | null
    }>
  } | null
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

      const response = await api.profile.$get()

      if (response.ok) {
        const profileData = await response.json()
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

  const handleGithubLink = async () => {
    try {
      const response = await authClient.githubApp.initInstall()

      if (response.error) {
        setError('Failed to get Github installation URL')
        console.error(response.error)
        return
      }

      // Redirect to the installation URL
      window.location.href = response.data.installUrl
    } catch (err) {
      setError('Failed to link Github account')
      console.error(err)
    }
  }

  const handleGithubUnlink = async (accountId: string) => {
    try {
      await authClient.unlinkAccount({
        providerId: 'github',
        accountId,
      })
      // Reload profile after successful unlink
      await loadProfile()
    } catch (err) {
      setError('Failed to unlink Github account')
      console.error(err)
    }
  }

  const handleConnectRepository = async (repoId: string) => {
    try {
      const response = await api.github['connect-repo'].$post({
        json: { repoId },
      })

      if (response.ok) {
        // Reload profile to show updated repository status
        await loadProfile()
      } else {
        const errorData = await response.json()
        setError((errorData as { error: string }).error || 'Failed to connect repository')
      }
    } catch (err) {
      setError('Failed to connect repository')
      console.error(err)
    }
  }

  const handleDisconnectRepository = async (repoId: string) => {
    try {
      const response = await api.github['disconnect-repo'].$post({
        json: { repoId },
      })

      if (response.ok) {
        // Reload profile to show updated repository status
        await loadProfile()
      } else {
        const errorData = await response.json()
        setError((errorData as { error: string }).error || 'Failed to disconnect repository')
      }
    } catch (err) {
      setError('Failed to disconnect repository')
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

  const handleGithubLinkClick = () => {
    handleGithubLink().catch((err) => {
      console.error('Github link failed:', err)
      setError('Failed to link Github account')
    })
  }

  if (loading) return <div className="flex justify-center items-center h-52 text-gray-600">Loading...</div>
  if (error) return <div className="text-red-600">{error}</div>
  if (!profile) return <div>No profile data</div>

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-semibold text-gray-900">Profile</h1>
        <button onClick={handleSignOutClick} className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 cursor-pointer">Sign Out</button>
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
                <strong>{account.realName || account.id}</strong> (Team: {account.teamName || account.teamId})
              </li>
            ))}
          </ul>
        ) : (
          <p>No Slack accounts linked</p>
        )}
        <button onClick={handleSlackLinkClick} className="px-6 py-3 bg-purple-800 text-white rounded font-medium hover:bg-purple-900 mt-4 cursor-pointer">
          Link Slack Account
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Github Account</h2>
        {profile.githubAccount ? (
          <>
            <div className="py-2 border-b border-gray-100 flex items-center justify-between">
              <div>
                <strong>{profile.githubAccount.username}</strong>
                {profile.githubAccount.orgName && <span className="text-gray-600 ml-2">(Org: {profile.githubAccount.orgName})</span>}
              </div>
              <button
                onClick={() => {
                  handleGithubUnlink(profile.githubAccount!.accountId).catch((err) => {
                    console.error('Github unlink failed:', err)
                    setError('Failed to unlink Github account')
                  })
                }}
                className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 text-sm cursor-pointer"
              >
                Unlink
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4 mt-4">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">How to connect a context repository:</h3>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                <li>Create a new GitHub repository in your organization</li>
                <li>Invite GitHub username <span className="font-mono bg-blue-100 px-1 py-0.5 rounded">pivotal-bot</span> to that repository with <b>write</b> access</li>
                <li>Refresh this page</li>
                <li>The repository name should appear below. Click &quot;Connect&quot; to connect it with your organization</li>
              </ol>
            </div>
            {profile.githubAccount.linkedRepo ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Connected repository:</p>
                <div className="bg-green-50 border border-green-200 rounded px-3 py-2 flex items-center justify-between">
                  <span className="text-sm font-mono text-green-900">{profile.githubAccount.linkedRepo.fullName}</span>
                  <button
                    onClick={() => {
                      handleDisconnectRepository(profile.githubAccount!.linkedRepo!.id).catch((err) => {
                        console.error('Disconnect repository failed:', err)
                        setError('Failed to disconnect repository')
                      })
                    }}
                    className="px-3 py-1 bg-red-500 text-white text-sm rounded hover:bg-red-600 cursor-pointer"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : profile.githubAccount.linkableRepos && profile.githubAccount.linkableRepos.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Available repositories:</p>
                <ul className="list-none space-y-2">
                  {profile.githubAccount.linkableRepos.map((repo) => (
                    <li key={repo.fullName} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono">{repo.fullName}</span>
                        {repo.invitationId && (
                          <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">Invitation pending</span>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          handleConnectRepository(repo.id).catch((err) => {
                            console.error('Connect repository failed:', err)
                            setError('Failed to connect repository')
                          })
                        }}
                        className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 cursor-pointer"
                      >
                        Connect
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-gray-600 text-sm">No repositories available yet. Follow the instructions above to add one.</p>
            )}
          </>
        ) : (
          <>
            <p>No Github account linked</p>
            <button onClick={handleGithubLinkClick} className="px-6 py-3 bg-gray-800 text-white rounded font-medium hover:bg-gray-900 mt-4 cursor-pointer">
              Link Github Account
            </button>
          </>
        )}
      </div>
      </div>
    </div>
  )
}
