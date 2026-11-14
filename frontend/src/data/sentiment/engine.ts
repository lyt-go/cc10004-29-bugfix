/**
 * 舆情预警联动引擎：全部是纯函数，输入旧状态、输出新状态，不做任何持久化。
 *
 * 修复点总览：
 * 1. 生命周期严格单向流转（草稿→评审中→已启用→已停用），停用即封存，终态不可恢复；
 * 2. 方案必须先评审、再启用，只有「已启用」方案才允许产出热度/预警；
 * 3. 预警生成前核对关键词集合版本（方案当前版本必须与规则绑定版本一致）；
 * 4. 停用、未结预警关闭、规则更新在同一次事务里一次落库（单份状态、一次写入）；
 * 5. 停用后停止新增热度与预警，历史情感倾向与升级记录原样保留；
 * 6. 连续停用、两路生成并发只保留首个完整预警编号，后到请求只记录核对结论。
 */
import {
  ALERT_LEVEL_ORDER,
  PLAN_LIFECYCLE_ORDER,
} from './types'
import type {
  AlertInstance,
  AlertRule,
  CheckConclusion,
  EscalationRecord,
  HeatRecord,
  KeywordVersion,
  SentimentDomainState,
  SentimentPlan,
  SentimentStatus,
  Tendency,
} from './types'

export interface EngineResult {
  ok: boolean
  message: string
  state: SentimentDomainState
}

function clone(state: SentimentDomainState): SentimentDomainState {
  return JSON.parse(JSON.stringify(state)) as SentimentDomainState
}

function fail(state: SentimentDomainState, message: string): EngineResult {
  return { ok: false, message, state }
}

function findPlan(state: SentimentDomainState, planId: number): SentimentPlan | undefined {
  return state.plans.find((plan) => plan.id === planId)
}

function findRuleOfPlan(state: SentimentDomainState, planId: number): AlertRule | undefined {
  return state.rules.find((rule) => rule.planId === planId)
}

/** 生命周期下标：只允许向后（下标增大）流转。 */
function stageIndex(status: SentimentStatus): number {
  return PLAN_LIFECYCLE_ORDER.indexOf(status)
}

/** 追加一条核对结论。任何请求（含被拦下的）都必须留痕。 */
function appendConclusion(
  state: SentimentDomainState,
  data: Omit<CheckConclusion, 'id'>,
): void {
  state.counters.conclusion += 1
  state.conclusions.push({ id: state.counters.conclusion, ...data })
}

/**
 * 通用生命周期流转：校验单向、校验封存终态。
 * 所有方案动作都先走这道闸，归档/封存后不能恢复，也不允许回到旧状态或随意变更。
 */
function transitionPlan(
  prev: SentimentDomainState,
  planId: number,
  nextStatus: SentimentStatus,
  now: string,
): EngineResult {
  const state = clone(prev)
  const plan = findPlan(state, planId)
  if (!plan) {
    return fail(prev, `没有找到编号为 ${planId} 的舆情方案`)
  }
  if (plan.sealed || plan.status === '已停用') {
    return fail(prev, `${plan.code} 已停用封存，封存为终态，不能恢复或再变更`)
  }
  const from = stageIndex(plan.status)
  const to = stageIndex(nextStatus)
  if (to <= from) {
    return fail(prev, `生命周期只能单向向前流转：${plan.status} 不能变更为 ${nextStatus}`)
  }
  if (to !== from + 1) {
    return fail(prev, `生命周期不能跨阶段跳转：${plan.status} 不能直接变更为 ${nextStatus}`)
  }
  plan.status = nextStatus
  plan.updatedAt = now
  return { ok: true, message: `${plan.code} 已流转到「${nextStatus}」`, state }
}

/** 提交方案评审：草稿 → 方案评审中。 */
export function submitPlanReview(prev: SentimentDomainState, planId: number, now: string): EngineResult {
  return transitionPlan(prev, planId, '方案评审中', now)
}

