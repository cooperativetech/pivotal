#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import { handleSlackMessage } from '../slack-message-handler'
import { llmPersonaRespond, extractScheduledTime } from './agents/llm-persona-agent'
import { scoreAlgorithm, type PersonInput, type DataAvailabilityConfig } from './core-benchmark/score-algorithm'
import type { PersonProfile, TimeSlot } from './core-benchmark/generate-benchmark-data'

// Type definitions
interface ConversationLog {
  testCaseId: number
  model: string
  startTime: string
  participants: string[]
  conversation: Array<{
    timestamp: string
    speaker: string
    message: string
    type: 'user' | 'bot'
  }>
  botReasoning: Array<{
    timestamp: string
    message: string
    extractedTime: TimeSlot | null
  }>
  personaResponses: Array<{
    timestamp: string
    persona: string
    response: string
    calendar: PersonProfile['calendar']
  }>
  finalScheduledTime: TimeSlot | null
  optimalSlots: TimeSlot[]
  optimalUtility: number
  endTime?: string
  conversationLength?: number
}

// API base URL
const API_BASE_URL = 'http://localhost:3001'

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

// Create a mock message event
function createMockMessage(userId: string, text: string, channel: string, ts?: string): SlackEventMiddlewareArgs<'message'>['message'] {
  const timestamp = ts || (Date.now() / 1000).toString()
  return {
    type: 'message',
    subtype: undefined,
    text: text,
    ts: timestamp,
    user: userId,
    channel: channel,
    channel_type: 'channel',
    event_ts: timestamp,
  }
}

