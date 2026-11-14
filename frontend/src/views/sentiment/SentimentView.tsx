import { useState } from 'react'

import AlertCondition from './AlertCondition'
import { useSentimentDomain } from './useSentimentDomain'
import {
  activatePlan,
  changeKeywords,
  closeAlertById,
  deactivatePlan,
  ingestHeat,
  listConclusions,
  openAlertOfPlan,
  reviewPlan,
  ruleOfPlan,
} from '@/data/sentiment/service'
import type { EngineResult } from '@/data/sentiment/engine'
import type { SentimentPlan, Tendency } from '@/data/sentiment/types'

function nextRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const TENDENCIES: Tendency[] = ['正面', '中性', '负面']

/** 生命周期徽章：封存终态单独标注，列表与详情共用。 */
function StatusBadge({ plan }: { plan: SentimentPlan }) {
  const sealed = plan.sealed || plan.status === '已停用'
  return (
    <span className={sealed ? 'badge badge-sealed' : 'badge badge-live'}>
      {plan.status}
      {sealed && '（已封存）'}
    </span>
  )
}

export default function SentimentView() {
  const { domain, refresh } = useSentimentDomain()
  const [selectedId, setSelectedId] = useState<number>(2)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [keywordDraft, setKeywordDraft] = useState('')
  const [heatDraft, setHeatDraft] = useState('')
  const [tendencyDraft, setTendencyDraft] = useState<Tendency>('负面')
  const [sourceDraft, setSourceDraft] = useState('微博')

  const selected = domain.plans.find((plan) => plan.id === selectedId) ?? domain.plans[0]
  const rule = selected ? ruleOfPlan(selected.id) : undefined
  const openAlert = selected ? openAlertOfPlan(selected.id) : undefined
  const planHeat = selected ? domain.heat.filter((item) => item.planId === selected.id) : []
  const planAlerts = selected ? domain.alerts.filter((item) => item.planId === selected.id) : []
  const planConclusions = selected
    ? listConclusions().filter((item) => item.planId === selected.id)
    : []

  function report(result: EngineResult): void {
    if (result.ok) {
      setMessage(result.message)
      setError('')
    } else {
      setError(result.message)
      setMessage('')
    }
    refresh()
  }

  function doReview(): void {
    if (selected) report(reviewPlan(selected.id))
  }
  function doEnable(): void {
    if (selected) report(activatePlan(selected.id))
  }
  function doDisable(): void {
    if (selected) report(deactivatePlan(selected.id, nextRequestId()))
  }
  function doUpdateKeywords(): void {
    if (!selected) return
    const keywords = keywordDraft.split(/[,，\s]+/).map((word) => word.trim()).filter(Boolean)
    if (keywords.length === 0) {
      setError('请至少填写一个关键词，多个关键词用逗号分隔')
      return
    }
    report(changeKeywords(selected.id, keywords, '页面手工更新关键词集合'))
    setKeywordDraft('')
  }
  function doIngest(): void {
    if (!selected) return
    const heat = Number(heatDraft)
    if (!Number.isFinite(heat)) {
      setError('热度必须是数字')
      return
    }
    report(ingestHeat({ requestId: nextRequestId(), planId: selected.id, heat, tendency: tendencyDraft, source: sourceDraft }))
    setHeatDraft('')
  }
  function doCloseAlert(alertId: number): void {
    report(closeAlertById(alertId))
  }

  const sealed = selected ? selected.sealed || selected.status === '已停用' : false

  return (
    <section className="page" data-module="sentiment">
      <header className="page-head">
        <div>
          <h2>舆情分析管理</h2>
          <p className="page-desc">
            舆情方案须先评审、再启用才可触发预警；停用即封存，停止新增热度与预警，历史情感倾向与升级记录保留。
          </p>
        </div>
      </header>

      <p className="status-legend">
        {(['草稿', '方案评审中', '已启用', '已停用'] as const).map((status) => (
          <span key={status} className="legend-item">
            {status}：{domain.plans.filter((plan) => plan.status === status).length}
          </span>
        ))}
        <span className="legend-item">已封存：{domain.plans.filter((plan) => plan.sealed).length}</span>
      </p>

      <table className="data-table">
        <thead>
          <tr>
            <th>方案编号</th>
            <th>监控主题</th>
            <th>当前关键词版本</th>
            <th>热度阈值</th>
            <th>关联预警规则</th>
            <th>当前状态</th>
            <th>当前未结预警</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {domain.plans.map((plan) => {
            const planRule = ruleOfPlan(plan.id)
            const open = openAlertOfPlan(plan.id)
            return (
              <tr key={plan.id} className={plan.id === selected?.id ? 'row-selected' : ''}>
                <td>{plan.code}</td>
                <td>{plan.topic}</td>
                <td>v{plan.activeKeywordVersion}（共{plan.keywordVersions.length}版）</td>
                <td>{plan.heatThreshold}</td>
                <td>{planRule ? planRule.code : '—'}</td>
                <td><StatusBadge plan={plan} /></td>
                <td>{open ? <span className="badge badge-alert">{open.code} / {open.level}</span> : '无（仅历史或未触发）'}</td>
                <td>
                  <button className="link" type="button" onClick={() => { setSelectedId(plan.id); setMessage(''); setError('') }}>
                    查看详情
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {selected && (
        <div className="detail-panel">
          <h3>舆情详情：{selected.code} {selected.topic}</h3>

          <div className="detail-grid">
            <article className="stat-card">
              <span className="stat-label">生命周期状态</span>
              <strong className="stat-value"><StatusBadge plan={selected} /></strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">数据来源 / 推送频率</span>
              <strong className="stat-value">{selected.dataSource} / {selected.pushFrequency}</strong>
            </article>
            <article className="stat-card">
              <span className="stat-label">关联预警条件（与预警列表同源）</span>
              <strong className="stat-value">{rule ? <AlertCondition rule={rule} /> : '未关联规则'}</strong>
            </article>
          </div>

          <h4>生命周期动作（单向流转，封存后不可恢复）</h4>
          <div className="row-actions">
            <button className="btn" type="button" disabled={selected.status !== '草稿'} onClick={doReview}>
              提交方案评审
            </button>
            <button className="btn primary" type="button" disabled={selected.status !== '方案评审中'} onClick={doEnable}>
              启用方案
            </button>
            <button className="btn danger" type="button" disabled={sealed} onClick={doDisable}>
              停用并封存
            </button>
          </div>
          {sealed && (
            <p className="error-text">该方案已停用封存：终态不可恢复，不再产生热度与预警，历史记录只读保留。</p>
          )}

          <h4>关键词集合版本（只追加新版本，历史版本不覆盖）</h4>
          <table className="data-table sub-table">
            <thead>
              <tr><th>版本</th><th>关键词</th><th>更新时间</th><th>说明</th></tr>
            </thead>
            <tbody>
              {selected.keywordVersions.map((kv) => (
                <tr key={kv.version} className={kv.version === selected.activeKeywordVersion ? 'row-selected' : ''}>
                  <td>v{kv.version}{kv.version === selected.activeKeywordVersion && '（生效中）'}</td>
                  <td>{kv.keywords.join('、')}</td>
                  <td>{kv.updatedAt}</td>
                  <td>{kv.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sealed && (
            <div className="filter-bar">
              <label className="filter-item">
                <span>新增关键词（逗号分隔）</span>
                <input value={keywordDraft} placeholder="如：归因, 口径, 数据打架" onChange={(e) => setKeywordDraft(e.target.value)} />
              </label>
              <button className="btn" type="button" onClick={doUpdateKeywords}>发布新版本并同步规则</button>
            </div>
          )}

          <h4>热度结果生成（生成前核对方案状态与关键词版本）</h4>
          {!sealed ? (
            <div className="filter-bar">
              <label className="filter-item">
                <span>热度</span>
                <input value={heatDraft} placeholder="如 82" onChange={(e) => setHeatDraft(e.target.value)} />
              </label>
              <label className="filter-item">
                <span>情感倾向</span>
                <select value={tendencyDraft} onChange={(e) => setTendencyDraft(e.target.value as Tendency)}>
                  {TENDENCIES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="filter-item">
                <span>来源</span>
                <input value={sourceDraft} onChange={(e) => setSourceDraft(e.target.value)} />
              </label>
              <button className="btn primary" type="button" onClick={doIngest}>生成热度并核对预警</button>
            </div>
          ) : (
            <p className="error-text">已封存：热度生成入口关闭，停用后的请求只会在核对结论里留痕。</p>
          )}

          <h4>热度与情感倾向历史（停用后保留，不再新增）</h4>
          <table className="data-table sub-table">
            <thead>
              <tr><th>时间</th><th>热度</th><th>情感倾向</th><th>来源</th><th>解释所用关键词版本</th></tr>
            </thead>
            <tbody>
              {planHeat.map((item) => (
                <tr key={item.id}>
                  <td>{item.createdAt}</td>
                  <td>{item.heat}</td>
                  <td>{item.tendency}</td>
                  <td>{item.source}</td>
                  <td>v{item.keywordVersion}</td>
                </tr>
              ))}
              {planHeat.length === 0 && <tr><td className="empty-state" colSpan={5}>暂无热度记录</td></tr>}
            </tbody>
          </table>

          <h4>预警记录（同一监控主题最多一个当前未结预警；关闭后转历史）</h4>
          <table className="data-table sub-table">
            <thead>
              <tr><th>预警编号</th><th>级别</th><th>状态</th><th>触发热度</th><th>关键词版本</th><th>升级记录</th><th>操作</th></tr>
            </thead>
            <tbody>
              {planAlerts.map((alert) => (
                <tr key={alert.id}>
                  <td>{alert.code}</td>
                  <td>{alert.level}</td>
                  <td>{alert.status === '已关闭' ? '已关闭（历史）' : alert.status}</td>
                  <td>{alert.heat}</td>
                  <td>v{alert.keywordVersion}</td>
                  <td>
                    {alert.escalations.length === 0
                      ? '—'
                      : alert.escalations.map((esc) => `${esc.fromLevel}→${esc.toLevel}@${esc.at}`).join('；')}
                  </td>
                  <td>
                    {alert.status !== '已关闭'
                      ? <button className="link" type="button" onClick={() => doCloseAlert(alert.id)}>关闭转历史</button>
                      : '只读'}
                  </td>
                </tr>
              ))}
              {planAlerts.length === 0 && <tr><td className="empty-state" colSpan={7}>暂无预警记录</td></tr>}
            </tbody>
          </table>
          {openAlert && <p className="page-desc">当前未结预警：{openAlert.code}（{openAlert.level}），持续超阈值会沿三级→二级→一级→紧急升级并复用该编号。</p>}

          <h4>核对结论留痕（被拦下的后到请求也只在这里记录）</h4>
          <table className="data-table sub-table">
            <thead>
              <tr><th>时间</th><th>请求标识</th><th>是否通过</th><th>结论</th><th>关键词版本</th><th>关联预警编号</th></tr>
            </thead>
            <tbody>
              {planConclusions.map((item) => (
                <tr key={item.id}>
                  <td>{item.at}</td>
                  <td>{item.requestId}</td>
                  <td>{item.passed ? '通过' : '不通过'}</td>
                  <td>{item.reason}</td>
                  <td>{item.keywordVersion === null ? '—' : `v${item.keywordVersion}`}</td>
                  <td>{item.alertCode ?? '—'}</td>
                </tr>
              ))}
              {planConclusions.length === 0 && <tr><td className="empty-state" colSpan={6}>暂无核对结论</td></tr>}
            </tbody>
          </table>

          <div className="page-foot">
            {message && <span className="ok-text">{message}</span>}
            {error && <span className="error-text">{error}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
