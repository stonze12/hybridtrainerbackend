# Hybrid Trainer — Monetization System Architecture

**Scope:** subscription + credit hybrid monetization layer in front of the Anthropic API, designed for production deployment at 100,000+ users.

**Companion code:** all code referenced below lives in `/code` alongside this document, organized by domain (`auth/`, `credits/`, `anthropic/`, `stripe/`, `admin/`, `db/`).

---

## 1. Two things to resolve before building this

**Anthropic's usage policies on reselling API access.** This system is built around metering and reselling access to Claude through your own credit system. That's a common and supported pattern, but the specifics (rate limits on your account, commercial terms, usage policy compliance) can change and should be confirmed directly with Anthropic for your account tier before launch — this is a business/legal check, not an engineering one, and it's outside what I can verify for you.

**Payment processing is something you operate, not something I can run.** Everything in this document and the accompanying code is designed for you to deploy and run — I can't execute Stripe charges, store card data, or process payments on your behalf under any circumstance. The Stripe integration below uses Stripe Checkout specifically so that card data never touches your servers, which also keeps your PCI compliance scope minimal.

---

## 2. High-level architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│  iOS / Web   │────▶│   API        │────▶│   PostgreSQL       │
│  Client      │     │   Gateway     │     │   (primary truth)  │
│  (PWA today, │◀────│   (Express/   │◀────│                    │
│  native      │     │   Node, behind│     └──────────────────┘
│  later)      │     │   ALB)        │              │
└─────────────┘     └──────┬───────┘              │
                            │                       │
              ┌─────────────┼─────────────┐         │
              ▼             ▼             ▼         │
        ┌─────────┐   ┌──────────┐  ┌──────────┐    │
        │  Redis   │   │  Stripe   │  │ Anthropic │   │
        │  (rate    │   │  (billing)│  │  API      │   │
        │  limit +  │   └──────────┘  └──────────┘    │
        │  session) │                                  │
        └─────────┘                                   │
                                                         ▼
                                                 ┌──────────────┐
                                                 │  Read replica │
                                                 │  (admin       │
                                                 │  dashboard     │
                                                 │  queries)      │
                                                 └──────────────┘
