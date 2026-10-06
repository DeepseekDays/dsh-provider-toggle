/**
 * dsh-provider-toggle —— 模型提供商一键开关（host 半端）
 * ============================================================================
 * 需求：在「设置 → 模型」每个提供商行的「编辑」左侧放一个开关；关掉之后，
 *       这个提供商从主界面「选择模型」栏里消失；再打开就回来。
 *
 * 两个半端：
 *   · host（本文件）：把被关掉的 provider route 从**模型目录**里摘掉。
 *     做法是包一层 `ctx.llm.listModels()`：被关掉的 route 返回空数组。
 *     DSH 自己就是这么"隐藏"一个提供商的 —— `buildModelCatalog()`
 *     （@deepseek-ai/dsh-api-session-controller 的 lib/types/catalog.js）里有一句
 *       groups.filter(group => group.models.length > 0)
 *     所以模型列表为空的 provider 会被整组丢弃，选择器里就看不见了。
 *     ⚠️ 只影响"目录/选择器"，**不影响路由**：dsh-llm 的源码注释写得很清楚
 *       "Core routing accepts unlisted model ids; catalog-driven entry points such as
 *        the GUI may require membership."
 *     也就是说：已经选着这个模型的旧会话不会被弄坏，只是选择器里不再提供它。
 *
 *   · client（client.js）：用 `settings.models.provider-card` 这个 keyed slot
 *     在提供商行里渲染主界面同款的 <Switch>（@deepseek-ai/dsh-client-ui-primitives）。
 *
 * 状态存哪儿？存在**插件自己的 settings 命名空间**里（`Config.disabled`）。
 * 这样：
 *   · 走的是 DSH 原生的 settings 服务 → 持久化进 profile 的 cordis.patch.yml；
 *   · 浏览器半端用现成的 `ctx.remote.settings.describe()/mutate()` 读写，
 *     不需要自己造 typert 远程接口；
 *   · 设置界面里改任何 provider 时 DSH 整份重写 cordis.patch.yml 也冲不掉它
 *     （那份重写是按内存状态来的，我们的值本来就在内存里）。
 *   · `.volatile()` 让这个字段可以**热更新**：写入后 loader 发
 *     `loader/volatile-update`，我们据此广播 `llm/adapters-updated`，
 *     浏览器的模型目录当场重载，不用重启 DSH。
 */

import z from '@deepseek-ai/schemastery';

/** loader 诊断里显示的插件名。 */
export const name = 'provider-toggle';

/**
 * 插件配置 = 被关掉的 provider route 列表。
 * `.volatile()` 是这个方案的关键：只有 volatile 字段才能被 settings 服务写
 * （dsh-settings 的 `write()` 里有一句 `isVolatilePath(schema, path)` 检查），
 * 也只有 volatile 字段走热更新而不是重启插件。
 */
export const Config = z.object({
  disabled: z.array(z.string()).default([]).volatile(),
});

/** 兜底命名空间：正常情况下是 profile 里那条 entry 的 id（cordis.patch.yml 里写的）。 */
const NS_FALLBACK = 'dsh-provider-toggle';

/** 挂在 llm 服务实例上的补丁状态（WeakMap 也行，但实例上更直观、且能防重复包装）。 */
const PATCH = Symbol.for('dsh-provider-toggle.patch');

/**
 * 双形态读值：官方内置插件里 `config.x` 是响应式 ref（`.get()`），
 * 而第三方插件有时拿到的是已经解开的普通对象。两种都读，坏值一律回落到空集。
 * @param {unknown} field - 配置字段。
 * @returns {string[]} 干净的 route 列表。
 */
function routesOf(field) {
  const raw = field !== null && typeof field === 'object' && typeof field.get === 'function'
    ? field.get()
    : field;
  return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.length > 0) : [];
}

