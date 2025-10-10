import { useState, useEffect } from 'react'
import { LogOut, Slack, Calendar as CalendarIcon, AlertCircle, CheckCircle, Link as LinkIcon } from 'react-feather'
import type { UserProfile } from '@shared/api-types'
import { api, authClient } from '@shared/api-client'
import { PageShell } from '@shared/components/page-shell'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@shared/components/ui/card'
import { Button } from '@shared/components/ui/button'
import { Badge } from '@shared/components/ui/badge'
import { Separator } from '@shared/components/ui/separator'
import { Skeleton } from '@shared/components/ui/skeleton'
import { LogoMark } from '@shared/components/logo-mark'

function StatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge className="badge-active border-transparent px-3 py-1 whitespace-nowrap pointer-events-none">
      <CheckCircle size={14} className="mr-1 text-[color:var(--status-active-text)]" /> Connected
    </Badge>
  ) : (
    <Badge variant="outline" className="border-border px-3 py-1 text-muted-foreground whitespace-nowrap pointer-events-none">
      <AlertCircle size={14} className="mr-1 text-muted-foreground" /> Not connected
    </Badge>
  )
}

function LoadingState() {
  return (
    <PageShell>
      <div className="flex min-h-[40vh] items-center justify-center">
        <LogoMark size={72} className="animate-spin-slow" />
      </div>
      <div className="space-y-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="border-token bg-surface">
            <CardHeader className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    </PageShell>
  )
}

