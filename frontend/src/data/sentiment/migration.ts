import { disablePlan } from './engine'
import type { SentimentDomainState } from './types'

/**
 * 领域迁移（纯函数，不碰 localStorage）：把历史故障现场一次性修复到正确终态。
 * 迁移与业务动作共用同一个停用事务，确保修复路径就是被验证过的代码路径。
 */
export function applyMigrations(raw: SentimentDomainState): SentimentDomainState {
  let state = raw

  // M1：SENT-0002 停用封存；其未结预警（OPSA-0002-A001）转入历史，规则 OPSA-0002 同步关闭。
  if (!state.migrations.includes('M1-disable-SENT-0002')) {
    const plan = state.plans.find((item) => item.code === 'SENT-0002')
    if (plan && plan.status !== '已停用' && !plan.sealed) {
      const result = disablePlan(state, plan.id, '2026-11-14T09:05:00.000Z')
      if (result.ok) {
        state = result.state
      }
    }
    state = { ...state, migrations: [...state.migrations, 'M1-disable-SENT-0002'] }
  }

  return { ...state, stateVersion: 2 }
}
