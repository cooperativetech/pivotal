import { Outlet, Link } from 'react-router'
import { useAuth } from './auth-context'

function App() {
  const { session } = useAuth()

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {session && (
        <nav className="flex-shrink-0 bg-white shadow-sm border-b border-gray-200 px-4 py-2">
          <div className="w-full flex justify-between items-center">
            <Link to="/" className="text-xl font-bold text-gray-800">
              Pivotal
            </Link>
            <div className="flex items-center gap-4">
              <span className="text-gray-600">Welcome, {session.user.name}</span>
              <Link
                to="/profile"
                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Profile
              </Link>
            </div>
          </div>
        </nav>
      )}
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  )
}

export default App
