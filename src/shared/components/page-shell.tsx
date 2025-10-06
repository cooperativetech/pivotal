import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils'

type PageShellProps = {
  children: ReactNode
  className?: string
  padded?: boolean
  showCanopy?: boolean
}

export function PageShell({ children, className, padded = true, showCanopy = true }: PageShellProps) {
  return (
    <div className={cn('min-h-screen w-full bg-background text-foreground', className)}>
      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col">
        {showCanopy && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 opacity-80 [background:radial-gradient(circle_at_top,var(--p-leaf)_0%,transparent_65%)]"
          />
        )}
        <div className={cn('flex flex-1 flex-col', padded && 'px-4 py-6 sm:px-6 lg:px-10 lg:py-12')}>{children}</div>
      </div>
    </div>
  )
}
