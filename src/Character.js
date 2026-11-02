import * as THREE from 'three';

const actions = new Set(['idle', 'move', 'attack', 'skill1', 'skill2', 'skill3']);
const assetBase = import.meta.env.BASE_URL;
const caches = new WeakMap();
const memoryBudget = 256 * 1024 * 1024;
const maxPageDimension = 2048;
const transitionDuration = 0.12;

// Downloads have a reserved demand lane. Decode/upload is separate, one page per
// rendered frame, so a slow background download never blocks a walking request.
class PageCache {
  constructor(renderer) {
    this.renderer = renderer;
    this.pages = new Map();
    this.bytes = 0;
    this.clock = 0;
    this.downloads = 0;
    this.backgroundDownloads = 0;
    this.uploading = false;
  }

  page(role, clip, index) {
    const meta = clip.data.pages[index];
    const url = `${assetBase}assets/characters/${role.id}/${meta.image}`;
    if (!this.pages.has(url)) {
      const scale = Math.min(1, maxPageDimension / Math.max(meta.columns, meta.rows) / clip.data.cellSize);
      const width = Math.max(1, Math.round(meta.columns * clip.data.cellSize * scale));
      const height = Math.max(1, Math.round(meta.rows * clip.data.cellSize * scale));
      this.pages.set(url, {
        url, width, height, estimate: width * height * 8,
        pins: new Set(), displayPins: new Set(), residentPins: new Set(), demands: new Set(),
        texture: null, bitmap: null, bytes: 0, used: 0, retryAt: 0,
        promise: null, phase: '', priority: 2, blob: null,
      });
    }
    return this.pages.get(url);
  }

  trim(extra = 0, demand = false) {
    const candidates = [...this.pages.values()].filter(page => page.texture &&
      !page.displayPins.size && !page.residentPins.size && !page.demands.size &&
      (demand || !page.pins.size)).sort((a, b) => a.used - b.used);
    for (const page of candidates) {
      if (this.bytes + extra <= memoryBudget) break;
      page.texture.dispose();
      page.bitmap.close();
      this.bytes -= page.bytes;
      page.texture = page.bitmap = null;
      page.bytes = 0;
    }
    return this.bytes + extra <= memoryBudget;
  }

  load(page, priority = 2) {
    page.used = ++this.clock;
    if (page.texture) return Promise.resolve(page);
    if (page.promise) {
      page.priority = Math.min(page.priority, priority);
    } else {
      if (performance.now() < page.retryAt) return Promise.resolve(page);
      page.priority = priority;
      page.phase = 'queued';
      page.promise = new Promise((resolve, reject) => { page.resolve = resolve; page.reject = reject; });
    }
    this.tick();
    return page.promise;
  }

  _finish(page, error) {
    const { resolve, reject } = page;
    page.promise = page.resolve = page.reject = null;
    page.phase = '';
    page.blob = null;
    if (error) {
      page.retryAt = performance.now() + 1000;
      reject(error);
    } else resolve(page);
  }

  tick() {
    const queued = [...this.pages.values()].filter(page => page.phase === 'queued')
      .sort((a, b) => a.priority - b.priority || a.used - b.used);
    for (const page of queued) {
      if (!page.pins.size) { this._finish(page); continue; }
      const background = page.priority > 0;
      if (this.downloads >= 3 || (background && this.backgroundDownloads >= 2)) continue;
      page.phase = 'fetching';
      this.downloads++;
      if (background) this.backgroundDownloads++;
      void fetch(page.url, { signal: AbortSignal.timeout(12000) }).then(async response => {
        if (!response.ok) throw new Error(`${page.url} HTTP ${response.status}`);
        page.blob = await response.blob();
        page.phase = 'downloaded';
        if (!page.pins.size) this._finish(page);
      }).catch(error => this._finish(page, error)).finally(() => {
        this.downloads--;
        if (background) this.backgroundDownloads--;
        this.tick();
      });
    }
    if (this.uploading) return;
    const ready = [...this.pages.values()].filter(page => page.phase === 'downloaded')
      .sort((a, b) => a.priority - b.priority || a.used - b.used);
    for (const page of ready) {
      if (!page.pins.size) { this._finish(page); continue; }
      if (!this.trim(page.estimate, page.priority === 0)) continue;
      this.uploading = true;
      page.phase = 'uploading';
      void this._upload(page);
      break;
    }
  }

