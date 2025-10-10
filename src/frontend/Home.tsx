import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router'
import { Users, Activity, ArrowRight } from 'react-feather'
import type { TopicWithState, UserProfile } from '@shared/api-types'
import { unserializeTopicWithState } from '@shared/api-types'
import { useAuth } from './auth-context'
import { api, authClient } from '@shared/api-client'
import { PageShell } from '@shared/components/page-shell'
import { LogoMark } from '@shared/components/logo-mark'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@shared/components/ui/card'
import { Badge } from '@shared/components/ui/badge'
import { Button } from '@shared/components/ui/button'
import { Skeleton } from '@shared/components/ui/skeleton'
import { Input } from '@shared/components/ui/input'
import { compactTopicSummary } from '@shared/utils'

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function LoadingState() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} className="border-token bg-surface">
          <CardHeader>
            <Skeleton className="h-5 w-24 rounded" />
            <Skeleton className="mt-3 h-12 w-3/4 rounded" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

interface EmptyStateProps {
  slackConnected: boolean
  onSlackLink: () => void
  filter: 'active' | 'all'
  hasAnyTopics: boolean
  searchTerm: string
}

function EmptyState({ slackConnected, onSlackLink, filter, hasAnyTopics, searchTerm }: EmptyStateProps) {
  const trimmedSearch = searchTerm.trim()
  const hasSearch = trimmedSearch.length > 0

  let title = 'No topics yet'
  let description = slackConnected
    ? 'Your workspace is connected. Pivotal will populate topics as new conversations emerge.'
    : 'Connect Slack to let Pivotal gather the conversations and context you care about.'

  if (!slackConnected) {
    title = 'Connect Slack to get started'
    description = 'Link your workspace to start building your living map of conversations.'
  } else if (hasSearch) {
    title = 'No topics match your search'
    description =
      filter === 'active'
        ? 'No active topics match your search. Try a different keyword or switch to All to include archived threads.'
        : 'No topics match your search. Try a different keyword or adjust your filters to explore other conversations.'
  } else if (filter === 'active' && hasAnyTopics) {
    title = 'No active topics right now'
    description = 'Switch to All to review archived threads or wait for new conversations to bloom.'
  }

  return (
    <Card className="border-dashed border-token bg-surface/80 text-center">
      <CardHeader className="space-y-4">
        <LogoMark size={56} pulse withHalo className="mx-auto" />
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {!slackConnected && (
        <CardContent className="flex justify-center">
          <Button onClick={onSlackLink} variant="default" className="bg-primary text-primary-foreground">
            Link Slack Workspace
          </Button>
        </CardContent>
      )}
    </Card>
  )
}

