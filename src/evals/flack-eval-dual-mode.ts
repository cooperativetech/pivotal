#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { llmPersonaRespond, extractScheduledTime } from './agents/llm-persona-agent'
import { scoreAlgorithmWithCases, PersonInput, DataAvailabilityConfig } from './core-benchmark/score-algorithm'
import type { PersonProfile, TimeSlot, BenchmarkTestCase } from './core-benchmark/generate-benchmark-data'
import { generateBenchmarkTestCases } from './core-benchmark/generate-benchmark-data'
import { api } from '../shared/api-client'
import { unserializeTopicData, TopicData } from '@shared/api-types'
import { setupCalendarDataForEval } from './setup-calendar-data'


type EvalMode = 'persona' | 'calendar'

// Simulate a scheduling conversation using personas or calendar mode
async function simulateSchedulingConversation(
  testCase: BenchmarkTestCase,
  mode: EvalMode = 'persona',
): Promise<TopicData> {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Test Case #${testCase.id} - Mode: ${mode.toUpperCase()}`)
  console.log(`${'='.repeat(60)}`)

  // Clear ALL topics, users, and queued messages before each test
  try {
    const result = await api.clear_test_data.$post()
    if (result.ok) {
      const data = await result.json()
      console.log(`Database cleared: ${data.message}`)
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
  }

  // In calendar mode, store calendar data in database first
  if (mode === 'calendar') {
    console.log('Setting up calendar data in database...')
    await setupCalendarDataForEval(testCase.profiles, false)
  }

  // Create all server-side users for this test case at once
  const usersToCreate = testCase.profiles.map((profile, idx) => ({
    id: `U_USER_${idx}`,
    realName: profile.name,
    isBot: false,
  }))
  const userIdProfileMap = new Map<string, PersonProfile>()
  testCase.profiles.forEach((profile, idx) => userIdProfileMap.set(`U_USER_${idx}`, profile))

  const createUsersRes = await api.users.create_fake.$post({
    json: { users: usersToCreate },
  })
  if (!createUsersRes.ok) {
    throw new Error(`Failed to create users: ${createUsersRes.statusText}`)
  }

  const { userIds } = await createUsersRes.json()
  console.log(`Created ${userIds.length} test users`)
  if (userIds.length < 1) {
    throw new Error('Eval requires at least 1 test user')
  }

  const initMessage = `Can you help us schedule a 1-hour meeting for Tuesday? We need ${testCase.profiles.map((p) => p.name).join(', ')} to attend.`
  console.log(`Sending initial message from ${userIds[0]}: ${initMessage}`)

  const initMessageRes = await api.message.$post({
    json: { userId: userIds[0], text: initMessage },
  })
  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId
  let msgsToReplyTo = initResData.resMessages

  // In a loop: reply to every recent message from the bot, and collect all the bot responses
  // to respond to on the next loop iteration.
  // Continue until there are no messages left to respond to, for a maximum of 10 rounds
  let msgRoundCount = 0
  while (msgsToReplyTo.length > 0 && msgRoundCount < 10) {
    const nestedMsgsToSend = await Promise.all(msgsToReplyTo.map(async (message) => {
      // If the message includes the text 'scheduled for', don't respond
      if (message.text.includes('scheduled for')) {
        return []
      }

      // Respond if direct message, or if the group message includes a question, or the word available, work, or conflict
      if (message.channelId.startsWith('D') || (
        message.text.includes('?') ||
        message.text.toLowerCase().includes('available') ||
        message.text.toLowerCase().includes('preferences') ||
        message.text.toLowerCase().includes('work') ||
        message.text.toLowerCase().includes('confirm') ||
        message.text.toLowerCase().includes('how about')
      )) {
        const channelRes = await api.channels[':channelId'].$get({
          param: { channelId: message.channelId  },
        })
        if (!channelRes.ok) {
          throw new Error(`Failed to get channel info: ${message.channelId}`)
        }

        // Generate response from all non-bot users in channel
        const { userIds } = await channelRes.json()
        return Promise.all(userIds.map(async (userId) => {
          const profile = userIdProfileMap.get(userId)
          if (!profile) {
            throw new Error(`Profile not found for userId: ${userId}`)
          }
          const userMsg = await llmPersonaRespond(topicId, userId, profile, message.text, message.timestamp)
          return { userId, userMsg }
        }))
      }
      return []
    }))

    // Send the messages, and collect the bot responses to reply to in the next round
    const msgsToSend = nestedMsgsToSend.flat()
    const nestedMsgsToReplyTo = await Promise.all(msgsToSend.map(async ({ userId, userMsg }) => {
      console.log(`Sending response from ${userId}: ${userMsg}`)
      const messageRes = await api.message.$post({
        json: { topicId, userId, text: userMsg },
      })
      if (!messageRes.ok) {
        throw new Error(`Failed to process message: ${messageRes.statusText}`)
      }

      const { resMessages } = await messageRes.json()
      return resMessages
    }))

    msgsToReplyTo = nestedMsgsToReplyTo.flat()
    msgRoundCount += 1
  }

  const topicResponse = await api.topics[':topicId'].$get({
    param: { topicId },
    query: {},
  })

  if (!topicResponse.ok) {
    throw new Error(`Failed to get topic data: ${topicResponse.statusText}`)
  }
  const topicData = unserializeTopicData(await topicResponse.json())

  console.log(`\n${'='.repeat(60)}`)
  console.log('Conversation ended')
  console.log(`${'='.repeat(60)}\n`)

  return topicData
}

// Evaluate using flack infrastructure
export async function evaluateWithFlack(
  numCases: number,
  mode: EvalMode = 'persona',
  dataAvailability: DataAvailabilityConfig = { calendarProbability: 1.0 },
  model = 'google/gemini-2.5-flash',
) {
  console.log('Evaluating scheduling using Flack infrastructure...')
  console.log(`Mode: ${mode.toUpperCase()} (${mode === 'calendar' ? 'Bot sees calendars directly' : 'LLM personas respond'})`)
  console.log(`Persona Model: ${model}`)
  console.log(`Data availability: ${dataAvailability.calendarProbability * 100}% calendar\n`)

  // Generate benchmark data dynamically with current "next Tuesday" dates
  console.log(`Generating ${numCases} test cases with current dates...`)
  const testCases: BenchmarkTestCase[] = generateBenchmarkTestCases(numCases)
  console.log(`Generated ${testCases.length} test cases\n`)

  let testCaseIndex = 0
  const allConversationLogs: TopicData[] = []

  // Create algorithm function
  const flackAlgorithm = async (_inputs: PersonInput[]): Promise<TimeSlot> => {
    const currentTestCase = testCases[testCaseIndex]
    testCaseIndex++

    const topicData = await simulateSchedulingConversation(currentTestCase, mode)
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

  // Run scoring with test cases array instead of file
  const scoringResults = await scoreAlgorithmWithCases(
    `Production Bot (Claude Sonnet 4) - ${mode.toUpperCase()} MODE`,
    flackAlgorithm,
    testCases,
    dataAvailability,
  )

  // Calculate efficiency metrics
  const totalMessagesAcrossTests = allConversationLogs.reduce((sum, log) => sum + (log.messages.length || 0), 0)
  const avgMessagesPerConversation = totalMessagesAcrossTests / allConversationLogs.length

  // Print results
  console.log('\n' + '='.repeat(60))
  console.log('EVALUATION RESULTS')
  console.log('='.repeat(60))
  console.log(`Mode: ${mode.toUpperCase()}`)
  console.log(`Average Percentile: ${scoringResults.summary.averagePercentile.toFixed(1)}%`)
  console.log(`Average Messages: ${avgMessagesPerConversation.toFixed(0)}`)
  console.log('='.repeat(60))

  // Print detailed results
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

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resultsDir = join(import.meta.dirname, '..', 'eval-results', `${timestamp}-${mode}`)
  mkdirSync(resultsDir, { recursive: true })

  const conversationLogPath = join(resultsDir, 'conversation-logs.json')
  writeFileSync(conversationLogPath, JSON.stringify(allConversationLogs, null, 2))
  console.log(`\n📝 Conversation logs saved to: ${conversationLogPath}`)

  const scoringResultsPath = join(resultsDir, 'scoring-results.json')
  writeFileSync(scoringResultsPath, JSON.stringify(scoringResults, null, 2))
  console.log(`📊 Scoring results saved to: ${scoringResultsPath}`)

  const summaryPath = join(resultsDir, 'eval-summary.md')
  const summaryContent = `# Evaluation Summary

**Date:** ${new Date().toISOString()}
**Mode:** ${mode.toUpperCase()}
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
  const mode = (process.argv[2] || 'persona') as EvalMode
  const numCases = parseInt(process.argv[3] || '2')
  const calendarProb = parseFloat(process.argv[4] || '1.0')
  const model = process.argv[5] || 'google/gemini-2.5-flash'

  if (!['persona', 'calendar'].includes(mode)) {
    console.error('Invalid mode. Use "persona" or "calendar"')
    process.exit(1)
  }

  if (isNaN(numCases) || numCases < 1) {
    console.error('Invalid number of cases. Must be a positive integer')
    process.exit(1)
  }

  evaluateWithFlack(numCases, mode, { calendarProbability: calendarProb }, model).catch(console.error)
}
