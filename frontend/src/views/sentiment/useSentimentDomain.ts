import { useCallback, useState } from 'react'

import { getDomain } from '@/data/sentiment/service'
import type { SentimentDomainState } from '@/data/sentiment/types'

/** 领域数据读取 + 动作后手动刷新（localStorage 不是响应式的，用版本号触发重渲染）。 */
export function useSentimentDomain(): {
  domain: SentimentDomainState
  refresh: () => void
} {
  const [, setTick] = useState(0)
  const refresh = useCallback(() => setTick((value) => value + 1), [])
  return { domain: getDomain(), refresh }
}
