# igloo.inc — reversed

Static mirror of **https://www.igloo.inc** (the canonical host; `igloo.inc` answers `308` to `www.igloo.inc`),
saved into `sites/igloo.inc/` with the original URL paths preserved. Every file was pulled with `curl`
from the exact address the page requested, and every response was checked for HTTP 200 **and** a
non-HTML content type — an unknown path on this host returns the SPA shell (`text/html`), which is how a
wrong address is detected and rejected. Nothing in the tree is an HTML fallback; each file's magic bytes
match its extension (KTX2, OpenEXR, Draco, Ogg/Opus, WebAssembly, WOFF2).

Studied with **REA 6.9.0** (`rea analyze-javascript-application ./sites/igloo.inc --json`):
11 relevant files, 8 parsed JS sources,
385,441 AST nodes, 420 findings, 0 parse failures,
module graph of 380 nodes / 445 edges, plus the route inventory
(`/` → scene `home`, `/portfolio/:project` → scene `project`). Compact excerpt in `artifacts/rea-summary.json`.

## Shape of the site

A single WebGL2 canvas with **no DOM UI to speak of**: `index.html` has an empty `<body>` and no stylesheet
link at all. The HTML is a shell for meta tags; the interface — titles, labels, the manifesto, the
sound toggle, the project cards — is drawn inside the 3D scene as MSDF text meshes and shader-driven
quads on an orthographic camera. The router (Svelte-compiled, two routes) only emits events into the
WebGL layer.

Asset pipeline: geometry is Draco (`.drc`), textures are Basis/KTX2 supercompressed (`.ktx2`), the
environment probe is OpenEXR, audio is Ogg/Opus, and all decoding happens in four dedicated Web Workers
(`audioworker`, `bitmapworker`, `exrworker`, `msdfworker`) so the main thread never stalls decoding.

## How the 3D scene works

Everything derives from one base scene class that owns a camera, a `postprocessing` `EffectComposer`,
`beforeRenderCbs`, and `matrixWorldAutoUpdate = false` (matrices are updated by hand once per frame).
Three scenes are registered and stacked for the scroll:

| Scene key | Class | Height (scroll units) | Contents |
|---|---|---:|---|
| `entry` | `UF` | 5.5 | Intro: particle seed geometry, blurred 3D letterforms (flat + cylindrical), shattered/ice pieces, camera intro path |
| `igloo` | `F3` | 2.35 | Hero: `igloo.drc` + cage + outline + patch, `ground.drc`, `mountain.drc`, shard rings, manifesto text, numbers |
| `cubes` | `aF` | `Be.cubes.length` (2) | Portfolio cubes — one per project, carved out of `cubes/*` textures + `cubes_env.exr` |

Two more composers sit outside the scroll stack: an orthographic **UI scene** (holds the per-project
card panels and all HUD glyphs) and a **detail scene** for the opened project. Rendering is one shared
renderer; each scene gets its own composer with an LUT grade pass (`igloo_scene.ktx2` / `cube_scene.ktx2`,
sampled tetrahedrally) and a combined effects pass that reads `scroll-datatexture.ktx2` for its curves,
plus a depth-of-field pass built from `bokeh.ktx2` + `perlin-datatexture.png`.

Materials are hand-written shaders over these textures: caustics on the ice, `frost-datatexture` for
creep/crystallisation, `triangles_tiling` as a repeating surface motif, `wind_noise` for drifting snow,
`clouds_noise` for atmosphere, blue-noise dithering (`noises/blue-8-128-rgb`) to kill banding, and
`mosaic.ktx2` nearest-sampled for a pixelated reveal. The igloo can blow apart: a second albedo
(`igloo_exploded_color`) plus the shard rings and smoke geometry drive that state.

## How the camera works

