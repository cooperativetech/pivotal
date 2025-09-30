import { Agent, run } from '../agent-sdk'

const sendInitialMessageAgent = new Agent({
  name: 'SendInitialMessageAgent',
  // model: 'google/gemini-2.5-flash',
  model: 'anthropic/claude-sonnet-4', // fallback if gemini doesn't work well
  modelSettings: {
    temperature: 0.7,
  },
  instructions: `You are an initial message generation agent. Generate a brief, natural initial message for a user to request help from the Pivotal scheduling bot.

Guidelines:
- Be natural and professional
- Keep it brief and to the point
- Make it clear what kind of help is needed
- Address the bot directly
- Generate only the message text, nothing else`,
})

export async function generateInitialMessage(userName: string, goal: string): Promise<string> {
  if (!goal || goal.trim() === '') {
    return ''
  }

  const prompt = `You are ${userName}. Your goal is: ${goal}

Generate a brief initial message to request the Pivotal bot to help. Be natural and professional.

Generate only the message text, nothing else.`

  try {
    const result = await run(sendInitialMessageAgent, prompt)
    return result.finalOutput?.trim() || `Hi, I'd like to ${goal.toLowerCase()}.`
  } catch (error) {
    console.error('Error generating initial message:', error)
    return `Hi, I'd like to ${goal.toLowerCase()}.`
  }
}