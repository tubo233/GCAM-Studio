import axios from 'axios'

export const http = axios.create({ baseURL: '', timeout: 600000 })

export type ApiResult<T = any> = { ok: boolean; data: T; [k: string]: any }

export async function apiGet<T = any>(url: string, params?: any): Promise<T> {
  const r = await http.get<ApiResult<T>>(url, { params })
  return r.data.data
}

export async function apiPost<T = any>(url: string, body?: any): Promise<T> {
  const r = await http.post<ApiResult<T>>(url, body ?? {})
  return r.data.data
}

export async function apiPut<T = any>(url: string, body?: any): Promise<T> {
  const r = await http.put<ApiResult<T>>(url, body ?? {})
  return r.data.data
}

export async function apiPatch<T = any>(url: string, body?: any): Promise<T> {
  const r = await http.patch<ApiResult<T>>(url, body ?? {})
  return r.data.data
}

export async function apiDelete<T = any>(url: string): Promise<T> {
  const r = await http.delete<ApiResult<T>>(url)
  return r.data.data
}

export function fmtSize(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
