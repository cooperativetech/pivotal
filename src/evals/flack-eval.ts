#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { io, Socket } from 'socket.io-client'
import { llmPersonaRespond, extractScheduledTime } from './agents/llm-persona-agent'
import { scoreAlgorithm, PersonInput, DataAvailabilityConfig } from './core-benchmark/score-algorithm'
import type { PersonProfile, TimeSlot } from './core-benchmark/generate-benchmark-data'
import { api, unserializeTopicTimestamps } from '../shared/api-client'
import { TopicData } from '../utils'

interface BenchmarkTestCase {
  id: number
  profiles: PersonProfile[]
  aggregateRawText?: string
  utilityDistribution: {
    timeSlot: TimeSlot
    totalUtility: number
  }[]
  optimalSlots: TimeSlot[]
  optimalUtility: number
}

const API_BASE_URL = 'http://localhost:3001'

// Create a socket.io client that impersonates a specific user
async function createUserSocketClient(userId: string): Promise<Socket> {
  const socket: Socket = io(API_BASE_URL)

  return new Promise<Socket>((resolve, reject) => {
    let connected = false
    let userListReceived = false

    // Handle connection
    socket.on('connect', () => {
      console.log(`Socket connected for user ${userId}`)
      connected = true
    })

    // Handle users list and immediately select the user
    socket.on('users-list', () => {
      userListReceived = true
      // Emit user selection to impersonate the specified user
      socket.emit('user-selected', userId)
      console.log(`Socket impersonating user: ${userId}`)
      resolve(socket)
    })

    // Handle errors
    socket.on('error', (data: { message: string }) => {
      console.error(`Socket error for user ${userId}: ${data.message}`)
      reject(new Error(data.message))
    })

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!connected || !userListReceived) {
        reject(new Error(`Timeout: Failed to connect socket for user ${userId}`))
      }
    }, 5000)
  })
}

// Simulate a scheduling conversation using personas
async function simulateSchedulingConversation(
  testCase: BenchmarkTestCase,
  botUserId: string,
): Promise<TopicData> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Test Case #${testCase.id}`)
  console.log(`${'='.repeat(60)}`)

  // Clear ALL topics, users, and queued messages before each test to ensure clean state
  try {
    const result = await api.clear_test_data.$post()
    if (result.ok) {
      const data = await result.json()
      console.log(`Database cleared: ${data.message}`)
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
  }

  // Create a server-side user for each test case profile
  for (let idx = 0; idx < testCase.profiles.length; idx++) {
    const profile = testCase.profiles[idx]
    const userId = `U_USER_${idx}`
    const result = await api.users.create_fake.$post({
      json: { userId, realName: profile.name },
    })
    if (result.ok) {
      console.log(`Created user: ${profile.name} (${userId})`)
    } else {
      throw new Error(`Failed to create user: ${profile.name} (${userId})`)
    }
  }

  let topicId: string | null = null

  // Create a socket for every test user, and listen for bot responses
  const promises = testCase.profiles.map(async (profile, idx) => {
    const userId = `U_USER_${idx}`
    const socket = await createUserSocketClient(userId)

    // Send initial message
    if (idx == 0) {
      const initMessage = `<@${botUserId}> Can you help us schedule a 1-hour meeting for Tuesday? We need ${testCase.profiles.map((p) => p.name).join(', ')} to attend.`
      console.log(`Sending initial message from ${userId}: ${initMessage}`)
      socket.emit('flack-message', { text: initMessage })
    }

    let msgCount = 0
    socket.on('bot-response', async (data: { channel: string; text: string; thread_ts?: string; timestamp: string }) => {
      console.log(`Message received for ${userId}: ${data.text}`)
      // Get the topicId (latest topic created) if it has not yet been fetched
      if (topicId === null) {
        const response = await api.latest_topic_id.$get()
        if (response.ok) {
          const data = await response.json()
          topicId = data.topicId
          console.log(`Retrieved latest topic ID: ${topicId}`)
        } else {
          throw new Error(`Failed to get latest topic: ${response.statusText}`)
        }
      }

      // Respond if direct message, or if the group message includes a question, or the word available, work, or conflict
      if (msgCount < 10 && (data.channel.startsWith('D') || (
        data.text.includes('?') ||
        data.text.toLowerCase().includes('available') ||
        data.text.toLowerCase().includes('work') ||
        data.text.toLowerCase().includes('conflict')
      ))) {
        const message = await llmPersonaRespond(topicId, userId, profile, data.text, data.timestamp)
        console.log(`Sending response from ${userId}: ${message}`)
        socket.emit('flack-message', { topicId: topicId, text: message })
        msgCount += 1

      // Otherwise, close the socket
      } else {
        socket.removeAllListeners('bot-response')
        socket.disconnect()
      }
    })

    const resPromise = new Promise<void>((resolve) => {
      socket.on('disconnect', () => resolve())
    })

    return resPromise
  })

  await Promise.all(promises)

  // Get topic data and extract scheduled time from last message
  if (topicId === null) {
    throw new Error('Topic id never fetched from server')
  }

  const topicResponse = await api.topics[':topicId'].$get({
    param: { topicId },
    query: {},
  })

  if (!topicResponse.ok) {
    throw new Error(`Failed to get topic data: ${topicResponse.statusText}`)
  }
  const topicData = unserializeTopicTimestamps(await topicResponse.json())

  console.log(`\n${'='.repeat(60)}`)
  console.log('Conversation ended')
  console.log(`${'='.repeat(60)}\n`)

  return topicData
}

