// 3D: frames as extruded meshes with real depth, a walk-around wall viewer, and USDZ export
// for AR Quick Look on iPhone / iPad. Loaded on demand (three.js is large).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { footprint, unionBox } from './arrange';
import { makeCanvas } from './imaging';
import { drawItems, img } from './render';
import type { Frame, Picture, PlacedItem } from './types';

const IN = 0.0254; // metres per inch

/** Bake a frame's face (frame photo + swapped pictures) into a texture canvas. */
async function frameTexture(frame: Frame, item: PlacedItem, pictures: Map<string, Picture>, maxPx: number): Promise<HTMLCanvasElement> {
  const W = frame.widthIn + frame.padX * 2, H = frame.heightIn + frame.padY * 2;
  const ppi = maxPx / Math.max(W, H);
  const c = makeCanvas(W * ppi, H * ppi);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(ppi, 0, 0, ppi, frame.padX * ppi, frame.padY * ppi);
  // Draw unclipped frame photo first so the extruded sides pick up the molding colour.
  ctx.drawImage(await img(frame.imageBlobId), -frame.padX, -frame.padY, W, H);
  await drawItems(ctx, [{ ...item, x: frame.widthIn / 2, y: frame.heightIn / 2, rotation: 0 }], new Map([[frame.id, frame]]), pictures, ppi, false);
  return c;
}

/** Extrude the frame outline to its depth; UVs map the face onto the baked texture. */
function frameMesh(frame: Frame, tex: THREE.Texture): THREE.Mesh {
  const shape = new THREE.Shape(frame.outline.map((p) => new THREE.Vector2(p.x - frame.widthIn / 2, -(p.y - frame.heightIn / 2))));
  const depth = frame.depthIn ?? 1;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const W = frame.widthIn + frame.padX * 2, H = frame.heightIn + frame.padY * 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + frame.widthIn / 2;
    const yDown = -pos.getY(i) + frame.heightIn / 2;
    uv[i * 2] = (x + frame.padX) / W;
    uv[i * 2 + 1] = 1 - (yDown + frame.padY) / H;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(IN);
  mesh.castShadow = true;
  return mesh;
}

export interface Gallery {
  group: THREE.Group;
  /** Arrangement centre in wall inches (the group's origin). */
  cx: number;
  cy: number;
  widthIn: number;
  heightIn: number;
}

/** All placed frames as one group, centred on the arrangement, facing +Z (out of the wall). */
export async function buildGallery(items: PlacedItem[], frames: Map<string, Frame>, pictures: Map<string, Picture>, maxTex = 1024): Promise<Gallery> {
  const group = new THREE.Group();
  const placed = items.filter((i) => frames.has(i.frameId));
  const u = unionBox(placed.map((i) => footprint(i, frames.get(i.frameId)!))) ?? { x: 0, y: 0, w: 0, h: 0 };
  const cx = u.x + u.w / 2, cy = u.y + u.h / 2;
  for (const it of placed) {
    const f = frames.get(it.frameId)!;
    const canvas = await frameTexture(f, it, pictures, maxTex);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = frameMesh(f, tex);
    const holder = new THREE.Group();
    holder.position.set((it.x - cx) * IN, -(it.y - cy) * IN, 0);
    holder.rotation.z = (-it.rotation * Math.PI) / 180;
    holder.add(mesh);
    group.add(holder);
  }
  return { group, cx, cy, widthIn: u.w, heightIn: u.h };
}

/** A USDZ file that AR Quick Look anchors to a wall, at true size. */
export async function exportUSDZ(g: Gallery): Promise<Blob> {
  const scene = new THREE.Scene();
  scene.add(g.group);
  const exporter = new USDZExporter();
  const data = await exporter.parseAsync(scene, {
    ar: { anchoring: { type: 'plane' }, planeAnchoring: { alignment: 'vertical' } },
    quickLookCompatible: true,
    maxTextureSize: 1024,
  });
  scene.remove(g.group);
  return new Blob([data as unknown as BlobPart], { type: 'model/vnd.usdz+zip' });
}

export function arSupported(): boolean {
  const a = document.createElement('a');
  return !!a.relList?.supports?.('ar');
}

/** Open a USDZ in AR Quick Look (iOS / iPadOS Safari). */
export function openQuickLook(blob: Blob, thumbnail?: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.rel = 'ar';
  // True scale only: stop pinch-to-resize so the preview stays honest.
  a.href = `${url}#allowsContentScaling=0`;
  const im = document.createElement('img');
  if (thumbnail) im.src = thumbnail;
  a.appendChild(im);
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}

// ---- Walk-around viewer ---------------------------------------------------------------------

export interface WallScene {
  wallUrl?: string; // straightened wall image
  x0: number; y0: number; x1: number; y1: number; // image extent, wall inches
  floorY: number; // wall-inch y of the floor
  ceilingY?: number;
  gallery: Gallery;
}

export type Vantage = 'front' | 'left' | 'right' | 'close' | 'seated' | 'far';

