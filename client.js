/**
 * dsh-provider-toggle —— 模型提供商一键开关（client 半端 / 浏览器）
 * ============================================================================
 * 在「设置 → 模型」的每个提供商行里渲染一个开关（就放在「编辑」左边），
 * 状态存在插件自己的 settings 命名空间里，host 半端据此把该 provider
 * 从模型目录里摘掉（→ 主界面「选择模型」栏里消失）。
 *
 * 挂载点：`settings.models.provider-card` —— 这是
 * @deepseek-ai/dsh-client-ui-settings-models 声明的 **keyed** slot，
 * 渲染方式是 renderSlot(name, props, { entryKey: row.entry.settingsNs })。
 * 也就是说同一个 settingsNs 的注册会**在每一行各渲染一次**，props 里带着当行的
 * `provider`（`{ provider, displayName, settingsNs, settingsPath, declared }`）。
 * 所有 pi-ai 路由（DeepSeek / openai / opencode-go / 自定义中转…）共用同一个
 * settingsNs（`["providers", <route>]` 才是逐 provider 的），所以**一个 key 的
 * 一条注册就够覆盖全部行**；`deepseek-account` 之类的独立名字空间会各自再注册一条。
 *
 * 位置：slot 的内容会渲染在 rowHead **下面**（同一张卡片里），所以要靠测量把它
 * 绝对定位到行头右侧、「编辑 / 删除」按钮组的左边。量不到就退化成行内显示，
 * 功能不受影响。
 *
 * 读写：全部走现成的 `ctx.remote.settings.describe() / mutate()`，不自己造远程接口。
 * 布局相关类名是 CSS Module 哈希（形如 `_5M2yiq_rowActions`），所以用
 * `[class*="rowActions"]` 这种子串选择器，避免跟着构建哈希走。
 */

