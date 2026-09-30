# Alcedo website — platform preview (prototype)

This is a website prototype for **Alcedo**, the proposed new brand direction for the restaurant operations platform currently called Atlas. It is **for review only**:

- not deployed and not linked from the application;
- marked `noindex`;
- the Atlas application, its authentication, database names and production branding are unchanged.

`index.html` contains all CSS and JavaScript inline, with no framework and no build step. Media are separate files in `assets/`.

## Preview

```bash
npx http-server prototypes/alcedo-website -p 8080     # open http://localhost:8080
```

Serve the folder over HTTP rather than opening `file://`. The video, thumbnails and fallbacks work either way, but background colour matching needs same-origin HTTP.

## Folder

```text
index.html                 the page
assets/hero.mp4            supplied hero footage (8.0 s, 1280×720, 24 fps, H.264)
assets/hero-final.webp     its last frame (8.00 s); hero-final.jpg is the same frame as JPEG
assets/brand/              ALCEDO Logo Kit v1.0 files, byte-identical copies
assets/ai-robot.png        the existing AI robot sprite (copy of apps/web/assets/atlas-bot/atlas-bot.png)
assets/screens/*.webp      product screenshots (current app, built-in test data)
```

## Changing things

Search `index.html` for the marker comments: `[ASSET: …]`, `[COPY]`, `[STATUS]`, `[DESTINATION]`, `[CROP]` and `[TIMING]`.

1. **Video source and static final frame**
   - **Video:** the `<source>` elements inside `#hero-video` are tried in order. The local `assets/hero.mp4` is first, and the reference URL `https://thinkingods.com/demos/kingfisher-hero/hero.mp4` is second. Reorder or replace them; a WebM source can be added above the MP4.
   - **Final frame:** `#hero-still` is shown for reduced motion, blocked autoplay, playback failure and no-JS. It is also the thumbnail source when the video can't be drawn. When the footage changes, export its last frame and replace `assets/hero-final.webp`. An empty `src` shows a labelled placeholder instead.
   - **Background matching:** with the local file served over HTTP, the pixel at (94 %, 12 %) of the first frame is read and sets `--bg` / `--ghost`. With the remote URL the readback is blocked cross-origin, and the CSS colours are kept.
2. **ALCEDO logo**
   - **Header:** `assets/brand/symbol-color.svg`. The kit has no horizontal lockup and advises the symbol alone below 180 px. The wrapper only trims the SVG's empty margins; the geometry is untouched.
   - **Footer:** `assets/brand/logo-dark.svg`, the reversed stacked lockup on its own deep-teal field.
   - **Favicons:** `favicon.ico`, `icon-32.png` and `icon-180.png`.
   - **To replace:** copy new kit files over these names. If a horizontal lockup arrives, swap the header `<img>` and remove the `.brand__crop` sizing.
3. **AI robot asset.** Set `--robot-sprite` in `:root`. It expects a 4-frame horizontal sprite: open · blink · sleep · happy, with frame 0 shown and frame 1 used for a subtle blink. The current sprite still shows the Atlas "A" mark on the robot.
4. **Copy and availability labels**
   - All copy is plain HTML.
   - Status chips use `.status` for available features, `.status--preview` for "Preview" and `.status--soon` for "Coming soon".
   - Screenshots carry a `.shot__label`: "Sample data", "Scripted demonstration · sample data", or "Sample lessons · pre-release build".
5. **Staff login and demo destinations**
   - Fill `DESTINATIONS` at the top of the script (`staffLogin`, `requestDemo`, `privacy`). Every link marked `data-dest` then points there.
   - While a value is empty, links go to the labelled "Prototype information" blocks on the page. Nothing is submitted, collected or stored.
   - No second authentication system is built; staff sign in to the existing application.
   - The repository documents `https://os-vabar.netlify.app` as the current app origin. Confirm it before using it as the staff login URL.
6. **Thumbnail crops**
   - Each hero card's canvas has `data-crop="centreX,centreY,size"`. The centre is given as fractions of the video's intrinsic width and height; size is the side of the square as a fraction of intrinsic height.
   - Current values: head `0.555,0.335,0.22`, wing `0.43,0.60,0.24`, and perch (feet on the twig) `0.50,0.79,0.24`.
   - Crops are drawn at device pixel ratio, only from the true final frame: after `ended`, after a confirmed seek to the end, or from the still.
7. **`REVEAL_AT`**
   - This is the landing timestamp in seconds, starting at `4.3`.
   - In the supplied clip there is a hard cut to the perched close-up at 4.00 s, and frame-to-frame motion drops sharply by about 4.3–4.4 s. So 4.3 s is the moment the bird reads as landed.
   - For another clip, scrub to the first frame where the bird is settled on the twig and set that time. The reveal follows, and the 9 s hard fallback (`FALLBACK_MS`) still guarantees the content appears.

## Behaviour summary

- **Reveal triggers.** Content appears on the landing time, video end, playback error, a rejected `play()`, the visitor pausing, the skip link, or the 9 s timeout. Replay cancels stale timers and starts a fresh one. If replay can't start, the content is restored at once.
- **Focus.** Hidden controls leave the tab order until the reveal. The play/pause/replay pill is always focusable, and replay moves focus to it if focus was inside content being hidden.
- **Reduced motion.** The final-frame still and all content show immediately, with no transitions or decorative animation. **Play** still works on request.
- **No JavaScript.** All content shows over the still. Product tour panels appear one after another, and the mobile menu becomes inline links.
- **Product tour.** An accessible tab list supports arrow keys, Home and End, and `#tour-<name>` links.

## Sources for claims

Product statements were checked against the application code:

- **Daily Operations** (Inventory, Purchasing, Recipes, Stock Count, Shifts, Reports): all exist in `apps/web`. Purchasing and Reports are for managers and administrators. Reports explicitly has no sales or point-of-sale connection.
- **AI assistant:** handles text, voice (transcribed notes and live conversation), and photos and files. It only uses read and draft tools; a person approves every change (`docs/ai/Atlas_AI_Tool_Registry.md`).
- **Food Intelligence** (Flavor Map): labelled **Preview**. `docs/flavor/Deployment.md` says the owner must approve it, and the repo does not confirm the live site has the UI.
- **Training:** labelled **Coming soon**. It is merged, but `docs/release/Atlas_Training_MVP.md` records that no production migration has been applied.
- **Knowledge:** the library exists in the current app.

No testimonials, customer counts, metrics, pricing or integrations are claimed.

## Screenshots and privacy

The screenshots show the real `apps/web` UI running in the repository's mocked backend (`tests/browser/harness.mjs`), with a frozen clock and no production traffic. Before capture, every fixture name that could be a real person, the venue name and Icelandic supplier names were replaced with made-up ones: "Alex Morgan", "Sam Rivera", "Harbor Bar", "Northwind Wines" and similar.

The visible text of every shot was then checked for the original names, emails and phone numbers; none remain. The training lessons are sample content written for the capture.

Staff schedules, messages, training results, manuals and business records stay behind sign-in. This public page only describes them.

## Open items before publication

- **Brand approval.**
  - The logo kit is a review edition. Its README asks for comparison with the concept reference before final geometry is approved.
  - A **horizontal lockup** is needed for the header.
  - The robot still carries the Atlas mark.
  - The giant ALCEDO word is decorative serif type, separate from the logo.
- **Domain.** `alcedo.is` is shown as the *intended* domain only; registration is not confirmed.
- **Destinations and privacy.** Staff login, demo/contact and privacy destinations need to be supplied.
- **Product sign-off.** Confirm the availability labels with product, especially Food Intelligence and Training.
