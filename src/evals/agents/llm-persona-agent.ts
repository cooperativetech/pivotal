import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import type { PersonProfile, TimeSlot } from '../core-benchmark/generate-benchmark-data'
import { api, unserializeTopicTimestamps } from '../../shared/api-client'

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

  // Filter messages to only show what this persona has said before and bot messages
  console.log(`Total messages in topic: ${topicData.messages.length}`)
  console.log(`Messages for ${userId}:`)
  topicData.messages.forEach((msg) => {
    console.log(`  - ${msg.userId}: "${msg.text.substring(0, 50)}..." (ts: ${msg.rawTs})`)
  })

  const myPreviousMessages = topicData.messages
    .filter((msg) => msg.userId === userId || msg.userId === 'UTESTBOT')
    .sort((a, b) => Number(a.rawTs) - Number(b.rawTs))
    .map((msg) => {
      const sender = msg.userId === userId ? profile.name : 'Scheduling Bot'
      return `${sender}: ${msg.text}`
    })
    .join('\n')

  console.log(`Filtered to ${myPreviousMessages.split('\n').filter((m) => m).length} messages for context`)

  // Format calendar for context
  const calendarContext = profile.calendar.length > 0
    ? profile.calendar.map((event) => {
        // Extract times from Google Calendar format
        let startTime = '09:00'
        let endTime = '10:00'
        if (event.start.dateTime && event.end.dateTime) {
          const start = new Date(event.start.dateTime)
          const end = new Date(event.end.dateTime)
          startTime = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`
          endTime = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`
        }
        return `- ${startTime}-${endTime}: ${event.summary} (${event.type})`
      }).join('\n')
    : 'No calendar events'

  // Debug logging to understand what context each persona has
  console.log(`\n=== PERSONA CONTEXT: ${profile.name} ===`)
  console.log(`Calendar (${profile.calendar.length} events):`)
  profile.calendar.forEach((event) => {
    let startTime = '09:00'
    let endTime = '10:00'
    if (event.start.dateTime && event.end.dateTime) {
      const start = new Date(event.start.dateTime)
      const end = new Date(event.end.dateTime)
      startTime = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`
      endTime = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`
    }
    console.log(`  ${startTime}-${endTime}: ${event.summary} (${event.type})`)
  })
  console.log('\nPrevious messages in conversation:')
  console.log(myPreviousMessages || '  [No previous messages]')
  console.log('\nResponding to bot message:')
  console.log(`  "${botMessage}"`)
  console.log('===================================\n')

  const prompt = `You are ${profile.name}, a busy professional responding to a scheduling request.

Your Tuesday calendar:
${calendarContext}

Calendar priorities:
- "critical" (medical, flights, childcare): Absolutely cannot move
- "meeting": Prefer not to move but could if really needed 
- "personal" (gym, lunch, errands): Can move if necessary
- "blocked-work" (focus time): Can interrupt if needed

CRITICAL TIME LOGIC:
- If your calendar shows 12:00-14:00 busy and 15:00-16:30 busy, then 14:00-15:00 IS FREE
- Example: "12:00-14:00: Lunch" means you're busy UNTIL 14:00, so 14:00-15:00 is available
- Example: "11:00-14:00: Deep work" ends AT 14:00, so a meeting at 14:00-15:00 works perfectly

Your previous messages in this conversation:
${myPreviousMessages || 'You haven\'t responded yet.'}

Latest message from scheduling bot:
${botMessage}

IMPORTANT RULES:
- Act like a real person scheduling a meeting via chat/email
- When sharing availability, list your conflicts/free times clearly (this can take a few sentences)
- Don't repeat availability you've already shared - just say "as I mentioned" if needed
- Don't acknowledge or thank unless truly necessary
- Be direct and businesslike
- If confirming a proposed time: just say if it works or not
- If you have a conflict at a proposed time, briefly state what it is
- Focus on answering what was asked, nothing more
- NEVER echo or repeat back what the bot just said to you
- If the bot is just confirming/acknowledging, you don't need to respond unless asked a question
- If the bot says it's waiting for others, you don't need to respond
- CRITICAL: Back-to-back meetings are FINE - if one meeting ends at 14:00 and another starts at 14:00, there is NO conflict
- A time slot is only blocked if there's an actual overlap (e.g., meeting from 13:00-14:30 blocks 14:00-15:00, but 13:00-14:00 does NOT block 14:00-15:00)`

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
  const busyTimes = profile.calendar.map((e) => {
    let startTime = '09:00'
    let endTime = '10:00'
    if (e.start.dateTime && e.end.dateTime) {
      const start = new Date(e.start.dateTime)
      const end = new Date(e.end.dateTime)
      startTime = `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}`
      endTime = `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`
    }
    return `${startTime}-${endTime}`
  }).join(', ')
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
