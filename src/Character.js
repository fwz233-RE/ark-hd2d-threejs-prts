import * as THREE from 'three';

const actions = new Set(['idle', 'move', 'attack', 'skill1', 'skill2', 'skill3']);
const assetBase = import.meta.env.BASE_URL;
const caches = new WeakMap();
// At 2048px, four displayed pages plus four imminent pages fit in 256 MiB.
const memoryBudget = 256 * 1024 * 1024;
const maxPageDimension = 2048;
// Serialize fetch/decode/upload too, so decoded images cannot accumulate behind uploads.
const tasks = [];
let running = false;
function schedule(task) {
  return new Promise((resolve, reject) => {
    tasks.push({ task, resolve, reject });
    if (!running) void drain();
  });
}
async function drain() {
  running = true;
  while (tasks.length) {
    const { task, resolve, reject } = tasks.shift();
    try {
      // The timer runs after the rendering callbacks of this animation frame.
      await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
      resolve(await task());
    } catch (error) { reject(error); }
  }
  running = false;
}

class PageCache {
  constructor(renderer) {
    this.renderer = renderer;
    this.pages = new Map();
    this.bytes = 0;
    this.clock = 0;
  }

  page(role, clip, index) {
    const page = clip.data.pages[index];
    const url = `${assetBase}assets/characters/${role.id}/${page.image}`;
    if (!this.pages.has(url)) {
      const sourceWidth = page.columns * clip.data.cellSize;
      const sourceHeight = page.rows * clip.data.cellSize;
      const scale = Math.min(1, maxPageDimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      this.pages.set(url, {
        url, pins: new Set(), demands: new Set(), displayPins: new Set(),
        width, height, estimate: width * height * 8,
        texture: null, bitmap: null, bytes: 0,
        used: 0, promise: null, retryAt: 0,
      });
    }
    return this.pages.get(url);
  }

  trim(extra = 0, speculative = false) {
    const candidates = [...this.pages.values()]
      .filter(page => page.texture && !page.displayPins.size && !page.demands.size &&
        (!speculative || !page.pins.size))
      .sort((a, b) => a.used - b.used);
    for (const page of candidates) {
      if (this.bytes + extra <= memoryBudget) break;
      page.texture.dispose();
      page.bitmap.close();
      this.bytes -= page.bytes;
      page.texture = page.bitmap = null;
      page.bytes = 0;
    }
  }

  load(page) {
    page.used = ++this.clock;
    if (page.texture) return Promise.resolve(page);
    if (page.promise) return page.promise;
    page.promise = schedule(async () => {
      if (!page.pins.size) return page;
      // A speculative request must not evict another character's ready prefetch.
      // Otherwise four one-page-ahead requests continually decode each other away.
      this.trim(page.estimate, !page.demands.size);
      // Wait for a ready page to be committed before admitting another over-budget
      // page. Displayed pages are never sacrificed to make room for a request.
      const waiting = [...this.pages.values()].some(other => other !== page &&
        other.texture && other.pins.size && !other.displayPins?.size);
      if (this.bytes + page.estimate > memoryBudget && (!page.demands.size || waiting)) return page;
      const response = await fetch(page.url);
      if (!response.ok) throw new Error(`${page.url} HTTP ${response.status}`);
      const blob = await response.blob();
      if (!page.pins.size) return page;
      let bitmap;
      let texture;
      try {
        bitmap = await createImageBitmap(blob, {
          resizeWidth: page.width,
          resizeHeight: page.height,
          resizeQuality: 'high',
          imageOrientation: 'flipY',
          premultiplyAlpha: 'none',
        });
        if (!page.pins.size) { bitmap.close(); return page; }
        const bytes = bitmap.width * bitmap.height * 8; // RGBA bitmap plus GPU storage.
        this.trim(bytes, !page.demands.size);
        texture = new THREE.Texture(bitmap);
        texture.flipY = false; // ImageBitmap orientation was applied during decode.
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        // Decode may span several frames. Always upload after a fresh rendered frame.
        await new Promise(done => requestAnimationFrame(() => setTimeout(done, 0)));
        if (!page.pins.size) { texture.dispose(); bitmap.close(); return page; }
        this.renderer.initTexture(texture);
        Object.assign(page, { texture, bitmap, bytes });
        this.bytes += bytes;
        this.trim();
        return page;
      } catch (error) {
        texture?.dispose();
        bitmap?.close();
        throw error;
      }
    }).catch(error => {
      page.retryAt = performance.now() + 1000;
      throw error;
    }).finally(() => { page.promise = null; });
    return page.promise;
  }
}

export class Character {
  constructor({ role, position, scene, labelsRoot, shadowTexture, renderer, onError }) {
    this.role = role;
    this.onError = onError;
    if (!caches.has(renderer)) caches.set(renderer, new PageCache(renderer));
    this._cache = caches.get(renderer);
    this.speed = 2.1;
    this.state = 'idle';
    this.clipKey = null;
    this.frame = 0;
    this.frameTime = 0;
    this.actionNote = '';
    this._ready = false;
    this._version = 0;
    this._pendingState = null;
    this._clips = new Map();
    this._queue = [];
    this._clip = null;
    this._rate = 1;
    this._holdTime = 0;
    this._displayed = null;
    this._wanted = null;
    this._displayPin = {};
    this._wantedPin = {};
    this._projected = new THREE.Vector3();
    this._cameraRotation = new THREE.Quaternion();
    this.group = new THREE.Group();
    if (position?.isVector3) this.group.position.copy(position);
    else if (position) this.group.position.fromArray(position);
    this.billboard = new THREE.Group();
    this.group.add(this.billboard);
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: 0.1, depthWrite: true,
      side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
    });
    this.plane = new THREE.Mesh(geometry, this.material);
    this.plane.visible = false;
    this.billboard.add(this.plane);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.7),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.8 }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.025;
    this.group.add(this.shadow);
    scene.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'world-label';
    this.label.textContent = role.name;
    this.label.position = new THREE.Vector3(0, 2.85, 0);
    Object.assign(this.label.dataset, { state: 'idle', clip: '', frame: '0' });
    labelsRoot.appendChild(this.label);
    this.setActive(false);
  }

  get ready() { return this._ready; }
  get playbackState() { return this._pendingState || this.state; }

  _report(error) {
    try { this.onError?.(error); } catch { /* A reporting callback must not reject playback. */ }
  }

  _prepare(key) {
    if (!this._clips.has(key)) {
      const data = this.role.manifest.animations[key];
      if (!data?.pages?.length) throw new Error(`${this.role.name}: 缺少分页动画 ${key}`);
      this._clips.set(key, { key, data });
    }
    return this._clips.get(key);
  }

  _want(clip, index, speculative = false) {
    const page = this._cache.page(this.role, clip, index);
    if (page !== this._wanted) {
      this._wanted?.demands.delete(this._wantedPin);
      this._wanted?.pins.delete(this._wantedPin);
      this._wanted = page;
      page.pins.add(this._wantedPin);
    }
    if (speculative) page.demands.delete(this._wantedPin);
    else page.demands.add(this._wantedPin);
    if (!page.texture && !page.promise && performance.now() >= page.retryAt) {
      const token = this._version;
      void this._cache.load(page).catch(error => {
        if (token === this._version && this._wanted === page && page.demands.has(this._wantedPin)) this._report(error);
      });
    }
    return page;
  }

  async init() {
    if (!this._initPromise) this._initPromise = (async () => {
      const token = this._version;
      const idle = this._prepare('build/Relax');
      const page = this._want(idle, 0);
      try {
        await this._cache.load(page);
        if (token !== this._version) return this;
        this._ready = true;
        // Only update() can commit playback, including the initial frame.
        this._pending = { token, keys: ['build/Relax'], state: 'idle' };
        this._pendingState = 'idle';
        const move = this._prepare('build/Move');
        const warm = this._cache.page(this.role, move, 0);
        // Warm movement only if idle plus movement fit without evicting pinned pages.
        if (this._cache.bytes + warm.estimate <= memoryBudget) {
          const pin = {};
          warm.pins.add(pin);
          try { await this._cache.load(warm); }
          catch { /* Demand requests retry and report if still active. */ }
          finally { warm.pins.delete(pin); this._cache.trim(); }
        }
        return this;
      } catch (error) {
        if (token !== this._version) return this;
        this._initPromise = null;
        throw error;
      }
    })();
    return this._initPromise;
  }

  _sequence(action) {
    const entries = this.role.manifest.animations;
    const exists = key => Boolean(entries[key]);
    const first = keys => keys.find(exists);
    if (action === 'idle') return ['build/Relax'];
    if (action === 'move') return ['build/Move'];
    if (action === 'attack') {
      const main = first(['front/Attack_Loop', 'front/Attack', 'front/Attack_1']);
      return main ? ['front/Attack_Begin', main, 'front/Attack_End'].filter(exists) : [];
    }
    if (action === 'skill1' && this.role.id === 'char_2025_shu') {
      return exists('front/Attack_1') ? ['front/Attack_1'] : [];
    }
    if (action === 'skill2' && this.role.id === 'char_1050_chen3') {
      return ['front/Skill_2_Begin', 'front/Skill_2_Disappear'].filter(exists);
    }
    const prefix = `front/Skill_${action.slice(-1)}`;
    const main = first([`${prefix}_Loop`, `${prefix}_Idle`, prefix]);
    return [`${prefix}_Begin`, main, `${prefix}_Attack`, `${prefix}_Attack_1`,
      `${prefix}_Attack_2`, `${prefix}_End`].filter(key => key && exists(key));
  }

  _play(keys, state) {
    this._pending?.resolve?.(false);
    const token = ++this._version;
    this._pendingState = state;
    return new Promise(resolve => {
      this._pending = { token, keys, state, resolve };
      try { this._want(this._prepare(keys[0]), 0); }
      catch (error) {
        this._pending = null;
        this._pendingState = null;
        this._report(error);
        resolve(false);
      }
    });
  }

  playAction(action) {
    if (!this.ready || !actions.has(action)) return Promise.resolve(false);
    const keys = this._sequence(action);
    return keys.length ? this._play(keys, action) : Promise.resolve(false);
  }

  setMoving(moving, directionX = 0, rate = 1) {
    this._rate = Number.isFinite(rate) ? Math.max(0, rate) : 1;
    if (directionX) this.billboard.scale.x = Math.sign(directionX);
    if (!this.ready) return;
    if (moving) {
      if (this._pendingState && this._pendingState !== 'move') return;
      if (this.state !== 'idle' && this.state !== 'move') return;
      if (this._pendingState !== 'move' && this.state !== 'move') {
        void this._play(['build/Move'], 'move');
      }
    } else if (this.state === 'move' || this._pendingState === 'move') {
      // A pending skill request must survive key release while the old Move is visible.
      if (!this._pendingState || this._pendingState === 'move') this.resetIdle();
    }
  }

  resetIdle() {
    if (this.ready) void this._play(['build/Relax'], 'idle');
  }

  setActive(active) {
    this.label.style.color = active ? '#65f4ec' : '';
    this.label.setAttribute('aria-current', active ? 'true' : 'false');
    this.label.setAttribute('aria-label', `${this.role.name}${active ? '（选中）' : ''}`);
  }

  _commit(clip, state, loop) {
    this._clip = clip;
    this._loop = loop;
    this._holdTime = 0;
    this.state = state;
    this.clipKey = clip.key;
    this.frameTime = 0;
    const data = clip.data;
    const height = this.role.manifest.targetHeight ?? 1.65;
    const unit = height / data.bodyHeight;
    this.plane.scale.set(data.worldSide * unit, data.worldSide * unit, 1);
    this.plane.position.set(data.center.x * unit, (data.center.y - data.groundY) * unit, 0);
    this.material.opacity = 1;
    Object.assign(this.label.dataset, { state, clip: clip.key });
    this._frameClip = null;
    this._setFrame(0);
  }

  _pageIndex(clip, frame) {
    return clip.data.pages.findIndex(page => frame >= page.startFrame && frame < page.startFrame + page.frames);
  }

  _setFrame(frame) {
    const { data } = this._clip;
    frame = Math.min(data.frames - 1, Math.max(0, frame));
    if (this._frameClip === this._clip && this.frame === frame) return true;
    const index = this._pageIndex(this._clip, frame);
    if (index < 0) throw new Error(`图集分页缺少帧 ${this.clipKey}:${frame}`);
    const entry = this._want(this._clip, index);
    if (!entry.texture) return false;
    if (!this.material.map) this.material.needsUpdate = true;
    this.material.map = entry.texture;
    this.plane.visible = true;
    this._displayed?.pins.delete(this._displayPin);
    this._displayed?.displayPins.delete(this._displayPin);
    this._displayed = entry;
    entry.pins.add(this._displayPin);
    entry.displayPins.add(this._displayPin);
    entry.used = ++this._cache.clock;
    const page = data.pages[index];
    const local = frame - page.startFrame;
    const inset = 0.5 / data.cellSize;
    const u = (local % page.columns + inset) / page.columns;
    const v = 1 - (Math.floor(local / page.columns) + 1 - inset) / page.rows;
    const w = (1 - 2 * inset) / page.columns;
    const h = (1 - 2 * inset) / page.rows;
    // Per-mesh UVs allow a single uploaded texture to be shared by all characters.
    const uv = this.plane.geometry.attributes.uv;
    uv.setXY(0, u, v + h); uv.setXY(1, u + w, v + h);
    uv.setXY(2, u, v); uv.setXY(3, u + w, v);
    uv.needsUpdate = true;
    this.frame = frame;
    this._frameClip = this._clip;
    this.label.dataset.frame = String(frame);
    this._cache.trim();
    return true;
  }

  _preload() {
    const index = this._pageIndex(this._clip, this.frame);
    if (index + 1 < this._clip.data.pages.length) this._want(this._clip, index + 1, true);
    else if (this._queue.length) this._want(this._prepare(this._queue[0]), 0, true);
    else if (this._loop) this._want(this._clip, 0, true);
    // Idle is demanded only when the finite sequence and its final hold end.
    else {
      this._wanted?.pins.delete(this._wantedPin);
      this._wanted?.demands.delete(this._wantedPin);
      this._wanted = null;
    }
    this._cache.trim();
  }

  update(delta, camera, paused = false) {
    if (camera) {
      camera.getWorldQuaternion(this.billboard.quaternion);
      this.group.getWorldQuaternion(this._cameraRotation).invert();
      this.billboard.quaternion.premultiply(this._cameraRotation);
      this._projected.copy(this.label.position);
      this.group.localToWorld(this._projected).project(camera);
      const display = Math.abs(this._projected.z) <= 1 ? 'block' : 'none';
      const left = `${(this._projected.x * 0.5 + 0.5) * globalThis.innerWidth}px`;
      const top = `${(-this._projected.y * 0.5 + 0.5) * globalThis.innerHeight}px`;
      if (this.label.style.display !== display) this.label.style.display = display;
      if (this._labelLeft !== left) { this.label.style.left = left; this._labelLeft = left; }
      if (this._labelTop !== top) { this.label.style.top = top; this._labelTop = top; }
    }
    if (paused) return;
    if (this._pending) {
      const pending = this._pending;
      if (pending.token !== this._version) return;
      const clip = this._prepare(pending.keys[0]);
      if (!this._want(clip, 0).texture) return;
      this._queue = pending.keys.slice(1);
      this._pending = null;
      this._pendingState = null;
      this.actionNote = pending.state === 'skill1' && this.role.id === 'char_2025_shu'
        ? '技能1使用普通攻击动作（源无独立动画）' : '';
      this._commit(clip, pending.state, pending.state === 'idle' || pending.state === 'move');
      pending.resolve?.(true);
      this._preload();
      return;
    }
    if (!this._clip) return;
    if (this._holdTime > 0) {
      this._holdTime = Math.max(0, this._holdTime - Math.max(0, delta));
      if (this._holdTime === 0) this.resetIdle();
      return;
    }
    let remaining = Math.max(0, delta) * (this.state === 'move' ? this._rate : 1);
    while (remaining > 0) {
      const data = this._clip.data;
      const duration = data.duration > 0 ? data.duration : data.frames / data.fps;
      const nextTime = Math.min(duration, this.frameTime + remaining);
      const nextFrame = Math.min(data.frames - 1, Math.floor(nextTime * data.fps));
      // Stop on the last available frame/time until the demanded page is uploaded.
      if (!this._setFrame(nextFrame)) return;
      remaining -= nextTime - this.frameTime;
      this.frameTime = nextTime;
      if (nextTime < duration) break;
      if (this._loop) {
        if (!this._want(this._clip, 0).texture) return;
        this.frameTime = 0;
        this._setFrame(0);
      } else if (this._queue.length) {
        const next = this._prepare(this._queue[0]);
        if (!this._want(next, 0).texture) return;
        this._queue.shift();
        this._commit(next, this.state, false);
      } else {
        this._holdTime = 0.35;
        break;
      }
    }
    this._preload();
  }
}
