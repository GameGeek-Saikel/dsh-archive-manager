// dsh-archive-manager client bundle self-tests (node:test).
//
// Materializes the client bundle against the DSH 0.2.0 shell seed table and
// exercises the bundle's own surfaces: the Remote contribution, the
// pending-deletion store, the row-menu action, and the confirmation dialog.
// Every shared module is loaded through ONE CommonJS resolver so the bundle and
// react-dom/server observe the same React instance (two copies would break the
// hook dispatcher).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireFallback = createRequire(import.meta.url);
const react = requireFallback("react");

// --- static module table (mirror of the 0.2.0 shell seed table, subset used here) ---
const statics = {
	react,
	"react/jsx-runtime": requireFallback("react/jsx-runtime"),
	"react-dom": requireFallback("react-dom"),
	"react-dom/server": requireFallback("react-dom/server")
};
const { renderToStaticMarkup } = statics["react-dom/server"];
// ui-primitives imports CSS through its bundler pipeline, which plain Node CJS
// cannot load. The bundle only renders MenuItemButton/Button/Modal, so a small
// functional stand-in keeps the surfaces renderable and assertable.
const primitivesStandIn = {
	IconTrashOutlineRegular: (props) => react.createElement("svg", { "data-icon": "trash", ...props }),
	MenuItemButton: ({ children, danger, separatorBefore, onSelect }) =>
		react.createElement("button", {
			type: "button",
			role: "menuitem",
			"data-danger": danger === true ? "true" : "false",
			"data-separator": separatorBefore === true ? "true" : "false",
			onClick: onSelect
		}, children),
	Button: ({ children, variant, disabled, onClick }) =>
		react.createElement("button", { type: "button", "data-variant": variant, disabled, onClick }, children),
	Modal: ({ open, title, description, closeLabel, children, footer }) =>
		open === true
			? react.createElement("div", { "data-modal": title, "data-close-label": closeLabel },
				react.createElement("p", { "data-description": "true" }, description),
				children,
				react.createElement("div", { "data-footer": "true" }, footer))
			: null
};
statics["@deepseek-ai/dsh-client-ui-primitives"] = primitivesStandIn;

// --- browser environment stubs for bundle materialization ---
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, set textContent(v) {} }), head: { appendChild: () => {} } };
const factories = new Map();
window.__ModuleLoader__ = { load: (handoff) => { factories.set(handoff.id, handoff.factory); } };

function materialize(id) {
	const factory = factories.get(id);
	if (factory === void 0) throw new Error(`no factory registered for ${id}`);
	const module = { exports: {} };
	const require = (spec) => {
		if (Object.hasOwn(statics, spec)) return statics[spec];
		throw new Error(`smoke require miss: ${spec}`);
	};
	return factory(require, module, module.exports) ?? module.exports;
}

await import(pathToFileURL(fileURLToPath(new URL("../dsh-archive-manager-client/lib/client.js", import.meta.url))).href);
const bundle = materialize("@gamegeek-saikel/dsh-archive-manager");
const t = bundle.__test;

/** The zh translate seat the surfaces receive through their locale registration. */
const zhT = (key, params) => {
	const text = t.zh[key] ?? key;
	return Object.entries(params ?? {}).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text);
};

test("bundle materializes with apply/inject and the __test surface", () => {
	assert.equal(typeof bundle.apply, "function");
	assert.deepEqual(bundle.inject, ["contextMenus", "shortcuts", "sessions", "slots", "locale", "remote"]);
	assert.equal(typeof t.callDelete, "function");
	assert.equal(typeof t.currentSession, "function");
	assert.equal(typeof t.DeleteSessionDialog, "function");
	// The bundle requires nothing beyond the shared platform modules.
	assert.equal(typeof bundle.NS, "string");
});

/**
 * A client context recording what `apply` registers. `effect` runs its factory
 * immediately, mirroring the framework's own initial run.
 * @param {object} options - `rows` is the Session list's `byId` snapshot.
 * @returns the fake context and the captured registrations.
 */
