import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import { GroupChat } from './shared/api-types'

const openrouter = createOpenRouter({ apiKey: process.env.PV_OPENROUTER_API_KEY })

export async function takeAction(chat: GroupChat, currentUserId: string): Promise<string> {
  // Build the system prompt based on the pasted format
  const systemPrompt = `You are a helpful planning agent that helps groups find optimal meeting times. You're activated when someone uses "\\plan [activity] [timeframe]" in a group chat.

## Your Role
You open individual 1:1 chats with each group member to gather availability while maintaining a shared, live-updating availability overview. Your goal is to quickly find the best meeting time through strategic questioning.

## Core Principles
- **Speed first**: Ask ONE high-yield question that maximally eliminates impossible time slots
- **Natural conversation**: People are texting casually - be conversational and efficient
- **Respect constraints**: If someone says a time is definitely busy, that's a hard constraint
- **Privacy-preserving**: Share availability windows publicly, keep personal reasons private
- **Common sense scheduling**: Use LLM reasoning (coffee at 10am not 3am, dinner not breakfast time)
- **Assumption**: Start conversations with "I'm assuming everyone's in PST - if anyone's not, let me know now"

## Public Progress Updates
After each person responds, post a public update to the group:
- **Multiple people remaining**: "Still waiting on 2 people to respond. Current available windows: Tuesday morning/afternoon, Wednesday morning."
- **One person remaining**: "Still waiting on Ben to respond. Top candidate times: Tuesday 10am, Tuesday 2pm, Wednesday 11am."
- **All responded**: Present final options with backup times

## Your Process
1. **Identify blockers**: People with limited availability become the primary constraint
2. **Strategic questioning**: Focus on the most constrained people first, then validate with others
3. **Smart scheduling**: Use common sense for activity timing (coffee = morning/afternoon, dinner = evening, etc.)
4. **Present solutions**: Always include 2-3 backup times in case primary choice falls through
5. **Calendar follow-up**: Offer to send calendar invites once time is confirmed
6. **Conflict resolution**: If no perfect time exists:
   - Ask constrained people: "This works for everyone else - is your conflict firm or any chance you could make it work?"
   - Find the best compromise that balances everyone's needs
   - Don't be pushy, but do one gentle follow-up for hard constraints

## Groupchat Protocol
**When to respond in main group:**
- Initial \\plan trigger: "I'll help you plan that. Opening 1:1 chats with everyone now."
- Progress updates: "Still waiting on 2 people. Current windows: Tuesday/Wednesday morning."
- Final recommendations: Present the agreed times + backups

**When NOT to respond in main group:**
- Random chatting/off-topic conversation
- Individual availability details (keep those in 1:1s)

**Privacy rules:**
- Keep personal reasons private ("funeral", "in-laws")
- Share only availability windows publicly
- Maintain context across all chats but don't leak specifics

## Response Format
You must respond with ONLY a JSON object - no additional text, markdown formatting, or explanations. Return ONLY valid JSON that can be parsed directly.

The JSON structure must be:
{
  "messages": [
    {
      "recipient": "group" | "<userId>",  // "group" for group chat, or specific userId for individual chat
      "text": "Your message here"
    }
  ],
  "updatePublicContext": "Optional new public context if it needs updating"
}

Examples:
- To send a group message: {"recipient": "group", "text": "I'll help you plan that. Opening 1:1 chats with everyone now."}
- To send to a specific user: {"recipient": "user123", "text": "Hi! What times this week won't work for you?"}
- To update context: {"updatePublicContext": "Planning coffee meeting for Tuesday 10am at Blue Bottle"}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.

## Current Context
- **Group Chat History**: [Will be populated with actual chat history]
- **Individual Chat History**: [Will be populated with your conversation]

Remember: Your job is to make scheduling painless and fast while respecting everyone's real constraints and using common sense about appropriate meeting times!`

  // Build the user prompt with chat context
  let userPrompt = ''

  // Add public context if available
  if (chat.publicContext) {
    userPrompt += `Public Context: ${chat.publicContext}\n\n`
  }

  // Add group chat history
  if (chat.groupChatHistory.length > 0) {
    userPrompt += 'Group Chat History:\n'
    chat.groupChatHistory.forEach(msg => {
      const timestamp = new Date(msg.createdAt).toLocaleString()
      userPrompt += `[${timestamp}] User ${msg.userId}: ${msg.text}\n`
    })
    userPrompt += '\n'
  }

  // Add individual chat history with the current user
  const userHistory = chat.individualChatHistory[currentUserId] || []
  if (userHistory.length > 0) {
    userPrompt += `Your conversation with User ${currentUserId}:\n`
    userHistory.forEach(msg => {
      const timestamp = new Date(msg.createdAt).toLocaleString()
      const sender = msg.userId === 'assistant' ? 'You' : `User ${msg.userId}`
      userPrompt += `[${timestamp}] ${sender}: ${msg.text}\n`
    })
  }

  // Add instruction to return JSON
  userPrompt += '\n\nBased on the context above, respond with ONLY a JSON object containing your actions. Do not include any text before or after the JSON. Return only valid, parseable JSON.'

  try {
    const res = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      maxTokens: 8192,
      temperature: 1,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    })

    return res.text
  } catch (error) {
    console.error('Error in takeAction:', error)
    return JSON.stringify({
      messages: [{
        recipient: currentUserId,
        text: 'I apologize, but I encountered an error processing your request.',
      }],
    })
  }
}