/**
 * 取（或安装）挂在 llm 实例上的过滤补丁。
 * 用引用计数，保证插件被重新 apply（volatile 之外的配置改动会重启插件）时不会叠加多层包装，
 * 而插件真正卸载时能把原型上的 `listModels` 还原回去。
 * @param {object} llm - `ctx.llm` 服务实例。
 * @returns {{ state: { disabled: Set<string> }, release: () => void }}
 */
function acquireFilter(llm) {
  let state = llm[PATCH];
  if (state === undefined) {
    const original = llm.listModels.bind(llm);
    state = { original, disabled: new Set(), holders: 0 };
    const patched = (provider, signal) => (
      state.disabled.has(String(provider)) ? Promise.resolve([]) : state.original(provider, signal)
    );
    Object.defineProperty(llm, 'listModels', {
      value: patched, writable: true, configurable: true, enumerable: false,
    });
    Object.defineProperty(llm, PATCH, {
      value: state, writable: true, configurable: true, enumerable: false,
    });
  }
  state.holders += 1;
  return {
    state,
    release: () => {
      state.holders -= 1;
      if (state.holders > 0) return;
      if (llm[PATCH] !== state) return;
      // 删掉自有属性 → 重新露出 LlmRuntime 原型上的 listModels
      Reflect.deleteProperty(llm, 'listModels');
      Reflect.deleteProperty(llm, PATCH);
    },
  };
}

/**
 * 挂载。
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 已校验的插件配置（`Config` 的产物）。
 */
export function apply(ctx, config) {
  // 这个页面/权限我们自己接管：不要让设置界面再自动生成一张表单卡片。
  // （`auto: false` 只影响自动表单，不影响配置读写。）
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  // 把命名空间 id 告诉浏览器半端（和 @deepseek-ai/dsh-client-ui-settings-models
  // 注入 __DSH_MODELS_ONBOARDING__ 是同一个手法）。
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_PROVIDER_TOGGLE__',
      value: { ns: ctx.fiber?.entry?.options?.id ?? NS_FALLBACK },
    });
  });

  ctx.inject(['llm'], (child) => {
    const llm = child.llm;
    const { state, release } = acquireFilter(llm);

    /**
     * 重新读一遍配置。
     * 快路径是 volatile ref；万一拿到的是普通对象（第三方插件的历史坑），
     * 就拐回 settings 服务读当前文档 —— 保证"永远读得到刚写进去的值"。
     */
    const readDisabled = () => {
      const field = config?.disabled;
      if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
        state.disabled = new Set(routesOf(field));
        return;
      }
      if (Array.isArray(field)) {
        state.disabled = new Set(routesOf(field));
        return;
      }
      const ns = ctx.fiber?.entry?.options?.id ?? NS_FALLBACK;
      const settings = ctx.get('settings');
      const namespaces = typeof settings?.describe === 'function'
        ? settings.describe({ redactSecrets: true })?.namespaces
        : undefined;
      const entry = Array.isArray(namespaces) ? namespaces.find((item) => item.ns === ns) : undefined;
      state.disabled = new Set(routesOf(entry?.value?.disabled));
    };

    readDisabled();

    // 挂载时也广播一次：插件被整体重载（非 volatile 字段改动）时不会有
    // loader/volatile-update，浏览器那侧得靠这个事件重载模型目录。
    queueMicrotask(() => {
      try {
        llm.emitAdaptersUpdated?.();
      } catch (error) {
        ctx.logger?.warn?.('provider-toggle: failed to announce llm/adapters-updated');
        ctx.logger?.warn?.(error);
      }
    });

    // volatile 配置变更 → 重新读值，并让浏览器重载模型目录。
    // `llm/adapters-updated` 正是 dsh-client-ui-model-selection 的
    // `catalog.refresh()` 监听的那个事件。
    ctx.on('loader/volatile-update', () => {
      readDisabled();
      try {
        llm.emitAdaptersUpdated?.();
      } catch (error) {
        ctx.logger?.warn?.('provider-toggle: failed to announce llm/adapters-updated');
        ctx.logger?.warn?.(error);
      }
    });

    child.effect(() => () => release());
  });
}

export { PATCH, routesOf };
