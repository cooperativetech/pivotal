import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { Chat as ChatType, ChatMessage, GroupChat, User } from '../shared/api-types'
import { useAuth } from './useAuth'
import ChatBox from './ChatBox'
import { socketClient } from './socket-client'

interface OnlineUser {
  id: string
  name: string
}

interface TypingUser {
  userId: string
  name: string
}

function Chat() {
  const { chatId } = useParams<{ chatId: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [chat, setChat] = useState<ChatType | null>(null)
  const [groupMessages, setGroupMessages] = useState<ChatMessage[]>([])
  const [assistantMessages, setAssistantMessages] = useState<ChatMessage[]>([])
  const [onlineUsers, setOnlineUsers] = useState<string[]>([])
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingUser>>(new Map())
  const [participants, setParticipants] = useState<OnlineUser[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!user || !chatId) return

    // Connect to socket server
    socketClient.connect()

    // Socket event listeners
    const handleConnected = () => {
      setIsConnected(true)
      setError(null)
      // Join the chat room
      try {
        socketClient.joinChat(
          chatId, 
          user.id, 
          user.name || user.email, 
          user.email,
        )
      } catch (err) {
        console.error('Failed to join chat:', err)
        setError('Failed to join chat')
      }
    }

    const handleDisconnected = () => {
      setIsConnected(false)
    }

    const handleError = (message: string) => {
      setError(message)
    }

    const handleChatJoined = ({ chatId: joinedChatId, groupChat, onlineUsers }: { chatId: string, groupChat: GroupChat, onlineUsers: string[] }) => {
      if (joinedChatId !== chatId) return
      
      // Load existing messages
      setGroupMessages(groupChat.groupChatHistory || [])
      const userMessages = groupChat.individualChatHistory[user.id] || []
      setAssistantMessages(userMessages)
      setOnlineUsers(onlineUsers)
    }

    const handleMessageReceived = ({ message, messageType, recipientUserId }: { message: ChatMessage, messageType: 'group' | 'assistant', recipientUserId?: string }) => {
      if (messageType === 'group') {
        setGroupMessages(prev => [...prev, message])
      } else if (messageType === 'assistant') {
        // For assistant messages, check if this message is for the current user
        if (message.userId === user.id || (message.userId === 'assistant' && (!recipientUserId || recipientUserId === user.id))) {
          setAssistantMessages(prev => [...prev, message])
        }
      }
    }

    const handleUserJoined = ({ userId }: { userId: string }) => {
      setOnlineUsers(prev => [...prev, userId])
    }

    const handleUserLeft = ({ userId }: { userId: string }) => {
      setOnlineUsers(prev => prev.filter(id => id !== userId))
      setTypingUsers(prev => {
        const newMap = new Map(prev)
        newMap.delete(userId)
        return newMap
      })
    }

    const handleUserTyping = ({ userId, name, isTyping }: { userId: string, name: string, isTyping: boolean }) => {
      setTypingUsers(prev => {
        const newMap = new Map(prev)
        if (isTyping && userId !== user.id) {
          newMap.set(userId, { userId, name })
        } else {
          newMap.delete(userId)
        }
        return newMap
      })
    }

    // Register event listeners
    socketClient.on('connected', handleConnected)
    socketClient.on('disconnected', handleDisconnected)
    socketClient.on('error', handleError)
    socketClient.on('chat:joined', handleChatJoined)
    socketClient.on('message:received', handleMessageReceived)
    socketClient.on('user:joined', handleUserJoined)
    socketClient.on('user:left', handleUserLeft)
    socketClient.on('user:typing', handleUserTyping)

    // Cleanup
    return () => {
      socketClient.off('connected', handleConnected)
      socketClient.off('disconnected', handleDisconnected)
      socketClient.off('error', handleError)
      socketClient.off('chat:joined', handleChatJoined)
      socketClient.off('message:received', handleMessageReceived)
      socketClient.off('user:joined', handleUserJoined)
      socketClient.off('user:left', handleUserLeft)
      socketClient.off('user:typing', handleUserTyping)
      socketClient.disconnect()
    }
  }, [chatId, user])

  // Fetch chat details and participants
  useEffect(() => {
    if (!chatId) return

    const fetchChat = async () => {
      try {
        const response = await fetch(`/api/chats/${chatId}`, {
          credentials: 'include',
        })
        if (!response.ok) {
          throw new Error('Failed to fetch chat')
        }
        const chatData = await response.json() as ChatType
        setChat(chatData)

        // Fetch user details for all participants
        const usersResponse = await fetch('/api/users', {
          credentials: 'include',
        })
        if (!usersResponse.ok) {
          throw new Error('Failed to fetch users')
        }
        const allUsers = await usersResponse.json() as User[]
        
        const chatParticipants = chatData.groupChat.userIds.map((userId: string) => {
          const userInfo = allUsers.find((u) => u.id === userId)
          return {
            id: userId,
            name: userInfo?.name || userInfo?.email || 'Unknown User',
          }
        })
        
        if (user) {
          // Add current user if not in the list
          const currentUserInList = chatParticipants.find((p: OnlineUser) => p.id === user.id)
          if (!currentUserInList) {
            chatParticipants.push({
              id: user.id,
              name: user.name || user.email,
            })
          }
        }
        
        setParticipants(chatParticipants)
      } catch (err) {
        console.error('Failed to fetch chat:', err)
        setError('Failed to load chat')
      }
    }

    void fetchChat()
  }, [chatId, user])

  const handleSendGroupMessage = (text: string) => {
    if (!user || !isConnected) return
    
    try {
      socketClient.sendMessage(chatId!, text, 'group')
      // Clear typing indicator
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
      socketClient.sendTypingStatus(chatId!, false)
    } catch (err) {
      console.error('Failed to send message:', err)
      setError('Failed to send message')
    }
  }

  const handleSendAssistantMessage = async (text: string) => {
    if (!user || !isConnected) return
    
    try {
      // Send message via socket for real-time update
      socketClient.sendMessage(chatId!, text, 'assistant')
      
      // Also call the API endpoint to trigger takeAction
      const response = await fetch(`/api/chats/${chatId}/assistant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ message: text }),
      })

      if (!response.ok) {
        throw new Error('Failed to send message to AI')
      }

      // AI responses will be delivered through socket events
    } catch (err) {
      console.error('Failed to send message:', err)
      setError('Failed to send message')
    }
  }

  const handleTyping = (isTyping: boolean) => {
    if (!isConnected) return

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    socketClient.sendTypingStatus(chatId!, isTyping)

    // Auto-stop typing after 3 seconds
    if (isTyping) {
      typingTimeoutRef.current = setTimeout(() => {
        socketClient.sendTypingStatus(chatId!, false)
      }, 3000)
    }
  }

  if (!user || !chat) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>
  }

  // Format typing indicator
  const typingText = Array.from(typingUsers.values())
    .map(u => u.name)
    .join(', ')
  const typingIndicator = typingText ? `${typingText} ${typingUsers.size === 1 ? 'is' : 'are'} typing...` : ''

  return (
    <div className="h-screen flex flex-col">
      <header className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">{chat.name}</h1>
            <p className="text-sm text-gray-600 mt-1">{chat.groupChat.publicContext}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600">
              {onlineUsers.length} online
            </div>
            <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <button
              onClick={() => { void navigate('/') }}
              className="text-gray-600 hover:text-gray-800"
            >
              Back
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-2 text-sm text-red-600">{error}</div>
        )}
      </header>
      
      <div className="flex-1 flex gap-4 p-6 bg-gray-50 overflow-hidden">
        <div className="flex-1 flex flex-col">
          <ChatBox
            title="Group Chat"
            messages={groupMessages}
            currentUserId={user.id}
            onSendMessage={handleSendGroupMessage}
            participants={participants}
            onTyping={handleTyping}
          />
          {typingIndicator && (
            <div className="text-sm text-gray-500 italic mt-1">{typingIndicator}</div>
          )}
        </div>
        
        <div className="flex-1">
          <ChatBox
            title="AI Assistant"
            messages={assistantMessages}
            currentUserId={user.id}
            onSendMessage={(text) => { void handleSendAssistantMessage(text) }}
            participants={[{ id: 'assistant', name: 'AI Assistant' }]}
          />
        </div>
      </div>
    </div>
  )
}

export default Chat