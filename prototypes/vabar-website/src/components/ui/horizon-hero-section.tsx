// horizon-hero-section.tsx
// Scroll-driven WebGL hero: star field, nebula, layered mountains and bloom.
// Based on the shared "HeroSection" component, ported to TypeScript. Changes from the
// original: typed refs, configurable copy and colours (props), scroll progress measured
// over this section only (so the page can continue below it), the title is split into
// characters so its intro animation runs, rendering pauses off-screen, reduced motion is
// respected, and the scene falls back to a CSS gradient when WebGL is unavailable.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as THREE from "three";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import "./horizon-hero-section.css";

gsap.registerPlugin(ScrollTrigger);

export type HeroSlide = {
  title: string;
  line1: string;
  line2: string;
  /** Scene colours while this slide is on screen; the scene blends between slides as you scroll. */
  palette?: HeroPalette;
  /** CSS background painted behind the scene for this slide (cross-fades between slides). */
  background?: string;
  /** Colour of the glow around this slide's title. */
  glow?: string;
};

export type HeroPalette = {
  nebula: [number, number];
  mountains: [number, number, number, number];
  atmosphere: [number, number, number];
};

export type HeroProps = {
  /** First slide is the landing title; the rest scroll in one screen at a time. */
  slides?: HeroSlide[];
  menuLabel?: string;
  scrollLabel?: string;
  palette?: HeroPalette;
  onMenuClick?: () => void;
  /** Optional fuller page heading for screen readers and search engines (the big title stays visual). */
  srTitle?: string;
  /** Optional logo shown instead of the landing title text (the title stays as its accessible name). */
  logo?: ReactNode;
  /** Rendered under the landing subtitle (e.g. call-to-action buttons). */
  children?: ReactNode;
};

const DEFAULT_SLIDES: HeroSlide[] = [
  { title: "HORIZON", line1: "Where vision meets reality,", line2: "we shape the future of tomorrow" },
  { title: "COSMOS", line1: "Beyond the boundaries of imagination,", line2: "lies the universe of possibilities" },
  { title: "INFINITY", line1: "In the space between thought and creation,", line2: "we find the essence of true innovation" },
];

const DEFAULT_PALETTE: HeroPalette = {
  nebula: [0x0033ff, 0xff0066],
  mountains: [0x1a1a2e, 0x16213e, 0x0f3460, 0x0a4668],
  atmosphere: [0.3, 0.6, 1.0],
};

type ShaderPoints = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
type ShaderMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
type BasicMesh = THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;

