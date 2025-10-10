import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router'
import { ArrowLeft } from 'react-feather'
import { local_api } from '@shared/api-client'
import type { UserContext, CalendarEvent } from '@shared/api-types'
import { getShortTimezoneFromIANA } from '@shared/utils'
import { UserContextView } from './UserContextView'
import { useLocalMode } from './LocalModeContext'
import { PageShell } from '@shared/components/page-shell'
import { LogoMark } from '@shared/components/logo-mark'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/components/ui/card'
import { Button } from '@shared/components/ui/button'
import { Label } from '@shared/components/ui/label'
import { Textarea } from '@shared/components/ui/textarea'

interface User {
  id: string
  realName: string | null
  tz: string | null
  isBot: boolean
  context?: UserContext | null
  calendar: CalendarEvent[] | null
}

function TopicCreation() {
  const isLocalMode = useLocalMode()
  const [users, setUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [message, setMessage] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await local_api.users.$get({ query: {} })
        if (!response.ok) {
          throw new Error('Failed to fetch users')
        }
        const data = await response.json()
        const humanUsers = data.users
          .filter((user) => !user.isBot)
          .sort((a, b) => {
            const nameA = a.realName || a.id
            const nameB = b.realName || b.id
            return nameA.localeCompare(nameB)
          })
        setUsers(humanUsers)
        if (humanUsers.length > 0) {
          setSelectedUserId(humanUsers[0].id)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchUsers().catch(console.error)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedUserId || !message.trim() || !isLocalMode) return

    setSending(true)
    setError(null)
    try {
      const response = await local_api.message.$post({
        json: {
          userId: selectedUserId,
          text: message.trim(),
        },
      })

      if (!response.ok) {
        throw new Error('Failed to send message')
      }

      const data = await response.json()

      if ('topicId' in data) {
        const topicPath = isLocalMode ? `/local/topic/${data.topicId}` : `/topic/${data.topicId}`
        await navigate(topicPath)
      } else {
        setMessage('')
        setSelectedUserId('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <LogoMark size={72} withHalo className="animate-spin-slow" />
        </div>
      </PageShell>
    )
  }

  if (error && users.length === 0) {
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
      <div className="mx-auto w-full max-w-3xl">
        <Card className="border-token bg-surface/95 shadow-lg">
          <CardHeader className="space-y-3">
            <Link
              to={isLocalMode ? '/local' : '/'}
              className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground transition hover:text-foreground"
            >
              <ArrowLeft size={16} /> Back
            </Link>
            <CardTitle className="heading-section text-foreground">Start a new conversation</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Seed a local topic by sending a message as any member of your workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <form onSubmit={(e) => {
              handleSubmit(e).catch(console.error)
            }} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="user">Select user</Label>
                <select
                  id="user"
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="w-full rounded-lg border border-token bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={sending}
                  required
                >
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.realName || user.id} {user.tz ? `(${getShortTimezoneFromIANA(user.tz)})` : ''}
                    </option>
                  ))}
                </select>
                {selectedUserId && (() => {
                  const selectedUser = users.find((u) => u.id === selectedUserId)
                  if (!selectedUser?.context) return null

                  return (
                    <div className="rounded-xl border border-token/60 bg-background/60 px-3 py-2">
                      <UserContextView
                        calendar={selectedUser.calendar}
                        context={selectedUser.context}
                        userTimezone={selectedUser.tz}
                      />
                    </div>
                  )
                })()}
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Message</Label>
                <Textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  placeholder="Type your message here…"
                  disabled={sending}
                  className="resize-none"
                />
              </div>

              <Button
                type="submit"
                disabled={!selectedUserId || !message.trim() || sending}
                className="w-full"
              >
                {sending ? 'Sending…' : 'Send message'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}

export default TopicCreation
