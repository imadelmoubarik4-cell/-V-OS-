// S94C platform rules (contract §5.4, report 08 §5.8): behaviour of
// supabase/functions/_shared/publishing/rules.mjs and parity of the generated
// browser copy apps/web/assets/js/marketing-platform-rules.js
// (window.AtlasPlatformRules), which must be byte-identical to a fresh build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as rules from '../../supabase/functions/_shared/publishing/rules.mjs';
import { buildPlatformRulesBrowser, RULES_SOURCE, RULES_BROWSER } from '../../scripts/build_platform_rules.mjs';

const { validate } = rules;
const jpeg = (over = {}) => ({ kind: 'image', mime_type: 'image/jpeg', width: 1080, height: 1350, byte_size: 400_000, ...over });
const mp4 = (over = {}) => ({ kind: 'video', mime_type: 'video/mp4', width: 1080, height: 1920, duration_ms: 20_000, byte_size: 20_000_000, ...over });
const codes = (result, level = 'errors') => result[level].map((item) => item.code);
const messageFor = (result, code, level = 'errors') => result[level].find((item) => item.code === code)?.message;

function loadBrowserCopy() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(RULES_BROWSER, 'utf8'), { window }, { filename: RULES_BROWSER });
  return window.AtlasPlatformRules;
}

