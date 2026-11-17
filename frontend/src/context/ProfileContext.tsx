import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiGet } from '../api'
import type { Profile } from '../types'

interface ProfileCtx {
  profiles: Profile[]
  activeId: string
  active?: Profile
  loading: boolean
  reload: () => Promise<void>
  setActiveId: (id: string) => void
}

const Ctx = createContext<ProfileCtx>({
  profiles: [],
  activeId: '',
  loading: false,
  reload: async () => {},
  setActiveId: () => {},
})

const KEY = 'gcam-studio-active-profile'

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [activeId, setActiveIdState] = useState<string>(localStorage.getItem(KEY) || '')
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await apiGet<Profile[]>('/api/profiles')
      setProfiles(list)
      if (!list.find((p) => p.id === activeId) && list.length) {
        const id = list[0].id
        setActiveIdState(id)
        localStorage.setItem(KEY, id)
      }
    } finally {
      setLoading(false)
    }
  }, [activeId])

  useEffect(() => {
    reload()
  }, [])

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id)
    localStorage.setItem(KEY, id)
  }, [])

  const active = useMemo(() => profiles.find((p) => p.id === activeId), [profiles, activeId])

  return <Ctx.Provider value={{ profiles, activeId, active, loading, reload, setActiveId }}>{children}</Ctx.Provider>
}

export function useProfiles() {
  return useContext(Ctx)
}
