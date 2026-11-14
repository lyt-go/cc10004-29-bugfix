/**
 * 端到端验收：用 localStorage 垫片驱动 service + store（与浏览器同一条写路径），
 * 验证迁移落盘、停用事务单次写入、连续停用只留结论、停用后生成被拦、两路生成去重。
 */
// localStorage 垫片
const mem = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear(),
}
;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }
;(globalThis as Record<string, unknown>).localStorage = localStorageShim

import {
  deactivatePlan,
  getDomain,
  ingestHeat,
  listConclusions,
  resetSentimentDomain,
} from '../frontend/src/data/sentiment/service'
import { domainStorageKey } from '../frontend/src/data/sentiment/store'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name} ${detail}`) }
}

console.log('E2E 1：首次加载即迁移并落盘')
resetSentimentDomain()
const raw = JSON.parse(mem.get(domainStorageKey())!)
check('落盘状态 stateVersion=2 且含 M1 迁移标记', raw.stateVersion === 2 && raw.migrations.includes('M1-disable-SENT-0002'))
check('落盘 SENT-0002 已停用封存', raw.plans[1].status === '已停用' && raw.plans[1].sealed === true)
check('落盘 OPSA-0002 已关闭', raw.rules[1].status === '已关闭')
check('落盘未结预警已转历史', raw.alerts[0].status === '已关闭')

console.log('E2E 2：停用后生成热度/预警被拦，只写核对结论，无新热度/预警')
{
  const before = { heat: getDomain().heat.length, alerts: getDomain().alerts.length, conclusions: listConclusions().length, writes: mem.size }
  const r = ingestHeat({ requestId: 'e2e-late', planId: 2, heat: 99, tendency: '负面', source: '微博' })
  check('请求被拒', r.ok === false)
  check('热度数不变', getDomain().heat.length === before.heat)
  check('预警数不变', getDomain().alerts.length === before.alerts)
  check('核对结论 +1', listConclusions().length === before.conclusions + 1)
  const persisted = JSON.parse(mem.get(domainStorageKey())!)
  check('被拦请求也已持久化结论', persisted.conclusions.length === before.conclusions + 1)
}

console.log('E2E 3：连续停用只记录核对结论，业务数据零变化')
{
  const snapshot = mem.get(domainStorageKey())!
  const beforeConc = listConclusions().length
  const r = deactivatePlan(2, 'e2e-repeat-disable')
  check('重复停用返回不通过', r.ok === false)
  const after = getDomain()
  check('方案仍封存', after.plans[1].sealed === true)
  check('仅多一条核对结论', listConclusions().length === beforeConc + 1)
  const last = listConclusions().at(-1)!
  check('结论说明重复停用', last.reason.includes('重复停用') && last.passed === false)
  check('除结论日志外业务快照不变', (() => {
    const p = JSON.parse(snapshot)
    const q = JSON.parse(mem.get(domainStorageKey())!)
    p.conclusions = []; q.conclusions = []
    p.counters.conclusion = 0; q.counters.conclusion = 0
    return JSON.stringify(p) === JSON.stringify(q)
  })())
}

console.log('E2E 4：SENT-0003 关键词继续产生自己的热度结果')
{
  const before = getDomain().heat.filter((h) => h.planId === 3).length
  const r = ingestHeat({ requestId: 'e2e-sent3', planId: 3, heat: 61, tendency: '正面', source: '应用商店评论' })
  check('SENT-0003 热度生成成功', r.ok === true)
  check('SENT-0003 热度 +1', getDomain().heat.filter((h) => h.planId === 3).length === before + 1)
}

console.log('E2E 5：两路同标识请求只保留首个完整预警编号')
{
  // 重置到迁移后的干净现场，避免上一组产生的未结预警干扰发号判断
  resetSentimentDomain()
  const first = ingestHeat({ requestId: 'e2e-race', planId: 3, heat: 88, tendency: '负面', source: 'A路' })
  const code = first.state.alerts.find((a) => a.sourceRequestId === 'e2e-race')?.code
  const alertCount = getDomain().alerts.length
  const second = ingestHeat({ requestId: 'e2e-race', planId: 3, heat: 91, tendency: '负面', source: 'B路' })
  check('首路发号成功', typeof code === 'string' && code!.startsWith('OPSA-0003-A'))
  check('后到请求被拒', second.ok === false)
  check('预警编号数量不变', getDomain().alerts.length === alertCount)
  check('后到结论引用首个编号', listConclusions().at(-1)!.alertCode === code)
}

console.log(`\nE2E 结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
