#!/usr/bin/env node
import { select, input } from '@inquirer/prompts'
import type { SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import { handleSlackMessage } from './slack-message-handler'

// API base URL
const API_BASE_URL = 'http://localhost:3001'

// Fetch bot info from the API
async function fetchBotInfo(): Promise<string | undefined> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/bot-info`)
    if (!response.ok) throw new Error('Failed to fetch bot info')
    const data = await response.json() as { botUserId?: string }
    return data.botUserId
  } catch (error) {
    console.error('Error fetching bot info:', error)
    return undefined
  }
}

// Fetch users from the API
async function fetchUsers(): Promise<Array<{ id: string; name: string }>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/users`)
    if (!response.ok) throw new Error('Failed to fetch users')
    // The API returns a Map serialized as an array of [id, name] pairs
    const data = await response.json() as Array<[string, string]>
    return data.map(([id, name]) => ({ id, name }))
  } catch (error) {
    console.error('Error fetching users:', error)
    return []
  }
}

// Function to create a mock message event
function createMockMessage(userId: string, text: string, channel: string = 'D_MOCK_CHANNEL', isDM = false): SlackEventMiddlewareArgs<'message'>['message'] {
  const ts = (Date.now() / 1000).toString() // Slack timestamps are in seconds, not milliseconds
  return {
    type: 'message',
    subtype: undefined,
    text: text,
    ts: ts,
    user: userId,
    channel: channel,
    channel_type: isDM ? 'im' : 'channel',
    event_ts: ts,
  }
}


// Main CLI function
async function main() {
  console.log('🤖 Welcome to Flack - Fake Slack Message Sender')
  console.log('Connecting to Slack bot API...\n')

  // Check if the bot is running
  const botUserId = await fetchBotInfo()
  if (!botUserId) {
    console.error('❌ Could not connect to Slack bot. Make sure the bot is running on http://localhost:3001')
    process.exit(1)
  }

  console.log('Loading Slack users...\n')
  const users = await fetchUsers()

  if (users.length === 0) {
    console.error('No users found. Make sure the Slack bot is running and configured correctly.')
    process.exit(1)
  }

  // Convert to array for inquirer
  const userChoices = users.map(user => ({
    name: user.name,
    value: user.id,
  }))

  // Ask user to select who they want to impersonate
  const selectedUserId = await select({
    message: 'Which user would you like to impersonate?',
    choices: userChoices,
  })

  const selectedUser = users.find(u => u.id === selectedUserId)
  const selectedUserName = selectedUser?.name || 'Unknown User'
  console.log(`\n✅ You are now impersonating: ${selectedUserName}\n`)

  console.log(`Bot User ID: ${botUserId}`)
  console.log('Connected to Slack bot handler\n')

  // Track conversation state
  const messageHistory: Array<{ user: string; text: string; ts: string }> = []

  // Create mock client with proper response handling
  const mockClient = {
    chat: {
      postMessage: (params: { thread_ts?: string; channel: string; text?: string }) => {
        const timestamp = (Date.now() / 1000).toString()
        if ('thread_ts' in params && params.thread_ts) {
          console.log(`\n🤖 Bot (in thread):`)
        } else if (params.channel.startsWith('D_')) {
          console.log(`\n🤖 Bot (DM to ${params.channel}):`)
        } else {
          console.log(`\n🤖 Bot:`)
        }
        console.log(`   ${params.text}\n`)

        messageHistory.push({
          user: botUserId,
          text: params.text || '',
          ts: timestamp,
        })

        return Promise.resolve({ ok: true, ts: timestamp, message: { text: params.text, user: botUserId, ts: timestamp } })
      },
    },
    reactions: {
      add: (params: { name: string; channel: string; timestamp: string }) => {
        console.log(`\n⚠️  Bot added reaction: :${params.name}:\n`)
        return Promise.resolve({ ok: true })
      },
    },
    conversations: {
      open: (params: { users?: string }) => Promise.resolve({
        ok: true,
        channel: { id: `D_${('users' in params ? params.users : 'unknown')}` },
      }),
    },
    users: {
      list: async () => {
        const userList = await fetchUsers()
        return {
          ok: true,
          members: userList.map(u => ({
            id: u.id,
            real_name: u.name,
            is_bot: false,
            deleted: false,
          })),
        }
      },
    },
  } as unknown as AllMiddlewareArgs['client']

  // Ask if this is a DM or channel message
  const messageType = await select({
    message: 'Where do you want to send messages from?',
    choices: [
      { name: 'Direct Message (DM)', value: 'dm' },
      { name: 'Channel Message', value: 'channel' },
      { name: 'Channel Message with @bot mention', value: 'mention' },
    ],
  })

  const isDM = messageType === 'dm'
  const mockChannel = isDM ? `D_${selectedUserId}` : 'C_MOCK_CHANNEL'

  // Message loop
  console.log('\nType your messages below (type "exit" to quit):')
  console.log('Commands: "exit" to quit\n')

  while (true) {
    const message = await input({
      message: `[${selectedUserName}]:`,
    })

    if (message.toLowerCase() === 'exit') {
      console.log('\n👋 Goodbye!')
      break
    }

    // Add bot mention if requested
    let messageText = message
    if (messageType === 'mention' && !message.includes(`<@${botUserId}>`)) {
      messageText = `<@${botUserId}> ${message}`
    }

    // Create mock message event
    const mockMessage = createMockMessage(selectedUserId, messageText, mockChannel, isDM)

    // Store message in history
    messageHistory.push({
      user: selectedUserId,
      text: messageText,
      ts: mockMessage.ts,
    })

    try {
      // Call the shared message handler
      await handleSlackMessage(mockMessage, botUserId, mockClient)
    } catch (error) {
      console.error('\n❌ Error processing message:', error)
    }
  }

  process.exit(0)
}

// Run the CLI
main().catch(console.error)
