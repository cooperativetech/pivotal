import type { MouseEvent } from 'react'
import type { RefObject } from 'react'
import { cn } from '@shared/lib/utils'

export interface TimelineEntry {
  id: string
  timestamp: Date | string
  text: string
}

interface TimelineProps {
  entries: TimelineEntry[]
  position: number | null
  disabled?: boolean
  isDragging: boolean
  thumbPulse: boolean
  timelineRef: RefObject<HTMLDivElement | null>
  onTrackClick: (event: MouseEvent<HTMLDivElement>) => void
  onDragStart: (event: MouseEvent<HTMLDivElement>) => void
  className?: string
}

export function Timeline({
  entries,
  position,
  disabled = false,
  isDragging,
  thumbPulse,
  timelineRef,
  onTrackClick,
  onDragStart,
  className,
}: TimelineProps) {
  if (entries.length === 0) return null

  const totalSegments = Math.max(entries.length - 1, 1)

  return (
    <div
      ref={timelineRef}
      className={cn(
        'relative h-12 select-none rounded-full border border-token/60 bg-[radial-gradient(circle_at_center,var(--p-leaf)/16,transparent_78%)] px-6',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
      onClick={onTrackClick}
      onMouseDown={onDragStart}
    >
      <div
        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[color:rgba(95,115,67,0.28)]"
        style={{ left: 'var(--spacing-container)', right: 'var(--spacing-container)' }}
      />

      {entries.map((entry, index) => {
        const positionPercent = 2 + (index / totalSegments) * 96
        const isActive = position !== null && index <= position
        const isCurrent = index === position

        const dotStyle = isCurrent
          ? { backgroundColor: 'var(--p-leaf)', boxShadow: '0 0 0 4px rgba(95,115,67,0.28)' }
          : isActive
          ? { backgroundColor: 'rgba(95,115,67,0.75)' }
          : { backgroundColor: 'rgba(95,115,67,0.35)' }

        const date = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : entry.timestamp
        const tooltip = `${date.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        })} - ${entry.text.substring(0, 50)}...`

        return (
          <div
            key={entry.id}
            className="absolute top-1/2 -translate-y-1/2"
            style={{ left: `${positionPercent}%` }}
          >
            <div className="h-2 w-2 -translate-x-1/2 rounded-full transition-all" style={dotStyle} title={tooltip} />
          </div>
        )
      })}

      {position !== null && (
        <div
          className="absolute top-1/2 -translate-y-1/2 transition-none"
          style={{ left: `${2 + (position / totalSegments) * 96}%` }}
        >
          <div
            className={cn(
              'h-6 w-6 -translate-x-1/2 cursor-grab rounded-full border-2 border-background shadow-lg transition',
              isDragging ? 'scale-110 cursor-grabbing' : '',
              thumbPulse ? 'animate-timeline-pulse' : '',
            )}
            style={{ backgroundColor: 'var(--p-leaf)', boxShadow: '0 0 18px rgba(95,115,67,0.4)' }}
          />
        </div>
      )}
    </div>
  )
}
