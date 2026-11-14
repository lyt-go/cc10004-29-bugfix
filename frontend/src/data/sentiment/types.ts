/**
 * 舆情预警联动领域模型。
 *
 * 这一层只放类型与纯数据结构，不碰 localStorage、不碰 React，
 * 业务规则全部在 engine.ts 里以纯函数实现，方便直接用 node 跑验收用例。
 */

/** 舆情方案生命周期：严格单向，「已停用」同时打封存标记，封存即终态。 */
export type SentimentStatus = '草稿' | '方案评审中' | '已启用' | '已停用'

export type Tendency = '正面' | '中性' | '负面'

/** 关键词集合的一个不可变版本：每次更新只追加新版本，历史版本永不覆盖。 */
export interface KeywordVersion {
  version: number
  keywords: string[]
  updatedAt: string
  note: string
}

/** 舆情方案（监控主题）。 */
export interface SentimentPlan {
  id: number
  /** 方案编号，如 SENT-0002 */
  code: string
  /** 监控主题 */
  topic: string
  dataSource: string
  /** 热度阈值 */
  heatThreshold: number
  pushFrequency: string
  product: string
  status: SentimentStatus
  /** 封存标记：停用后置 true，终态不可恢复、不可再变更 */
  sealed: boolean
  keywordVersions: KeywordVersion[]
  /** 当前生效的关键词集合版本号 */
  activeKeywordVersion: number
  /** 绑定的预警规则 id */
  ruleId: number | null
  createdAt: string
  updatedAt: string
}

/** 一次热度结果（含情感倾向快照），停用后不再新增，但历史记录永久保留。 */
export interface HeatRecord {
  id: number
  planId: number
  /** 生成时核对通过并快照的关键词集合版本，历史热度按此版本解释 */
  keywordVersion: number
  heat: number
  tendency: Tendency
  source: string
  createdAt: string
}

/** 预警规则。 */
export interface AlertRule {
  id: number
  /** 规则编号，如 OPSA-0002 */
  code: string
  planId: number
  metric: string
  operator: '>=' | '>' | '<=' | '<'
  threshold: number
  /** 持续周期 */
  periods: number
  /** 预警级别，取值在 ALERT_LEVEL_ORDER 内 */
  level: string
  notifyTarget: string
  escalation: string
  status: '草稿' | '规则评审中' | '已生效' | '已关闭'
  /** 规则最近一次更新时绑定的关键词集合版本，预警生成前必须与方案当前版本一致 */
  keywordVersion: number
  /** 预警条件文案快照，舆情详情页与预警列表共用同一渲染，避免两页条件对不上 */
  conditionText: string
  updatedAt: string
}

export interface EscalationRecord {
  at: string
  fromLevel: string
  toLevel: string
  heat: number
  note: string
}

/** 预警实例（一次完整预警）。 */
export interface AlertInstance {
  id: number
  /** 完整预警编号，如 OPSA-0002-A001，同一规则只增不补号 */
  code: string
  ruleId: number
  planId: number
  /** 生成时快照的关键词集合版本：历史预警永远按这一版关键词解释 */
  keywordVersion: number
  level: string
  /** 未结 / 已升级 都算未结当前预警；已关闭转入历史 */
  status: '未结' | '已升级' | '已关闭'
  heat: number
  /** 触发该预警的请求标识，用于两路生成去重 */
  sourceRequestId: string
  createdAt: string
  closedAt: string | null
  /** 升级记录：方案停用后停止新增，但历史升级永久保留 */
  escalations: EscalationRecord[]
}

/**
 * 核对结论：任何一次热度/预警请求都会留痕。
 * 停用、版本不一致、重复请求等被拦下的请求只写结论，不产生热度与预警。
 */
export interface CheckConclusion {
  id: number
  at: string
  requestId: string
  planId: number
  ruleId: number | null
  passed: boolean
  reason: string
  keywordVersion: number | null
  /** 命中或关联的首个完整预警编号（后到请求只引用它，不再另发编号） */
  alertCode: string | null
}

export interface SentimentDomainState {
  /** 领域数据版本号，用于启动迁移 */
  stateVersion: number
  /** 已执行过的迁移标识 */
  migrations: string[]
  plans: SentimentPlan[]
  rules: AlertRule[]
  heat: HeatRecord[]
  alerts: AlertInstance[]
  conclusions: CheckConclusion[]
  counters: {
    heat: number
    alert: number
    conclusion: number
  }
}

/** 预警级别从低到高，升级只能沿这个顺序向前走。 */
export const ALERT_LEVEL_ORDER = ['三级', '二级', '一级', '紧急'] as const

/** 方案生命周期顺序：流转只能向前，不能回到旧状态。 */
export const PLAN_LIFECYCLE_ORDER: SentimentStatus[] = ['草稿', '方案评审中', '已启用', '已停用']
