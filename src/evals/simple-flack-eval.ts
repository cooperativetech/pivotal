#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { saveEvaluationResults, createAggregatedSummary, createResultsFolder, formatTimestamp, clearDatabase, getBenchmarksFromSet } from './utils'
import { dumpTopic } from '../utils'
import { findCommonFreeTime } from '../tools/time_intersection'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse command line arguments for benchmark file or folder
function parseArguments(): { benchmarkSet: string; benchmark: string | null; nReps: number; topicRouting: boolean } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      benchmarkSet: {
        type: 'string',
        short: 's',
        default: 'benchmarks',
      },
      benchmark: {
        type: 'string',
        short: 'b',
      },
      nReps: {
        type: 'string',
        short: 'r',
        default: '1',
      },
      topicRouting: {
        type: 'boolean',
        short: 't',
        default: false,
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
  })

  if (values.help) {
    console.log('Usage: pnpm run eval [options]')
    console.log('\nOptions:')
    console.log('  -s, --benchmarkSet      Top-level folder containing multiple benchmarks (e.g., "benchmarks" or specific folder)')
    console.log('  -b, --benchmark         Single benchmark folder with timestamped groups (e.g., benchmark_XYZ_gen<timestamp>)')
    console.log('  -r, --nReps             Number of repetitions per case (default: 1)')
    console.log('  -t, --topicRouting      Enable topic routing (default: false)')
    console.log('  -h, --help              Show this help message')
    console.log('\nIf no arguments are provided, defaults to running all benchmarks in the "benchmarks" folder')
    process.exit(0)
  }

  // Validate arguments - only one option should be specified
  const argCount = [values.benchmarkSet, values.benchmark].filter(Boolean).length
  if (argCount > 1) {
    console.error('Error: Cannot specify both --benchmarkSet and --benchmark')
    process.exit(1)
  }

  return {
    benchmarkSet: values.benchmarkSet,
    benchmark: values.benchmark || null,
    nReps: parseInt(values.nReps, 10),
    topicRouting: values.topicRouting || false,
  }
}
import { BaseScheduleUser } from './sim-users'
import { type SavedEvaluationResults, type BaseScheduleUserData, BenchmarkFileData } from './utils'
import { isConfirming, extractSuggestedTime } from '../agents/evals'
import type { SimpleCalendarEvent } from './sim-users'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'

// Load benchmark data and create BaseScheduleUser simUsers using import functionality
function loadSimUsersFromBenchmarkData(benchmarkSimUsers: BaseScheduleUserData[]): BaseScheduleUser[] {
  return benchmarkSimUsers.map((personData) => {
    return BaseScheduleUser.import(personData)
  })
}

