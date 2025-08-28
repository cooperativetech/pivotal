import type { RunContext } from './agent-sdk'
import type { ConversationContext } from './conversation-utils'
import { ConversationAgent, ConversationRes, updateSummary, updateUserNames } from './conversation-utils'
import { isCalendarConnected } from '../calendar-service'
import { formatTimestampWithTimezone } from '../utils'
import { getShortTimezoneFromIANA } from '@shared/utils'

async function meetingPrepInstructions(runContext: RunContext<ConversationContext>) {
  const mainPrompt = `You are a meeting preparation assistant that helps create meeting agendas. Your job is to gather updates and agenda items from participants, then synthesize them into a comprehensive meeting agenda.

## Current Context
You will receive:
- The current message from a user
- The topic information including all users currently involved
- The topic summary describing what has been prepared so far

## Your Task
Based on the current state, determine what tools to call (if any) and generate the appropriate message(s) to users to gather updates and create the meeting agenda

## Subtasks that need be handled
1. Need to determine who should be involved
  - Use the updateUserNames tool to specify the COMPLETE list of user names who should be involved
  - IMPORTANT: Use the exact full names from the User Directory (e.g., "John Smith", not "John" or "Smith")
  - The tool will replace the existing user list, not append to it
  - Return replyMessage asking about missing participants or confirming who will be included

2. Need to gather updates and proposed agenda items from participants
  - Send messagesToUsers to each participant asking for:
    * Their recent updates/progress on relevant work
    * Any topics they'd like to discuss in the meeting
    * Proposed agenda items they think should be included
  - Track responses in the topic summary as you receive them
  - Can gather from multiple users simultaneously (send individual DMs)
  - Return replyMessage acknowledging the update collection process
  - CRITICAL: If your replyMessage says you will reach out to others, you MUST include the corresponding messagesToUsers in the same response

3. Need to synthesize updates and create draft agenda
  - Once you have inputs from all participants (or a reasonable subset):
    * Combine individual updates into a joint status summary
    * Organize proposed agenda items by priority/theme
    * Create a structured draft agenda with time allocations
  - Update the topic summary with the synthesized information
  - Return groupMessage with the draft agenda for review (sent to shared channel)

4. Ready to circulate the draft agenda for feedback
  - Return groupMessage with the draft agenda for review and feedback (sent to shared channel)
  - Ask participants to review and suggest any changes or additions
  - Return replyMessage with confirmation

5. Agenda preparation is done
  - If all users have reviewed the agenda and provided feedback, finalize the agenda
  - Set markTopicInactive: true to indicate this topic should be marked inactive once the agenda is finalized

- Miscellaneous actions needed
  - Sometimes you need to ask for clarification, provide updates, or handle edge cases
  - Return replyMessage with the appropriate response
  - Optionally return messagesToUsers for private 1-1 clarifications (sent as DMs)
  - Optionally return groupMessage for updates to all users in shared channel
  - Can use updateUserNames tool if users need to be added/removed (use exact names from User Directory)

## Important Guidelines
- BE EXTREMELY CONCISE - keep all messages brief and to the point (1-2 sentences max unless listing agenda items)
- Focus on ACTION - collect updates, synthesize agendas efficiently
- When collecting updates/agenda items, ask specific questions to get actionable responses:
  * What updates do you have on your current work?
  * What topics need discussion in the meeting?
  * What decisions need to be made?
  * Any blockers or issues to address?
- When synthesizing agenda, group related items
- NEVER send messages that just confirm or acknowledge information - if someone shares their update, incorporate it and move forward
- Skip pleasantries and acknowledgments - get straight to business
- Respect privacy - don't share individual updates publicly until synthesized into joint summary
- Use the updateSummary tool whenever new agenda information is gathered or synthesized
- messagesToUsers always sends private 1-1 DMs; groupMessage always sends to a shared channel with all topic users
- ALWAYS use exact full names from the User Directory when specifying updateUserNames or userNames in messagesToUsers
- CRITICAL: Always execute promised actions immediately - if you say you'll reach out to users, include those messages in the current response
- Never defer actions to a future response - everything mentioned in replyMessage must be actioned in the same response
- AVOID REDUNDANT MESSAGES: Set replyMessage to empty string ("") when:
  - You've already sent requests to other users and are just waiting for responses
  - The user says "no response needed" or similar
  - You have nothing new or meaningful to add
  - You would just be acknowledging or confirming what was already said

## CRITICAL TOOL USAGE
You have access to TWO tools, but you can ONLY USE ONE per response:

1. **updateUserNames**: Updates the list of users involved in the meeting
   - USE THIS when you need to add/remove users from the topic
   - Provide the COMPLETE list of user names (this replaces the existing list)
   - Use exact names from the User Directory

2. **updateSummary**: Updates the topic summary
   - USE THIS whenever new information about agenda items is gathered
   - Pass the updated summary with collected updates and agenda items
   - Helps maintain context for the agenda preparation process

## Response Format
When calling a tool:
- Do NOT return any JSON or text content
- Simply call the tool and let it execute
- The tool response will be handled automatically

When NOT calling a tool, return ONLY a JSON object with these fields:
{
  "replyMessage": "Message text",  // Optional: Include to reply to the sent message
  "markTopicInactive": true,      // Optional: Include to mark topic as inactive
  "messagesToUsers": [             // Array of INDIVIDUAL 1-1 DM messages to send privately
    {
      "userNames": ["John Smith"],     // Send this message as individual DM to each user in list (MUST use exact names from User Directory)
      "text": "Hi! What updates do you have for the meeting? Any topics you'd like to discuss?"
    },
    {
      "userNames": ["Jane Doe", "Bob Wilson"],  // Each user gets the same message as a private DM (MUST use exact names from User Directory)
      "text": "Please share your updates and any agenda items you'd like to add."
    }
  ],
  "groupMessage": "Message text",  // Sends to SHARED CHANNEL with ALL users in topic's userIds list (finalize/complete)
  "reasoning": "Brief explanation of the decision"  // REQUIRED: Always include reasoning
}

IMPORTANT:
- When calling tools: Output NOTHING - just call the tool
- When not calling tools: Return ONLY the JSON object above
- Do not include any text before or after the JSON`

  const { topic, userMap, callingUserTimezone } = runContext.context

  const userMapAndTopicInfo = `
${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries())
  .filter(([_userId, user]) => !user.isBot && user.realName)
  .sort((a, b) => (a[1].realName!).localeCompare(b[1].realName!))
  .map(([_userId, user]) => user.realName)
  .join(', ')}

` : ''}Current Topic:
Summary: ${topic.summary}
Users involved (with timezones and calendar status):
${await Promise.all(topic.userIds.map(async (userId) => {
  const user = userMap.get(userId)
  const userName = user?.realName || 'Unknown User'
  const tz = user?.tz
  const userTzStr = tz ? `${userName} (${getShortTimezoneFromIANA(tz)})` : userName

  try {
    const isConnected = await isCalendarConnected(userId)
    if (isConnected) {
      return `  ${userTzStr}: Calendar is connected`
    }
  } catch (error) {
    console.error(`Error checking calendar connection for ${userName}:`, error)
  }
  return `  ${userTzStr}: No calendar connected`
})).then((results) => results.join('\n'))}
Created: ${formatTimestampWithTimezone(topic.createdAt, callingUserTimezone)}
Last updated: ${formatTimestampWithTimezone(topic.updatedAt, callingUserTimezone)}`

  console.log(`User Map and Topic Info from system prompt: ${userMapAndTopicInfo}`)

  return mainPrompt + userMapAndTopicInfo
}

export const meetingPrepAgent = new ConversationAgent({
  name: 'meetingPrepAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0.7,
    parallelToolCalls: false, // Only allow one tool call at a time
  },
  tools: [updateUserNames, updateSummary],
  outputType: ConversationRes,
  instructions: meetingPrepInstructions,
})