  async _upload(page) {
    let bitmap;
    let texture;
    try {
      bitmap = await createImageBitmap(page.blob, {
        resizeWidth: page.width, resizeHeight: page.height, resizeQuality: 'high',
        imageOrientation: 'flipY', premultiplyAlpha: 'none',
      });
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!page.pins.size) { bitmap.close(); this._finish(page); return; }
      texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.renderer.initTexture(texture);
      Object.assign(page, { texture, bitmap, bytes: bitmap.width * bitmap.height * 8 });
      this.bytes += page.bytes;
      this._finish(page);
    } catch (error) {
      texture?.dispose();
      bitmap?.close();
      this._finish(page, error);
    } finally {
      this.uploading = false;
      this.tick();
    }
  }
}

export class Character {
  constructor({ role, position, scene, labelsRoot, shadowTexture, renderer, onError }) {
    this.role = role;
    this.onError = onError;
    if (!caches.has(renderer)) caches.set(renderer, new PageCache(renderer));
    this._cache = caches.get(renderer);
    this.state = 'idle';
    this.clipKey = null;
    this.frame = 0;
    this.frameTime = 0;
    this.actionNote = '';
    this._ready = false;
    this._version = 0;
    this._pendingState = null;
    this._pending = null;
    this._clips = new Map();
    this._queue = [];
    this._clip = null;
    this._rate = 1;
    this._holdTime = 0;
    this._active = false;
    this._displayed = null;
    this._displayPin = {};
    this._residentPin = {};
    this._resident = new Set();
    this._slots = {
      transition: { token: {}, page: null },
      frame: { token: {}, page: null },
      prefetch: { token: {}, page: null },
    };
    this._phases = new Map();
    this._fade = null;
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
    this._poseUniforms = {
      posePreviousMap: { value: null }, poseBlend: { value: 1 },
      posePreviousRect: { value: new THREE.Vector4() }, poseRect: { value: new THREE.Vector4() },
      posePreviousSize: { value: new THREE.Vector2(1, 1) }, poseSize: { value: new THREE.Vector2(1, 1) },
      posePreviousCenter: { value: new THREE.Vector2() }, poseCenter: { value: new THREE.Vector2() },
      poseDrawSize: { value: new THREE.Vector2(1, 1) }, poseDrawCenter: { value: new THREE.Vector2() },
    };
    this.material.onBeforeCompile = shader => this._compilePoseBlend(shader);
    this.material.customProgramCacheKey = () => 'aligned-locomotion-transition-v1';
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
  get preparing() { return Boolean(this._pending); }
  get canMove() { return this.state === 'move' && !this._pending; }

  _compilePoseBlend(shader) {
    Object.assign(shader.uniforms, this._poseUniforms);
    shader.vertexShader = `uniform vec2 poseDrawSize; uniform vec2 poseDrawCenter; varying vec2 posePoint;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nposePoint = position.xy * poseDrawSize + poseDrawCenter;');
    shader.fragmentShader = `
      uniform sampler2D posePreviousMap;
      uniform float poseBlend;
      uniform vec4 posePreviousRect; uniform vec4 poseRect;
      uniform vec2 posePreviousSize; uniform vec2 poseSize;
      uniform vec2 posePreviousCenter; uniform vec2 poseCenter;
      varying vec2 posePoint;
      vec4 alignedPose(sampler2D image, vec4 rect, vec2 size, vec2 center) {
        vec2 local = (posePoint - center) / size + 0.5;
        if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return vec4(0.0);
        return texture2D(image, rect.xy + local * rect.zw);
      }
      ${shader.fragmentShader}`.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 currentPose = alignedPose(map, poseRect, poseSize, poseCenter);
          if (poseBlend < 1.0) {
            vec4 previousPose = alignedPose(posePreviousMap, posePreviousRect, posePreviousSize, posePreviousCenter);
            float coverage = mix(previousPose.a, currentPose.a, poseBlend);
            vec3 premultiplied = mix(previousPose.rgb * previousPose.a, currentPose.rgb * currentPose.a, poseBlend);
            currentPose = vec4(premultiplied / max(coverage, 0.00001), coverage);
          }
          diffuseColor *= currentPose;
        #endif
      `);
  }

