import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useSearchParams } from 'react-router'
import { ArrowLeft, Calendar as CalendarIcon, ChevronDown } from 'react-feather'
import { api, local_api, authClient } from '@shared/api-client'
import type { CalendarEvent, TopicData, SlackMessage, SlackChannel, TopicStateWithMessageTs } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'
import type { UserProfile } from '@shared/api-types'
import { getShortTimezoneFromIANA, getShortTimezone, compactTopicSummary } from '@shared/utils'
import { useLocalMode } from './LocalModeContext'
import { Button } from '@shared/components/ui/button'
import { Badge } from '@shared/components/ui/badge'
import { Card } from '@shared/components/ui/card'
import { PageShell } from '@shared/components/page-shell'
import { LogoMark } from '@shared/components/logo-mark'
import { LogoMarkInline } from '@shared/components/logo-mark-inline'

interface ChannelGroup {
  channelId: string
  messages: SlackMessage[]
}

function Topic() {
  const { topicId } = useParams<{ topicId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [topicData, setTopicData] = useState<TopicData | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [userCalendars, setUserCalendars] = useState<Record<string, CalendarEvent[] | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isLocalMode = useLocalMode()
  const apiClient = isLocalMode ? local_api : api
  const [timelinePosition, setTimelinePosition] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [testingMessageId, setTestingMessageId] = useState<string | null>(null)
  const [llmResponse, setLlmResponse] = useState<string | null>(null)
  const [showPopup, setShowPopup] = useState(false)
  const [chatInputs, setChatInputs] = useState<Map<string, string>>(new Map())
  const [sendingChannels, setSendingChannels] = useState<Set<string>>(new Set())
  const [topicState, setTopicState] = useState<TopicStateWithMessageTs | null>(null)
  const [hiddenBlocks, setHiddenBlocks] = useState<Set<string>>(new Set())
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [showCalendarPanel, setShowCalendarPanel] = useState(false)
  const [thumbPulse, setThumbPulse] = useState(false)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef<number>(0)
  const dragStartPosition = useRef<number>(0)
  const messageContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const initialLoadRef = useRef(true)
  const pulseTimeoutRef = useRef<number | null>(null)

  const botUserId = topicData?.topic.botUserId ?? null

  const userMap = useMemo(() => {
    const map = new Map<string, string>()
    if (!topicData) return map

    topicData.users.forEach((user) => {
      map.set(user.id, user.realName || user.id)
    })

    if (topicData.topic.botUserId && !map.has(topicData.topic.botUserId)) {
      map.set(topicData.topic.botUserId, 'Pivotal')
    }

    return map
  }, [topicData])

  const formatSlackText = useCallback(
    (text: string) =>
      (text ?? '').replace(/<@([A-Z0-9]+)>/gi, (_, id: string) => {
        const displayName = userMap.get(id) || (botUserId === id ? 'Pivotal' : id)
        const normalized = displayName.startsWith('@') ? displayName.slice(1) : displayName
        return `@${normalized}`
      }),
    [userMap, botUserId],
  )

  const compactSummary = useMemo(
    () => compactTopicSummary(topicState?.summary ?? ''),
    [topicState?.summary],
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    const previousTitle = document.title
    const displayTitle = compactSummary || topicState?.summary || 'Topic'
    document.title = `Pivotal · ${displayTitle}`
    return () => {
      document.title = previousTitle
    }
  }, [compactSummary, topicState?.summary])

  useEffect(() => {
    const fetchTopicData = async () => {
      if (!topicId) return

      try {
        const response = await apiClient.topics[':topicId'].$get({
          param: { topicId },
          query: {},
        })
        if (!response.ok) {
          throw new Error('Failed to fetch topic data')
        }
        const data = await response.json()
        const deserialized = unserializeTopicData(data.topicData)
        setTopicData(deserialized)
        setTopicState(deserialized.states.length > 0 ? deserialized.states[deserialized.states.length - 1] : null)
        setUserCalendars(data.userCalendars)

        // Only read query params on initial load
        if (initialLoadRef.current) {
          initialLoadRef.current = false
          // Check for messageId in query params
          const messageIdParam = searchParams.get('messageId')
          if (messageIdParam && data.topicData.messages.length > 0) {
            // Sort messages to find the position of the specified message
            const sorted = [...data.topicData.messages].sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
            const position = sorted.findIndex((m) => m.id === messageIdParam)
            if (position !== -1) {
              setTimelinePosition(position)
            } else {
              // Default to showing all messages if messageId not found
              setTimelinePosition(data.topicData.messages.length - 1)
            }
          } else if (data.topicData.messages.length > 0) {
            // Default: Initialize timeline to show all messages
            setTimelinePosition(data.topicData.messages.length - 1)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchTopicData().catch(console.error)
  }, [topicId, apiClient, searchParams])

  useEffect(() => {
  const loadProfile = async () => {
      try {
        const session = await authClient.getSession()
        if (!session.data?.session?.token) {
          if (!isLocalMode) {
            setError('Not authenticated')
          }
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
      }
    }

    loadProfile().catch(console.error)
  }, [isLocalMode])

  const viewerSlackId = profile?.slackAccount?.accountId ?? null
  const calendarConnected = !!profile?.googleAccount
  const viewerCalendar = useMemo(() => {
    if (!viewerSlackId) return null
    return userCalendars[viewerSlackId] ?? null
  }, [userCalendars, viewerSlackId])

  const upcomingEvents = useMemo(() => {
    if (!viewerCalendar) return []
    const now = Date.now()
    return viewerCalendar
      .filter((event) => new Date(event.end).getTime() >= now)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, 3)
  }, [viewerCalendar])

  // Sort all messages by timestamp for timeline
  const sortedMessages = useMemo(() => {
    return topicData?.messages
      ? [...topicData.messages].sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
      : []
  }, [topicData?.messages])

  // Filter messages based on timeline position
  const visibleMessageIds = new Set(
    timelinePosition !== null
      ? sortedMessages.slice(0, timelinePosition + 1).map((m) => m.id)
      : sortedMessages.map((m) => m.id),
  )

  // Update topicState based on current timeline position
  useEffect(() => {
    if (!topicData?.states || topicData.states.length === 0) {
      setTopicState(null)
      return
    }

    if (sortedMessages.length === 0) {
      setTopicState(topicData.states[topicData.states.length - 1])
      return
    }

    const currentMessageRawTs = timelinePosition !== null && sortedMessages[timelinePosition]
      ? sortedMessages[timelinePosition].rawTs
      : sortedMessages[sortedMessages.length - 1]?.rawTs

    if (!currentMessageRawTs) {
      setTopicState(null)
      return
    }

    const applicableStates = topicData.states.filter(
      (state) => Number(state.createdByMessageRawTs) <= Number(currentMessageRawTs),
    )

    const fallbackState = topicData.states[topicData.states.length - 1]
    const nextState = applicableStates.length > 0 ? applicableStates[applicableStates.length - 1] : fallbackState
    setTopicState(nextState)
  }, [timelinePosition, sortedMessages, topicData?.states])

  // Update URL query parameter when timeline position changes (debounced)
  useEffect(() => {
    if (timelinePosition !== null && sortedMessages[timelinePosition]) {
      const timer = setTimeout(() => {
        const currentMessageId = sortedMessages[timelinePosition].id
        setSearchParams((prev) => {
          const newParams = new URLSearchParams(prev)
          newParams.set('messageId', currentMessageId)
          return newParams
        }, { replace: true }) // Use replace to avoid creating history entries for each change
      }, 50) // Debounce for 50ms

      return () => clearTimeout(timer)
    }
  }, [timelinePosition, sortedMessages, setSearchParams])

  // Scroll message containers to bottom when timeline changes or on initial load
  useEffect(() => {
    // Small delay to ensure DOM is updated
    const timer = setTimeout(() => {
      messageContainerRefs.current.forEach((container) => {
        if (container) {
          container.scrollTop = container.scrollHeight
        }
      })
    }, 10)

    return () => clearTimeout(timer)
  }, [timelinePosition, topicData, showCalendarPanel])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!topicData || sortedMessages.length === 0 || sendingChannels.size > 0) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setTimelinePosition((prev) => {
          if (prev === null) return sortedMessages.length - 1
          return Math.max(0, prev - 1)
        })
        setThumbPulse(true)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setTimelinePosition((prev) => {
          if (prev === null) return sortedMessages.length - 1
          return Math.min(sortedMessages.length - 1, prev + 1)
        })
        setThumbPulse(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [topicData, sortedMessages.length, sendingChannels.size])

  // Handle timeline click
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0 || sendingChannels.size > 0) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const width = rect.width
    const position = Math.round((x / width) * (sortedMessages.length - 1))
    setTimelinePosition(Math.max(0, Math.min(sortedMessages.length - 1, position)))
    setThumbPulse(true)
  }, [sortedMessages.length, sendingChannels.size])

  // Handle test LLM response
  const handleTestLlmResponse = useCallback(async (messageId: string) => {
    if (!topicId || !isLocalMode) return

    setTestingMessageId(messageId)
    try {
      const response = await local_api.test_llm_response.$post({
        json: {
          topicId,
          messageId,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to test LLM response')
      }

      const data = await response.json()
      setLlmResponse(JSON.stringify(data, null, 2))
      setShowPopup(true)
    } catch (err) {
      console.error('Error testing LLM response:', err)
      setLlmResponse(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to test LLM response' }, null, 2))
      setShowPopup(true)
    } finally {
      setTestingMessageId(null)
    }
  }, [topicId, isLocalMode])

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0 || sendingChannels.size > 0) return

    setIsDragging(true)
    setThumbPulse(false)
    dragStartX.current = e.clientX
    dragStartPosition.current = timelinePosition ?? sortedMessages.length - 1

    e.preventDefault()
  }, [sortedMessages.length, timelinePosition, sendingChannels.size])

  // Handle drag move
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current || sortedMessages.length === 0) return

      const rect = timelineRef.current.getBoundingClientRect()
      const deltaX = e.clientX - dragStartX.current
      const width = rect.width
      const deltaPosition = Math.round((deltaX / width) * (sortedMessages.length - 1))
      const newPosition = dragStartPosition.current + deltaPosition
      setTimelinePosition(Math.max(0, Math.min(sortedMessages.length - 1, newPosition)))
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setThumbPulse(true)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, sortedMessages.length])

  useEffect(() => {
    if (!thumbPulse) return
    if (pulseTimeoutRef.current) window.clearTimeout(pulseTimeoutRef.current)
    pulseTimeoutRef.current = window.setTimeout(() => {
      setThumbPulse(false)
      pulseTimeoutRef.current = null
    }, 500)
    return () => {
      if (pulseTimeoutRef.current) {
        window.clearTimeout(pulseTimeoutRef.current)
        pulseTimeoutRef.current = null
      }
    }
  }, [thumbPulse])

  const handleTopicStatusToggle = useCallback(() => {
    if (!topicId || !topicState) return
    const nextActive = !topicState.isActive
    const confirmMessage = nextActive
      ? 'Mark this topic active again?'
      : 'Mark this topic inactive?'
    if (!window.confirm(confirmMessage)) return

    setUpdatingStatus(true)

    fetch(`/api/topics/${topicId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isActive: nextActive }),
    }).then(async (response) => {
      if (!response.ok) {
        let message = 'Failed to update topic status'
        try {
          const errorBody: unknown = await response.json()
          if (typeof errorBody === 'object' && errorBody && 'error' in errorBody) {
            const maybeError = (errorBody as { error?: string }).error
            if (maybeError) message = maybeError
          }
        } catch {
          // ignore
        }
        setError(message)
        return
      }

      setTopicState((prev) => (prev ? { ...prev, isActive: nextActive } : prev))
      setError(null)
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to update topic status')
    }).finally(() => {
      setUpdatingStatus(false)
    })
  }, [topicId, topicState])

  const redirectToCalendarAuth = useCallback(() => {
    if (typeof window === 'undefined') return

    const currentPath = window.location.pathname + window.location.search
    const params = new URLSearchParams({
      callbackURL: currentPath,
      errorCallbackURL: currentPath,
    })
    window.location.href = `/api/google/authorize?${params.toString()}`
  }, [])

  if (loading && !error) {
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
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive shadow-sm">
          Error: {error}
        </div>
      </div>
    )
  }

  if (!topicData || !topicState) {
    return (
      <PageShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <LogoMark size={72} withHalo className="animate-spin-slow" />
        </div>
      </PageShell>
    )
  }

  // Group messages by channel only (filtered by timeline position)
  const channelGroups: ChannelGroup[] = []
  const channelMap = new Map<string, ChannelGroup>()

  topicData.messages.forEach((msg) => {
    // Only include messages that are visible based on timeline position
    if (!visibleMessageIds.has(msg.id)) return

    if (!channelMap.has(msg.channelId)) {
      const group: ChannelGroup = {
        channelId: msg.channelId,
        messages: [],
      }
      channelMap.set(msg.channelId, group)
      channelGroups.push(group)
    }

    const channelGroup = channelMap.get(msg.channelId)
    if (channelGroup) {
      channelGroup.messages.push(msg)
    }
  })

  // Sort messages within each channel by timestamp
  channelGroups.forEach((group) => {
    group.messages.sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
  })

  // Check if we're viewing the latest message
  const isViewingLatest = timelinePosition === sortedMessages.length - 1

  const lastMessageDate = sortedMessages.length > 0
    ? sortedMessages[sortedMessages.length - 1].timestamp
    : topicState?.createdAt ?? null


  // Helper to check if a channel is a DM (1 user since bot is not included)
  const isDMChannel = (channelId: string) => {
    const channel = topicData.channels?.find((ch) => ch.id === channelId)
    return channel?.userIds.length === 1
  }

  // Helper to get the current user ID for a channel
  const getCurrentUserId = (channelId: string) => {
    const channel = topicData.channels?.find((ch) => ch.id === channelId)
    return channel?.userIds[0]
  }

  // Render Slack-like action buttons (local only)
  const renderActionButtons = (msg: SlackMessage, channelId: string) => {
    if (!isLocalMode || hiddenBlocks.has(msg.id)) return null
    type SlackText = { type?: string; text?: string }
    type SlackActionElement = { url?: string; action_id?: string; text?: SlackText }
    type SlackActionsBlock = { type: 'actions'; elements: SlackActionElement[] }

    const raw: unknown = msg.raw
    const hasBlocks = typeof raw === 'object' && raw !== null && Object.prototype.hasOwnProperty.call(Object(raw), 'blocks')
    const rawBlocks = hasBlocks ? (raw as { blocks?: unknown }).blocks : undefined
    if (!Array.isArray(rawBlocks)) return null

    const actions = rawBlocks.find((b): b is SlackActionsBlock => {
      if (typeof b !== 'object' || b === null) return false
      const block = b as Partial<SlackActionsBlock>
      return block.type === 'actions' && Array.isArray(block.elements)
    })
    if (!actions) return null

    const isDM = isDMChannel(channelId)
    const currentUserId = isDM ? getCurrentUserId(channelId) : null

    const signOutAndRedirect = async (url: string) => {
      await authClient.signOut()
      window.location.href = url
    }

    const onNotNow = () => {
      setHiddenBlocks((prev) => new Set(prev).add(msg.id))
    }

    const onDontAskAgain = async () => {
      if (!currentUserId) return
      try {
        await local_api.calendar.dont_ask_again.$post({ json: { userId: currentUserId } })
      } catch (e) {
        console.warn('dont_ask_again failed', e)
      } finally {
        setHiddenBlocks((prev) => new Set(prev).add(msg.id))
      }
    }

    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.elements.map((el, idx: number) => {
          const label = el.text?.text || 'Button'
          if (typeof el.url === 'string') {
            return (
              <Button
                key={idx}
                onClick={() => {
                  signOutAndRedirect(el.url as string).catch(console.error)
                }}
                variant="secondary"
                size="sm"
                className="bg-secondary text-secondary-foreground"
              >
                {label}
              </Button>
            )
          }
          if (el.action_id === 'calendar_not_now') {
            return (
              <Button
                key={idx}
                onClick={onNotNow}
                variant="ghost"
                size="sm"
              >
                {label}
              </Button>
            )
          }
          if (el.action_id === 'dont_ask_calendar_again') {
            return (
              <Button
                key={idx}
                onClick={() => {
                  onDontAskAgain().catch(console.error)
                }}
                variant="ghost"
                size="sm"
              >
                {label}
              </Button>
            )
          }
          return null
        })}
        {isLocalMode && (
          <Button
            key="llm-test"
            size="sm"
            variant="outline"
            onClick={() => {
              handleTestLlmResponse(msg.id).catch(console.error)
            }}
            disabled={testingMessageId === msg.id}
          >
            {testingMessageId === msg.id ? 'Testing…' : 'Test LLM response'}
          </Button>
        )}
      </div>
    )
  }

  // Handle sending a message
  const handleSendMessage = async (channelId: string) => {
    const chatInput = chatInputs.get(channelId) || ''
    const currentUserId = getCurrentUserId(channelId)
    if (!chatInput.trim() || !currentUserId || !topicId || sendingChannels.has(channelId) || !isLocalMode) return

    setSendingChannels((prev) => new Set(prev).add(channelId))
    try {
      const response = await local_api.message.$post({
        json: {
          userId: currentUserId,
          text: chatInput.trim(),
          topicId,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to send message')
      }

      const data = await response.json()

      // Add new messages to the topic data
      if ('savedReqMessage' in data && 'resMessages' in data) {
        const newMessages = [data.savedReqMessage, ...data.resMessages].map((msg) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }))

        // Check for any new channelIds that aren't in topicData
        let validChannels: SlackChannel[] = []
        if (isLocalMode) {
          const existingChannelIds = new Set(topicData.channels?.map((ch) => ch.id) || [])
          const newChannelIds = newMessages
            .map((msg) => msg.channelId)
            .filter((channelId) => !existingChannelIds.has(channelId))

          // Fetch channel info for any new channels
          const newChannels = await Promise.all(
            [...new Set(newChannelIds)].map(async (channelId) => {
              try {
                const response = await local_api.channels[':channelId'].$get({
                  param: { channelId },
                })
                if (response.ok) {
                  return await response.json()
                }
                console.error(`Failed to fetch channel ${channelId}`)
                return null
              } catch (err) {
                console.error(`Error fetching channel ${channelId}:`, err)
                return null
              }
            }),
          )

          // Filter out any null results
          validChannels = newChannels.filter((ch) => ch !== null)
        }

        setTopicData((prev) => {
          if (!prev) return prev
          const updatedMessages = [...prev.messages, ...newMessages]
          // Update timeline position to show all messages including new ones
          // Sort to find the correct position
          const sorted = [...updatedMessages].sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
          setTimelinePosition(sorted.length - 1)

          // Merge new channels with existing ones
          const updatedChannels = [
            ...(prev.channels || []),
            ...validChannels,
          ]

          return {
            ...prev,
            messages: updatedMessages,
            channels: updatedChannels,
          }
        })
      }

      // Clear the input for this channel
      setChatInputs((prev) => {
        const next = new Map(prev)
        next.set(channelId, '')
        return next
      })
    } catch (err) {
      console.error('Error sending message:', err)
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSendingChannels((prev) => {
        const next = new Set(prev)
        next.delete(channelId)
        return next
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background/95 px-4 py-6 sm:px-6 lg:px-10">
      <div className="gap-4 border-b border-token pb-4 sm:grid sm:grid-cols-[minmax(0,1fr)_260px] sm:items-start sm:gap-6">
        <div className="space-y-2">
          <Link
            to={isLocalMode ? '/local' : '/'}
            className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft size={16} /> Back
          </Link>
          <h1 className="heading-section text-foreground" title={topicState.summary}>
            {compactSummary || topicState.summary}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="bg-secondary/70 text-secondary-foreground">
              {topicData.topic.workflowType}
            </Badge>
            <Badge
              variant={topicState.isActive ? undefined : 'outline'}
              className={
                topicState.isActive
                  ? 'border-transparent bg-emerald-500/15 px-2.5 py-1 text-emerald-400 shadow-[0_0_0_1px_rgba(95,115,67,0.25)] transition-colors hover:bg-primary/75 hover:text-primary-foreground'
                  : 'border-border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground'
              }
            >
              {topicState.isActive ? 'Active' : 'Inactive'}
            </Badge>
            <span>
              {lastMessageDate
                ? `Last message ${new Date(lastMessageDate).toLocaleString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`
                : 'No messages yet'}
            </span>
            {sortedMessages.length > 0 && timelinePosition !== null && (
              <span>
                Showing {timelinePosition + 1} of {sortedMessages.length} messages
              </span>
            )}
            {!isViewingLatest && (
              <span className="rounded-full bg-muted px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/80">
                Historic view
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:mt-0 sm:w-[260px] sm:items-end sm:justify-self-end">
          <Button
            type="button"
            variant={topicState.isActive ? 'outline' : 'default'}
            className={`w-full ${topicState.isActive ? 'border-border text-muted-foreground hover:bg-muted' : ''}`}
            onClick={handleTopicStatusToggle}
            disabled={updatingStatus}
          >
            {updatingStatus
              ? 'Saving…'
              : topicState.isActive
              ? 'Mark inactive'
              : 'Mark active'}
          </Button>
          {profile && (
            <button
              type="button"
              onClick={() => setShowCalendarPanel((prev) => !prev)}
              aria-expanded={showCalendarPanel}
              className={`group w-full rounded-xl border border-token bg-surface px-4 py-3 text-left text-xs text-muted-foreground shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                showCalendarPanel ? 'ring-2 ring-accent/60 ring-offset-2 ring-offset-background' : ''
              }`}
            >
              <div className="flex items-center justify-between text-foreground">
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-[color:rgba(95,115,67,0.15)] p-1.5 text-[color:var(--p-leaf)] transition-colors group-hover:bg-primary/15 group-hover:text-primary">
                    <CalendarIcon size={16} />
                  </div>
                  <div className="text-left text-xs font-medium uppercase tracking-[0.3em] text-muted-foreground/80">Calendar</div>
                </div>
                <ChevronDown
                  size={16}
                  className={`text-muted-foreground transition-transform duration-200 ${showCalendarPanel ? 'rotate-180 text-foreground' : 'group-hover:text-foreground'}`}
                />
              </div>
              <p className="mt-2 text-left text-xs text-muted-foreground">
                Showing all times in {getShortTimezone()}.
              </p>
            </button>
          )}
        </div>
      </div>
      {channelGroups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-xl border border-token bg-surface px-4 py-3 text-sm text-muted-foreground shadow-sm">
            No conversations found for this topic
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid gap-2 overflow-hidden pb-2 md:grid-cols-2 lg:grid-cols-3">
          <div
            className={`min-h-0 grid grid-cols-1 gap-2 md:col-span-2 ${
              showCalendarPanel ? 'lg:col-span-2 lg:grid-cols-2' : 'lg:col-span-3 lg:grid-cols-3'
            }`}
          >
            {channelGroups.map((channel) => {
            const isDM = isDMChannel(channel.channelId)
            const userId = isDM ? getCurrentUserId(channel.channelId) : null
            const user = userId ? topicData.users.find((u) => u.id === userId) : null
            const channelInfo = topicData.channels?.find((ch) => ch.id === channel.channelId)
            const participantNames = (channelInfo?.userIds ?? [])
              .map((id) => topicData.users.find((u) => u.id === id)?.realName?.trim())
              .filter((name): name is string => Boolean(name))

            const humanLabel = isDM
              ? user?.realName || 'Direct message'
              : participantNames.length > 0
                ? `${participantNames.slice(0, 3).join(', ')}${participantNames.length > 3 ? ` +${participantNames.length - 3}` : ''}`
                : `Channel ${channel.channelId}`
            return (
              <Card
                key={channel.channelId}
                className="flex min-h-0 flex-col border-token bg-surface/90 shadow-sm"
              >
                <div className="flex items-center justify-between border-b border-token/60 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">{humanLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-muted-foreground">
                      {channel.messages.length} message{channel.messages.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>

                <div
                  className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
                  ref={(el) => {
                    if (el) {
                      messageContainerRefs.current.set(channel.channelId, el)
                    }
                  }}
                >
                  {channel.messages.map((msg) => {
                    const baseUserName = userMap.get(msg.userId) || 'Pivotal'
                    const isBot = msg.userId === topicData.topic.botUserId || !userMap.has(msg.userId)
                    const isViewer = viewerSlackId ? msg.userId === viewerSlackId : false
                    const userName = isBot
                      ? (
                          <span className="inline-flex items-center gap-1 text-[color:var(--p-stem)]">
                            <LogoMarkInline size={14} />
                            Pivotal
                          </span>
                        )
                      : baseUserName
                    const isLatestOverall = timelinePosition !== null &&
                      sortedMessages[timelinePosition]?.id === msg.id

                    return (
                      <div key={msg.id} className="space-y-2">
                        <div
                          className={`flex ${isViewer ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[75%] rounded-2xl px-4 py-2 cursor-pointer transition-opacity hover:opacity-95 ${
                              isViewer
                                ? 'bg-accent text-accent-foreground'
                                : 'bg-card text-foreground shadow-sm'
                            } ${
                              isLatestOverall ? 'ring-2 ring-accent/60 ring-offset-2 ring-offset-background' : ''
                            }`}
                            onClick={() => {
                              if (sendingChannels.size === 0) {
                                const messageIndex = sortedMessages.findIndex((m) => m.id === msg.id)
                                if (messageIndex !== -1) {
                                  setTimelinePosition(messageIndex)
                                }
                              }
                            }}
                          >
                            <div
                              className={`mb-1 text-xs ${
                                isBot ? 'text-accent-foreground/80' : 'text-muted-foreground'
                              }`}
                            >
                              {userName}
                            </div>
                            <div className="text-sm whitespace-pre-wrap break-words">
                              {formatSlackText(msg.text ?? '')}
                              {renderActionButtons(msg, channel.channelId)}
                            </div>
                            <div
                              className={`mt-1 text-xs ${
                                isBot ? 'text-accent-foreground/70' : 'text-muted-foreground'
                              }`}
                            >
                              {isLatestOverall ? (
                                <div className="break-words">
                                  {(() => {
                                    const timeOptions: Intl.DateTimeFormatOptions =
                                      isDM && user?.tz
                                        ? { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: user.tz }
                                        : { hour: 'numeric', minute: '2-digit', second: '2-digit' }
                                    const timeString = new Date(msg.timestamp).toLocaleTimeString('en-US', timeOptions)
                                    const timezoneString = isDM && user?.tz
                                      ? getShortTimezoneFromIANA(user.tz)
                                      : getShortTimezone()
                                    const idSuffix = isLocalMode ? ` (${msg.id})` : ''
                                    return `${timeString} (${timezoneString})${idSuffix}`
                                  })()}
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <span className="flex-shrink-0">
                                    {(() => {
                                      const timeOptions: Intl.DateTimeFormatOptions =
                                        isDM && user?.tz
                                          ? { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: user.tz }
                                          : { hour: 'numeric', minute: '2-digit', second: '2-digit' }
                                      const timeString = new Date(msg.timestamp).toLocaleTimeString('en-US', timeOptions)
                                      const timezoneString = isDM && user?.tz
                                        ? getShortTimezoneFromIANA(user.tz)
                                        : getShortTimezone()
                                      return `${timeString} (${timezoneString})`
                                    })()}
                                  </span>
                                  {isLocalMode && (
                                    <span className="truncate text-muted-foreground/70">{msg.id}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {isLocalMode && renderActionButtons(msg, channel.channelId)}
                      </div>
                    )
                  })}
                </div>

                {isLocalMode && isDM && isViewingLatest && (
                  <div className="border-t border-token/60 px-3 py-3">
                    <div className="flex items-center gap-2">
                      <input
                        value={chatInputs.get(channel.channelId) || ''}
                        onChange={(event) => {
                          setChatInputs((prev) => {
                            const next = new Map(prev)
                            next.set(channel.channelId, event.target.value)
                            return next
                          })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleSendMessage(channel.channelId).catch(console.error)
                          }
                        }}
                        placeholder="Type a message..."
                        disabled={sendingChannels.has(channel.channelId)}
                        className="flex-1 rounded-lg border border-token bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-muted disabled:text-muted-foreground"
                      />
                      <Button
                        onClick={() => {
                          handleSendMessage(channel.channelId).catch(console.error)
                        }}
                        disabled={sendingChannels.has(channel.channelId) || !(chatInputs.get(channel.channelId) || '').trim()}
                        className="shrink-0"
                      >
                        {sendingChannels.has(channel.channelId) ? 'Sending…' : 'Send'}
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )
            })}
          </div>
          {showCalendarPanel && profile && (
            <Card
              key="calendar-overview"
              className="flex min-h-0 flex-col border-[color:var(--p-leaf)] bg-surface/95 shadow-[0_12px_36px_-30px_rgba(13,38,24,0.35)] md:col-span-2 lg:col-span-1 lg:col-start-3 lg:row-span-full lg:self-stretch"
            >
              <div className="flex items-center justify-between border-b border-token/60 px-4 py-3 text-sm font-medium text-foreground">
                <span className="flex items-center gap-2"><CalendarIcon size={16} className="text-[color:var(--p-leaf)]" />Calendar overview</span>
                <Badge
                  role={calendarConnected ? undefined : 'button'}
                  tabIndex={calendarConnected ? undefined : 0}
                  onClick={calendarConnected ? undefined : redirectToCalendarAuth}
                  onKeyDown={calendarConnected
                    ? undefined
                    : (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          redirectToCalendarAuth()
                        }
                      }}
                  variant={calendarConnected ? undefined : 'outline'}
                  className={
                    calendarConnected
                      ? 'border-transparent bg-emerald-500/15 px-2.5 py-1 text-emerald-400 shadow-[0_0_0_1px_rgba(95,115,67,0.25)]'
                      : 'cursor-pointer border-[color:rgba(191,69,42,0.35)] px-2.5 py-1 text-[color:var(--p-ember)] transition-colors duration-200 hover:border-[color:rgba(191,69,42,0.5)] hover:bg-[color:rgba(191,69,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:rgba(191,69,42,0.45)] focus-visible:ring-offset-2 focus-visible:ring-offset-background'
                  }
                >
                  {calendarConnected ? 'Google Calendar connected' : 'Connect Google Calendar'}
                </Badge>
              </div>
              <div className="flex flex-1 flex-col gap-3 px-4 py-4 text-sm text-muted-foreground overflow-hidden">
                <div className="rounded-lg border border-token/60 bg-background/70 p-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground/70">User timezone</div>
                  <div className="mt-1 text-sm font-medium text-foreground">{getShortTimezone()}</div>
                </div>
                <div className="flex-1 overflow-hidden">
                  <div className="h-full overflow-y-auto rounded-lg border border-dashed border-token/60 bg-background/60 p-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground/70">Upcoming</div>
                    {upcomingEvents.length === 0 ? (
                      <div className="mt-2 text-xs">
                        {viewerCalendar
                          ? 'No upcoming calendar holds detected.'
                          : 'Calendar data will appear here once connected.'}
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {upcomingEvents.map((event) => {
                          const start = new Date(event.start)
                          const end = new Date(event.end)
                          const sameDay = start.toDateString() === end.toDateString()
                          const dayFormatter = new Intl.DateTimeFormat('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })
                          const timeFormatter = new Intl.DateTimeFormat('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                          const rangeLabel = sameDay
                            ? `${dayFormatter.format(start)} · ${timeFormatter.format(start)} – ${timeFormatter.format(end)}`
                            : `${dayFormatter.format(start)} ${timeFormatter.format(start)} → ${timeFormatter.format(end)} ${timeFormatter.format(end)}`

                          return (
                            <div key={`${event.start}-${event.end}-${event.summary}`} className="rounded border border-token/60 bg-surface/80 p-3">
                              <div className="flex items-center justify-between text-sm font-medium text-foreground">
                                <span>{event.summary || 'Scheduled hold'}</span>
                                {event.free && (
                                  <span className="text-xs font-semibold text-emerald-400">
                                    Open
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">{rangeLabel}</div>
                              {event.participantEmails && event.participantEmails.length > 0 && (
                                <div className="mt-2 text-xs text-muted-foreground/80">
                                  With {event.participantEmails.slice(0, 3).join(', ')}
                                  {event.participantEmails.length > 3 ? '…' : ''}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Timeline Component */}
      {sortedMessages.length > 0 && (
        <div className="mt-6 flex-shrink-0">
          <div className="rounded-xl border border-token bg-surface p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">Message timeline</div>
              <div className="text-xs text-muted-foreground">Use arrow keys or drag to navigate</div>
            </div>
            <div
              ref={timelineRef}
              className={`relative h-10 select-none rounded-full border border-token/60 bg-[radial-gradient(circle_at_center,var(--p-leaf)/18,transparent_75%)] px-5 ${
                sendingChannels.size > 0 ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
              }`}
              onClick={handleTimelineClick}
              onMouseDown={handleDragStart}
            >
              <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[color:rgba(95,115,67,0.32)]" />

              {sortedMessages.map((msg, index) => {
                const position = (index / (sortedMessages.length - 1)) * 100
                const isActive = timelinePosition !== null && index <= timelinePosition
                const isCurrent = index === timelinePosition
                const dotStyle = isCurrent
                  ? { backgroundColor: 'var(--p-leaf)', boxShadow: '0 0 0 4px rgba(95,115,67,0.28)' }
                  : isActive
                  ? { backgroundColor: 'rgba(95,115,67,0.75)' }
                  : { backgroundColor: 'rgba(95,115,67,0.35)' }

                return (
                  <div
                    key={msg.id}
                    className="absolute top-1/2 -translate-y-1/2"
                    style={{ left: `${position}%` }}
                  >
                    <div
                      className="h-2 w-2 -translate-x-1/2 rounded-full transition-all"
                      style={dotStyle}
                      title={`${new Date(msg.timestamp).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} - ${msg.text.substring(0, 50)}...`}
                    />
                  </div>
                )
              })}

              {timelinePosition !== null && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 transition-none"
                  style={{
                    left: `${(timelinePosition / (sortedMessages.length - 1)) * 100}%`,
                  }}
                >
                  <div
                    className={`h-6 w-6 -translate-x-1/2 cursor-grab rounded-full border-2 border-background shadow-lg transition ${
                      isDragging ? 'scale-110 cursor-grabbing' : ''
                    } ${thumbPulse ? 'animate-timeline-pulse' : ''}`}
                    style={{ backgroundColor: 'var(--p-leaf)', boxShadow: '0 0 18px rgba(95,115,67,0.4)' }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* JSON Response Popup */}
      {showPopup && (
        <div
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setShowPopup(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-4xl cursor-auto flex-col overflow-hidden rounded-xl border border-token bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-token/60 px-4 py-3">
              <h2 className="text-lg font-semibold text-foreground">LLM response</h2>
              <button
                onClick={() => setShowPopup(false)}
                className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-background px-4 py-3">
              <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap">
                {llmResponse}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Topic