```

**Why this shape:**

- **Stateless API servers behind a load balancer.** No server-side session state in the app servers themselves — JWTs carry identity, Redis carries rate-limit counters. This means you can horizontally scale API instances without sticky sessions, which is the baseline requirement for handling 100k+ users without a single instance becoming a bottleneck.
- **Postgres as the single source of truth**, with a **read replica fed exclusively to the admin dashboard.** Admin analytics queries (revenue rollups, feature usage breakdowns) are read-heavy and can be expensive; running them against your primary database risks slowing down the actual user-facing credit deduction path, which is latency-sensitive. Point the admin dashboard's connection pool at a replica so a slow analytics query can never compete with a real-time AI request for database resources.
- **Redis for rate limiting**, not in-memory counters — covered in detail in §6.

---

## 3. Database schema

Full schema: `code/db/schema.sql`. Atomic credit functions: `code/db/credit_functions.sql`.

### Core tables

| Table | Purpose |
|---|---|
| `users` | Identity, cached credit balance, membership tier |
| `refresh_tokens` | Revocable JWT refresh tokens (hashed) |
| `password_reset_tokens` | One-time password reset tokens (hashed) |
| `subscriptions` | Local mirror of Stripe subscription state |
| `credit_purchases` | One row per completed one-time credit pack purchase |
| `credit_transactions` | **Append-only ledger — the source of truth for all credit movement** |
| `ai_requests` | One row per Anthropic API call: tokens, cost, latency, status |
| `stripe_webhook_events` | Idempotency log for webhook processing |
| `admin_audit_log` | Every manual admin action, attributed |

### The most important design decision in this schema

`users.credits` is a **cached value, not the source of truth.** The actual truth is the sum of all rows in `credit_transactions` for that user. This is the same pattern every real ledger-based system uses (it's how double-entry bookkeeping works, and it's how Stripe's own internal balance tracking works).

Why this matters in practice: if `users.credits` were the only record of a user's balance, then any bug that corrupts that one row loses the user's entire credit history with no way to reconstruct it, and you have no audit trail to answer "why does this user have 340 credits" six months from now. With the ledger, `users.credits` can always be recomputed from `credit_transactions`, support disputes are answerable by reading the ledger, and a nightly reconciliation job (`credit_balance_reconciliation` view, in `credit_functions.sql`) can detect drift between the cache and the truth before it compounds into a real problem.

### Why credits are `BIGINT`, not `NUMERIC` or `FLOAT`

Floating point arithmetic on a balance that gates billable API calls is a defect waiting to happen — `0.1 + 0.2 !== 0.3` in floating point, and that kind of error compounding across millions of transactions will eventually let a deduction round down at exactly the wrong moment. Credits are whole numbers in this design; there is no fractional-credit concept anywhere in the spec, so there's no reason to introduce float risk.

### Why monetary amounts are stored in cents (`INTEGER`)

Same reasoning as above, applied to dollars. `$14.99` stored as a float risks `1499.0000000002`-style drift after enough arithmetic. Storing `1499` (cents) as an integer makes every monetary calculation exact. This is standard practice — it's literally how Stripe's own API represents amounts.

---

## 4. The atomic credit deduction problem

This is the single most important correctness issue in the whole system, so it gets its own section.

**The race condition:** if a user's request to spend credits is implemented as "read balance → check if enough → write new balance" across three separate steps in application code, two concurrent requests (a double-tap, a retry, or — at 100k+ users — just normal traffic volume) can both read the same starting balance, both pass the check, and both write a deduction. The result: the user got two AI responses for the price of one, and your real credit ledger has silently drifted from what was actually charged. At consumer-app scale, this is not a rare edge case — it happens routinely under real concurrent load.

**The fix:** the check-and-deduct happens in a single atomic SQL statement (`deduct_credits()` in `credit_functions.sql`):

```sql
UPDATE users
SET credits = credits - p_amount
WHERE id = p_user_id AND credits >= p_amount
RETURNING credits INTO v_new_balance;
```

Postgres takes a row-level lock for the duration of this statement. If two requests for the same user arrive concurrently, the database serializes them — the second one's `WHERE credits >= p_amount` check runs against the balance *after* the first one's deduction has already applied, so if the balance is now insufficient, the second `UPDATE` simply matches zero rows and fails cleanly. There is no window where both can succeed against a balance that should only support one.

This is wrapped in `credit_service.chargeForFeature()`, which is the only function any route handler should call to charge a user — never write `UPDATE users SET credits = ...` anywhere else in the codebase.

---

## 5. The AI request flow, end to end

This is implemented in `code/anthropic/anthropic_service.js::runAiRequest()`, called by every AI-powered route (example: `code/anthropic/route_example_coach.js`).

1. **Check balance + verify + deduct** — one atomic call to `deduct_credits()`. If insufficient, throw `InsufficientCreditsError` and stop here — **the Anthropic API is never called** if the user can't pay for it.
2. **Save transaction record** — both the `credit_transactions` ledger row (inside step 1) and an `ai_requests` row with `status='pending'`, created *before* the Anthropic call. This means even a server crash mid-request leaves a recoverable trail.
3. **Call Anthropic.**
4. **On success:** update the `ai_requests` row with token counts, computed cost, latency, and `status='success'`. Return the response to the route handler.
5. **On failure:** update `ai_requests` with `status='failed'` and the error, **and refund the deducted credits** via `grant_credits()`. The user should never pay for a request that didn't produce a result.

**Why deduct before calling Anthropic, then refund on failure — rather than calling first and charging only on success?** Charging-after-success reopens exactly the race condition described in §4: two concurrent requests could both pass a balance check, both call Anthropic (now you've paid Anthropic twice for one user's one paid action), and only then attempt to deduct, by which point you're choosing between an awkward retroactive failure or letting the balance go negative. Deduct-then-refund closes the race at the point where it matters and treats "Anthropic failed" as the rare path that needs cleanup, rather than treating "two requests landed at once" as the rare path — which it isn't, at scale.

---

## 6. Rate limiting

Implemented in `code/auth/rate_limit.js`, backed by Redis sorted sets (sliding window, not fixed window — fixed-window counters allow up to 2× the intended burst right at window boundaries).

Two independent limit layers:

- **General API rate limit** (120 req/min per user) — a backstop against runaway clients or bugs, not a business control.
- **AI endpoint rate limit, tiered by membership** — Free: 10/hour, Pro: 60/hour, Admin: 200/hour. This is what actually protects your Anthropic spend from a single compromised or abusive account hammering the most expensive endpoints (Fight Camp Builder, Opponent Analysis) faster than credit deduction alone would naturally throttle.

**Why Redis and not an in-memory counter:** at 100k+ users you're running multiple API server instances behind a load balancer. An in-memory rate limiter tracks its counts per-instance — a user whose requests happen to land on different instances effectively gets N× the intended limit, where N is your instance count. A shared Redis store gives one true count across every instance.

---

## 7. Stripe integration

Checkout session creation: `code/stripe/checkout.js`. Webhook handling: `code/stripe/webhooks.js`.

### Why Stripe Checkout (hosted page) instead of a custom card form

Building your own card input form (Stripe Elements embedded in your own UI) is possible, but it pulls more PCI compliance scope onto you and is meaningfully more implementation surface for the same outcome. Checkout's hosted page means card data never transits your servers at all — Stripe handles the entire card-entry experience, and you only ever see a `checkout.session.completed` webhook telling you it succeeded.

### A note on the Payment Link you shared

The link `https://buy.stripe.com/6oUeVf6ab1Pz7rLfEc6oo01` is a **Stripe Payment Link** — a simpler, no-code alternative to the Checkout Sessions API used throughout this design. It works, and the webhook handling in `webhooks.js` will correctly process payments made through it (Payment Links fire the same `checkout.session.completed` and subscription events), but it has one gap relevant to this system: **Payment Links don't let you attach `metadata.app_user_id` at creation time**, since there's no server-side code generating the link per-user — it's one static URL shared with everyone.