test('the browser copy is byte-identical to a fresh build of rules.mjs (parity)', () => {
  const fresh = buildPlatformRulesBrowser(fs.readFileSync(RULES_SOURCE, 'utf8'));
  const committed = fs.readFileSync(RULES_BROWSER, 'utf8');
  assert.equal(committed, fresh, 'run: node scripts/build_platform_rules.mjs');
  assert.match(committed, /^\/\/ GENERATED FILE - do not edit\./);
  assert.doesNotMatch(committed, /^\s*(export|import)\s/m, 'classic script: no module syntax');
  assert.match(committed, /window\.AtlasPlatformRules = Object\.freeze\(\{[^}]*\bvalidate\b/);
});

test('rules.mjs stays dependency-free and the build refuses module syntax it cannot convert', () => {
  const source = fs.readFileSync(RULES_SOURCE, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.throws(() => buildPlatformRulesBrowser("import x from './y.mjs';\nexport function validate() {}"));
  assert.throws(() => buildPlatformRulesBrowser('export default function validate() {}'));
});

test('the browser copy behaves exactly like the server module', () => {
  const browser = loadBrowserCopy();
  assert.equal(typeof browser.validate, 'function');
  const cases = [
    { platforms: ['instagram', 'facebook', 'tiktok', 'google-business-profile'], caption: 'Jazz #live', media: [jpeg(), jpeg({ mime_type: 'image/png', width: 1000, height: 2000 })] },
    { platforms: ['tiktok'], caption: 'x', media: [mp4({ duration_ms: 760_000 })], options: { tiktok: { target_kind: 'tiktok_video', tiktok: { privacy_level: 'SELF_ONLY', brand_content_toggle: true } } }, targets_ready: [{ provider_key: 'tiktok', ready: true, target_kinds: ['tiktok_inbox_video', 'tiktok_video'] }] },
    { platforms: ['google-business-profile'], caption: 'Call 555 1234', media: [mp4()], options: { 'google-business-profile': { gbp: { topic_type: 'EVENT', event: { title: 'Quiz', start: '2026-10-03T20:00', end: '2026-10-03T19:00' } } } } },
    { platforms: [], caption: '' },
  ];
  for (const input of cases) assert.deepEqual(JSON.parse(JSON.stringify(browser.validate(input))), JSON.parse(JSON.stringify(validate(input))));
});

test('channel and schedule checks', () => {
  assert.deepEqual(codes(validate({ platforms: [] })), ['no_channel']);
  assert.equal(messageFor(validate({ platforms: [] }), 'no_channel'), 'Choose at least one channel.');
  const past = validate({ platforms: ['facebook'], caption: 'hi', scheduled_for: '2026-10-01T10:00:00Z', now: Date.parse('2026-10-02T10:00:00Z') });
  assert.equal(messageFor(past, 'time_past'), 'Choose a time in the future.');
  assert.deepEqual(codes(validate({ platforms: ['myspace'] })), ['unknown_platform']);
});

test('Instagram: media required, target kinds, carousel limit, JPEG, aspect, Reel duration, caption and hashtags', () => {
  assert.equal(messageFor(validate({ platforms: ['instagram'], caption: 'x' }), 'ig_no_media'), 'Instagram needs at least one photo or video.');
  assert.equal(validate({ platforms: ['instagram'], media: [jpeg()] }).target_kinds.instagram, 'ig_feed');
  assert.equal(validate({ platforms: ['instagram'], media: [mp4()] }).target_kinds.instagram, 'ig_reel');
  assert.equal(validate({ platforms: ['instagram'], media: [jpeg(), mp4()] }).target_kinds.instagram, 'ig_carousel');
  const twelve = validate({ platforms: ['instagram'], media: Array.from({ length: 12 }, () => jpeg()) });
  assert.equal(messageFor(twelve, 'ig_too_many'), 'Instagram carousels take up to 10 photos or videos. Remove 2.');
  const tall = validate({ platforms: ['instagram'], media: [jpeg(), jpeg(), jpeg({ width: 1080, height: 1920 })] });
  assert.equal(messageFor(tall, 'ig_aspect'), 'Instagram: photo 3 is taller than 4:5. Choose the Portrait 4:5 crop.');
  const wide = validate({ platforms: ['instagram'], media: [jpeg({ width: 2000, height: 1000 })] });
  assert.match(messageFor(wide, 'ig_aspect'), /wider than 1\.91:1/);
  assert.deepEqual(codes(validate({ platforms: ['instagram'], media: [jpeg({ width: 1080, height: 1350 })] })), [], '4:5 is allowed');
  assert.deepEqual(codes(validate({ platforms: ['instagram'], media: [jpeg({ width: 1910, height: 1000 })] })), [], '1.91:1 is allowed');
  assert.match(messageFor(validate({ platforms: ['instagram'], media: [jpeg({ mime_type: 'image/png' })] }), 'ig_image_format'), /must be a JPEG/);
  assert.equal(messageFor(validate({ platforms: ['instagram'], media: [mp4({ duration_ms: 2000 })] }), 'ig_reel_duration'), 'Instagram Reels must be 3 seconds to 15 minutes. This video is 2 seconds.');
  assert.match(messageFor(validate({ platforms: ['instagram'], media: [mp4({ duration_ms: 16 * 60_000 })] }), 'ig_reel_duration'), /This video is 16:00\./);
  assert.match(messageFor(validate({ platforms: ['instagram'], media: [mp4({ byte_size: 400 * 1024 * 1024 })] }), 'ig_reel_size'), /300 MB/);
  const long = validate({ platforms: ['instagram'], caption: 'a'.repeat(2340), media: [jpeg()] });
  assert.equal(messageFor(long, 'ig_caption_length'), 'Instagram caption is 2,340 characters; the limit is 2,200. Shorten it or write a shorter Instagram caption.');
  const tags = validate({ platforms: ['instagram'], caption: Array.from({ length: 34 }, (_, i) => `#tag${i}`).join(' '), media: [jpeg()] });
  assert.equal(messageFor(tags, 'ig_hashtags'), 'Instagram allows up to 30 hashtags. This caption has 34.');
  // A per-platform override is what gets checked.
  const override = validate({ platforms: ['instagram', 'facebook'], caption: 'a'.repeat(3000), overrides: { instagram: 'short' }, media: [jpeg()] });
  assert.ok(!codes(override).includes('ig_caption_length'));
  assert.equal(rules.countHashtags('#a b #ö_1 c#d'), 2);
  assert.equal(validate({ platforms: ['instagram'], media: [jpeg()], options: { instagram: { target_kind: 'ig_reel' } } }).errors[0].code, 'ig_reel_media');
});

test('Facebook: text/photo/video/reel kinds and mixed media', () => {
  assert.equal(validate({ platforms: ['facebook'], caption: 'hi' }).target_kinds.facebook, 'fb_page_post');
  assert.equal(validate({ platforms: ['facebook'], media: [jpeg(), jpeg()] }).target_kinds.facebook, 'fb_page_photo');
  assert.equal(validate({ platforms: ['facebook'], media: [mp4()] }).target_kinds.facebook, 'fb_page_video');
  assert.equal(validate({ platforms: ['facebook'], media: [mp4()], options: { facebook: { target_kind: 'fb_reel' } } }).target_kinds.facebook, 'fb_reel');
  assert.deepEqual(codes(validate({ platforms: ['facebook'], caption: '' })), ['fb_empty']);
  assert.ok(codes(validate({ platforms: ['facebook'], media: [jpeg(), mp4()] })).includes('fb_mixed_media'));
  const landscapeReel = validate({ platforms: ['facebook'], media: [mp4({ width: 1920, height: 1080 })], options: { facebook: { target_kind: 'fb_reel' } } });
  assert.ok(codes(landscapeReel, 'warnings').includes('fb_reel_orientation'));
});

test('TikTok: one video, inbox by default, Direct Post only when allowed, privacy, commercial content, max duration', () => {
  assert.equal(messageFor(validate({ platforms: ['tiktok'] }), 'tiktok_no_media'), 'TikTok needs one video.');
  assert.ok(codes(validate({ platforms: ['tiktok'], media: [jpeg()] })).includes('tiktok_photo_unsupported'));
  assert.ok(codes(validate({ platforms: ['tiktok'], media: [mp4(), mp4()] })).includes('tiktok_one_video'));
  assert.equal(validate({ platforms: ['tiktok'], media: [mp4()] }).target_kinds.tiktok, 'tiktok_inbox_video');
  const notAllowed = validate({ platforms: ['tiktok'], media: [mp4()], options: { tiktok: { target_kind: 'tiktok_video' } }, targets_ready: [{ provider_key: 'tiktok', ready: true, target_kinds: ['tiktok_inbox_video'] }] });
  assert.equal(notAllowed.target_kinds.tiktok, 'tiktok_inbox_video');
  assert.ok(codes(notAllowed, 'warnings').includes('tiktok_direct_unavailable'));
  const ready = [{ provider_key: 'tiktok', ready: true, target_kinds: ['tiktok_inbox_video', 'tiktok_video'] }];
  const direct = (tt, extra = {}) => validate({ platforms: ['tiktok'], media: [mp4(extra.media)], options: { tiktok: { target_kind: 'tiktok_video', tiktok: tt } }, targets_ready: ready, ...extra.input });
  assert.equal(messageFor(direct({}), 'tiktok_privacy'), 'Choose who can see it on TikTok.');
  assert.deepEqual(codes(direct({ privacy_level: 'PUBLIC_TO_EVERYONE' })), []);
  assert.equal(messageFor(direct({ privacy_level: 'PUBLIC_TO_EVERYONE', commercial_content: true }), 'tiktok_commercial'), 'Choose whether this promotes your brand, another brand, or both.');
  assert.equal(messageFor(direct({ privacy_level: 'SELF_ONLY', brand_content_toggle: true }), 'tiktok_branded_private'), "Branded content can't be private. Choose Everyone or Friends.");
  const unaudited = direct({ privacy_level: 'PUBLIC_TO_EVERYONE', creator_info: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 600 } });
  assert.match(messageFor(unaudited, 'tiktok_privacy_unavailable'), /private \(Only me\)/);
  const tooLong = direct({ privacy_level: 'SELF_ONLY', creator_info: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 600 } }, { media: { duration_ms: 760_000 } });
  assert.equal(messageFor(tooLong, 'tiktok_too_long'), 'TikTok: this account can post videos up to 10 minutes. This one is 12:40.');
});

