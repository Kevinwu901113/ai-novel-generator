# apps/desktop — 已退役（B12），B13 整体删除

WebUI 迁移（decision-log D11）后本目录只剩过渡空壳：

- `src/renderer` 已于 B12 迁往 `apps/web`（git mv，历史保留）；
- `build` / `typecheck` 已收缩为 noop（renderer 迁出后本包不可再构建为完整应用）；
- `src/main` / `src/preload` 及其测试暂留作 B12 期间的行为参照，**B13 连同本目录、
  Electron 依赖、打包脚本一并删除**（删除清单见 `docs/development/b13-electron-removal-design.md`）。

不要在本目录新增任何功能。
