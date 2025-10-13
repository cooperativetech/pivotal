import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'

type ChatCompletionCreateParamsWithCacheControl = Omit<ChatCompletionCreateParams, 'messages'> & {
  messages: Array<ChatCompletionMessageParam & {
    cache_control?: { type: string }
  }>
}

export const PROMPT_CACHE_BOUNDARY = '---CACHE-BOUNDARY---'

export const customFetch: typeof fetch = async (url, init) => {
  if (!init) {
    return fetch(url, init)
  }
  const llmParams = JSON.parse(init.body as string) as ChatCompletionCreateParamsWithCacheControl

  // Check for system message
  const systemMessages = llmParams.messages.filter((m) => m.role === 'system')
  if (systemMessages.length !== 1) {
    console.error(`Expected exactly one system message during llm fetch call, but found ${systemMessages.length}`)
    throw new Error()
  }
  if (llmParams.messages[0] !== systemMessages[0]) {
    console.error('Expected system message to be first message of llmParams.messages')
    throw new Error()
  }

  // For anthropic models, add cache_control property for the system prompt, and
  // up to the last two user or tool messages
  if (llmParams.model.startsWith('anthropic/')) {
    llmParams.messages[0].cache_control = { type: 'ephemeral' }
    const userOrToolMessages = llmParams.messages.filter((m) => m.role === 'user' || m.role === 'tool')
    for (const message of userOrToolMessages.slice(-2)) {
      message.cache_control = { type: 'ephemeral' }
    }
  }

  // Handle PROMPT_CACHE_BOUNDARY
  const systemContent = llmParams.messages[0].content as string
  const boundaryCount = (systemContent.match(new RegExp(PROMPT_CACHE_BOUNDARY, 'g')) || []).length
  if (boundaryCount === 1) {
    if (llmParams.model.startsWith('anthropic/')) {
      // For anthropic models, split into two system messages with cache_control
      const [part1, part2] = systemContent.split(PROMPT_CACHE_BOUNDARY)
      const originalMessage = llmParams.messages[0]
      llmParams.messages[0] = { ...originalMessage, content: part1 }
      llmParams.messages.splice(1, 0, { ...originalMessage, content: part2 })
    } else {
      // For non-anthropic models, just remove the boundary string
      llmParams.messages[0].content = systemContent.replace(PROMPT_CACHE_BOUNDARY, '')
    }
  } else if (boundaryCount > 1) {
    console.error(`Expected at most one PROMPT_CACHE_BOUNDARY in system message, but found ${boundaryCount}`)
    throw new Error()
  }

  init.body = JSON.stringify(llmParams)
  return fetch(url, init)
}
