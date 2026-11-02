import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from 'three';

// Exercise the actual player with deterministic atlas I/O, without WebGL or a
// server. Browser interaction separately verifies shader output and real assets.
const originalFetch = globalThis.fetch;
const originalBitmap = globalThis.createImageBitmap;
const requests = new Map();
let holdRequest = null;
let holdRelease = null;
globalThis.document = { createElement: () => ({ style: {}, dataset: {}, setAttribute() {} }) };
globalThis.requestAnimationFrame = callback => setImmediate(() => callback(performance.now()));
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.fetch = async url => {
  requests.set(url, (requests.get(url) || 0) + 1);
  if (holdRequest?.(url)) await new Promise(resolve => { holdRelease = resolve; });
  return { ok: true, blob: async () => ({}) };
};
globalThis.createImageBitmap = async (_, options) => ({
  width: options.resizeWidth, height: options.resizeHeight, close() {},
});
const source = (await readFile(new URL('../src/Character.js', import.meta.url), 'utf8'))
  .replace("from 'three'", `from '${import.meta.resolve('three')}'`)
  .replace("from './PoseSnapshot.js'", `from '${new URL('../src/PoseSnapshot.js', import.meta.url).href}'`)
  .replaceAll('import.meta.env.BASE_URL', "'/'");
