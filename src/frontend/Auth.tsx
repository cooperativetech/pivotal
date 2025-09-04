import { useState } from 'react'
import { authClient } from '../shared/auth-client'

export default function Auth() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSlackSignIn = async () => {
    setError('')
    setLoading(true)
    try {
      await authClient.signIn.social({
        provider: 'slack',
        callbackURL: '/',
      })
    } catch (err) {
      setError('Failed to continue with Slack')
      console.error(err)
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 p-4">
      <div className="bg-white rounded-lg p-8 shadow-lg w-full max-w-md">
        <h1 className="text-center mb-6 text-2xl font-semibold text-gray-900">Welcome to Pivotal</h1>
        {error && <div className="text-red-600 bg-red-50 p-3 rounded mb-4 text-center">{error}</div>}
        <button
          onClick={() => { handleSlackSignIn().catch(console.error) }}
          disabled={loading}
          className="w-full p-3 bg-purple-700 text-white rounded font-medium hover:bg-purple-800 disabled:bg-gray-400 disabled:cursor-not-allowed mb-4"
        >
          {loading ? 'Redirecting…' : 'Continue with Slack'}
        </button>
        <p className="text-center text-gray-600 text-sm">Slack access is required to use Pivotal.</p>
      </div>
    </div>
  )
}
