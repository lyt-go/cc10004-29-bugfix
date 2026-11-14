/**
 * 舆情预警联动验收脚本（不参与前端构建，由 verify-domain.sh 用 esbuild 打包后 node 运行）。
 * 覆盖：生命周期单向/封存终态、先评审后启用、版本核对、停用事务原子性、
 * 历史保留、连续停用/两路生成只保留首个完整预警编号、SENT-0002 迁移修复、SENT-0003 不受波及。
 */
import {
  closeAlert,
  disablePlan,
  enablePlan,
  generateHeat,
  submitPlanReview,
  updateKeywords,
  updateRule,
} from '../frontend/src/data/sentiment/engine'
import { buildInitialDomainState } from '../frontend/src/data/sentiment/seed'
import { applyMigrationsForTest } from '../frontend/src/data/sentiment/migration-test'
import type { SentimentDomainState } from '../frontend/src/data/sentiment/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function stateAfterMigration(): SentimentDomainState {
  return applyMigrationsForTest(buildInitialDomainState())
}

console.log('一、迁移修复：SENT-0002 停用封存，OPSA-0002 未结预警转历史')
{
  const s = stateAfterMigration()
  const sent2 = s.plans.find((p) => p.code === 'SENT-0002')!
  check('SENT-0002 状态为已停用', sent2.status === '已停用')
  check('SENT-0002 已封存（终态）', sent2.sealed === true)
  const rule2 = s.rules.find((r) => r.code === 'OPSA-0002')!
  check('OPSA-0002 规则已关闭', rule2.status === '已关闭')
  check('OPSA-0002 规则关键词版本已对齐到 v2', rule2.keywordVersion === 2)
  const a001 = s.alerts.find((a) => a.code === 'OPSA-0002-A001')!
  check('OPSA-0002-A001 已关闭转入历史', a001.status === '已关闭' && a001.closedAt !== null)
  check('历史升级记录保留', a001.escalations.length === 1 && a001.escalations[0].toLevel === '二级')
  const sent2HeatCount = s.heat.filter((h) => h.planId === 2).length
  check('历史情感倾向/热度记录保留（3条）', sent2HeatCount === 3)

  const sent3 = s.plans.find((p) => p.code === 'SENT-0003')!
  check('SENT-0003 仍然已启用、未封存', sent3.status === '已启用' && sent3.sealed === false)
  const rule3 = s.rules.find((r) => r.code === 'OPSA-0003')!
  check('OPSA-0003 仍然已生效', rule3.status === '已生效')
}

console.log('二、停用后停止新增热度与预警，只留核对结论')
{
  const s0 = stateAfterMigration()
  const before = { heat: s0.heat.length, alerts: s0.alerts.length, conclusions: s0.conclusions.length }
  const r = generateHeat(s0, {
    requestId: 'late-1', planId: 2, heat: 99, tendency: '负面', source: '微博', now: '2026-11-14T10:00:00.000Z',
  })
  check('停用后生成请求被拒', r.ok === false)
  check('不新增热度', r.state.heat.length === before.heat)
  check('不新增预警', r.state.alerts.length === before.alerts)
  check('只新增一条核对结论', r.state.conclusions.length === before.conclusions + 1)
  const c = r.state.conclusions[r.state.conclusions.length - 1]
  check('结论标记不通过且原因含停用封存', c.passed === false && c.reason.includes('停用封存'))
}

console.log('三、连续停用：已封存再停用，不改数据，仅记录核对结论')
{
  const s0 = stateAfterMigration()
  const r1 = disablePlan(s0, 2, '2026-11-14T11:00:00.000Z')
  check('重复停用被拒绝', r1.ok === false)
  check('重复停用返回同一状态引用（无写入）', r1.state === s0)
}

