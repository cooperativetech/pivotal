import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Slack } from 'react-feather'
import { authClient } from '@shared/api-client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/components/ui/card'
import { Button } from '@shared/components/ui/button'
import { LogoMark } from '@shared/components/logo-mark'

export default function Login() {
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [searchParams] = useSearchParams()

  const handleSlackSignIn = async () => {
    setError('')
    setLoading(true)
    try {
      const redirectTo = searchParams.get('redirectTo')
      const callbackURL = redirectTo === 'googleAuthorize' ? '/api/google/authorize' : undefined

      await authClient.signIn.social({ provider: 'slack', callbackURL })
    } catch (err) {
      setError('Failed to continue with Slack')
      console.error(err)
      setLoading(false)
    }
  }

  return (
    <div className="login-gradient flex min-h-screen w-full flex-col items-center justify-center px-4 py-16 text-foreground">
      <div className="mb-8 flex items-center gap-3 rounded-full bg-surface/60 px-4 py-2 text-xs uppercase tracking-[0.35em] text-[color:rgba(8,25,16,0.85)] shadow-sm backdrop-blur">
        <LogoMark size={40} />
        <span className="font-semibold">Pivotal</span>
      </div>
      <Card className="w-full max-w-md border-token bg-surface/90 shadow-lg transition duration-300 hover:shadow-xl focus-within:shadow-xl focus-within:ring-2 focus-within:ring-accent/40">
        <CardHeader className="space-y-3 text-center">
          <CardTitle className="text-2xl font-semibold text-foreground">Welcome back</CardTitle>
          <CardDescription className="text-sm text-foreground/90">
            Sign in with Slack to step back into the Pivotal network.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button
            onClick={() => {
              handleSlackSignIn().catch(console.error)
            }}
            disabled={loading}
            className="w-full bg-primary text-primary-foreground transition-colors hover:bg-[#d46245]"
            size="lg"
          >
            {loading ? (
              <>
                <LogoMark size={18} withHalo />
                Redirecting…
              </>
            ) : (
              <>
                <Slack size={18} />
                Continue with Slack
              </>
            )}
          </Button>
        </CardContent>
      </Card>
      <div className="mt-16 text-xs font-semibold uppercase tracking-[0.25em] text-[color:var(--p-root)]/80">
        A Cooperative.tech Product
      </div>
    </div>
  )
}
