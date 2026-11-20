import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from './layout/AppLayout'
import { ProfileProvider } from './context/ProfileContext'
import Dashboard from './pages/Dashboard'
import Profiles from './pages/Profiles'
import ParameterTable from './pages/ParameterTable'
import Parameters from './pages/Parameters'
import DataFiles from './pages/DataFiles'
import XmlBrowser from './pages/XmlBrowser'
import ConfigEditor from './pages/ConfigEditor'
import PolicyStudio from './pages/PolicyStudio'
import Runs from './pages/Runs'
import Results from './pages/Results'
import Compare from './pages/Compare'
import Settings from './pages/Settings'
import { isLocalConsole } from './localAccess'

export default function App() {
  return (
    <ProfileProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/parameter-table" element={<ParameterTable />} />
          <Route path="/parameters" element={<Parameters />} />
          <Route path="/data" element={<DataFiles />} />
          <Route path="/xml" element={<XmlBrowser />} />
          <Route path="/model-config" element={<ConfigEditor />} />
          <Route path="/policy" element={<PolicyStudio />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/results" element={<Results />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/settings" element={isLocalConsole() ? <Settings /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ProfileProvider>
  )
}
