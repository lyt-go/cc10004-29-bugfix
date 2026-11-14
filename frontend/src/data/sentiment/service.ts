/**
 * 舆情预警联动服务：页面只调用这里，不直接碰引擎或 localStorage。
 * 每个业务动作对应一次引擎计算 + 一次整份状态提交（停用事务的三件事在同一次提交里生效）。
 */
import {
  closeAlert,
  disablePlan,
  enablePlan,
  generateHeat,
  submitPlanReview,
  transitionRule,
  updateKeywords,
  updateRule,
} from './engine'
import type { EngineResult } from './engine'
import { commitDomain, loadDomain, resetDomain } from './store'
import type {
  AlertInstance,
  AlertRule,
  CheckConclusion,
  HeatRecord,
  SentimentDomainState,
  SentimentPlan,
  Tendency,
} from './types'

function now(): string {
  return new Date().toISOString()
}

function commit(result: EngineResult): EngineResult {
  // 引擎返回同一引用说明被拦下且没有任何留痕/变更，不必重复落盘；
  // 带核对结论的拦截会返回新状态，照常一次提交。
  if (result.state !== loadDomain()) {
    commitDomain(result.state)
  }
  return result
}

export function getDomain(): SentimentDomainState {
  return loadDomain()
}

export function listPlans(): SentimentPlan[] {
  return loadDomain().plans
}

export function listRules(): AlertRule[] {
  return loadDomain().rules
}

export function listAlerts(): AlertInstance[] {
  return loadDomain().alerts
}

export function listHeat(planId?: number): HeatRecord[] {
  const rows = loadDomain().heat
  return typeof planId === 'number' ? rows.filter((row) => row.planId === planId) : rows
}

export function listConclusions(): CheckConclusion[] {
  return loadDomain().conclusions
}

/** 某监控主题（方案）的当前未结预警：同一主题最多一条，避免两个互相矛盾的当前预警。 */
export function openAlertOfPlan(planId: number): AlertInstance | undefined {
  return loadDomain().alerts.find((alert) => alert.planId === planId && alert.status !== '已关闭')
}

export function planById(planId: number): SentimentPlan | undefined {
  return loadDomain().plans.find((plan) => plan.id === planId)
}

export function ruleOfPlan(planId: number): AlertRule | undefined {
  return loadDomain().rules.find((rule) => rule.planId === planId)
}

export function reviewPlan(planId: number): EngineResult {
  return commit(submitPlanReview(loadDomain(), planId, now()))
}

export function activatePlan(planId: number): EngineResult {
  return commit(enablePlan(loadDomain(), planId, now()))
}

/**
 * 停用方案：停用 + 未结预警关闭 + 规则更新在一次提交内生效。
 * 连续停用（已封存又点一次）：不改业务数据，只补一条核对结论留痕。
 */
export function deactivatePlan(planId: number, requestId: string): EngineResult {
  const state = loadDomain()
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) {
    return { ok: false, message: `没有找到编号为 ${planId} 的舆情方案`, state }
  }

  const result = disablePlan(state, planId, now())
  if (result.ok) {
    // 停用事务的三件事与核对结论在同一份状态上、同一次提交里生效
    result.state.counters.conclusion += 1
    result.state.conclusions.push({
      id: result.state.counters.conclusion,
      at: now(),
      requestId,
      planId,
      ruleId: result.state.rules.find((rule) => rule.planId === planId)?.id ?? null,
      passed: true,
      reason: '停用事务已一次生效：方案封存、未结预警转历史、规则关闭；停止新增热度与预警，历史情感与升级记录保留',
      keywordVersion: plan.activeKeywordVersion,
      alertCode: null,
    })
    return commit(result)
  }

  // 连续停用 / 封存后请求：只记录核对结论，不产生任何业务变更（单次写入仅追加日志）
  if (plan.sealed || plan.status === '已停用') {
    return recordConclusionOnly({
      requestId,
      planId,
      ruleId: ruleOfPlan(planId)?.id ?? null,
      passed: false,
      reason: `${plan.code} 已停用封存，重复停用请求只记录核对结论，不再变更数据`,
      keywordVersion: plan.activeKeywordVersion,
      alertCode: openAlertOfPlan(planId)?.code ?? null,
    })
  }
  return result
}

export function changeKeywords(planId: number, keywords: string[], note: string): EngineResult {
  return commit(updateKeywords(loadDomain(), planId, keywords, note, now()))
}

export function editRule(
  ruleId: number,
  patch: Partial<Pick<AlertRule, 'threshold' | 'periods' | 'level' | 'operator' | 'notifyTarget' | 'escalation'>>,
): EngineResult {
  return commit(updateRule(loadDomain(), ruleId, patch, now()))
}

export function moveRule(ruleId: number, nextStatus: AlertRule['status']): EngineResult {
  return commit(transitionRule(loadDomain(), ruleId, nextStatus, now()))
}

export function closeAlertById(alertId: number): EngineResult {
  return commit(closeAlert(loadDomain(), alertId, now()))
}

export interface HeatRequest {
  requestId: string
  planId: number
  heat: number
  tendency: Tendency
  source: string
}

/** 热度/预警生成入口：版本核对、去重、升级、发号全部在引擎内完成，这里只负责一次提交。 */
export function ingestHeat(req: HeatRequest): EngineResult {
  return commit(generateHeat(loadDomain(), { ...req, now: now() }))
}

interface ConclusionOnly {
  requestId: string
  planId: number
  ruleId: number | null
  passed: boolean
  reason: string
  keywordVersion: number | null
  alertCode: string | null
}

/** 仅追加核对结论（后到请求、重复停用），不动任何业务数据。 */
export function recordConclusionOnly(data: ConclusionOnly): EngineResult {
  const state = loadDomain()
  state.counters.conclusion += 1
  state.conclusions.push({
    id: state.counters.conclusion,
    at: now(),
    ...data,
  })
  commitDomain(state)
  return { ok: data.passed, message: data.reason, state }
}

export function resetSentimentDomain(): SentimentDomainState {
  return resetDomain()
}
