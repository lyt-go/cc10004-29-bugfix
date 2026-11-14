/** 供验收脚本复用迁移纯函数（应用代码走 store.ts，测试不经 localStorage）。 */
export { applyMigrations as applyMigrationsForTest } from './migration'
