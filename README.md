# Hydro Contest Scoreboard Exporter

> 一个适配所有基于 [Hydro](https://github.com/hydro-dev/Hydro) 的 OJ 的篡改猴（Tampermonkey）脚本：在比赛列表中多选比赛，一键导出成绩表；也可以在成绩表页面直接导出当前场次。

支持导出 **TXT / CSV / JSON**，保留原始成绩表的全部列，不做排名重算，也不修改网站数据。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Userscript-00a65a.svg)](https://www.tampermonkey.net/)

## 功能

- **比赛列表批量导出**：在任意 Hydro OJ 的 `/contest` 或 `/d/<domain>/contest` 页面，为每场比赛添加“选择”复选框。
- **跨页选择**：翻页后已选比赛不会丢失；也可以“全选本页”或“全选所有页”。
- **成绩表页单场导出**：打开比赛的“成绩表”页面，直接导出当前成绩表。
- **比赛详情页导出**：在比赛详情页点击导出，脚本会自动抓取该场比赛的成绩表。
- **保留全部列**：不假设只有 A/B/C/D 四题，自动适配不同题目数量、不同规则（IOI/OI/ACM 等）和自定义列。
- **三种格式**：
  - `TXT`：适合直接阅读、打印或粘贴；
  - `CSV`：UTF-8 BOM，Excel 可直接打开；
  - `JSON`：适合程序处理。
- **失败可见**：某场比赛未公开、未开始或登录失效时，会在面板和 TXT/JSON 的错误区中注明原因。

## 安装

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)（Edge / Chrome / Firefox 均可）。
2. 点击安装脚本：

   **[安装 Hydro Contest Scoreboard Exporter](https://raw.githubusercontent.com/GX6zm/hydro-contest-score-exporter/main/hydro-contest-score-exporter.user.js)**

3. 在 Tampermonkey 的安装页面点击“安装”。

脚本会通过 `@updateURL` 自动检查 GitHub 上的更新。

> 如果此前安装过只针对某个 OJ 的专用导出脚本，建议在 Tampermonkey 中禁用，避免出现重复的复选框和悬浮面板。

## 使用

### 批量导出多场比赛

1. 打开 OJ 的比赛列表页，例如：
   - `https://hydro.ac/contest`
   - `https://your-oj.example/d/domain/contest`
   - 作业列表 `/homework` 同样支持。
2. 每场比赛右侧会出现“选择”复选框；勾选需要的比赛。
3. 右下角面板会显示已选数量：
   - **全选本页 / 取消本页**
   - **全选所有页**：自动扫描分页并选中全部比赛
   - **清空已选**
4. 点击 **导出 TXT / CSV / JSON**。

### 导出单场比赛

- 打开某场比赛的“成绩表”页面（URL 包含 `/scoreboard`），点击面板中的导出按钮。
- 或者打开比赛详情页，点击导出；脚本会自动请求该场比赛的成绩表。

## 支持范围

面向所有基于 Hydro 的在线评测系统编写，包括但不限于：

- 官方 [hydro.ac](https://hydro.ac)
- 自建 Hydro / HydroOJ 站点
- 使用 Hydro 二次开发、保留 Hydro 路由和成绩表结构的 OJ（例如云斗学院）

已实际测试：

- `https://hydro.ac`（公开比赛列表、成绩表、5 题成绩表）
- `https://yundouxueyuan.com/d/NOIPC/contest`（自定义主题、4 题成绩表）

支持的路由：

- `/contest`
- `/d/<domain>/contest`
- `/homework`
- `/d/<domain>/homework`
- 上述路由的分页 `?page=N`
- `.../contest/<id>/scoreboard`
- `.../homework/<id>/scoreboard`

## 导出格式

### TXT

按比赛分区块，包含比赛标题、链接、域名、类型和完整成绩表。表格列宽按中英文显示宽度对齐。

### CSV

第一行是表头，包含：

```text
比赛,比赛链接,域名,类型,<成绩表原始列...>
```

不同比赛列数不同时，会取所有比赛列的并集；某场比赛没有的列留空。

### JSON

```json
{
  "generator": "Hydro Contest Scoreboard Exporter",
  "version": "1.0.1",
  "exportedAt": "2026-11-10T05:00:00.000Z",
  "contests": [
    {
      "title": "比赛名称",
      "url": "https://hydro.ac/contest/...",
      "domain": "system",
      "type": "contest",
      "columns": ["#", "用户", "总分数", "A", "B"],
      "rows": [
        { "#": "1", "用户": "user", "总分数": "100", "A": "100", "B": "0" }
      ]
    }
  ],
  "errors": []
}
```

## 权限与隐私

- 脚本使用 `@grant none`，只通过当前页面的同源 `fetch` 读取成绩表，不向任何第三方服务器发送数据。
- 所有导出均在浏览器本地生成，文件直接下载到本机。
- 不读取、不上传 Cookie、密码或其它账号信息。
- `@match *://*/*` 是为了兼容任意自建 Hydro 域名；脚本只在检测到 Hydro 比赛/作业页面时才显示界面。

## 已知限制

- 只能导出**当前账号有权查看**的成绩表；隐藏、未开始或未解冻的成绩表无法绕过。
- 如果站点使用了完全不同的前端主题、移除了 `.contest__item` / `.contest__title` 等结构，列表选择可能退化；脚本会尝试按链接兜底，但建议提交 Issue 并附上页面结构。
- 成绩表很大时（数千行、几十场比赛），导出需要几秒到几十秒；脚本默认 2 个并发请求。
- CSV/JSON 是原始成绩表导出，不会自动计算“全国榜”或跨场去重；需要合并排名时请自行处理。

## 开发

脚本是单文件原生 JavaScript，无构建步骤：

```text
hydro-contest-score-exporter.user.js
```

本地调试：

1. 在 Tampermonkey 中新建脚本，粘贴文件内容；
2. 或启动本地静态服务器，打开 `.user.js` 文件，让 Tampermonkey 弹出安装页：

   ```bash
   python -m http.server 8765
   ```

3. 在 Hydro 站点的比赛列表 / 成绩表页刷新测试。

欢迎提交 Issue 或 PR，附上：

- OJ 地址（可公开的测试站）
- 页面类型（列表 / 成绩表 / 详情）
- 浏览器与 Tampermonkey 版本
- 控制台报错或页面结构截图

## License

[MIT](LICENSE)
