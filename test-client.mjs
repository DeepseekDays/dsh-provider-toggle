/**
 * dsh-provider-toggle / test-client.mjs
 * ============================================================================
 * 离线验证台（浏览器半端）：**不用浏览器**，用最小化的假 React / 假 `window`，
 * 把 client.js 的工厂函数取出来跑一遍，核对：
 *   · 插槽注册是「按 settingsNs 去重后的 keyed 注册」（keyed slot 必须带 options.key）；
 *   · 组件渲染出来的 Switch 状态与 settings 文档一致；
 *   · 点开关 → 调 `remote.settings.mutate(ns, [{op:'set', path:['disabled'], value:[…]}], revision)`。
 *
 * 不测真实 DOM 定位（`placeSwitch` 依赖 getBoundingClientRect，
 * 那是纯视觉兜底：量不到就退化成行内显示，不影响功能）。
 *
 * 跑：node test-client.mjs
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  \u2717 ${label}\n      ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

// --------------------------------------------------------------- 假 React
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value ?? null }),
};

/** 假 Switch：只记录 props，方便断言。 */
function FakeSwitch(props) {
  return { type: 'fake-switch', props };
}

// ------------------------------------------------------------- 假 window
let loaded = null;
globalThis.window = {
  __ModuleLoader__: { load: (entry) => { loaded = entry; } },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.__DSH_PROVIDER_TOGGLE__ = { ns: 'dsh-provider-toggle' };

await import('./client.js');
assert.ok(loaded !== null, 'client.js 没有调用 window.__ModuleLoader__.load');

const required = [];
const mod = loaded.factory((id) => {
  required.push(id);
  if (id === 'react') return fakeReact;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: FakeSwitch };
  throw new Error(`unexpected require("${id}")`);
});

// ------------------------------------------------------------ 假客户端 ctx
const PROVIDERS = [
  { provider: 'deepseek-account', displayName: 'DeepSeek 账号', settingsNs: 'llm-deepseek-account', settingsPath: ['providers', 'deepseek-account'] },
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek-official'] },
  { provider: 'opencode-go', displayName: 'opencode-go', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'] },
  { provider: 'opencode-go-v41', displayName: 'OpenCode Go (V4.1)', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go-v41'] },
];

const writes = [];
let document_ = { disabled: [], revision: 3 };

const registrations = [];
const ctx = {
  effect: (fn) => fn(),
  remote: {
    $on: () => () => {},
    llm: {
      listConfigurableProviders: async () => ({ ok: true, value: PROVIDERS }),
    },
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: 'dsh-provider-toggle', value: { disabled: [...document_.disabled] }, revision: document_.revision }] },
      }),
      mutate: async (ns, ops, revision) => {
        writes.push({ ns, ops, revision });
        const next = ops[0].value;
        const previous = new Set(document_.disabled);
        document_ = { disabled: next, revision: document_.revision + 1 };
        return {
          ok: true,
          value: { ns, value: { disabled: next }, revision: document_.revision, __previous: [...previous] },
        };
      },
    },
  },
  slots: {
    inject: (name, callback) => {
      const iterator = callback();
      for (const _disposer of iterator) { /* 注册由下面的 register 收集 */ }
      return () => {};
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

console.log('client.js 工厂要求的模块：', JSON.stringify(required));

await check('exports.apply / exports.inject 都在', () => {
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots', 'remote', 'remote.llm', 'remote.settings']);
});

mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

console.log('\n[1] 插槽注册');
await check('按 settingsNs 去重成 2 条 keyed 注册（llm-pi-ai 覆盖全部 pi-ai 路由）', () => {
  assert.equal(registrations.length, 2, `实际 ${registrations.length}`);
  assert.deepEqual(
    registrations.map((row) => row.options.key).sort(),
    ['llm-deepseek-account', 'llm-pi-ai'],
  );
});
await check('注册的 slot 名是 settings.models.provider-card，且带 key（keyed slot 必填）', () => {
  for (const row of registrations) {
    assert.equal(row.options.name, 'settings.models.provider-card');
    assert.equal(typeof row.options.key, 'string');
    assert.equal(typeof row.component, 'function');
  }
});

console.log('\n[2] 组件渲染');
const ProviderToggle = registrations[0].component;
const rowFor = (provider) => ({ provider: PROVIDERS.find((item) => item.provider === provider) });

let element = ProviderToggle(rowFor('opencode-go'));
await check('渲染出外层 span + Switch', () => {
  assert.equal(element.type, 'span');
  assert.equal(element.props['data-dsh-provider-toggle'], '1');
});
await check('初始 checked = true（该 provider 未被关）', () => {
  const switchEl = element.props.children;
  assert.equal(switchEl.type, FakeSwitch);
  assert.equal(switchEl.props.checked, true);
  assert.equal(switchEl.props.disabled, false);
});
await check('没有 provider 的 props 返回 null（不污染别的 slot 调用）', () => {
  assert.equal(ProviderToggle({}), null);
});
await check('不给 deepseek-account 开关（它的行会随目录一起消失，会失去回开入口）', () => {
  assert.equal(ProviderToggle(rowFor('deepseek-account')), null);
});

console.log('\n[3] 点开关 → 写 settings');
const switchEl = element.props.children;
await switchEl.props.onChange(false);
await new Promise((resolve) => setTimeout(resolve, 0));
await check('mutate 参数正确：ns / set disabled / 带 revision', () => {
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    ns: 'dsh-provider-toggle',
    ops: [{ op: 'set', path: ['disabled'], value: ['opencode-go'] }],
    revision: 3,
  });
});

await check('重渲染后该行 checked = false', () => {
  const again = ProviderToggle(rowFor('opencode-go'));
  assert.equal(again.props.children.props.checked, false);
});
await check('同一个 key 下的其他行不受影响', () => {
  const other = ProviderToggle(rowFor('deepseek-official'));
  assert.equal(other.props.children.props.checked, true);
});

console.log('\n[4] 再打开');
await ProviderToggle(rowFor('opencode-go')).props.children.props.onChange(true);
await new Promise((resolve) => setTimeout(resolve, 0));
await check('mutate 收到空数组（全部可见）', () => {
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].ops, [{ op: 'set', path: ['disabled'], value: [] }]);
  assert.equal(writes[1].revision, 4, '第二笔写应带上第一笔产生的新 revision');
});
await check('恢复后 checked = true', () => {
  assert.equal(ProviderToggle(rowFor('opencode-go')).props.children.props.checked, true);
});

console.log('\n[5] 命名空间不可用时静默不渲染（不炸设置页）');
{
  let captured = null;
  const bare = {
    effect: (fn) => fn(),
    remote: {
      $on: () => () => {},
      llm: { listConfigurableProviders: async () => ({ ok: true, value: [] }) },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }), mutate: async () => ({ ok: true }) },
    },
    slots: { inject: (name, callback) => { callback(); return () => {}; }, register: () => () => {} },
  };
  mod.apply(bare);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const component = mod.ProviderToggle;
  captured = component({ provider: { provider: 'x', displayName: 'X' } });
  await check('返回 null', () => { assert.equal(captured, null); });
}

console.log(`\n${failures.length === 0 ? '全部通过' : '存在失败项'}：${passed} 通过 / ${failures.length} 失败`);
process.exit(failures.length === 0 ? 0 : 1);
