# ALCEDO icons

`apps/web/assets/js/alcedo-icons.js` is the app's one icon set. It replaced
lucide@0.454.0 from unpkg in the October 2026 redesign ("Basalt & Kingfisher",
`docs/design/Alcedo_Redesign_2026.md`). It is self-hosted, synchronous and has
no network access: every path is inlined.

## Language

- Geometry: Phosphor Icons 2.1.1, **Regular** weight (MIT, `LICENSE-phosphor.txt`).
  Its even 16-unit stroke on a 256 grid, round caps and joins and soft 16-unit
  outer corners sit well beside IBM Plex Sans and read as one family at 16-24 px.
- Glyphs are filled paths painted in `currentColor`, `viewBox="0 0 256 256"`.
  Size an icon with width/height (`--icon-sm/md/lg/xl`), colour it with `color`.
  There is no stroke to set: `stroke-width` rules do nothing to these icons.
- Markup is unchanged: `<i data-lucide="name" aria-hidden="true"></i>` plus a
  `lucide.createIcons()` call. The rendered `<svg>` keeps the classes
  `lucide lucide-<name>`, adds `alcedo-icon`, and copies the placeholder's own
  attributes. `AlcedoIcons.svg(name, { size, className, label })` returns the
  same icon as a string for template code; `lucide.icons.<PascalName>` still
  serves lucide-shaped nodes for helpers that build their own `<svg>`.
- Unknown names draw a dashed circle and warn once in the console.
  `tests/node/alcedo-icons.test.js` fails if any name used in `apps/web` has
  no glyph.

## Custom glyphs

Drawn as 16-unit round-capped centre lines on the 256 grid, stroked to outlines
with skia-pathops and merged with the Phosphor base, so they carry the same
weight and corner treatment. Badges sit in the lower-right corner, centred on
(192,192), with a 16-unit knockout gap.

