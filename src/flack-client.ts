#!/usr/bin/env node
import { select, input } from '@inquirer/prompts'
import { io, Socket } from 'socket.io-client'

// API base URL
const API_BASE_URL = 'http://localhost:3001'

// Main CLI function
async function main() {
  console.log('🤖 Welcome to Flack - Fake Slack Message Sender')
  console.log('Connecting to socket server...')

  // Connect to socket server
  const socket: Socket = io(API_BASE_URL)

  // Wait for connection and users list
  const users = await new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
    let connected = false
    let usersReceived = false
    let usersList: Array<{ id: string; name: string }> = []

    socket.on('connect', () => {
      console.log('Connected to socket server')
      console.log('Loading Slack users...\n')
      connected = true
    })

    socket.on('users-list', (data: Array<{ id: string; name: string }>) => {
      usersList = data
      usersReceived = true
      resolve(usersList)
    })

    socket.on('error', (data: { message: string }) => {
      console.error(`\n❌ Error from server: ${data.message}\n`)
      reject(new Error(data.message))
    })

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!connected || !usersReceived) {
        reject(new Error('Timeout: Failed to connect or receive users list'))
      }
    }, 5000)
  })

  if (users.length === 0) {
    console.error('No users found. Make sure the Slack bot is running and configured correctly.')
    socket.disconnect()
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

  // Set up event listeners for bot responses
  socket.on('bot-response', (data: { channel: string; text: string; thread_ts?: string; timestamp: string }) => {
    if (data.thread_ts) {
      console.log(`\n🤖 Bot (in thread):`)
    } else if (data.channel.startsWith('D')) {
      console.log(`\n🤖 Bot (DM to ${data.channel}):`)
    } else {
      console.log(`\n🤖 Bot: (Group message to ${data.channel})`)
    }
    console.log(`   ${data.text}\n`)
  })

  socket.on('bot-reaction', (data: { name: string; channel: string; timestamp: string }) => {
    console.log(`\n⚠️  Bot added reaction: :${data.name}:\n`)
  })

  socket.on('error', (data: { message: string }) => {
    console.error(`\n❌ Error from server: ${data.message}\n`)
  })

  // Notify server of selected user
  socket.emit('user-selected', selectedUserId)

  // Message loop (all messages are DMs to the bot)
  console.log('\nType your messages below (type "exit" to quit):')
  console.log('You are sending DMs to the bot as ' + selectedUserName)
  console.log('Commands: "exit" to quit\n')

  while (true) {
    const message = await input({
      message: `[${selectedUserName}]:`,
    })

    if (message.toLowerCase() === 'exit') {
      console.log('\n👋 Goodbye!')
      break
    }

    // Send message text to socket server
    socket.emit('flack-message', {
      text: message,
    })
  }

  socket.disconnect()
  process.exit(0)
}

// Run the CLI
main().catch(console.error)