window.__ModuleLoader__.load({
	id: "dsh-provider-toggle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		const Switch = primitives.Switch;

		const SOURCE = "dsh-provider-toggle";
		/** 由 @deepseek-ai/dsh-client-ui-settings-models 声明的 keyed slot。 */
		const SLOT = "settings.models.provider-card";
		/** host 半端通过 webserver/index-inject 注入的命名空间 id；再给一个兜底。 */
		const NS_FALLBACK = "dsh-provider-toggle";

		/**
		 * 不给开关的 provider route。
		 * `deepseek-account` 必须排除：@deepseek-ai/dsh-client-ui-settings-models 在
		 * 加载行列表时会查 `remote.session.modelCatalog()`，并且
		 *   s.rows.filter(row => row.entry.provider !== "deepseek-account" || row.accountAvailable === true)
		 * —— 也就是说这个 provider 一被从模型目录摘掉，**它自己这一行也一起消失**，
		 * 界面里就再也没有把它打开回来的入口了（只能去手改 profile 的 cordis.patch.yml）。
		 * 它是账号登录型 provider，不是 API Key 型，本来也不适合当"开关"用。
		 */
		const NO_TOGGLE = new Set(["deepseek-account"]);

		// ---------------------------------------------------------------- 文案
		const ZH = (() => {
			const lang = String(
				(globalThis.document && globalThis.document.documentElement && globalThis.document.documentElement.lang)
				|| globalThis.navigator?.language
				|| "zh",
			);
			return /^zh/i.test(lang);
		})();
		const COPY = ZH
			? {
				label: "在模型选择器中显示 {provider}",
				titleOn: "已启用：会出现在「选择模型」栏里。点击隐藏。",
				titleOff: "已停用：已从「选择模型」栏里消失。点击恢复。",
				busy: "正在保存…",
				error: "保存失败",
			}
			: {
				label: "Show {provider} in the model picker",
				titleOn: "Enabled: listed in the model picker. Click to hide.",
				titleOff: "Disabled: hidden from the model picker. Click to restore.",
				busy: "Saving…",
				error: "Save failed",
			};
		const copy = (key, provider) => String(COPY[key]).replace("{provider}", provider ?? "");

		function namespaceId() {
			const injected = globalThis.__DSH_PROVIDER_TOGGLE__;
			return injected !== null
				&& typeof injected === "object"
				&& typeof injected.ns === "string"
				&& injected.ns.length > 0
				? injected.ns
				: NS_FALLBACK;
		}

		// ------------------------------------------------------- 共享状态（单例）
		/** 页面级单例：所有行共享同一份"哪些 provider 被关掉了"。 */
		let pluginCtx;
		let state = { status: "idle", ns: null, revision: undefined, disabled: [], error: null };
		const listeners = new Set();

		function publish(next) {
			state = next;
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					console.error(`${SOURCE}: listener failed`, error);
				}
			}
		}

		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		/** 从 settings 文档里读回当前状态（describe 同时负责推进 revision 记账）。 */
		async function refresh() {
			const ctx = pluginCtx;
			if (ctx === undefined) return;
			const wanted = state.ns ?? namespaceId();
			let response;
			try {
				response = await ctx.remote.settings.describe();
			} catch (error) {
				publish({ ...state, status: "error", error: String(error?.message ?? error) });
				return;
			}
			if (response === undefined || response.ok !== true) {
				publish({ ...state, status: "error", error: response?.error?.message ?? "settings.describe() failed" });
				return;
			}
			const namespaces = Array.isArray(response.value?.namespaces) ? response.value.namespaces : [];
			// 首选注入进来的 id；找不到就按"值里带 disabled 数组"反查一次，
			// 这样即使 profile 里的 entry id 被改过也仍然能用。
			const entry = namespaces.find((item) => item.ns === wanted)
				?? namespaces.find((item) => item?.value !== null && typeof item?.value === "object" && Array.isArray(item.value.disabled));
			if (entry === undefined) {
				if (state.status !== "missing" || state.ns !== wanted) {
					console.warn(`${SOURCE}: settings namespace "${wanted}" is not exposed — no toggle rendered`);
				}
				publish({ ...state, status: "missing", ns: wanted, error: null });
				return;
			}
			const raw = entry.value !== null && typeof entry.value === "object" ? entry.value.disabled : undefined;
			publish({
				status: "ready",
				ns: entry.ns,
				revision: entry.revision,
				disabled: Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [],
				error: null,
			});
		}

		/**
		 * 写回开关状态。
		 * @param {string} route - provider route（就是 provider 行的 id）。
		 * @param {boolean} enabled - true = 在模型选择器里显示。
		 */
		async function setRoute(route, enabled) {
			const ctx = pluginCtx;
			if (ctx === undefined || state.status !== "ready" || state.ns === null) return;
			const next = new Set(state.disabled);
			if (enabled) next.delete(route);
			else next.add(route);
			const value = [...next];
			const previous = state;
			// 乐观更新：开关先动，失败再回滚。
			publish({ ...state, disabled: value, error: null });
			let response;
			try {
				response = await ctx.remote.settings.mutate(
					previous.ns,
					[{ op: "set", path: ["disabled"], value }],
					previous.revision,
				);
			} catch (error) {
				response = undefined;
				console.error(`${SOURCE}: mutate threw`, error);
			}
			if (response !== undefined && response.ok === true) {
				const raw = response.value?.value !== null && typeof response.value?.value === "object"
					? response.value.value.disabled
					: undefined;
				publish({
					status: "ready",
					ns: previous.ns,
					revision: response.value?.revision ?? previous.revision,
					disabled: Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : value,
					error: null,
				});
				return;
			}
			console.error(`${SOURCE}: write refused`, response?.error);
			publish({ ...previous, error: response?.error?.message ?? COPY.error });
			await refresh();
		}

		// ------------------------------------------------------------- 定位
		/**
		 * 把开关绝对定位到行头右侧、按钮组左边。
		 * 量不到任何关键元素就原样退回行内布局（功能不受影响）。
		 * @param {HTMLElement | null} anchorEl - 插槽渲染出来的外壳元素。
		 */
		function placeSwitch(anchorEl) {
			if (anchorEl === null || anchorEl === undefined) return;
			const row = anchorEl.closest("li");
			if (row === null) return;
			const head = row.querySelector('[class*="rowHead"]');
			const actions = row.querySelector('[class*="rowActions"]');
			if (head === null || actions === null) return;
			if (getComputedStyle(row).position === "static") row.style.position = "relative";
			const rowBox = row.getBoundingClientRect();
			const headBox = head.getBoundingClientRect();
			const actionBox = actions.getBoundingClientRect();
			anchorEl.style.position = "absolute";
			anchorEl.style.left = "auto";
			anchorEl.style.top = `${headBox.top - rowBox.top}px`;
			anchorEl.style.height = `${headBox.height}px`;
			anchorEl.style.right = `${Math.max(0, rowBox.right - actionBox.left + 8)}px`;
			anchorEl.style.display = "flex";
			anchorEl.style.alignItems = "center";
		}

		// ------------------------------------------------------------ 组件
		/**
		 * 一行的开关。props 由 slot 渲染器给出，`props.provider` 就是那一行的目录条目。
		 * @param {{ provider?: { provider?: string, displayName?: string } }} props - slot props。
		 * @returns {object | null} 开关元素。
		 */
		function ProviderToggle(props) {
			const entry = props?.provider;
			const route = entry !== null && typeof entry === "object" && typeof entry.provider === "string"
				? entry.provider
				: null;
			const displayName = entry?.displayName ?? route;

			const [snap, setSnap] = react.useState(state);
			const [busy, setBusy] = react.useState(false);
			const anchor = react.useRef(null);
			const placement = react.useCallback(() => {
				placeSwitch(anchor.current);
			}, []);

			react.useEffect(() => {
				setSnap(state);
				const unsubscribe = subscribe(() => setSnap(state));
				void refresh();
				return unsubscribe;
			}, []);

			// 每次提交后重新量一次（按钮组宽度会随「删除」出现/消失而变），
			// 再加一个 ResizeObserver 兜住卡片自身的尺寸变化。
			react.useLayoutEffect(() => {
				placement();
			});
			react.useEffect(() => {
				window.addEventListener("resize", placement);
				let observer;
				try {
					observer = new ResizeObserver(placement);
					if (anchor.current !== null) observer.observe(anchor.current.closest("li") ?? anchor.current);
				} catch {
					observer = undefined;
				}
				return () => {
					window.removeEventListener("resize", placement);
					observer?.disconnect();
				};
			}, [placement]);

			if (route === null || NO_TOGGLE.has(route)) return null;
			if (snap.status === "missing" || snap.status === "error") return null;

			const checked = !snap.disabled.includes(route);
			const disabled = snap.status !== "ready" || busy;
			return h(
				"span",
				{ ref: anchor, "data-dsh-provider-toggle": "1" },
				h(Switch, {
					checked,
					disabled,
					label: copy("label", displayName),
					title: busy ? COPY.busy : copy(checked ? "titleOn" : "titleOff", displayName),
					onChange: (next) => {
						setBusy(true);
						Promise.resolve(setRoute(route, next)).finally(() => setBusy(false));
					},
				}),
			);
		}

		// ------------------------------------------------------------- 挂载
		/** 需要 cordis 服务：插槽注册表 + 远程 settings / llm。 */
		const inject = ["slots", "remote", "remote.llm", "remote.settings"];

		/**
		 * 给每一个 settingsNs 注册一条 keyed 插槽条目。
		 * @param {object} ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			pluginCtx = ctx;

			const keys = new Set();
			let installDisposer = null;

			const install = () => {
				if (installDisposer !== null) {
					try {
						installDisposer();
					} catch (error) {
						console.warn(`${SOURCE}: re-register`, error);
					}
					installDisposer = null;
				}
				const list = [...keys];
				if (list.length === 0) return;
				try {
					installDisposer = ctx.slots.inject(SLOT, function* register() {
						for (const key of list) {
							yield ctx.slots.register({ name: SLOT, key }, ProviderToggle);
						}
					});
				} catch (error) {
					// 插件已卸载 / 插槽系统不可用：静默放弃，别把设置页带崩。
					installDisposer = null;
					console.warn(`${SOURCE}: slot registration skipped`, error);
				}
			};

			const loadKeys = async () => {
				let response;
				try {
					response = await ctx.remote.llm.listConfigurableProviders();
				} catch (error) {
					console.warn(`${SOURCE}: listConfigurableProviders threw`, error);
					return;
				}
				if (response === undefined || response.ok !== true) {
					console.warn(`${SOURCE}: listConfigurableProviders refused`, response?.error);
					return;
				}
				const next = new Set();
				for (const item of response.value ?? []) {
					if (item !== null && typeof item === "object" && typeof item.settingsNs === "string" && item.settingsNs.length > 0) {
						next.add(item.settingsNs);
					}
				}
				if (next.size === keys.size && [...next].every((key) => keys.has(key))) return;
				keys.clear();
				for (const key of next) keys.add(key);
				install();
			};

			void loadKeys();
			void refresh();

			ctx.effect(() => ctx.remote.$on("llm/adapters-updated", () => {
				void loadKeys();
				void refresh();
			}), "provider-toggle: provider directory invalidations");

			ctx.effect(() => () => {
				if (installDisposer !== null) {
					try {
						installDisposer();
					} catch (error) {
						console.warn(`${SOURCE}: dispose`, error);
					}
					installDisposer = null;
				}
			}, "provider-toggle: slot registrations");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.ProviderToggle = ProviderToggle;
		return module.exports;
	},
});
