import { Server, Socket } from 'socket.io'
import { eq } from 'drizzle-orm'
import db from './db/engine.ts'
import { chatTable } from './db/schema/main.ts'
import { ChatMessage } from './shared/api-types.ts'

interface SocketUser {
  userId: string
  name: string
  email: string
}

interface JoinChatData {
  chatId: string
  userId: string
  userName: string
  userEmail: string
}

interface SendMessageData {
  chatId: string
  text: string
  messageType: 'group' | 'assistant'
}

export function setupSocketServer(io: Server, port: number) {
  console.log(`Socket server setup on port ${port}`)

  // Track which users are in which chat rooms
  const chatRooms = new Map<string, Set<string>>() // chatId -> Set of userIds
  const socketUsers = new Map<string, SocketUser>() // socketId -> user info

  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', socket.id)
    let currentChatId: string | null = null
    let currentUser: SocketUser | null = null

    socket.on('chat:join', async ({ chatId, userId, userName, userEmail }: JoinChatData) => {
      try {
        // No authentication - just use the provided user info
        currentUser = {
          userId,
          name: userName,
          email: userEmail,
        }
        socketUsers.set(socket.id, currentUser)

        // Verify user has access to this chat
        const chatRecord = await db.select()
          .from(chatTable)
          .where(eq(chatTable.id, chatId))
          .limit(1)

        if (chatRecord.length === 0) {
          socket.emit('error', { message: 'Chat not found' })
          return
        }

        const groupChat = chatRecord[0].groupChat
        // Skip access check for prototyping - anyone can join any chat

        // Join the socket room
        await socket.join(chatId)
        currentChatId = chatId

        // Track user in chat room
        if (!chatRooms.has(chatId)) {
          chatRooms.set(chatId, new Set())
        }
        chatRooms.get(chatId)!.add(userId)

        // Send current chat state to the user
        socket.emit('chat:joined', {
          chatId,
          groupChat,
          onlineUsers: Array.from(chatRooms.get(chatId) || []),
        })

        // Notify others in the room
        socket.to(chatId).emit('user:joined', {
          userId: userId,
          name: userName,
        })

        console.log(`User ${userName} (${userId}) joined chat ${chatId}`)
      } catch (error) {
        console.error('Error joining chat:', error)
        socket.emit('error', { message: 'Failed to join chat' })
      }
    })

    socket.on('message:send', async ({ chatId, text, messageType }: SendMessageData) => {
      if (!currentUser || currentChatId !== chatId) {
        socket.emit('error', { message: 'Not in this chat' })
        return
      }

      const message: ChatMessage = {
        userId: currentUser.userId,
        text,
        createdAt: new Date().toISOString(),
      }

      try {
        // Get the current chat
        const chatRecord = await db.select()
          .from(chatTable)
          .where(eq(chatTable.id, chatId))
          .limit(1)

        if (chatRecord.length === 0) {
          socket.emit('error', { message: 'Chat not found' })
          return
        }

        const groupChat = chatRecord[0].groupChat

        // Update the appropriate chat history
        if (messageType === 'group') {
          groupChat.groupChatHistory.push(message)

          // Save to database for group messages
          await db.update(chatTable)
            .set({ groupChat })
            .where(eq(chatTable.id, chatId))
        }
        // Skip saving assistant messages - they're handled by the API endpoint

        // Emit to appropriate recipients
        if (messageType === 'group') {
          // Broadcast to all users in the chat
          io.to(chatId).emit('message:received', {
            message,
            messageType: 'group',
            userName: currentUser.name,
          })
        } else {
          // Only send back to the sender for assistant messages
          socket.emit('message:received', {
            message,
            messageType: 'assistant',
          })
        }

        console.log(`Message sent in chat ${chatId} by ${currentUser.name} (type: ${messageType})`)
      } catch (error) {
        console.error('Error sending message:', error)
        socket.emit('error', { message: 'Failed to send message' })
      }
    })

    socket.on('message:typing', ({ chatId, isTyping }: { chatId: string, isTyping: boolean }) => {
      if (!currentUser || currentChatId !== chatId) return

      socket.to(chatId).emit('user:typing', {
        userId: currentUser.userId,
        name: currentUser.name,
        isTyping,
      })
    })

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id)

      if (currentUser && currentChatId) {
        // Remove user from chat room
        const roomUsers = chatRooms.get(currentChatId)
        if (roomUsers) {
          roomUsers.delete(currentUser.userId)
          if (roomUsers.size === 0) {
            chatRooms.delete(currentChatId)
          }
        }

        // Notify others in the room
        socket.to(currentChatId).emit('user:left', {
          userId: currentUser.userId,
          name: currentUser.name,
        })
      }

      socketUsers.delete(socket.id)
    })
  })

  // Periodic cleanup of empty rooms
  setInterval(() => {
    for (const [chatId, users] of chatRooms.entries()) {
      if (users.size === 0) {
        chatRooms.delete(chatId)
      }
    }
  }, 60000) // Every minute

  console.log('Socket server is ready')
}
