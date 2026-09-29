// All physical measurements are stored in inches. Display units are a preference.

export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL in source-image pixels

export type OpeningShape = 'rect' | 'oval';
export type FrameShape = 'rectangular' | 'circular/oval' | 'irregular';
export type SizeGroup = 'S' | 'M' | 'L' | 'XL';

export interface Opening {
  id: string;
  /** Top-left position and size, inches, relative to the frame's top-left outer corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: OpeningShape;
}

export interface FrameTags {
  shape: FrameShape;
  color: string; // named colour family, e.g. "gold", "black"
  colorHex: string; // representative swatch
  matted: boolean;
  size: SizeGroup;
  custom: string[];
}

/** Straighten settings kept so the item can be re-edited later. */
export interface StraightenState {
  sourceBlobId: string; // downscaled original photo
  quad: Quad;
  /** Extra fine rotation in degrees applied after straightening. */
  fineRotation: number;
}

export interface Frame {
  id: string;
  name: string;
  createdAt: number;
  qty: number;
  widthIn: number;
  heightIn: number;
  /** How far the frame stands off the wall (for 3D and AR). Defaults to 1". */
  depthIn?: number;
  /** Straightened image of the frame. Covers [-padX, W+padX] x [-padY, H+padY] inches. */
  imageBlobId: string;
  padX: number;
  padY: number;
  /** Cut-out outline polygon in inches relative to the frame's top-left. */
  outline: Pt[];
  openings: Opening[];
  tags: FrameTags;
  straighten?: StraightenState;
  notes?: string;
}

export interface PictureTags {
  orientation: 'portrait' | 'landscape' | 'square';
  color: string;
  colorHex: string;
  custom: string[];
}

export interface Picture {
  id: string;
  name: string;
  createdAt: number;
  imageBlobId: string;
  /** width / height of the stored image */
  aspect: number;
  /** Optional physical print size. */
  printW?: number;
  printH?: number;
  tags: PictureTags;
  straighten?: StraightenState;
}

export interface OpeningFill {
  pictureId: string;
  /** Zoom relative to "cover" fit (1 = just covers the opening). */
  scale: number;
  /** Offset of the picture centre from the opening centre, as a fraction of opening w/h. */
  ox: number;
  oy: number;
  /** Rotation of the picture inside the opening: 0/90/180/270 plus fine degrees. */
  rot: number;
}

export interface PlacedItem {
  id: string;
  frameId: string;
  /** Centre of the frame on the wall, inches in wall coordinates. */
  x: number;
  y: number;
  rotation: number; // degrees
  fills: Record<string, OpeningFill>; // keyed by opening id
  locked?: boolean;
}

export interface Layout {
  id: string;
  name: string;
  items: PlacedItem[];
  updatedAt: number;
}

export interface Zone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Keep frames out of this area. */
  noHang: boolean;
  /** Leave this area unpainted when previewing a wall colour. */
  noPaint: boolean;
}

export interface PaintStroke {
  mode: 'add' | 'erase';
  /** Brush radius as a fraction of the source photo's width. */
  r: number;
  /** Points normalised to the source photo (0..1 of width / height). */
  pts: Pt[];
}

export interface WallPaint {
  hex: string;
  name: string;
  strength: number; // 0..1
  tolerance: number; // 0..1 mask similarity
  /** Extra "tap to fill" seed points, normalised to the source photo. */
  taps?: Pt[];
  /** Manual brush / eraser touch-ups, applied after automatic detection. */
  strokes?: PaintStroke[];
}

export interface Wall {
  sourceBlobId: string;
  quad: Quad;
  refW: number; // inches, width of the pinned rectangle
  refH: number;
  bottomAboveFloor: number; // inches from the floor to the bottom edge of the pinned rectangle
  /** Floor-to-ceiling height, if known. Keeps wall paint off the ceiling. */
  ceilingHeight?: number;
  imageBlobId: string; // straightened wall image
  /** Extent of the straightened image in wall inches (origin = pinned rectangle's top-left). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  paint?: WallPaint;
  /** Painted version of the straightened image. */
  paintedBlobId?: string;
  /** Painted version of the original photo. */
  paintedSrcBlobId?: string;
}

export interface ProjectSettings {
  eyeLevel: number; // inches above floor
  showEyeLevel: boolean;
  gap: number; // preferred spacing between frames
  snap: boolean;
  showZones: boolean;
  showPaint: boolean;
  /** 'photo': work on the photo as taken (frames follow its perspective). 'straight': squared-up wall. */
  viewMode?: 'photo' | 'straight';
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  wall?: Wall;
  zones: Zone[];
  layouts: Layout[];
  activeLayoutId: string;
  settings: ProjectSettings;
  thumbBlobId?: string;
}

export type Units = 'in' | 'cm';

export interface Prefs {
  units: Units;
  reduceTransparency: boolean;
}