  _report(error) {
    try { this.onError?.(error); } catch { /* Reporting must not reject playback. */ }
  }

  _prepare(key) {
    if (!this._clips.has(key)) {
      const data = this.role.manifest.animations[key];
      if (!data?.pages?.length) throw new Error(`${this.role.name}: 缺少分页动画 ${key}`);
      this._clips.set(key, { key, data });
    }
    return this._clips.get(key);
  }

  _releaseSlot(name) {
    const slot = this._slots[name];
    slot.page?.pins.delete(slot.token);
    slot.page?.demands.delete(slot.token);
    slot.page = null;
  }

  _request(clip, index, name, priority = 0) {
    const page = this._cache.page(this.role, clip, index);
    const slot = this._slots[name];
    if (slot.page !== page) {
      this._releaseSlot(name);
      slot.page = page;
      page.pins.add(slot.token);
    }
    if (priority === 0) page.demands.add(slot.token);
    if (!page.texture && !page.promise && performance.now() >= page.retryAt) {
      const request = this._cache.load(page, priority);
      void request.catch(error => { if (slot.page === page && priority === 0) this._report(error); });
    } else if (page.promise) {
      page.priority = Math.min(page.priority, priority);
      this._cache.tick();
    }
    return page;
  }

  _warmLocomotion() {
    if (!this.ready || !this._active) return;
    const move = this._prepare('build/Move');
    const idle = this._prepare('build/Relax');
    const idleFrame = this._entryFrame(idle, this._phases.get('idle') || 0);
    const wanted = new Set(move.data.pages.map((_, index) => this._cache.page(this.role, move, index)));
    wanted.add(this._cache.page(this.role, idle, this._pageIndex(idle, idleFrame)));
    for (const page of this._resident) if (!wanted.has(page)) {
      page.residentPins.delete(this._residentPin);
      page.pins.delete(this._residentPin);
    }
    this._resident = wanted;
    for (const page of wanted) {
      page.residentPins.add(this._residentPin);
      page.pins.add(this._residentPin);
      if (!page.texture && !page.promise && performance.now() >= page.retryAt) {
        void this._cache.load(page, 0).catch(error => { if (this._active && this._resident.has(page)) this._report(error); });
      } else if (page.promise) {
        page.priority = 0;
      }
    }
    this._cache.tick();
  }

