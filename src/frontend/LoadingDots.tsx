import { useState, useEffect } from 'react'

interface LoadingDotsProps {
  text: string
}

function LoadingDots({ text }: LoadingDotsProps) {
  const [dotCount, setDotCount] = useState(1)

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount(prev => prev >= 3 ? 0 : prev + 1)
    }, 500)

    return () => clearInterval(interval)
  }, [])

  const visibleDots = '.'.repeat(dotCount)
  const invisibleDots = '.'.repeat(3 - dotCount)

  return (
    <span>
      {text}
      <span>{visibleDots}</span>
      <span className="invisible">{invisibleDots}</span>
    </span>
  )
}

export default LoadingDots