function fakeCtx({ rows = {} } = {}) {
	const captured = { menus: [], shortcuts: [], icons: [], injections: [] };
	const ctx = {
		effect: (factory) => { factory(); return () => {}; },
		locale: { register: () => () => {}, bind: () => zhT },
		remote: { $mount: async () => () => {} },
		sessions: { list: { getSnapshot: () => ({ byId: rows }) } },
		contextMenus: { register: (contribution) => { captured.menus.push(contribution); return () => {}; } },
		shortcuts: { register: (command) => { captured.shortcuts.push(command); return () => {}; } },
		slots: {
			inject: (name, factory) => { captured.injections.push({ name, factory }); },
			register: (options, component) => { captured.icons.push({ options, component }); return () => {}; }
		},
		get: () => void 0
	};
	return { ctx, captured };
}

/** Drain one recorded slot injection (generator or factory) into its registrations. */
function drain(captured, name) {
	const entry = captured.injections.find((candidate) => candidate.name === name);
	if (entry === void 0) return undefined;
	const result = entry.factory();
	if (result !== null && typeof result === "object" && typeof result[Symbol.iterator] === "function") {
		for (const _ of result) { /* each yield already ran ctx.slots.register */ }
	}
	return entry;
}

test("Remote contribution declares exactly the deleteSession endpoint with strict codecs", () => {
	assert.equal(t.ARCHIVE_MANAGER_REMOTE.package, "@gamegeek-saikel/dsh-archive-manager");
	assert.equal(t.ARCHIVE_MANAGER_REMOTE.descriptors.length, 1);
	const [descriptor] = t.ARCHIVE_MANAGER_REMOTE.descriptors;
	assert.equal(descriptor.service, "workspaceRegistry");
	assert.equal(descriptor.namespace, "workspaceRegistry");
	assert.equal(descriptor.method, "deleteSession");
	assert.deepEqual(descriptor.invocation, { kind: "direct" });
	assert.equal(descriptor.parameters.length, 1);
	assert.equal(descriptor.parameters[0].name, "sessionId");
	assert.equal(descriptor.parameters[0].codec.mode, "strict");
	assert.equal(descriptor.result.mode, "strict");
	// The 0.2.0 generated contract is { mode, typeSymbol, create() }: the
	// Client gateway validates that shape before a contribution may mount.
	assert.equal(typeof descriptor.parameters[0].codec.create, "function");
	assert.equal(typeof descriptor.result.create, "function");
	assert.ok(descriptor.parameters[0].codec.typeSymbol.length > 0);
	assert.ok(descriptor.result.typeSymbol.length > 0);
	// the codec shims validate when the factory is exercised
	const sessionId = descriptor.parameters[0].codec.create();
	assert.equal(sessionId.parse("s1"), "s1");
	assert.throws(() => sessionId.parse(""), TypeError);
	assert.throws(() => sessionId.parse(7), TypeError);
	const deleted = descriptor.result.create();
	assert.deepEqual(deleted.parse({ deleted: true }), { deleted: true });
	assert.throws(() => deleted.parse({ deleted: false }), TypeError);
	assert.throws(() => deleted.parse(null), TypeError);
});

test("pending-deletion store notifies subscribers and dedupes the same id", () => {
	const seen = [];
	const unsubscribe = t.subscribe(() => seen.push(t.getPending()));
	assert.equal(t.getPending(), null);
	t.setPending("s1");
	assert.equal(t.getPending(), "s1");
	t.setPending("s1"); // same request: no second notification
	assert.deepEqual(seen, ["s1"]);
	t.setPending("s2");
	assert.deepEqual(seen, ["s1", "s2"]);
	unsubscribe();
	t.setPending(null);
	assert.deepEqual(seen, ["s1", "s2"], "unsubscribed listeners stop hearing the store");
	assert.equal(t.getPending(), null);
});