Without `app_user_id` in the metadata, the webhook handler in §7 has no reliable way to know *which user* just paid. The practical fix is to pass the user id through Stripe's `client_reference_id` field instead, which Payment Links do support via a URL parameter:

```
https://buy.stripe.com/6oUeVf6ab1Pz7rLfEc6oo01?client_reference_id={internal_user_id}
```

Your frontend would generate this URL per-user (substituting the logged-in user's id) rather than sharing the bare link. The webhook handler would then read `session.client_reference_id` instead of `session.metadata.app_user_id` for events originating from this link specifically. If you intend to rely on Payment Links rather than building the dynamic Checkout Session flow in `checkout.js`, this is the one adjustment needed to keep credit/subscription delivery correctly attributed — otherwise a payment can succeed in Stripe with no way to know whose account to upgrade.

### Subscriptions vs. credit packs through the same Checkout flow

Both purchase types go through `stripe.checkout.sessions.create()`, distinguished by `mode: 'subscription'` vs `mode: 'payment'`, and tagged with `metadata.purchase_type` so the webhook handler knows which branch to take. The `metadata.app_user_id` field on every session (and propagated onto the resulting subscription object) is what lets webhooks map a Stripe event back to your internal user — **never try to match Stripe objects back to your users by email**, since emails can be edited and Stripe doesn't enforce uniqueness the way your own `users.email` column does.

### Webhook idempotency — non-negotiable at this scale

Stripe retries webhook deliveries on timeout or any 5xx response, which means **the same event will be delivered to your endpoint more than once** as a matter of normal Stripe operation, not as a failure case. `stripe_webhook_events` exists specifically to make every handler idempotent: the event's Stripe-assigned id is inserted with `ON CONFLICT DO NOTHING` before any business logic runs, and if the insert finds an existing row, the handler exits immediately having done nothing. Without this table, a single payment can grant credits twice, a single cancellation can fire your downgrade logic twice (harmless but noisy), or — worse — partial failures during a retry can leave the system in an inconsistent state that's hard to detect later.

### Why webhook signature verification matters here specifically

Without verifying `stripe-signature` against your webhook secret, your webhook endpoint is a public URL that accepts arbitrary POST bodies — anyone who discovers it could POST a fake `invoice.payment_succeeded` event and grant themselves 500 credits for free. `stripe.webhooks.constructEvent()` in `webhooks.js` is what prevents this; it's the first thing that runs on every webhook request, before any database access.

### Events handled, and why each one matters

| Event | What it does |
|---|---|
| `checkout.session.completed` | Grants credit-pack purchases. Subscriptions are handled by the next event instead, since renewals don't go through Checkout again. |
| `invoice.payment_succeeded` | Grants the monthly 500 Pro credits — fires on the *first* subscription invoice and every renewal after it. This is the actual source of monthly credit grants, not the checkout event. |
| `invoice.payment_failed` | Marks the subscription `past_due`. Does **not** immediately downgrade — Stripe's Smart Retries may still succeed, and downgrading too early on a single failed charge attempt is a bad user experience for what's often just an expired-card hiccup. |
| `customer.subscription.updated` | Syncs status, period end, and `cancel_at_period_end` flag — covers plan changes and a user scheduling cancellation. |
| `customer.subscription.deleted` | The subscription is genuinely over. Downgrades `membership_type` to `free`. Already-granted credits from the paid period are **not** clawed back — they were earned for time already paid for. |
| `charge.refunded` | Claws back credits from a refunded one-time purchase, using the same atomic `deduct_credits()` function. If the user already spent the credits and the clawback can't complete, it's flagged to `admin_audit_log` for manual review rather than driving the balance negative. |

### Subscription cancellation flow (user-initiated)

Users manage their own subscription (cancel, update card, view invoices) through **Stripe's Billing Portal**, not custom UI you build — `createBillingPortalSession()` in `checkout.js` generates a one-time link into Stripe's hosted portal. This avoids reimplementing subscription-management UI and guarantees Stripe's own cancellation flow (including any retention offers you configure in the Stripe dashboard) fires correctly.

---

## 8. Anthropic API integration

Service: `code/anthropic/anthropic_service.js`. Example route: `code/anthropic/route_example_coach.js`.

### Secure key storage

The Anthropic API key is read from an environment variable at process startup (`process.env.ANTHROPIC_API_KEY`), injected by your secrets manager at deploy time — AWS Secrets Manager, GCP Secret Manager, or HashiCorp Vault, depending on your infrastructure. It is never committed to source control, never logged, and never present in any response sent to a client. All Anthropic calls happen exclusively in server-side code; the client never has the key or makes a direct request to `api.anthropic.com`.

### Cost tracking

Every successful request records `input_tokens`, `output_tokens`, and a computed `estimated_cost_cents` based on the model's published per-token rate (see `MODEL_COST_PER_MTOK` in `anthropic_service.js` — update these constants whenever Anthropic's pricing changes, or better, move them to a config table you can update without a deploy). This is what feeds the admin dashboard's API cost panel and the gross-margin estimate.