| Glyph | Construction |
| --- | --- |
| kingfisher (`alcedo`, `atlas-bot`) | The Alcedo AI mark. Crown and breast as one line `M180,92A60,60 0 1,0 176,140Q172,196 104,212L40,224Q80,188 72,140`, a filled dagger bill `M170,80L246,112Q250,115 246,118L176,130Z`, eye r12 at (130,96); drawn at 1/1.12 and scaled x1.12, translated (-28,-24). |
| receipt-tall (`receipt-text`) | Upright slip 64-200 x 32-224, 8-unit centre-line corner radius, three teeth (24 wide, 20 deep), lines at y 80/120 (to x160) and 160 (to x136). Phosphor's receipt lies flat and reads as a chat bubble at 16 px. |
| user-x | Phosphor user-minus with its bar redrawn as an x (+-20). |
| book-x, package-x | Phosphor book / package + x badge `M164,164L220,220M220,164L164,220`. |
| package-plus, image-plus | Phosphor package / image + plus badge `M192,152V232M152,192H232`. |
| image-up | Phosphor image + arrow badge `M192,232V156M160,188L192,156L224,188`. |
| calendar-clock | Phosphor calendar-blank + clock badge (r44 at 188,188; hands to 166 and 206). |
| hard-drives-slash (`server-off`) | Phosphor hard-drives + slash `M48,40L208,216` (Phosphor's slash line). |
| search-x | Phosphor magnifying-glass + x in the lens (88-136). |
| scan-search | Phosphor scan + a lens r32 at (120,120) with handle to (168,168). |
| file-sheet (`file-spreadsheet`) | Phosphor file + a 2x2 grid 88-168 x 128-200. |
| sidebar-simple-right (`panel-right-open`) | Phosphor sidebar-simple mirrored. |

## Name map (app name -> glyph)

| App name | Glyph |
| --- | --- |
| activity | pulse |
| alcedo | kingfisher |
| archive | archive |
| archive-restore | box-arrow-up |
| arrow-down | arrow-down |
| arrow-left | arrow-left |
| arrow-right | arrow-right |
| arrow-up | arrow-up |
| arrow-up-right | arrow-up-right |
| atlas-bot | kingfisher |
| audio-lines | waveform |
| badge-check | seal-check |
| badge-percent | seal-percent |
| ban | prohibit |
| barcode | barcode |
| beer | beer-stein |
| bell | bell-simple |
| book-check | book-bookmark |
| book-open | book-open |
| book-x | book-x |
| briefcase-business | briefcase |
| building-2 | building-office |
| cake-slice | cake |
| calculator | calculator |
| calendar | calendar-blank |
| calendar-check | calendar-check |
| calendar-clock | calendar-clock |
| calendar-days | calendar-dots |
| calendar-off | calendar-slash |
| calendar-plus | calendar-plus |
| camera | camera |
| chart-no-axes-column | chart-bar |
| check | check |
| check-check | checks |
| check-circle-2 | check-circle |
| chevron-down | caret-down |
| chevron-left | caret-left |
| chevron-right | caret-right |
| chevron-up | caret-up |
| chevrons-up-down | caret-up-down |
| circle | circle |
| circle-alert | warning-circle |
| circle-check | check-circle |
| circle-dashed | circle-dashed |
| circle-user-round | user-circle |
| circle-x | x-circle |
| citrus | orange-slice |
| clapperboard | film-slate |
| clipboard-check | clipboard-text |
| clock | clock |
| coffee | coffee |
| compass | compass |
| contact-round | address-book |
| copy | copy |
| database | database |
| door-open | door-open |
| download | download-simple |
| ellipsis | dots-three |
| external-link | arrow-square-out |
| eye | eye |
| eye-off | eye-slash |
| file | file |
| file-archive | file-archive |
| file-pen-line | note-pencil |
| file-plus | file-plus |
| file-plus-2 | file-plus |
| file-question | file-magnifying-glass |
| file-spreadsheet | file-sheet |
| file-text | file-text |
| file-up | file-arrow-up |
| file-x | file-x |
| film | film-strip |
| flag | flag |
| flame | flame |
| gallery-vertical-end | cards |
| gauge | gauge |
| git-compare | git-diff |
| glass-water | pint-glass |
| graduation-cap | graduation-cap |
| grip-vertical | dots-six-vertical |
| hand-coins | hand-coins |
| hand-heart | hand-heart |
| hash | hash |
| history | clock-counter-clockwise |
| home | house |
| house | house |
| image | image |
| image-off | image-broken |
| image-plus | image-plus |
| image-up | image-up |
| images | images |
| inbox | tray |
| info | info |
| keyboard | keyboard |
| layers | stack |
| layers-3 | stack |
| layout-grid | squares-four |
| lightbulb | lightbulb |
| link | link |
| link-2 | link-simple |
| list | list |
| list-checks | list-checks |
| list-filter | funnel-simple |
| list-todo | list-checks |
| loader-circle | circle-notch |
| locate-fixed | gps-fix |
| lock | lock-simple |
| log-out | sign-out |
| mail | envelope-simple |
| map | map-trifold |
| map-pin | map-pin |
| martini | martini |
| megaphone | megaphone-simple |
| message-circle | chat-circle |
| message-square-text | chat-text |
| messages-square | chats |
| mic | microphone |
| mic-off | microphone-slash |
| minus | minus |
| move | arrows-out-cardinal |
| notebook-pen | note-pencil |
| octagon-alert | warning-octagon |
| orbit | graph |
| package | package |
| package-check | box-arrow-down |
| package-plus | package-plus |
| package-x | package-x |
| palette | palette |
| panel-left | sidebar-simple |
| panel-right-open | sidebar-simple-right |
| paperclip | paperclip |
| pencil | pencil-simple |
| pencil-ruler | pencil-ruler |
| phone-off | phone-slash |
| pin | push-pin |
| pin-off | push-pin-slash |
| play | play |
| plug | plug |
| plus | plus |
| printer | printer |
| qr-code | qr-code |
| receipt-text | receipt-tall |
| refresh-cw | arrows-clockwise |
| repeat-2 | repeat |
| replace | swap |
| rotate-ccw | arrow-counter-clockwise |
| ruler | ruler |
| scan-barcode | barcode |
| scan-line | scan |
| scan-search | scan-search |
| search | magnifying-glass |
| search-x | search-x |
| send | paper-plane-tilt |
| server | hard-drives |
| server-off | hard-drives-slash |
| settings | gear-six |
| shield | shield |
| shield-alert | shield-warning |
| shield-check | shield-check |
| shopping-cart | shopping-cart-simple |
| sliders-horizontal | sliders-horizontal |
| smartphone | device-mobile |
| snowflake | snowflake |
| sparkles | sparkle |
| square | stop |
| square-pen | note-pencil |
| star | star |
| store | storefront |
| tag | tag |
| target | target |
| thermometer | thermometer-simple |
| thumbs-down | thumbs-down |
| trash-2 | trash |
| triangle-alert | warning |
| truck | truck |
| undo-2 | arrow-u-up-left |
| unplug | plugs |
| upload | upload-simple |
| user | user |
| user-cog | user-gear |
| user-minus | user-minus |
| user-plus | user-plus |
| user-round | user |
| user-x | user-x |
| users | users |
| utensils | fork-knife |
| video | video-camera |
| wand-sparkles | magic-wand |
| wifi-off | wifi-slash |
| wine | wine |
| workflow | flow-arrow |
| x | x |
| zap | lightning |
