# Gallery Wall

Mock up a gallery wall on your iPad before putting a single nail in the wall.

1. **Photograph your wall** and pin a rectangle you've measured. The photo is straightened so every inch on screen is a real inch.
2. **Photograph your frames** on the floor and enter their outside size. Each frame is cut out automatically (irregular and ornate edges included), its openings are detected (including multi-opening mats), and it's tagged by shape, color, matting and size.
3. **Arrange**: drag frames from your inventory onto the wall, snap to edges, equal gaps, wall center and the eye-level line, rotate, lock, align and distribute, undo/redo.
4. **Swap pictures** into any opening from your picture inventory, with suggestions ranked by how well they fit.
5. **Autofill** suggests where leftover frames could go, or builds complete Salon / Grid / Symmetric / Single-row arrangements, which you can save as separate layouts to compare.
6. **Preview wall colors** (a curated Sherwin-Williams palette or any custom color). The recolor keeps the photo's real light and shadows.
7. **Export** an image of the finished wall via the iPad share sheet.

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
- **Wall recolor** (`src/lib/recolor.ts`): a pixel is roughly *paint × light*, so dividing by the old paint color (in linear light) recovers the lighting, including warm or cool tints, and multiplying by the new color repaints it. The wall mask is flood-filled from the pinned area and stops at trim, outlets and fixtures.
- **Autofill** (`src/lib/arrange.ts`): greedy growth that scores candidate spots next to existing frames by centering, compactness, overall shape and edge alignment, plus template generators for grid, symmetric and single-row layouts.
