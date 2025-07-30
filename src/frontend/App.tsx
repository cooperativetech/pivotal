import { Outlet } from 'react-router'
import { AuthProvider } from './AuthContext'

function App() {
  return (
    <AuthProvider>
      <div className="app">
        <Outlet />
      </div>
    </AuthProvider>
  )
}

export default App