console.log('四、封存终态不可恢复，生命周期单向流转')
{
  const s0 = stateAfterMigration()
  const r1 = enablePlan(s0, 2, '2026-11-14T11:00:00.000Z')
  check('封存方案不能重新启用', r1.ok === false && r1.state === s0)
  const r2 = submitPlanReview(s0, 2, '2026-11-14T11:00:00.000Z')
  check('封存方案不能回到评审中', r2.ok === false)

  // 草稿方案不能直接启用
  const r3 = enablePlan(s0, 1, '2026-11-14T11:00:00.000Z')
  check('草稿方案未评审不能启用', r3.ok === false)
  const s1 = submitPlanReview(s0, 1, '2026-11-14T11:00:00.000Z')
  check('草稿可提交评审', s1.ok)
  const s2 = enablePlan(s1.state, 1, '2026-11-14T11:05:00.000Z')
  check('评审通过后可启用', s2.ok && s2.state.plans[0].status === '已启用')
  // 回退被禁止
  const r4 = submitPlanReview(s2.state, 1, '2026-11-14T11:06:00.000Z')
  check('已启用不能回到评审中（禁止回退）', r4.ok === false)

  // 跨阶段跳转被禁止（从新草稿方案直接启用）
  const r5 = enablePlan(stateAfterMigration(), 1, '2026-11-14T11:07:00.000Z')
  check('草稿不能跨评审直接启用（禁止跳阶段）', r5.ok === false && r5.message.includes('评审'))
}

console.log('五、预警生成前核对关键词集合版本')
{
  let s = stateAfterMigration()
  // SENT-0003 规则与方案都在 v1，核对通过，先造一次未超阈值热度
  const low = generateHeat(s, { requestId: 'h1', planId: 3, heat: 40, tendency: '正面', source: '评论', now: '2026-11-14T12:00:00.000Z' })
  check('未超阈值：记热度不发预警', low.ok && low.state.alerts.length === s.alerts.length)
  s = low.state

  // 更新 SENT-0003 关键词到 v2（规则同步对齐，验证规则更新联动）
  const upd = updateKeywords(s, 3, ['新版', '看板', '好用', '真香'], '补充真香', '2026-11-14T12:10:00.000Z')
  check('关键词更新追加 v2 且历史 v1 保留', upd.ok && upd.state.plans[2].keywordVersions.length === 2 && upd.state.plans[2].activeKeywordVersion === 2)
  check('关联规则同步对齐到 v2', upd.state.rules.find((r) => r.id === 3)!.keywordVersion === 2)
  s = upd.state

  // 人为把规则回退到旧版本，模拟版本漂移：生成必须被拦下
  const drifted = JSON.parse(JSON.stringify(s)) as SentimentDomainState
  drifted.rules.find((r) => r.id === 3)!.keywordVersion = 1
  const blocked = generateHeat(drifted, { requestId: 'h2', planId: 3, heat: 88, tendency: '负面', source: '评论', now: '2026-11-14T12:20:00.000Z' })
  check('版本不一致时拒绝生成且只记结论', blocked.ok === false && blocked.state.heat.length === s.heat.length && blocked.state.conclusions.length === drifted.conclusions.length + 1)
  check('结论说明版本不一致', blocked.state.conclusions.at(-1)!.reason.includes('版本不一致'))

  // 规则更新（阈值）会重新对齐版本
  const realigned = updateRule(s, 3, { threshold: 50 }, '2026-11-14T12:30:00.000Z')
  check('规则更新后版本对齐、条件文案刷新', realigned.state.rules[2].keywordVersion === 2 && realigned.state.rules[2].conditionText.includes('v2'))
  const fired = generateHeat(realigned.state, { requestId: 'h3', planId: 3, heat: 88, tendency: '负面', source: '评论', now: '2026-11-14T12:40:00.000Z' })
  check('版本一致且超阈值：生成完整预警编号', fired.ok && fired.state.alerts.some((a) => a.ruleId === 3 && a.code === 'OPSA-0003-A001'))
  check('预警快照生成时关键词版本 v2', fired.state.alerts.at(-1)!.keywordVersion === 2)
}