test("the menu entry renders below Archive and raises the confirmation", async () => {
	const { ctx, captured } = fakeCtx();
	await bundle.apply(ctx);
	assert.equal(captured.menus.length, 1);
	const [menu] = captured.menus;
	assert.equal(menu.id, t.DELETE_COMMAND_ID);
	assert.equal(menu.target, "session");
	// Archive is 600 with afterContent; the entry must follow it, not precede it.
	assert.ok(menu.order > 600, `order ${menu.order} must sort after Archive's 600`);
	const actions = menu.resolve({ sessionId: "s1", displayTitle: "t" });
	assert.equal(actions.length, 1);
	const [action] = actions;
	assert.deepEqual({
		id: action.id,
		label: action.label,
		icon: action.icon,
		danger: action.danger,
		separatorBefore: action.separatorBefore,
		afterContent: action.afterContent,
		commandId: action.commandId
	}, {
		id: "delete",
		label: "删除会话",
		icon: { key: t.DELETE_ICON_KEY },
		danger: true,
		separatorBefore: true,
		afterContent: true,
		commandId: t.DELETE_COMMAND_ID
	});
	t.setPending(null);
	action.run();
	assert.equal(t.getPending(), "s1");
	t.setPending(null);
});

 test("the keyed trash icon is contributed for the entry", async () => {
	const { ctx, captured } = fakeCtx();
	await bundle.apply(ctx);
	assert.ok(drain(captured, "contextMenu.icon") !== undefined, "the icon slot is injected");
	assert.equal(captured.icons.length, 1);
	assert.deepEqual(captured.icons[0].options, { name: "contextMenu.icon", key: t.DELETE_ICON_KEY });
	assert.equal(captured.icons[0].component, primitivesStandIn.IconTrashOutlineRegular);
});

 test("the shortcut shows beside the label and only opens the confirmation", async () => {
	const { ctx, captured } = fakeCtx({ rows: { s1: { id: "s1", retainedBy: { mainView: 1 } } } });
	await bundle.apply(ctx);
	assert.equal(captured.shortcuts.length, 1);
	const [command] = captured.shortcuts;
	assert.equal(command.id, t.DELETE_COMMAND_ID);
	assert.equal(command.label(), "删除会话");
	assert.deepEqual(command.regions, ["page", "editable"]);
	assert.deepEqual(command.modals, ["sidebar"]);
	assert.equal(command.defaults["web:windows"].code, "KeyD");
	assert.deepEqual(command.defaults["web:windows"].modifiers, ["primary", "alt"]);
	// macOS keeps Cmd+Option+D for the Dock.
	assert.deepEqual(command.defaults["desktop:macos"].modifiers, ["primary", "shift"]);
	const resolved = command.resolve({ modal: null });
	assert.equal(resolved.status, "handled");
	t.setPending(null);
	resolved.run();
	assert.equal(t.getPending(), "s1", "the binding raises the dialog, never the deletion");
	t.setPending(null);
});

 test("the shortcut blocks without an open Session", async () => {
	const { ctx, captured } = fakeCtx();
	await bundle.apply(ctx);
	const [command] = captured.shortcuts;
	assert.deepEqual(command.resolve({ modal: null }), { status: "blocked", reason: "请先选择一个会话" });
});

test("the confirmation dialog renders nothing with no request and the full copy with one", () => {
	const props = { deleteSession: () => Promise.resolve({ deleted: true }), t: zhT };
	const render = () => renderToStaticMarkup(react.createElement(t.DeleteSessionDialog, props));
	t.setPending(null);
	assert.equal(render(), "");
	t.setPending("s1");
	const markup = render();
	t.setPending(null);
	assert.match(markup, /data-modal="删除会话"/);
	assert.match(markup, /此操作不可撤销/);
	assert.match(markup, /分叉出的会话是独立会话/);
	assert.match(markup, /data-close-label="关闭"/);
	assert.match(markup, /永久删除/);
	assert.match(markup, /取消/);
});

test("callDelete unwraps the Remote result and folds a failure into a throw", async () => {
	const calls = [];
	const ctx = {
		get: (key) => key === "remote.workspaceRegistry"
			? { deleteSession: async (sessionId) => { calls.push(sessionId); return { ok: true, value: { deleted: true } }; } }
			: void 0
	};
	assert.deepEqual(await t.callDelete(ctx, "s1"), { deleted: true });
	assert.deepEqual(calls, ["s1"]);
	const failure = Object.assign(new Error("no such session"), { code: "session/unknown" });
	const failing = { get: () => ({ deleteSession: async () => ({ ok: false, error: failure }) }) };
	await assert.rejects(() => t.callDelete(failing, "s1"), /no such session/);
	const unmounted = { get: () => void 0 };
	await assert.rejects(() => t.callDelete(unmounted, "s1"), /not mounted/);
});
