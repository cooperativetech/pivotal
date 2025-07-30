import { useState } from 'react'
import { ChatMessage } from '../shared/api-types'

interface ChatBoxProps {
  title: string
  messages: ChatMessage[]
  currentUserId: string
  onSendMessage: (message: string) => void
  participants?: { id: string, name: string }[]
  onTyping?: (isTyping: boolean) => void
}

function ChatBox({ title, messages, currentUserId, onSendMessage, participants, onTyping }: ChatBoxProps) {
  const [inputValue, setInputValue] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (inputValue.trim()) {
      onSendMessage(inputValue)
      setInputValue('')
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)
    
    // Notify typing status
    if (onTyping) {
      onTyping(value.length > 0)
    }
  }

  const getUserName = (userId: string) => {
    if (userId === 'assistant') return 'AI Assistant'
    const participant = participants?.find(p => p.id === userId)
    return participant?.name || 'Unknown User'
  }

  return (
    <div className="flex flex-col h-full border rounded-lg bg-white shadow-sm">
      <div className="px-4 py-3 border-b bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((message, index) => {
          const isCurrentUser = message.userId === currentUserId
          return (
            <div
              key={index}
              className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[70%] rounded-lg px-4 py-2 ${
                  isCurrentUser
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                {!isCurrentUser && (
                  <div className="text-xs font-medium mb-1 opacity-70">
                    {getUserName(message.userId)}
                  </div>
                )}
                <div className="break-words">{message.text}</div>
                <div className={`text-xs mt-1 ${
                  isCurrentUser ? 'text-blue-100' : 'text-gray-500'
                }`}>
                  {new Date(message.createdAt).toLocaleTimeString()}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      
      <form onSubmit={handleSubmit} className="border-t p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

export default ChatBox