// Create all server-side users based on simUsers
async function createUsersFromSimUsers(simUsers: Record<string, BaseScheduleUser>): Promise<Map<string, BaseScheduleUser>> {
  const usersToCreate = Object.values(simUsers).map((simUser) => ({
    id: simUser.name,
    realName: simUser.name,
    isBot: false,
  }))

  const userSimUserMap = new Map<string, BaseScheduleUser>()
  Object.values(simUsers).forEach((simUser) => userSimUserMap.set(simUser.name, simUser))

  const createUsersRes = await local_api.users.create_fake.$post({
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

  return userSimUserMap
}

// Process bot message responses and add them to appropriate simUser buffers
async function processBotMessages(messageResult: Record<string, unknown>, simUsers: Record<string, BaseScheduleUser>): Promise<SimpleCalendarEvent | null> {
  if (!messageResult.resMessages || !Array.isArray(messageResult.resMessages)) {
    console.log('⚠️ Bot did not reply - no resMessages in response')
    return null
  }

  if (messageResult.resMessages.length === 0) {
    console.log('⚠️ Bot did not reply - resMessages array is empty')
    return null
  }

  let suggestedEvent: SimpleCalendarEvent | null = null

  // Process each bot response message
  for (const resMessage of messageResult.resMessages as Record<string, unknown>[]) {
    console.log(`Bot response: "${resMessage.text as string}"`)

    // Extract suggested event from this message using Agent
    if (!suggestedEvent) {
      const extractedEvent = await extractSuggestedTime(resMessage.text as string)
      if (extractedEvent) {
        suggestedEvent = extractedEvent
        console.log(`✅ Extracted suggested meeting: ${extractedEvent.start.toISOString()} - ${extractedEvent.end.toISOString()} (${extractedEvent.summary})`)
      } else {
        console.log('ℹ️  No meeting time detected in bot message')
      }
    }

    try {
      // Get channel information to determine which simUsers should receive this message
      const channelRes = await local_api.channels[':channelId'].$get({
        param: { channelId: resMessage.channelId as string },
      })

      if (!channelRes.ok) {
        console.error(`Failed to get channel info: ${resMessage.channelId as string}`)
        // Fallback: send to all simUsers if we can't get channel info
        for (const simUser of Object.values(simUsers)) {
          simUser.receive(resMessage.text as string)
        }
        continue
      }

      const { userIds } = await channelRes.json()

      // Only send message to simUsers whose names match the channel userIds
      for (const userId of userIds) {
        if (simUsers[userId]) {
          simUsers[userId].receive(resMessage.text as string)
        }
      }
    } catch (error) {
      console.error(`Error processing bot message for channel ${resMessage.channelId as string}:`, error)
      // Fallback: send to all simUsers if there's an error
      for (const simUser of Object.values(simUsers)) {
        simUser.receive(resMessage.text as string)
      }
    }
  }

  return suggestedEvent
}


// Simulate a strict turn-based scheduling conversation
async function simulateTurnBasedConversation(simUsers: Record<string, BaseScheduleUser>, topicRouting: boolean = false, nGroups: number, groupUserMapping: string[][], groupGoalInitializer: string[]): Promise<{ topicDatas: (TopicData | null)[]; suggestedEvents: (SimpleCalendarEvent | null)[]; confirmations: Record<string, boolean> }> {
  console.log('\n' + '='.repeat(60))
  console.log('Starting Turn-Based Scheduling Conversation')
  console.log('='.repeat(60))

  if (Object.keys(simUsers).length === 0) {
    throw new Error('No simUsers provided for conversation')
  }

  // Log all simUsers
  Object.values(simUsers).forEach((simUser, index) => {
    console.log(`SimUser ${index + 1}: ${simUser.name} - Goal: "${simUser.goal}"`)
  })

  // Create inverse mapping and validate for topicRouting
  let userGroupMapping: Record<string, number> | null = null

  if (!topicRouting) {
    // Construct inverse mapping: user -> group
    userGroupMapping = {}
    groupUserMapping.forEach((userNames, groupIndex) => {
      userNames.forEach(userName => {
        if (userGroupMapping![userName] !== undefined) {
          throw new Error(`When topicRouting is false, users cannot be in multiple groups. User '${userName}' found in both group ${userGroupMapping![userName]} and group ${groupIndex}`)
        }
        userGroupMapping![userName] = groupIndex
      })
    })
  } else {
    // When topicRouting is enabled, users can be in multiple groups
    userGroupMapping = null
  }

  // Initialize group-based tracking
  const topicIds: (string | null)[] = Array.from({ length: nGroups }, () => null)
  const suggestedEvents: (SimpleCalendarEvent | null)[] = Array.from({ length: nGroups }, () => null)

  // Start conversation: Send initial messages from goal initializers
  console.log('\n--- Starting Conversation ---')
  // Send initial messages from goal initializers for each group

  for (let groupIndex = 0; groupIndex < groupGoalInitializer.length; groupIndex++) {
    const goalUserName = groupGoalInitializer[groupIndex]
    const simUser = simUsers[goalUserName]

    if (simUser.goal && simUser.goal.trim() !== '') {
      const initialMessage = await simUser.sendInitialMessage()

      if (!initialMessage) {
        console.log(`${simUser.name} (Group ${groupIndex}) has a goal but no initial message to send`)
        continue
      }

      console.log(`${simUser.name} (Group ${groupIndex}): ${initialMessage}`)

      // Send initial message through local API
      const initMessageRes = await local_api.message.$post({
        json: {
          userId: simUser.name,
          text: initialMessage,
          ignoreExistingTopics: !topicRouting,
          ...(!topicRouting ? { topicId: topicIds[groupIndex] || undefined } : {}),
        },
      })
      if (!initMessageRes.ok) {
        throw new Error(`Failed to process initial message from ${simUser.name}: ${initMessageRes.statusText}`)
      }

      const initResData = await initMessageRes.json()

      // Store topicId for this group
      if (!topicIds[groupIndex]) {
        topicIds[groupIndex] = initResData.topicId
        console.log(`Created topic for group ${groupIndex}: ${topicIds[groupIndex]}`)
      }

      // Process bot responses for this initial message and extract suggested event
      const newSuggestedEvent = await processBotMessages(initResData, simUsers)
      if (newSuggestedEvent && !suggestedEvents[groupIndex]) {
        suggestedEvents[groupIndex] = newSuggestedEvent
        console.log(`  → Initial bot suggestion for group ${groupIndex}: ${newSuggestedEvent.start.toISOString()} - ${newSuggestedEvent.end.toISOString()} (${newSuggestedEvent.summary})`)
      }
    }
  }

  if (topicIds.every((id) => !id)) {
    throw new Error('No simUser with a goal was able to start a conversation')
  }

  // Initialize confirmation tracking for all simUsers
  const confirmations: Record<string, boolean> = {}
  const resetConfirmations = () => {
    Object.values(simUsers).forEach((simUser) => {
      confirmations[simUser.name] = false
    })
  }
  resetConfirmations()

  // Run turn-based conversation for up to 10 rounds
  const maxRounds = 10
  let roundCount = 0

  while (roundCount < maxRounds) {
    roundCount++
    console.log(`\n--- Round ${roundCount} ---`)

    let anySimUserSpoke = false

    // Each simUser replies to messages in their buffer
    for (const simUser of Object.values(simUsers)) {
      console.log(`${simUser.name} buffer length: ${simUser.messageBuffer.length}`)
      if (simUser.messageBuffer.length > 0) {
      //if (true) {
        const reply = await simUser.replyBuffer()

        if (reply) {
          console.log(`${simUser.name}: ${reply}`)
          anySimUserSpoke = true

          // Check if this reply is confirming a meeting suggestion
          if (!confirmations[simUser.name]) {
            const isConfirmation = await isConfirming(reply)
            if (isConfirmation) {
              confirmations[simUser.name] = true
              console.log(`  → Detected confirmation from ${simUser.name}`)
            }
          }

          // Send reply through local API
          const replyRes = await local_api.message.$post({
            json: {
              userId: simUser.name,
              text: reply,
              ignoreExistingTopics: !topicRouting,
              ...(topicRouting ? {} : topicIds[userGroupMapping![simUser.name]] ? { topicId: topicIds[userGroupMapping![simUser.name]]! } : {}),
            },
          })

          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to simUser buffers
            const newSuggestedEvent = await processBotMessages(replyData, simUsers)
            if (newSuggestedEvent) {
              // Determine which group this suggestion belongs to
              let targetGroup: number

              if (!topicRouting) {
                // Use userGroupMapping to determine the group
                targetGroup = userGroupMapping![simUser.name]
              } else {
                // Use topicId from response to find the group
                const responseTopicId = replyData.topicId
                if (!responseTopicId) {
                  throw new Error(`Topic routing enabled but no topicId in response for user ${simUser.name}`)
                }

                const topicIndex = topicIds.findIndex(topicId => topicId === responseTopicId)
                if (topicIndex === -1) {
                  throw new Error(`Topic routing error: topicId ${responseTopicId} not found in known topics for user ${simUser.name}`)
                }
                targetGroup = topicIndex
              }

              // Check if this is a new/different suggested event for this group
              const currentGroupEvent = suggestedEvents[targetGroup]
              if (!currentGroupEvent || newSuggestedEvent.start.getTime() !== currentGroupEvent.start.getTime() || newSuggestedEvent.end.getTime() !== currentGroupEvent.end.getTime()) {
                console.log(`  → Bot suggested new meeting for group ${targetGroup}: ${newSuggestedEvent.start.toISOString()} - ${newSuggestedEvent.end.toISOString()} (${newSuggestedEvent.summary})`)
                if (currentGroupEvent) {
                  console.log(`  → Previous meeting for group ${targetGroup} was: ${currentGroupEvent.start.toISOString()} - ${currentGroupEvent.end.toISOString()} (${currentGroupEvent.summary})`)
                  console.log(`  → Resetting confirmations for group ${targetGroup} due to meeting change`)
                  // Reset confirmations for users in this group
                  const groupUserNames = groupUserMapping[targetGroup] || []
                  groupUserNames.forEach((userName) => {
                    if (simUsers[userName]) {
                      confirmations[userName] = false
                    }
                  })
                }
                suggestedEvents[targetGroup] = newSuggestedEvent
              }
            }
          } else {
            console.error(`Failed to send reply from ${simUser.name}: ${replyRes.statusText}`)
          }
        }
      }
    }

    // Check if all simUsers in each group have confirmed their respective meetings
    let allGroupsConfirmed = true
    for (let groupIndex = 0; groupIndex < nGroups; groupIndex++) {
      if (suggestedEvents[groupIndex]) {
        const groupUserNames = groupUserMapping[groupIndex] || []
        const groupUsers = groupUserNames.map(name => simUsers[name])
        const groupConfirmed = groupUsers.every((simUser) => confirmations[simUser.name])
        if (!groupConfirmed) {
          allGroupsConfirmed = false
          break
        }
      } else {
        // If any group doesn't have a suggested event, not all groups are ready
        allGroupsConfirmed = false
        break
      }
    }

    if (allGroupsConfirmed && suggestedEvents.every((event) => event !== null)) {
      console.log('\n🎉 All simUsers in all groups have confirmed their respective meetings!')
      console.log('Ending conversation successfully.')
      break
    }

    // If no simUser spoke this round, end the conversation
    if (!anySimUserSpoke) {
      console.log('No simUsers responded. Ending conversation.')
      break
    }
  }

  if (roundCount >= maxRounds) {
    console.log(`\nReached maximum rounds (${maxRounds}). Ending conversation.`)
  }

  console.log('\n--- Conversation Complete ---')

  // Get final topic data for all groups
  const topicDatas: (TopicData | null)[] = []
  for (let i = 0; i < nGroups; i++) {
    const topicId = topicIds[i]
    if (topicId) {
      // Find a user from this specific group to query the topic
      const groupUserNames = groupUserMapping[i] || []
      const validUserName = groupUserNames.find(name => simUsers[name])
      const groupUser = validUserName ? simUsers[validUserName] : null
      if (!groupUser) {
        throw new Error(`No user found for group ${i}`)
      }

      const topicResponse = await local_api.topics[':topicId'].$get({
        param: { topicId },
        query: { visibleToUserId: groupUser.name },
      })

      if (!topicResponse.ok) {
        throw new Error(`Failed to get topic data for group ${i}`)
      }

      const topicData = unserializeTopicData((await topicResponse.json()).topicData)
      topicDatas.push(topicData)
    } else {
      // Push null for groups without topics
      topicDatas.push(null)
    }
  }

  return { topicDatas, suggestedEvents, confirmations }
}

// Main evaluation function
async function runSimpleEvaluation(): Promise<void> {
  console.log('=� Starting Simple Flack Evaluation')

  try {
    // Step 1: Parse command line arguments
    const { benchmarkSet, benchmark, nReps, topicRouting } = parseArguments()

    // Step 2: Determine what to run based on arguments
    let benchmarksToRun: string[] = []

    if (benchmark) {
      // Option 1: Run single benchmark folder from the specified benchmarkSet
      console.log(`Using single benchmark: ${benchmark} from set: ${benchmarkSet}`)
      benchmarksToRun = [`${benchmarkSet}/${benchmark}`]
    } else {
      // Option 2: Loop over all benchmarks within the benchmark set folder
      console.log(`Using benchmark set: ${benchmarkSet}`)
      benchmarksToRun = await getBenchmarksFromSet(benchmarkSet)
    }

    // Run all benchmarks
    console.log(`Running ${benchmarksToRun.length} benchmark(s) with ${nReps} repetition(s) each`)

    for (let i = 0; i < benchmarksToRun.length; i++) {
      const benchmarkName = benchmarksToRun[i]
      console.log(`\n${'='.repeat(80)}`)
      console.log(`Running benchmark ${i + 1}/${benchmarksToRun.length}: ${benchmarkName}`)
      console.log(`${'='.repeat(80)}`)

      await runRepeatedEvaluation(benchmarkName, nReps, topicRouting)
    }

    console.log(`\n✅ Completed all ${benchmarksToRun.length} benchmarks (${nReps} reps each)`)
  } catch (error) {
    console.error('\n❌ Evaluation failed:', error)
    process.exit(1)
  }
}

// Wrapper function to run repeated evaluations
async function runRepeatedEvaluation(benchmarkName: string, nReps: number, topicRouting: boolean): Promise<void> {
  const allResults: SavedEvaluationResults[] = []

  for (let rep = 1; rep <= nReps; rep++) {
    if (nReps > 1) {
      console.log(`\n--- Repetition ${rep}/${nReps} ---`)
    }
    try {
      const result = await runSingleEvaluation(benchmarkName, topicRouting)
      if (result) {
        allResults.push(result)
      }
    } catch (error) {
      console.error(`Repetition ${rep} failed:`, error)
      // Continue with other repetitions
    }
  }

  if (nReps > 1) {
    console.log(`\n✅ Completed all ${nReps} repetitions for this case`)

    // Create aggregated summary if we have multiple runs
    if (allResults.length > 1) {
      createAggregatedSummary(benchmarkName, allResults, nReps)
    }
  }
}

// Run a single evaluation for a specific benchmark folder
async function runSingleEvaluation(benchmarkName: string, topicRouting = false): Promise<SavedEvaluationResults | null> {
  try {
    // Step 1: Clear database
    await clearDatabase()

    // Step 2: Load benchmark file(s) and agents from benchmark data
    console.log('\nLoading benchmark data...')

    let nGroups: number
    let groupUserMapping: string[][]
    let simUsers: Record<string, BaseScheduleUser> = {}
    let benchmarkData: any

    // Load all JSON files from the benchmark folder
    const folderPath = join(__dirname, 'data', benchmarkName)
    if (!existsSync(folderPath)) {
      throw new Error(`Benchmark folder not found: ${benchmarkName}`)
    }

    const files = readdirSync(folderPath)
    const filesToLoad = files
      .filter(file => file.endsWith('.json'))
      .map(file => join(folderPath, file))
      .sort()

    if (filesToLoad.length === 0) {
      throw new Error(`No JSON files found in benchmark folder: ${benchmarkName}`)
    }

    console.log(`Loading benchmark data from ${filesToLoad.length} file(s)`)

    const groupData: Array<{ benchmarkData: any; simUsers: BaseScheduleUser[] }> = []

    // Load each file
    for (let i = 0; i < filesToLoad.length; i++) {
      const filePath = filesToLoad[i]
      console.log(`Loading file ${i + 1}/${filesToLoad.length}: ${filePath}`)

      const rawData = readFileSync(filePath, 'utf-8')
      const parsedData: unknown = JSON.parse(rawData)
      const groupBenchmarkData = BenchmarkFileData.parse(parsedData)
      const groupSimUsers = loadSimUsersFromBenchmarkData(groupBenchmarkData.simUsers)

      groupData.push({
        benchmarkData: groupBenchmarkData,
        simUsers: groupSimUsers,
      })

      // Add users to the dictionary, handling deduplication
      for (const simUser of groupSimUsers) {
        const existing = simUsers[simUser.name]
        if (existing) {
          const existingHasGoal = existing.goal && existing.goal.trim() !== ''
          const currentHasGoal = simUser.goal && simUser.goal.trim() !== ''

          // Error if both users have goals - this indicates a data inconsistency
          if (existingHasGoal && currentHasGoal) {
            throw new Error(`Data inconsistency: User '${simUser.name}' appears multiple times with different goals. Existing: "${existing.goal}", New: "${simUser.goal}"`)
          }

          // Keep the user with a goal, or if neither has goals, keep the first one
          if (currentHasGoal && !existingHasGoal) {
            simUsers[simUser.name] = simUser
            console.log(`  Replaced duplicate user '${simUser.name}' - keeping version with goal: "${simUser.goal}"`)
          } else if (existingHasGoal && !currentHasGoal) {
            console.log(`  Kept existing user '${simUser.name}' - has goal: "${existing.goal}"`)
          } else {
            console.log(`  Kept first version of user '${simUser.name}' (neither has goal)`)
          }
        } else {
          simUsers[simUser.name] = simUser
        }
      }
    }

    console.log(`Loaded ${Object.keys(simUsers).length} unique simUsers from ${filesToLoad.length} file(s)`)

    // Create groupUserMapping based on loaded groups
    groupUserMapping = groupData.map(group => group.simUsers.map(simUser => simUser.name))

    // Use the first group's benchmark data as the template
    benchmarkData = groupData[0].benchmarkData
    nGroups = filesToLoad.length

    console.log(`Loaded ${Object.keys(simUsers).length} total simUsers across ${nGroups} groups`)

    // Log all loaded simUsers
    Object.values(simUsers).forEach((simUser) => {
      // Find which group(s) this user belongs to
      const userGroups = groupUserMapping
        .map((userNames, groupIndex) => userNames.includes(simUser.name) ? groupIndex : -1)
        .filter(groupIndex => groupIndex !== -1)

      const groupDisplay = userGroups.length > 0 ? userGroups.join(', ') : 'unknown'
      console.log(`  - ${simUser.name} (Group ${groupDisplay}): ${simUser.calendar.length} calendar events, goal: "${simUser.goal}"`)
    })

    // Step 3: Create users in database
    console.log('\nCreating users in database...')
    await createUsersFromSimUsers(simUsers)

    // Step 4: Construct groupGoalInitializer (find the user with a goal in each group)
    const groupGoalInitializer: string[] = []
    for (let groupIndex = 0; groupIndex < nGroups; groupIndex++) {
      const groupUsers = groupUserMapping[groupIndex]
      const goalUser = groupUsers
        .map(name => simUsers[name])
        .find(user => user.goal && user.goal.trim() !== '')
      if (goalUser) {
        groupGoalInitializer.push(goalUser.name)
      } else {
        throw new Error(`No user with a goal found in group ${groupIndex}`)
      }
    }

    // Step 5: Run turn-based simulation
    const result = await simulateTurnBasedConversation(simUsers, topicRouting, nGroups, groupUserMapping, groupGoalInitializer)

    // Log conversation completion for each group
    result.topicDatas.forEach((topicData, groupIndex) => {
      if (topicData) {
        console.log(`\nGroup ${groupIndex} conversation completed with ${topicData.messages.length} messages`)
      }
    })

    // Log suggested events for each group
    result.suggestedEvents.forEach((suggestedEvent, groupIndex) => {
      if (suggestedEvent) {
        console.log(`Bot suggested meeting for group ${groupIndex}: ${suggestedEvent.start.toISOString()} - ${suggestedEvent.end.toISOString()}`)
        console.log(`Meeting summary for group ${groupIndex}: ${suggestedEvent.summary}`)
      } else {
        console.log(`No meeting was suggested by the bot for group ${groupIndex}`)
      }
    })

    // Check confirmations
    const confirmedSimUsers = Object.entries(result.confirmations).filter(([_, confirmed]) => confirmed)
    const allSimUsersConfirmed = confirmedSimUsers.length === Object.keys(simUsers).length

    console.log('\nConfirmation Status:')
    Object.entries(result.confirmations).forEach(([agentName, confirmed]) => {
      console.log(`  ${confirmed ? '✅' : '❌'} ${agentName}: ${confirmed ? 'Confirmed' : 'Not confirmed'}`)
    })

    if (allSimUsersConfirmed && confirmedSimUsers.length > 0) {
      console.log('🎉 All simUsers have confirmed the meeting suggestion!')
    } else if (confirmedSimUsers.length > 0) {
      console.log(`⚠️  Only ${confirmedSimUsers.length}/${Object.keys(simUsers).length} simUsers have confirmed`)
    } else {
      console.log('❌ No confirmations detected from any simUsers')
    }

    // Check feasibility using evalPossibility for each group
    let allWithinTimeRange = true
    const benchmark = benchmarkData.benchmark
    const benchmarkStartTime = new Date(benchmark.startTime)
    const benchmarkEndTime = new Date(benchmark.endTime)
    const groupFeasibilityResults: Array<{
      groupIndex: number
      maxSharedFreeTime: number
      hasSufficientTime: boolean
      hasSuggestedEvent: boolean
      allUsersCanAttend: boolean
      withinTimeRange: boolean
    }> = []

    result.suggestedEvents.forEach((suggestedEvent, groupIndex) => {
      console.log(`\nFeasibility Check for Group ${groupIndex}:`)

      // Get users for this group
      const groupUserNames = groupUserMapping[groupIndex] || []
      const groupUsers = groupUserNames.map(name => simUsers[name])

      // Calculate shared free time for this group regardless of whether there's a suggested event
      const commonFreeSlots = findCommonFreeTime(groupUsers, benchmarkStartTime, benchmarkEndTime)
      const groupMaxSharedFreeTime = commonFreeSlots.length > 0
        ? Math.max(...commonFreeSlots.map((slot) => slot.end.getTime() - slot.start.getTime())) / (1000 * 60) // duration in minutes
        : 0

      const hasCommonFreeTime = groupMaxSharedFreeTime >= benchmarkData.benchmark.meetingLength
      console.log(`  ${hasCommonFreeTime ? '✅' : '❌'} Common availability: ${hasCommonFreeTime ? `Max shared free time: ${groupMaxSharedFreeTime} minutes (required: ${benchmarkData.benchmark.meetingLength} minutes)` : `Insufficient shared free time: ${groupMaxSharedFreeTime} minutes (required: ${benchmarkData.benchmark.meetingLength} minutes)`}`)

      let groupWithinTimeRange = true
      let groupUsersCanAttend = true

      if (suggestedEvent) {
        // Check if meeting falls within benchmark time constraints
        const meetingStart = suggestedEvent.start
        const meetingEnd = suggestedEvent.end

        const withinTimeRange = meetingStart >= benchmarkStartTime && meetingEnd <= benchmarkEndTime
        if (!withinTimeRange) {
          allWithinTimeRange = false
          groupWithinTimeRange = false
        }
        console.log(`  ${withinTimeRange ? '✅' : '❌'} Time constraints: ${withinTimeRange ? 'Within benchmark range' : 'Outside benchmark range'}`)

        if (!withinTimeRange) {
          console.log(`    Benchmark range: ${benchmarkStartTime.toISOString()} to ${benchmarkEndTime.toISOString()}`)
          console.log(`    Suggested meeting: ${meetingStart.toISOString()} to ${meetingEnd.toISOString()}`)
        }

        // Check individual simUser availability for this group
        groupUsers.forEach((simUser) => {
          const canAttend = simUser.evalPossibility(suggestedEvent)
          console.log(`  ${canAttend ? '✅' : '❌'} ${simUser.name}: ${canAttend ? 'Available' : 'Calendar conflict'}`)
          if (!canAttend) {
            groupUsersCanAttend = false
          }
        })
      } else {
        console.log(`  ❌ No meeting suggested for group ${groupIndex}`)
      }

      groupFeasibilityResults.push({
        groupIndex,
        maxSharedFreeTime: groupMaxSharedFreeTime,
        hasSufficientTime: hasCommonFreeTime,
        hasSuggestedEvent: suggestedEvent !== null,
        allUsersCanAttend: groupUsersCanAttend,
        withinTimeRange: groupWithinTimeRange,
      })
    })

    // Overall evaluation judgment
    console.log('\n--- Overall Evaluation Judgment ---')

    // Analyze results by group - find the failing groups to determine the evaluation reason

    let evaluationSucceeded = false
    let evaluationReason = ''

    // Check if all groups that should have meetings do have them and are feasible
    const failingGroups = groupFeasibilityResults.filter((group) => {
      if (!group.hasSuggestedEvent && group.hasSufficientTime) {
        return true // Should have had a meeting but didn't
      }
      if (group.hasSuggestedEvent && (!group.hasSufficientTime || !group.allUsersCanAttend || !group.withinTimeRange)) {
        return true // Has meeting but shouldn't due to constraints
      }
      return false
    })

    if (failingGroups.length === 0) {
      // All groups are correctly handled
      evaluationSucceeded = true
      evaluationReason = 'SUCCESS: All groups correctly handled - meetings found when feasible, none when infeasible'
    } else {
      // There are failing groups - determine the primary failure reason
      const groupsWithInsufficientTime = failingGroups.filter((g) => g.hasSuggestedEvent && !g.hasSufficientTime)
      const groupsWithConflicts = failingGroups.filter((g) => g.hasSuggestedEvent && g.hasSufficientTime && !g.allUsersCanAttend)
      const groupsWithTimeRangeIssues = failingGroups.filter((g) => g.hasSuggestedEvent && !g.withinTimeRange)
      const groupsWithMissedOpportunities = failingGroups.filter((g) => !g.hasSuggestedEvent && g.hasSufficientTime)

      evaluationSucceeded = false

      if (groupsWithInsufficientTime.length > 0) {
        const failingGroup = groupsWithInsufficientTime[0]
        evaluationReason = `FAILURE: Meeting suggested for group ${failingGroup.groupIndex} when insufficient shared free time (${failingGroup.maxSharedFreeTime} min <= ${benchmarkData.benchmark.meetingLength} min)`
      } else if (groupsWithConflicts.length > 0) {
        const failingGroup = groupsWithConflicts[0]
        evaluationReason = `FAILURE: Sufficient shared free time for group ${failingGroup.groupIndex} (${failingGroup.maxSharedFreeTime} min > ${benchmarkData.benchmark.meetingLength} min) but not all users can attend suggested meeting`
      } else if (groupsWithTimeRangeIssues.length > 0) {
        const failingGroup = groupsWithTimeRangeIssues[0]
        evaluationReason = `FAILURE: Meeting suggested for group ${failingGroup.groupIndex} falls outside the specified time constraints`
      } else if (groupsWithMissedOpportunities.length > 0) {
        const failingGroup = groupsWithMissedOpportunities[0]
        evaluationReason = `FAILURE: No meeting suggested for group ${failingGroup.groupIndex} despite sufficient shared free time (${failingGroup.maxSharedFreeTime} min > ${benchmarkData.benchmark.meetingLength} min)`
      } else {
        evaluationReason = 'FAILURE: Unexpected evaluation state'
      }
    }

    console.log(`${evaluationSucceeded ? '✅' : '❌'} ${evaluationReason}`)

    // Save evaluation results
    console.log('\nSaving evaluation results...')

    // Get genTimestamp directly from benchmark data
    const genTimestamp = benchmarkData.benchmark.genTimestamp || 'unknown'

    const allUsersCanAttend = groupFeasibilityResults.every((g) => !g.hasSuggestedEvent || g.allUsersCanAttend)

    // Generate unified timestamp for this evaluation
    const evalTimestamp = formatTimestamp()

    const resultsData: SavedEvaluationResults = {
      evalTimestamp,
      benchmarkFile: benchmarkName,
      genTimestamp,
      suggestedEvents: result.suggestedEvents.map((event) => event ? {
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        summary: event.summary,
      } : null),
      confirmedSimUsers: confirmedSimUsers.map(([name]) => name),
      allSimUsersConfirmed,
      maxSharedFreeTimes: groupFeasibilityResults.map((g) => g.maxSharedFreeTime),
      allCanAttends: groupFeasibilityResults.map((g) => g.allUsersCanAttend),
      evaluationSummary: {
        totalSimUsers: Object.keys(simUsers).length,
        confirmedCount: confirmedSimUsers.length,
        hasSuggestedEvents: result.suggestedEvents.every((event) => event !== null),
        allCanAttend: allUsersCanAttend,
        withinTimeRange: allWithinTimeRange,
        evaluationSucceeded,
      },
    }

    // Create results folder
    const evalFolderPath = createResultsFolder(benchmarkName, evalTimestamp)

    // Save evaluation results
    const savedResults = saveEvaluationResults(evalFolderPath, resultsData)

    // Dump topic data for all groups to the same results folder
    console.log('\nSaving topic conversation histories...')
    for (let groupIndex = 0; groupIndex < nGroups; groupIndex++) {
      const topicData = result.topicDatas[groupIndex]
      if (topicData) {
        const topicId = topicData.topic.id
        const fullTopicData = await dumpTopic(topicId)

        // Create topic filename with group info: benchmarkFolderName_eval<timestamp>_group<index>_topic.json
        const benchmarkFolderName = benchmarkName.includes('/') ? benchmarkName.split('/').pop()! : benchmarkName
        const topicFileName = `${benchmarkFolderName}_eval${resultsData.evalTimestamp}_group${groupIndex}_topic.json`
        const topicPath = join(evalFolderPath, topicFileName)
        writeFileSync(topicPath, JSON.stringify(fullTopicData, null, 2))
        console.log(`Topic conversation history for group ${groupIndex} saved to: ${topicPath}`)
      }
    }

    console.log('\n✅ Evaluation completed successfully')
    return savedResults
  } catch (error) {
    console.error('\n❌ Evaluation failed:', error)
    return null // Return null instead of throwing to allow for graceful handling
  }
}

// Run the evaluation if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => process.nextTick(() => process.exit(1)))
  await runSimpleEvaluation()
}
