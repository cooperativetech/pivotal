import { z } from 'zod'

export const CreateQuizReq = z.strictObject({
  url: z.string(),
})
export type CreateQuizReq = z.infer<typeof CreateQuizReq>

export const ChatMessage = z.strictObject({
  userId: z.string(),
  text: z.string(),
  createdAt: z.string(),
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const ChatHistory = z.array(ChatMessage)
export type ChatHistory = z.infer<typeof ChatHistory>

export const GroupChat = z.strictObject({
  userIds: z.array(z.string()),
  publicContext: z.string(),
  groupChatHistory: ChatHistory,
  individualChatHistory: z.record(z.string(), ChatHistory),
})
export type GroupChat = z.infer<typeof GroupChat>

export const User = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string(),
})
export type User = z.infer<typeof User>

export const GetUsersResponse = z.array(User)
export type GetUsersResponse = z.infer<typeof GetUsersResponse>

export const CreateChatRequest = z.strictObject({
  name: z.string(),
  selectedUserIds: z.array(z.string()),
  publicContext: z.string().optional(),
})
export type CreateChatRequest = z.infer<typeof CreateChatRequest>

export const Chat = z.strictObject({
  id: z.string(),
  name: z.string(),
  groupChat: GroupChat,
  createdAt: z.string(),
})
export type Chat = z.infer<typeof Chat>

export const CreateChatResponse = Chat
export type CreateChatResponse = z.infer<typeof CreateChatResponse>
