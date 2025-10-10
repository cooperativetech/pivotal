import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { local_api } from '@shared/api-client'
import type { TopicWithState } from '@shared/api-types'
import { unserializeTopicWithState } from '@shared/api-types'
import { PageShell } from '@shared/components/page-shell'
import { LogoMark } from '@shared/components/logo-mark'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/components/ui/card'
import { Badge } from '@shared/components/ui/badge'
import { Button } from '@shared/components/ui/button'
import { compactTopicSummary } from '@shared/utils'

function LocalHome() {
  const [topics, setTopics] = useState<TopicWithState[]>([])
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
        setTopics(data.topics.map(unserializeTopicWithState))
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
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <LogoMark size={72} withHalo className="animate-spin-slow" />
        </div>
      </PageShell>
    )
  }

  if (error) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <Card className="border-destructive/40 bg-destructive/10 px-6 py-4 text-sm text-destructive">
            Error: {error}
          </Card>
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <div className="mb-8 text-center">
        <h1 className="heading-hero text-foreground">Flack testing interface</h1>
        <p className="mt-2 text-sm text-muted-foreground">Local mode — no authentication required.</p>
      </div>

      <div className="mb-6 flex justify-center">
        <Button asChild className="bg-primary text-primary-foreground">
          <Link to="/local/create-topic">+ New topic</Link>
        </Button>
      </div>

      {topics.length === 0 ? (
        <Card className="border-dashed border-token bg-surface/80 text-center">
          <CardHeader>
            <CardTitle>No topics yet</CardTitle>
            <CardDescription className="text-muted-foreground">
              Kick off a test message to generate a topic snapshot.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {topics.map((topic) => {
            const compactSummary = compactTopicSummary(topic.state.summary)

            return (
              <Card
                key={topic.id}
                className="border-token bg-surface/90 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
              >
              <CardHeader className="space-y-3">
                <CardTitle className="heading-card text-foreground" title={topic.state.summary}>
                  {compactSummary}
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="bg-secondary/80 text-secondary-foreground">
                    {topic.workflowType}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={topic.state.isActive ? 'badge-active border-transparent' : 'border-border'}
                  >
                    {topic.state.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                  <Badge variant="outline" className="border-border text-muted-foreground">
                    Local
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
                <div>
                  <div>Users: {topic.state.userIds.length}</div>
                  <div>
                    Created: {new Date(topic.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to={`/local/topic/${topic.id}`}>Open</Link>
                </Button>
              </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}

export default LocalHome