export default function Profile() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [googleBusy, setGoogleBusy] = useState(false)
  const [slackBusy, setSlackBusy] = useState(false)
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubRepoBusy, setGithubRepoBusy] = useState<string | null>(null)
  const [slackAppBusy, setSlackAppBusy] = useState(false)
  const [teamMismatchError, setTeamMismatchError] = useState(false)

  useEffect(() => {
    // Check for error parameters in URL
    const params = new URLSearchParams(window.location.search)
    const errorType = params.get('error')

    if (errorType === 'team-mismatch') {
      setTeamMismatchError(true)
      // Remove error parameter from URL without reload
      window.history.replaceState({}, '', '/profile')
    }

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
      window.location.href = response.data.installUrl
    } catch (err) {
      setError('Failed to link Github account')
      console.error(err)
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

  const handleGithubUninstall = async () => {
    try {
      setGithubBusy(true)
      const response = await api.github['uninstall-app'].$post()

      if (response.ok) {
        await loadProfile()
      } else {
        const errorData = await response.json()
        setError((errorData as { error: string }).error || 'Failed to uninstall GitHub app')
      }
    } catch (err) {
      setError('Failed to uninstall GitHub app')
      console.error(err)
    } finally {
      setGithubBusy(false)
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

  const calendarConnected = !!profile?.googleAccount

  if (loading) return <LoadingState />
  if (error && !profile) {
    return (
      <PageShell>
        <Card className="border-destructive/40 bg-destructive/10 text-destructive">
          <CardHeader>
            <CardTitle>Unable to load profile</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    )
  }
  if (!profile) return <PageShell>No profile data</PageShell>

  return (
    <PageShell>
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h1 className="heading-hero text-foreground">Your Pivotal identity</h1>
          <p className="max-w-xl text-base text-muted-foreground">
            {'  Manage the roots of your workspace.'}
          </p>
        </div>
        <Button variant="outline" onClick={() => { handleSignOut().catch((err) => {
          console.error('Sign out failed:', err)
          setError('Failed to sign out')
        }) }} className="self-start cursor-pointer disabled:cursor-default">
          <LogOut size={16} /> Sign out
        </Button>
      </div>

      {teamMismatchError && (
        <Card className="mb-6 border-destructive/40 bg-destructive/10 text-destructive">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div className="flex-1">
              <CardTitle className="heading-card text-destructive mb-2">Team Mismatch Error</CardTitle>
              <CardDescription className="text-destructive/90">
                You connected your Google Calendar from a different Slack team than the one associated with your account.
              </CardDescription>
              <CardDescription className="text-destructive/90 mt-2">
                Please disconnect your Slack account below, then log in again using the correct Slack team.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setTeamMismatchError(false) }}
              className="text-destructive hover:text-destructive/80 hover:bg-destructive/20 cursor-pointer"
              aria-label="Close error message"
            >
              ×
            </Button>
          </CardHeader>
        </Card>
      )}

      {error && (
        <Card className="mb-6 border-destructive/40 bg-destructive/10 text-destructive">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="heading-card text-destructive">Something needs attention</CardTitle>
              <CardDescription className="text-destructive/80">{error}</CardDescription>
            </div>
            <AlertCircle size={32} />
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card className="border-token bg-surface">
          <CardHeader className="space-y-4">
            <CardTitle>Account</CardTitle>
            <CardDescription className="mt-1 text-sm text-muted-foreground">Your identity inside Pivotal.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium text-foreground">{profile.user.name}</span>
            </div>
            <Separator className="bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium text-foreground">{profile.user.email}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-token bg-surface">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="heading-card flex items-center gap-2">
                <Slack size={18} className="text-[color:var(--p-leaf)]" /> Slack workspace
              </CardTitle>
              <CardDescription className="mt-2 text-sm text-muted-foreground">Connect Slack so Pivotal can sync your workspace.</CardDescription>
            </div>
            <StatusBadge connected={!!profile.slackAccount} />
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {profile.slackAccount ? (
              <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                <span className="text-foreground">Workspace:</span> {profile.organization?.name}
              </div>
            ) : (
              <p className="text-muted-foreground">Link your Slack account to start syncing conversations.</p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              onClick={profile.slackAccount ? (() => { handleSlackDisconnect().catch(console.error) }) : (() => { handleSlackConnect().catch(console.error) })}
              disabled={slackBusy}
              variant={profile.slackAccount ? 'outline' : 'default'}
              className={profile.slackAccount ? 'border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer disabled:cursor-default' : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:cursor-default'}
            >
              {slackBusy ? 'Working…' : profile.slackAccount ? 'Disconnect Slack' : 'Connect Slack'}
            </Button>
          </CardFooter>
        </Card>

        <Card className="border-token bg-surface">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="heading-card flex items-center gap-2">
                <CalendarIcon size={18} className="text-[color:var(--p-leaf)]" /> Google Calendar
              </CardTitle>
              <CardDescription className="mt-2 text-sm text-muted-foreground">Sync your availability for scheduling.</CardDescription>
            </div>
            <StatusBadge connected={calendarConnected} />
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {!profile.slackAccount ? (
              <p>Connect Slack first to unlock calendar syncing.</p>
            ) : calendarConnected ? (
              <p>Your calendar is connected. Meetings will stay aligned with real availability.</p>
            ) : (
              <p>Link your Google calendar to let Pivotal propose real-time availability.</p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              onClick={calendarConnected ? (() => { handleGoogleDisconnect().catch(console.error) }) : handleGoogleConnect}
              disabled={googleBusy || !profile.slackAccount}
              variant={calendarConnected ? 'outline' : 'default'}
              className={calendarConnected ? 'border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer disabled:cursor-default' : 'bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:cursor-default'}
            >
              {googleBusy
                ? calendarConnected
                  ? 'Disconnecting…'
                  : 'Connecting…'
                : calendarConnected
                ? 'Disconnect calendar'
                : 'Connect Google Calendar'}
            </Button>
          </CardFooter>
        </Card>

        {profile.organization && (
          <Card className="border-token bg-surface lg:col-span-2">
            <CardHeader>
              <CardTitle className="heading-card flex items-center gap-2">
                <LinkIcon size={18} className="text-[color:var(--p-leaf)]" /> Organization
              </CardTitle>
              <CardDescription className="mt-2 text-sm text-muted-foreground">Settings shared by your workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 text-sm">
              <div className="space-y-4">
                <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">Slack workspace</div>
                  <div className="mt-1">{profile.organization.name}</div>
                </div>
                <div className="rounded-lg border border-token bg-background/40 p-4 text-xs text-muted-foreground">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="font-medium text-foreground">Pivotal bot</div>
                      <p className="mt-2 text-muted-foreground">
                        {profile.organization.slackAppInstalled
                          ? 'The bot is installed and can participate in workspace conversations.'
                          : 'Install the bot to let Pivotal participate in workspace conversations.'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end">
                      {profile.organization.slackAppInstalled ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { handleSlackAppDisconnect().catch(console.error) }}
                          disabled={slackAppBusy}
                          className="border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer disabled:cursor-default"
                        >
                          {slackAppBusy ? 'Uninstalling…' : 'Uninstall bot'}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => { handleSlackAppConnect().catch(console.error) }}
                          disabled={slackAppBusy || !profile.slackAccount}
                          className="bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:cursor-default"
                        >
                          {slackAppBusy ? 'Connecting…' : 'Install to Slack'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <Separator className="bg-border" />

              <div className="space-y-4">
                <h3 className="font-semibold text-foreground">GitHub</h3>

                {profile.organization.githubOrgName ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-foreground">Organization: <span className="font-mono">{profile.organization.githubOrgName}</span></div>
                          {profile.organization.githubOrgConnectedByUserName && (
                            <div className="mt-1">Connected by: {profile.organization.githubOrgConnectedByUserName}</div>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { handleGithubUninstall().catch(console.error) }}
                          disabled={githubBusy}
                          className="border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer disabled:cursor-default"
                        >
                          {githubBusy ? 'Uninstalling…' : 'Uninstall App'}
                        </Button>
                      </div>
                    </div>

                    {!profile.organization.githubLinkedRepo && (
                      <div className="rounded-lg border border-dashed border-token/80 bg-background/30 p-3 text-xs">
                        <p className="font-medium text-foreground mb-2">Connect a context repository for your organization:</p>
                        <p className="text-muted-foreground mb-2">
                          <strong>Note:</strong> The connected repository will be shared with all members of your organization.
                        </p>
                        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                          <li>Create a new GitHub repository in your organization (suggested name: <span className="font-mono text-foreground">pivotal-context</span>)</li>
                          <li>Invite GitHub username <span className="font-mono text-foreground">pivotal-bot</span> to that repository with <b>write</b> access</li>
                          <li>Refresh this page</li>
                          <li>The repository name should appear below. Click &quot;Connect&quot; to connect it with your organization</li>
                        </ol>
                      </div>
                    )}

                    {profile.organization.githubLinkedRepo ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-foreground">Connected repository:</p>
                        <p className="text-xs text-muted-foreground">This repository is shared with your organization.</p>
                        <div className="rounded-lg border border-token bg-background/40 p-3 text-xs">
                          <div className="flex items-center justify-between text-foreground">
                            <div>
                              <div className="font-mono font-medium">{profile.organization.githubLinkedRepo.fullName}</div>
                              {profile.organization.githubRepoConnectedByUserName && (
                                <div className="mt-1 text-muted-foreground">Connected by: {profile.organization.githubRepoConnectedByUserName}</div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                handleRepositoryDisconnect(profile.organization.githubLinkedRepo!.id).catch((err) => {
                                  console.error('Disconnect repository failed:', err)
                                  setError('Failed to disconnect repository')
                                })
                              }}
                              disabled={githubRepoBusy !== null}
                              className="border-destructive/40 text-destructive hover:bg-destructive/10 cursor-pointer disabled:cursor-default"
                            >
                              {githubRepoBusy ? 'Disconnecting…' : 'Disconnect'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : profile.organization.githubLinkableRepos && profile.organization.githubLinkableRepos.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-foreground">Available repositories:</p>
                        <p className="text-xs text-muted-foreground">Connecting a repository will make it available to your entire organization.</p>
                        <div className="space-y-2">
                          {profile.organization.githubLinkableRepos.map((repo) => (
                            <div
                              key={repo.fullName}
                              className="flex items-center justify-between rounded-lg border border-token bg-background/40 p-3"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono text-foreground">{repo.fullName}</span>
                                {repo.invitationId && (
                                  <Badge variant="outline" className="text-xs text-amber-500">Invitation pending</Badge>
                                )}
                              </div>
                              <Button
                                size="sm"
                                onClick={() => {
                                  handleRepositoryConnect(repo.id).catch((err) => {
                                    console.error('Connect repository failed:', err)
                                    setError('Failed to connect repository')
                                  })
                                }}
                                disabled={githubRepoBusy !== null}
                                className="bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:cursor-default"
                              >
                                {githubRepoBusy === repo.id ? 'Connecting…' : 'Connect'}
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No repositories available yet. Follow the instructions above to add one.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Connect your GitHub organization to enable context repository features.
                    </p>
                    <Button
                      onClick={() => { handleGithubConnect().catch(console.error) }}
                      disabled={githubBusy}
                      className="bg-green-600 text-white hover:bg-green-700 cursor-pointer disabled:cursor-default"
                    >
                      {githubBusy ? 'Connecting…' : 'Connect GitHub'}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  )
}
