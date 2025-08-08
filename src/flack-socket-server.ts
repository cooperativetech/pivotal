import { Server, Socket } from 'socket.io'
import type { SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import { handleSlackMessage, getSlackUsers } from './slack-message-handler'

interface QueuedMessage {
  channel: string
  text?: string
  thread_ts?: string
  timestamp: string
  user: string // The user who sent the message (bot)
}

// Fake user data for testing
const FAKE_USERS = new Map<string, string>([
  ['U123456', 'Alice Johnson'],
  ['U234567', 'Bob Smith'],
  ['U345678', 'Charlie Brown'],
  ['U456789', 'Diana Prince'],
  ['U567890', 'Eve Wilson'],
  ['U678901', 'Frank Miller'],
  ['U789012', 'Grace Lee'],
  ['U890123', 'Henry Davis'],
])

// Fake conversation members for testing
const FAKE_CHANNEL_MEMBERS = new Map<string, string[]>([
  ['C123456', ['U123456', 'U234567', 'U345678']], // General channel
  ['C234567', ['U456789', 'U567890', 'U678901']], // Random channel
  ['D123456', ['U123456']], // DM with Alice
  ['D234567', ['U234567']], // DM with Bob
])

export function setupSocketServer(io: Server) {
  // Track which users are currently being impersonated by connected clients
  const impersonatedUsers = new Map<string, string>() // socketId -> userId
  const userToSocket = new Map<string, string>() // userId -> socketId (reverse mapping)
  const messageQueues = new Map<string, QueuedMessage[]>() // userId -> queued messages
  const botUserId = 'UTESTBOT'

  io.on('connection', async (socket: Socket) => {

    // Create a mock Slack client that doesn't make real API calls
    const mockClient: AllMiddlewareArgs['client'] = {
      users: {
        list: () => {
          // Return fake users
          const members = Array.from(FAKE_USERS.entries()).map(([id, name]) => ({
            id,
            team_id: 'T123456',
            real_name: name,
            name: name.toLowerCase().replace(' ', '.'),
            deleted: false,
            is_bot: false,
            updated: Math.floor(Date.now() / 1000),
            tz: 'America/New_York',
          }))

          // Add the bot user
          members.push({
            id: botUserId,
            team_id: 'T123456',
            real_name: 'Pivotal Bot',
            name: 'pivotal-bot',
            deleted: false,
            is_bot: true,
            updated: Math.floor(Date.now() / 1000),
            tz: 'America/New_York',
          })

          return {
            ok: true,
            members,
            response_metadata: {},
          }
        },
      },
      conversations: {
        open: ({ users }: { users: string }) => {
          // Return a fake DM channel
          const userList = users.split(',')
          const channelId = userList.length === 1 ? `D${userList[0].substring(1)}` : `G${Date.now()}`

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
        info: ({ channel }: { channel: string }) => {
          // Return fake channel info
          if (channel.startsWith('D')) {
            // Direct message - extract user ID from channel ID
            const userId = `U${channel.substring(1)}`
            return {
              ok: true,
              channel: {
                id: channel,
                user: userId,
                is_im: true,
                created: Math.floor(Date.now() / 1000),
              },
            }
          } else {
            // Regular channel
            return {
              ok: true,
              channel: {
                id: channel,
                name: 'general',
                is_channel: true,
                created: Math.floor(Date.now() / 1000),
              },
            }
          }
        },
        members: ({ channel }: { channel: string }) => {
          // Return fake channel members
          const members = FAKE_CHANNEL_MEMBERS.get(channel) || ['U123456', 'U234567']
          return {
            ok: true,
            members,
            response_metadata: {},
          }
        },
      },
      chat: {
        postMessage: async (params: { channel: string; text?: string; thread_ts?: string }) => {
          const timestamp = (Date.now() / 1000).toString()

          // Prepare the message
          const message: QueuedMessage = {
            channel: params.channel,
            text: params.text,
            thread_ts: params.thread_ts,
            timestamp,
            user: botUserId,
          }

          // Get list of users in the channel
          try {
            let userIds: string[] = []

            if (params.channel.startsWith('D')) {
              // Direct message - extract user ID from channel ID
              const userId = `U${params.channel.substring(1)}`
              userIds = [userId]
            } else {
              // Regular channel - get members
              const members = FAKE_CHANNEL_MEMBERS.get(params.channel) || ['U123456', 'U234567']
              userIds = members
            }

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
            message: { text: params.text, user: botUserId, ts: timestamp },
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

        // Construct the Slack message object
        const ts = (Date.now() / 1000).toString()
        const message: SlackEventMiddlewareArgs<'message'>['message'] = {
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