  async init() {
    if (!this._initPromise) this._initPromise = (async () => {
      const idle = this._prepare('build/Relax');
      const page = this._request(idle, 0, 'transition');
      await this._cache.load(page, 0);
      this._ready = true;
      this._pending = { token: this._version, keys: ['build/Relax'], state: 'idle', entryTime: 0 };
      this._pendingState = 'idle';
      return this;
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
    if (action === 'skill1' && this.role.id === 'char_2025_shu') return exists('front/Attack_1') ? ['front/Attack_1'] : [];
    if (action === 'skill2' && this.role.id === 'char_1050_chen3') return ['front/Skill_2_Begin', 'front/Skill_2_Disappear'].filter(exists);
    const prefix = `front/Skill_${action.slice(-1)}`;
    const main = first([`${prefix}_Loop`, `${prefix}_Idle`, prefix]);
    return [`${prefix}_Begin`, main, `${prefix}_Attack`, `${prefix}_Attack_1`,
      `${prefix}_Attack_2`, `${prefix}_End`].filter(key => key && exists(key));
  }

  _duration(clip) { return clip.data.duration > 0 ? clip.data.duration : clip.data.frames / clip.data.fps; }
  _entryFrame(clip, time) { return Math.min(clip.data.frames - 1, Math.floor(time * clip.data.fps)); }

  _play(keys, state) {
    const locomotion = state === 'idle' || state === 'move';
    if (this._pendingState === state && locomotion) return this._pending.promise;
    // A key reversal can cancel a transition which has not committed yet. Keep
    // the live phase, rather than recommitting this same clip at its saved phase.
    if (locomotion && this.state === state && this._clip?.key === keys[0]) {
      this._pending?.resolve?.(false);
      this._pending = null;
      this._pendingState = null;
      ++this._version;
      this._releaseSlot('transition');
      return Promise.resolve(true);
    }
    this._pending?.resolve?.(false);
    const token = ++this._version;
    const clip = this._prepare(keys[0]);
    const entryTime = (state === 'idle' || state === 'move') ? (this._phases.get(state) || 0) % this._duration(clip) : 0;
    this._pendingState = state;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this._pending = { token, keys, state, entryTime, promise, resolve };
    this._request(clip, this._pageIndex(clip, this._entryFrame(clip, entryTime)), 'transition');
    return promise;
  }

  playAction(action) {
    if (!this.ready || !actions.has(action)) return Promise.resolve(false);
    const keys = this._sequence(action);
    return keys.length ? this._play(keys, action) : Promise.resolve(false);
  }

  setMoving(moving, directionX = 0, rate = 1) {
    this._rate = Number.isFinite(rate) ? Math.max(0, rate) : 1;
    if (directionX) this.billboard.scale.x = Math.sign(directionX);
    if (!this.ready) return false;
    if (moving) {
      // Movement is an explicit interrupt, including a stop still waiting for idle.
      if (this._pendingState !== 'move' && (this.state !== 'move' || this._pending)) void this._play(['build/Move'], 'move');
    } else if (this._pendingState === 'move' || (this.state === 'move' && !this._pending)) {
      this.resetIdle();
    }
    return this.canMove;
  }

  resetIdle() {
    if (!this.ready || (this.state === 'idle' && !this._pending)) return;
    void this._play(['build/Relax'], 'idle');
  }

  setActive(active) {
    this._active = active;
    this.label.style.color = active ? '#65f4ec' : '';
    this.label.setAttribute('aria-current', active ? 'true' : 'false');
    this.label.setAttribute('aria-label', `${this.role.name}${active ? '（选中）' : ''}`);
    if (active) this._warmLocomotion();
    else {
      for (const page of this._resident) {
        page.residentPins.delete(this._residentPin);
        page.pins.delete(this._residentPin);
      }
      this._resident.clear();
      this._cache.trim();
    }
  }

  _endFade() {
    if (this._fade) this._fade.page.displayPins.delete(this._fade.pin);
    this._fade = null;
    this._poseUniforms.poseBlend.value = 1;
    this._poseUniforms.posePreviousMap.value = this.material.map;
    this._drawBounds();
  }

  _drawBounds() {
    const u = this._poseUniforms;
    const center = u.poseCenter.value;
    const size = u.poseSize.value;
    if (this._fade) {
      const previousCenter = u.posePreviousCenter.value, previousSize = u.posePreviousSize.value;
      const left = Math.min(center.x - size.x / 2, previousCenter.x - previousSize.x / 2);
      const right = Math.max(center.x + size.x / 2, previousCenter.x + previousSize.x / 2);
      const bottom = Math.min(center.y - size.y / 2, previousCenter.y - previousSize.y / 2);
      const top = Math.max(center.y + size.y / 2, previousCenter.y + previousSize.y / 2);
      u.poseDrawCenter.value.set((left + right) / 2, (bottom + top) / 2);
      u.poseDrawSize.value.set(right - left, top - bottom);
    } else {
      u.poseDrawCenter.value.copy(center);
      u.poseDrawSize.value.copy(size);
    }
    this.plane.position.set(u.poseDrawCenter.value.x, u.poseDrawCenter.value.y, 0);
    this.plane.scale.set(u.poseDrawSize.value.x, u.poseDrawSize.value.y, 1);
  }

  _commit(clip, state, loop, time = 0) {
    const u = this._poseUniforms;
    const changed = this._clip && this.state !== state;
    if (this._clip) this._phases.set(this.state, this.frameTime);
    this._endFade();
    if (changed && this._displayed) {
      const pin = {};
      this._displayed.displayPins.add(pin);
      this._fade = { page: this._displayed, pin, time: 0 };
      u.posePreviousMap.value = this.material.map;
      u.posePreviousRect.value.copy(u.poseRect.value);
      u.posePreviousSize.value.copy(u.poseSize.value);
      u.posePreviousCenter.value.copy(u.poseCenter.value);
      u.poseBlend.value = 0;
    }
    this._clip = clip;
    this._loop = loop;
    this._holdTime = 0;
    this.state = state;
    this.clipKey = clip.key;
    this.frameTime = time;
    const data = clip.data;
    const unit = (this.role.manifest.targetHeight ?? 1.65) / data.bodyHeight;
    u.poseSize.value.set(data.worldSide * unit, data.worldSide * unit);
    u.poseCenter.value.set(data.center.x * unit, (data.center.y - data.groundY) * unit);
    this._drawBounds();
    Object.assign(this.label.dataset, { state, clip: clip.key });
    this._frameClip = null;
    this._setFrame(this._entryFrame(clip, time));
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
    const entry = this._request(this._clip, index, 'frame');
    if (!entry.texture) return false;
    if (!this.material.map) this.material.needsUpdate = true;
    this.material.map = entry.texture;
    this.plane.visible = true;
    this._displayed?.displayPins.delete(this._displayPin);
    this._displayed = entry;
    entry.displayPins.add(this._displayPin);
    entry.used = ++this._cache.clock;
    const meta = data.pages[index];
    const local = frame - meta.startFrame;
    const inset = 0.5 / data.cellSize;
    const u = (local % meta.columns + inset) / meta.columns;
    const v = 1 - (Math.floor(local / meta.columns) + 1 - inset) / meta.rows;
    const w = (1 - 2 * inset) / meta.columns, h = (1 - 2 * inset) / meta.rows;
    this._poseUniforms.poseRect.value.set(u, v, w, h);
    if (!this._fade) this._poseUniforms.posePreviousMap.value = entry.texture;
    const uv = this.plane.geometry.attributes.uv;
    uv.setXY(0, u, v + h); uv.setXY(1, u + w, v + h);
    uv.setXY(2, u, v); uv.setXY(3, u + w, v);
    uv.needsUpdate = true;
    this.frame = frame;
    this._frameClip = this._clip;
    this.label.dataset.frame = String(frame);
    this._releaseSlot('frame');
    return true;
  }

  _preload() {
    if (!this._clip) return;
    const index = this._pageIndex(this._clip, this.frame);
    if (index + 1 < this._clip.data.pages.length) this._request(this._clip, index + 1, 'prefetch', 1);
    else if (this._queue.length) this._request(this._prepare(this._queue[0]), 0, 'prefetch', 1);
    else if (this._loop) this._request(this._clip, 0, 'prefetch', 1);
    else this._releaseSlot('prefetch');
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
    this._cache.tick();
    if (paused) return;
    if (this._fade) {
      this._fade.time += delta;
      const blend = Math.min(1, this._fade.time / transitionDuration);
      this._poseUniforms.poseBlend.value = blend * blend * (3 - 2 * blend);
      if (blend >= 1) this._endFade();
    }
    this._warmLocomotion();
    if (this._pending) {
      const pending = this._pending;
      const clip = this._prepare(pending.keys[0]);
      const index = this._pageIndex(clip, this._entryFrame(clip, pending.entryTime));
      if (this._request(clip, index, 'transition').texture && !this._fade) {
        this._queue = pending.keys.slice(1);
        this._pending = null;
        this._pendingState = null;
        this.actionNote = pending.state === 'skill1' && this.role.id === 'char_2025_shu'
          ? '技能1使用普通攻击动作（源无独立动画）' : '';
        this._commit(clip, pending.state, pending.state === 'idle' || pending.state === 'move', pending.entryTime);
        this._releaseSlot('transition');
        pending.resolve?.(true);
        this._preload();
        return;
      }
      // Keep the old pose animated while its replacement downloads.
    }
    if (!this._clip) return;
    if (this._holdTime > 0) {
      this._holdTime = Math.max(0, this._holdTime - delta);
      if (this._holdTime === 0 && !this._pending) this.resetIdle();
      return;
    }
    let remaining = Math.max(0, delta) * (this.state === 'move' ? this._rate : 1);
    while (remaining > 0) {
      const duration = this._duration(this._clip);
      const nextTime = Math.min(duration, this.frameTime + remaining);
      if (!this._setFrame(this._entryFrame(this._clip, nextTime))) return;
      remaining -= nextTime - this.frameTime;
      this.frameTime = nextTime;
      if (nextTime < duration) break;
      if (this._loop) {
        if (!this._setFrame(0)) return;
        this.frameTime = 0;
      } else if (this._queue.length && !this._pending) {
        const next = this._prepare(this._queue[0]);
        if (!this._request(next, 0, 'frame').texture) return;
        this._queue.shift();
        this._commit(next, this.state, false);
      } else {
        this._holdTime = 0.2;
        break;
      }
    }
    this._preload();
    this._cache.trim();
  }
}