console.log('六、两路生成并发：只保留首个完整预警编号，后到请求仅记核对结论')
{
  const s0 = stateAfterMigration()
  // 用 SENT-0003（启用中），同一 requestId 模拟两路同时打到同一规则
  const first = generateHeat(s0, { requestId: 'race-1', planId: 3, heat: 77, tendency: '负面', source: 'A路', now: '2026-11-14T13:00:00.000Z' })
  check('首路生成完整预警', first.ok && first.state.alerts.some((a) => a.sourceRequestId === 'race-1'))
  const firstCode = first.state.alerts.find((a) => a.sourceRequestId === 'race-1')!.code
  const second = generateHeat(first.state, { requestId: 'race-1', planId: 3, heat: 90, tendency: '负面', source: 'B路', now: '2026-11-14T13:00:01.000Z' })
  check('后到请求被拒', second.ok === false)
  check('不新增预警编号', second.state.alerts.length === first.state.alerts.length)
  check('后到请求只新增核对结论', second.state.conclusions.length === first.state.conclusions.length + 1)
  check('结论引用首个完整预警编号', second.state.conclusions.at(-1)!.alertCode === firstCode)
}

console.log('七、同一监控主题只允许一个当前未结预警，升级复用编号')
{
  const s0 = stateAfterMigration()
  const a1 = generateHeat(s0, { requestId: 'u1', planId: 3, heat: 77, tendency: '负面', source: 'x', now: '2026-11-14T14:00:00.000Z' })
  const code1 = a1.state.alerts.find((a) => a.planId === 3 && a.status !== '已关闭')!.code
  const a2 = generateHeat(a1.state, { requestId: 'u2', planId: 3, heat: 82, tendency: '负面', source: 'x', now: '2026-11-14T14:30:00.000Z' })
  const open = a2.state.alerts.filter((a) => a.planId === 3 && a.status !== '已关闭')
  check('只有一个当前未结预警', open.length === 1)
  check('升级复用原编号', open[0].code === code1)
  check('级别按三级→二级单向升级', open[0].level === '二级' && open[0].status === '已升级')
  check('升级记录追加', open[0].escalations.length === 1)
  const a3 = generateHeat(a2.state, { requestId: 'u3', planId: 3, heat: 90, tendency: '负面', source: 'x', now: '2026-11-14T15:00:00.000Z' })
  check('继续升级到一级', a3.state.alerts.find((a) => a.id === open[0].id)!.level === '一级')
  const closed = closeAlert(a3.state, open[0].id, '2026-11-14T15:30:00.000Z')
  check('关闭后进入历史', closed.state.alerts.find((a) => a.id === open[0].id)!.status === '已关闭')
  const a4 = generateHeat(closed.state, { requestId: 'u4', planId: 3, heat: 66, tendency: '负面', source: 'x', now: '2026-11-14T16:00:00.000Z' })
  check('历史预警关闭后再次超阈值才发新号 A002', a4.state.alerts.some((a) => a.code === 'OPSA-0003-A002'))
}

console.log('八、停用事务原子性：停用/关闭/规则更新同一份状态')
{
  // 取迁移前的故障现场，直接验证 disablePlan 一次调用改三处
  const raw = buildInitialDomainState()
  const r = disablePlan(raw, 2, '2026-11-14T09:05:00.000Z')
  check('一次调用成功', r.ok)
  check('方案停用封存', r.state.plans[1].status === '已停用' && r.state.plans[1].sealed)
  check('未结预警同批关闭', r.state.alerts[0].status === '已关闭')
  check('规则同批关闭并对齐版本', r.state.rules[1].status === '已关闭' && r.state.rules[1].keywordVersion === 2)
  check('输入状态未被原地修改（纯函数）', raw.plans[1].status === '已启用')
}

console.log('九、历史预警按生成时快照的关键词版本解释')
{
  const s = stateAfterMigration()
  const a001 = s.alerts.find((a) => a.code === 'OPSA-0002-A001')!
  check('历史预警保留生成时 v2 快照，不随后续版本变化改写', a001.keywordVersion === 2)
  const oldHeat = s.heat.filter((h) => h.planId === 2)
  check('历史热度各自保留生成时版本（v1/v2 并存）', oldHeat.some((h) => h.keywordVersion === 1) && oldHeat.some((h) => h.keywordVersion === 2))
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
