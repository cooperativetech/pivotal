import { useState, useEffect } from 'react'
import type { UserProfile } from '@shared/api-types'
import { api, authClient } from '@shared/api-client'

export default function Profile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [googleBusy, setGoogleBusy] = useState(false)
  const [slackBusy, setSlackBusy] = useState(false)
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubRepoBusy, setGithubRepoBusy] = useState<string | null>(null)
  const [slackAppBusy, setSlackAppBusy] = useState(false)

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

  const handleSlackConnect = async () => {
    try {
      setSlackBusy(true)
      await authClient.linkSocial({ provider: 'slack' })
    } catch (err) {
      setError('Failed to link Slack account')
      console.error(err)
      setSlackBusy(false)
    }
  }

  const handleSlackDisconnect = async () => {
    try {
      setSlackBusy(true)
      await authClient.unlinkAccount({ providerId: 'slack' })
      await authClient.signOut()
      window.location.href = '/'
    } catch (err) {
      setError('Failed to disconnect Slack')
      console.error(err)
      setSlackBusy(false)
    }
  }

  const handleGoogleConnect = () => {
    try {
      setGoogleBusy(true)
      // Use api route here instead of linkSocial so that the codepath is
      // identical between this button and the button sent via slack
      const params = new URLSearchParams({
        callbackURL: '/profile',
        errorCallbackURL: '/profile',
      })
      window.location.href = `/api/google/authorize?${params.toString()}`
    } catch (err) {
      setError('Failed to link Google account')
      console.error(err)
      setGoogleBusy(false)
    }
  }

  const handleGoogleDisconnect = async () => {
    try {
      setGoogleBusy(true)
      await authClient.unlinkAccount({ providerId: 'google' })
      await loadProfile()
    } catch (err) {
      setError('Failed to unlink Google account')
      console.error(err)
    } finally {
      setGoogleBusy(false)
    }
  }

  const handleSlackAppConnect = async () => {
    try {
      setSlackAppBusy(true)
      const response = await authClient.slackApp.initInstall({ callbackURL: '/profile' })
      if (response.error) {
        throw new Error(`Failed to get Slack installation URL: ${response.error.message}`)
      }
      // Redirect to the installation URL
      window.location.href = response.data.installUrl
    } catch (err) {
      setError('Failed to link Slack application')
      console.error(err)
      setSlackAppBusy(false)
    }
  }

  const handleSlackAppDisconnect = async () => {
    try {
      setSlackAppBusy(true)
      const response = await authClient.slackApp.uninstall()
      if (response.error) {
        throw new Error(`Failed to uninstall Slack app: ${response.error.message}`)
      }
      await loadProfile()
    } catch (err) {
      setError('Failed to uninstall Slack app')
      console.error(err)
    } finally {
      setSlackAppBusy(false)
    }
  }

  const handleGithubConnect = async () => {
    try {
      setGithubBusy(true)
      const response = await authClient.githubApp.initInstall()
      if (response.error) {
        throw new Error(`Failed to get Github installation URL: ${response.error.message}`)
      }
      // Redirect to the installation URL
      window.location.href = response.data.installUrl
    } catch (err) {
      setError('Failed to link Github account')
      console.error(err)
      setGithubBusy(false)
    }
  }

  const handleGithubDisconnect = async (accountId: string) => {
    try {
      setGithubBusy(true)
      await authClient.unlinkAccount({
        providerId: 'github',
        accountId,
      })
      await loadProfile()
    } catch (err) {
      setError('Failed to unlink Github account')
      console.error(err)
    } finally {
      setGithubBusy(false)
    }
  }

  const handleRepositoryConnect = async (repoId: string) => {
    try {
      setGithubRepoBusy(repoId)
      const response = await api.github['connect-repo'].$post({
        json: { repoId },
      })

      if (response.ok) {
        await loadProfile()
      } else {
        const errorData = await response.json()
        setError((errorData as { error: string }).error || 'Failed to connect repository')
      }
    } catch (err) {
      setError('Failed to connect repository')
      console.error(err)
    } finally {
      setGithubRepoBusy(null)
    }
  }

  const handleRepositoryDisconnect = async (repoId: string) => {
    try {
      setGithubRepoBusy(repoId)
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
    } finally {
      setGithubRepoBusy(null)
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

  const handleSlackConnectClick = () => {
    handleSlackConnect().catch((err) => {
      console.error('Slack link failed:', err)
      setError('Failed to link Slack account')
    })
  }

  const calendarConnected = !!profile?.googleAccount

  const handleGithubConnectClick = () => {
    handleGithubConnect().catch((err) => {
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
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Slack Account</h2>
        {profile.slackAccount ? (
          <div className="py-2 border-b border-gray-100">
            Team: {profile.organization.name }
          </div>
        ) : (
          <p>No Slack account linked</p>
        )}

        <div className="flex flex-wrap gap-3 mt-4">
          <button
            type="button"
            disabled
            className={`px-4 py-2 rounded border font-medium ${
              profile.slackAccount
                ? 'border-emerald-600 text-emerald-600'
                : 'border-red-500 text-red-500'
            }`}
          >
            {profile.slackAccount ? '✅ Connected!' : '❌ Not connected!'}
          </button>
          <button
            onClick={profile.slackAccount ? (() => { handleSlackDisconnect().catch(console.error) }) : handleSlackConnectClick}
            disabled={slackBusy}
            className={`px-6 py-3 rounded font-medium text-white cursor-pointer disabled:cursor-default ${
              profile.slackAccount
                ? 'bg-red-500 hover:bg-red-600 disabled:bg-red-400'
                : 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400'
            }`}
          >
            {slackBusy ? 'Working…' : profile.slackAccount ? 'Disconnect Slack' : 'Connect Slack'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Google Calendar</h2>
        {!profile.slackAccount ? (
          <p className="text-sm text-gray-700">Connect a Slack account first to connect your Google Calendar.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled
                className={`px-4 py-2 rounded border font-medium ${
                  calendarConnected
                    ? 'border-emerald-600 text-emerald-600'
                    : 'border-red-500 text-red-500'
                }`}
              >
                {calendarConnected ? '✅ Connected!' : '❌ Not connected!'}
              </button>
              {calendarConnected ? (
                <>
                  <button
                    onClick={() => { handleGoogleDisconnect().catch(console.error) }}
                    disabled={googleBusy}
                    className="px-6 py-3 rounded font-medium bg-red-500 text-white hover:bg-red-600 disabled:bg-red-400 cursor-pointer disabled:cursor-default"
                  >
                    {googleBusy ? 'Disconnecting…' : 'Disconnect calendar'}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleGoogleConnect}
                  disabled={googleBusy}
                  className="px-6 py-3 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 cursor-pointer disabled:cursor-default"
                >
                  {googleBusy ? 'Connecting…' : 'Connect Google Calendar'}
                </button>
              )}
            </div>
          </>
        )}

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
                  handleGithubDisconnect(profile.githubAccount!.accountId).catch((err) => {
                    console.error('Github unlink failed:', err)
                    setError('Failed to unlink Github account')
                  })
                }}
                disabled={githubBusy}
                className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 disabled:bg-red-400 text-sm cursor-pointer disabled:cursor-default"
              >
                {githubBusy ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>

            {!profile.githubAccount.linkedRepo && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4 mt-4">
                <h3 className="text-sm font-semibold text-blue-900 mb-2">How to connect a context repository:</h3>
                <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                  <li>Create a new GitHub repository in your organization (suggested name: <span className="font-mono bg-blue-100 px-1 py-0.5 rounded">pivotal-context</span>)</li>
                  <li>Invite GitHub username <span className="font-mono bg-blue-100 px-1 py-0.5 rounded">pivotal-bot</span> to that repository with <b>write</b> access</li>
                  <li>Refresh this page</li>
                  <li>The repository name should appear below. Click &quot;Connect&quot; to connect it with your organization</li>
                </ol>
              </div>
            )}
            {profile.githubAccount.linkedRepo ? (
              <div className="mt-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Connected repository:</p>
                <div className="bg-green-50 border border-green-200 rounded px-3 py-2 flex items-center justify-between">
                  <span className="text-sm font-mono text-green-900">{profile.githubAccount.linkedRepo.fullName}</span>
                  <button
                    onClick={() => {
                      handleRepositoryDisconnect(profile.githubAccount!.linkedRepo!.id).catch((err) => {
                        console.error('Disconnect repository failed:', err)
                        setError('Failed to disconnect repository')
                      })
                    }}
                    disabled={githubRepoBusy !== null}
                    className="px-3 py-1 bg-red-500 text-white text-sm rounded hover:bg-red-600 disabled:bg-red-400 cursor-pointer disabled:cursor-default"
                  >
                    {githubRepoBusy ? 'Disconnecting…' : 'Disconnect'}
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
                          handleRepositoryConnect(repo.id).catch((err) => {
                            console.error('Connect repository failed:', err)
                            setError('Failed to connect repository')
                          })
                        }}
                        disabled={githubRepoBusy !== null}
                        className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:bg-blue-400 cursor-pointer disabled:cursor-default"
                      >
                        {githubRepoBusy === repo.id ? 'Connecting…' : 'Connect'}
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
            <button onClick={handleGithubConnectClick} disabled={githubBusy} className="px-6 py-3 bg-gray-800 text-white rounded font-medium hover:bg-gray-900 disabled:bg-gray-600 mt-4 cursor-pointer disabled:cursor-default">
              {githubBusy ? 'Connecting…' : 'Connect Github Account'}
            </button>
          </>
        )}
      </div>

      {profile.organization && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Organization</h2>
          <div className="bg-gray-50 border border-gray-300 rounded-lg px-4 py-3 inline-block mb-4">
            <span className="font-medium text-gray-900">{profile.organization.name}</span>
          </div>

          <div className="mt-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Slack Bot</h3>
            {profile.organization.slackAppInstalled ? (
              <div className="py-2">
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled
                    className="px-4 py-2 rounded border font-medium border-emerald-600 text-emerald-600"
                  >
                    ✅ Bot Installed
                  </button>
                  <button
                    onClick={() => { handleSlackAppDisconnect().catch(console.error) }}
                    disabled={slackAppBusy}
                    className="px-6 py-3 rounded font-medium bg-red-500 text-white hover:bg-red-600 disabled:bg-red-400 cursor-pointer disabled:cursor-default"
                  >
                    {slackAppBusy ? 'Uninstalling…' : 'Uninstall Bot'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-sm text-gray-700 mb-3">
                  The Pivotal bot needs to be installed to your Slack workspace to enable conversation features and scheduling assistance.
                </p>
                <button
                  onClick={() => { handleSlackAppConnect().catch(console.error) }}
                  disabled={slackAppBusy}
                  className="px-6 py-3 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 cursor-pointer disabled:cursor-default"
                >
                  {slackAppBusy ? 'Connecting…' : 'Install to Slack'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}