export class WallViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private raf = 0;
  private target: THREE.Vector3;
  private ro: ResizeObserver;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; t0: number } | null = null;

  constructor(private host: HTMLElement, private s: WallScene) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.scene.background = new THREE.Color('#1a1a1f');

    const { gallery } = s;
    const eye = 1.6;
    const centerH = (s.floorY - gallery.cy) * IN;
    this.target = new THREE.Vector3(0, centerH, 0);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 50);
    this.camera.position.set(0, eye, 2.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.target);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 9;
    this.controls.minAzimuthAngle = -Math.PI * 0.47;
    this.controls.maxAzimuthAngle = Math.PI * 0.47;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.minPolarAngle = Math.PI * 0.2;
    this.controls.screenSpacePanning = true;

    // Lights: soft room light plus a key light for frame shadows on the wall.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-1.2, 3.2, 3);
    key.target.position.set(0, centerH, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const r = Math.max(gallery.widthIn, gallery.heightIn) * IN + 1;
    Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: 12 });
    key.shadow.radius = 6;
    key.shadow.bias = -0.0005;
    this.scene.add(key, key.target);

    gallery.group.position.set(0, centerH, 0.001);
    this.scene.add(gallery.group);
    void this.buildRoom();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.anim) {
        const t = Math.min(1, (performance.now() - this.anim.t0) / 700);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.camera.position.lerpVectors(this.anim.from, this.anim.to, e);
        if (t >= 1) this.anim = null;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private async buildRoom() {
    const s = this.s;
    const cx = s.gallery.cx;
    const wallW = (s.x1 - s.x0) * IN, wallH = (s.y1 - s.y0) * IN;
    const midX = ((s.x0 + s.x1) / 2 - cx) * IN;
    const midY = (s.floorY - (s.y0 + s.y1) / 2) * IN;
    let wallColor = new THREE.Color('#d9d4ca');
    let floorColor = new THREE.Color('#a88a66');
    if (s.wallUrl) {
      const im = new Image();
      im.src = s.wallUrl;
      await im.decode().catch(() => undefined);
      // Areas the photo didn't cover come out black; make them transparent.
      const c = makeCanvas(im.naturalWidth, im.naturalHeight);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const sumWall = [0, 0, 0, 0], sumFloor = [0, 0, 0, 0];
      const floorRow = ((s.floorY - s.y0) / (s.y1 - s.y0)) * c.height;
      // Only the wall plane is real in this photo: hide the ceiling and floor parts of it.
      const topRow = s.ceilingY !== undefined ? ((s.ceilingY - s.y0) / (s.y1 - s.y0)) * c.height : -1;
      for (let i = 0; i < d.data.length; i += 4) {
        const r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
        const row = i / 4 / c.width;
        const outside = row < topRow || row > floorRow + 2;
        if (r + g + b < 10 || outside) {
          if (outside && row > floorRow + 4 && r + g + b >= 10 && (i / 4) % 7 === 0) { sumFloor[0] += r; sumFloor[1] += g; sumFloor[2] += b; sumFloor[3]++; }
          d.data[i + 3] = 0;
          continue;
        }
        const acc = row > floorRow + 4 ? sumFloor : row < floorRow - 10 ? sumWall : null;
        if (acc && (i / 4) % 7 === 0) { acc[0] += r; acc[1] += g; acc[2] += b; acc[3]++; }
      }
      ctx.putImageData(d, 0, 0);
      if (sumWall[3]) wallColor = new THREE.Color(`rgb(${sumWall[0] / sumWall[3] | 0},${sumWall[1] / sumWall[3] | 0},${sumWall[2] / sumWall[3] | 0})`);
      if (sumFloor[3] > 50) floorColor = new THREE.Color(`rgb(${sumFloor[0] / sumFloor[3] | 0},${sumFloor[1] / sumFloor[3] | 0},${sumFloor[2] / sumFloor[3] | 0})`);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const photo = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 }));
      photo.position.set(midX, midY, 0);
      this.scene.add(photo);
    }
    // A plain wall behind the photo, extending past its edges.
    const ceilH = s.ceilingY !== undefined ? (s.floorY - s.ceilingY) * IN : 2.6;
    this.scene.background = wallColor.clone().multiplyScalar(0.55);
    const backing = new THREE.Mesh(new THREE.PlaneGeometry(40, ceilH), new THREE.MeshBasicMaterial({ color: wallColor }));
    backing.position.set(midX, ceilH / 2, -0.002);
    this.scene.add(backing);
    // Frame shadows fall on this invisible layer just in front of the wall.
    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(40, ceilH), new THREE.ShadowMaterial({ opacity: 0.32, depthWrite: false }));
    shadowCatcher.renderOrder = 10;
    shadowCatcher.position.set(midX, ceilH / 2, 0.0005);
    shadowCatcher.receiveShadow = true;
    this.scene.add(shadowCatcher);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), new THREE.MeshLambertMaterial({ color: floorColor }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(midX, 0, 6);
    this.scene.add(floor);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ecebe7'), side: THREE.DoubleSide }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(midX, ceilH, 6);
    this.scene.add(ceil);
  }

  goTo(v: Vantage) {
    const t = this.target;
    const eye = 1.6;
    const pos: Record<Vantage, THREE.Vector3> = {
      front: new THREE.Vector3(0, eye, 2.8),
      left: new THREE.Vector3(-2.2, eye, 2.0),
      right: new THREE.Vector3(2.2, eye, 2.0),
      close: new THREE.Vector3(0, eye, 1.1),
      seated: new THREE.Vector3(0, 1.15, 2.6),
      far: new THREE.Vector3(-0.6, eye, 5),
    };
    this.controls.target.copy(t);
    this.anim = { from: this.camera.position.clone(), to: pos[v], t0: performance.now() };
  }

  snapshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((r) => this.renderer.domElement.toBlob(r, 'image/png'));
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        (mat as THREE.MeshStandardMaterial).map?.dispose();
        mat.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
