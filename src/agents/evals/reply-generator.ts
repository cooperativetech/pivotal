import { Agent, run } from '../agent-sdk'
import type { SimpleCalendarEvent } from '../../evals/sim-users'
import type { HistoryMessage } from '../../evals/utils'
import { formatCalendarEvents } from '../../evals/utils'

const generateReplyAgent = new Agent({
  name: 'GenerateReplyAgent',
  // model: 'google/gemini-2.5-flash',
  model: 'anthropic/claude-sonnet-4', // fallback if gemini doesn't work well
  modelSettings: {
    temperature: 0.8,
  },
  instructions: `You are a reply generation agent. Given a user's context (name, goal, calendar, message history), generate a natural and professional reply to the latest message.

Guidelines:
- Be brief and professional
- Consider the user's calendar when discussing scheduling
- Stay true to the user's goal and personality
- Respond naturally to the conversation context
- Keep responses concise (1-2 sentences typically)`,
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

  const goalContext = goal && goal.trim() !== '' ? `Your goal is: ${goal}\nDo NOT accept any meetings outside of this timeframe.\n\n` : ''
  const prompt = `You are ${userName}. You are engaged in a scheduling conversation mediated by a bot named Pivotal. ${goalContext}Your calendar: ${calendarText}

Conversation history:
${historyText}

Current messages to respond to: ${messageBuffer.join(' | ')}

Respond naturally to: "${latestMessage}"

Do NOT offer to schedule an appointment when you have a meeting, but DO accept meetings close to scheduled slots that don't overlap. Generate only the reply text, nothing else.`

  try {
    const result = await run(generateReplyAgent, prompt)
    return result.finalOutput?.trim() || 'Sure, let me check my calendar and get back to you.'
  } catch (error) {
    console.error('Error generating reply:', error)
    return 'I unfortunately can\'t access my calendar.'
  }
}