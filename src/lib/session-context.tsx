import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'

const SessionUsernameContext = createContext<string | null>(null)

export function SessionUsernameProvider({
  username,
  children,
}: {
  username: string | null
  children: ReactNode
}) {
  return (
    <SessionUsernameContext.Provider value={username}>
      {children}
    </SessionUsernameContext.Provider>
  )
}

export function useSessionUsername(): string | null {
  return useContext(SessionUsernameContext)
}
