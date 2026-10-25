# blue hour

pov: it's blue hour in eastern europe. A small walkable night scene built with Next.js, three.js and GSAP.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000, click to wander.

## Music

Put your copy of the track at `public/audio/snowfall.mp3`. It fades in on click and loops. If the file is missing the scene still runs with wind and footsteps only.

## Controls

- WASD / arrows: walk (physical keys, so ZQSD on AZERTY)
- Shift: walk faster
- M: mute music
- B: switch between the generated panel blocks and the downloaded building models
- Esc: pause

## Debug views

`/?cam=x,y,z,yaw,pitch` skips the intro and drops the camera at a fixed spot, e.g. `/?cam=60,1.68,45,2.3,0.02` for the park lamp. Add `&fog=0` to turn the volumetric fog off.

## Models

The originals you downloaded stay in `public/models/`. The app loads compressed copies from `public/models/opt/` (meshopt geometry, WebP textures), made with `gltf-transform optimize`.

## Layout

- `lib/world/city.ts`: procedural street, panel blocks, lamps, cars, kiosks, trees, park path
- `lib/world/textures.ts`: canvas-generated facades, snow, tire tracks
- `lib/world/fog.ts`: raymarched volumetric fog with lamp light scattering, and the final composite
- `lib/world/snow.ts`: snowfall (sharp flakes + out-of-focus near flakes), sky
- `lib/world/materials.ts`: snow coat on upward faces and snow glints, usable on any material
- `lib/world/noise.ts`: ground height (drifts, road berms, trodden trail), also used for walking
- `lib/world/models.ts`, `lib/world/modelProps.ts`: glTF loading, baking into instanced meshes, snow coat and window lights on models
- `lib/world/interiors.ts`: interior mapping, fake rooms ray-traced behind each window pane
- `lib/world/cinematic.ts`: auto-focus depth of field and camera motion blur
- `lib/world/post.ts`: bloom, grade, grain, SMAA
- `lib/world/player.ts`: pointer-lock walking, head bob, collisions
- `lib/world/audio.ts`: music fade, procedural wind and snow crunch
