import React from 'react'
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import AppLayout from './layout/AppLayout'
import { ProfileProvider } from './context/ProfileContext'
import Dashboard from './pages/Dashboard'
import Profiles from './pages/Profiles'
import ParameterHub from './pages/ParameterHub'
import ConfigEditor from './pages/ConfigEditor'
import Runs from './pages/Runs'
import Results from './pages/Results'
import Settings from './pages/Settings'
import { isLocalConsole } from './localAccess'

function LegacyRedirect({
  target,
  preset,
}: {
  target: string
  preset?: Record<string, string> | ((params: URLSearchParams) => Record<string, string>)
}) {
  const [searchParams] = useSearchParams()
  const next = new URLSearchParams(searchParams)
  const extra = typeof preset === 'function' ? preset(searchParams) : preset
  if (extra) {
    Object.entries(extra).forEach(([k, v]) => next.set(k, v))
  }
  const qs = next.toString()
  return <Navigate to={qs ? `${target}?${qs}` : target} replace />
}

export default function App() {
  return (
    <ProfileProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/scenario" element={<ConfigEditor />} />
          <Route path="/model-config" element={<ConfigEditor />} />
          <Route path="/parameters" element={<ParameterHub />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/results" element={<Results />} />
          <Route path="/settings" element={isLocalConsole() ? <Settings /> : <Navigate to="/" replace />} />

          {/* 无损兼容旧路径 */}
          <Route path="/policy" element={<LegacyRedirect target="/scenario" preset={{ openPolicy: '1' }} />} />
          <Route
            path="/parameter-table"
            element={<LegacyRedirect target="/parameters" preset={(p) => ({ tab: p.has('file') ? 'csv' : 'xml' })} />}
          />
          <Route path="/data" element={<LegacyRedirect target="/parameters" preset={{ tab: 'csv' }} />} />
          <Route path="/xml" element={<LegacyRedirect target="/parameters" preset={{ tab: 'raw-xml' }} />} />
          <Route path="/compare" element={<LegacyRedirect target="/results" preset={{ tab: 'compare' }} />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ProfileProvider>
  )
}
