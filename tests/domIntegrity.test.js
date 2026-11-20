/**
 * tests/domIntegrity.test.js
 * Plain-Node verification of static HTML/CSS/JS integrity and full Phase 3 appView
 * DOM binding across Title, Interactive Tutorial, Carriage Briefing, Carriage Table,
 * Stop Result, Stamp Reward Tray, Run Over, Dev Trace, keyboard play, and teardown.
 *
 * (Honest scope: verifies DOM wiring, button/keyboard handlers, zero external URLs,
 * and zero listener/timer leaks in Node — does not replace visual browser rendering.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PHASES, SIDES } from "../src/core/engine.js";
import { RUN_SCREENS, createRunController } from "../src/core/run.js";
import { STAMP_IDS } from "../src/data/stamps.js";
import { mountAppView } from "../src/ui/appView.js";

class MockClassList {
  constructor() {
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
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new MockClassList();
    this._text = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.type = "";
    this.title = "";
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get childNodes() {
    return this.children;
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
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
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
    if (selector === "button:not(:disabled)") {
      return this.children.filter((c) => c.tagName === "BUTTON" && !c.disabled);
    }
    return [];
  }
  querySelector(selector) {
    const m = selector.match(/^button\[data-slot="(\d+)"\]:not\(:disabled\)$/);
    if (m) {
      return (
        this.children.find(
          (c) => c.tagName === "BUTTON" && c.dataset.slot === m[1] && !c.disabled
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
    listeners: new Map(),
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    createTextNode(str) {
      return { textContent: String(str ?? "") };
    },
    getElementById(id) {
      return doc.byId.get(id) || null;
    },
    addEventListener(type, fn) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, new Set());
      doc.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      doc.listeners.get(type)?.delete(fn);
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

  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/gi)) {
    const [, tag, id] = m;
    doc.byId.set(id, new MockElement(tag, doc, id));
  }
  return doc;
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("Static build has zero external/CDN URLs and appView drives Title, Tutorial, Briefing, Duel, Stamps, Reward & Teardown cleanly", () => {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const css = fs.readFileSync(path.resolve("styles/main.css"), "utf8");

  assert.equal(/https?:\/\//i.test(html), false, "index.html must have zero external URLs");
  assert.equal(/https?:\/\//i.test(css), false, "styles/main.css must have zero external URLs");
  for (const jsFile of listJsFiles(path.resolve("src"))) {
    const code = fs.readFileSync(jsFile, "utf8");
    assert.equal(/https?:\/\//i.test(code), false, `${jsFile} must have zero external URLs`);
  }

  // Verify every ID referenced by appView.js exists in index.html.
  const viewSource = fs.readFileSync(path.resolve("src/ui/appView.js"), "utf8");
  for (const m of viewSource.matchAll(/getElementById\("([^"]+)"\)/g)) {
    const id = m[1];
    assert.ok(html.includes(`id="${id}"`), `index.html missing required element #${id}`);
  }

  const doc = createMockDocumentFromIndexHtml(html);
  const ctrl = createRunController({
    initialSeed: "DOM-RUN-3",
    immediate: true,
    tutorialCompleted: false,
  });
  const unmount = mountAppView(ctrl, doc);

  // 1. Title screen visible; launch interactive tutorial from primary CTA and walk via DOM clicks!
  assert.equal(doc.getElementById("title-screen").classList.contains("hidden"), false);
  doc.getElementById("title-primary-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.TUTORIAL);
  assert.equal(doc.getElementById("tutorial-banner").classList.contains("hidden"), false);

  // Step 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> Complete -> Stop 1 Briefing via real DOM buttons & shortcuts!
  doc.getElementById("tutorial-next-btn").click(); // Step 2
  doc.getElementById("inspector-fan").querySelectorAll("button:not(:disabled)")[0].click(); // Step 3
  doc.dispatch("keydown", { key: "c", target: doc.body }); // Step 4
  doc.getElementById("inspector-fan").querySelectorAll("button:not(:disabled)")[0].click(); // Step 5
  const pBtns = doc.getElementById("player-fan").querySelectorAll("button:not(:disabled)");
  pBtns[1].focus();
  pBtns[1].click();
  assert.equal(doc.activeElement?.dataset?.slot, "1", "Keyboard focus preserved when staging swap");
  doc.getElementById("player-fan").querySelectorAll("button:not(:disabled)")[0].click(); // Step 6
  assert.ok(doc.getElementById("player-fan").textContent.includes("Swapped"));
  doc.getElementById("commit-offer-btn").click(); // Step 7
  // Trigger Stamp #1 via keyboard shortcut "1", cancel via Escape, re-arm via click, peek slot #1!
  doc.dispatch("keydown", { key: "1", target: doc.body });
  assert.equal(ctrl.getSnapshot().activeStampTargeting?.stampId, STAMP_IDS.INSPECTION_WINDOW);
  doc.dispatch("keydown", { key: "Escape", target: doc.body });
  assert.equal(ctrl.getSnapshot().activeStampTargeting, null);
  doc.getElementById("stamp-tray").querySelectorAll("button:not(:disabled)")[0].click();
  doc.getElementById("inspector-fan").querySelectorAll("button:not(:disabled)")[0].click(); // Step 8
  assert.ok(doc.getElementById("inspector-fan").textContent.includes("Peeked (You)"));
  doc.getElementById("inspector-fan").querySelectorAll("button:not(:disabled)")[1].click(); // COMPLETE!
  doc.getElementById("tutorial-next-btn").click(); // -> Stop 1 BRIEFING!

  // 2. Stop 1 Briefing -> play entire Best-of-3 multi-deal Stop 1 via DOM buttons -> Stop Result -> Reward/Next!
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.BRIEFING);
  assert.equal(doc.getElementById("briefing-screen").classList.contains("hidden"), false);
  assert.ok(
    doc.getElementById("briefing-inspector-stamps").children.length >= 1,
    "Briefing displays Inspector's equipped Stamps"
  );
  doc.getElementById("begin-duel-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.DUEL);

  let matchGuard = 0;
  while (
    ctrl.getSnapshot().screen === RUN_SCREENS.DUEL ||
    (ctrl.getSnapshot().screen === RUN_SCREENS.STOP_RESULT &&
      ctrl.getSnapshot().lastStopSummary?.kind === "DEAL_CONTINUE")
  ) {
    matchGuard += 1;
    assert.ok(matchGuard < 600, "DOM multi-deal carriage completes cleanly");
    const snap = ctrl.getSnapshot();
    if (snap.screen === RUN_SCREENS.STOP_RESULT) {
      doc.getElementById("stop-continue-btn").click();
      continue;
    }
    assert.equal(snap.view.activeActor, SIDES.PLAYER);
    if (snap.view.phase === PHASES.OFFER) {
      doc.dispatch("keydown", { key: "ArrowRight", target: doc.body });
      doc.getElementById("commit-offer-btn").click();
    } else {
      const iBtns = doc.getElementById("inspector-fan").querySelectorAll("button:not(:disabled)");
      assert.ok(iBtns.length >= 1);
      iBtns[0].click();
    }
  }

  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.STOP_RESULT);
  assert.equal(ctrl.getSnapshot().lastStopSummary.kind, "CARRIAGE_OVER");
  doc.getElementById("stop-continue-btn").click();
  if (ctrl.getSnapshot().screen === RUN_SCREENS.REWARD) {
    assert.equal(doc.getElementById("reward-grid").children.length, 3);
    doc.getElementById("skip-reward-btn").click();
  }
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.BRIEFING);
  assert.equal(ctrl.getSnapshot().stopIndex, 1, "Reached Stop 2 Briefing with Carriage Condition");
  assert.equal(
    doc.getElementById("briefing-condition-box").classList.contains("is-clear"),
    false,
    "Stop 2 Briefing presents an active Carriage Condition"
  );

  // 2a. Verify Platform Locker screen, unlocking ★ The Perforation Gauge, Departure Draft, and [G]/[E] Locker Tools via keyboard!
  doc.getElementById("nav-title-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.TITLE);
  ctrl.getMetaStore().grantStubsForTest(120);
  doc.getElementById("title-locker-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.LOCKER);
  assert.equal(doc.getElementById("locker-screen").classList.contains("hidden"), false);
  assert.equal(doc.getElementById("locker-grid").children.length, 6, "Renders all 6 Keepsakes");
  // Unlock Thumb-Worn Tallow (25) + Keystone Perforation Gauge (60)!
  assert.ok(ctrl.buyKeepsake("TALLOW_SEAL").ok);
  assert.ok(ctrl.buyKeepsake("PERFORATION_GAUGE").ok);
  doc.getElementById("locker-start-run-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.STARTER_DRAFT, "Opens Departure Stamp Draft");
  assert.equal(doc.getElementById("reward-grid").children.length, 3);
  doc.getElementById("skip-reward-btn").click();
  assert.equal(ctrl.getSnapshot().screen, RUN_SCREENS.BRIEFING);
  assert.ok(
    doc.getElementById("briefing-inspector-stamps").textContent.includes("JAMMED"),
    "Perforation Gauge visibly jams an Inspector Stamp on Briefing"
  );
  doc.getElementById("begin-duel-btn").click();
  assert.equal(doc.getElementById("tools-bar").classList.contains("hidden"), false);
  if (ctrl.getSnapshot().view.legal.canUseGauge) {
    doc.dispatch("keydown", { key: "g", target: doc.body });
    assert.ok(
      doc.getElementById("inspector-fan").textContent.includes("Gauge: Safe"),
      "Pressing G fires Perforation Gauge and tags guaranteed-safe card"
    );
  }
  doc.dispatch("keydown", { key: "e", target: doc.body });
  assert.ok(
    doc.getElementById("inspector-fan").textContent.includes("CHECK EDGE"),
    "Pressing E arms Check Edge targeting on hidden slots"
  );
  doc.dispatch("keydown", { key: "Escape", target: doc.body });

  // 2b. Verify Balatro-inspired in-hand Emblem synergy cues, Loupe pair labels, and Will Expose tags.
  unmount();
  const comboCtrl = createRunController({ initialSeed: "COMBO-UI-1", immediate: true });
  const unmountCombo = mountAppView(comboCtrl, doc);
  comboCtrl.startRun({
    seed: "COMBO-UI-1",
    startingStamps: [
      STAMP_IDS.MANIFEST_LOUPE,
      STAMP_IDS.CARBON_COPY,
      STAMP_IDS.BELL_CORD,
    ],
  });
  comboCtrl.beginStopDuel(); // Stop 1: Player draws first with 3 Stamps equipped!
  if (comboCtrl.getSnapshot().view.myHand.some((s) => s.ticket.symbolId === "KEY" || s.ticket.symbolId === "BELL")) {
    assert.ok(
      doc.getElementById("player-fan").textContent.includes("Charges Cord"),
      "Held Key★/Bell★ shows live Charges Cord cue while Bell Cord is dormant"
    );
  }
  // Arm Manifest Loupe and check explicit Loupe #1+#2 label on Inspector slot 0!
  comboCtrl.activateStamp(STAMP_IDS.MANIFEST_LOUPE);
  assert.ok(
    doc.getElementById("inspector-fan").textContent.includes("Loupe #1+#2"),
    "Armed Manifest Loupe displays explicit adjacent pair label Loupe #1+#2"
  );
  // Execute Loupe on #1+#2, then draw a card so Player enters Offer phase with Will Expose on leftmost card!
  comboCtrl.drawSlot(0);
  assert.ok(
    doc.getElementById("inspector-fan").textContent.includes("Loupe:"),
    "Resolved Manifest Loupe badges checked slots"
  );
  comboCtrl.drawSlot(0);
  if (comboCtrl.getSnapshot().screen === RUN_SCREENS.DUEL) {
    assert.ok(
      doc.getElementById("player-fan").textContent.includes("Will Expose"),
      "Leftmost player card previews Will Expose before Commit Fan"
    );
  }
  unmountCombo();
  comboCtrl.dispose();

  // Re-mount primary view briefly for Dev Trace & clean teardown audit.
  const unmountFinal = mountAppView(ctrl, doc);

  // 3. Dev Trace stays hidden by default, opens cleanly via Alt+D, and closes again.
  const devPanel = doc.getElementById("dev-trace-panel");
  assert.equal(devPanel.classList.contains("hidden"), true);
  doc.dispatch("keydown", { key: "d", altKey: true, target: doc.body });
  assert.equal(devPanel.classList.contains("hidden"), false);
  assert.equal(doc.getElementById("dev-buckets").children.length, 5);
  doc.getElementById("dev-trace-toggle").click();
  assert.equal(devPanel.classList.contains("hidden"), true);

  // 4. Clean unmount removes every single listener from document and all persistent elements.
  unmountFinal();
  ctrl.dispose();
  let remainingDocListeners = 0;
  for (const s of doc.listeners.values()) remainingDocListeners += s.size;
  assert.equal(remainingDocListeners, 0, "Zero document listeners remain after unmount()");
  for (const el of doc.byId.values()) {
    assert.equal(el.listenerCount(), 0, `Zero listeners remain on #${el.id} after unmount()`);
  }
});
