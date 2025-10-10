import { Agent, run } from '../agent-sdk'
import type { SimpleCalendarEvent } from '../../evals/sim-users'
import type { HistoryMessage } from '../../evals/utils'
import { formatCalendarEvents } from '../../evals/utils'

const generateReplyAgent = new Agent({
  name: 'GenerateReplyAgent',
  // model: 'google/gemini-2.5-flash',
  model: 'anthropic/claude-4.5-sonnet', // fallback if gemini doesn't work well
  modelSettings: {
    temperature: 0.8,
  },
  instructions: `You are a reply generation agent. Given a user's context (name, goal, calendar, message history), generate a natural and professional reply to the latest message.

Guidelines:
- Be brief and professional
- Consider the user's calendar when discussing scheduling
- Stay true to the user's goal and personality - NEVER deviate from specified time constraints
- Respond naturally to the conversation context
- Keep responses concise (1-2 sentences typically)
- If the user has time constraints in their goal, they must STRICTLY follow them and reject any meeting times outside those bounds`,
})

export async function generateReply(userName: string, goal: string, calendar: SimpleCalendarEvent[], messageBuffer: string[], history: HistoryMessage[]): Promise<string> {
  if (messageBuffer.length === 0) {
    return ''
  }

  const latestMessage = messageBuffer[messageBuffer.length - 1]

  // Format calendar using helper function
  const calendarText = formatCalendarEvents(calendar)

  // Format conversation history
  const historyText = history.length > 0
    ? history.map((h) => `${h.sender === 'bot' ? 'Bot' : userName}: ${h.message}`).join('\n')
    : 'No previous conversation'

  const goalContext = goal && goal.trim() !== '' ? `Your goal is: ${goal}\n\nIMPORTANT: You MUST strictly adhere to your goal's time constraints. NEVER accept or agree to any meeting time that falls outside the specific timeframe mentioned in your goal. If a time is suggested outside your constraints, politely decline and redirect to times within your specified range.\n\n` : ''
  const prompt = `You are ${userName}. You are engaged in a scheduling conversation mediated by a bot named Pivotal. ${goalContext}Your calendar: ${calendarText}

Conversation history:
${historyText}

Current messages to respond to: ${messageBuffer.join(' | ')}

Respond naturally to: "${latestMessage}"

CRITICAL RULES:
1. If you have a goal with specific time constraints, NEVER accept meetings outside those times
2. Do NOT offer to schedule an appointment when there is a calendar conflict
3. DO accept meetings that are adjacent to existing appointments without time overlap (i.e., a meeting can start immediately when another ends, or end immediately before another starts)
4. If a suggested time violates your goal's timeframe, politely decline and suggest alternative times within your constraints
5. When providing your availability in response to a scheduling request, ONLY mention times that fall within the originally requested time range - do not suggest times outside the specified window

Generate only the reply text, nothing else.`

  try {
    const result = await run(generateReplyAgent, prompt)
    return result.finalOutput?.trim() || 'Sure, let me check my calendar and get back to you.'
  } catch (error) {
    console.error('Error generating reply:', error)
    return 'I unfortunately can\'t access my calendar.'
  }
}