const { Character } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function role(id) {
  const clip = (name, frames) => ({
    frames, fps: 30, duration: frames / 30, cellSize: 64,
    bodyHeight: 50, groundY: 0, worldSide: 64, center: { x: 0, y: 30 },
    pages: Array.from({ length: Math.ceil(frames / 64) }, (_, i) => ({
      image: `${name}-${i}.png`, columns: 8, rows: 8,
      startFrame: i * 64, frames: Math.min(64, frames - i * 64),
    })),
  });
  return { id, name: id, manifest: { targetHeight: 1.65, animations: {
    'build/Relax': clip('idle', 150), 'build/Move': clip('move', 100),
    'front/Attack': clip('attack', 40), 'front/Skill_1': clip('skill', 40),
  } } };
}
function make(id) {
  const errors = [];
  const character = new Character({ role: role(id), scene: new THREE.Scene(),
    labelsRoot: { appendChild() {} }, shadowTexture: new THREE.Texture(),
    renderer: { initTexture() {}, getRenderTarget() { return null; }, setRenderTarget() {}, render() {} },
    onError: error => errors.push(error) });
  return { character, errors };
}
async function until(predicate, characters, limit = 200) {
  for (let i = 0; i < limit; i++) {
    for (const c of characters) c.update(1 / 60, null);
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Playback failed to reach requested state');
}
async function initialized(id) {
  const result = make(id);
  await result.character.init();
  result.character.update(0, null);
  return result;
}

test('next-page prefetch survives current-frame updates and loop boundaries', async () => {
  const { character: c, errors } = await initialized('prefetch');
  const idle = c._prepare('build/Relax');
  c._preload();
  const next = c._slots.prefetch.page;
  c._setFrame(1);
  assert.equal(c._slots.prefetch.page, next);
  assert(next.pins.has(c._slots.prefetch.token));
  await until(() => Boolean(next.texture), [c]);
  c.setActive(true);
  await until(() => [...c._resident].every(page => page.texture), [c]);
  c.setMoving(true);
  await until(() => c.state === 'move' && !c._pending, [c]);
  const time = c.frameTime;
  let loops = 0, previous = c.frame;
  for (let i = 0; i < 800; i++) {
    c.update(1 / 60, null);
    if (c.frame < previous) loops++;
    previous = c.frame;
  }
  assert(loops >= 3);
  assert.notEqual(c.frameTime, time);
  assert.equal(requests.get(`/assets/characters/prefetch/${idle.data.pages[1].image}`), 1);
  assert.equal(errors.length, 0);
});

test('cancelling an uncommitted start/stop preserves the live phase', async () => {
  const { character: c } = await initialized('cancel');
  c.update(0.8, null);
  const idleTime = c.frameTime;
  c.setMoving(true);
  c.setMoving(false);
  assert.equal(c._pending, null);
  assert.equal(c.frameTime, idleTime);
  c.setActive(true);
  await until(() => [...c._resident].every(page => page.texture), [c]);
  c.setMoving(true);
  await until(() => c.canMove, [c]);
  for (let i = 0; i < 30; i++) c.update(1 / 60, null);
  const movingTime = c.frameTime;
  c.setMoving(false);
  c.setMoving(true);
  assert.equal(c._pending, null);
  assert.equal(c.frameTime, movingTime);
});

test('rapid reversals commit immediately from a snapshot; pause freezes both poses', async () => {
  const { character: c } = await initialized('blend');
  c.setActive(true);
  await until(() => [...c._resident].every(page => page.texture), [c]);
  c.setMoving(true);
  c.update(0, null);
  c.update(0.03, null);
  const oldFade = c._fade;
  const oldBlend = c._poseUniforms.poseBlend.value;
  assert(oldBlend > 0 && oldBlend < 1);
  c.setMoving(false);
  c.update(0, null);
  assert.notEqual(c._fade, oldFade);
  assert.equal(c.state, 'idle');
  assert.equal(c._pending, null);
  assert.equal(c._snapshot.material.uniforms.blend.value, oldBlend);
  assert.equal(c._poseUniforms.poseBlend.value, 0);
  const frozen = [c.frameTime, c.frame, c._fade.time, 0];
  for (let i = 0; i < 20; i++) c.update(0.05, null, true);
  assert.deepEqual([c.frameTime, c.frame, c._fade.time, c._poseUniforms.poseBlend.value], frozen);
  await until(() => c.state === 'idle' && !c._pending && !c._fade, [c]);
});

test('a delayed page neither freezes current playback nor blocks another demand', async () => {
  const { character: a } = await initialized('slow');
  const b = new Character({ role: role('fast'), scene: new THREE.Scene(),
    labelsRoot: { appendChild() {} }, shadowTexture: new THREE.Texture(),
    renderer: a._cache.renderer });
  await b.init(); b.update(0, null);
  holdRequest = url => url.includes('/slow/skill');
  void a.playAction('skill1');
  await until(() => Boolean(holdRelease), [a, b]);
  const initial = a.frameTime;
  b.setMoving(true);
  await until(() => b.canMove, [a, b]);
  assert(a.frameTime > initial);
  a.resetIdle();
  assert.equal(a._pending, null);
  holdRequest = null; holdRelease(); holdRelease = null;
  await until(() => ![...a._cache.pages.values()].some(page => page.phase === 'fetching'), [a, b]);
  assert.equal(a.state, 'idle');
});

test('held direction does not cancel a skill; a fresh press interrupts immediately', async () => {
  const { character: c } = await initialized('input');
  c.setActive(true);
  await until(() => [...c._resident].every(page => page.texture), [c]);
  const skill = c._prepare('front/Skill_1');
  await until(() => Boolean(c._request(skill, 0, 'transition').texture), [c]);
  c.setMoving(true, 1, 1, 1);
  c.update(0, null);
  void c.playAction('skill1');
  c.setMoving(true, 1, 1, 1);
  c.update(0, null);
  assert.equal(c.state, 'skill1');
  assert.equal(c._poseUniforms.poseBlend.value, 0);
  c.setMoving(true, 1, 1, 2);
  c.update(0, null);
  assert.equal(c.state, 'move');
  assert.equal(c._pending, null);
  assert(c.canMove);
  c.setMoving(false, 0, 1, 2);
  assert(!c.canMove);
  c.update(0, null);
  assert.equal(c.state, 'idle');
});

test('finite actions return without a final-frame hold', async () => {
  const { character: c } = await initialized('finish');
  c.setActive(true);
  const attack = c._prepare('front/Attack');
  await until(() => Boolean(c._request(attack, 0, 'transition').texture), [c]);
  void c.playAction('attack');
  c.update(0, null);
  c.update(c._duration(attack), null);
  assert.equal(c._pendingState, 'idle');
  assert.equal(c._holdTime, 0);
  c.update(0, null);
  assert.equal(c.state, 'idle');
});

test.after(() => {
  globalThis.fetch = originalFetch;
  globalThis.createImageBitmap = originalBitmap;
});
