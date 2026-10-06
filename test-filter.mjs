/**
 * dsh-provider-toggle / test-filter.mjs
 * ============================================================================
 * 离线验证台：**不启动 DSH**，把 host 半端的 `apply()` 挂到一个假的 cordis ctx 上，
 * 逐条核对「关掉一个 provider → 它从模型目录里消失」这条链路。
 *
 * 口径独立实现一遍（不 import 被测代码的判断逻辑来自证）：
 *   · 期望的"可见路由"由本文件自己按 routes × listModels() 算；
 *   · 复刻 DSH `buildModelCatalog()` 里那句 `groups.filter(g => g.models.length > 0)`，
 *     因为"厂商从选择器消失"正是它决定的
 *     （@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js）。
 *
 * 跑：node test-filter.mjs
 */

import { register } from 'node:module';
import assert from 'node:assert/strict';

register('./test-resolve-hook.mjs', import.meta.url);

const { apply, Config, routesOf } = await import('./index.js');

const NS = 'dsh-provider-toggle';
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

// ------------------------------------------------------------------ 测试替身

const ROUTES = ['deepseek-account', 'deepseek-official', 'opencode-go', 'custom-relay'];
const MODELS = new Map(ROUTES.map((route) => [route, [{ id: `${route}-1`, name: `${route} one` }]]));

/** 仿 LlmRuntime：listModels 在**原型**上（用来验证卸载时能还原）。 */
class FakeLlm {
  events = 0;
  listModels(provider) {
    return Promise.resolve(MODELS.get(provider) ?? []);
  }
  emitAdaptersUpdated() {
    this.events += 1;
  }
}

/** 复刻 buildModelCatalog 里决定"分组去留"的那一句。 */
async function visibleRoutes(llm) {
  const groups = await Promise.all(ROUTES.map(async (route) => ({
    id: route,
    models: await llm.listModels(route),
  })));
  return groups.filter((group) => group.models.length > 0).map((group) => group.id);
}

const warns = [];
function makeCtx(llm, document) {
  const listeners = new Map();
  const disposers = [];
  const childFor = () => ({
    llm,
    settings: { configure: () => () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  });
  const ctx = {
    fiber: { entry: { options: { id: NS } } },
    logger: { warn: (...args) => warns.push(args) },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    inject: (deps, callback) => callback(childFor()),
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    get: (key) => (key === 'settings'
      ? {
        describe: () => ({
          namespaces: [{ ns: NS, value: { disabled: document.list }, revision: document.revision }],
        }),
      }
      : undefined),
  };
  return {
    ctx,
    emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/** 可写的 volatile ref，模拟 loader 提交 volatile 配置之后的形态。 */
function makeRef(initial) {
  let value = initial;
  return { get: () => value, set: (next) => { value = next; } };
}

// ------------------------------------------------------------------- 开始

console.log(`Config 默认值：${JSON.stringify(routesOf(Config({}).disabled))}`);

await check('Config.disabled 默认是空数组', () => {
  assert.deepEqual(routesOf(Config({}).disabled), []);
});
await check('Config.disabled 标了 volatile（否则设置服务会拒绝写入）', () => {
  assert.equal(Config.dict.disabled.meta.volatile, true);
});
await check('routesOf 兼容 ref 与普通对象两种形态', () => {
  assert.deepEqual(routesOf({ get: () => ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(routesOf(['a', '', 3, 'b']), ['a', 'b']);
  assert.deepEqual(routesOf(undefined), []);
});

console.log('\n[1] 空配置：全部 provider 可见');
{
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const harness = makeCtx(llm, { list: [], revision: 0 });
  apply(harness.ctx, { disabled: ref });
  await check(`可见 = ${JSON.stringify(ROUTES)}`, async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES);
  });

  console.log('\n[2] 关掉 opencode-go');
  const before = llm.events;
  ref.set(['opencode-go']);
  harness.emit('loader/volatile-update', [['disabled']]);
  const expected = ROUTES.filter((route) => route !== 'opencode-go');
  await check(`可见 = ${JSON.stringify(expected)}`, async () => {
    assert.deepEqual(await visibleRoutes(llm), expected);
  });
  await check("listModels('opencode-go') 返回空数组", async () => {
    assert.deepEqual(await llm.listModels('opencode-go'), []);
  });
  await check("未受影响的路由照常返回模型", async () => {
    assert.equal((await llm.listModels('deepseek-official')).length, 1);
  });
  await check('广播了 llm/adapters-updated（浏览器据此重载模型目录）', () => {
    assert.ok(llm.events > before, `events ${before} -> ${llm.events}`);
  });

  console.log('\n[3] 再关一个：两个一起藏');
  ref.set(['opencode-go', 'custom-relay']);
  harness.emit('loader/volatile-update', [['disabled']]);
  await check("可见 = ['deepseek-account','deepseek-official']", async () => {
    assert.deepEqual(await visibleRoutes(llm), ['deepseek-account', 'deepseek-official']);
  });

  console.log('\n[4] 全部打开：回到原样');
  ref.set([]);
  harness.emit('loader/volatile-update', [['disabled']]);
  await check(`可见 = ${JSON.stringify(ROUTES)}`, async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES);
  });

  console.log('\n[5] 插件卸载：listModels 还原成原型方法');
  harness.disposeAll();
  await check('llm 上没有遗留自有属性 listModels', () => {
    assert.equal(Object.hasOwn(llm, 'listModels'), false);
  });
  ref.set(['opencode-go']);
  await check('卸载后过滤失效（不做"幽灵隐藏"）', async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES);
  });
}

console.log('\n[6] 兜底路径：config 不是 ref（第三方插件的历史坑）→ 改读 settings 文档');
{
  const llm = new FakeLlm();
  const harness = makeCtx(llm, { list: ['custom-relay'], revision: 7 });
  apply(harness.ctx, { disabled: undefined });
  await check("可见 = ROUTES 去掉 'custom-relay'", async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES.filter((route) => route !== 'custom-relay'));
  });
  harness.disposeAll();
}

console.log('\n[7] 重复 apply 不叠加包装（非 volatile 配置改动会让插件重启）');
{
  const llm = new FakeLlm();
  const ref = makeRef(['opencode-go']);
  const a = makeCtx(llm, { list: [], revision: 0 });
  apply(a.ctx, { disabled: ref });
  const b = makeCtx(llm, { list: [], revision: 0 });
  apply(b.ctx, { disabled: ref });
  await check(`可见 = ${JSON.stringify(ROUTES.filter((r) => r !== 'opencode-go'))}`, async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES.filter((r) => r !== 'opencode-go'));
  });
  a.disposeAll();
  await check('卸载其中一个实例后过滤仍在（引用计数生效）', async () => {
    assert.deepEqual(await visibleRoutes(llm), ROUTES.filter((r) => r !== 'opencode-go'));
  });
  b.disposeAll();
  await check('两个都卸载后才真正还原', () => {
    assert.equal(Object.hasOwn(llm, 'listModels'), false);
  });
}

console.log(`\n${failures.length === 0 ? '全部通过' : '存在失败项'}：${passed} 通过 / ${failures.length} 失败`);
if (warns.length > 0) console.log(`（过程中 ${warns.length} 条 logger.warn，属预期）`);
process.exit(failures.length === 0 ? 0 : 1);
