# Phase 3 — Social: Chat, Activity Feed, Auto Recaps & Power Rankings

**Prerequisites:** Phase 0 (notification hub, realtime SSE helper, feature
flags).
**Read first:** `PLAN.md` §2 (realtime), the draft stream route.

## Goal

The single biggest retention driver in fantasy: make the league feel alive.
Add per-league **chat** with reactions, an automatic **activity feed**, and
auto-generated **weekly/stage recaps** and **power rankings**.

## Why

Sleeper's dominance is largely social. League banter and auto-generated
narrative ("biggest blowout", "unluckiest manager") pull managers back between
matches far more than scores alone. The realtime and notification primitives
from Phase 0 make this tractable without new infra.

## Design / approach

### 3.1 League chat
- New table `chat_message`: `id`, `league_id`, `manager_id`, `body`,
  `created_at`, `edited_at`, `deleted_at` (soft delete). Index `(league_id,
  created_at)`.
- New table `chat_reaction`: `(message_id, manager_id, emoji)` PK.
- Service `src/data/social/chat.ts`: post, edit, soft-delete, list (paginated),
  toggle reaction. Membership-gated.
- Realtime via the Phase 0 SSE helper: `GET /api/leagues/[id]/chat/stream`
  emits new messages/reactions; `POLL_MS ~= 2500`. Posting is a normal `POST`.
- UI: a chat panel on the league page; render reactions; support GIFs by URL
  embed (no upload pipeline — paste a link; render image URLs inline).
- New chat messages enqueue an in-app notification to other members (dedupe so
  a burst doesn't spam; respect a simple per-member mute flag).

### 3.2 Activity feed
- A derived, append-only feed of league events: draft picks (already logged in
  `draft_pick`), stage results posted, rank changes (from `standings_snapshot`),
  chips played (Phase 6), bracket locks (Phase 5).
- Table `activity_event`: `id`, `league_id`, `type`, `payload` (jsonb),
  `created_at`. Most producers `enqueue` here; some (like draft picks) can be
  projected from existing tables on read — prefer writing events for new
  features, projecting for already-logged ones.
- Render interleaved with chat or on its own tab.

### 3.3 Auto recaps & power rankings
- After each stage's scores finalize (hook into the cron's post-recompute step,
  or the standings-snapshot write), generate:
  - **Power rankings**: rank teams by a blend of cumulative total and recent
    stage form; show movement vs previous stage (you already persist per-stage
    rank in `standings_snapshot` — diff consecutive snapshots).
  - **Recap narrative**: "biggest blowout" (largest H2H or stage-total gap),
    "top haul" (best single player), "bench tragedy" (best player left out of a
    best-ball XI — note: best-ball auto-optimizes, so frame this as "narrowly
    missed XI"), "manager of the stage".
- Generation: a pure `src/data/social/recap.ts` that takes the stage's computed
  standings/scores and returns a structured recap object; render it as a card
  and post it into chat/activity automatically. Keep copy templated and
  deterministic (no external LLM dependency required); if you later want
  livelier prose, an optional enrichment step can call a model, but the
  deterministic version must stand alone.

## Tasks
- [ ] Migration `00NN_social.sql`: `chat_message`, `chat_reaction`,
      `activity_event` (+ indexes).
- [ ] `src/data/social/chat.ts` (+ spec): post/edit/delete/list/react.
- [ ] Chat routes: `POST/GET /api/leagues/[id]/chat`, reaction route, and SSE
      `…/chat/stream` using the Phase 0 helper.
- [ ] Chat UI panel with reactions + inline image/GIF-by-URL rendering + mute
      toggle.
- [ ] `activity_event` producers/projectors + feed route + UI tab.
- [ ] `src/data/social/recap.ts` (+ spec): power rankings (with movement) and
      deterministic recap narrative.
- [ ] Hook recap/power-ranking generation into the post-stage recompute step;
      auto-post into chat + activity; notify members.
- [ ] Gate the whole feature behind the `chat` feature flag.

## Acceptance criteria
- [ ] Two members in one league see each other's messages/reactions within a
      few seconds via the stream; non-members get 403.
- [ ] A new message produces in-app notifications for other (non-muted) members,
      deduped under burst.
- [ ] Power rankings movement matches the diff of consecutive
      `standings_snapshot` rows (spec-verified).
- [ ] Recap object is deterministic for a fixed input (spec-verified) and
      auto-posts once per stage (idempotent — safe if cron reruns).
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Direct messages / cross-league chat.
- File/image upload hosting (URL embeds only).