/**
 * 启用方案：方案评审中 → 已启用。
 * 规则：舆情方案须先评审、再启用，只有评审通过的方案才能启用并触发预警。
 */
export function enablePlan(prev: SentimentDomainState, planId: number, now: string): EngineResult {
  const plan = findPlan(prev, planId)
  if (!plan) {
    return fail(prev, `没有找到编号为 ${planId} 的舆情方案`)
  }
  if (plan.status !== '方案评审中') {
    return fail(prev, `${plan.code} 必须先完成评审（当前「${plan.status}」），评审通过才能启用`)
  }
  return transitionPlan(prev, planId, '已启用', now)
}

/**
 * 停用方案（核心修复）——一次事务内完成三件事，并只做一次状态写入：
 *   a. 方案进入「已停用」并封存（终态，不可恢复）；
 *   b. 该方案所有「未结 / 已升级」预警转入历史（关闭），历史情感与升级记录保留；
 *   c. 关联预警规则更新为「已关闭」，并把规则绑定的关键词版本对齐到方案当前版本，
 *      保证规则与方案条件一致（两页预警条件对不上的根因之一）。
 * 连续停用：已封存时幂等返回 ok=false 且不再写任何数据，只在调用方补一条核对结论。
 */
export function disablePlan(prev: SentimentDomainState, planId: number, now: string): EngineResult {
  const existing = findPlan(prev, planId)
  if (!existing) {
    return fail(prev, `没有找到编号为 ${planId} 的舆情方案`)
  }
  if (existing.sealed || existing.status === '已停用') {
    return fail(prev, `${existing.code} 已停用封存，无需重复停用`)
  }

  const state = clone(prev)
  const plan = findPlan(state, planId)!
  // a. 停用 + 封存（单向生命周期的终态）
  plan.status = '已停用'
  plan.sealed = true
  plan.updatedAt = now

  // b. 未结预警转入历史：关闭但保留全部升级记录与历史快照
  for (const alert of state.alerts) {
    if (alert.planId === planId && alert.status !== '已关闭') {
      alert.status = '已关闭'
      alert.closedAt = now
    }
  }

  // c. 关联规则更新：关闭并对齐关键词版本、刷新条件文案（与方案在同一事务内提交）
  const rule = findRuleOfPlan(state, planId)
  if (rule) {
    rule.status = '已关闭'
    rule.keywordVersion = plan.activeKeywordVersion
    rule.conditionText = buildConditionText(rule, plan.activeKeywordVersion)
    rule.updatedAt = now
  }

  return {
    ok: true,
    message: `${plan.code} 已停用封存，未结预警已转入历史，关联规则已同步关闭（单次事务生效）`,
    state,
  }
}

/** 规则条件文案：预警列表与舆情详情页共用，确保两页条件完全一致。 */
export function buildConditionText(rule: Pick<AlertRule, 'metric' | 'operator' | 'threshold' | 'periods'>, keywordVersion: number): string {
  return `${rule.metric} ${rule.operator} ${rule.threshold} 持续${rule.periods}周期（关键词集合 v${keywordVersion}）`
}

/**
 * 更新关键词集合：只追加不可变新版本，不覆盖历史。
 * 封存方案禁止变更；同时把关联规则的版本对齐到新版本（规则更新与版本核对在同一处完成）。
 * 返回新状态与新版本号。
 */