function Home() {
  const [topics, setTopics] = useState<TopicWithState[]>([])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [userNameMap, setUserNameMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'active' | 'all'>('all')
  const [search, setSearch] = useState('')

  const filteredTopics = useMemo(() => {
    const base = filter === 'active' ? topics.filter((topic) => topic.state.isActive) : topics
    if (!search.trim()) return base
    const query = search.toLowerCase()
    return base.filter((topic) => {
      if (topic.state.summary.toLowerCase().includes(query)) return true
      return topic.state.userIds.some((id) => (userNameMap[id] || '').toLowerCase().includes(query))
    })
  }, [topics, filter, search, userNameMap])
  const { session } = useAuth()

  const fetchData = useCallback(async () => {
    if (!session) return

    try {
      setError(null)
      const [profileResponse, topicsResponse] = await Promise.all([
        api.profile.$get(),
        api.profile.topics.$get(),
      ])

      if (!profileResponse.ok) {
        let profileMessage = 'Failed to fetch profile'
        try {
          const errorBody = await profileResponse.json()
          if (errorBody && typeof errorBody === 'object' && 'error' in errorBody) {
            profileMessage = `${profileMessage} (${(errorBody as { error: string }).error})`
          }
        } catch (parseErr) {
          console.error('Unable to parse profile error response', parseErr)
        }
        throw new Error(profileMessage)
      }

      if (!topicsResponse.ok) {
        let topicsMessage = 'Failed to fetch topics'
        try {
          const errorBody = await topicsResponse.json()
          if (errorBody && typeof errorBody === 'object' && 'error' in errorBody) {
            topicsMessage = `${topicsMessage} (${(errorBody as { error: string }).error})`
          } else {
            topicsMessage = `${topicsMessage} (status ${topicsResponse.status})`
          }
        } catch (parseErr) {
          console.error('Unable to parse topics error response', parseErr)
          topicsMessage = `${topicsMessage} (status ${topicsResponse.status})`
        }
        throw new Error(topicsMessage)
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
    setError(null)
    try {
      await authClient.linkSocial({
        provider: 'slack',
      })
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

  if (loading && !error) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <LogoMark size={72} withHalo className="animate-spin-slow" />
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <h1 className="heading-hero text-foreground">Pivotal Topics</h1>
          <p className="max-w-xl text-base text-muted-foreground">
            {'A living map of your team\'s conversations.'}
          </p>
        </div>
        {profile?.slackAccount && (
          <div className="rounded-xl border border-token bg-surface px-4 py-3 text-sm text-muted-foreground shadow-sm">
            <div className="flex items-center gap-2 text-foreground">
              <Users size={16} />
              <span className="font-medium">{profile.organization?.name ?? 'Slack workspace'}</span>
            </div>
            <div className="mt-1 text-xs">Synced and ready for new context.</div>
          </div>
        )}
      </header>

      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="filter-toggle-shell relative flex h-12 w-full max-w-filter-toggle items-center rounded-full p-1.5 text-sm font-medium text-[color:rgba(13,38,24,0.78)] transition-colors">
          <span
            className="filter-toggle-thumb pointer-events-none absolute inset-y-1 w-[calc(50%-0.5rem)] rounded-full transition-transform duration-300 ease-out"
            style={{ transform: filter === 'all' ? 'translateX(0)' : 'translateX(100%)' }}
          />
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`relative z-10 flex-1 cursor-pointer rounded-full px-5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default ${
              filter === 'all'
                ? 'text-[color:rgba(13,38,24,0.94)] font-semibold'
                : 'text-[color:rgba(13,38,24,0.6)] hover:text-[color:rgba(13,38,24,0.85)]'
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setFilter('active')}
            className={`relative z-10 flex-1 cursor-pointer rounded-full px-5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default ${
              filter === 'active'
                ? 'text-[color:rgba(13,38,24,0.94)] font-semibold'
                : 'text-[color:rgba(13,38,24,0.6)] hover:text-[color:rgba(13,38,24,0.85)]'
            }`}
          >
            Active
          </button>
        </div>
        <div className="w-full sm:w-64">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search topics or people"
            className="h-10 rounded-full bg-surface"
          />
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/40 bg-destructive/10 text-destructive">
          <CardHeader className="space-y-2">
            <CardTitle>Something went wrong</CardTitle>
            <CardDescription className="text-destructive/80">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => { setLoading(true); fetchData().catch(console.error) }}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <LoadingState />
      ) : error ? null : filteredTopics.length === 0 ? (
        <EmptyState
          slackConnected={!!profile?.slackAccount}
          onSlackLink={handleSlackLinkClick}
          filter={filter}
          hasAnyTopics={topics.length > 0}
          searchTerm={search}
        />
      ) : (
        <div className="grid auto-rows-[minmax(0,1fr)] gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {filteredTopics.map((topic) => {
            const isActive = topic.state.isActive
            const users = topic.state.userIds.map((id) => userNameMap[id]).filter(Boolean)
            const compactSummary = compactTopicSummary(topic.state.summary)

            return (
              <Link
                key={topic.id}
                to={`/topic/${topic.id}`}
                className="group block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Card className="flex h-full flex-col border-token bg-surface shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
                  <CardHeader className="space-y-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary" className="bg-secondary/80 text-secondary-foreground">
                        {topic.workflowType}
                      </Badge>
                      <Badge
                        variant={isActive ? undefined : 'outline'}
                        className={
                          isActive
                            ? 'badge-active border-transparent px-2.5 py-1 transition-colors hover:bg-primary/75 hover:text-primary-foreground'
                            : 'border-border bg-muted/60 px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground'
                        }
                      >
                        {isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <CardTitle
                      className="text-lg leading-snug text-foreground line-clamp-2"
                      title={topic.state.summary}
                    >
                      {compactSummary}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2 text-xs uppercase tracking-wider">
                      <Activity size={14} className={isActive ? 'text-[color:var(--status-active-text)]' : 'text-muted-foreground'} />
                      Updated {formatDate(topic.state.createdAt)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col justify-between text-sm text-muted-foreground">
                    <div className="space-y-2">
                      {users.length > 0 && (
                        <div className="flex items-center gap-2">
                          <Users size={16} className="text-accent" />
                          <span className="truncate">{users.join(', ')}</span>
                        </div>
                      )}
                    </div>
                    <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                      <span>Created {formatDate(topic.createdAt)}</span>
                      <ArrowRight size={16} className="text-accent transition-transform group-hover:translate-x-1" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}

export default Home
