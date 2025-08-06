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

export function setupSocketServer(io: Server, botUserId: string, slackClient: AllMiddlewareArgs['client']) {
  // Track which users are currently being impersonated by connected clients
  const impersonatedUsers = new Map<string, string>() // socketId -> userId
  const userToSocket = new Map<string, string>() // userId -> socketId (reverse mapping)
  const messageQueues = new Map<string, QueuedMessage[]>() // userId -> queued messages
  io.on('connection', async (socket: Socket) => {
    console.log('Flack client connected:', socket.id)

    // Send users list to the client on connection
    try {
      const users = await getSlackUsers(slackClient)
      // Get list of currently impersonated user IDs
      const impersonatedUserIds = new Set(impersonatedUsers.values())

      // Filter and map users
      const availableUsers = Array.from(users.entries())
        .filter(([id]) => id !== botUserId && !impersonatedUserIds.has(id))
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

    // Create mock client with proper response handling
    const mockClient: AllMiddlewareArgs['client'] = {
      chat: {
        postMessage: async (params: { thread_ts?: string; channel: string; text?: string }) => {
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
              // Direct message - get conversation info to find the users
              const convoInfo = await slackClient.conversations.info({
                channel: params.channel,
              })
              if (convoInfo.ok && convoInfo.channel && 'user' in convoInfo.channel) {
                // In a DM, the 'user' field contains the other user's ID
                userIds = [convoInfo.channel.user as string]
              }
            } else {
              // Regular channel - get members
              const membersResult = await slackClient.conversations.members({
                channel: params.channel,
              })
              if (membersResult.ok && membersResult.members) {
                userIds = membersResult.members
              }
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
            // Fallback: send to the originating client
            socket.emit('bot-response', message)
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
          // Send reaction event back to the client
          socket.emit('bot-reaction', {
            name: params.name,
            channel: params.channel,
            timestamp: params.timestamp,
          })
          return Promise.resolve({ ok: true })
        },
      },
      conversations: {
        open: slackClient.conversations.open,
      },
      users: {
        list: slackClient.users.list,
      },
    } as unknown as AllMiddlewareArgs['client']

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
        const dmResult = await slackClient.conversations.open({ users: userId })
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
