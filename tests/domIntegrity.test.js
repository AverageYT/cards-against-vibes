/**
 * tests/domIntegrity.test.js
 * Plain-Node verification of static HTML/CSS/JS integrity and duelView DOM binding.
 * (Honest scope: verifies DOM node wiring, event binding, keyboard handler, zero CDN
 * links, and clean listener teardown in Node — does not replace visual browser rendering.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PHASES, SIDES } from "../src/core/engine.js";
import { STARTING_MODES, createDuelController } from "../src/ui/duelController.js";
import { mountDuelView } from "../src/ui/duelView.js";

class MockClassList {
  constructor(owner) {
    this.owner = owner;
    this.set = new Set();
  }
  syncFromString(str) {
    this.set = new Set(String(str || "").split(/\s+/).filter(Boolean));
  }
  toString() {
    return Array.from(this.set).join(" ");
  }
  add(...names) {
    for (const n of names) if (n) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  toggle(name, force) {
    if (force === undefined) {
      if (this.set.has(name)) {
        this.set.delete(name);
        return false;
      }
      this.set.add(name);
      return true;
    }
    if (force) this.set.add(name);
    else this.set.delete(name);
    return Boolean(force);
  }
  contains(name) {
    return this.set.has(name);
  }
}

class MockElement {
  constructor(tagName, doc, id = "") {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new MockClassList(this);
    this._text = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.type = "";
    this.title = "";
  }
  get className() {
    return this.classList.toString();
  }
  set className(val) {
    this.classList.syncFromString(val);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(val) {
    this.children = [];
    this._text = String(val ?? "");
  }
  appendChild(child) {
    if (child && child.isFragment) {
      for (const c of child.children) this.children.push(c);
      child.children = [];
      return child;
    }
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    for (const n of nodes) this.appendChild(n);
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const bucket = this.listeners.get(type);
    bucket.add(fn);
    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => bucket.delete(fn), { once: true });
    }
  }
  dispatch(type, extra = {}) {
    const ev = {
      type,
      target: extra.target || this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const fn of Array.from(this.listeners.get(type) || [])) {
      fn(ev);
    }
    return ev;
  }
  click() {
    if (this.disabled) return;
    this.dispatch("click");
  }
  focus() {
    if (!this.disabled) {
      this.ownerDocument.activeElement = this;
    }
  }
  querySelectorAll(selector) {
    if (selector === "button.ticket:not(:disabled)") {
      return this.children.filter(
        (c) => c.tagName === "BUTTON" && c.classList.contains("ticket") && !c.disabled
      );
    }
    return [];
  }
  querySelector(selector) {
    const match = selector.match(/^button\.ticket\[data-slot="(\d+)"\]:not\(:disabled\)$/);
    if (match) {
      const slot = match[1];
      return (
        this.children.find(
          (c) =>
            c.tagName === "BUTTON" &&
            c.classList.contains("ticket") &&
            c.dataset.slot === slot &&
            !c.disabled
        ) || null
      );
    }
    return null;
  }
  listenerCount() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function createMockDocumentFromIndexHtml(html) {
  const doc = {
    body: null,
    activeElement: null,
    byId: new Map(),
    bySelector: new Map(),
    listeners: new Map(),
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    createDocumentFragment() {
      return {
        isFragment: true,
        children: [],
        appendChild(c) {
          this.children.push(c);
          return c;
        },
      };
    },
    getElementById(id) {
      return doc.byId.get(id) || null;
    },
    querySelector(sel) {
      return doc.bySelector.get(sel) || null;
    },
    addEventListener(type, fn, opts) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, new Set());
      const bucket = doc.listeners.get(type);
      bucket.add(fn);
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => bucket.delete(fn), { once: true });
      }
    },
    dispatch(type, extra = {}) {
      const ev = {
        type,
        target: extra.target || doc.body,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...extra,
      };
      for (const fn of Array.from(doc.listeners.get(type) || [])) fn(ev);
      return ev;
    },
  };
  doc.body = new MockElement("body", doc);
  doc.activeElement = doc.body;

  // Populate every id="..." found in index.html so missing HTML IDs fail immediately.
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/gi)) {
    const [, tag, id] = m;
    doc.byId.set(id, new MockElement(tag, doc, id));
  }
  doc.bySelector.set(".seat-inspector", new MockElement("section", doc));
  doc.bySelector.set(".seat-player", new MockElement("section", doc));
  return doc;
}

test("Static build has zero external/CDN URLs and index.html wires every duelView control cleanly", () => {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("styles/main.css"), "utf8");

  assert.equal(/https?:\/\//i.test(html), false, "index.html must have zero external URLs");
  assert.equal(/https?:\/\//i.test(css), false, "styles/main.css must have zero external URLs");

  // Verify every ID referenced by duelView.js exists in index.html.
  const viewSource = fs.readFileSync(path.resolve("src/ui/duelView.js"), "utf8");
  for (const m of viewSource.matchAll(/getElementById\("([^"]+)"\)/g)) {
    const id = m[1];
    assert.ok(html.includes(`id="${id}"`), `index.html missing required element #${id}`);
  }

  // Mount duelView onto mock DOM and drive a full duel via rendered buttons & keyboard events.
  const doc = createMockDocumentFromIndexHtml(html);
  const ctrl = createDuelController({
    initialSeed: "DOM-FLOW-7",
    initialPairCount: 6,
    initialStartingMode: STARTING_MODES.PLAYER_OFFERS_FIRST,
    immediate: true,
  });
  const viewHandle = mountDuelView(ctrl, doc);
  ctrl.startDuel();

  let guard = 0;
  while (ctrl.getSnapshot().view.phase !== PHASES.OVER) {
    guard += 1;
    assert.ok(guard < 200, "DOM-driven duel terminates");
    const snap = ctrl.getSnapshot();
    assert.equal(snap.view.activeActor, SIDES.PLAYER);

    if (snap.view.phase === PHASES.OFFER) {
      const playerButtons = doc.getElementById("player-fan").querySelectorAll("button.ticket:not(:disabled)");
      if (playerButtons.length >= 2) {
        // Test keyboard ArrowRight focus + click swap + focus preservation!
        doc.dispatch("keydown", { key: "ArrowRight", target: doc.body });
        assert.equal(doc.activeElement.dataset.zone, "player");
        playerButtons[0].click();
        assert.equal(
          doc.activeElement?.dataset?.slot,
          "0",
          "Keyboard focus preserved on ticket after staging swap"
        );
        const refreshed = doc.getElementById("player-fan").querySelectorAll("button.ticket:not(:disabled)");
        refreshed[1].click();
        assert.ok(
          doc.getElementById("player-fan").textContent.includes("SWAPPED"),
          "Swapped cards show explicit SWAPPED badge"
        );
      }
      // Commit via keyboard shortcut C
      doc.dispatch("keydown", { key: "c", target: doc.body });
    } else {
      const inspButtons = doc.getElementById("inspector-fan").querySelectorAll("button.ticket:not(:disabled)");
      assert.ok(inspButtons.length >= 1, "At least one enabled Inspector card to draw");
      inspButtons[0].click();
    }
  }

  const resultPanel = doc.getElementById("result-panel");
  assert.equal(resultPanel.classList.contains("hidden"), false, "Result panel visible at DUEL_OVER");

  // Verify developer trace panel starts hidden, opens on click, renders legal trace, and hides again.
  const devPanel = doc.getElementById("dev-trace-panel");
  const devToggle = doc.getElementById("dev-trace-toggle");
  assert.equal(devPanel.classList.contains("hidden"), true, "Dev trace hidden by default");
  devToggle.click();
  assert.equal(devPanel.classList.contains("hidden"), false, "Dev trace visible when toggled on");
  assert.ok(
    doc.getElementById("dev-buckets").children.length === 5,
    "Dev trace shows all 5 normalized buckets"
  );
  devToggle.click();
  assert.equal(devPanel.classList.contains("hidden"), true, "Dev trace closes cleanly");

  // Verify destroy() removes all registered listeners cleanly.
  viewHandle.destroy();
  ctrl.dispose();
  let remainingDocListeners = 0;
  for (const s of doc.listeners.values()) remainingDocListeners += s.size;
  assert.equal(remainingDocListeners, 0, "Zero document listeners remain after destroy()");
  for (const el of doc.byId.values()) {
    assert.equal(el.listenerCount(), 0, `Zero listeners remain on #${el.id} after destroy()`);
  }
});
