import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import './index.css'
import App from './App.tsx'
import Home from './Home.tsx'
import Topic from './Topic.tsx'
import TopicCreation from './TopicCreation.tsx'
import Login from './Login.tsx'
import Register from './Register.tsx'
import Profile from './Profile.tsx'
import { AuthProvider } from './AuthContext.tsx'
import ProtectedRoute from './ProtectedRoute.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<App />}>
            <Route index element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            } />
            <Route path="profile" element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            } />
            <Route path="topic/:topicId" element={
              <ProtectedRoute>
                <Topic />
              </ProtectedRoute>
            } />
            <Route path="create-topic" element={
              <ProtectedRoute>
                <TopicCreation />
              </ProtectedRoute>
            } />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
)
