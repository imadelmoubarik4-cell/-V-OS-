# Atlas Training — Product Roadmap

_Source of truth for the Training product. Owner-supplied roadmap, transcribed and
scoped for the MVP implementation run. Location in the app: **Knowledge → Training**._

## 1. What Training is

Atlas Training turns an approved internal procedure into a lesson a staff member can
actually complete:

> **Video SOP + written procedure + staff assignment + completion evidence + Atlas
> AI‑compatible approved knowledge.**

Training is **not** a standalone video library. It is an extension of the existing
**Knowledge** module. A training lesson **is** a Knowledge article whose
`article_type = 'training'`, published through Knowledge's existing
draft → immutable published version → staff‑visible lifecycle. Everything Knowledge
already does — categories, versions, `target_roles`, the `required` flag, sources,
reads, acknowledgements, activity/events, onboarding task links, role‑aware access,
full‑text search — is **reused, never replaced**.

## 2. The experience the MVP must make real

**Manager** — Knowledge → Training → New training → upload a real video → add a
written procedure and steps → target a role → publish.

**Bartender** — Knowledge → Training → *Required for you* → Opening the Bar → Start →
watch the video, seek by chapter, read the written steps → **I have completed this
training**.

**Manager** — Team / Training → sees that the correct employee completed the correct
**immutable lesson version**.

## 3. MVP scope (build now)

- Knowledge → Training home for staff and a manager authoring mode.
- Manager video upload to **private** storage; a video player with chapters.
- Lesson: title, summary, category, written SOP (procedure), checklist/procedure steps,
  chapters/timestamps.
- Role targeting (reuse `target_roles`), required/recommended (reuse `required`).
- Versioned publishing (reuse Knowledge versions); publishing v2 never mutates v1.
- Staff: *Continue training*, *Required*, *Recommended*, *Library*; resume video
  position; **explicit** completion; completion history bound to the exact version.
- Manager completion view (per lesson: assigned / completed / outstanding).
- Phone‑first UX; existing Knowledge search compatibility; onboarding compatibility;
  security; audit trail.

## 4. Explicitly out of MVP scope (do not build)

Quizzes, AI transcription, AI‑generated chapters, AI timestamp answering, automatic
translation / dubbing, QR codes, shift blocking, competency scoring, manager practical
sign‑off, offline full‑video downloads, multi‑venue sharing, automated video editing,
advanced analytics, automatic social publishing, surveillance‑style telemetry
(playback‑speed / per‑seek / attention tracking / leaderboards).

## 5. Product principles

- **Watching ≠ learning.** Completion is always an explicit, server‑validated action;
  playback position is only a resume convenience, never proof of competency.
- **Immutability.** A published version and its video are frozen. Editing a published
  lesson creates the next draft/version; v1 completions and v1 media are preserved.
- **Private media.** Training video is sensitive internal content. It lives in a private
  bucket, is never public, and is reached only through short‑lived, authorization‑checked
  signed access minted server‑side.
- **Server‑authoritative security.** The browser never decides authorization; the Edge
  Function resolves the actor and enforces role/visibility/ownership on every call.
- **Data minimization.** Store only what behavior needs: started, last opened, resume
  position, explicit completion.

## 6. Assignment model (MVP)

By **role**, reusing Knowledge `target_roles` (`all | admin | manager | bartender |
viewer`). Required vs. recommended reuses the Knowledge `required` flag. Per‑person
assignment is not an MVP blocker.

## 7. Onboarding & Operations compatibility (MVP = compatibility, not redesign)

- `public.onboarding_tasks` / `public.onboarding_progress` remain the onboarding system.
- `atlas_private.knowledge_task_links` continues to link onboarding tasks to articles;
  a training lesson is just such an article, so an onboarding task can point at a lesson
  with no new engine.
- Operations "Watch how" → lesson: architecture must permit it; wired only if it is a
  minimal, safe change, otherwise documented as the post‑MVP bridge.

## 8. Definition of test‑ready

The MVP is test‑ready only when a manager can upload a real MP4 in a non‑production
environment, build and publish a lesson, a targeted staff member can play the private
video and explicitly complete it, a manager can see the completion, publishing v2
preserves v1 history and media, existing Knowledge/onboarding still work, and the full
automated suite (migration replay, node, browser, python, security/authorization,
Supabase advisors) is green. See
`docs/release/Atlas_Training_T0_Architecture_Audit.md` for the technical contract and
`docs/release/Atlas_Training_MVP.md` (produced by the implementation) for the acceptance
script and results.