// Simulate a scheduling conversation using personas
async function simulateSchedulingConversation(
  testCase: BenchmarkTestCase,
  botUserId: string,
  model = 'google/gemini-2.5-pro',
): Promise<{ scheduledTime: TimeSlot | null; conversationLog: ConversationLog }> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Test Case #${testCase.id}`)
  console.log(`${'='.repeat(60)}`)

  // Clear ALL topics before each test to ensure clean state
  try {
    const clearResponse = await fetch(`${API_BASE_URL}/api/clear-topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearAll: true }),
    })
    if (clearResponse.ok) {
      const result = await clearResponse.json() as { message: string }
      console.log(`Database cleared: ${result.message}`)
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
  }

  // Use a unique channel for each test run to avoid collision
  const timestamp = Date.now()
  const channelId = `C_EVAL_${timestamp}_${testCase.id}`
  console.log(`Using channel: ${channelId}\n`)

  // Track conversation history and detailed logs
  const conversationHistory: string[] = []
  const detailedLog: ConversationLog = {
    testCaseId: testCase.id,
    model,
    startTime: new Date().toISOString(),
    participants: testCase.profiles.map((p) => p.name),
    conversation: [],
    botReasoning: [],
    personaResponses: [],
    finalScheduledTime: null,
    optimalSlots: testCase.optimalSlots,
    optimalUtility: testCase.optimalUtility,
  }
  let lastBotMessage = ''
  let scheduledTime: TimeSlot | null = null

  // Track DM messages sent to each user
  const dmMessagesPerUser = new Map<string, string[]>()
  const openDmChannels = new Map<string, string>() // userId -> dmChannelId

  // Create mock users map
  const userMap = new Map<string, string>()
  testCase.profiles.forEach((profile, idx) => {
    const userId = `U_USER_${idx}`
    userMap.set(userId, profile.name)
  })
  userMap.set(botUserId, 'SchedulerBot')

  // Create mock client that captures bot responses
  const mockClient = {
    chat: {
      postMessage: async (params: { thread_ts?: string; channel: string; text?: string }) => {
        const timestamp = (Date.now() / 1000).toString()
        lastBotMessage = params.text || ''

        // Check if this is a DM by looking at the channel ID
        const isDm = params.channel.startsWith('D_')
        if (isDm) {
          // Find which user this DM is for
          for (const [userId, dmChannelId] of openDmChannels.entries()) {
            if (dmChannelId === params.channel) {
              // Track this DM message for the specific user
              if (!dmMessagesPerUser.has(userId)) {
                dmMessagesPerUser.set(userId, [])
              }
              dmMessagesPerUser.get(userId)!.push(lastBotMessage)
              const userName = userMap.get(userId) || userId
              console.log(`\n🤖 Bot -> ${userName} (DM): ${lastBotMessage}\n`)
              break
            }
          }
        } else {
          console.log(`\n🤖 Bot: ${lastBotMessage}\n`)
        }
        conversationHistory.push(`Bot: ${lastBotMessage}`)
        detailedLog.conversation.push({
          timestamp: new Date().toISOString(),
          speaker: 'Bot',
          message: lastBotMessage,
          type: 'bot',
        })
        detailedLog.botReasoning.push({
          timestamp: new Date().toISOString(),
          message: lastBotMessage,
          extractedTime: null,
        })

        // Check if this message contains a confirmed time
        const extractedTime = await extractScheduledTime(lastBotMessage, model)
        if (extractedTime) {
          scheduledTime = extractedTime
          console.log(`\n✅ Scheduled time detected: ${extractedTime.start}-${extractedTime.end}\n`)
          detailedLog.botReasoning[detailedLog.botReasoning.length - 1].extractedTime = extractedTime
        }

        return { ok: true, ts: timestamp, message: { text: lastBotMessage, user: botUserId, ts: timestamp } }
      },
    },
    reactions: {
      add: () => Promise.resolve({ ok: true }),
    },
    conversations: {
      open: async (params: { users: string }) => {
        // Create a unique DM channel ID for this user
        const dmChannelId = `D_${params.users}_${Date.now()}`
        openDmChannels.set(params.users, dmChannelId)
        return Promise.resolve({ ok: true, channel: { id: dmChannelId } })
      },
    },
    users: {
      list: () => Promise.resolve({
        ok: true,
        members: Array.from(userMap.entries()).map(([id, name]) => ({
          id,
          team_id: 'T_TEST_TEAM',
          real_name: name,
          is_bot: id === botUserId,
          deleted: false,
          updated: Math.floor(Date.now() / 1000),
          tz: 'America/New_York',
        })),
      }),
    },
  } as unknown as AllMiddlewareArgs['client']

  // Start the conversation with the first user requesting to schedule
  const initiatorProfile = testCase.profiles[0]
  const initiatorId = 'U_USER_0'
  const initialMessage = `<@${botUserId}> Can you help us schedule a 1-hour meeting for Tuesday? We need ${testCase.profiles.map((p) => p.name).join(', ')} to attend.`

  console.log(`\n👤 ${initiatorProfile.name}: ${initialMessage}\n`)
  conversationHistory.push(`${initiatorProfile.name}: ${initialMessage}`)
  detailedLog.conversation.push({
    timestamp: new Date().toISOString(),
    speaker: initiatorProfile.name,
    message: initialMessage,
    type: 'user',
  })

  // Process initial message through the bot
  const mockMessage = createMockMessage(initiatorId, initialMessage, channelId)
  await handleSlackMessage(mockMessage, botUserId, mockClient)

  // Simulate back-and-forth for up to 10 rounds
  for (let round = 0; round < 10; round++) {
    // If we already have a scheduled time, we're done
    if (scheduledTime) {
      break
    }

    // Check if bot sent DM messages to users
    const hasDmMessages = dmMessagesPerUser.size > 0

    if (hasDmMessages) {
      // Each person responds to their specific DM if they received one
      for (let i = 0; i < testCase.profiles.length; i++) {
        const profile = testCase.profiles[i]
        const userId = `U_USER_${i}`

        // Check if this user received a DM
        const userDmMessages = dmMessagesPerUser.get(userId)
        if (userDmMessages && userDmMessages.length > 0) {
          // Get the most recent DM for this user
          const latestDm = userDmMessages[userDmMessages.length - 1]

          // Generate persona response based on their calendar and the DM they received
          const response = await llmPersonaRespond(profile, latestDm, conversationHistory, model)

          console.log(`\n👤 ${profile.name}: ${response}\n`)
          conversationHistory.push(`${profile.name}: ${response}`)
          detailedLog.conversation.push({
            timestamp: new Date().toISOString(),
            speaker: profile.name,
            message: response,
            type: 'user',
          })
          detailedLog.personaResponses.push({
            timestamp: new Date().toISOString(),
            persona: profile.name,
            response,
            calendar: profile.calendar,
          })

          // Send this response through the bot (responding in DM channel)
          const dmChannelId = openDmChannels.get(userId) || channelId
          const personaMessage = createMockMessage(userId, response, dmChannelId)
          await handleSlackMessage(personaMessage, botUserId, mockClient)

          // Clear this user's DM messages after they respond
          dmMessagesPerUser.set(userId, [])

          // Add small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200))

          // Check if bot scheduled something after this response
          if (scheduledTime) {
            break
          }
        }
      }
    } else if (lastBotMessage.includes('?') || lastBotMessage.toLowerCase().includes('available') ||
               lastBotMessage.toLowerCase().includes('work') || lastBotMessage.toLowerCase().includes('conflict')) {
      // Fallback: respond to channel messages (original logic)
      for (let i = 0; i < testCase.profiles.length; i++) {
        const profile = testCase.profiles[i]
        const userId = `U_USER_${i}`

        // Generate persona response based on their calendar
        const response = await llmPersonaRespond(profile, lastBotMessage, conversationHistory, model)

        console.log(`\n👤 ${profile.name}: ${response}\n`)
        conversationHistory.push(`${profile.name}: ${response}`)
        detailedLog.conversation.push({
          timestamp: new Date().toISOString(),
          speaker: profile.name,
          message: response,
          type: 'user',
        })
        detailedLog.personaResponses.push({
          timestamp: new Date().toISOString(),
          persona: profile.name,
          response,
          calendar: profile.calendar,
        })

        // Send this response through the bot
        const personaMessage = createMockMessage(userId, response, channelId)
        await handleSlackMessage(personaMessage, botUserId, mockClient)

        // Add small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 200))

        // Check if bot scheduled something after this response
        if (scheduledTime) {
          break
        }
      }
    } else {
      // Bot might have made a final decision, try to extract it
      const extractedTime = await extractScheduledTime(lastBotMessage, model)
      if (extractedTime) {
        scheduledTime = extractedTime
        break
      }

      // If bot isn't asking questions and hasn't scheduled, prompt for decision
      const promptMessage = 'Can you confirm the final meeting time for Tuesday?'
      console.log(`\n👤 ${initiatorProfile.name}: ${promptMessage}\n`)
      conversationHistory.push(`${initiatorProfile.name}: ${promptMessage}`)
      detailedLog.conversation.push({
        timestamp: new Date().toISOString(),
        speaker: initiatorProfile.name,
        message: promptMessage,
        type: 'user',
      })

      const promptMsg = createMockMessage(initiatorId, promptMessage, channelId)
      await handleSlackMessage(promptMsg, botUserId, mockClient)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('Conversation ended')
  console.log(`${'='.repeat(60)}\n`)

  detailedLog.endTime = new Date().toISOString()
  detailedLog.finalScheduledTime = scheduledTime
  detailedLog.conversationLength = conversationHistory.length

  return { scheduledTime, conversationLog: detailedLog }
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

  // Clear ALL topics from database before starting evaluation
  console.log('Clearing all topics from database...')
  try {
    const clearResponse = await fetch(`${API_BASE_URL}/api/clear-topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearAll: true }),
    })
    if (clearResponse.ok) {
      const result = await clearResponse.json() as { message: string }
      console.log(`✅ ${result.message}\n`)
    } else {
      console.error('Warning: Could not clear database')
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
  }

  // Set up test users in database
  console.log('Setting up test users...')
  try {
    const { setupTestUsers } = await import('../db/cleanup')
    await setupTestUsers()
  } catch (error) {
    console.error('Warning: Could not set up test users:', error)
  }

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
  const allConversationLogs: ConversationLog[] = []

  // Create algorithm function that uses flack simulation
  const flackAlgorithm = async (_inputs: PersonInput[]): Promise<TimeSlot> => {
    // Note: We don't use the PersonInput[] here since we need the full profiles for personas
    // Instead, we'll access the current test case directly
    const currentTestCase = testCases[testCaseIndex]
    testCaseIndex++ // Increment for next call

    const { scheduledTime, conversationLog } = await simulateSchedulingConversation(currentTestCase, botUserId, model)
    allConversationLogs.push(conversationLog)

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
  const totalMessagesAcrossTests = allConversationLogs.reduce((sum, log) => sum + (log.conversation?.length || 0), 0)
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
    const messageCount = log?.conversation?.length || 0
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
    const messageCount = log?.conversation?.length || 0
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
