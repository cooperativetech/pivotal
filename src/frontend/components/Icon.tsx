import type { Icon as FeatherIcon } from 'react-feather'
import { cn } from '@shared/lib/utils'

type IconProps = {
  icon: FeatherIcon
  className?: string
  strokeWidth?: number
}

export function Icon({ icon: IconComponent, className, strokeWidth = 1.5 }: IconProps) {
  return (
    <IconComponent
      className={cn('text-accent', className)}
      strokeWidth={strokeWidth}
    />
  )
}