Cameras are not free-floating. Each scene holds a rig of `basePosition`, `baseTarget`, `baseUp`, a
`displacement {position, target, rotation}` fed by the pointer, and `shake`. The base camera is
perspective (orthographic only for the UI scene); the igloo scene animates **fov 22 → 30** over 7.2 s
while pushing the camera from `z 0` to `-1.5` (3.5 s) and then `-3` (7.2 s), lifting the target
`y -9.83 → -10`, and rotating an "up" variant by π — then blends the whole intro pose into the
timeline pose with an `introWeight` value (`basePosition.lerpVectors(introPosition, timelinePosition,
introWeight)`). Pointer parallax is deliberately tiny (`displacement {x .01, y .005}`, `lerp .035`
per frame) so it reads as breathing rather than tracking. `lerpPosition/Target/Rotation` default to
`0.035` — every camera move is a damped follow, nothing snaps except `shake` releases.

## How the scroll works

There is **no native page scroll**: no `scroll` event listener exists and the body has no height.
Scrolling is virtual and infinite.

1. A wheel/touch singleton accumulates wheel deltas into `position`, derives `velocity`, adds it with
   a `0.1` gain, damps it by `0.97` per frame (normalised to 33 fps), clamps velocity to `±1`, zeroes it
   below `0.001`, and emits a single `wheel` event carrying position/delta/velocity.
2. The scene controller integrates that into `scroll.y`: wheel input → `targetY2` (`× scrollMultiplier
   0.00075`), `targetY1` follows with `lerp 0.075` (rate-limited), `scroll.y` follows with `lerp 0.15`.
   Two smoothing stages plus velocity is why the motion feels weighted.
3. Scenes are laid end to end: `total = Σ height` (5.5 + 2.35 + 2 = 9.85), and `scroll.y` is taken
   **modulo `total`** — so the sequence wraps and the site loops forever.
4. Each frame every scene gets `__top`/`__bottom`; a scene's `progress = (y - __top) / (height + 1)`,
   and it is only rendered when its band is on screen. There is an auto-centre/snap that settles the
   scroll onto scene boundaries, plus a `scrollBlocked` flag set by the router during transitions.
5. `progress` is the single source of truth: `timeline.progress(this.progress)` scrubs a GSAP timeline
   (camera path, fades, rotations, `startTime`/`progress` helpers all wired to it), it drives audio
   volumes, and it is uploaded into shaders as `uProgress` for the scroll-texture effects.
6. Project detail text has its own nested scroll (`scrollTargetY` per project, `lerp 0.1`, wheel
   `× scrollMultiplier`, arrow keys `±150`, touch drag), with the panel geometry moved in
   `group.position.y`.

## How the sounds work

A custom engine over the Web Audio API, not `<audio>`: one shared `AudioContext`, a `contextReady`
promise that resolves on the first user gesture (nothing plays before that), `preventSuspend`/
`preventResume` guards and visibility handling so background tabs do not break the mix.

`addAudio({name, url, volume, autoPlay, loop, playbackRate, offset, sync, syncOffset,
minTimeBetweenPlays})` decodes Ogg/Opus in `audioworker`, caches the `AudioBuffer`, and plays a fresh
`AudioBufferSourceNode` through a `GainNode`. Volume changes use `setTargetAtTime(value, now, 0.01)` —
a 10 ms exponential approach, so fades are click-free and continuous. Positional playback exists too
(`PannerNode` with a directional cone), and per-sound `minTimeBetweenPlays` acts as a rate limiter.

Beds (autoplay + loop, mixed by scroll progress) versus one-shots:

| Sound | File | Volume | Role |
|---|---|---:|---|
| music-bg | `music-highq.ogg` | 0.20 | music, always on |
| room-bg | `room.ogg` | 0.45 | cube-interior ambience |
| wind | `wind.ogg` | 0 → ramped | `fit(p,.05,.2,0,1) * fit(p,.75,.95,1,0) * 0.4` |
| igloo | `igloo.ogg` | 0 → ramped | hero ambience |
| shard | `shard.ogg` | 0 → ramped | break-up |
| portals | `circles.ogg` | 0 → ≤0.9 | proximity-eased (`power2.out`) |
| particles | `particles.ogg` | 0 → ramped | particle scenes |
| beeps / beeps2 / beeps3 | `beeps*.ogg` | 0.50 | `playBeep()` picks 1 of 3 at random, hard-throttled to 0.4 s |
| ui-short / ui-long | `ui-*.ogg` | 0.30 | interface ticks |
| logo / manifesto | `logo.ogg`, `manifesto.ogg` | 0.30 | hover / manifesto cues |
| click-project / enter / leave / project-text | — | 0.50 | project transitions |

