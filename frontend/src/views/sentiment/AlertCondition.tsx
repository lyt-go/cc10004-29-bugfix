import type { AlertRule } from '@/data/sentiment/types'

/**
 * 预警条件的唯一渲染出口：舆情详情页和运营预警列表都用它，
 * 从根上消除「两个页面预警条件对不上」的问题。
 */
export default function AlertCondition({ rule }: { rule: AlertRule }) {
  return (
    <span className="alert-condition" title={`规则绑定关键词集合 v${rule.keywordVersion}`}>
      {rule.conditionText}
    </span>
  )
}