export function updateKeywords(
  prev: SentimentDomainState,
  planId: number,
  keywords: string[],
  note: string,
  now: string,
): EngineResult & { keywordVersion?: number } {
  const plan0 = findPlan(prev, planId)
  if (!plan0) {
    return fail(prev, `没有找到编号为 ${planId} 的舆情方案`)
  }
  if (plan0.sealed || plan0.status === '已停用') {
    return fail(prev, `${plan0.code} 已停用封存，关键词集合不能再变更`)
  }
  const nextKeywords = [...new Set(keywords.map((word) => word.trim()).filter(Boolean))]
  if (nextKeywords.length === 0) {
    return fail(prev, '关键词集合不能为空')
  }
  const state = clone(prev)
  const plan = findPlan(state, planId)!
  const version: KeywordVersion = {
    version: plan.keywordVersions.length + 1,
    keywords: nextKeywords,
    updatedAt: now,
    note: note || `更新至 v${plan.keywordVersions.length + 1}`,
  }
  plan.keywordVersions.push(version)
  plan.activeKeywordVersion = version.version
  plan.updatedAt = now

  const rule = findRuleOfPlan(state, planId)
  if (rule) {
    rule.keywordVersion = version.version
    rule.conditionText = buildConditionText(rule, version.version)
    rule.updatedAt = now
  }
  return {
    ok: true,
    keywordVersion: version.version,
    message: `${plan.code} 关键词集合已更新到 v${version.version}，关联规则已同步对齐`,
    state,
  }
}

/** 更新规则阈值/级别等条件（同一事务内对齐关键词版本与条件文案）。 */
export function updateRule(
  prev: SentimentDomainState,
  ruleId: number,
  patch: Partial<Pick<AlertRule, 'threshold' | 'periods' | 'level' | 'operator' | 'notifyTarget' | 'escalation'>>,
  now: string,
): EngineResult {
  const rule0 = prev.rules.find((item) => item.id === ruleId)
  if (!rule0) {
    return fail(prev, `没有找到编号为 ${ruleId} 的预警规则`)
  }
  const plan0 = findPlan(prev, rule0.planId)
  if (!plan0) {
    return fail(prev, '规则没有关联有效舆情方案')
  }
  if (plan0.sealed) {
    return fail(prev, `${plan0.code} 已封存，规则不可再变更`)
  }
  const state = clone(prev)
  const rule = state.rules.find((item) => item.id === ruleId)!
  Object.assign(rule, patch)
  rule.keywordVersion = plan0.activeKeywordVersion
  rule.conditionText = buildConditionText(rule, plan0.activeKeywordVersion)
  rule.updatedAt = now
  return { ok: true, message: `${rule.code} 规则已更新并对齐关键词集合 v${plan0.activeKeywordVersion}`, state }
}

export interface HeatInput {
  requestId: string
  planId: number
  heat: number
  tendency: Tendency
  source: string
  now: string
}

/** 预警生成前的统一核对：方案状态、规则状态、关键词版本、请求去重。 */
function precheckGeneration(
  state: SentimentDomainState,
  requestId: string,
  planId: number,
): { ok: boolean; reason: string; plan?: SentimentPlan; rule?: AlertRule; duplicateOf?: AlertInstance } {
  const plan = findPlan(state, planId)
  if (!plan) {
    return { ok: false, reason: `没有找到编号为 ${planId} 的舆情方案` }
  }
  // 封存/停用：停止一切新增，只留核对结论
  if (plan.sealed || plan.status === '已停用') {
    return { ok: false, reason: `${plan.code} 已停用封存，停止新增热度与预警` }
  }
  // 必须先评审并启用
  if (plan.status !== '已启用') {
    return { ok: false, reason: `${plan.code} 当前「${plan.status}」，须先评审并启用后才能触发预警` }
  }
  const rule = findRuleOfPlan(state, planId)
  if (!rule) {
    return { ok: false, reason: `${plan.code} 没有关联预警规则`, plan }
  }
  if (rule.status !== '已生效') {
    return { ok: false, reason: `${rule.code} 当前「${rule.status}」，规则未生效不能触发预警`, plan, rule }
  }
  // 关键词集合版本核对：规则版本必须等于方案当前生效版本
  if (rule.keywordVersion !== plan.activeKeywordVersion) {
    return {
      ok: false,
      reason: `关键词集合版本不一致：方案当前 v${plan.activeKeywordVersion}，规则绑定 v${rule.keywordVersion}，请先更新规则再生成预警`,
      plan,
      rule,
    }
  }
  // 两路生成 / 连续停用碰在一起：同一请求标识只认首个完整预警，后到请求去重
  const duplicateOf = state.alerts.find(
    (alert) => alert.ruleId === rule.id && alert.sourceRequestId === requestId,
  )
  if (duplicateOf) {
    return { ok: false, reason: `请求 ${requestId} 已生成过完整预警 ${duplicateOf.code}，后到请求只记录核对结论`, plan, rule, duplicateOf }
  }
  return { ok: true, reason: '核对通过', plan, rule }
}