### Model selection and "faster responses for Pro"

The spec calls for Pro users to get faster AI responses. The cleanest way to implement this without maintaining two separate prompt sets is to route Free-tier requests to a smaller/faster model (e.g. Haiku) for cost control, while Pro requests use the full model (e.g. Sonnet) — this naturally produces a real speed and quality difference tied to membership tier, rather than introducing artificial throttling on the Free tier. Implement this as a single lookup based on `req.user.role` at the top of each route handler, feeding into `anthropicParams.model`.

---

## 9. API endpoint reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | none | Create account, grant 25 signup credits |
| POST | `/api/auth/login` | none (rate-limited by IP) | Issue access + refresh token |
| POST | `/api/auth/refresh` | refresh token | Rotate refresh token, issue new access token |
| POST | `/api/auth/logout` | refresh token | Revoke refresh token |
| POST | `/api/auth/password-reset/request` | none | Email a reset link (always 200, even if email unknown) |
| POST | `/api/auth/password-reset/complete` | reset token | Set new password, revoke all sessions |
| GET | `/api/users/me` | access token | Profile, credit balance, membership status |
| POST | `/api/coach/ask` | access token | AI Coach question (5 credits) |
| POST | `/api/training-plans/generate` | access token | Custom training plan (15 credits) |
| POST | `/api/nutrition/generate` | access token | Nutrition plan (10 credits) |
| POST | `/api/sparring/review` | access token | Sparring video review (20 credits) |
| POST | `/api/opponent/analyze` | access token | Opponent analysis (25 credits) |
| POST | `/api/fight-camp/build` | access token | Fight camp builder (30 credits) |
| GET | `/api/credits/transactions` | access token | Paginated credit transaction history |
| POST | `/api/billing/checkout/subscription` | access token | Create Stripe Checkout session for Pro |
| POST | `/api/billing/checkout/credits` | access token | Create Stripe Checkout session for a credit pack |
| POST | `/api/billing/portal` | access token | Create Stripe Billing Portal session |
| POST | `/api/webhooks/stripe` | Stripe signature | Webhook receiver (see §7) |
| GET | `/api/admin/overview` | admin role | Dashboard summary metrics |
| GET | `/api/admin/revenue-by-day` | admin role | Revenue time series |
| GET | `/api/admin/feature-usage` | admin role | Per-feature usage and cost breakdown |
| GET | `/api/admin/top-spenders` | admin role | Highest API-cost users (abuse + power-user detection) |
| GET | `/api/admin/churn` | admin role | Subscription churn rate |
| GET | `/api/admin/users/:id` | admin role | User lookup |
| POST | `/api/admin/users/:id/adjust-credits` | admin role | Manual credit adjustment, fully audited |

