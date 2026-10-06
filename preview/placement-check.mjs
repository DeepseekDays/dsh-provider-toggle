/**
 * dsh-provider-toggle / preview/placement-check.mjs
 * ============================================================================
 * 视觉/几何验证台：**不需要启动 DSH**。
 *
 * 做法：
 *   1. 从真实的 DSH 安装里抽取 **真 CSS**：
 *      · 设置页的行样式（@deepseek-ai/dsh-client-ui-settings-models 里内联的
 *        ModelsSection.module.css，类名前缀 _5M2yiq_）；
 *      · 主界面同款开关样式（@deepseek-ai/dsh-web-frontend 的 CSS 里
 *        作为静态模块打进去的 Switch.module.css，_switch_1ik0f_5 / _thumb_1ik0f_33）。
 *   2. 从 client.js 里抽出**真的 `placeSwitch()` 源码**（不是复制一份）。
 *   3. 按 React 实际渲染出来的结构搭一份 DOM 复刻（rowCard > rowHead + 插槽 span）。
 *   4. 用本机 Edge + CDP 打开它，量出几何关系并截图。
 *
 * 判据（都是"开关有没有落在「编辑」左边"的硬指标）：
 *   · 开关右边缘 < 「编辑」按钮左边缘，间隙 8px±1；
 *   · 开关的垂直中心 ≈ 「编辑」按钮的垂直中心（±1px）；
 *   · 开关完全落在卡片水平范围内，不与按钮组重叠。
 *
 * 跑：node preview/placement-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const APP = process.env.DSH_APP_DIR ?? 'F:/DSH/DSH Desktop/resources/app';
const EDGE = process.env.EDGE_PATH
  ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// ---------------------------------------------------------------- 抽取工具

/** 抽 `const <name> = "…";` 形式的 CSS 字符串字面量（按 JS 转义规则解码）。 */
function extractCssLiteral(source, varName) {
  const head = `const ${varName} = "`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`找不到 ${varName} 的声明`);
  let index = start + head.length;
  let out = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      // ⚠️ 不能用 `source.indexOf('";')` 找结尾：CSS 里有 `content:\"\";border…`
      // 和 `url(\"data:…\")`，`\"` 后面紧跟的那对字符本身就长得像结束标记，
      // 会在字面量中间把 CSS 截断（第一次就是被这个坑了 —— 设置页样式只抽到一半，
      // 开关按钮整个掉了样式）。必须按转义规则扫。
      const next = source[index + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
        out += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      } else out += next;
      index += 2;
      continue;
    }
    if (char === '"') return out;
    out += char;
    index += 1;
  }
  throw new Error(`${varName} 的字符串没有结束`);
}

/** 从 JS 源码里按大括号配平抽一个函数。 */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`找不到 ${signature}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${signature} 的大括号不配平`);
}

