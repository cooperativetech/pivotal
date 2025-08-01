import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { parseArgs } from 'node:util'
import { createWriteStream } from 'node:fs'
import { Server } from 'socket.io'
import { join } from 'node:path'
import { ne, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

import { user } from './db/schema/auth.ts'
import { GroupChat, GetUsersResponse, CreateChatRequest, ChatMessage } from './shared/api-types.ts'
import { z } from 'zod'
import { takeAction } from './anthropic-api.ts'
import { auth } from './auth.ts'
import db from './db/engine.ts'
import { chatTable } from './db/schema/main.ts'
import { setupSocketServer } from './socket-server.ts'

const args = parseArgs({ options: { prod: { type: 'boolean' } } })

const PORT = 7172
const logStream = createWriteStream(join(process.cwd(), 'pv.log'), { flags: 'a' })

// Create a global io instance that will be initialized after server starts
let io: Server | null = null

const app = new Hono()
  .use(logger((message) => {
    const logEntry = `[${new Date().toISOString()}] ${message}`
    console.log(logEntry)
    logStream.write(`${logEntry}\n`)
  }))
  .use('/api/*', cors({
    origin: 'http://localhost:5173',
    credentials: true,
  }))

  .get('/healthcheck', (c) => {
    return c.text('okay')
  })

  .all('/api/auth/*', (c) => auth.handler(c.req.raw))

  .get('/api/users', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const users = await db.select({
      id: user.id,
      name: user.name,
      email: user.email,
    }).from(user).where(ne(user.id, session.user.id))

    return c.json(users as GetUsersResponse)
  })

  .post('/api/chats', zValidator('json', CreateChatRequest), async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const { name, selectedUserIds, publicContext } = c.req.valid('json')

    const groupChat: GroupChat = {
      userIds: [...selectedUserIds, session.user.id],
      publicContext: publicContext || '',
      groupChatHistory: [],
      individualChatHistory: {},
    }

    const newChat = await db.insert(chatTable).values({
      id: randomUUID(),
      name,
      groupChat,
    }).returning()

    return c.json(newChat[0])
  })

  .get('/api/chats/:chatId', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const chatId = c.req.param('chatId')

    const chatRecord = await db.select()
      .from(chatTable)
      .where(eq(chatTable.id, chatId))
      .limit(1)

    if (chatRecord.length === 0) {
      return c.json({ error: 'Chat not found' }, 404)
    }

    // Verify user has access
    const groupChat = chatRecord[0].groupChat
    if (!groupChat.userIds.includes(session.user.id)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    return c.json(chatRecord[0])
  })

  .post('/api/chats/:chatId/assistant', zValidator('json', z.object({ message: z.string() })), async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const chatId = c.req.param('chatId')
    const { message } = c.req.valid('json')

    // Get the chat
    const chatRecord = await db.select()
      .from(chatTable)
      .where(eq(chatTable.id, chatId))
      .limit(1)

    if (chatRecord.length === 0) {
      return c.json({ error: 'Chat not found' }, 404)
    }

    const groupChat = chatRecord[0].groupChat

    // Verify user has access
    if (!groupChat.userIds.includes(session.user.id)) {
      return c.json({ error: 'Access denied' }, 403)
    }

    // Add user message to individual chat history
    if (!groupChat.individualChatHistory[session.user.id]) {
      groupChat.individualChatHistory[session.user.id] = []
    }

    groupChat.individualChatHistory[session.user.id].push({
      userId: session.user.id,
      text: message,
      createdAt: new Date().toISOString(),
    })

    // Update the chat in database
    await db.update(chatTable)
      .set({ groupChat })
      .where(eq(chatTable.id, chatId))

    // Call takeAction and process the response
    const actionResponse = await takeAction(groupChat, session.user.id)
    console.log(actionResponse)

    try {
      const aiResponse = JSON.parse(actionResponse) as {
        messages?: Array<{
          recipient: string
          text: string
        }>
        updatePublicContext?: string
      }

      // Update public context if specified
      if (aiResponse.updatePublicContext) {
        groupChat.publicContext = aiResponse.updatePublicContext
        await db.update(chatTable)
          .set({ groupChat })
          .where(eq(chatTable.id, chatId))
      }

      // Process messages
      if (aiResponse.messages && Array.isArray(aiResponse.messages)) {
        for (const msg of aiResponse.messages) {
          const aiMessage: ChatMessage = {
            userId: 'assistant',
            text: msg.text,
            createdAt: new Date().toISOString(),
          }

          if (msg.recipient === 'group') {
            // Add to group chat history
            groupChat.groupChatHistory.push(aiMessage)

            // Send through socket to all users in the chat room
            if (io) {
              io.to(chatId).emit('message:received', {
                message: aiMessage,
                messageType: 'group',
                userName: 'AI Assistant',
              })
            }
          } else {
            // Add to individual chat history
            if (!groupChat.individualChatHistory[msg.recipient]) {
              groupChat.individualChatHistory[msg.recipient] = []
            }
            groupChat.individualChatHistory[msg.recipient].push(aiMessage)

            // Emit to the chat room with recipient info
            if (io) {
              io.to(chatId).emit('message:received', {
                message: aiMessage,
                messageType: 'assistant',
                recipientUserId: msg.recipient,
                userName: 'AI Assistant',
              })
            }
          }
        }

        // Save updated chat to database
        await db.update(chatTable)
          .set({ groupChat })
          .where(eq(chatTable.id, chatId))

        return c.json({
          success: true,
          messages: aiResponse.messages,
          publicContextUpdated: !!aiResponse.updatePublicContext,
        })
      }

      return c.json({ success: true })
    } catch (error) {
      console.error('Error parsing AI response:', error)
      console.error('Raw response:', actionResponse)
      return c.json({ error: 'Failed to process AI response' }, 500)
    }
  })


export type AppType = typeof app

if (args.values.prod) {
  app.get('/*', serveStatic({ root: './src/dist', index: 'index.html' }))
  app.get('*', serveStatic({ path: './src/dist/index.html' }))
}

const server = serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`Server running on http://[::]:${info.port}`)
})

// Initialize Socket.IO after server starts
io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    credentials: true,
  },
  connectionStateRecovery: {},
})
setupSocketServer(io, PORT)

// Export io instance for use elsewhere if needed
export { io }