The AI-feature routes all follow the same shape as `route_example_coach.js` — validate input, call `runAiRequest()` with a feature-specific system prompt, shape the response. Building the remaining five (training plans, nutrition, sparring review, opponent analysis, fight camp builder) is mechanical repetition of that one pattern with different prompts and `max_tokens` budgets; I've built out the one in full as the template rather than five near-identical files.

---

## 10. Admin dashboard architecture

Backend: `code/admin/analytics_service.js` + `code/admin/admin_routes.js`.

### What it shows (per the spec)

Total users, active subscribers, monthly revenue, credits sold, credits consumed, Anthropic API costs, and a profit estimate — all filterable by date range.

### A deliberate framing choice: "gross margin," not "profit"

The dashboard computes `revenue − Anthropic API cost` and surfaces it clearly labeled as **gross margin on AI spend**, not "profit." Real profit also has to account for Stripe's processing fees, your infrastructure costs, and payroll — none of which this system tracks. Labeling the number accurately matters here: someone making business decisions off a dashboard that says "profit" when it's actually "revenue minus one cost category" is going to be miscalibrated about how the business is actually doing.

### Scaling the dashboard queries past launch

The queries in `analytics_service.js` are correct and will run fine against real tables at moderate scale, but they aggregate across the entire `ai_requests` and `credit_transactions` tables on every dashboard load. At 100k+ users generating ongoing AI request volume, two changes become worth making once query latency is noticeable (don't do this prematurely — wait until you actually observe slow dashboard loads):

1. **Point these queries at a read replica**, never the primary — an expensive analytics query should never be able to add latency to a real-time credit deduction on the primary database.
2. **Pre-aggregate into a nightly rollup table** (`daily_metrics`, one row per day with the same shape as `getOverviewMetrics()`'s return value, populated by a scheduled job). The dashboard then reads pre-computed rows instead of re-scanning millions of transaction rows on every page load. This is a standard data-warehousing pattern — don't build it on day one, but design the analytics service (as done here, behind a clean function interface) so swapping the implementation later doesn't require touching the routes or the frontend.

### Admin actions are fully audited

Every manual credit adjustment writes to `admin_audit_log` with the acting admin's user id, the target user, the amount, and a required human-readable reason (enforced as a minimum 5-character string in the route handler) — there is no path to silently or anonymously adjusting a user's balance.

---

## 11. Mobile app architecture

The spec describes six screens. Below is the screen-to-API mapping and the state-management pattern that keeps credit balance display correct without excessive polling.

| Screen | Primary API calls | Notes |
|---|---|---|
| **Dashboard** | `GET /api/users/me`, `GET /api/credits/transactions?limit=10` | Shows remaining credits, membership status, recent activity |
| **Store** | `POST /api/billing/checkout/subscription`, `POST /api/billing/checkout/credits` | Both return a Stripe Checkout URL; open in an in-app browser (`SFSafariViewController` on iOS, Custom Tabs on Android) rather than a WebView, since Apple Pay / Google Pay autofill and saved-card autofill work correctly in the native browser context and not reliably inside an embedded WebView |
| **AI Coach** | `POST /api/coach/ask` | Standard chat UI; show the post-request `remainingCredits` from the response to update the displayed balance without a separate fetch |
| **Fight Analysis** | Upload to object storage (S3/GCS) first, then `POST /api/sparring/review` with the resulting URL | Videos should never be uploaded directly through your API server — pre-signed upload URLs straight to S3/GCS keep large file transfer off your API instances entirely |
| **Training Plans** | `POST /api/training-plans/generate` | |
| **Nutrition** | `POST /api/nutrition/generate` | |

### Keeping the displayed credit balance correct

Don't poll `/api/users/me` on a timer to keep the balance fresh — it's wasted load at 100k+ users for a number that only changes when the user themselves takes an action. Instead:

- Every AI-feature response includes `remainingCredits` (see `route_example_coach.js`) — update local state directly from that.
- On returning to the app from the Store's Checkout webview (success or cancel), do one single `GET /api/users/me` refresh — this is the one moment a balance change could have happened outside the app's own knowledge (a webhook just landed).
- That's the entire sync strategy. No websocket, no polling loop — both would be solving a problem that doesn't exist here at meaningful cost.

### Handling `InsufficientCreditsError` consistently

Every AI-feature screen should handle the `402` / `InsufficientCreditsError` response shape the same way: show a single reusable "out of credits" sheet with the required/available counts and a button that deep-links straight to the Store, pre-scrolled to credit packs. Build this once as a shared component, not per-screen — five AI features means five places this exact error can occur.

---

## 12. Security checklist

| Requirement | Where it's implemented |
|---|---|
| JWT authentication | `auth_service.js` (issuance) + `middleware.js` (verification) |
| Refresh token revocation | `refresh_tokens` table, hashed, rotated on every use |
| Password hashing | bcrypt, cost factor 12, `auth_service.js` |
| Account lockout on brute force | `failed_login_count` / `locked_until` in `auth_service.js::loginUser` |
| Login enumeration resistance | Constant-shape error + dummy bcrypt compare for unknown emails |
| API rate limiting | `rate_limit.js`, Redis sliding window, tiered by role |
| Stripe webhook verification | `stripe.webhooks.constructEvent()` in `webhooks.js`, first line of the handler |
| Webhook idempotency | `stripe_webhook_events` unique-constraint dedup |
| Secure credit deduction | Atomic SQL functions, §4 |
| Sensitive data encryption | TLS in transit everywhere (enforced at the load balancer); password hashes and token hashes at rest; database-level encryption at rest (enable on your managed Postgres provider — RDS/Cloud SQL support this as a checkbox, not custom code) |
| Fraud / anti-abuse | Per-tier AI rate limits (§6), refund-clawback with admin flagging on failed clawbacks (§7), top-spender admin report for manual abuse review (§10) |
| Admin action auditing | `admin_audit_log`, every manual adjustment attributed and reasoned |

### What's deliberately NOT included, and why

**CAPTCHA / bot detection on registration** — not in the spec, but worth adding before launch given that signup grants 25 free credits, which is a direct incentive for scripted mass-account-creation abuse. Recommend Cloudflare Turnstile (free, low-friction) on the registration endpoint specifically.

**IP-based geofencing or VPN detection** — not included; only add this if you observe actual abuse patterns that warrant it. Premature anti-abuse tooling adds friction for legitimate users without a demonstrated problem to solve.

---

## 13. Deployment recommendations

**Compute:** containerized API servers (Docker) on ECS Fargate or GKE Autopilot — both give you horizontal autoscaling without managing the underlying VMs. Given the stateless design in §2, scaling out is just "run more containers," with no session-affinity configuration needed.

**Database:** managed Postgres (RDS or Cloud SQL), not self-hosted — at this scale, you want automated backups, point-in-time recovery, and a managed failover story without building it yourself. Provision a read replica from day one of production traffic and route the admin dashboard to it (§10).

**Redis:** managed (ElastiCache or Memorystore) for the rate limiter. This is a small, cheap instance — rate-limit counters are tiny and short-lived.

**Object storage:** S3 or GCS for uploaded fight videos, with pre-signed upload URLs (§11) so large files never transit your API servers.

**Background jobs:** a job queue (BullMQ on Redis, or SQS-backed workers) for anything that shouldn't block a request-response cycle — verification emails, password reset emails, payment-failed dunning notifications, and the nightly reconciliation/rollup jobs from §4 and §10.

**Secrets:** AWS Secrets Manager or GCP Secret Manager for the Anthropic API key, Stripe secret key, JWT signing secrets, and database credentials — injected as environment variables at container start, never baked into the image or committed to source.

**Observability:** structured logging (JSON logs) shipped to CloudWatch/Stackdriver or a dedicated platform (Datadog, Honeycomb); error tracking via Sentry; and dashboards on the `ai_requests` table specifically for Anthropic latency and failure-rate trends, since that's your most operationally critical external dependency.

---

## 14. Scalability notes specific to 100,000+ users

**Database connection pooling.** At this user count, run a connection pooler (PgBouncer, or RDS Proxy if on AWS) between your API servers and Postgres. Each API container shouldn't hold its own large connection pool directly against the database — Postgres has a hard limit on concurrent connections, and a fleet of containers each opening dozens of connections will exhaust it well before you reach 100k users.

**`credit_transactions` table growth.** This table receives a row for every single credit-consuming or credit-granting action, across every user, forever. At meaningful scale this becomes your largest table by row count. Plan to partition it by month (Postgres native table partitioning on `created_at`) once it crosses tens of millions of rows — this keeps both writes and the reconciliation query in §4 fast by letting Postgres skip partitions outside the query's date range, rather than scanning the entire history every time.

**`ai_requests` table growth and retention.** Similarly large. Decide a retention policy up front — e.g., keep full detail for 13 months (covers year-over-year reporting), then roll older rows into a pre-aggregated monthly summary table and drop the row-level detail. This is a business decision as much as a technical one (how far back do you actually need to investigate an individual user's request history), so make it deliberately rather than letting the table grow unbounded by default.

**Stripe webhook processing under load.** A surge of webhook deliveries (e.g. right after a pricing change triggers re-billing across many subscriptions) should never be able to back up your main API request path. Webhooks already run on their own route in this design, but consider moving the actual business-logic execution (everything inside `handleEvent()`) onto a job queue if you observe webhook processing time becoming a bottleneck — acknowledge receipt fast, process asynchronously. Not necessary at launch; worth revisiting if webhook volume becomes substantial.

**Read/write splitting beyond the admin dashboard.** If user-facing read paths (e.g. `GET /api/credits/transactions` history pages) start contributing meaningful load, they're good candidates to also route to a read replica, the same way the admin dashboard does — anything that doesn't need to read its own immediately-prior write can tolerate replica lag.

---

## 15. What to build first

Given everything above, a sane build order:

1. **Database schema + atomic credit functions** (§3, §4) — everything else depends on this being correct first.
2. **Auth** (registration, login, JWT, password reset) — `code/auth/`.
3. **Credit service + one real AI feature end-to-end** (AI Coach, since it's the simplest) — proves out the full flow in §5 before replicating it across the other five features.
4. **Stripe integration** (checkout + webhooks) — this is what actually lets credits and Pro membership be purchased; nothing else matters commercially until this works.
5. **The remaining five AI features**, each a mechanical repeat of step 3's pattern.
6. **Admin dashboard** — you can run the business without it for a short while by querying the database directly, but build it before you have enough volume that manual SQL queries become impractical.
7. **Rate limiting + abuse hardening** (§6, §12) — important before any public launch, not after.
