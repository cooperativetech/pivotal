import { useLocation } from 'react-router'

/**
 * Hook to detect if we're in local/testing mode (under /local/* routes)
 * Returns true when user is accessing Flack testing interface
 */
export function useLocalMode(): boolean {
  const location = useLocation()
  return location.pathname.startsWith('/local')
}