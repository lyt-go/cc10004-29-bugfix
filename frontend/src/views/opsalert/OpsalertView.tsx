import { useState } from 'react'

import AlertCondition from '@/views/sentiment/AlertCondition'
import { useSentimentDomain } from '@/views/sentiment/useSentimentDomain'
import { closeAlertById, moveRule } from '@/data/sentiment/service'
import type { EngineResult } from '@/data/sentiment/engine'
import type { AlertRule } from '@/data/sentiment/types'

export default function OpsalertView() {
  const { domain, refresh } = useSentimentDomain()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

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

  const planName = (planId: number): string =>
    domain.plans.find((plan) => plan.id === planId)?.topic ?? '—'
  const planCode = (planId: number): string =>
    domain.plans.find((plan) => plan.id === planId)?.code ?? '—'

  function nextRuleStatus(rule: AlertRule): AlertRule['status'] | null {
    const order: AlertRule['status'][] = ['草稿', '规则评审中', '已生效', '已关闭']
    const idx = order.indexOf(rule.status)
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null
  }

  const actionLabel: Record<AlertRule['status'], string> = {
    草稿: '提交规则评审',
    规则评审中: '生效规则',
    已生效: '关闭规则',
    已关闭: '已终态',
  }

  return (
    <section className="page" data-module="opsalert">
      <header className="page-head">
        <div>
          <h2>运营预警管理（舆情联动）</h2>
          <p className="page-desc">
            预警规则与舆情方案一一绑定；方案停用封存时规则在同一事务内关闭。预警条件与舆情详情页共用同一渲染与版本快照。
          </p>
        </div>
      </header>

      <p className="status-legend">
        {(['草稿', '规则评审中', '已生效', '已关闭'] as const).map((status) => (
          <span key={status} className="legend-item">
            {status}：{domain.rules.filter((rule) => rule.status === status).length}
          </span>
        ))}
        <span className="legend-item">未结预警：{domain.alerts.filter((alert) => alert.status !== '已关闭').length}</span>
        <span className="legend-item">历史预警：{domain.alerts.filter((alert) => alert.status === '已关闭').length}</span>
      </p>

      <h3>预警规则</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>规则编号</th>
            <th>关联舆情方案</th>
            <th>监控主题</th>
            <th>预警条件（与舆情详情页一致）</th>
            <th>级别</th>
            <th>通知对象</th>
            <th>升级策略</th>
            <th>规则状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {domain.rules.map((rule) => {
            const target = nextRuleStatus(rule)
            return (
              <tr key={rule.id}>
                <td>{rule.code}</td>
                <td>{planCode(rule.planId)}</td>
                <td>{planName(rule.planId)}</td>
                <td><AlertCondition rule={rule} /></td>
                <td>{rule.level}</td>
                <td>{rule.notifyTarget}</td>
                <td>{rule.escalation}</td>
                <td>
                  <span className={rule.status === '已关闭' ? 'badge badge-sealed' : 'badge badge-live'}>
                    {rule.status}
                  </span>
                </td>
                <td>
                  {target ? (
                    <button className="link" type="button" onClick={() => report(moveRule(rule.id, target))}>
                      {actionLabel[rule.status]}
                    </button>
                  ) : (
                    '只读'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <h3>预警实例（完整预警编号）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>预警编号</th>
            <th>所属规则</th>
            <th>监控主题</th>
            <th>级别</th>
            <th>状态</th>
            <th>触发热度</th>
            <th>生成时关键词版本</th>
            <th>升级记录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {domain.alerts.map((alert) => (
            <tr key={alert.id}>
              <td>{alert.code}</td>
              <td>{domain.rules.find((rule) => rule.id === alert.ruleId)?.code ?? '—'}</td>
              <td>{planName(alert.planId)}</td>
              <td>{alert.level}</td>
              <td>
                <span className={alert.status === '已关闭' ? 'badge badge-sealed' : 'badge badge-alert'}>
                  {alert.status === '已关闭' ? '已关闭（历史）' : alert.status}
                </span>
              </td>
              <td>{alert.heat}</td>
              <td>v{alert.keywordVersion}（历史按此版本解释）</td>
              <td>
                {alert.escalations.length === 0
                  ? '—'
                  : alert.escalations.map((esc) => `${esc.fromLevel}→${esc.toLevel}`).join('；')}
              </td>
              <td>
                {alert.status !== '已关闭'
                  ? <button className="link" type="button" onClick={() => report(closeAlertById(alert.id))}>关闭转历史</button>
                  : '只读'}
              </td>
            </tr>
          ))}
          {domain.alerts.length === 0 && (
            <tr><td className="empty-state" colSpan={9}>暂无预警实例</td></tr>
          )}
        </tbody>
      </table>

      <h3>核对结论（停用、版本不一致、重复请求的留痕）</h3>
      <table className="data-table">
        <thead>
          <tr><th>时间</th><th>请求标识</th><th>方案</th><th>是否通过</th><th>结论</th><th>关键词版本</th><th>关联预警编号</th></tr>
        </thead>
        <tbody>
          {domain.conclusions.map((item) => (
            <tr key={item.id}>
              <td>{item.at}</td>
              <td>{item.requestId}</td>
              <td>{planCode(item.planId)}</td>
              <td>{item.passed ? '通过' : '不通过'}</td>
              <td>{item.reason}</td>
              <td>{item.keywordVersion === null ? '—' : `v${item.keywordVersion}`}</td>
              <td>{item.alertCode ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="page-foot">
        {message && <span className="ok-text">{message}</span>}
        {error && <span className="error-text">{error}</span>}
      </footer>
    </section>
  )
}