// Evaluate using flack infrastructure
export async function evaluateWithFlack(
  benchmarkFile: string,
  dataAvailability: DataAvailabilityConfig = { calendarProbability: 1.0 },
  model = 'google/gemini-2.5-flash',
) {
  console.log('Evaluating scheduling using Flack infrastructure with LLM personas...')
  console.log(`Model: ${model}`)
  console.log(`Data availability: ${dataAvailability.calendarProbability * 100}% calendar\n`)

  // Check if bot is running
  console.log('Connecting to Slack bot at http://localhost:3001...')
  const botUserId = 'UTESTBOT'
  if (!botUserId) {
    console.error('❌ Could not connect to Slack bot. Make sure the bot is running on http://localhost:3001')
    console.error('Run the bot server first, then run this eval.')
    process.exit(1)
  }
  console.log(`✅ Connected! Bot User ID: ${botUserId}\n`)

  // Load benchmark data
  const dataDir = join(import.meta.dirname, 'data')
  let filepath = join(dataDir, benchmarkFile)

  if (!existsSync(filepath)) {
    filepath = benchmarkFile
    if (!existsSync(filepath)) {
      throw new Error(`Benchmark data file not found: ${benchmarkFile}`)
    }
  }

  console.log(`Loading benchmark data from ${filepath}...`)
  const testCases: BenchmarkTestCase[] = JSON.parse(readFileSync(filepath, 'utf-8')) as BenchmarkTestCase[]
  console.log(`Loaded ${testCases.length} test cases\n`)

  // Track which test case we're on and collect all logs
  let testCaseIndex = 0
  const allConversationLogs: TopicData[] = []

  // Create algorithm function that uses flack simulation
  const flackAlgorithm = async (_inputs: PersonInput[]): Promise<TimeSlot> => {
    // Note: We don't use the PersonInput[] here since we need the full profiles for personas
    // Instead, we'll access the current test case directly
    const currentTestCase = testCases[testCaseIndex]
    testCaseIndex++ // Increment for next call

    const topicData = await simulateSchedulingConversation(currentTestCase, botUserId)
    allConversationLogs.push(topicData)

    const lastMessage = topicData.messages.sort((a, b) =>
      Number(b.rawTs) - Number(a.rawTs),
    )[0]
    const scheduledTime = await extractScheduledTime(lastMessage.text)

    if (!scheduledTime) {
      console.error('Failed to extract scheduled time from conversation')
      return { start: '10:00', end: '11:00' } // Fallback
    }

    return scheduledTime
  }

  // Run scoring with our flack-based algorithm
  const scoringResults = await scoreAlgorithm(
    `Production Bot (Claude Sonnet 4) with LLM Personas (${model})`,
    flackAlgorithm,
    benchmarkFile,
    dataAvailability,
  )

  // Calculate efficiency metrics
  const totalMessagesAcrossTests = allConversationLogs.reduce((sum, log) => sum + (log.messages.length || 0), 0)
  const avgMessagesPerConversation = totalMessagesAcrossTests / allConversationLogs.length

  // Print simplified results
  console.log('\n' + '='.repeat(60))
  console.log('EVALUATION RESULTS')
  console.log('='.repeat(60))
  console.log(`Average Percentile: ${scoringResults.summary.averagePercentile.toFixed(1)}%`)
  console.log(`Average Messages: ${avgMessagesPerConversation.toFixed(0)}`)
  console.log('='.repeat(60))

  // Print detailed test case results
  console.log('\nDETAILED TEST CASE RESULTS')
  console.log('='.repeat(60))
  scoringResults.results.forEach((result, idx) => {
    const log = allConversationLogs[idx]
    const messageCount = log.messages.length || 0
    console.log(`\nTest Case #${result.testCaseId}:`)
    console.log(`  Percentile: ${result.percentile.toFixed(1)}%`)
    console.log(`  Messages: ${messageCount}`)
    console.log(`  Status: ${result.isOptimal ? '✅ OPTIMAL' : '❌ SUB-OPTIMAL'}`)
  })
  console.log('\n' + '='.repeat(60))

  // Save evaluation results to files
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resultsDir = join(import.meta.dirname, '..', 'eval-results', timestamp)
  mkdirSync(resultsDir, { recursive: true })

  // Save conversation logs
  const conversationLogPath = join(resultsDir, 'conversation-logs.json')
  writeFileSync(conversationLogPath, JSON.stringify(allConversationLogs, null, 2))
  console.log(`\n📝 Conversation logs saved to: ${conversationLogPath}`)

  // Save scoring results
  const scoringResultsPath = join(resultsDir, 'scoring-results.json')
  writeFileSync(scoringResultsPath, JSON.stringify(scoringResults, null, 2))
  console.log(`📊 Scoring results saved to: ${scoringResultsPath}`)

  // Create a summary markdown file
  const summaryPath = join(resultsDir, 'eval-summary.md')
  const summaryContent = `# Evaluation Summary

**Date:** ${new Date().toISOString()}
**Model:** ${model}

## Results

- **Average Percentile:** ${scoringResults.summary.averagePercentile.toFixed(1)}%
- **Average Messages:** ${avgMessagesPerConversation.toFixed(0)}

## Test Case Details

${scoringResults.results.map((r, idx) => {
    const log = allConversationLogs[idx]
    const messageCount = log.messages.length || 0
    return `### Test Case #${r.testCaseId}
- **Percentile:** ${r.percentile.toFixed(1)}%
- **Messages:** ${messageCount}
- **Status:** ${r.isOptimal ? '✅ OPTIMAL' : '❌ SUB-OPTIMAL'}`
  }).join('\n\n')}
`
  writeFileSync(summaryPath, summaryContent)
  console.log(`📄 Summary report saved to: ${summaryPath}`)

  console.log(`\n✨ All evaluation results saved in: ${resultsDir}\n`)
}

// Run the evaluation
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmarkFile = process.argv[2] || 'benchmark-data-2-cases.json'
  const calendarProb = parseFloat(process.argv[3] || '1.0')
  const model = process.argv[4] || 'google/gemini-2.5-flash'

  evaluateWithFlack(benchmarkFile, { calendarProbability: calendarProb }, model).catch(console.error)
}
