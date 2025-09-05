#!/usr/bin/env node
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { BaseScheduleUser } from './agents/user-agents'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'

// Initialize OpenRouter with API key from environment
const apiKey = process.env.PV_OPENROUTER_API_KEY
if (!apiKey) {
  throw new Error('PV_OPENROUTER_API_KEY environment variable is required')
}
const openrouter = createOpenRouter({
  apiKey,
})

const MODEL = 'google/gemini-2.5-flash'

// Load benchmark data and create BaseScheduleUser agents using import functionality
function loadAgentsFromBenchmarkData(): BaseScheduleUser[] {
  const dataPath = join(__dirname, 'data', 'benchmark-2ppl-medbusy.json')
  const rawData = readFileSync(dataPath, 'utf-8')
  const benchmarkData = JSON.parse(rawData)
  
  return benchmarkData.map((personData: any) => {
    return BaseScheduleUser.import(personData)
  })
}

// Create all server-side users based on agents
async function createUsersFromAgents(agents: BaseScheduleUser[]): Promise<Map<string, BaseScheduleUser>> {
  const usersToCreate = agents.map((agent) => ({
    id: agent.name,
    realName: agent.name,
    isBot: false,
  }))
  
  const userAgentMap = new Map<string, BaseScheduleUser>()
  agents.forEach((agent) => userAgentMap.set(agent.name, agent))

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

  return userAgentMap
}

// Extract suggested meeting time using LLM
async function extractSuggestedTimeWithLLM(messageText: string): Promise<Date | null> {
  try {
    const currentDate = new Date()
    const currentDateString = currentDate.toISOString().split('T')[0] // YYYY-MM-DD format
    const currentYear = currentDate.getFullYear()
    const currentMonth = currentDate.toLocaleString('en-US', { month: 'long' })
    
    const result = await generateText({
      model: openrouter(MODEL),
      prompt: `Analyze this message and determine if it contains a suggestion for a specific meeting time. If it does, extract the suggested time in ISO 8601 format (YYYY-MM-DDTHH:MM:SS±HH:MM). If no specific meeting time is suggested, respond with "NONE".
      For context, today is ${currentDateString} (${currentMonth} ${currentYear}).

      Message: "${messageText}"

      Response format:
      - If a meeting time is suggested: Return just the ISO 8601 timestamp
      - If no meeting time is suggested: Return "NONE"`,
    })

    const response = result.text.trim()
    
    if (response === 'NONE' || response.toLowerCase() === 'none') {
      return null
    }

    // Try to parse the extracted time
    const extractedDate = new Date(response)
    if (isNaN(extractedDate.getTime())) {
      console.warn(`Failed to parse extracted time: ${response}`)
      return null
    }

    return extractedDate
  } catch (error) {
    console.error('Error extracting suggested time with LLM:', error)
    return null
  }
}

// Process bot message responses and add them to appropriate agent buffers
async function processBotMessages(messageResult: any, agents: BaseScheduleUser[]): Promise<Date | null> {
  if (!messageResult.resMessages || !Array.isArray(messageResult.resMessages)) {
    return null
  }

  let suggestedTime: Date | null = null

  // Process each bot response message
  for (const resMessage of messageResult.resMessages) {
    console.log(`Bot response: "${resMessage.text}"`)
    
    // Extract suggested time from this message using LLM
    if (!suggestedTime) {
      const extractedTime = await extractSuggestedTimeWithLLM(resMessage.text)
      if (extractedTime) {
        suggestedTime = extractedTime
        console.log(`Extracted suggested time: ${suggestedTime.toISOString()}`)
      }
    }
    
    try {
      // Get channel information to determine which agents should receive this message
      const channelRes = await local_api.channels[':channelId'].$get({
        param: { channelId: resMessage.channelId },
      })
      
      if (!channelRes.ok) {
        console.error(`Failed to get channel info: ${resMessage.channelId}`)
        // Fallback: send to all agents if we can't get channel info
        for (const agent of agents) {
          agent.receive(resMessage.text)
        }
        continue
      }

      const { userIds } = await channelRes.json()
      
      // Only send message to agents whose names match the channel userIds
      for (const agent of agents) {
        if (userIds.includes(agent.name)) {
          agent.receive(resMessage.text)
        }
      }
    } catch (error) {
      console.error(`Error processing bot message for channel ${resMessage.channelId}:`, error)
      // Fallback: send to all agents if there's an error
      for (const agent of agents) {
        agent.receive(resMessage.text)
      }
    }
  }

  return suggestedTime
}