type ThreeState = {
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  renderer: THREE.WebGLRenderer | null;
  composer: EffectComposer | null;
  stars: ShaderPoints[];
  nebula: ShaderMesh | null;
  atmosphere: ShaderMesh | null;
  mountains: BasicMesh[];
  locations: number[];
  animationId: number | null;
  visible: boolean;
  target: { x: number; y: number; z: number } | null;
  /** Scroll position in slides (0 … slides-1): target from scroll, current eased towards it. */
  blendTarget: number;
  blend: number;
  lastTime: number;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const Component = ({
  slides = DEFAULT_SLIDES,
  menuLabel = "SPACE",
  scrollLabel = "SCROLL",
  palette = DEFAULT_PALETTE,
  onMenuClick,
  srTitle,
  logo,
  children,
}: HeroProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const scrollProgressRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  const smoothCameraPos = useRef({ x: 0, y: 30, z: 100 });

  const [scrollProgress, setScrollProgress] = useState(0);
  const [currentSection, setCurrentSection] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const totalSections = Math.max(slides.length - 1, 1);

  const threeRefs = useRef<ThreeState>({
    scene: null,
    camera: null,
    renderer: null,
    composer: null,
    stars: [],
    nebula: null,
    atmosphere: null,
    mountains: [],
    locations: [],
    animationId: null,
    visible: true,
    target: null,
    blendTarget: 0,
    blend: 0,
    lastTime: 0,
  });

  // One palette per slide (falling back to `palette`). Keyed by value so a new array with the
  // same colours (e.g. after a language switch) does not rebuild the WebGL scene.
  const paletteKey = JSON.stringify([palette, slides.map((s) => s.palette ?? null)]);
  const scenePalettes = useMemo(
    () => slides.map((s) => s.palette ?? palette),
    [paletteKey],
  );

  // Initialize Three.js
  useEffect(() => {
    const refs = threeRefs.current;
    const reduced = prefersReducedMotion();
    const palette = scenePalettes[0];
    // Pre-built colours for blending between slides.
    const sceneColors = scenePalettes.map((p) => ({
      nebula: p.nebula.map((c) => new THREE.Color(c)),
      mountains: p.mountains.map((c) => new THREE.Color(c)),
      atmosphere: new THREE.Vector3(...p.atmosphere),
    }));
    const tmpVec = new THREE.Vector3();
    // StrictMode mounts twice: start from clean arrays every time.
    refs.stars = [];
    refs.mountains = [];
    refs.locations = [];

    const createStarField = (scene: THREE.Scene) => {
      const starCount = window.innerWidth < 768 ? 2500 : 5000;

      for (let i = 0; i < 3; i++) {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(starCount * 3);
        const colors = new Float32Array(starCount * 3);
        const sizes = new Float32Array(starCount);

        for (let j = 0; j < starCount; j++) {
          const radius = 200 + Math.random() * 800;
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(Math.random() * 2 - 1);

          positions[j * 3] = radius * Math.sin(phi) * Math.cos(theta);
          positions[j * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          positions[j * 3 + 2] = radius * Math.cos(phi);

          // Color variation
          const color = new THREE.Color();
          const colorChoice = Math.random();
          if (colorChoice < 0.7) {
            color.setHSL(0, 0, 0.8 + Math.random() * 0.2);
          } else if (colorChoice < 0.9) {
            color.setHSL(0.08, 0.5, 0.8);
          } else {
            color.setHSL(0.6, 0.5, 0.8);
          }

          colors[j * 3] = color.r;
          colors[j * 3 + 1] = color.g;
          colors[j * 3 + 2] = color.b;

          sizes[j] = Math.random() * 2 + 0.5;
        }

        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

        const material = new THREE.ShaderMaterial({
          uniforms: {
            time: { value: 0 },
            depth: { value: i },
          },
          vertexShader: `
            attribute float size;
            attribute vec3 color;
            varying vec3 vColor;
            uniform float time;
            uniform float depth;

            void main() {
              vColor = color;
              vec3 pos = position;

              // Slow rotation based on depth
              float angle = time * 0.05 * (1.0 - depth * 0.3);
              mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
              pos.xy = rot * pos.xy;

              vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
              gl_PointSize = size * (300.0 / -mvPosition.z);
              gl_Position = projectionMatrix * mvPosition;
            }
          `,
          fragmentShader: `
            varying vec3 vColor;

            void main() {
              float dist = length(gl_PointCoord - vec2(0.5));
              if (dist > 0.5) discard;

              float opacity = 1.0 - smoothstep(0.0, 0.5, dist);
              gl_FragColor = vec4(vColor, opacity);
            }
          `,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });

        const stars = new THREE.Points(geometry, material);
        scene.add(stars);
        refs.stars.push(stars);
      }
    };

    const createNebula = (scene: THREE.Scene) => {
      const geometry = new THREE.PlaneGeometry(8000, 4000, 100, 100);
      const material = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          color1: { value: new THREE.Color(palette.nebula[0]) },
          color2: { value: new THREE.Color(palette.nebula[1]) },
          opacity: { value: 0.3 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying float vElevation;
          uniform float time;

          void main() {
            vUv = uv;
            vec3 pos = position;

            float elevation = sin(pos.x * 0.01 + time) * cos(pos.y * 0.01 + time) * 20.0;
            pos.z += elevation;
            vElevation = elevation;

            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 color1;
          uniform vec3 color2;
          uniform float opacity;
          uniform float time;
          varying vec2 vUv;
          varying float vElevation;

          void main() {
            float mixFactor = sin(vUv.x * 10.0 + time) * cos(vUv.y * 10.0 + time);
            vec3 color = mix(color1, color2, mixFactor * 0.5 + 0.5);

            float alpha = opacity * (1.0 - length(vUv - 0.5) * 2.0);
            alpha *= 1.0 + vElevation * 0.01;

            gl_FragColor = vec4(color, alpha);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const nebula = new THREE.Mesh(geometry, material);
      nebula.position.z = -1050;
      nebula.rotation.x = 0;
      scene.add(nebula);
      refs.nebula = nebula;
    };

    const createMountains = (scene: THREE.Scene) => {
      const layers = [
        { distance: -50, height: 60, color: palette.mountains[0], opacity: 1 },
        { distance: -100, height: 80, color: palette.mountains[1], opacity: 0.8 },
        { distance: -150, height: 100, color: palette.mountains[2], opacity: 0.6 },
        { distance: -200, height: 120, color: palette.mountains[3], opacity: 0.4 },
      ];

      layers.forEach((layer, index) => {
        const points: THREE.Vector2[] = [];
        const segments = 50;

        for (let i = 0; i <= segments; i++) {
          const x = (i / segments - 0.5) * 1000;
          const y =
            Math.sin(i * 0.1) * layer.height +
            Math.sin(i * 0.05) * layer.height * 0.5 +
            Math.random() * layer.height * 0.2 -
            100;
          points.push(new THREE.Vector2(x, y));
        }

        points.push(new THREE.Vector2(5000, -300));
        points.push(new THREE.Vector2(-5000, -300));

        const shape = new THREE.Shape(points);
        const geometry = new THREE.ShapeGeometry(shape);
        const material = new THREE.MeshBasicMaterial({
          color: layer.color,
          transparent: true,
          opacity: layer.opacity,
          side: THREE.DoubleSide,
        });

        const mountain = new THREE.Mesh(geometry, material);
        mountain.position.z = layer.distance;
        mountain.position.y = layer.distance;
        mountain.userData = { baseZ: layer.distance, index };
        scene.add(mountain);
        refs.mountains.push(mountain);
      });
    };

    const createAtmosphere = (scene: THREE.Scene) => {
      const geometry = new THREE.SphereGeometry(600, 32, 32);
      const [r, g, b] = palette.atmosphere;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          tint: { value: new THREE.Vector3(r, g, b) },
        },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vPosition;

          void main() {
            vNormal = normalize(normalMatrix * normal);
            vPosition = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          varying vec3 vPosition;
          uniform float time;
          uniform vec3 tint;

          void main() {
            float intensity = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
            vec3 atmosphere = tint * intensity;

            float pulse = sin(time * 2.0) * 0.1 + 0.9;
            atmosphere *= pulse;

            gl_FragColor = vec4(atmosphere, intensity * 0.25);
          }
        `,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
      });

      const atmosphere = new THREE.Mesh(geometry, material);
      scene.add(atmosphere);
      refs.atmosphere = atmosphere;
    };

    const getLocation = () => {
      refs.locations = refs.mountains.map((mountain) => mountain.position.z);
    };

    const renderFrame = (time: number) => {
      refs.stars.forEach((starField) => {
        starField.material.uniforms.time.value = time;
      });

      if (refs.nebula) refs.nebula.material.uniforms.time.value = time * 0.5;
      if (refs.atmosphere) refs.atmosphere.material.uniforms.time.value = time;

      // Blend the scene colours towards the slide being scrolled to.
      if (sceneColors.length > 1) {
        // Time-based easing, so the colours settle in about a second at any frame rate.
        const dt = refs.lastTime ? Math.min(Math.max(time - refs.lastTime, 0), 0.25) : 1 / 60;
        refs.lastTime = time;
        refs.blend += (refs.blendTarget - refs.blend) * (reduced ? 1 : 1 - Math.exp(-dt * 3.5));
        const i = Math.min(Math.floor(refs.blend), sceneColors.length - 1);
        const f = Math.min(Math.max(refs.blend - i, 0), 1);
        const a = sceneColors[i];
        const b = sceneColors[Math.min(i + 1, sceneColors.length - 1)];
        if (refs.nebula) {
          (refs.nebula.material.uniforms.color1.value as THREE.Color).lerpColors(a.nebula[0], b.nebula[0], f);
          (refs.nebula.material.uniforms.color2.value as THREE.Color).lerpColors(a.nebula[1], b.nebula[1], f);
        }
        refs.mountains.forEach((m, k) => m.material.color.lerpColors(a.mountains[k], b.mountains[k], f));
        if (refs.atmosphere) {
          (refs.atmosphere.material.uniforms.tint.value as THREE.Vector3).copy(tmpVec.copy(a.atmosphere).lerp(b.atmosphere, f));
        }
      }

      // Smooth camera movement with easing
      if (refs.camera && refs.target) {
        const smoothingFactor = reduced ? 1 : 0.05; // Lower = smoother but slower
        const pos = smoothCameraPos.current;
        pos.x += (refs.target.x - pos.x) * smoothingFactor;
        pos.y += (refs.target.y - pos.y) * smoothingFactor;
        pos.z += (refs.target.z - pos.z) * smoothingFactor;

        // Add subtle floating motion
        const floatX = reduced ? 0 : Math.sin(time * 0.1) * 2;
        const floatY = reduced ? 0 : Math.cos(time * 0.15) * 1;

        refs.camera.position.set(pos.x + floatX, pos.y + floatY, pos.z);
        refs.camera.lookAt(0, 10, -600);
      }

      // Parallax mountains with subtle animation
      refs.mountains.forEach((mountain, i) => {
        const parallaxFactor = 1 + i * 0.5;
        mountain.position.x = reduced ? 0 : Math.sin(time * 0.1) * 2 * parallaxFactor;
        mountain.position.y = 50 + (reduced ? 0 : Math.cos(time * 0.15) * 1 * parallaxFactor);
      });

      refs.composer?.render();
    };

    const animate = () => {
      refs.animationId = requestAnimationFrame(animate);
      if (!refs.visible || document.hidden) return;
      renderFrame(Date.now() * 0.001);
    };

    const initThree = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Scene setup
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x000000, 0.00025);
      refs.scene = scene;

      // Camera
      refs.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
      refs.camera.position.z = 100;
      refs.camera.position.y = 20;

      // Renderer
      refs.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      refs.renderer.setSize(window.innerWidth, window.innerHeight);
      refs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      refs.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      refs.renderer.toneMappingExposure = 0.5;

      // Post-processing
      refs.composer = new EffectComposer(refs.renderer);
      refs.composer.addPass(new RenderPass(scene, refs.camera));
      refs.composer.addPass(
        new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.4, 0.85),
      );

      // Create scene elements
      createStarField(scene);
      createNebula(scene);
      createMountains(scene);
      createAtmosphere(scene);
      getLocation();

      if (reduced) {
        // One still frame, re-rendered on scroll (see the scroll effect).
        renderFrame(0);
      } else {
        animate();
      }
    };

    try {
      initThree();
    } catch (error) {
      console.warn("Hero: WebGL unavailable, showing the static background.", error);
      setWebglFailed(true);
    }
    // Mark as ready after Three.js is initialized (or has failed) so the UI animates in.
    setIsReady(true);

    // Handle resize
    const handleResize = () => {
      if (refs.camera && refs.renderer && refs.composer) {
        refs.camera.aspect = window.innerWidth / window.innerHeight;
        refs.camera.updateProjectionMatrix();
        refs.renderer.setSize(window.innerWidth, window.innerHeight);
        refs.composer.setSize(window.innerWidth, window.innerHeight);
        if (reduced) renderFrame(0);
      }
    };
    window.addEventListener("resize", handleResize);

    // Stop drawing while the hero is scrolled out of view.
    const observer = new IntersectionObserver(([entry]) => {
      refs.visible = entry.isIntersecting;
    });
    if (containerRef.current) observer.observe(containerRef.current);

    // Cleanup
    return () => {
      if (refs.animationId) cancelAnimationFrame(refs.animationId);
      refs.animationId = null;
      window.removeEventListener("resize", handleResize);
      observer.disconnect();

      // Dispose Three.js resources
      refs.stars.forEach((starField) => {
        starField.geometry.dispose();
        starField.material.dispose();
      });
      refs.mountains.forEach((mountain) => {
        mountain.geometry.dispose();
        mountain.material.dispose();
      });
      [refs.nebula, refs.atmosphere].forEach((mesh) => {
        mesh?.geometry.dispose();
        mesh?.material.dispose();
      });
      refs.composer?.dispose();
      refs.renderer?.dispose();
      refs.scene = null;
      refs.camera = null;
      refs.renderer = null;
      refs.composer = null;
      refs.nebula = null;
      refs.atmosphere = null;
    };
  }, [scenePalettes]);

  // GSAP Animations - Run after component is ready
  useEffect(() => {
    if (!isReady) return;

    // Set initial states to prevent flash
    gsap.set([menuRef.current, titleRef.current, subtitleRef.current, scrollProgressRef.current], {
      visibility: "visible",
    });
    if (prefersReducedMotion()) return;

    const tl = gsap.timeline();

    // Animate menu
    if (menuRef.current) {
      tl.from(menuRef.current, { x: -100, opacity: 0, duration: 1, ease: "power3.out" });
    }

    // Animate title with split text
    if (titleRef.current) {
      const titleChars = titleRef.current.querySelectorAll(".title-char, .hero-logo");
      tl.from(titleChars, { y: 200, opacity: 0, duration: 1.5, stagger: 0.05, ease: "power4.out" }, "-=0.5");
    }

    // Animate subtitle lines
    if (subtitleRef.current) {
      const subtitleLines = subtitleRef.current.querySelectorAll(".subtitle-line, .hero-actions");
      tl.from(subtitleLines, { y: 50, opacity: 0, duration: 1, stagger: 0.2, ease: "power3.out" }, "-=0.8");
    }

    // Animate scroll indicator
    if (scrollProgressRef.current) {
      tl.from(scrollProgressRef.current, { opacity: 0, y: 50, duration: 1, ease: "power2.out" }, "-=0.5");
    }

    return () => {
      tl.kill();
    };
  }, [isReady]);

  // Scroll handling: progress runs 0 → 1 across this section only.
  useEffect(() => {
    const reduced = prefersReducedMotion();

    // Define camera positions for each section
    const cameraPositions = [
      { x: 0, y: 30, z: 300 }, // Section 0
      { x: 0, y: 40, z: -50 }, // Section 1
      { x: 0, y: 50, z: -700 }, // Section 2
    ];

    const handleScroll = () => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const maxScroll = Math.max(container.offsetHeight - window.innerHeight, 1);
      const scrolled = Math.min(Math.max(-rect.top, 0), maxScroll);
      const progress = scrolled / maxScroll;

      setScrollProgress(progress);
      const newSection = Math.min(Math.floor(progress * totalSections), totalSections);
      setCurrentSection(newSection);

      const refs = threeRefs.current;

      // Calculate smooth progress through all sections
      const totalProgress = progress * totalSections;
      const sectionProgress = totalProgress % 1;

      // Get current and next positions
      const currentPos = cameraPositions[Math.min(newSection, cameraPositions.length - 1)];
      const nextPos = cameraPositions[newSection + 1] || currentPos;

      // Set target positions (actual smoothing happens in animate loop)
      refs.target = {
        x: currentPos.x + (nextPos.x - currentPos.x) * sectionProgress,
        y: currentPos.y + (nextPos.y - currentPos.y) * sectionProgress,
        z: currentPos.z + (nextPos.z - currentPos.z) * sectionProgress,
      };

      refs.blendTarget = totalProgress;

      // Fly through the mountains, then move them out of the way.
      refs.mountains.forEach((mountain, i) => {
        mountain.position.z = progress > 0.7 ? 600000 : (refs.locations[i] ?? mountain.position.z);
      });
      if (refs.nebula && refs.mountains[3]) {
        refs.nebula.position.z = refs.mountains[3].position.z;
      }

      if (reduced && refs.composer && refs.camera) {
        smoothCameraPos.current = { ...refs.target };
        refs.blend = refs.blendTarget;
        refs.camera.position.set(refs.target.x, refs.target.y, refs.target.z);
        refs.camera.lookAt(0, 10, -600);
        refs.composer.render();
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll(); // Set initial position

    return () => window.removeEventListener("scroll", handleScroll);
  }, [totalSections]);

  const splitTitle = (text: string) =>
    text.split("").map((char, i) => (
      <span key={i} className="title-char" aria-hidden="true">
        {char === " " ? " " : char}
      </span>
    ));

  const [first, ...rest] = slides;

  return (
    <div
      ref={containerRef}
      className="hero-container cosmos-style"
      style={{ height: `${slides.length * 100}svh` }}
    >
      {/* Sticky stage: canvas, side menu and progress stay put while the slides scroll. */}
      <div className="hero-stage">
        {/* Per-slide backgrounds, cross-faded by scroll position */}
        {slides.map((slide, i) =>
          slide.background ? (
            <div
              key={slide.title}
              className="hero-bg"
              aria-hidden="true"
              style={{ background: slide.background, opacity: Math.max(0, 1 - Math.abs(scrollProgress * totalSections - i)) }}
            />
          ) : null,
        )}
        <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" data-failed={webglFailed || undefined} />

        {/* Side menu */}
        <button
          ref={menuRef}
          type="button"
          className="side-menu"
          style={{ visibility: "hidden" }}
          onClick={onMenuClick}
          aria-label={`${menuLabel} menu`}
        >
          <span className="menu-icon" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </span>
          <span className="vertical-text">{menuLabel}</span>
        </button>

        {/* Scroll progress indicator */}
        <div ref={scrollProgressRef} className="scroll-progress" style={{ visibility: "hidden" }} aria-hidden="true">
          <div className="scroll-text">{scrollLabel}</div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${scrollProgress * 100}%` }} />
          </div>
          <div className="section-counter">
            {String(currentSection).padStart(2, "0")} / {String(totalSections).padStart(2, "0")}
          </div>
        </div>
      </div>

      {/* Slides scroll over the stage */}
      <div className="scroll-sections">
        <section
          className="content-section hero-content cosmos-content"
          style={first.glow ? ({ "--glow": first.glow } as CSSProperties) : undefined}
        >
          <h1
            ref={titleRef}
            className="hero-title"
            style={{ visibility: "hidden", "--chars": first.title.length } as CSSProperties}
            aria-label={srTitle ? undefined : first.title}
          >
            {srTitle ? <span className="hero-sr-only">{srTitle}</span> : null}
            {logo ? <span className="hero-logo">{logo}</span> : splitTitle(first.title)}
          </h1>

          <div ref={subtitleRef} className="hero-subtitle cosmos-subtitle" style={{ visibility: "hidden" }}>
            <p className="subtitle-line">{first.line1}</p>
            <p className="subtitle-line">{first.line2}</p>
            {children ? <div className="hero-actions">{children}</div> : null}
          </div>
        </section>

        {rest.map((slide) => (
          <section
            key={slide.title}
            className="content-section"
            style={slide.glow ? ({ "--glow": slide.glow } as CSSProperties) : undefined}
          >
            <h2 className="hero-title" style={{ "--chars": slide.title.length } as CSSProperties}>
              {slide.title}
            </h2>

            <div className="hero-subtitle cosmos-subtitle">
              <p className="subtitle-line">{slide.line1}</p>
              <p className="subtitle-line">{slide.line2}</p>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

export default Component;
