import type { SentimentDomainState } from './types'

/**
 * 领域初始数据（修复前的故障现场）：
 * - SENT-0002 仍是「已启用」，规则 OPSA-0002 已生效，且存在一条未结预警和持续升级的热度；
 *   业务上该方案应当被停用——由启动迁移调用修复后的停用事务一次性纠正。
 * - SENT-0003 正常「已启用」，关键词集合继续产生自己的热度，迁移不得波及它。
 * - SENT-0001 还在草稿态，用来证明未评审/未启用的方案不能触发预警。
 */
export function buildInitialDomainState(now = '2026-11-14T09:00:00.000Z'): SentimentDomainState {
  return {
    stateVersion: 1,
    migrations: [],
    plans: [
      {
        id: 1,
        code: 'SENT-0001',
        topic: '数据看板卡顿投诉',
        dataSource: '客服工单 / 应用商店评论',
        heatThreshold: 60,
        pushFrequency: '每日',
        product: '数据看板',
        status: '草稿',
        sealed: false,
        keywordVersions: [
          { version: 1, keywords: ['看板', '卡顿', '加载慢'], updatedAt: '2026-11-01T08:00:00.000Z', note: '初稿关键词' },
        ],
        activeKeywordVersion: 1,
        ruleId: null,
        createdAt: '2026-11-01T08:00:00.000Z',
        updatedAt: '2026-11-01T08:00:00.000Z',
      },
      {
        id: 2,
        code: 'SENT-0002',
        topic: '归因报告口径争议',
        dataSource: '微博 / 行业社群 / 客服工单',
        heatThreshold: 70,
        pushFrequency: '每4小时',
        product: '归因分析平台',
        // 故障现场：本应停用却仍处于已启用，导致预警规则持续产出热度并升级
        status: '已启用',
        sealed: false,
        keywordVersions: [
          { version: 1, keywords: ['归因', '口径', '对不上'], updatedAt: '2026-11-02T08:00:00.000Z', note: '初版关键词' },
          { version: 2, keywords: ['归因', '口径', '对不上', '数据打架'], updatedAt: '2026-11-08T08:00:00.000Z', note: '补充“数据打架”' },
        ],
        activeKeywordVersion: 2,
        ruleId: 2,
        createdAt: '2026-11-02T08:00:00.000Z',
        updatedAt: '2026-11-08T08:00:00.000Z',
      },
      {
        id: 3,
        code: 'SENT-0003',
        topic: '新版看板上线口碑',
        dataSource: '应用商店评论 / 站内反馈',
        heatThreshold: 55,
        pushFrequency: '每2小时',
        product: '数据看板',
        status: '已启用',
        sealed: false,
        keywordVersions: [
          { version: 1, keywords: ['新版', '看板', '好用'], updatedAt: '2026-11-03T08:00:00.000Z', note: '初版关键词' },
        ],
        activeKeywordVersion: 1,
        ruleId: 3,
        createdAt: '2026-11-03T08:00:00.000Z',
        updatedAt: '2026-11-03T08:00:00.000Z',
      },
    ],
    rules: [
      {
        id: 1,
        code: 'OPSA-0001',
        planId: 1,
        metric: '舆情热度',
        operator: '>=',
        threshold: 60,
        periods: 2,
        level: '三级',
        notifyTarget: '产品值班群',
        escalation: '连续2周期超阈值升二级',
        status: '草稿',
        keywordVersion: 1,
        conditionText: '舆情热度 >= 60 持续2周期（关键词集合 v1）',
        updatedAt: '2026-11-01T08:00:00.000Z',
      },
      {
        id: 2,
        code: 'OPSA-0002',
        planId: 2,
        metric: '舆情热度',
        operator: '>=',
        threshold: 70,
        periods: 1,
        level: '三级',
        notifyTarget: '归因产品负责人 / 值班群',
        escalation: '每持续1个周期热度再超阈值则升一级',
        status: '已生效',
        // 规则仍停留在 v1，而方案已到 v2：用于验证预警生成前的版本核对
        keywordVersion: 1,
        conditionText: '舆情热度 >= 70 持续1周期（关键词集合 v1）',
        updatedAt: '2026-11-02T08:00:00.000Z',
      },
      {
        id: 3,
        code: 'OPSA-0003',
        planId: 3,
        metric: '舆情热度',
        operator: '>=',
        threshold: 55,
        periods: 2,
        level: '三级',
        notifyTarget: '看板产品群',
        escalation: '连续2周期超阈值升二级',
        status: '已生效',
        keywordVersion: 1,
        conditionText: '舆情热度 >= 55 持续2周期（关键词集合 v1）',
        updatedAt: '2026-11-03T08:00:00.000Z',
      },
    ],
    heat: [
      { id: 1, planId: 2, keywordVersion: 1, heat: 72, tendency: '负面', source: '微博', createdAt: '2026-11-09T08:00:00.000Z' },
      { id: 2, planId: 2, keywordVersion: 2, heat: 78, tendency: '负面', source: '行业社群', createdAt: '2026-11-10T08:00:00.000Z' },
      { id: 3, planId: 2, keywordVersion: 2, heat: 85, tendency: '负面', source: '客服工单', createdAt: '2026-11-11T08:00:00.000Z' },
      { id: 4, planId: 3, keywordVersion: 1, heat: 48, tendency: '正面', source: '应用商店评论', createdAt: '2026-11-12T08:00:00.000Z' },
    ],
    alerts: [
      {
        id: 1,
        code: 'OPSA-0002-A001',
        ruleId: 2,
        planId: 2,
        keywordVersion: 2,
        level: '二级',
        status: '未结',
        heat: 85,
        sourceRequestId: 'seed-req-0002',
        createdAt: '2026-11-11T08:05:00.000Z',
        closedAt: null,
        escalations: [
          { at: '2026-11-10T08:05:00.000Z', fromLevel: '三级', toLevel: '二级', heat: 78, note: '热度连续超阈值，自动升级' },
        ],
      },
    ],
    conclusions: [
      {
        id: 1,
        at: '2026-11-11T08:05:00.000Z',
        requestId: 'seed-req-0002',
        planId: 2,
        ruleId: 2,
        passed: true,
        reason: '方案已启用、规则已生效，关键词版本核对通过，生成预警',
        keywordVersion: 2,
        alertCode: 'OPSA-0002-A001',
      },
    ],
    counters: { heat: 4, alert: 1, conclusion: 1 },
  }
}
