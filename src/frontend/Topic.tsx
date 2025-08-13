import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useSearchParams } from 'react-router'

interface SlackMessage {
  id: string
  topicId: string
  userId: string
  channelId: string
  text: string
  timestamp: string
  rawTs: string
  threadTs: string | null
  raw: unknown
}

interface SlackUser {
  id: string
  teamId: string
  realName: string | null
  tz: string | null
  isBot: boolean
  deleted: boolean
  updated: string
  raw: unknown
}

interface Topic {
  id: string
  userIds: string[]
  summary: string
  workflowType: 'scheduling' | 'other'
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface TopicData {
  topic: Topic
  messages: SlackMessage[]
  users: SlackUser[]
}

interface ChannelGroup {
  channelId: string
  messages: SlackMessage[]
}

function Topic() {
  const { topicId } = useParams<{ topicId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [topicData, setTopicData] = useState<TopicData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timelinePosition, setTimelinePosition] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef<number>(0)
  const dragStartPosition = useRef<number>(0)
  const messageContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const initialLoadRef = useRef(true)

  useEffect(() => {
    const fetchTopicData = async () => {
      if (!topicId) return

      try {
        const response = await fetch(`/api/topics/${topicId}`)
        if (!response.ok) {
          throw new Error('Failed to fetch topic data')
        }
        const data = await response.json() as TopicData
        setTopicData(data)

        // Only read query params on initial load
        if (initialLoadRef.current) {
          initialLoadRef.current = false
          // Check for messageId in query params
          const messageIdParam = searchParams.get('messageId')
          if (messageIdParam && data.messages.length > 0) {
            // Sort messages to find the position of the specified message
            const sorted = [...data.messages].sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
            const position = sorted.findIndex((m) => m.id === messageIdParam)
            if (position !== -1) {
              setTimelinePosition(position)
            } else {
              // Default to showing all messages if messageId not found
              setTimelinePosition(data.messages.length - 1)
            }
          } else if (data.messages.length > 0) {
            // Default: Initialize timeline to show all messages
            setTimelinePosition(data.messages.length - 1)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    void fetchTopicData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]) // Intentionally exclude searchParams to prevent re-fetching on URL changes

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
  }, [timelinePosition, topicData])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!topicData || sortedMessages.length === 0) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setTimelinePosition((prev) => {
          if (prev === null) return sortedMessages.length - 1
          return Math.max(0, prev - 1)
        })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setTimelinePosition((prev) => {
          if (prev === null) return sortedMessages.length - 1
          return Math.min(sortedMessages.length - 1, prev + 1)
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [topicData, sortedMessages.length])

  // Handle timeline click
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const width = rect.width
    const position = Math.round((x / width) * (sortedMessages.length - 1))
    setTimelinePosition(Math.max(0, Math.min(sortedMessages.length - 1, position)))
  }, [sortedMessages.length])

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0) return

    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartPosition.current = timelinePosition ?? sortedMessages.length - 1

