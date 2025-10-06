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
    <div className="login-gradient flex min-h-screen w-full flex-col items-center justify-center px-6 py-24 text-foreground">
      <div className="mb-12 flex items-center gap-3 rounded-full bg-surface/60 px-5 py-3 text-sm uppercase tracking-[0.35em] text-[color:rgba(8,25,16,0.85)] shadow-sm backdrop-blur">
        <LogoMark size={48} />
        <span className="font-semibold">Pivotal</span>
      </div>
      <Card className="w-full max-w-lg border-token bg-surface/95 shadow-[0_32px_60px_-28px_rgba(13,38,24,0.65)] transition duration-300 hover:shadow-[0_38px_80px_-30px_rgba(13,38,24,0.7)] focus-within:shadow-[0_38px_80px_-30px_rgba(13,38,24,0.7)] focus-within:ring-2 focus-within:ring-accent/35">
        <CardHeader className="space-y-4 px-8 pt-10 text-center">
          <CardTitle className="text-3xl font-semibold text-foreground">Welcome back</CardTitle>
          <CardDescription className="text-base text-foreground/90">
            Sign in with Slack to step back into the Pivotal network.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 px-8 pb-10">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-base text-destructive">
              {error}
            </div>
          )}
          <Button
            onClick={() => {
              handleSlackSignIn().catch(console.error)
            }}
            disabled={loading}
            className="w-full gap-3 bg-green-600 py-4 text-base text-white transition-colors hover:bg-green-700"
            size="lg"
          >
            {loading ? (
              <>
                <LogoMark size={20} withHalo />
                Redirecting…
              </>
            ) : (
              <>
                <Slack size={20} />
                Continue with Slack
              </>
            )}
          </Button>
        </CardContent>
      </Card>
      <div className="mt-20 text-sm font-semibold uppercase tracking-[0.28em] text-[color:var(--p-root)]/80">
        A Coop.tech Product
      </div>
    </div>
  )
}
