import { io, Socket } from 'socket.io-client'
import { ChatMessage, GroupChat } from '../shared/api-types'

interface MessageReceivedData {
  message: ChatMessage
  messageType: 'group' | 'assistant'
  userName?: string
  recipientUserId?: string
}

interface UserStatusData {
  userId: string
  name: string
}

interface UserTypingData extends UserStatusData {
  isTyping: boolean
}

interface ChatJoinedData {
  chatId: string
  groupChat: GroupChat
  onlineUsers: string[]
}

type EventCallback<T = unknown> = (data?: T) => void

class SocketClient {
  private socket: Socket | null = null
  private listeners: Map<string, Set<EventCallback<unknown>>> = new Map()

  connect() {
    if (this.socket?.connected) return

    this.socket = io('http://localhost:7172', {
      transports: ['websocket'],
      autoConnect: true,
    })

    this.socket.on('connect', () => {
      console.log('Socket connected')
      this.emit('connected')
    })

    this.socket.on('disconnect', () => {
      console.log('Socket disconnected')
      this.emit('disconnected')
    })

    this.socket.on('error', ({ message }: { message: string }) => {
      console.error('Socket error:', message)
      this.emit('error', message)
    })

    this.socket.on('chat:joined', (data: ChatJoinedData) => {
      this.emit('chat:joined', data)
    })

    this.socket.on('message:received', (data: MessageReceivedData) => {
      this.emit('message:received', data)
    })

    this.socket.on('user:joined', (data: UserStatusData) => {
      this.emit('user:joined', data)
    })

    this.socket.on('user:left', (data: UserStatusData) => {
      this.emit('user:left', data)
    })

    this.socket.on('user:typing', (data: UserTypingData) => {
      this.emit('user:typing', data)
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  joinChat(chatId: string, userId: string, userName: string, userEmail: string) {
    if (!this.socket?.connected) {
      throw new Error('Socket not connected')
    }

    // No authentication - just send user info directly
    this.socket.emit('chat:join', {
      chatId,
      userId,
      userName,
      userEmail,
    })
  }

  sendMessage(chatId: string, text: string, messageType: 'group' | 'assistant') {
    if (!this.socket?.connected) {
      throw new Error('Socket not connected')
    }

    this.socket.emit('message:send', {
      chatId,
      text,
      messageType,
    })
  }

  sendTypingStatus(chatId: string, isTyping: boolean) {
    if (!this.socket?.connected) return

    this.socket.emit('message:typing', {
      chatId,
      isTyping,
    })
  }

  on(event: string, callback: EventCallback<unknown>) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)
  }

  off(event: string, callback: EventCallback<unknown>) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.delete(callback)
    }
  }

  private emit(event: string, data?: unknown) {
    const callbacks = this.listeners.get(event)
    if (callbacks) {
      callbacks.forEach(callback => callback(data))
    }
  }
}

export const socketClient = new SocketClient()