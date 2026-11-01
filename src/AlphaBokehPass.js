import { DepthTexture, HalfFloatType, NearestFilter, UnsignedIntType, Vector2, WebGLRenderTarget } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const depthShader = /* glsl */`
  #include <packing>
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float nearClip;
  uniform float farClip;
  uniform float focus;
  uniform float aperture;
  uniform float maxblur;
  uniform vec2 resolution;

  float viewDepth(vec2 uv) {
    return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, nearClip, farClip);
  }

  float blurRadius(float depth) {
    return min(maxblur, abs(depth - focus) * aperture);
  }

  float depthWeight(float a, float b) {
    return 1.0 - smoothstep(0.25, 1.25, abs(a - b));
  }
`;

const blurShader = {
  name: 'DepthAwareBokeh',
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    focus: { value: 14.6 },
    aperture: { value: 0.0016 },
    maxblur: { value: 0.009 },
    nearClip: { value: 0.1 },
    farClip: { value: 80 },
    resolution: { value: new Vector2(1, 1) },
  },
  vertexShader,
  fragmentShader: /* glsl */`
    ${depthShader}
    void main() {
      float depth = viewDepth(vUv);
      float radius = blurRadius(depth);
      vec3 color = texture2D(tColor, vUv).rgb;
      float weight = 1.0;
      // A fixed disk avoids temporal noise; depth rejection prevents sharp
      // silhouettes from leaking into blurred scenery through transparent texels.
      for (int i = 0; i < 16; i++) {
        float angle = float(i) * 2.39996323;
        float distance = sqrt((float(i) + 0.5) / 16.0);
        vec2 offset = vec2(cos(angle), sin(angle)) * distance * radius;
        offset.y *= resolution.x / resolution.y;
        vec2 uv = vUv + offset;
        float sampleDepth = viewDepth(uv);
        float sampleRadius = blurRadius(sampleDepth);
        float radiusPixels = sampleRadius * resolution.x;
        float offsetPixels = distance * radius * resolution.x;
        // Defocused silhouettes may spread only as far as their own blur disk.
        // In-focus foreground samples cannot contaminate a blurred background.
        float coverage = 1.0 - smoothstep(radiusPixels * 0.6, radiusPixels + 1.0, offsetPixels);
        float defocused = smoothstep(0.5, 1.5, min(radius, sampleRadius) * resolution.x);
        float sampleWeight = max(depthWeight(depth, sampleDepth), defocused * coverage);
        color += texture2D(tColor, uv).rgb * sampleWeight;
        weight += sampleWeight;
      }
      // Retain the sample's depth for edge-aware upsampling.
      gl_FragColor = vec4(color / weight, depth);
    }
  `,
};

const compositeShader = {
  name: 'DepthAwareBokehComposite',
  uniforms: {
    ...blurShader.uniforms,
    tBlur: { value: null },
    blurSize: { value: new Vector2(1, 1) },
  },
  vertexShader,
  fragmentShader: /* glsl */`
    ${depthShader}
    uniform sampler2D tBlur;
    uniform vec2 blurSize;
    void main() {
      vec3 original = texture2D(tColor, vUv).rgb;
      float depth = viewDepth(vUv);
      float amount = smoothstep(0.5, 1.5, blurRadius(depth) * resolution.x);
      if (amount == 0.0) {
        gl_FragColor = vec4(original, 1.0);
        return;
      }
      vec2 position = vUv * blurSize - 0.5;
      vec2 base = floor(position);
      vec2 fraction = fract(position);
      vec3 color = vec3(0.0);
      float weight = 0.0;
      for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 2; x++) {
          vec2 corner = vec2(float(x), float(y));
          vec2 uv = (base + corner + 0.5) / blurSize;
          vec4 sampleColor = texture2D(tBlur, uv);
          vec2 blend = mix(1.0 - fraction, fraction, corner);
          float sampleWeight = blend.x * blend.y * depthWeight(depth, sampleColor.a);
          color += sampleColor.rgb * sampleWeight;
          weight += sampleWeight;
        }
      }
      // Full-resolution color is retained wherever the low-resolution depth
      // samples belong to another surface, including tiny hair/weapon details.
      vec3 blurred = (color + original * 0.0001) / (weight + 0.0001);
      gl_FragColor = vec4(mix(original, blurred, amount), 1.0);
    }
  `,
};

export class AlphaBokehPass extends ShaderPass {
  constructor(scene, camera, params = {}) {
    super(compositeShader);
    this.scene = scene;
    this.camera = camera;
    this.renderScale = params.renderScale ?? 0.5;
    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'Full-resolution scene color';
    this.sceneTarget.depthTexture.name = 'Alpha-tested scene depth';
    this.blurTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
    });
    this.blurPass = new ShaderPass(blurShader);
    // Both passes use the same depth and lens parameters.
    for (const key of Object.keys(blurShader.uniforms)) {
      this.blurPass.uniforms[key] = this.uniforms[key];
    }
    this.uniforms.tColor.value = this.sceneTarget.texture;
    this.uniforms.tDepth.value = this.sceneTarget.depthTexture;
    this.uniforms.tBlur.value = this.blurTarget.texture;
    this.uniforms.focus.value = params.focus ?? 14.6;
    this.uniforms.aperture.value = params.aperture ?? 0.0016;
    this.uniforms.maxblur.value = params.maxblur ?? 0.009;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this.sceneTarget);
      // Alpha-discarded texels write neither color nor depth. World and characters
      // share native depth, so there is no rectangular sprite depth overlay.
      renderer.render(this.scene, this.camera);
      this.uniforms.nearClip.value = this.camera.near;
      this.uniforms.farClip.value = this.camera.far;
      this.blurPass.render(renderer, this.blurTarget, readBuffer);
      super.render(renderer, writeBuffer, readBuffer);
    } finally {
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget);
    }
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    const blurWidth = Math.max(1, Math.floor(width * this.renderScale));
    const blurHeight = Math.max(1, Math.floor(height * this.renderScale));
    this.blurTarget.setSize(blurWidth, blurHeight);
    this.uniforms.resolution.value.set(width, height);
    this.uniforms.blurSize.value.set(blurWidth, blurHeight);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.blurTarget.dispose();
    this.blurPass.dispose();
    super.dispose();
  }
}
