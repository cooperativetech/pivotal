import { useState } from 'react'
import { useNavigate, Link } from 'react-router'
import { authClient } from '../shared/auth-client'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const result = await authClient.signIn.email({
        email,
        password,
      })

      if (result.error) {
        setError(result.error.message || 'Login failed')
      } else {
        (async () => {
          try {
            await navigate('/')
          } catch (err) {
            console.error('Navigation failed:', err)
          }
        })().catch(console.error)
      }
    } catch (err) {
      setError('An unexpected error occurred')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleFormSubmit = (e: React.FormEvent) => {
    handleSubmit(e).catch((err) => {
      console.error('Form submission failed:', err)
      setError('Form submission failed')
    })
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>Sign In</h1>
        <form onSubmit={handleFormSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <p>
          Don&apos;t have an account? <Link to="/register">Register here.</Link>
        </p>
      </div>
    </div>
  )
}