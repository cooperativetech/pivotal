import { Server, Socket } from 'socket.io'
import type { SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import type { UsersListResponse } from '@slack/web-api'
import { handleSlackMessage, getSlackUsers } from './slack-message-handler'

type FlackMessage = SlackEventMiddlewareArgs<'message'>['message'] & {
  type: 'message'
  subtype: string | undefined
  channel: string
  text: string
  ts: string
  thread_ts?: string
  user: string
  channel_type: 'im' | 'channel' | 'group'
  event_ts: string
}

type FlackUser = NonNullable<UsersListResponse['members']>[number] & {
  id: string
  team_id: string
  real_name: string
  name: string
  deleted: boolean
  is_bot: boolean
  updated: number
  tz: string
}

function makeFlackUser(id: string, real_name: string): FlackUser {
  return {
    id,
    team_id: 'T123456',
    real_name,
    name: real_name.toLowerCase().replace(' ', '.'),
    deleted: false,
    is_bot: false,
    updated: Math.floor(Date.now() / 1000),
    tz: 'America/New_York',
  }
}

const FAKE_USERS = new Map<string, FlackUser>([
  ['U123456', makeFlackUser('U123456', 'Alice Johnson')],
  ['U234567', makeFlackUser('U234567', 'Bob Smith')],
  ['U345678', makeFlackUser('U345678', 'Charlie Brown')],
  ['U456789', makeFlackUser('U456789', 'Diana Prince')],
  ['U567890', makeFlackUser('U567890', 'Eve Wilson')],
  ['U678901', makeFlackUser('U678901', 'Frank Miller')],
  ['U789012', makeFlackUser('U789012', 'Grace Lee')],
  ['U890123', makeFlackUser('U890123', 'Henry Davis')],
])

// Channel management functions
const channelToUsers = new Map<string, string[]>()

function getChannelForUsers(userIds: string[]): string {
  // Single user = DM channel
  if (userIds.length === 1) {
    return `D${userIds[0].substring(1)}`
  }

  // Multiple users = group channel
  // Check if we already have a channel for these users
  const sortedUsers = [...userIds].sort().join(',')
  for (const [channelId, users] of channelToUsers.entries()) {
    if ([...users].sort().join(',') === sortedUsers) {
      return channelId
    }
  }

  // Create new group channel
  const newChannelId = `G${Date.now()}`
  channelToUsers.set(newChannelId, userIds)
  return newChannelId
}

function getUsersForChannel(channelId: string): string[] {
  // DM channel - extract user from channel ID
  if (channelId.startsWith('D')) {
    return [`U${channelId.substring(1)}`]
  }

  // Group/regular channel - look up stored users
  return channelToUsers.get(channelId) || []
}

export function setupSocketServer(io: Server) {
  // Track which users are currently being impersonated by connected clients
  const impersonatedUsers = new Map<string, string>() // socketId -> userId
  const userToSocket = new Map<string, string>() // userId -> socketId (reverse mapping)
  const messageQueues = new Map<string, FlackMessage[]>() // userId -> queued messages
  const botUserId = 'UTESTBOT'

  io.on('connection', async (socket: Socket) => {

    // Create a mock Slack client that doesn't make real API calls
    const mockClient: AllMiddlewareArgs['client'] = {
      users: {
        list: () => {
          // Return fake users
          const members = Array.from(FAKE_USERS.values())

          // Add the bot user
          const botUser: FlackUser = {
            id: botUserId,
            team_id: 'T123456',
            real_name: 'Pivotal Bot',
            name: 'pivotal-bot',
            deleted: false,
            is_bot: true,
            updated: Math.floor(Date.now() / 1000),
            tz: 'America/New_York',
          }
          members.push(botUser)

          return {
            ok: true,
            members,
            response_metadata: {},
          }
        },
      },
      conversations: {
        open: ({ users }: { users: string }) => {
          // Get or create channel for the specified users
          const userList = users.split(',')
          const channelId = getChannelForUsers(userList)

          return {
            ok: true,
            channel: {
              id: channelId,
              created: Math.floor(Date.now() / 1000),
              is_im: userList.length === 1,
              is_mpim: userList.length > 1,
            },
          }
        },
      },
      chat: {
        postMessage: async (params: { channel: string; text: string; thread_ts?: string }) => {
          const timestamp = (Date.now() / 1000).toString()

          // Prepare the message as FlackMessage
          const message: FlackMessage = {
            type: 'message',
            subtype: undefined,
            channel: params.channel,
            text: params.text,
            ts: timestamp,
            thread_ts: params.thread_ts,
            user: botUserId,
            channel_type: params.channel.startsWith('D') ? 'im' : 'channel',
            event_ts: timestamp,
          }

          // Get list of users in the channel
          try {
            const userIds = getUsersForChannel(params.channel)

            // Send to active users or queue for inactive ones
            for (const userId of userIds) {
              if (userId === botUserId) continue // Skip the bot itself

              const socketId = userToSocket.get(userId)
              if (socketId) {
                // User has an active socket, send the message
                const userSocket = io.sockets.sockets.get(socketId)
                if (userSocket) {
                  userSocket.emit('bot-response', message)
                }
              } else {
                // User doesn't have an active socket, queue the message
                if (!messageQueues.has(userId)) {
                  messageQueues.set(userId, [])
                }
                const queue = messageQueues.get(userId)
                if (queue) {
                  queue.push(message)
                }
                console.log(`Queued message for offline user ${userId}`)
              }
            }
          } catch (error) {
            console.error('Error getting channel members:', error)
          }

          return Promise.resolve({
            ok: true,
            ts: timestamp,
            message: message,
          })
        },
      },
      reactions: {
        add: (params: { name: string; channel: string; timestamp: string }) => {
          // Send reaction event back to the specific client
          socket.emit('bot-reaction', {
            name: params.name,
            channel: params.channel,
            timestamp: params.timestamp,
          })
          return Promise.resolve({ ok: true })
        },
      },
    } as unknown as AllMiddlewareArgs['client']

    console.log('Flack client connected:', socket.id)

    // Send users list to the client on connection
    try {
      // Get list of non-bot users
      const users = await getSlackUsers(mockClient, false)
      // Get list of currently impersonated user IDs
      const impersonatedUserIds = new Set(impersonatedUsers.values())

      // Filter and map users
      const availableUsers = Array.from(users.entries())
        .filter(([id]) => !impersonatedUserIds.has(id))
        .map(([id, name]) => ({ id, name }))

      // Sort users: those with queued messages first
      const usersWithMessages: Array<{ id: string; name: string }> = []
      const usersWithoutMessages: Array<{ id: string; name: string }> = []

      availableUsers.forEach(user => {
        if (messageQueues.has(user.id) && messageQueues.get(user.id)!.length > 0) {
          usersWithMessages.push(user)
        } else {
          usersWithoutMessages.push(user)
        }
      })

      // Combine lists with users having messages at the top
      const usersList = [...usersWithMessages, ...usersWithoutMessages]
      socket.emit('users-list', usersList)
    } catch (error) {
      console.error('Error fetching users:', error)
      socket.emit('error', { message: 'Failed to fetch users list' })
    }

    // Handle user selection
    socket.on('user-selected', (userId: string) => {
      impersonatedUsers.set(socket.id, userId)
      userToSocket.set(userId, socket.id)
      console.log(`Client ${socket.id} is impersonating user ${userId}`)

      // Send any queued messages for this user
      const queuedMessages = messageQueues.get(userId)
      if (queuedMessages && queuedMessages.length > 0) {
        console.log(`Sending ${queuedMessages.length} queued messages to user ${userId}`)
        queuedMessages.forEach(msg => {
          socket.emit('bot-response', msg)
        })
        // Clear the queue after sending
        messageQueues.delete(userId)
      }
    })

    // Handle incoming Flack messages (always DMs to the bot)
    socket.on('flack-message', async (data: { text: string }) => {
      try {
        const { text } = data

        // Get the user ID who sent this message
        const userId = impersonatedUsers.get(socket.id)
        if (!userId) {
          console.error('No user selected for socket:', socket.id)
          socket.emit('error', { message: 'Please select a user first' })
          return
        }

        // Open DM channel with the user
        const dmResult = await mockClient.conversations.open({ users: userId })
        if (!dmResult.ok || !dmResult.channel) {
          console.error('Failed to open DM channel:', dmResult.error)
          socket.emit('error', { message: 'Failed to open DM channel' })
          return
        }

        // Construct the FlackMessage
        const ts = (Date.now() / 1000).toString()
        const message: FlackMessage = {
          type: 'message',
          subtype: undefined,
          text: text,
          ts: ts,
          user: userId,
          channel: dmResult.channel.id!,
          channel_type: 'im',
          event_ts: ts,
        }

        // Call the shared message handler
        await handleSlackMessage(message, botUserId, mockClient)
      } catch (error) {
        console.error('Error processing message:', error)
        socket.emit('error', { message: 'Error processing message' })
      }
    })

    socket.on('disconnect', () => {
      // Remove user from impersonated users mapping
      const userId = impersonatedUsers.get(socket.id)
      if (userId) {
        impersonatedUsers.delete(socket.id)
        userToSocket.delete(userId)
        console.log(`Client ${socket.id} stopped impersonating user ${userId}`)
      }
      console.log('Flack client disconnected:', socket.id)
    })
  })
}
