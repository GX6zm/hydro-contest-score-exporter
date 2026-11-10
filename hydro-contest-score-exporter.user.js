// ==UserScript==
// @name         Hydro 比赛成绩导出
// @name:en      Hydro Contest Scoreboard Exporter
// @namespace    https://github.com/GX6zm/hydro-contest-score-exporter
// @version      1.0.1
// @description  在任意基于 Hydro 的 OJ 上勾选比赛，批量导出成绩表（TXT / CSV / JSON）
// @description:en  Export contest scoreboards from any Hydro-based online judge as TXT, CSV or JSON.
// @author       GX6zm
// @license      MIT
// @homepageURL  https://github.com/GX6zm/hydro-contest-score-exporter
// @supportURL   https://github.com/GX6zm/hydro-contest-score-exporter/issues
// @updateURL    https://raw.githubusercontent.com/GX6zm/hydro-contest-score-exporter/main/hydro-contest-score-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/GX6zm/hydro-contest-score-exporter/main/hydro-contest-score-exporter.user.js
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.1';
  const PANEL_ID = 'hydro-score-exporter-panel';
  const STYLE_ID = 'hydro-score-exporter-style';
  const STORAGE_PREFIX = 'hydro-score-exporter:';
  const CONCURRENCY = 2;
  const REQUEST_GAP = 120;
  const MAX_PAGES = 100;

  const state = {
    info: null,
    mode: null,
    selected: new Map(),
    pageItems: new Map(),
    busy: false,
    lastHref: location.href,
  };
  let retryTimer = 0;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                           */
  /* ------------------------------------------------------------------ */

  function clean(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getUiContext() {
    try {
      const raw = window.UiContext;
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return null;
    }
  }

  function typeLabel(kind) {
    return kind === 'homework' ? '作业' : '比赛';
  }

  function safeName(value) {
    return String(value || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function stamp(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
      + `-${p(date.getHours())}${p(date.getMinutes())}`;
  }

  function displayWidth(value) {
    let width = 0;
    for (const ch of String(value)) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x1100 && cp <= 0x115f)
        || (cp >= 0x2e80 && cp <= 0xa4cf)
        || (cp >= 0xac00 && cp <= 0xd7a3)
        || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0xfe10 && cp <= 0xfe19)
        || (cp >= 0xfe30 && cp <= 0xfe6f)
        || (cp >= 0xff00 && cp <= 0xff60)
        || (cp >= 0xffe0 && cp <= 0xffe6)
        || (cp >= 0x1f300 && cp <= 0x1faff)
      ) width += 2;
      else width += 1;
    }
    return width;
  }

  function padDisplay(value, width, align) {
    const text = String(value);
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    if (align === 'right') return ' '.repeat(gap) + text;
    if (align === 'center') {
      const left = Math.floor(gap / 2);
      return ' '.repeat(left) + text + ' '.repeat(gap - left);
    }
    return text + ' '.repeat(gap);
  }

  function csvEscape(value) {
    const text = String(value == null ? '' : value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  /* ------------------------------------------------------------------ */
  /* 页面识别                                                           */
  /* ------------------------------------------------------------------ */

  function isHydroPage() {
    if (document.documentElement.dataset.app === 'Hydro') return true;
    if (typeof window.UiContext !== 'undefined') return true;
    const page = document.documentElement.dataset.page || '';
    if (/^(contest|homework)_(main|detail|scoreboard)/.test(page)) return true;
    return !!document.querySelector('.contest__list, .contest__item')
      && !!document.querySelector('a[href*="/contest/"], a[href*="/homework/"]');
  }

  function getPageInfo() {
    const page = document.documentElement.dataset.page || '';
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const context = getUiContext() || {};
    const domain = (path.match(/\/d\/([^/]+)\//) || [])[1]
      || context.domainId
      || '';
    const kind = /^homework/.test(page) || /\/homework(?:\/|$)/.test(path)
      ? 'homework'
      : 'contest';
    const idMatch = path.match(/\/(?:contest|homework)\/([0-9a-f]{24})(?:\/|$)/i)
      || path.match(/\/([0-9a-f]{24})(?:\/|$)/);
    const tid = idMatch
      ? idMatch[1]
      : (context.tdoc && (context.tdoc.docId || context.tdoc._id)) || '';
    const isList = page === 'contest_main'
      || page === 'homework_main'
      || (!tid && /^\/(?:d\/[^/]+\/)?(?:contest|homework)\/?$/.test(path));
    const isScoreboard = /scoreboard/i.test(page)
      || /\/scoreboard(?:\/|$)/i.test(path);
    return {
      page,
      path,
      domain,
      kind,
      tid,
      isList,
      isScoreboard,
      isCurrent: !!tid,
    };
  }

  function scoreboardUrl(contestHref) {
    const url = new URL(contestHref, location.href);
    url.pathname = url.pathname
      .replace(/\/scoreboard(?:\/.*)?$/i, '')
      .replace(/\/+$/, '') + '/scoreboard';
    url.search = '';
    url.hash = '';
    return url.href;
  }

  function contestHrefFromLocation() {
    const url = new URL(location.href);
    url.pathname = url.pathname
      .replace(/\/scoreboard(?:\/.*)?$/i, '')
      .replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  }

  function currentMeta() {
    const context = getUiContext() || {};
    let title = clean(context.tdoc && context.tdoc.title);
    if (!title) {
      const element = document.querySelector('.section__title, .contest__title, h1');
      if (element) {
        const clone = element.cloneNode(true);
        clone.querySelectorAll('a.button, button, .section__tools, .hse-pick').forEach((node) => node.remove());
        title = clean(clone.textContent);
      }
    }
    if (!title) {
      title = clean(document.title.replace(/\s*[-|–—]\s*Hydro.*$/i, '')) || '成绩表';
    }
    return {
      key: `${state.info.domain || ''}|${state.info.kind}|${state.info.tid || 'current'}`,
      tid: state.info.tid,
      title,
      href: contestHrefFromLocation(),
      domain: state.info.domain,
      kind: state.info.kind,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 列表扫描                                                           */
  /* ------------------------------------------------------------------ */

  function contestMetaFromLink(link, info, base) {
    let url;
    try {
      url = new URL(link.getAttribute('href'), base || location.href);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/i.test(url.protocol)) return null;
    const match = url.pathname.match(/\/(contest|homework)\/([0-9a-f]{24})(?:\/|$)/i);
    if (!match || /\/scoreboard(?:\/|$)/i.test(url.pathname)) return null;
    const domain = (url.pathname.match(/\/d\/([^/]+)\//) || [])[1] || info.domain || '';
    const kind = match[1].toLowerCase();
    const tid = match[2];
    return {
      key: `${domain}|${kind}|${tid}`,
      tid,
      title: clean(link.textContent) || tid,
      href: `${url.origin}${url.pathname}`,
      domain,
      kind,
    };
  }

  function collectPageItems(doc, info) {
    const items = new Map();
    const base = location.href;
    const nodes = [...doc.querySelectorAll('.contest__item')];

    if (nodes.length) {
      for (const node of nodes) {
        const link = node.querySelector(
          '.contest__title a[href*="/contest/"], .contest__title a[href*="/homework/"], '
          + 'a[href*="/contest/"], a[href*="/homework/"]',
        );
        if (!link) continue;
        const meta = contestMetaFromLink(link, info, base);
        if (!meta) continue;
        const titleNode = node.querySelector('.contest__title');
        if (titleNode) {
          const clone = titleNode.cloneNode(true);
          clone.querySelectorAll('.hse-pick').forEach((label) => label.remove());
          const titleText = clean(clone.textContent);
          if (titleText) meta.title = titleText;
        }
        items.set(meta.key, meta);
      }
      return items;
    }

    const seen = new Set();
    for (const link of doc.querySelectorAll('a[href]')) {
      if (link.closest('.pager, .pagination, .nav, .menu, .footer, .section__tools')) continue;
      const meta = contestMetaFromLink(link, info, base);
      if (!meta || seen.has(meta.key)) continue;
      seen.add(meta.key);
      if (!clean(link.textContent)) {
        const container = link.closest('li, article, .section__list__item, .media, .row');
        const heading = container && container.querySelector('h1, h2, h3, .contest__title');
        if (heading) meta.title = clean(heading.textContent) || meta.title;
      }
      items.set(meta.key, meta);
    }
    return items;
  }

  function getLastPage(doc) {
    let last = 1;
    doc.querySelectorAll('.pager a[href], .pagination a[href]').forEach((link) => {
      try {
        const url = new URL(link.getAttribute('href'), location.href);
        const page = Number(url.searchParams.get('page'));
        if (Number.isFinite(page) && page > last) last = page;
        const pathMatch = url.pathname.match(/\/page\/(\d+)/i);
        if (pathMatch) last = Math.max(last, Number(pathMatch[1]));
      } catch (error) {
        /* ignore */
      }
    });
    return Math.min(Math.max(last, 1), MAX_PAGES);
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async function collectAllContests() {
    const info = state.info;
    const firstUrl = new URL(location.href);
    firstUrl.searchParams.delete('page');
    firstUrl.hash = '';

    const firstHtml = await fetchText(firstUrl.href);
    const firstDoc = new DOMParser().parseFromString(firstHtml, 'text/html');
    const lastPage = getLastPage(firstDoc);
    const all = new Map();

    for (let page = 1; page <= lastPage; page += 1) {
      setStatus(`正在扫描列表页 ${page}/${lastPage}…`, Math.round((page / lastPage) * 100));
      let doc = firstDoc;
      if (page > 1) {
        const url = new URL(firstUrl.href);
        url.searchParams.set('page', String(page));
        const html = await fetchText(url.href);
        doc = new DOMParser().parseFromString(html, 'text/html');
      }
      const items = collectPageItems(doc, info);
      for (const [key, meta] of items) all.set(key, meta);
      await sleep(80);
    }
    return [...all.values()];
  }

  /* ------------------------------------------------------------------ */
  /* 成绩表解析                                                         */
  /* ------------------------------------------------------------------ */

  function headerText(th, index) {
    const parts = String(th.innerHTML || '')
      .split(/<br\s*\/?>/i)
      .map((part) => clean(part.replace(/<[^>]*>/g, ' ')));
    return clean(parts.join(' ')) || `列${index + 1}`;
  }

  function getCellText(cell) {
    if (cell.classList.contains('col--user') || cell.querySelector('.user-profile-name')) {
      const names = [...cell.querySelectorAll('.user-profile-name')]
        .map((node) => clean(node.textContent))
        .filter(Boolean);
      if (names.length) return [...new Set(names)].join(' / ');
    }
    return clean(cell.textContent);
  }

  function findScoreboardTable(doc) {
    const directTables = [...doc.querySelectorAll('table.data-table')];
    const withRows = directTables.find((table) => table.querySelector('tbody tr'));
    if (withRows) return withRows;
    if (directTables.length && !directTables.some((table) => table.querySelector('tbody'))) {
      return directTables[0];
    }
    const tables = [...doc.querySelectorAll('table')];
    let best = null;
    let bestScore = -1;
    for (const table of tables) {
      const headers = [...table.querySelectorAll('thead th')];
      const rows = [...table.querySelectorAll('tbody tr')];
      if (!headers.length || !rows.length) continue;
      const text = clean(table.textContent);
      let score = rows.length;
      if (/用户|user|排名|rank|总分|score/i.test(text)) score += 1000;
      if (score > bestScore) {
        best = table;
        bestScore = score;
      }
    }
    return best;
  }

  function parseScoreboard(root) {
    const doc = root && root.nodeType === 9 ? root : document;
    if (doc.documentElement.dataset.page === 'user_login') {
      throw new Error('登录状态已失效，请重新登录');
    }
    const table = findScoreboardTable(doc);
    if (!table) {
      const note = doc.querySelector('.note, .error, .section__body');
      throw new Error(clean(note ? note.textContent : '').slice(0, 160)
        || '未找到成绩表（可能未登录、比赛未开始或成绩表未公开）');
    }

    let headRow = table.querySelector('thead tr');
    let bodyRows = [...table.querySelectorAll('tbody tr')];

    if (!headRow && !bodyRows.length) {
      const first = table.querySelector('tr');
      if (first && first.querySelector('th')) headRow = first;
    }

    let columns = headRow
      ? [...headRow.querySelectorAll('th, td')].map((cell, index) => headerText(cell, index))
      : [];

    if (!columns.length) {
      const headerTable = [...doc.querySelectorAll('table.data-table')]
        .find((candidate) => candidate !== table && candidate.querySelector('thead th'));
      if (headerTable) {
        columns = [...headerTable.querySelectorAll('thead th')]
          .map((cell, index) => headerText(cell, index));
      }
    }

    if (!bodyRows.length) {
      const allRows = [...table.querySelectorAll('tr')];
      bodyRows = headRow ? allRows.filter((row) => row !== headRow) : allRows;
    }

    if (!columns.length) {
      const width = bodyRows[0] ? bodyRows[0].children.length : 0;
      columns = Array.from({ length: width }, (_, index) => `列${index + 1}`);
    }

    const rows = bodyRows
      .map((tr) => [...tr.querySelectorAll('td, th')].map(getCellText))
      .filter((row) => row.length && row.some((value) => value !== ''));

    const width = Math.max(columns.length, ...rows.map((row) => row.length), 0);
    while (columns.length < width) columns.push(`列${columns.length + 1}`);
    const normalized = rows.map((row) => {
      const copy = row.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });

    return { columns, rows: normalized };
  }

  async function fetchScoreboard(meta) {
    const html = await fetchText(scoreboardUrl(meta.href));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.querySelector('table.data-table') && doc.documentElement.dataset.page === 'user_login') {
      throw new Error('登录状态已失效，请重新登录');
    }
    return parseScoreboard(doc);
  }

  /* ------------------------------------------------------------------ */
  /* 导出格式                                                           */
  /* ------------------------------------------------------------------ */

  function uniqueHeaders(columns) {
    const seen = new Map();
    return columns.map((column, index) => {
      const base = clean(column) || `列${index + 1}`;
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base}#${count}`;
    });
  }

  function renderTable(columns, rows) {
    const headers = uniqueHeaders(columns);
    const widths = headers.map((header, index) => {
      let width = displayWidth(header);
      for (const row of rows) width = Math.max(width, displayWidth(row[index] || ''));
      return Math.max(width, 1);
    });
    const aligns = headers.map((_, index) => {
      if (index === 0) return 'center';
      const values = rows
        .map((row) => row[index])
        .filter((value) => value !== '' && value != null);
      if (values.length && values.every((value) => /^-?\d+(?:\.\d+)?$/.test(value))) return 'right';
      return 'left';
    });
    const line = (values) => values
      .map((value, index) => ` ${padDisplay(String(value).replace(/\|/g, '¦'), widths[index], aligns[index])} `)
      .join('|');
    const separator = widths.map((width) => '-'.repeat(width + 2)).join('+');
    const output = [line(headers), separator];
    for (const row of rows) output.push(line(row));
    return output.join('\r\n');
  }

  function buildTxt(results, errors) {
    const lines = [];
    lines.push('Hydro 比赛成绩表');
    lines.push(`导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    lines.push(`比赛数量：${results.length} 场${errors.length ? `（另有 ${errors.length} 场获取失败）` : ''}`);
    lines.push('');

    results.forEach((result, index) => {
      const { meta, columns, rows } = result;
      lines.push('='.repeat(90));
      lines.push(`【${index + 1}】${meta.title}`);
      lines.push(`链接：${meta.href}`);
      lines.push(`域名：${meta.domain || '默认'}   |   类型：${typeLabel(meta.kind)}`);
      lines.push('-'.repeat(90));
      lines.push(rows.length ? renderTable(columns, rows) : '（暂无成绩）');
      lines.push('');
    });

    if (errors.length) {
      lines.push('='.repeat(90));
      lines.push('以下比赛获取失败：');
      errors.forEach((failure, index) => {
        lines.push(`${index + 1}. ${failure.meta.title}`);
        lines.push(`   链接：${failure.meta.href}`);
        lines.push(`   原因：${failure.error}`);
      });
      lines.push('');
    }

    lines.push('说明：本文件导出的是网站原始成绩表，未重新计算排名或跨场去重。');
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  function buildCsv(results) {
    const metaHeaders = ['比赛', '比赛链接', '域名', '类型'];
    const allHeaders = [];
    const seen = new Set(metaHeaders);

    const prepared = results.map((result) => {
      const headers = uniqueHeaders(result.columns);
      headers.forEach((header) => {
        if (!seen.has(header)) {
          seen.add(header);
          allHeaders.push(header);
        }
      });
      return { result, headers };
    });

    const output = [[...metaHeaders, ...allHeaders]];
    for (const { result, headers } of prepared) {
      for (const row of result.rows) {
        const values = new Map(headers.map((header, index) => [header, row[index] || '']));
        output.push([
          result.meta.title,
          result.meta.href,
          result.meta.domain || '',
          typeLabel(result.meta.kind),
          ...allHeaders.map((header) => values.get(header) || ''),
        ]);
      }
    }

    return `\uFEFF${output.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
  }

  function buildJson(results, errors) {
    return `${JSON.stringify({
      generator: 'Hydro Contest Scoreboard Exporter',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      contests: results.map(({ meta, columns, rows }) => {
        const headers = uniqueHeaders(columns);
        return {
          title: meta.title,
          url: meta.href,
          domain: meta.domain,
          type: meta.kind,
          columns: headers,
          rows: rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || '']))),
        };
      }),
      errors: errors.map(({ meta, error }) => ({
        title: meta.title,
        url: meta.href,
        error,
      })),
    }, null, 2)}\n`;
  }

  function buildOutput(results, errors, format) {
    if (format === 'csv') return buildCsv(results);
    if (format === 'json') return buildJson(results, errors);
    return buildTxt(results, errors);
  }

  function downloadOutput(results, errors, format) {
    const content = buildOutput(results, errors, format);
    const mime = format === 'json'
      ? 'application/json;charset=utf-8'
      : format === 'csv'
        ? 'text/csv;charset=utf-8'
        : 'text/plain;charset=utf-8';
    const extension = format === 'json' ? 'json' : format;
    const date = new Date();
    const filename = results.length === 1
      ? `${safeName(results[0].meta.title) || '成绩表'}_成绩表_${stamp(date)}.${extension}`
      : `Hydro成绩表_${results.length}场_${stamp(date)}.${extension}`;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ------------------------------------------------------------------ */
  /* 选择状态                                                           */
  /* ------------------------------------------------------------------ */

  function storageKey(info) {
    return `${STORAGE_PREFIX}${location.origin}:${info.domain || 'default'}:${info.kind}`;
  }

  function loadSelection(info) {
    try {
      const raw = sessionStorage.getItem(storageKey(info));
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return new Map();
      return new Map(list
        .filter((item) => item && item.key && item.href && item.title)
        .map((item) => [item.key, item]));
    } catch (error) {
      return new Map();
    }
  }

  function saveSelection() {
    if (!state.info || !state.info.isList) return;
    try {
      sessionStorage.setItem(
        storageKey(state.info),
        JSON.stringify([...state.selected.values()]),
      );
    } catch (error) {
      /* ignore */
    }
  }

  function syncKey(key) {
    const checked = state.selected.has(key);
    document.querySelectorAll(`input[data-hse-key="${CSS.escape(key)}"]`).forEach((input) => {
      input.checked = checked;
      const item = input.closest('.contest__item');
      if (item) item.classList.toggle('hse-picked', checked);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 界面                                                               */
  /* ------------------------------------------------------------------ */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 18px;
        bottom: 64px;
        z-index: 2147483000;
        width: 330px;
        box-sizing: border-box;
        padding: 13px 14px;
        border: 1px solid rgba(255, 255, 255, .13);
        border-radius: 14px;
        background: rgba(27, 31, 38, .97);
        box-shadow: 0 14px 44px rgba(0, 0, 0, .48);
        color: #e8eaed;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        backdrop-filter: blur(14px);
      }
      #${PANEL_ID} .hse-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 5px;
      }
      #${PANEL_ID} .hse-head-title {
        font-size: 14px;
        font-weight: 650;
      }
      #${PANEL_ID} .hse-badge {
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        box-sizing: border-box;
        border-radius: 999px;
        background: #3b82f6;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        line-height: 22px;
        text-align: center;
      }
      #${PANEL_ID} .hse-current {
        margin: 4px 0 9px;
        color: #dbeafe;
        font-size: 12px;
        line-height: 1.45;
        word-break: break-word;
      }
      #${PANEL_ID} .hse-hint {
        margin-bottom: 9px;
        color: #9aa4b2;
        font-size: 12px;
      }
      #${PANEL_ID} .hse-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
        margin-bottom: 7px;
      }
      #${PANEL_ID} .hse-grid .hse-wide {
        grid-column: 1 / -1;
      }
      #${PANEL_ID} .hse-formats {
        display: grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        gap: 7px;
        margin-top: 7px;
      }
      #${PANEL_ID} button {
        min-height: 31px;
        padding: 6px 9px;
        border: 1px solid rgba(255, 255, 255, .14);
        border-radius: 8px;
        background: rgba(255, 255, 255, .06);
        color: #e8eaed;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        transition: background .15s ease, border-color .15s ease, opacity .15s ease;
      }
      #${PANEL_ID} button:hover:not(:disabled) {
        background: rgba(255, 255, 255, .13);
        border-color: rgba(255, 255, 255, .25);
      }
      #${PANEL_ID} button:disabled {
        opacity: .42;
        cursor: not-allowed;
      }
      #${PANEL_ID} button.hse-primary {
        border-color: #3b82f6;
        background: #3b82f6;
        color: #fff;
        font-weight: 650;
      }
      #${PANEL_ID} button.hse-primary:hover:not(:disabled) {
        background: #2f75e6;
        border-color: #2f75e6;
      }
      #${PANEL_ID} .hse-progress {
        display: none;
        margin-top: 10px;
      }
      #${PANEL_ID} .hse-progress.is-on {
        display: block;
      }
      #${PANEL_ID} .hse-bar {
        height: 4px;
        overflow: hidden;
        border-radius: 2px;
        background: rgba(255, 255, 255, .1);
      }
      #${PANEL_ID} .hse-bar > i {
        display: block;
        width: 0;
        height: 100%;
        border-radius: 2px;
        background: #3b82f6;
        transition: width .2s ease;
      }
      #${PANEL_ID} .hse-status {
        margin-top: 6px;
        color: #9aa4b2;
        font-size: 11px;
        line-height: 1.45;
        word-break: break-word;
      }
      #${PANEL_ID} .hse-status.is-error {
        color: #fca5a5;
      }
      .contest__item .hse-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .contest__item .hse-title > a {
        flex: 1 1 auto;
        min-width: 0;
      }
      .contest__item .hse-pick {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 6px;
        padding: 3px 9px;
        border: 1px solid rgba(148, 163, 184, .3);
        border-radius: 999px;
        background: rgba(148, 163, 184, .07);
        color: #9aa4b2;
        font-size: 12px;
        line-height: 18px;
        cursor: pointer;
        user-select: none;
        transition: background .15s ease, border-color .15s ease, color .15s ease;
      }
      .contest__item .hse-pick:hover {
        border-color: rgba(59, 130, 246, .7);
        background: rgba(59, 130, 246, .14);
        color: #dbeafe;
      }
      .contest__item .hse-pick input {
        position: relative;
        width: 15px;
        height: 15px;
        margin: 0;
        border: 1px solid #6b7280;
        border-radius: 4px;
        outline: none;
        background: transparent;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }
      .contest__item .hse-pick input:checked {
        border-color: #3b82f6;
        background: #3b82f6;
      }
      .contest__item .hse-pick input:checked::after {
        content: "";
        position: absolute;
        left: 4px;
        top: 1px;
        width: 4px;
        height: 8px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
      }
      .contest__item.hse-picked {
        background: rgba(59, 130, 246, .08);
        box-shadow: inset 3px 0 0 #3b82f6;
      }
      .hse-pick--inline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-right: 8px;
        color: #9aa4b2;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      @media (max-width: 720px) {
        #${PANEL_ID} {
          right: 12px;
          bottom: 56px;
          width: calc(100vw - 24px);
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="hse-head">
          <span class="hse-head-title">Hydro 成绩导出</span>
          <span class="hse-badge" data-hse-count>0</span>
        </div>
        <div data-hse-body></div>
        <div class="hse-progress" data-hse-progress>
          <div class="hse-bar"><i></i></div>
          <div class="hse-status" data-hse-status></div>
        </div>
      `;
      document.body.appendChild(panel);
    }
    panel.onclick = handlePanelClick;
    return panel;
  }

  function renderPanel() {
    const panel = ensurePanel();
    const body = panel.querySelector('[data-hse-body]');
    const badge = panel.querySelector('[data-hse-count]');
    if (state.mode === 'list') {
      badge.textContent = String(state.selected.size);
      body.innerHTML = `
        <div class="hse-hint">勾选比赛，支持跨页；也可扫描全部列表页。</div>
        <div class="hse-grid">
          <button type="button" data-hse-action="all-page">全选本页</button>
          <button type="button" data-hse-action="all-pages">全选所有页</button>
          <button type="button" class="hse-wide" data-hse-action="clear">清空已选</button>
        </div>
        <div class="hse-formats">
          <button type="button" class="hse-primary" data-hse-format="txt">导出 TXT</button>
          <button type="button" data-hse-format="csv">CSV</button>
          <button type="button" data-hse-format="json">JSON</button>
        </div>
      `;
      updatePanel();
    } else {
      badge.textContent = '当前';
      body.innerHTML = `
        <div class="hse-current" data-hse-current-title></div>
        <div class="hse-hint">导出当前页面的成绩表；详情页会自动抓取成绩表。</div>
        <div class="hse-formats">
          <button type="button" class="hse-primary" data-hse-format="txt">导出 TXT</button>
          <button type="button" data-hse-format="csv">CSV</button>
          <button type="button" data-hse-format="json">JSON</button>
        </div>
      `;
      body.querySelector('[data-hse-current-title]').textContent = currentMeta().title;
    }
  }

  function updatePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || state.mode !== 'list') return;
    panel.querySelector('[data-hse-count]').textContent = String(state.selected.size);
    const allPageSelected = state.pageItems.size > 0
      && [...state.pageItems.keys()].every((key) => state.selected.has(key));
    const allPageButton = panel.querySelector('[data-hse-action="all-page"]');
    if (allPageButton) allPageButton.textContent = allPageSelected ? '取消本页' : '全选本页';
    panel.querySelectorAll('button').forEach((button) => {
      if (button.dataset.hseFormat) button.disabled = state.busy || state.selected.size === 0;
      else if (button.dataset.hseAction === 'clear') button.disabled = state.busy || state.selected.size === 0;
      else button.disabled = state.busy;
    });
  }

  function setStatus(message, percent, isError) {
    const panel = ensurePanel();
    const progress = panel.querySelector('[data-hse-progress]');
    const status = panel.querySelector('[data-hse-status]');
    progress.classList.add('is-on');
    progress.querySelector('i').style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    status.textContent = message;
    status.classList.toggle('is-error', !!isError);
  }

  function setBusy(busy) {
    state.busy = busy;
    const panel = ensurePanel();
    panel.classList.toggle('is-busy', busy);
    panel.querySelectorAll('button').forEach((button) => {
      button.disabled = busy;
    });
    if (!busy) updatePanel();
  }

  /* ------------------------------------------------------------------ */
  /* 列表选择                                                           */
  /* ------------------------------------------------------------------ */

  function ensureCheckbox(meta, node) {
    const titleRow = node.matches && node.matches('.contest__item')
      ? node.querySelector('.contest__title')
      : null;
    const container = titleRow || node;
    if (!container) return;

    let label = container.querySelector(`.hse-pick input[data-hse-key="${CSS.escape(meta.key)}"]`);
    if (label) {
      label.checked = state.selected.has(meta.key);
      return;
    }

    if (titleRow) titleRow.classList.add('hse-title');
    label = document.createElement('label');
    label.className = titleRow ? 'hse-pick' : 'hse-pick hse-pick--inline';
    label.title = '选择此比赛导出成绩表';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.hseKey = meta.key;
    input.checked = state.selected.has(meta.key);
    input.setAttribute('aria-label', `选择「${meta.title}」`);
    const text = document.createElement('span');
    text.textContent = '选择';
    label.append(input, text);

    if (titleRow) titleRow.appendChild(label);
    else container.parentNode.insertBefore(label, container);

    input.addEventListener('change', () => {
      if (input.checked) state.selected.set(meta.key, meta);
      else state.selected.delete(meta.key);
      saveSelection();
      syncKey(meta.key);
      updatePanel();
    });
    node.classList.toggle('hse-picked', input.checked);
  }

  function scanPage() {
    if (!state.info || !state.info.isList) return;
    state.pageItems.clear();
    const nodes = [...document.querySelectorAll('.contest__item')];
    if (nodes.length) {
      for (const node of nodes) {
        const link = node.querySelector(
          '.contest__title a[href*="/contest/"], .contest__title a[href*="/homework/"], '
          + 'a[href*="/contest/"], a[href*="/homework/"]',
        );
        if (!link) continue;
        const meta = contestMetaFromLink(link, state.info);
        if (!meta) continue;
        const titleNode = node.querySelector('.contest__title');
        if (titleNode) {
          const clone = titleNode.cloneNode(true);
          clone.querySelectorAll('.hse-pick').forEach((item) => item.remove());
          const titleText = clean(clone.textContent);
          if (titleText) meta.title = titleText;
        }
        state.pageItems.set(meta.key, meta);
        if (state.selected.has(meta.key)) state.selected.set(meta.key, meta);
        ensureCheckbox(meta, node);
      }
    } else {
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href]')) {
        if (link.closest('.pager, .pagination, .nav, .menu, .footer, .section__tools')) continue;
        const meta = contestMetaFromLink(link, state.info);
        if (!meta || seen.has(meta.key)) continue;
        seen.add(meta.key);
        if (!clean(link.textContent)) {
          const holder = link.closest('li, article, .section__list__item, .media, .row');
          const heading = holder && holder.querySelector('h1, h2, h3, .contest__title');
          if (heading) meta.title = clean(heading.textContent) || meta.title;
        }
        state.pageItems.set(meta.key, meta);
        if (state.selected.has(meta.key)) state.selected.set(meta.key, meta);
        ensureCheckbox(meta, link);
      }
    }
    updatePanel();
  }

  function toggleAllPage() {
    if (!state.pageItems.size) return;
    const allSelected = [...state.pageItems.keys()].every((key) => state.selected.has(key));
    for (const [key, meta] of state.pageItems) {
      if (allSelected) state.selected.delete(key);
      else state.selected.set(key, meta);
    }
    saveSelection();
    for (const key of state.pageItems.keys()) syncKey(key);
    updatePanel();
  }

  function clearSelection() {
    state.selected.clear();
    saveSelection();
    for (const key of state.pageItems.keys()) syncKey(key);
    updatePanel();
  }

  async function selectAllPages() {
    if (state.busy) return;
    setBusy(true);
    try {
      const all = await collectAllContests();
      for (const meta of all) state.selected.set(meta.key, meta);
      saveSelection();
      scanPage();
      setStatus(`已选择 ${all.length} 场；当前共 ${state.selected.size} 场。`, 100);
    } catch (error) {
      setStatus(`扫描失败：${error.message || error}`, 0, true);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 导出流程                                                           */
  /* ------------------------------------------------------------------ */

  async function exportSelected(format) {
    if (state.busy) return;
    const items = [...state.selected.values()];
    if (!items.length) {
      setStatus('请先勾选比赛。', 0, true);
      return;
    }

    setBusy(true);
    setStatus(`准备获取 ${items.length} 场成绩表…`, 2);
    const results = new Array(items.length);
    const errors = [];
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        const meta = items[index];
        setStatus(`正在获取 ${index + 1}/${items.length}：${meta.title}`, Math.round((done / items.length) * 100));
        try {
          results[index] = { meta, ...(await fetchScoreboard(meta)) };
        } catch (error) {
          errors.push({ meta, error: error.message || String(error) });
        } finally {
          done += 1;
          setStatus(`已完成 ${done}/${items.length}`, Math.round((done / items.length) * 100));
        }
        await sleep(REQUEST_GAP);
      }
    };

    try {
      await Promise.all(Array.from(
        { length: Math.min(CONCURRENCY, items.length) },
        () => worker(),
      ));
      const success = results.filter(Boolean);
      if (!success.length) {
        setStatus(`导出失败：${errors[0] ? errors[0].error : '没有获取到成绩表'}`, 0, true);
        return;
      }
      downloadOutput(success, errors, format);
      const rowCount = success.reduce((sum, result) => sum + result.rows.length, 0);
      setStatus(
        `已导出 ${success.length} 场、${rowCount} 行`
        + (errors.length ? `；${errors.length} 场失败（详见 TXT/JSON）` : ''),
        100,
        errors.length > 0,
      );
    } catch (error) {
      setStatus(`导出出错：${error.message || error}`, 0, true);
    } finally {
      setBusy(false);
    }
  }

  async function exportCurrent(format) {
    if (state.busy) return;
    setBusy(true);
    const meta = currentMeta();
    setStatus('正在读取当前成绩表…', 15);
    try {
      let parsed;
      if (state.info.isScoreboard) {
        parsed = parseScoreboard(document);
      } else {
        parsed = await fetchScoreboard(meta);
      }
      downloadOutput([{ meta, ...parsed }], [], format);
      setStatus(`已导出：${meta.title}`, 100);
    } catch (error) {
      setStatus(`导出失败：${error.message || error}`, 0, true);
    } finally {
      setBusy(false);
    }
  }

  function handlePanelClick(event) {
    const formatButton = event.target.closest('button[data-hse-format]');
    if (formatButton) {
      const format = formatButton.dataset.hseFormat;
      if (state.mode === 'list') exportSelected(format);
      else exportCurrent(format);
      return;
    }
    const actionButton = event.target.closest('button[data-hse-action]');
    if (!actionButton) return;
    const action = actionButton.dataset.hseAction;
    if (action === 'all-page') toggleAllPage();
    else if (action === 'all-pages') selectAllPages();
    else if (action === 'clear') clearSelection();
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  function resetUI() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    document.querySelectorAll('.hse-pick').forEach((node) => node.remove());
    document.querySelectorAll('.hse-title').forEach((node) => node.classList.remove('hse-title'));
    document.querySelectorAll('.hse-picked').forEach((node) => node.classList.remove('hse-picked'));
  }

  function init() {
    if (!isHydroPage()) return;
    const info = getPageInfo();
    if (!info.isList && !info.isCurrent) return;

    clearTimeout(retryTimer);
    resetUI();
    injectStyle();

    state.info = info;
    state.mode = info.isList ? 'list' : 'current';
    state.pageItems.clear();
    state.selected = info.isList ? loadSelection(info) : new Map();

    ensurePanel();
    renderPanel();

    if (info.isList) {
      scanPage();
      if (!state.pageItems.size) {
        retryTimer = window.setTimeout(() => {
          if (state.info && state.info.isList) {
            scanPage();
            if (!state.pageItems.size) {
              setStatus('没有找到比赛链接，请确认当前页是 Hydro 比赛列表。', 0, true);
            }
          }
        }, 900);
      }
    }
  }

  init();
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) init();
  });
  window.addEventListener('popstate', () => window.setTimeout(init, 120));
  window.setInterval(() => {
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      window.setTimeout(init, 250);
    }
  }, 1200);
})();
