/**
 * 舆情预警联动的本地持久化：独立于通用 CRUD 的 localStorage 键，
 * 所有写操作都经 service 层以「整份领域状态一次写入」提交，保证事务性。
 */
import { applyMigrations } from './migration'
import { buildInitialDomainState } from './seed'
import type { SentimentDomainState } from './types'

const STORAGE_KEY = 'data-product-ops:sentiment-domain:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): SentimentDomainState {
  const fallback = buildInitialDomainState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return applyMigrations(clone(fallback))
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const migrated = applyMigrations(clone(fallback))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  }
  try {
    const parsed = JSON.parse(raw) as SentimentDomainState
    // 已经是迁移后的结构就直接用，避免每次加载都重复写 localStorage
    const upToDate = parsed.stateVersion === 2 && parsed.migrations?.includes('M1-disable-SENT-0002')
    if (upToDate) {
      return parsed
    }
    const migrated = applyMigrations(parsed)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  } catch {
    const migrated = applyMigrations(clone(fallback))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  }
}

let cache: SentimentDomainState | null = null

export function loadDomain(): SentimentDomainState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 唯一写入口：一次动作 = 一份完整状态 = 一次 localStorage 提交（事务边界）。 */
export function commitDomain(next: SentimentDomainState): SentimentDomainState {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return cache
}

export function resetDomain(): SentimentDomainState {
  const fresh = applyMigrations(buildInitialDomainState())
  return commitDomain(fresh)
}

export function domainStorageKey(): string {
  return STORAGE_KEY
}
