import LoadingDots from './LoadingDots'
import { } from '../shared/api-types'
import { AuthForm } from './AuthForm'
import { authClient } from './auth-client'
import { useAuth } from './useAuth'
import { Link } from 'react-router'

function Home() {
  const { user, loading, refetchUser } = useAuth()

  const handleLogout = async () => {
    await authClient.signOut()
    await refetchUser()
  }

  if (loading) {
    return <LoadingDots text="Loading" />
  }

  return (
    <div>
      {user ? (
        <div className="max-w-2xl mx-auto my-8 p-8 text-center">
          <h1 className="text-3xl font-semibold mb-4">Welcome, {user.name}!</h1>
          <p className="text-gray-600 mb-8">You are logged in as {user.email}</p>
          <div className="flex gap-4 justify-center items-center">
            <Link
              to="/create-chat"
              className="px-6 py-3 bg-blue-600 text-white font-medium rounded-md hover:bg-blue-700 transition-colors no-underline"
            >
              Create Group Chat
            </Link>
            <button
              onClick={() => void handleLogout()}
              className="px-6 py-3 bg-gray-600 text-white font-medium rounded-md hover:bg-gray-700 transition-colors"
            >
              Log Out
            </button>
          </div>
        </div>
      ) : (
        <AuthForm onSuccess={() => void refetchUser()} />
      )}
    </div>
  )
}

export default Home
