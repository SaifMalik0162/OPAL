import test from "node:test";
import assert from "node:assert/strict";
import { createOverlayCoordinator } from "../src/overlay-coordinator.js";

function element() {
  return {
    inert: false,
    isConnected: true,
    dataset: {},
    style: { overflow: "" },
    children: [],
    contains(target) { return target === this || this.children.includes(target); },
    querySelectorAll() { return this.children; },
    focus() { documentRef.activeElement = this; },
    getAttribute() { return null; },
  };
}

let documentRef;
function createDocument() {
  const listeners = new Map();
  const background = element();
  const html = element();
  const body = element();
  documentRef = {
    activeElement: null,
    documentElement: html,
    body,
    defaultView: { setTimeout, clearTimeout },
    querySelector: (selector) => selector === "[data-overlay-background]" ? background : null,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(event) { listeners.get("keydown")?.(event); },
    background,
  };
  return documentRef;
}

function keyEvent(key) {
  return { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.immediateStopped = true; } };
}

test("only the top layer handles Escape", () => {
  const doc = createDocument();
  const coordinator = createOverlayCoordinator(doc);
  const calls = [];
  const removeParent = coordinator.register({ element: element(), modal: true, onEscape: () => calls.push("parent") });
  const removeChild = coordinator.register({ element: element(), modal: true, onEscape: () => calls.push("child") });
  const event = keyEvent("Escape");
  doc.dispatch(event);
  assert.deepEqual(calls, ["child"]);
  assert.equal(event.prevented, true);
  assert.equal(event.immediateStopped, true);
  removeChild();
  doc.dispatch(keyEvent("Escape"));
  assert.deepEqual(calls, ["child", "parent"]);
  removeParent();
});

test("modal layer locks background and scroll, then restores both", () => {
  const doc = createDocument();
  doc.documentElement.style.overflow = "auto";
  doc.body.style.overflow = "scroll";
  const coordinator = createOverlayCoordinator(doc);
  const layer = element();
  const remove = coordinator.register({ element: layer, modal: true, initialFocus: false });
  assert.equal(doc.background.inert, true);
  assert.equal(doc.documentElement.style.overflow, "hidden");
  assert.equal(doc.body.style.overflow, "hidden");
  remove();
  assert.equal(doc.background.inert, false);
  assert.equal(doc.documentElement.style.overflow, "auto");
  assert.equal(doc.body.style.overflow, "scroll");
});

test("nested portal layers stay outside the inert background and stack in visual order", () => {
  const doc = createDocument();
  const coordinator = createOverlayCoordinator(doc);
  const parent = element();
  const child = element();
  parent.parentElement = doc.body;
  child.parentElement = doc.body;
  const removeParent = coordinator.register({ element: parent, modal: true, initialFocus: false });
  const removeChild = coordinator.register({ element: child, modal: true, initialFocus: false });

  assert.equal(doc.background.inert, true);
  assert.equal(parent.inert, true);
  assert.equal(child.inert, false);
  assert.ok(Number(child.style.zIndex) > Number(parent.style.zIndex));

  removeChild();
  assert.equal(parent.inert, false);
  removeParent();
});
