import { useState, useEffect } from 'react'
import { LogOut, Slack, Calendar as CalendarIcon, GitHub, AlertCircle, CheckCircle, Link as LinkIcon } from 'react-feather'
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
    <Badge className="badge-active border-transparent px-3 py-1 whitespace-nowrap">
      <CheckCircle size={14} className="mr-1 text-[color:var(--status-active-text)]" /> Connected
    </Badge>
  ) : (
    <Badge variant="outline" className="border-border px-3 py-1 text-muted-foreground whitespace-nowrap">
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
        }) }} className="self-start">
          <LogOut size={16} /> Sign out
        </Button>
      </div>

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
              className={profile.slackAccount ? 'border-destructive/40 text-destructive hover:bg-destructive/10' : ''}
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
              className={calendarConnected ? 'border-destructive/40 text-destructive hover:bg-destructive/10' : ''}
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

        <Card className="border-token bg-surface">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="heading-card flex items-center gap-2">
                <GitHub size={18} className="text-[color:var(--p-leaf)]" /> GitHub repositories
              </CardTitle>
              <CardDescription className="mt-2 text-sm text-muted-foreground">Share repos so Pivotal can pull docs and history.</CardDescription>
            </div>
            <StatusBadge connected={!!profile.githubAccount} />
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {profile.githubAccount ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between text-foreground">
                    <span className="font-medium">{profile.githubAccount.username}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleGithubDisconnect(profile.githubAccount!.accountId).catch((err) => {
                          console.error('Github unlink failed:', err)
                          setError('Failed to unlink Github account')
                        })
                      }}
                      disabled={githubBusy}
                      className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    >
                      {githubBusy ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  </div>
                  {profile.githubAccount.orgName && (
                    <div className="mt-2">Org: {profile.githubAccount.orgName}</div>
                  )}
                </div>

                {profile.githubAccount.linkedRepo ? (
                  <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                    <div className="flex items-center justify-between text-foreground">
                      <span className="font-medium">{profile.githubAccount.linkedRepo.fullName}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          handleRepositoryDisconnect(profile.githubAccount!.linkedRepo!.id).catch((err) => {
                            console.error('Disconnect repository failed:', err)
                            setError('Failed to disconnect repository')
                          })
                        }}
                        disabled={githubRepoBusy !== null}
                        className="border-destructive/40 text-destructive hover:bg-destructive/10"
                      >
                        {githubRepoBusy ? 'Disconnecting…' : 'Disconnect'}
                      </Button>
                    </div>
                    <p className="mt-2">Primary context repository.</p>
                  </div>
                ) : (
                  <div className="space-y-3 text-xs text-muted-foreground">
                    <div className="rounded-lg border border-dashed border-token/80 bg-background/30 p-3">
                      <p className="font-medium text-foreground">How to connect a context repository:</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4">
                        <li>Create a GitHub repo (e.g. <span className="font-mono text-foreground">pivotal-context</span>).</li>
                        <li>Invite <span className="font-mono text-foreground">pivotal-bot</span> with write access.</li>
                        <li>Refresh this page after the invite lands.</li>
                        <li>Connect the repo from the list below.</li>
                      </ol>
                    </div>

                    {profile.githubAccount.linkableRepos && profile.githubAccount.linkableRepos.length > 0 ? (
                      <div className="space-y-2">
                        {profile.githubAccount.linkableRepos.map((repo) => (
                      <div
                        key={repo.fullName}
                        className="flex items-center justify-between rounded-lg border border-token bg-background/40 p-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/60 focus-within:ring-offset-2 focus-within:ring-offset-background"
                      >
                        <div className="space-y-1">
                              <p className="font-medium text-foreground">{repo.fullName}</p>
                              {repo.invitationId && (
                <Badge variant="outline" className="text-xs text-amber-500">
                              Invitation pending
                            </Badge>
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
                            >
                              {githubRepoBusy === repo.id ? 'Connecting…' : 'Connect'}
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No repositories available yet. Follow the instructions above to add one.</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p>Authorize GitHub so Pivotal can read your context repos.</p>
                <Button onClick={() => { handleGithubConnect().catch((err) => {
                  console.error('Github link failed:', err)
                  setError('Failed to link Github account')
                }) }} disabled={githubBusy}>
                  {githubBusy ? 'Connecting…' : 'Connect GitHub'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {profile.organization && (
          <Card className="border-token bg-surface">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="heading-card flex items-center gap-2">
                <LinkIcon size={18} className="text-[color:var(--p-leaf)]" /> Organization
              </CardTitle>
            <CardDescription className="mt-2 text-sm text-muted-foreground">Settings shared by your workspace.</CardDescription>
            </div>
            <Badge variant="secondary" className="bg-secondary/80 text-secondary-foreground">
              {profile.organization.name}
            </Badge>
          </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Slack workspace</div>
                <div className="mt-1">{profile.organization.slackTeamId}</div>
              </div>
              <div className="rounded-lg border border-token bg-background/40 p-3 text-xs text-muted-foreground">
                <div className="flex items-center justify-between text-foreground">
                  <span className="font-medium">Pivotal bot</span>
                  <StatusBadge connected={profile.organization.slackAppInstalled} />
                </div>
                <p className="mt-2 text-muted-foreground">
                  Install the bot to let Pivotal participate in workspace conversations.
                </p>
              </div>
            </CardContent>
            <CardFooter>
              {profile.organization.slackAppInstalled ? (
                <Button
                  variant="outline"
                  onClick={() => { handleSlackAppDisconnect().catch(console.error) }}
                  disabled={slackAppBusy}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  {slackAppBusy ? 'Uninstalling…' : 'Uninstall bot'}
                </Button>
              ) : (
                <Button
                  onClick={() => { handleSlackAppConnect().catch(console.error) }}
                  disabled={slackAppBusy || !profile.slackAccount}
                >
                  {slackAppBusy ? 'Connecting…' : 'Install to Slack'}
                </Button>
              )}
            </CardFooter>
          </Card>
        )}
      </div>
    </PageShell>
  )
}