function compare(heat: number, operator: AlertRule['operator'], threshold: number): boolean {
  switch (operator) {
    case '>=':
      return heat >= threshold
    case '>':
      return heat > threshold
    case '<=':
      return heat <= threshold
    case '<':
      return heat < threshold
    default:
      return false
  }
}

/**
 * 生成热度结果（并按规则决定是否生成/升级预警）。
 * 停用/未启用/版本不一致/重复请求：只写一条核对结论，不产生热度、不发预警编号。
 * 热度未超阈值：写热度与通过结论，但不生成预警。
 * 热度超阈值且存在未结预警：沿级别顺序升级，复用原预警编号，不另发新号。
 * 热度超阈值且无未结预警：生成一个完整预警编号。
 */
export function generateHeat(prev: SentimentDomainState, input: HeatInput): EngineResult {
  // 先在克隆态上做结论留痕，确保任何被拦请求都有核对结论
  const state = clone(prev)
  const check = precheckGeneration(state, input.requestId, input.planId)

  if (!check.ok) {
    appendConclusion(state, {
      at: input.now,
      requestId: input.requestId,
      planId: input.planId,
      ruleId: check.rule?.id ?? null,
      passed: false,
      reason: check.reason,
      keywordVersion: check.plan?.activeKeywordVersion ?? null,
      alertCode: check.duplicateOf?.code ?? null,
    })
    return { ok: false, message: check.reason, state }
  }

  const plan = check.plan!
  const rule = check.rule!

  // 核对通过：先落热度（停用后这条路径根本进不来，历史热度则永久保留）
  state.counters.heat += 1
  const heatRecord: HeatRecord = {
    id: state.counters.heat,
    planId: plan.id,
    keywordVersion: plan.activeKeywordVersion,
    heat: input.heat,
    tendency: input.tendency,
    source: input.source,
    createdAt: input.now,
  }
  state.heat.push(heatRecord)

  const breached = compare(input.heat, rule.operator, rule.threshold)
  if (!breached) {
    appendConclusion(state, {
      at: input.now,
      requestId: input.requestId,
      planId: plan.id,
      ruleId: rule.id,
      passed: true,
      reason: `热度 ${input.heat} 未${rule.operator}阈值 ${rule.threshold}，仅记录热度，不生成预警`,
      keywordVersion: plan.activeKeywordVersion,
      alertCode: null,
    })
    return { ok: true, message: `${plan.code} 热度已记录，未达预警阈值`, state }
  }

  // 超阈值：找该规则的未结预警（同一监控主题只允许一个当前未结预警，消除互相矛盾的双预警）
  const openAlert = state.alerts.find(
    (alert) => alert.ruleId === rule.id && alert.status !== '已关闭',
  )

  if (openAlert) {
    // 升级：沿用首个完整预警编号，级别只能向更高走
    const currentIdx = ALERT_LEVEL_ORDER.indexOf(openAlert.level as (typeof ALERT_LEVEL_ORDER)[number])
    const nextLevel = currentIdx < ALERT_LEVEL_ORDER.length - 1
      ? ALERT_LEVEL_ORDER[currentIdx + 1]
      : (ALERT_LEVEL_ORDER[ALERT_LEVEL_ORDER.length - 1] as string)
    const escalation: EscalationRecord = {
      at: input.now,
      fromLevel: openAlert.level,
      toLevel: nextLevel,
      heat: input.heat,
      note: '热度持续超阈值，自动升级',
    }
    openAlert.escalations.push(escalation)
    openAlert.level = nextLevel
    openAlert.status = '已升级'
    openAlert.heat = input.heat
    appendConclusion(state, {
      at: input.now,
      requestId: input.requestId,
      planId: plan.id,
      ruleId: rule.id,
      passed: true,
      reason: `命中未结预警 ${openAlert.code}，升级为${nextLevel}，不另发预警编号`,
      keywordVersion: plan.activeKeywordVersion,
      alertCode: openAlert.code,
    })
    return { ok: true, message: `${plan.code} 预警 ${openAlert.code} 已升级为${nextLevel}`, state }
  }

  // 无未结预警：生成首个完整预警编号（同一规则顺序编号，只增不补号）
  state.counters.alert += 1
  const seq = state.alerts.filter((alert) => alert.ruleId === rule.id).length + 1
  const code = `${rule.code}-A${String(seq).padStart(3, '0')}`
  const alert: AlertInstance = {
    id: state.counters.alert,
    code,
    ruleId: rule.id,
    planId: plan.id,
    keywordVersion: plan.activeKeywordVersion,
    level: rule.level,
    status: '未结',
    heat: input.heat,
    sourceRequestId: input.requestId,
    createdAt: input.now,
    closedAt: null,
    escalations: [],
  }
  state.alerts.push(alert)
  appendConclusion(state, {
    at: input.now,
    requestId: input.requestId,
    planId: plan.id,
    ruleId: rule.id,
    passed: true,
    reason: `热度超阈值且无未结预警，生成完整预警编号 ${code}（按关键词集合 v${plan.activeKeywordVersion} 解释）`,
    keywordVersion: plan.activeKeywordVersion,
    alertCode: code,
  })
  return { ok: true, message: `${plan.code} 已生成预警 ${code}`, state }
}