test('Google Business Profile: no video, first photo only, photo rules, phone numbers, events and buttons', () => {
  const gbp = (g, extra = {}) => validate({ platforms: ['google-business-profile'], caption: 'Brunch every Sunday', options: { 'google-business-profile': { gbp: g } }, ...extra });
  assert.equal(messageFor(gbp({}, { media: [mp4()] }), 'gbp_video'), "Google Business Profile can't post videos. Remove the video or turn off Google Business Profile.");
  assert.equal(messageFor(gbp({}, { media: [jpeg(), jpeg()] }), 'gbp_extra_photos', 'warnings'), 'Google Business Profile uses only the first photo.');
  assert.ok(codes(gbp({}, { media: [jpeg({ mime_type: 'image/webp' })] })).includes('gbp_photo_format'));
  assert.ok(codes(gbp({}, { media: [jpeg({ byte_size: 5000 })] })).includes('gbp_photo_size'));
  assert.ok(codes(gbp({}, { media: [jpeg({ byte_size: 6 * 1024 * 1024 })] })).includes('gbp_photo_size'));
  assert.ok(codes(gbp({}, { media: [jpeg({ width: 200, height: 200 })] })).includes('gbp_photo_dimensions'));
  assert.equal(messageFor(gbp({}, { caption: 'Book on +354 555 1234' }), 'gbp_phone'), 'Google removes posts with a phone number in the text. Use the Call now button instead.');
  assert.ok(!codes(gbp({}, { caption: 'Open 2026-10-03, 17:00-19:00' })).includes('gbp_phone'), 'dates and times are not phone numbers');
  assert.equal(messageFor(gbp({ topic_type: 'EVENT', event: { title: 'Quiz' } }), 'gbp_event_dates'), 'Add when the event starts and ends.');
  assert.equal(messageFor(gbp({ topic_type: 'EVENT', event: { title: 'Quiz', start: '2026-10-03T20:00', end: '2026-10-03T19:00' } }), 'gbp_event_order'), 'The event ends before it starts.');
  assert.ok(codes(gbp({ topic_type: 'OFFER', offer: { start: '2026-10-03', end: '2026-10-05' } })).includes('gbp_event_title'));
  assert.equal(messageFor(gbp({ call_to_action: { action_type: 'BOOK' } }), 'gbp_cta_link'), 'Add the link the button opens.');
  assert.equal(messageFor(gbp({ call_to_action: { action_type: 'BOOK', url: 'http://vabar.is' } }), 'gbp_cta_https'), 'Enter a full link starting with https://');
  assert.deepEqual(codes(gbp({ call_to_action: { action_type: 'CALL' } })), []);
  assert.ok(codes(gbp({ topic_type: 'ALERT' })).includes('gbp_topic_unsupported'));
  assert.ok(codes(gbp({}, { caption: 'a'.repeat(1600) })).includes('gbp_caption_length'));
  assert.equal(gbp({}).target_kinds['google-business-profile'], 'gbp_local_post');
});

