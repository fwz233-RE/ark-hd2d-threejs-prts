import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const clipCache = new Map();
const actions = new Set(['idle', 'move', 'attack', 'skill1', 'skill2', 'skill3']);

function loadClip(role, key) {
  const cacheKey = `${role.id}/${key}`;
  if (!clipCache.has(cacheKey)) {
    const data = role.manifest.animations[key];
    if (!data?.pages?.length) return Promise.reject(new Error(`${role.name}: 缺少分页动画 ${key}`));
    const promise = Promise.all(data.pages.map(async page => {
      const texture = await loader.loadAsync(`/assets/characters/${role.id}/${page.image}`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      return texture;
    })).then(textures => ({ key, data, textures })).catch(error => {
      clipCache.delete(cacheKey);
      throw error;
    });
    clipCache.set(cacheKey, promise);
  }
  return clipCache.get(cacheKey);
}

export class Character {
  constructor({ role, position, scene, labelsRoot, shadowTexture, onError }) {
    this.role = role;
    this.onError = onError;
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
    this._queueReady = false;
    this._holdTime = 0;
    this._projected = new THREE.Vector3();
    this._cameraRotation = new THREE.Quaternion();
    this.group = new THREE.Group();
    if (position?.isVector3) this.group.position.copy(position);
    else if (position) this.group.position.fromArray(position);
    this.billboard = new THREE.Group();
    this.group.add(this.billboard);
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: 0.035, depthWrite: true,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.plane = new THREE.Mesh(geometry, this.material);
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

  async _prepare(key) {
    if (!this._clips.has(key)) {
      const promise = loadClip(this.role, key).then(clip => ({
        ...clip, textures: clip.textures.map(texture => texture.clone()),
      })).catch(error => {
        this._clips.delete(key);
        throw error;
      });
      this._clips.set(key, promise);
    }
    return this._clips.get(key);
  }

  async init() {
    if (!this._initPromise) this._initPromise = (async () => {
      try {
        const [idle] = await Promise.all([this._prepare('build/Relax'), this._prepare('build/Move')]);
        this._idle = idle;
        this._ready = true;
        this._commit(idle, 'idle', true);
        return this;
      } catch (error) { this._report(error); throw error; }
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

  async _play(keys, state) {
    const token = ++this._version;
    this._pendingState = state;
    try {
      const first = await this._prepare(keys[0]);
      if (token !== this._version) return false;
      this._pendingState = null;
      this._queueReady = false;
      this._queue = [];
      this.actionNote = state === 'skill1' && this.role.id === 'char_2025_shu'
        ? '技能1使用普通攻击动作（源无独立动画）' : '';
      this._commit(first, state, state === 'idle' || state === 'move');

      const clips = await Promise.all([...keys.slice(1), 'build/Relax'].map(key => this._prepare(key)));
      if (token !== this._version) return false;
      this._idle = clips.pop();
      this._queue = clips;
      this._queueReady = true;
      return true;
    } catch (error) {
      if (token !== this._version) return false;
      this._pendingState = null;
      this._report(error);
      this.resetIdle();
      return false;
    }
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
    ++this._version;
    this._pendingState = null;
    this._queue = [];
    this._queueReady = false;
    this.actionNote = '';
    if (this._idle) this._commit(this._idle, 'idle', true);
    else if (this.ready) void this._play(['build/Relax'], 'idle');
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
    this._setFrame(0);
  }

  _setFrame(frame) {
    const { data, textures } = this._clip;
    this.frame = Math.min(data.frames - 1, Math.max(0, frame));
    const index = data.pages.findIndex(page => this.frame >= page.startFrame && this.frame < page.startFrame + page.frames);
    if (index < 0) throw new Error(`图集分页缺少帧 ${this.clipKey}:${this.frame}`);
    const page = data.pages[index];
    const texture = textures[index];
    if (!this.material.map) this.material.needsUpdate = true;
    this.material.map = texture;
    const local = this.frame - page.startFrame;
    const inset = 0.5 / data.cellSize;
    texture.repeat.set((1 - 2 * inset) / page.columns, (1 - 2 * inset) / page.rows);
    texture.offset.set((local % page.columns + inset) / page.columns,
      1 - (Math.floor(local / page.columns) + 1 - inset) / page.rows);
    this.label.dataset.frame = String(this.frame);
  }

  update(delta, camera, paused = false) {
    if (camera) {
      camera.getWorldQuaternion(this.billboard.quaternion);
      this.group.getWorldQuaternion(this._cameraRotation).invert();
      this.billboard.quaternion.premultiply(this._cameraRotation);
      this._projected.copy(this.label.position);
      this.group.localToWorld(this._projected).project(camera);
      this.label.style.display = Math.abs(this._projected.z) <= 1 ? 'block' : 'none';
      const root = this.label.parentElement;
      const width = root?.clientWidth || globalThis.innerWidth;
      const height = root?.clientHeight || globalThis.innerHeight;
      this.label.style.left = `${(this._projected.x * 0.5 + 0.5) * width}px`;
      this.label.style.top = `${(-this._projected.y * 0.5 + 0.5) * height}px`;
    }
    if (paused || !this._clip) return;
    if (this._holdTime > 0) {
      this._holdTime = Math.max(0, this._holdTime - Math.max(0, delta));
      if (this._holdTime === 0) this._commit(this._idle, 'idle', true);
      return;
    }
    let remaining = Math.max(0, delta) * (this.state === 'move' ? this._rate : 1);
    // Consume each finite segment once; carry excess time across the queue synchronously.
    while (remaining > 0) {
      const data = this._clip.data;
      const duration = data.duration > 0 ? data.duration : data.frames / data.fps;
      const step = Math.min(remaining, Math.max(0, duration - this.frameTime));
      this.frameTime += step;
      remaining -= step;
      if (this.frameTime < duration) break;
      if (this._loop) { this.frameTime = remaining % duration; break; }
      const next = this._queue.shift();
      if (next) {
        this._commit(next, this.state, false);
      } else if (!this._queueReady) {
        this.frameTime = duration;
        break;
      } else if (this.state !== 'idle' && this.state !== 'move') {
        this.frameTime = duration;
        this._holdTime = 0.35;
        break;
      } else {
        this._commit(this._idle, 'idle', true);
      }
    }
    this._setFrame(Math.floor(this.frameTime * this._clip.data.fps));
  }
}