/**
 * 手动关闭单条预警（进入历史）。封存方案的未结预警在停用事务里已自动关闭。
 */
export function closeAlert(prev: SentimentDomainState, alertId: number, now: string): EngineResult {
  const alert0 = prev.alerts.find((item) => item.id === alertId)
  if (!alert0) {
    return fail(prev, `没有找到编号为 ${alertId} 的预警`)
  }
  if (alert0.status === '已关闭') {
    return fail(prev, `预警 ${alert0.code} 已在历史中，不能重复关闭`)
  }
  const state = clone(prev)
  const alert = state.alerts.find((item) => item.id === alertId)!
  alert.status = '已关闭'
  alert.closedAt = now
  return { ok: true, message: `预警 ${alert.code} 已转入历史，升级记录保留`, state }
}

/** 规则评审/生效等流转（仅做基本前置校验，规则生命周期同样单向）。 */
export function transitionRule(
  prev: SentimentDomainState,
  ruleId: number,
  nextStatus: AlertRule['status'],
  now: string,
): EngineResult {
  const order: AlertRule['status'][] = ['草稿', '规则评审中', '已生效', '已关闭']
  const rule0 = prev.rules.find((item) => item.id === ruleId)
  if (!rule0) {
    return fail(prev, `没有找到编号为 ${ruleId} 的预警规则`)
  }
  const plan0 = findPlan(prev, rule0.planId)
  if (plan0?.sealed) {
    return fail(prev, `关联方案已封存，规则保持「${rule0.status}」`)
  }
  const fromIdx = order.indexOf(rule0.status)
  const toIdx = order.indexOf(nextStatus)
  if (toIdx <= fromIdx) {
    return fail(prev, `规则生命周期只能单向向前：${rule0.status} 不能变更为 ${nextStatus}`)
  }
  if (toIdx !== fromIdx + 1) {
    return fail(prev, `规则生命周期不能跨阶段跳转：${rule0.status} 不能直接变更为 ${nextStatus}`)
  }
  const state = clone(prev)
  const rule = state.rules.find((item) => item.id === ruleId)!
  rule.status = nextStatus
  rule.updatedAt = now
  return { ok: true, message: `${rule.code} 已流转到「${nextStatus}」`, state }
}
