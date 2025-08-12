import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import type { PersonProfile, TimeSlot } from '../core-benchmark/generate-benchmark-data'
import { api, unserializeTopicTimestamps } from '../api-client'
import { organizeMessagesByChannelAndThread } from '../../utils'

// Initialize OpenRouter with API key from environment
const apiKey = process.env.PV_OPENROUTER_API_KEY
if (!apiKey) {
  throw new Error('PV_OPENROUTER_API_KEY environment variable is required')
}
const openrouter = createOpenRouter({
  apiKey,
})

const MODEL = 'google/gemini-2.5-flash'

// LLM persona that responds to scheduling requests based on their calendar
export async function llmPersonaRespond(
  topicId: string,
  userId: string,
  profile: PersonProfile,
  botMessage: string,
  timestamp: string,
): Promise<string> {
  // Fetch topic data from API
  const topicResponse = await api.topics[':topicId'].$get({
    param: { topicId },
    query: { visibleToUserId: userId, beforeRawTs: timestamp },
  })

  if (!topicResponse.ok) {
    throw new Error(`Failed to get topic data: ${topicResponse.statusText}`)
  }

  const topicData = unserializeTopicTimestamps(await topicResponse.json())

  // Create user map for organizeMessagesByChannelAndThread
  const userMap = new Map<string, string>()
  topicData.users.forEach((user: { id: string; realName?: string | null }) => {
    userMap.set(user.id, user.realName || user.id)
  })

  // Get conversation history using organizeMessagesByChannelAndThread
  const conversationHistory = organizeMessagesByChannelAndThread(topicData.messages, userMap)
  // Format calendar for context
  const calendarContext = profile.calendar.length > 0
    ? profile.calendar.map((event) =>
        `- ${event.start}-${event.end}: ${event.description} (${event.type})`,
      ).join('\n')
    : 'No calendar events'

  const prompt = `You are ${profile.name}, responding to a scheduling request.

Your Tuesday calendar:
${calendarContext}

Calendar event types and how you feel about scheduling over them:
- "critical" (medical, flights, childcare): NEVER available, will strongly refuse
- "meeting": Try to avoid but could reschedule if really needed
- "personal" (gym, lunch, errands): Prefer not to but flexible if necessary
- "blocked-work" (focus time): Can interrupt if needed but not ideal

Conversation so far:
${conversationHistory}

Latest message from scheduling bot:
${botMessage}

Respond naturally as ${profile.name} would, mentioning specific conflicts if the bot proposes times that overlap with your calendar. Be conversational but concise. If you have a conflict, explain what it is. If you're free, confirm availability.`

  // Retry up to 3 times if we get empty responses
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await generateText({
        model: openrouter(MODEL),
        prompt,
        maxTokens: 2048,
        temperature: 0.7,
      })
      const responseText = result.text.trim()

      if (responseText) {
        return responseText
      }

      console.error(`Empty response for ${profile.name} (attempt ${attempt}/3). Full result:`, JSON.stringify(result, null, 2))

      if (attempt < 3) {
        console.log(`Retrying for ${profile.name} after 1 second...`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) {
      console.error(`Error generating response for ${profile.name} (attempt ${attempt}/3):`, error)

      if (attempt < 3) {
        console.log(`Retrying for ${profile.name} after 1 second...`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  // After 3 attempts, give a proper response based on their calendar
  console.error(`Failed after 3 attempts for ${profile.name}. Generating fallback based on calendar.`)

  // Generate a simple response based on their actual calendar
  const busyTimes = profile.calendar.map((e) => `${e.start}-${e.end}`).join(', ')
  if (busyTimes) {
    return `Hi! On Tuesday I have conflicts at: ${busyTimes}. Any other time should work for me.`
  } else {
    return `Hi! I'm completely free on Tuesday, so any time works for me.`
  }
}

// Extract final meeting time from bot's confirmation message
export async function extractScheduledTime(botMessage: string): Promise<TimeSlot | null> {
  const prompt = `Extract the final scheduled meeting time from this bot message.

Bot message:
"${botMessage}"

If the message confirms a specific meeting time, extract it and return in this exact format:
START: HH:MM
END: HH:MM

If no specific time is confirmed, return:
NO_TIME_FOUND

Only return the time extraction, nothing else.`

  try {
    const result = await generateText({
      model: openrouter(MODEL),
      prompt,
      maxTokens: 50,
      temperature: 0,
    })

    const response = result.text.trim()

    // Parse the response
    if (response === 'NO_TIME_FOUND' || !response.includes('START:')) {
      return null
    }

    const startMatch = response.match(/START:\s*(\d{1,2}:\d{2})/)
    const endMatch = response.match(/END:\s*(\d{1,2}:\d{2})/)

    if (startMatch && endMatch) {
      return {
        start: startMatch[1],
        end: endMatch[1],
      }
    }

    return null
  } catch (error) {
    console.error('Error extracting time:', error)
    return null
  }
}