// Clear database before starting evaluation
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

// Simulate a strict turn-based scheduling conversation
async function simulateTurnBasedConversation(agents: BaseScheduleUser[]): Promise<{ topicData: TopicData; suggestedTime: Date | null }> {
  console.log('\n' + '='.repeat(60))
  console.log('Starting Turn-Based Scheduling Conversation')
  console.log('='.repeat(60))

  if (agents.length === 0) {
    throw new Error('No agents provided for conversation')
  }

  // Log all agents
  agents.forEach((agent, index) => {
    console.log(`Agent ${index + 1}: ${agent.name} - Goal: "${agent.goal}"`)
  })

  // Start conversation: First agent sends initial message through API
  console.log('\n--- Starting Conversation ---')
  const firstAgent = agents[0]
  const initialMessage = await firstAgent.send_initial_message()
  
  if (!initialMessage) {
    console.log(`${firstAgent.name} has no initial message to send`)
    throw new Error('First agent must have an initial message to start conversation')
  }

  console.log(`${firstAgent.name}: ${initialMessage}`)

  // Send initial message through local API
  const initMessageRes = await local_api.message.$post({
    json: { userId: firstAgent.name, text: initialMessage },
  })
  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId

  console.log(`Created topic: ${topicId}`)

  // Process initial bot responses
  let suggestedTime = await processBotMessages(initResData, agents)

  // Run turn-based conversation for up to 10 rounds
  const maxRounds = 10
  let roundCount = 0
  
  while (roundCount < maxRounds) {
    roundCount++
    console.log(`\n--- Round ${roundCount} ---`)
    
    let anyAgentSpoke = false
    
    // Each agent replies to messages in their buffer
    for (const agent of agents) {
      if (agent.message_buffer.length > 0) {
        const reply = await agent.reply_buffer()
        
        if (reply) {
          console.log(`${agent.name}: ${reply}`)
          anyAgentSpoke = true
          
          // Send reply through local API
          const replyRes = await local_api.message.$post({
            json: { userId: agent.name, text: reply , topicId: topicId},
          })
          
          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to agent buffers
            const newSuggestedTime = await processBotMessages(replyData, agents)
            if (newSuggestedTime && !suggestedTime) {
              suggestedTime = newSuggestedTime
            }
          } else {
            console.error(`Failed to send reply from ${agent.name}: ${replyRes.statusText}`)
          }
        }
      }
    }
    
    // If no agent spoke this round, end the conversation
    if (!anyAgentSpoke) {
      console.log('No agents responded. Ending conversation.')
      break
    }
  }
  
  if (roundCount >= maxRounds) {
    console.log(`\nReached maximum rounds (${maxRounds}). Ending conversation.`)
  }

  console.log('\n--- Conversation Complete ---')
  
  // Get final topic data
  const topicResponse = await local_api.topics[':topicId'].$get({
    param: { topicId },
    query: { visibleToUserId: firstAgent.name },
  })

  if (!topicResponse.ok) {
    throw new Error('Failed to get final topic data')
  }

  const topicData = unserializeTopicData(await topicResponse.json())
  return { topicData, suggestedTime }
}

// Main evaluation function
async function runSimpleEvaluation(): Promise<void> {
  console.log('=� Starting Simple Flack Evaluation')

  try {
    // Step 1: Clear database
    await clearDatabase()

    // Step 2: Load agents from benchmark data
    console.log('\nLoading agents from benchmark data...')
    const agents = loadAgentsFromBenchmarkData()
    console.log(`Loaded ${agents.length} agents:`)
    agents.forEach((agent) => {
      console.log(`  - ${agent.name}: ${agent.calendar.length} calendar events, goal: "${agent.goal}"`)
    })

    // Step 3: Create users in database
    console.log('\nCreating users in database...')
    const userAgentMap = await createUsersFromAgents(agents)

    // Step 4: Run turn-based simulation
    const result = await simulateTurnBasedConversation(agents)
    console.log(`\nConversation completed with ${result.topicData.messages.length} messages`)
    
    if (result.suggestedTime) {
      console.log(`Bot suggested meeting time: ${result.suggestedTime.toISOString()}`)
    } else {
      console.log('No meeting time was suggested by the bot')
    }

    // TODO: Add scoring/evaluation logic

    console.log('\n Evaluation completed successfully')
  } catch (error) {
    console.error('\nL Evaluation failed:', error)
    process.exit(1)
  }
}

// Run the evaluation if called directly
if (import.meta.main) {
  runSimpleEvaluation()
}