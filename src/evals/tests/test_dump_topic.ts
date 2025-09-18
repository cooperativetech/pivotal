#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { local_api } from '../../shared/api-client.ts'
import { dumpTopic } from '../../utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

async function createTestUser(): Promise<string> {
  const testUserId = 'test_user_dump_topic'
  const usersToCreate = [{
    id: testUserId,
    realName: 'Test User',
    isBot: false,
  }]

  const createUsersRes = await local_api.users.create_fake.$post({
    json: { users: usersToCreate },
  })

  if (!createUsersRes.ok) {
    throw new Error(`Failed to create test user: ${createUsersRes.statusText}`)
  }

  const { userIds } = await createUsersRes.json()
  console.log(`Created test user: ${userIds[0]}`)
  return testUserId
}

async function startConversationWithPivotal(userId: string): Promise<string> {
  console.log('\n--- Starting Conversation with Pivotal ---')

  const testMessage = 'Hi Pivotal! Can you help me schedule a meeting with my team for next week? We need about 1 hour to discuss our project roadmap.'

  console.log(`${userId}: ${testMessage}`)

  // Send initial message through local API
  const initMessageRes = await local_api.message.$post({
    json: { userId, text: testMessage },
  })

  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId

  console.log(`Created topic: ${topicId}`)

  // Check if bot replied
  if (initResData.resMessages && Array.isArray(initResData.resMessages) && initResData.resMessages.length > 0) {
    console.log('\n--- Bot Responses ---')
    for (const resMessage of initResData.resMessages) {
      console.log(`Bot: ${resMessage.text}`)
    }
  } else {
    console.log('⚠️ Bot did not reply immediately')
  }

  return topicId
}

function formatTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')

  return `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`
}

async function dumpTopicToResults(topicId: string, userId: string): Promise<void> {
  console.log('\n--- Dumping Topic Data ---')

  // Wait a moment to ensure all processing is complete
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Dump the topic data
  const topicData = await dumpTopic(topicId, { visibleToUserId: userId })

  // Create results directory if it doesn't exist
  const resultsDir = join(__dirname, '../results/tests')
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true })
    console.log(`Created results directory: ${resultsDir}`)
  }

  // Generate filename with timestamp
  const timestamp = formatTimestamp()
  const filename = `dump_topic_test_${timestamp}.json`
  const filepath = join(resultsDir, filename)

  // Write topic data to file
  writeFileSync(filepath, JSON.stringify(topicData, null, 2))

  console.log(`Topic data dumped to: ${filepath}`)
  console.log(`Topic contains ${topicData.messages.length} messages from ${topicData.users.length} users`)

  // Print a summary of the conversation
  console.log('\n--- Conversation Summary ---')
  console.log(`Topic ID: ${topicData.topic.id}`)
  console.log(`Workflow Type: ${topicData.topic.workflowType}`)
  console.log(`Messages:`)

  topicData.messages.forEach((msg, index) => {
    const user = topicData.users.find(u => u.id === msg.userId)
    const userName = user?.realName || msg.userId
    const timestamp = new Date(msg.timestamp).toLocaleString()
    console.log(`  ${index + 1}. [${timestamp}] ${userName}: "${msg.text}"`)
  })
}

async function runDumpTopicTest(): Promise<void> {
  console.log('🧪 Starting Dump Topic Test')

  try {
    // Step 1: Clear database
    await clearDatabase()

    // Step 2: Create test user
    const userId = await createTestUser()

    // Step 3: Start conversation with Pivotal
    const topicId = await startConversationWithPivotal(userId)

    // Step 4: Dump topic to results
    await dumpTopicToResults(topicId, userId)

    console.log('\n✅ Dump Topic Test completed successfully')

  } catch (error) {
    console.error('\n❌ Dump Topic Test failed:', error)
    process.exit(1)
  }
}

// Run the test if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => process.nextTick(() => process.exit(1)))
  runDumpTopicTest()
}