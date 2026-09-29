# Gallery Wall

Mock up a gallery wall on your iPad before putting a single nail in the wall.

1. **Photograph your wall** and pin a rectangle you've measured. Work on the photo **as taken** (frames follow its perspective and shrink as they move away from the camera) or on a **straightened** wall, and switch any time.
2. **Photograph your frames** on the floor and enter their outside size. Each frame is cut out automatically (irregular and ornate edges included), its openings are detected (including multi-opening mats), and it's tagged by shape, color, matting and size.
3. **Arrange**: drag frames from your inventory onto the wall, snap to edges, equal gaps, wall center and the eye-level line, rotate, lock, align and distribute, undo/redo.
4. **Swap pictures** into any opening from your picture inventory, with suggestions ranked by how well they fit.
5. **Autofill** suggests where leftover frames could go, or builds complete Salon / Grid / Symmetric / Single-row arrangements, which you can save as separate layouts to compare.
6. **Preview wall colors** (a curated Sherwin-Williams palette or any custom color). The whole wall is detected automatically and kept off the ceiling, with a live highlight, a sensitivity slider and brush/eraser/tap-fill touch-ups. The recolor keeps the photo's real light and shadows.
7. **More viewpoints**: add 2–4 photos of the same wall from elsewhere in the room, match 4+ reference points (outlet, smoke detector, corners…), and flip between perspectives, including arranging from any of them.
8. **3D walk-around** of the wall with real frame depth and shadows, plus **View in AR** (AR Quick Look) to see the arrangement at true size on the real wall with an iPhone or iPad. The AR file can be AirDropped to any iPhone.
9. **Export** an image of the finished wall via the iPad share sheet.

Everything runs and is stored on the device (IndexedDB). No accounts, no uploads. Use *Settings → Export backup* to save a `.zip` to Files or iCloud Drive, and *Import backup* to restore it on another device.

## Using it on iPad

Open the hosted URL in Safari, tap **Share → Add to Home Screen**. It then launches full-screen like a native app, works offline, and keeps its storage.

Hosting needs HTTPS (camera access and offline support require it). Any static host works, because the build uses relative paths:

- **GitHub Pages**: included workflow deploys `main`. Enable it under *Settings → Pages → Source: GitHub Actions*. Pages on a **private** repo needs a paid GitHub plan; otherwise make the repo public or use one of the options below.
- **Netlify / Cloudflare Pages / Vercel** (free): connect the repo, build command `npm run build`, output directory `dist`.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (use --host to open it from an iPad on the same Wi-Fi)
npm test           # unit tests (units, geometry, snapping, autofill)
npm run build      # type-check + production build into dist/
```

`dev/e2e.mjs` drives the whole app in headless Chromium at iPad size (frames → pictures → wall → arrange → autofill → paint → export → reload). It expects sample photos in `dev/samples/` (git-ignored): `3.jpg` wall, `4.jpg` and `5.jpg` frames.

### How the tricky parts work

- **Straightening** (`src/lib/imaging.ts`): a homography from the four pinned corners to real-world inches, inverse-mapped with bilinear sampling.
- **Frame cut-out** (`src/lib/detect.ts`): a simplified GrabCut. Background colors are learnt from the photo border and foreground from the center, refined over a few rounds, then cleaned up with morphology, hole filling and contour tracing, and simplified into an editable polygon.
- **Openings**: finds the mat (a large, uniform, light color), then projects non-mat pixels onto rows and columns to find the grid of windows. Frames without a mat get their opening from where the molding color ends.
- **Wall recolor** (`src/lib/recolor.ts`): a pixel is roughly *paint × light*, so dividing by the old paint color (in linear light) recovers the lighting, including warm or cool tints, and multiplying by the new color repaints it. The wall mask is flood-filled across the whole photo from the pinned area, allowing gradual color drift from mixed lighting, stopping at edges (trim, outlets, fixtures), and clipped to the wall plane between floor and ceiling.
- **Perspective** (`src/lib/projection.ts`): every view is a homography from wall inches to image pixels (a plain scale when straightened, the photo's perspective otherwise). Frames are laid out flat and projected with a CSS `matrix3d`; export does the same warp on a canvas.
- **Extra viewpoints** (`src/screens/VantageEditor.tsx`): a least-squares homography (`homographyLSQ`) from the matched points. Paint touch-ups live on the wall plane, so they map into every viewpoint.
- **3D / AR** (`src/lib/scene3d.ts`, loaded on demand): frame outlines are extruded to their depth with a baked face texture; USDZ export uses vertical plane anchoring for AR Quick Look.
- **Autofill** (`src/lib/arrange.ts`): greedy growth that scores candidate spots next to existing frames by centering, compactness, overall shape and edge alignment, plus template generators for grid, symmetric and single-row layouts.
