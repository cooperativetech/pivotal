import { Link, Outlet, useLocation } from 'react-router'
import { LogIn, User } from 'react-feather'
import { useAuth } from './auth-context'
import { Button } from '@shared/components/ui/button'
import { LogoMark } from '@shared/components/logo-mark'

const navItems = [
  { href: '/', label: 'Topics' },
  { href: '/company', label: 'Company', requireSession: true },
  { href: '/profile', label: 'Profile', requireSession: true },
]

function App() {
  const { session } = useAuth()
  const location = useLocation()

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="border-b border-token bg-sidebar/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-10">
          <Link to="/" className="flex items-center gap-3 text-sm font-medium uppercase tracking-[0.35em] text-sidebar-foreground">
            <LogoMark size={32} className="shadow-sm" />
            <span>Pivotal</span>
          </Link>
          <nav className="hidden items-center gap-2 sm:flex">
            {navItems.map((item) => {
              if (item.requireSession && !session) return null
              const isActive = location.pathname === item.href
              return (
                <Button
                  key={item.href}
                  asChild
                  variant={isActive ? 'secondary' : 'ghost'}
                  className={isActive ? 'bg-secondary/70 text-secondary-foreground' : 'text-sidebar-foreground'}
                >
                  <Link to={item.href}>{item.label}</Link>
                </Button>
              )
            })}
          </nav>
          <div className="flex items-center gap-2">
            {session ? (
              <Button asChild variant="ghost" className="flex items-center gap-2 text-sidebar-foreground">
                <Link to="/profile">
                  <User size={16} />
                  <span className="hidden sm:inline">{session.user.name.split(' ')[0]}</span>
                </Link>
              </Button>
            ) : (
              <Button asChild variant="default" className="bg-primary text-primary-foreground">
                <Link to="/login" className="flex items-center gap-2">
                  <LogIn size={16} />
                  <span>Sign in</span>
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-background">
        <Outlet />
      </main>
    </div>
  )
}

export default App
