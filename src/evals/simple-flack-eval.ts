#!/usr/bin/env node
import { readFileSync } from 'fs'
import { join } from 'path'
import { BaseScheduleUser } from './agents/user-agents'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'

// Load benchmark data and create BaseScheduleUser agents using import functionality
function loadAgentsFromBenchmarkData(): BaseScheduleUser[] {
  const dataPath = join(__dirname, 'data', 'benchmark-2ppl-medbusy.json')
  const rawData = readFileSync(dataPath, 'utf-8')
  const benchmarkData = JSON.parse(rawData)
  
  return benchmarkData.map((personData: any) => {
    return BaseScheduleUser.import(personData)
  })
}

// Process bot message responses and add them to appropriate agent buffers
async function processBotMessage(messageResult: any, agents: BaseScheduleUser[]): Promise<void> {
  if (!messageResult.resMessages || !Array.isArray(messageResult.resMessages)) {
    return
  }

  // Process each bot response message
  for (const resMessage of messageResult.resMessages) {
    console.log(`Bot response: "${resMessage.text}"`)
    
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
async function simulateTurnBasedConversation(agents: BaseScheduleUser[]): Promise<TopicData> {
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
  await processBotMessage(initResData, agents)

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
            json: { userId: agent.name, text: reply },
          })
          
          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to agent buffers
            await processBotMessage(replyData, agents)
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

  return unserializeTopicData(await topicResponse.json())
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

    // Step 3: Run turn-based simulation
    const topicData = await simulateTurnBasedConversation(agents)
    console.log(`\nConversation completed with ${topicData.messages.length} messages`)

    // TODO: Add scoring/evaluation logic

    console.log('\n Evaluation completed successfully')
  } catch (error) {
    console.error('\nL Evaluation failed:', error)
    process.exit(1)
  }
}

// Run the evaluation if called directly
if (require.main === module) {
  runSimpleEvaluation()
}