Global mute and master volume travel on the event bus (`webgl_audio_mute_toggle`,
`webgl_audio_update_mute`, `webgl_audio_global_volume`, `webgl_set_audio_volume`), and the mute state
is persisted (it is re-applied through `contextReady` on load).

## Event bus (the whole app talks through it)

`webgl_play_audio`, `webgl_set_audio_volume`, `webgl_audio_global_volume`, `webgl_audio_mute_toggle`,
`webgl_audio_update_mute`, `webgl_switch_scene`, `webgl_router_request_switch_scene`,
`webgl_router_block_navigation`, `webgl_router_start`, `webgl_project_show`, `webgl_project_hide`,
`webgl_show_ui_intro`, `webgl_hover_logo`, `webgl_ui_particles_clicked`, `webgl_render`,
`webgl_render_active`, `webgl_prerender`, `webgl_postrender`, `webgl_average_fps_update`.

## Rebuilding notes (honest caveats)

* `App3D-d68cb154.js` is minified with mangled identifiers; class names used above are the ones
  recoverable from the registry (`ty = {igloo: F3, cubes: aF, entry: UF}`) and string evidence.
* The scene is WebGL2 + `THREE` internals bundled in, so a rebuild needs three.js of a similar era,
  the KTX2/Basis + Draco loaders, and a postprocessing stack with an LUT pass.
* Text is MSDF, not DOM — matching the typography pixel-for-pixel means reproducing the same atlas and
  shader, not importing a font.
* REA reported bounded alias-selection expansion (`semantic_precision.alias_selections=512`), so a few
  dynamic `window` property paths remain unresolved in its graph. That does not affect the inventory.
* **Licensing:** the code, models, textures, audio and copy are Igloo Inc.'s. This mirror is for study;
  shipping an "exact copy" would redistribute their copyrighted assets and their GSAP-standard-licensed
  runtime. Use it to understand the technique, then build with your own art and code.

## Complete file inventory

Path is relative to `sites/igloo.inc/`. 90 files, 13,902,770 bytes total.