    e.preventDefault()
  }, [sortedMessages.length, timelinePosition])

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
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, sortedMessages.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading topic...</div>
      </div>
    )
  }

  if (error || !topicData) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error || 'Topic not found'}</div>
      </div>
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

    channelMap.get(msg.channelId)!.messages.push(msg)
  })

  // Sort messages within each channel by timestamp
  channelGroups.forEach((group) => {
    group.messages.sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
  })

  // Create user map for display names
  const userMap = new Map<string, string>()
  topicData.users.forEach((user) => {
    userMap.set(user.id, user.realName || user.id)
  })

  return (
    <div className="h-screen bg-gray-50 p-4 flex flex-col">
      <div className="flex-shrink-0">
        <Link to="/" className="inline-block mb-4 text-blue-600 hover:underline">
          ← Back to Topics
        </Link>

        <h1 className="text-3xl font-bold mb-2">{topicData.topic.summary}</h1>
        <div className="flex items-center gap-2 mb-6">
          <span
            className={`inline-block px-2 py-1 text-xs font-medium rounded ${
              topicData.topic.workflowType === 'scheduling'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {topicData.topic.workflowType}
          </span>
          <span
            className={`inline-block px-2 py-1 text-xs font-medium rounded ${
              topicData.topic.isActive
                ? 'bg-green-100 text-green-800'
                : 'bg-red-100 text-red-800'
            }`}
          >
            {topicData.topic.isActive ? 'Active' : 'Inactive'}
          </span>
          <span className="text-sm text-gray-600">
            Updated: {new Date(topicData.topic.updatedAt).toLocaleString()}
          </span>
          {sortedMessages.length > 0 && timelinePosition !== null && (
            <span className="text-sm text-gray-600">
              Showing {timelinePosition + 1} of {sortedMessages.length} messages
            </span>
          )}
        </div>
      </div>

      {channelGroups.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-500">No conversations found for this topic</div>
        </div>
        ) : (
        <div className="flex-1 grid gap-6 md:grid-cols-2 lg:grid-cols-3 overflow-hidden">
            {channelGroups.map((channel) => (
              <div
                key={channel.channelId}
              className="bg-white rounded-lg shadow-md p-4 overflow-y-auto flex flex-col"
              >
              <div className="flex-shrink-0 mb-3 pb-2 border-b border-gray-200">
                  <div className="text-sm font-medium text-gray-700">
                    Channel: #{channel.channelId}
                  </div>
                  <div className="text-xs text-gray-500">
                    {channel.messages.length} message{channel.messages.length !== 1 ? 's' : ''}
                </div>
            </div>

              <div
                className="flex-1 space-y-3 overflow-y-auto p-2"
                ref={(el) => {
                  if (el) {
                    messageContainerRefs.current.set(channel.channelId, el)
                  }
                }}
              >
                  {channel.messages.map((msg) => {
                    const userName = userMap.get(msg.userId) || 'Pivotal Bot'
                    const isBot = !userMap.has(msg.userId)
                    // Check if this is the latest message overall based on timeline position
                    const isLatestOverall = timelinePosition !== null &&
                      sortedMessages[timelinePosition]?.id === msg.id

                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isBot ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[75%] rounded-2xl px-4 py-2 cursor-pointer hover:opacity-90 transition-opacity ${
                            isBot
                              ? 'bg-blue-500 text-white'
                              : 'bg-gray-200 text-gray-900'
                          } ${
                            isLatestOverall ? 'ring-2 ring-offset-2 ring-amber-500' : ''
                          }`}
                          onClick={() => {
                            const messageIndex = sortedMessages.findIndex((m) => m.id === msg.id)
                            if (messageIndex !== -1) {
                              setTimelinePosition(messageIndex)
                            }
                          }}
                        >
                          <div
                            className={`text-xs mb-1 ${
                              isBot ? 'text-blue-100' : 'text-gray-600'
                            }`}
                          >
                            {userName}
                          </div>
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {msg.text}
                          </div>
                          <div
                            className={`text-xs mt-1 ${
                              isBot ? 'text-blue-100' : 'text-gray-500'
                            }`}
                          >
                            {new Date(msg.timestamp).toLocaleTimeString()} ({msg.id})
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
      )}

      {/* Timeline Component */}
      {sortedMessages.length > 0 && (
        <div className="flex-shrink-0 mt-4 pb-4">
          <div className="bg-white rounded-lg shadow-md p-4">
            <div className="mb-2 text-sm font-medium text-gray-700">Message Timeline</div>
            <div
              ref={timelineRef}
              className="relative h-12 bg-gray-100 rounded-lg cursor-pointer select-none"
              onClick={handleTimelineClick}
              onMouseDown={handleDragStart}
            >
              {/* Timeline track */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-gray-300 rounded-full" />

              {/* Timeline ticks */}
              {sortedMessages.map((msg, index) => {
                const position = (index / (sortedMessages.length - 1)) * 100
                const isActive = timelinePosition !== null && index <= timelinePosition
                const isCurrent = index === timelinePosition

                return (
                  <div
                    key={msg.id}
                    className="absolute top-1/2 -translate-y-1/2"
                    style={{ left: `${position}%` }}
                  >
                    <div
                      className={`w-2 h-2 rounded-full -translate-x-1/2 transition-all ${
                        isCurrent
                          ? 'w-4 h-4 bg-blue-600 ring-2 ring-blue-300'
                          : isActive
                          ? 'bg-blue-500'
                          : 'bg-gray-400'
                      }`}
                      title={`${new Date(msg.timestamp).toLocaleTimeString()} - ${msg.text.substring(0, 50)}...`}
                    />
                  </div>
                )
              })}

              {/* Current position indicator/thumb */}
              {timelinePosition !== null && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 transition-none"
                  style={{
                    left: `${(timelinePosition / (sortedMessages.length - 1)) * 100}%`,
                  }}
                >
                  <div
                    className={`w-6 h-6 bg-blue-600 rounded-full -translate-x-1/2 shadow-lg ring-2 ring-white cursor-grab ${
                      isDragging ? 'cursor-grabbing scale-110' : ''
                    }`}
                  />
                </div>
              )}
            </div>

            {/* Navigation hint */}
            <div className="mt-2 text-xs text-gray-500 text-center">
              Use arrow keys (← →) or drag to navigate through time
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Topic
