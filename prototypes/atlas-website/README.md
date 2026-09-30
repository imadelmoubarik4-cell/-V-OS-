# Atlas website — platform preview (prototype)

`index.html` is a single, self-contained page (all CSS and JavaScript inline, no framework, no
build step). It is a **prototype for review**: it is not linked from the Atlas app, not deployed,
and carries `noindex`. Commercial details, destinations and feature availability are unapproved.

Preview locally from the repository root:

```bash
npx http-server prototypes/atlas-website -p 8080    # then open http://localhost:8080
```

Opening the file directly (`file://`) also works.

The design follows the KINGFISHER reference's hero choreography. The brand, copy and content are Atlas.

## Replacing assets and copy

Every editable spot in `index.html` carries a marker comment: search for `[ASSET: …]`, `[COPY]`,
`[DESTINATION]`, `[CROP]` or `[TIMING]`.

| # | What | Where | How |
|---|------|-------|-----|
| 1 | **Video URL** | `[ASSET: VIDEO]`, the `<source>` inside `#hero-video` | Change `src`. The clip plays once, never loops, and holds its last frame. It plays without CORS. Only the optional background colour sampling needs same-origin or CORS footage (see the notes below). |
| 2 | **Static final-frame image** | `[ASSET: FINAL FRAME]`, `#hero-still` | It is currently the last frame (8.00 s) of the supplied `hero.mp4`, embedded as WebP. Replace `src` with a file path when the footage changes. `src=""` shows the labelled placeholder instead. The page uses it for reduced motion, blocked autoplay, video failure, no-JS, and as the thumbnail source when the video can't be drawn. |
| 3 | **Official Atlas logo** | `[ASSET: LOGO]`, the header and footer `<img>` | These are byte-identical embeds of the brand kit's `Atlas_Primary_Horizontal_Midnight.svg` (header, on sage) and `…_White.svg` (footer, on dark). To use files instead, point `src` at `../../apps/web/assets/brand/…`. Never redraw or retype the lockup. |
| 4 | **Atlas AI robot** | `[ASSET: ROBOT]`, `--robot-sprite` in `:root` | This is the product's `apps/web/assets/atlas-bot/atlas-bot.png`: a 4-frame sprite (open · blink · sleep · happy), with frame 0 shown and a subtle blink. Replace the `url(…)` to swap it. |
| 5 | **Copy and feature labels** | `[COPY]` blocks | The hero, cards, bento, capability band, CTA and footer are plain HTML text. Availability chips read "Preview — availability to be confirmed". Unverified descriptions carry "Copy placeholder — verify before publication". Remove those only after product sign-off. |
| 6 | **Staff login and demo destinations** | `[DESTINATION]` | For now, `#staff-login`, `#request-demo` and `#privacy` are labelled placeholder blocks on the page. There is no form, and nothing is sent or stored. When real URLs exist, replace every `href="#staff-login"` / `href="#request-demo"` (header, mobile menu, hero, CTA, footer) and delete the placeholder blocks. |
| 7 | **Thumbnail crops** | `[CROP]`, `data-crop` on the three hero-card canvases | The format is `centreX,centreY,size`. `centreX` and `centreY` are fractions of the video's intrinsic width and height. `size` is the side of the square crop as a fraction of intrinsic height. Current values: head `0.555,0.335,0.22`, wing `0.43,0.60,0.24`, perch (feet on the twig) `0.50,0.79,0.24`. Crops are drawn at device pixel ratio, and only from the true final frame. |
| 8 | **Landing timestamp** | `[TIMING]`, `const REVEAL_AT = 4.3` | This is when the UI reveals, in seconds. It was checked against the supplied clip: 8.0 s, 1280×720, 24 fps, with a hard cut to the perched close-up at 4.00 s and the bird settled by about 4.3 s. **If you swap in a clip that lands earlier or later, change this number and the reveal moves with it.** A 9-second hard fallback (`FALLBACK_MS`) always shows the content. |

## Behaviour notes

- **Reveal triggers.** Content appears on whichever comes first: the landing timestamp, video end, video error, a rejected `play()`, the visitor pausing, the skip link, or the 9 s timeout. Replay cancels any stale timer and starts a new one.
- **Focus while hidden.** Hidden controls are taken out of the tab order until the reveal. The play/pause/replay pill is never hidden, and replay moves focus to it if focus was inside the content being hidden.
- **Reduced motion.** Content and the final-frame still show immediately, with no transitions or decorative animation. The visitor can still press **Play**.
- **No JavaScript.** Everything is visible over the final-frame still, and the mobile menu becomes inline links.
- **Background matching.** On `loadeddata` the script samples the pixel at (94 %, 12 %) and sets `--bg` and `--ghost`, the ghost being each channel × 0.955. With the current cross-origin URL, the browser blocks the readback, so the page keeps the CSS colours. They match closely: the sampled footage background is `#B5C1AF`, against `#B6C3B0`. To enable matching, self-host the clip or serve it with CORS and add `crossorigin="anonymous"`. Only add that attribute if CORS is actually enabled, or the video will fail to load.
- **Ghost word.** It is checked against the footage at 1920, 1440, 1280, 1024 and 390 px wide. The darker head and beak read as sitting in front of the lettering. The white cheek patch and orange breast sit below the masked part of the word, so no bad light-on-letter overlap was seen at these sizes. It is decorative text, not the logo.
- **Layouts.**
  - *Wide* (≥ 1200 px and aspect ≥ 3:2): copy on the left, cards in the lower right, clear of the bird.
  - *Mid* (other widths above 900 px): the video is anchored left so the bird sits right, and the cards move below the fold.
  - *≤ 900 px*: the bird takes the top 46 svh (at least 280 px), with copy and cards stacked below.

## Replacement-footage prompt

> Photorealistic kingfisher flying into frame from the left and landing naturally on a delicate twig, against a perfectly flat sage-green studio backdrop matching #B6C3B0. Locked camera, wide composition, realistic feathers and wing motion, soft directional lighting, no text, no logos, no camera movement. Bird lands at approximately 4.3 seconds and remains perched and nearly still for the remainder of the clip. Keep the left side clear for website copy and position the perched bird around the centre-right. The final frame must be clean and suitable as a static website hero. 16:9, high resolution.

## Before publication

- **Brand review.** The Atlas brand kit forbids typing "ATLAS" in a substitute font *as a logo*. The giant word is decorative typography, kept separate from the official lockup, but brand should confirm it is acceptable. The page also uses the requested sage, green and orange palette rather than the product's Midnight and Atlas Blue.
- **Product copy.** Confirm all feature copy (Food Intelligence especially) and availability labels with product.
- **Video hosting.** Host the video on an approved domain, add a WebM source if wanted, and supply the real destinations.