| File | Bytes | What it is for |
|---|---:|---|
| `assets/App3D-d68cb154.js` | 1,486,303 | The whole application (1.49 MB, minified, 385k AST nodes): bundled three.js (WebGL2 renderer, KTX2/Basis loader, DRACOLoader, EXR loader, MSDF text, EffectComposer/passes), GSAP + ScrollTrigger, a small Svelte-compiled router and DOM layer, the audio engine, and every 3D scene class. App3D is imported on load, so nothing here is lazy except the 4 workers. |
| `assets/IBMPlexMono-Medium-1e253194.woff` | 57,556 | Web font, DOM side of IBM Plex Mono Medium (headings in the HTML/preloader layer). |
| `assets/IBMPlexMono-Medium-897c8c30.woff2` | 39,936 | Same font, WOFF2 (preferred). |
| `assets/IBMPlexMono-Regular-419d45f6.woff` | 56,500 | Web font, IBM Plex Mono Regular, DOM side (body copy). |
| `assets/IBMPlexMono-Regular-d3034935.woff2` | 39,068 | Same font, WOFF2 (preferred). |
| `assets/audio/beeps.ogg` | 9,765 | One-shot blip, volume 0.5, throttled to 0.4 s (random pick 1 of 3 with beeps2/beeps3). |
| `assets/audio/beeps2.ogg` | 10,254 | One-shot blip variant 2 (same throttle/volume). |
| `assets/audio/beeps3.ogg` | 10,117 | One-shot blip variant 3 (same throttle/volume). |
| `assets/audio/circles.ogg` | 28,454 | Registered as 'portals': volume 0, autoplay, loop. Volume comes from portal proximity (eased power2.out, up to 0.9). |
| `assets/audio/click-project.ogg` | 6,753 | One-shot: project cube click. |
| `assets/audio/enter-project.ogg` | 21,582 | One-shot: entering a project (cube -> interior). |
| `assets/audio/igloo.ogg` | 62,478 | Igloo ambience bed: volume 0, autoplay, loop. Volume is ramped by scene progress, not fixed. |
| `assets/audio/leave-project.ogg` | 11,909 | One-shot: leaving a project. |
| `assets/audio/logo.ogg` | 4,855 | One-shot: logo hover/interaction cue, volume 0.3. |
| `assets/audio/manifesto.ogg` | 6,163 | One-shot tied to the manifesto block, volume 0.3. |
| `assets/audio/music-highq.ogg` | 1,527,578 | Main background music bed. addAudio: volume 0.2, autoplay, loop, stereo. The longest asset on the site (1.5 MB). |
| `assets/audio/particles.ogg` | 16,799 | Particle layer: volume 0, autoplay, loop, tied to particle scenes. |
| `assets/audio/project-text.ogg` | 11,037 | One-shot accompanying project text reveal, volume 0.5. |
| `assets/audio/room.ogg` | 609,688 | Interior room ambience bed: volume 0.45, autoplay, loop (plays inside the project cube / detail space). |
| `assets/audio/shard.ogg` | 21,753 | Shard / ice loop: volume 0, autoplay, loop, ramped during the igloo blow-up. |
| `assets/audio/ui-long.ogg` | 4,453 | UI cue, longer variant, volume 0.3. |
| `assets/audio/ui-short.ogg` | 3,021 | UI cue, short variant, volume 0.3. |
| `assets/audio/wind.ogg` | 572,916 | Wind loop: volume 0, autoplay, loop. Scroll-driven: volume = fit(progress,.05,.2,0,1) * fit(progress,.75,.95,1,0) * 0.4, i.e. fades in crossing 5-20% and out across 75-95%. |
| `assets/audioworker-036a09db.js` | 116,311 | Audio decode worker (116 KB). Decodes the Ogg/Opus files off the main thread and posts back decoded PCM, which is wrapped into Web Audio AudioBuffers ('audio <name> load error' string lives here). |
| `assets/bitmapworker-046527f8.js` | 2,948 | Tiny worker (2.9 KB) that rasterises pixel data for bitmap textures without blocking the render loop. |
| `assets/exrworker-41cbee65.js` | 83,463 | OpenEXR decode worker (83 KB) for cubes_env.exr (environment reflections / lighting probe). |
| `assets/favicon16-9e4401be.png` | 513 | 16x16 favicon. |
| `assets/favicon32-af94112f.png` | 1,245 | 32x32 favicon. |
| `assets/fonts/IBMPlexMono-Medium-datatexture.ktx2` | 110,330 | 512x1024 MSDF glyph atlas for IBM Plex Mono Medium. Loaded as a plain 'data' texture; the MSDF text meshes (titles, labels, manifesto) sample it in a shader so text stays crisp at any zoom. |
| `assets/geometries/blurrytext.drc` | 1,187 | Blurred 3D letterforms used as background shapes. |
| `assets/geometries/blurrytext_cylinder.drc` | 5,571 | The same text wrapped on a cylinder for the curved background band. |
| `assets/geometries/ceilingsmoke.drc` | 13,717 | Ceiling smoke slab in the cube interior. |
| `assets/geometries/cubes/background_shapes.drc` | 669 | Background shapes inside the portfolio cube. |
| `assets/geometries/floor.drc` | 40,738 | Cube-interior floor mesh. |
| `assets/geometries/ground.drc` | 18,861 | Ground plane/terrain mesh. |
| `assets/geometries/igloo.drc` | 222,834 | The igloo itself (223 KB Draco): the hero mesh, instanced/explodable into blocks. |
| `assets/geometries/igloo/igloo_cage.drc` | 5,732 | Wireframe cage over the igloo (structural outline shell). |
| `assets/geometries/igloo/igloo_outline.drc` | 20,334 | Outline shell for the igloo silhouette effect. |
| `assets/geometries/igloo/patch.drc` | 240 | Small patch/plaque mesh on the igloo surface. |
| `assets/geometries/intro_particles.drc` | 2,069 | Particle seed geometry for the intro (points baked as a mesh). |
| `assets/geometries/mountain.drc` | 11,846 | Mountain range mesh behind the igloo. |
| `assets/geometries/shattered_ring.drc` | 40,703 | Shattered ring of ice shards around the ground imprint. |
| `assets/geometries/shattered_ring2.drc` | 43,550 | Second shard ring variant (different break pattern). |
| `assets/geometries/shattered_ring_smoke.drc` | 10,263 | Smoke/puff geometry emitted from the shard ring. |
| `assets/geometries/smoke_trail.drc` | 4,126 | Smoke trail geometry for the shard/particle motion. |
| `assets/images/bokeh.ktx2` | 21,582 | 512x512 bokeh kernel ('srgb-repeat') used by the depth-of-field pass (uniform tBokeh alongside perlin-datatexture.png). |
| `assets/images/caustics.ktx2` | 2,419 | 64x64 repeating caustics map for light patterns on ice/snow. |
| `assets/images/clouds_noise.ktx2` | 25,373 | 256x256 noise for cloud/atmosphere layers. |
| `assets/images/cubes/advect.png` | 27,467 | 128x128 advection texture for the cube interior's fluid/smoke effect. |
| `assets/images/cubes/bg.png` | 1,803 | 4x4 PNG background tint for the cube interior. |
| `assets/images/cubes/blurrytext_atlas.ktx2` | 7,781 | 256x256 blurred-text atlas used for the frosted text behind the cube interior. |
| `assets/images/cubes/cube_scene.ktx2` | 41,384 | 32x32x32 3D LUT ('luttetrahedral') for the portfolio cube scene. |
| `assets/images/cubes/dot_pattern.ktx2` | 725 | 64x64 dot pattern overlay for the interior panels. |
| `assets/images/cubes_env.exr` | 259,130 | OpenEXR environment probe (259 KB) for image-based lighting inside the portfolio cubes. |
| `assets/images/floor_color.ktx2` | 629,652 | 2048x2048 floor albedo for the cube interior. |
| `assets/images/frost-datatexture.ktx2` | 134,781 | Frost/ice data texture ('colordata-repeat') driving ice creep and crystalline distortion. |
| `assets/images/igloo/ground_color.ktx2` | 625,325 | 2048x2048 ground albedo. |
| `assets/images/igloo/ground_glow.ktx2` | 213,732 | 1024x1024 glow/emissive mask for the ground (snow glow around the igloo). |
| `assets/images/igloo/ground_sansigloo_color.ktx2` | 628,793 | Ground albedo variant for the shot without the igloo (the ring imprint). |
| `assets/images/igloo/igloo_color.ktx2` | 533,374 | 2048x2048 albedo for the igloo mesh. |
| `assets/images/igloo/igloo_exploded_color.ktx2` | 842,242 | Albedo variant used for the exploded/blown-apart igloo state. |
| `assets/images/igloo/igloo_scene.ktx2` | 14,484 | 32x32x32 3D LUT loaded with the 'luttetrahedral' mode: the colour grade applied to the igloo scene. |
| `assets/images/igloo/mountain_color.ktx2` | 591,988 | Mountain range albedo. |
| `assets/images/igloo/numbers.ktx2` | 4,862 | 32x1024 srgb atlas of digits/glyphs used for the counter/number overlays. |
| `assets/images/igloo/triangles_tiling.ktx2` | 47,616 | 512x512 tiling triangle pattern (repeating detail/wireframe motif on surfaces). |
| `assets/images/mosaic.ktx2` | 1,089 | 32x32 nearest-sampled mosaic pattern (pixelated reveal/mask). |
| `assets/images/noises/blue-8-128-rgb.ktx2` | 50,420 | 128x128 blue-noise texture ('data-repeat') whose offset is animated by uBlueOffset for dithering/grain. |
| `assets/images/numbers-datatexture.ktx2` | 13,540 | 280x36 data texture describing number layout/metrics for the counters. |
| `assets/images/perlin-datatexture.ktx2` | 3,789 | Same noise as KTX2, used in both data and srgb modes by other shaders. |
| `assets/images/perlin-datatexture.png` | 3,500 | 64x64 PNG perlin noise, the DOF pass's tMap (blur/CoC modulation). |
| `assets/images/scroll-datatexture.ktx2` | 1,286,436 | 1 MB 1024x1024 data texture sampled as uProgress/'tScroll' in several shaders (registered as 'colordata-repeat', 'data-repeat' and 'datatexture-repeat'). It is the lookup table that turns scroll progress into animation curves, so easing/latency lives in the texture instead of JS. |
| `assets/images/shapes_blurred.ktx2` | 38,936 | 512x1024 soft blurred shapes, background bokeh/defocused geometry. |
| `assets/images/social.jpg` | 88,021 | Open Graph / Twitter card image (1200x630-ish JPEG) referenced by the meta tags. |
| `assets/images/ui/arrow-datatexture.ktx2` | 1,574 | 64x64 data texture for the arrow glyph (scroll hint / links). |
| `assets/images/ui/close-datatexture.ktx2` | 826 | 64x64 data texture for the close (X) glyph. |
| `assets/images/ui/logo-datatexture.ktx2` | 2,130 | 128x128 MSDF/mask data texture for the Igloo logo mesh (ui/logo-datatexture). |
| `assets/images/ui/sound-datatexture.ktx2` | 4,405 | 64x128 data texture for the speaker/mute icon; its two halves are the on/off states. |
| `assets/images/ui/visit-datatexture.ktx2` | 844 | 100x32 data texture for the 'VISIT' label glyphs. |
| `assets/images/uv/uvchecker-srgb.ktx2` | 298,298 | 2048x2048 UV checker (KTX2): development/debug UV grid, also used for the surface warp verification. |
| `assets/images/uv/uvchecker-srgb.png` | 434,117 | PNG copy of the same UV checker, used where a raw bitmap rather than a transcoded texture is needed. |
| `assets/images/wind_noise.ktx2` | 18,158 | 256x256 noise driving wind streaks/snow drift. |
| `assets/index-2e130bc1.js` | 16,546 | Vite entry chunk (16 KB). Modulepreload polyfill + bootstrap; its only import is ./App3D-d68cb154.js. Also where the 4 WOFF/WOFF2 font URLs are declared. |
| `assets/libs/basis/basis_transcoder.js` | 67,059 | Basis Universal transcoder glue, set as the KTX2Loader transcoder path (/assets/libs/basis/). Every .ktx2 texture goes through it. |
| `assets/libs/basis/basis_transcoder.wasm` | 472,914 | Basis transcoder binary (473 KB): decompresses the Zstandard-supercompressed KTX2 mips into GPU formats. |
| `assets/libs/draco/draco_decoder.js` | 720,148 | Google Draco decoder runtime, wired as the DRACOLoader decoder at /assets/libs/draco/ (all .drc geometry). |
| `assets/libs/draco/draco_decoder.wasm` | 285,948 | The Draco decompressor itself (286 KB), fetched by draco_decoder.js. |
| `assets/libs/draco/draco_wasm_wrapper.js` | 58,763 | Emscripten wrapper glue that binds draco_decoder.wasm to JavaScript. |
| `assets/msdfworker-ac346fa7.js` | 3,175 | MSDF (multi-channel signed distance field) text worker (3.1 KB): lays out glyphs into the IBMPlexMono atlas used for 3D text. |
| `index.html` | 1,410 | The entire HTML shell: 1.4 KB, empty <body>, one module script. Meta/OG tags (title 'Igloo Inc.', description, twitter card, og:image), two PNG favicons, and <script type=module src=/assets/index-2e130bc1.js>. No CSS file is linked anywhere; all styling ships inside the JS. |
| `robots.txt` | 23 | Crawler policy served at /robots.txt. |

---

**File count: 90 files** (13,902,770 bytes) under `sites/igloo.inc/`, plus this report.