const settingsClient = fs.readFileSync(
  path.join(APP, 'node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'),
  'utf8',
);
const primitivesCss = fs.readFileSync(
  path.join(APP, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BPHePDI_.css'),
  'utf8',
);
const pluginClient = fs.readFileSync(path.join(PLUGIN, 'client.js'), 'utf8');

const settingsCss = extractCssLiteral(settingsClient, 'css$3');
const switchCssStart = primitivesCss.indexOf('._switch_1ik0f_5{');
const switchCss = primitivesCss.slice(switchCssStart, primitivesCss.indexOf('._control_d62eq_11{'));
const placeSwitchSource = extractFunction(pluginClient, 'function placeSwitch(');

// ------------------------------------------------- 主题变量：给一套暗色兜底
// DSH 的 --dsw-* 令牌由主题插件在运行时注入，离线跑不到；这里按名字喂一套暗色值，
// 只为让截图看起来像真的（几何判定与颜色无关）。
const NAMES = [...new Set([
  ...settingsCss.matchAll(/var\((--dsw-[\w-]+)/g),
  ...switchCss.matchAll(/var\((--dsw-[\w-]+)/g),
].map((match) => match[1]))].sort();

const PALETTE = {
  '--dsw-alias-label-primary': '#ededed',
  '--dsw-alias-label-secondary': '#b0b0b0',
  '--dsw-alias-label-tertiary': '#8a8a8a',
  '--dsw-alias-label-primary-foreground': '#ffffff',
  '--dsw-alias-brand-primary': '#4d6bfe',
  '--dsw-alias-bg-base': '#181818',
  '--dsw-alias-bg-layer-1': '#232323',
  '--dsw-alias-bg-layer-2': '#2b2b2b',
  '--dsw-alias-bg-module-platform': '#2b2b2b',
  '--dsw-alias-settings-card-fill': '#232323',
  '--dsw-alias-settings-card-stroke': '#383838',
  '--dsw-alias-border-l1': '#303030',
  '--dsw-alias-border-l2': '#383838',
  '--dsw-alias-border-l3': '#4a4a4a',
  '--dsw-alias-border-l4': '#5a5a5a',
  '--dsw-alias-interactive-bg-hover': '#ffffff0f',
  '--dsw-alias-state-error-primary': '#ff8080',
  '--dsw-alias-state-business-primary': '#4d6bfe',
  '--dsw-alias-switch-thumb': '#8a8a8a',
  '--dsw-radius-sm': '6px',
  '--dsw-radius-md': '8px',
  '--dsw-radius-lg': '12px',
  '--dsw-radius-xl': '16px',
  '--dsw-focus-ring-width': '2px',
  '--dsw-focus-ring-color': '#4d6bfe',
};
const tokens = NAMES.map((name) => `  ${name}: ${PALETTE[name] ?? '#888'};`).join('\n');

// ------------------------------------------------------------ DOM 复刻
// 结构照 @deepseek-ai/dsh-client-ui-settings-models 的 rowCard 分支 1:1 抄：
//   li.rowCard > div.rowHead > (span.rowIdentity > span.rowName [+ tag + dot])
//                              + span.rowActions > (button.secondaryButton [+ button.dangerButton])
//              + <插槽 span>            <- 我们的开关就渲染在这里
const ROWS = [
  // 0 号行故意**不给开关**：真实插件对 deepseek-account 也是这个行为（见 client.js 的 NO_TOGGLE），
  // 这里保持和实现一致，免得复刻件比真货还乐观。
  { name: 'DeepSeek 账号', edit: '编辑', toggle: false },
  { name: 'DeepSeek', edit: '编辑' },
  { name: 'openai', edit: '编辑', removable: true, checked: false },
  { name: 'OpenCode Go (V4.1)', edit: '编辑', removable: true, tag: '自定义' },
];

const rowHtml = ROWS.map((row, index) => `
    <li class="_5M2yiq_rowCard">
      <div class="_5M2yiq_rowHead">
        <span class="_5M2yiq_rowIdentity">
          <span class="_5M2yiq_rowName">${row.name}</span>
          ${row.tag === undefined || row.tag === null ? '' : `<span class="_5M2yiq_rowTag">${row.tag}</span>`}
          <span class="_5M2yiq_credentialDot _5M2yiq_credentialDotConfigured" role="img" aria-label="API 密钥已配置" title="API 密钥已配置"></span>
        </span><span class="_5M2yiq_rowActions">
          <button type="button" class="_5M2yiq_secondaryButton" aria-label="编辑 ${row.name}">${row.edit}</button>
          ${row.removable ? '<button type="button" class="_5M2yiq_dangerButton" aria-label="删除">删除</button>' : ''}
        </span>
      </div>
      ${row.toggle === false ? '' : `<span data-dsh-provider-toggle="1" data-row="${index}">
        <button type="button" role="switch" aria-checked="${row.checked === false ? 'false' : 'true'}"
          aria-label="在模型选择器中显示 ${row.name}"
          title="${row.checked === false ? '已停用：已从「选择模型」栏里消失。点击恢复。' : '已启用：会出现在「选择模型」栏里。点击隐藏。'}"
          class="_switch_1ik0f_5"><span class="_thumb_1ik0f_33"></span></button>
      </span>`}
    </li>`).join('');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-provider-toggle placement check</title>
<style>
:root {
${tokens}
}
body { margin: 0; padding: 24px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 14px/22px -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif; }
.wrap { max-width: 720px; }
h1 { font-size: 16px; font-weight: 500; margin: 0 0 4px; }
p { color: var(--dsw-alias-label-tertiary); margin: 0 0 4px; font-size: 12px; }
/* ---- 真实的 ModelsSection.module.css（从 DSH 安装里抽出来的原文） ---- */
${settingsCss}
/* ---- 真实的 Switch.module.css（主界面同款开关） ---- */
${switchCss}
</style></head>
<body>
<div class="wrap">
  <h1>设置 / 模型</h1>
  <p>填入各提供商的 API 密钥即可使用其模型。（离线版式复刻：真 CSS + 真 placeSwitch()）</p>
  <ul class="_5M2yiq_rows">${rowHtml}
  </ul>
</div>
<script>
${placeSwitchSource}

window.__report = [];
for (const span of document.querySelectorAll('[data-dsh-provider-toggle]')) {
  placeSwitch(span);
  const row = span.closest('li');
  const actions = row.querySelector('[class*="rowActions"]');
  const editButton = actions.querySelector('button');
  const rowBox = row.getBoundingClientRect();
  const toggleBox = span.getBoundingClientRect();
  const editBox = editButton.getBoundingClientRect();
  const toggleInner = span.querySelector('button').getBoundingClientRect();
  window.__report.push({
    row: span.dataset.row,
    rowHeight: Math.round(rowBox.height * 100) / 100,
    gapToEdit: Math.round((editBox.left - toggleInner.right) * 100) / 100,
    centerDelta: Math.round(((toggleInner.top + toggleInner.height / 2) - (editBox.top + editBox.height / 2)) * 100) / 100,
    insideRow: toggleInner.left >= rowBox.left - 0.5 && toggleInner.right <= rowBox.right + 0.5,
    overlapsActions: toggleInner.right > editBox.left + 0.5,
    sameLineAsEdit: Math.abs((toggleInner.top + toggleInner.height / 2) - (editBox.top + editBox.height / 2)) < 3,
    position: getComputedStyle(span).position,
  });
}
document.title = 'ready';
<\/script>
</body></html>
`;

const outDir = path.join(PLUGIN, 'preview');
fs.mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, 'placement.html');
fs.writeFileSync(htmlPath, html);
console.log(`已生成 ${htmlPath}（${html.length} 字节）`);
console.log(`主题变量 ${NAMES.length} 个：${NAMES.join(', ')}`);

// ------------------------------------------------------------------ CDP
const PORT = 9444;
const profile = path.join(os.tmpdir(), `dsh-provider-toggle-cdp-${Date.now()}`);
const pageUrl = `file:///${htmlPath.replaceAll('\\', '/')}`;
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--window-size=880,420',
  pageUrl,
]);
edge.on('error', (error) => console.error('Edge 启动失败：', error.message));

const getJson = async (url) => {
  const response = await fetch(url);
  return response.json();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let socket;
try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      // ⚠️ Edge 一起来就先挂出一堆 background_page（扩展），所以不能只看"列表非空"。
      target = (targets ?? []).find((item) => item.type === 'page');
      if (target !== undefined) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (target === undefined) throw new Error('Edge 起来了但没有 page target');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    socket.send(JSON.stringify({ id: seq, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    if (probe.result?.value === 'ready') break;
    await sleep(200);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'placement.png'), Buffer.from(shot.data, 'base64'));

  // 再放大一张：只看第 2 行（有「编辑 + 删除」按钮、最挤的那种）的右侧，
  // 用来肉眼确认开关的"开/关"外观和与按钮的间距。
  const clipBox = await send('Runtime.evaluate', {
    expression: `(() => {
      const span = document.querySelector('[data-dsh-provider-toggle][data-row="2"]');
      const row = span.closest('li').getBoundingClientRect();
      return JSON.stringify({ x: row.right - 220, y: row.top - 6, width: 216, height: row.height + 12 });
    })()`,
    returnByValue: true,
  });
  const clip = { ...JSON.parse(clipBox.result.value), scale: 4 };
  const zoom = await send('Page.captureScreenshot', { format: 'png', clip });
  fs.writeFileSync(path.join(outDir, 'placement-zoom.png'), Buffer.from(zoom.data, 'base64'));

  const result = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__report)',
    returnByValue: true,
  });
  const report = JSON.parse(result.result.value);

  console.log('\n几何报告（每个提供商行一个开关）：');
  for (const row of report) console.log(' ', JSON.stringify(row));

  const failures = [];
  for (const row of report) {
    if (row.position !== 'absolute') failures.push(`row ${row.row}: position=${row.position}（没量到行头/按钮组）`);
    if (row.overlapsActions) failures.push(`row ${row.row}: 与按钮组重叠`);
    if (!row.sameLineAsEdit) failures.push(`row ${row.row}: 垂直中心与「编辑」差 ${row.centerDelta}px`);
    if (!(row.gapToEdit >= 6 && row.gapToEdit <= 11)) failures.push(`row ${row.row}: 与「编辑」的间隙 ${row.gapToEdit}px 不在 6~11 之间`);
    if (!row.insideRow) failures.push(`row ${row.row}: 越出卡片范围`);
  }

  console.log(`\n截图：${path.join(outDir, 'placement.png')}`);
  if (failures.length === 0) console.log(`几何判定全部通过（${report.length} 行）。`);
  else {
    console.log('几何判定失败：');
    for (const line of failures) console.log(`  - ${line}`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
