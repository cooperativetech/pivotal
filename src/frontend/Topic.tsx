import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useSearchParams } from 'react-router'
import { api } from '@shared/api-client'
import { unserializeTopicData, TopicData, SlackMessage } from '@shared/api-types'
import { getShortTimezoneFromIANA, getShortTimezone } from '@shared/utils'
import { UserContextView } from './UserContextView'

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
  const [testingMessageId, setTestingMessageId] = useState<string | null>(null)
  const [llmResponse, setLlmResponse] = useState<string | null>(null)
  const [showPopup, setShowPopup] = useState(false)
  const [chatInputs, setChatInputs] = useState<Map<string, string>>(new Map())
  const [sendingChannels, setSendingChannels] = useState<Set<string>>(new Set())
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set())
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef<number>(0)
  const dragStartPosition = useRef<number>(0)
  const messageContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const initialLoadRef = useRef(true)

  useEffect(() => {
    const fetchTopicData = async () => {
      if (!topicId) return

      try {
        const response = await api.topics[':topicId'].$get({
          param: { topicId },
          query: {},
        })
        if (!response.ok) {
          throw new Error('Failed to fetch topic data')
        }
        const data = await response.json()
        setTopicData(unserializeTopicData(data))

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
      if (!topicData || sortedMessages.length === 0 || sendingChannels.size > 0) return

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
  }, [topicData, sortedMessages.length, sendingChannels.size])

  // Handle timeline click
  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0 || sendingChannels.size > 0) return

    const rect = timelineRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const width = rect.width
    const position = Math.round((x / width) * (sortedMessages.length - 1))
    setTimelinePosition(Math.max(0, Math.min(sortedMessages.length - 1, position)))
  }, [sortedMessages.length, sendingChannels.size])

  // Handle test LLM response
  const handleTestLlmResponse = useCallback(async (messageId: string) => {
    if (!topicId) return

    setTestingMessageId(messageId)
    try {
      const response = await api.test_llm_response.$post({
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
  }, [topicId])

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || sortedMessages.length === 0 || sendingChannels.size > 0) return

    setIsDragging(true)
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

  // Check if we're viewing the latest message
  const isViewingLatest = timelinePosition === sortedMessages.length - 1

  // Helper to check if a channel is a DM (2 users)
  const isDMChannel = (channelId: string) => {
    const channel = topicData.channels?.find((ch) => ch.id === channelId)
    return channel?.userIds.length === 2
  }

  // Helper to get the current user ID for a channel
  const getCurrentUserId = (channelId: string) => {
    const channel = topicData.channels?.find((ch) => ch.id === channelId)
    return channel?.userIds.find((uid) => userMap.has(uid))
  }

  // Helper to get DM user info (for channel title)
  const getDMUserInfo = (channelId: string) => {
    const channel = topicData.channels?.find((ch) => ch.id === channelId)
    if (!channel || channel.userIds.length !== 2) return null

    // Find the non-bot user ID (the one in userMap)
    const userId = channel.userIds.find((uid) => userMap.has(uid))
    if (!userId) return null

    // Get the user details
    const user = topicData.users.find((u) => u.id === userId)
    if (!user) return null

    return {
      realName: user.realName || user.id,
      timezone: user.tz ? getShortTimezoneFromIANA(user.tz) : '',
    }
  }

  // Handle toggling user context expansion
  const toggleContextExpansion = (channelId: string) => {
    setExpandedContexts((prev) => {
      const next = new Set(prev)
      if (next.has(channelId)) {
        next.delete(channelId)
      } else {
        next.add(channelId)
      }
      return next
    })
  }

  // Handle sending a message
  const handleSendMessage = async (channelId: string) => {
    const chatInput = chatInputs.get(channelId) || ''
    const currentUserId = getCurrentUserId(channelId)
    if (!chatInput.trim() || !currentUserId || !topicId || sendingChannels.has(channelId)) return

    setSendingChannels((prev) => new Set(prev).add(channelId))
    try {
      const response = await api.message.$post({
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
        const existingChannelIds = new Set(topicData.channels?.map((ch) => ch.id) || [])
        const newChannelIds = newMessages
          .map((msg) => msg.channelId)
          .filter((channelId) => !existingChannelIds.has(channelId))

        // Fetch channel info for any new channels
        const newChannels = await Promise.all(
          [...new Set(newChannelIds)].map(async (channelId) => {
            try {
              const response = await api.channels[':channelId'].$get({
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
        const validChannels = newChannels.filter((ch) => ch !== null)

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
    <div className="h-screen bg-gray-50 p-4 flex flex-col">
      <div className="flex-shrink-0">
        <div className="flex items-center gap-3 mb-1">
          <Link to="/" className="text-blue-600 hover:underline text-sm">
            ← Back to Topics
          </Link>
          <h1 className="text-xl font-bold">{topicData.topic.summary}</h1>
        </div>
        <div className="flex items-center gap-2 mb-2">
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
            Updated: {new Date(topicData.topic.updatedAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}
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
        <div className="flex-1 grid gap-2 md:grid-cols-2 lg:grid-cols-3 overflow-hidden pb-2">
            {channelGroups.map((channel) => {
              const isExpanded = expandedContexts.has(channel.channelId)
              const isDM = isDMChannel(channel.channelId)
              const userId = isDM ? getCurrentUserId(channel.channelId) : null
              const user = userId ? topicData.users.find((u) => u.id === userId) : null
              const userData = userId ? topicData.userData?.find((ud) => ud.slackUserId === userId) : null
              const topicUserContext = userId ? topicData.topic.perUserContext[userId] : null

              return (
                <div
                  key={channel.channelId}
                  className="bg-white rounded-lg shadow-md p-2 overflow-y-auto flex flex-col"
                >
                  <div
                    className={`flex-shrink-0 mb-2 pb-1 border-b border-gray-200 flex items-center justify-between -m-2 p-2 mb-0 rounded-t-lg ${
                      isDM ? 'cursor-pointer hover:bg-gray-200 transition-colors' : ''
                    }`}
                    onClick={isDM ? () => toggleContextExpansion(channel.channelId) : undefined}
                  >
                    <div className="text-xs font-medium text-gray-700">
                      {isDM ? (
                        (() => {
                          const userInfo = getDMUserInfo(channel.channelId)
                          return userInfo ? (
                            <>
                              {userInfo.realName}
                              {userInfo.timezone && ` (${userInfo.timezone})`}
                              <span className="text-gray-400 ml-1">
                                (#{channel.channelId})
                              </span>
                            </>
                          ) : (
                            `#${channel.channelId}`
                          )
                        })()
                      ) : (
                        `#${channel.channelId}`
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-gray-500">
                        {channel.messages.length} message{channel.messages.length !== 1 ? 's' : ''}
                      </div>
                      {isDM && (
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      )}
                    </div>
                  </div>

                  {isExpanded && isDM && (
                    <div className="mb-2 -mx-2 px-2">
                      <UserContextView
                        context={userData?.context}
                        topicContext={topicUserContext}
                        userTimezone={user?.tz || null}
                      />
                    </div>
                  )}

              <div
                className="flex-1 space-y-3 overflow-y-auto px-1 py-1"
                ref={(el) => {
                  if (el) {
                    messageContainerRefs.current.set(channel.channelId, el)
                  }
                }}
              >
                  {channel.messages.map((msg) => {
                    const userName = userMap.get(msg.userId) || 'Pivotal'
                    const isBot = !userMap.has(msg.userId)
                    // Check if this is the latest message overall based on timeline position
                    const isLatestOverall = timelinePosition !== null &&
                      sortedMessages[timelinePosition]?.id === msg.id

                    return (
                      <div key={msg.id} className="space-y-2">
                        <div
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
                              if (sendingChannels.size === 0) {
                                const messageIndex = sortedMessages.findIndex((m) => m.id === msg.id)
                                if (messageIndex !== -1) {
                                  setTimelinePosition(messageIndex)
                                }
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
                                    return `${timeString} (${timezoneString}) (${msg.id})`
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
                                  <span className="truncate">
                                    ({msg.id})
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        {!isBot && isLatestOverall && (
                          <div className={`flex ${isBot ? 'justify-end' : 'justify-start'}`}>
                            <button
                              onClick={() => { void handleTestLlmResponse(msg.id) }}
                              disabled={testingMessageId === msg.id}
                              className="px-3 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 hover:cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                            >
                              {testingMessageId === msg.id ? 'Testing...' : 'Test LLM Response'}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Chat Bar for DM Channels */}
                {isDM && isViewingLatest && (
                  <div className="mt-2 -mx-2 -mb-2">
                    <div className="flex">
                      <input
                        type="text"
                        value={chatInputs.get(channel.channelId) || ''}
                        onChange={(e) => {
                          setChatInputs((prev) => {
                            const next = new Map(prev)
                            next.set(channel.channelId, e.target.value)
                            return next
                          })
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void handleSendMessage(channel.channelId)
                          }
                        }}
                        placeholder="Type a message..."
                        disabled={sendingChannels.has(channel.channelId)}
                        className="flex-1 px-3 py-1.5 text-sm border-t border-l border-b border-gray-200 rounded-bl-lg focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                      <button
                        onClick={() => { void handleSendMessage(channel.channelId) }}
                        disabled={sendingChannels.has(channel.channelId) || !(chatInputs.get(channel.channelId) || '').trim()}
                        className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-br-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                      >
                        {sendingChannels.has(channel.channelId) ? '...' : 'Send'}
                      </button>
                    </div>
                  </div>
                )}
                </div>
              )
            })}
          </div>
      )}

      {/* Timeline Component */}
      {sortedMessages.length > 0 && (
        <div className="flex-shrink-0">
          <div className="bg-white rounded-lg shadow-md p-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-medium text-gray-700">Message Timeline</div>
              <div className="text-xs text-gray-500">
                Use arrow keys (← →) or drag to navigate
              </div>
            </div>
            <div
              ref={timelineRef}
              className={`relative h-8 bg-gray-100 rounded-lg select-none ${
                sendingChannels.size > 0 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              }`}
              onClick={handleTimelineClick}
              onMouseDown={handleDragStart}
            >
              {/* Timeline track */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-gray-300 rounded-full" />

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
                      className={`w-1.5 h-1.5 rounded-full -translate-x-1/2 transition-all ${
                        isCurrent
                          ? 'w-3 h-3 bg-blue-600 ring-2 ring-blue-300'
                          : isActive
                          ? 'bg-blue-500'
                          : 'bg-gray-400'
                      }`}
                      title={`${new Date(msg.timestamp).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} - ${msg.text.substring(0, 50)}...`}
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
                    className={`w-5 h-5 bg-blue-600 rounded-full -translate-x-1/2 shadow-lg ring-2 ring-white cursor-grab ${
                      isDragging ? 'cursor-grabbing scale-110' : ''
                    }`}
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
          className="fixed inset-0 bg-gray-600/60 flex items-center justify-center z-50 p-4 cursor-pointer"
          onClick={() => setShowPopup(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-4xl max-h-[80vh] w-full overflow-hidden flex flex-col cursor-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">LLM Response</h2>
              <button
                onClick={() => setShowPopup(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs font-mono whitespace-pre-wrap">
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
