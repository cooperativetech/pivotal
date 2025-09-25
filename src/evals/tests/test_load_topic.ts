#!/usr/bin/env node
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { local_api } from '../../shared/api-client.ts'
import { loadTopics } from '../../utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface TopicData {
  topic: {
    id: string
    botUserId: string
    workflowType: string
    createdAt: string
  }
  states: Array<{
    id: string
    topicId: string
    userIds: string[]
    summary: string
    isActive: boolean
    perUserContext: Record<string, unknown>
    createdByMessageId: string
    createdAt: string
    createdByMessageRawTs: string
  }>
  messages: Array<{
    id: string
    topicId: string
    userId: string
    channelId: string
    text: string
    timestamp: string
    rawTs: string
    threadTs: string | null
    raw: Record<string, unknown>
    autoMessageId: string | null
  }>
  users: Array<{
    id: string
    teamId: string
    realName: string
    email: string | null
    tz: string
    isBot: boolean
    deleted: boolean
    updated: string
    raw: Record<string, unknown>
  }>
  userData: unknown[]
  channels: Array<{
    id: string
    userIds: string[]
  }>
}

async function clearDatabase(): Promise<void> {
  console.log('Clearing database...')
  try {
    const result = await local_api.clear_test_data.$post()
    if (result.ok) {
      const data = await result.json()
      console.log(`Database cleared: ${data.message}`)
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
    throw error
  }
}

function loadTopicData(jsonFilePath: string): TopicData {
  console.log(`Loading topic data from: ${jsonFilePath}`)

  try {
    const jsonContent = readFileSync(jsonFilePath, 'utf8')
    const topicData = JSON.parse(jsonContent) as TopicData

    console.log(`Loaded topic: ${topicData.topic.id}`)
    console.log(`- ${topicData.messages.length} messages`)
    console.log(`- ${topicData.users.length} users`)
    console.log(`- ${topicData.states.length} states`)

    return topicData
  } catch (error) {
    throw new Error(`Failed to load topic data: ${String(error)}`)
  }
}

async function loadTopicIntoDatabase(jsonContent: string): Promise<string> {
  console.log('\nLoading topic and messages into database...')

  try {
    const result = await loadTopics(jsonContent)
    const newTopicId = result.topicIds[0]
    console.log(`Successfully loaded topic into database. New topic ID: ${newTopicId}`)
    console.log('Note: States will be recreated when new messages are processed')

    return newTopicId
  } catch (error) {
    throw new Error(`Failed to load topic into database: ${String(error)}`)
  }
}

async function continueConversation(userId: string, newTopicId: string): Promise<void> {
  console.log('\n--- Continuing Conversation ---')

  // Send a follow-up message from the user
  const followUpMessage = "The team includes Sarah from Engineering, Mike from Product, and Lisa from Design. We're all available next Tuesday or Wednesday afternoon."

  console.log(`${userId}: ${followUpMessage}`)

  // Send the message through local API with topicId to continue the existing conversation
  const messageRes = await local_api.message.$post({
    json: {
      userId,
      text: followUpMessage,
      topicId: newTopicId,
    },
  })

  if (!messageRes.ok) {
    const errorText = await messageRes.text()
    throw new Error(`Failed to send follow-up message: ${messageRes.statusText} - ${errorText}`)
  }

  const messageData = await messageRes.json()

  // Check if bot replied
  if (messageData.resMessages && Array.isArray(messageData.resMessages) && messageData.resMessages.length > 0) {
    console.log('\n--- Bot Responses ---')
    for (const resMessage of messageData.resMessages) {
      console.log(`Bot: ${resMessage.text}`)
    }
  } else {
    console.log('⚠️ Bot did not reply immediately')
  }
}

async function runLoadTopicTest(): Promise<void> {
  console.log('🧪 Starting Load Topic Test')

  try {
    // Step 1: Clear database
    await clearDatabase()

    // Step 2: Load topic data from JSON file
    const jsonFilePath = join(__dirname, '../results/tests/dump_topic_test_20250918172340511.json')
    const topicData = await loadTopicData(jsonFilePath)
    const jsonContent = readFileSync(jsonFilePath, 'utf8')

    // Step 3: Load topic, users, and messages into database (loadTopics handles everything)
    const newTopicId = await loadTopicIntoDatabase(jsonContent)

    // Step 4: Continue the conversation from where it left off
    const mainUserId = topicData.users.find((u) => !u.isBot)?.id
    if (!mainUserId) {
      throw new Error('No non-bot user found in topic data')
    }

    await continueConversation(mainUserId, newTopicId)

    console.log('\n✅ Load Topic Test completed successfully')

  } catch (error) {
    console.error('\n❌ Load Topic Test failed:', error)
    process.exit(1)
  }
}

// Run the test if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => process.nextTick(() => process.exit(1)))
  void runLoadTopicTest()
}