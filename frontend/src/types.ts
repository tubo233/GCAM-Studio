export interface Profile {
  id: string
  name: string
  description?: string
  base_config?: string
  created_at?: string
  updated_at?: string
  overlay_files?: number
  builds?: number
  runs?: number
  tags?: string[]
  active?: boolean
}

export interface CatalogFile {
  id: string
  path: string
  module: string
  module_label: string
  subdir?: string
  name: string
  title: string
  units?: string
  description?: string
  columns: string[]
  column_types?: string
  rows: number
  size: number
  china_relevant: boolean
  file_type: 'csv' | 'xlsx'
  year_columns?: string[]
  long_format?: boolean
  key_columns?: string[]
}

export interface XmlItem {
  id: string
  kind: 'xml' | 'policy' | 'extra'
  path: string
  name: string
  category: string
  scenario_name?: string
  size: number
}

export interface QueryItem {
  id: string
  title: string
  tag: string
  group: string
  groups: string[]
}

export interface Job {
  id: string
  kind: string
  title: string
  status: string
  progress: number
  logs?: string[]
  result?: any
  error?: string
}

export interface RunInfo {
  stage?: string
  run_id: string
  profile_id: string
  scenario_name?: string
  status?: string
  created_at?: string
  elapsed_sec?: number
  db?: string
  config?: string
  log?: string
  run_dir?: string
  validation_only?: boolean
  stop_year?: number
  calculated_through?: number
  error?: string
}

export interface FileInfo {
  kind: string
  path: string
  resolved_path: string
  is_overlay: boolean
  title: string
  units: string
  description: string
  columns: string[]
  column_types: Record<string, string>
  key_columns: string[]
  year_columns: string[]
  long_format: boolean
  rows: number
  size: number
  diff_count: number
}
