import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import './index.css'
import App from './App.tsx'
import Home from './Home.tsx'
import Chat from './Chat.tsx'
import CreateGroupChat from './CreateGroupChat.tsx'
import { ProtectedRoute } from './ProtectedRoute.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Home />} />
          <Route path="create-chat" element={
            <ProtectedRoute>
              <CreateGroupChat />
            </ProtectedRoute>
          } />
          <Route path="chat/:chatId" element={<Chat />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
