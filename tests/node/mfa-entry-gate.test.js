// S99 behavioural tests for the two-factor ENTRY gate and onboarding completion.
// These exercise the real pure decision functions extracted from the shipped
// source (not just static string checks), covering the review findings:
//   * enforcement OFF  → existing factor-less staff enter (release non-breaking)
//   * enforcement ON   → factor-less staff are sent to enrolment
//   * a verified factor always steps up to aal2 (unchanged S96 behaviour)
//   * missing enrolment UI enters the app and never loops the gate
//   * interrupted onboarding cannot complete until every step is done
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Extract a self-contained function declaration by brace-matching and eval it.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found in source');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end !== -1, name + ' body not closed');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src.slice(start, end) + ')')();
}

const app = readFileSync('apps/web/assets/js/atlas-app.js', 'utf8');
const invite = readFileSync('apps/web/assets/js/account-invitation.js', 'utf8');
const mfaEntryDecision = extractFn(app, 'mfaEntryDecision');
const enrollmentPlan = extractFn(app, 'enrollmentPlan');
const canCompleteOnboarding = extractFn(invite, 'canCompleteOnboarding');

test('enforcement OFF: existing factor-less staff enter (no forced enrolment)', () => {
  assert.equal(mfaEntryDecision({ hasVerifiedFactor: false, mustEnroll: false, aal: 'aal1' }), 'allow');
});

test('enforcement ON: factor-less staff are routed to enrolment', () => {
  assert.equal(mfaEntryDecision({ hasVerifiedFactor: false, mustEnroll: true, aal: 'aal1' }), 'enroll');
});

test('a verified factor always challenges to aal2, whatever the policy', () => {
  assert.equal(mfaEntryDecision({ hasVerifiedFactor: true, aal: 'aal1', mustEnroll: false }), 'challenge');
  assert.equal(mfaEntryDecision({ hasVerifiedFactor: true, aal: 'aal1', mustEnroll: true }), 'challenge');
});

test('an already-aal2 session with a factor enters', () => {
  assert.equal(mfaEntryDecision({ hasVerifiedFactor: true, aal: 'aal2', mustEnroll: true }), 'allow');
});

test('the gate reads the rollout policy rather than forcing enrolment unconditionally', () => {
  assert.match(app, /fetchMustEnroll\(\)/);
  const gate = app.slice(app.indexOf('async function enforceEntryMfa'), app.indexOf('function mountLoginEnrollment'));
  assert.match(gate, /mustEnroll = hasVerifiedFactor \? false : await fetchMustEnroll\(\)/);
});

test('missing enrolment UI enters the app and never recurses through the gate', () => {
  assert.equal(enrollmentPlan(false), 'enter');
  assert.equal(enrollmentPlan(true), 'mount');
  const mount = app.slice(app.indexOf('function mountLoginEnrollment'), app.indexOf('async function onSignedIn'));
  assert.ok(!/onSignedIn\s*\(/.test(mount), 'mountLoginEnrollment must not call onSignedIn (would loop)');
  assert.match(mount, /enterApp\(session\)/);
});

test('interrupted onboarding cannot complete until every step is done', () => {
  const full = { password: true, name: true, phone: true, photo: true, mfa: true };
  assert.equal(canCompleteOnboarding(full), true);
  for (const step of Object.keys(full)) {
    assert.equal(canCompleteOnboarding({ ...full, [step]: false }), false, 'must block when missing: ' + step);
  }
  assert.equal(canCompleteOnboarding(null), false);
});