test('readiness and alt text are warnings, never blocking', () => {
  const result = validate({
    platforms: ['instagram', 'facebook'],
    caption: 'x',
    media: [jpeg({ alt_text: '' })],
    targets_ready: [{ provider_key: 'instagram', ready: false, reason: 'needs_reauthorization' }, { provider_key: 'facebook', ready: true }],
  });
  assert.deepEqual(codes(result), []);
  assert.equal(messageFor(result, 'not_ready', 'warnings'), 'Instagram needs reconnecting in Settings › Integrations before Atlas can post.');
  assert.equal(result.warnings.filter((w) => w.code === 'missing_alt').length, 1);
  assert.equal(messageFor(result, 'missing_alt', 'warnings'), 'Photo 1 has no alt text. Add it so people using screen readers know what it shows.');
  // A readiness map works too.
  const map = validate({ platforms: ['facebook'], caption: 'x', targets_ready: { facebook: { ready: false, reason: 'no_resource_selected' } } });
  assert.match(messageFor(map, 'not_ready', 'warnings'), /^Facebook has no account chosen/);
});

test('every message names the channel or is a general check, and none leaks internal codes', () => {
  const result = validate({
    platforms: ['instagram', 'facebook', 'tiktok', 'google-business-profile'],
    caption: `${'#t '.repeat(40)} call 5551234`,
    media: [jpeg({ mime_type: 'image/png', width: 100, height: 400 }), mp4({ duration_ms: 1000 })],
    options: { tiktok: { target_kind: 'tiktok_video', tiktok: {} }, 'google-business-profile': { gbp: { topic_type: 'EVENT' } } },
    targets_ready: [{ provider_key: 'tiktok', ready: true, target_kinds: ['tiktok_inbox_video', 'tiktok_video'] }],
  });
  assert.ok(result.errors.length >= 8);
  for (const item of [...result.errors, ...result.warnings]) {
    assert.ok(item.message.length > 10 && item.message.length < 220, item.code);
    assert.doesNotMatch(item.message, /\b(ig|fb|gbp|tiktok)_[a-z_]+\b|undefined|NaN|null/, item.message);
  }
});

test('P1-2 a non-JPEG photo with a ready JPEG publish copy passes the JPEG checks (server and browser copy)', () => {
  const browser = loadBrowserCopy();
  const heic = { kind: 'image', mime_type: 'image/heic', width: 1080, height: 1350, byte_size: 400_000 };
  for (const run of [validate, browser.validate]) {
    const without = run({ platforms: ['instagram', 'facebook', 'google-business-profile'], caption: 'Jazz', media: [heic] });
    assert.ok(codes(without).includes('ig_image_format'));
    assert.ok(codes(without).includes('fb_image_format'));
    assert.ok(codes(without).includes('gbp_photo_format'));
    const withCopy = run({ platforms: ['instagram', 'facebook', 'google-business-profile'], caption: 'Jazz', media: [{ ...heic, publish_variant_id: '00000000-0000-4000-8000-000000000001' }] });
    for (const code of ['ig_image_format', 'fb_image_format', 'gbp_photo_format']) assert.ok(!codes(withCopy).includes(code), code);
    // An explicitly chosen variant is checked as itself.
    const chosen = run({ platforms: ['instagram'], caption: 'Jazz', media: [{ ...heic, mime_type: 'image/png', variant_id: '00000000-0000-4000-8000-000000000002', publish_variant_id: '00000000-0000-4000-8000-000000000001' }] });
    assert.ok(codes(chosen).includes('ig_image_format'));
  }
});
