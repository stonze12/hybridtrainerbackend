# Deploying Hybrid Trainer API — Supabase + Fly.io

Two pieces, set up in order: **Supabase** for Postgres (your database), then **Fly.io** for the Node server itself (the actual running app). Do them in this order — Fly.io's setup needs your Supabase connection string as one of its secrets, so the database has to exist first.

You'll also want a Stripe account and your Anthropic API key ready before step 2 of the Fly.io section.

---

## Part 1 — Supabase (Postgres)

### 1.1 Create the project

Go to supabase.com, sign in with GitHub, click **New Project**. Pick an org, name it something like `hybrid-trainer-db`, and set a database password — **save this password somewhere**, Supabase won't show it to you again after this screen. Pick a region — ideally one that's also close to wherever you'll run Fly.io in Part 2, since you'll pick a matching Fly region there. Click **Create new project** and wait roughly 2 minutes while it provisions.

### 1.2 Run your schema

Once the project is ready, open **SQL Editor** in the left sidebar → **New query**. Open `src/db/schema.sql` from your project folder, paste the entire contents in, and click **Run**. Then open a second new query and do the same for `src/db/credit_functions.sql` — it has to run second, since it references tables the first file creates.

If something errors partway through, the most common cause is running them out of order, or running `schema.sql` twice (it fails on `CREATE TYPE` since the types already exist from the first run). If you need to start over, it's easiest to delete the project and create a fresh one rather than trying to manually unwind partial state.

If you hit a permissions error specifically on the `CREATE EXTENSION "uuid-ossp"` or `"pgcrypto"` lines near the top of `schema.sql`, go to **Database** → **Extensions** in the sidebar, enable both manually, then re-run the rest of the script.

### 1.3 Verify the tables exist

Click **Table Editor** in the sidebar. You should see `users`, `subscriptions`, `credit_purchases`, `credit_transactions`, `ai_requests`, `stripe_webhook_events`, `admin_audit_log`, and a couple others. If they're all there, the schema applied correctly.

### 1.4 Get your connection string

Go to **Project Settings** (gear icon) → **Database**. Under **Connection string**, switch to the **URI** tab. You'll see something like:

```
postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

Replace `[YOUR-PASSWORD]` with the database password from step 1.1. **Use this pooler connection string (port 6543), not the direct connection (port 5432).** The pooler is built for exactly the situation your app is in — many short-lived connections from a server, rather than one long-lived connection — and Supabase's free-tier direct connections are limited and will exhaust quickly under normal app traffic.

Keep this full string handy — it becomes your `DATABASE_URL` secret in Part 2, step 2.3.

This is also a good moment to set up **Upstash** for Redis if you haven't already (separate from Supabase, but needed for the same secrets step in Part 2) — create a free database at upstash.com and copy its connection string from the dashboard's **Details** tab, in the `ioredis`-compatible format.

---

## Part 2 — Fly.io (the Node server)

Fly's main interface is a CLI (`flyctl`) rather than a web dashboard for most setup — app creation and deploys happen from your terminal, though you'll still use the web dashboard occasionally for things like viewing billing.

### 2.1 Install the Fly CLI and log in

```bash
curl -L https://fly.io/install.sh | sh
```

(Windows: use the PowerShell command on fly.io/docs/flyctl/install — everything after this step is identical either way.)

Restart your terminal, then:

```bash
fly auth login
```

This opens a browser to log in or create a Fly.io account. You'll need a credit card on file even to use the free allowance — Fly requires this to prevent abuse, but you won't be charged as long as you stay within it (one always-on shared-cpu VM at this app's size generally fits within what's covered).

### 2.2 Launch the app

From inside your project folder (the unzipped `hybrid-trainer-backend`):

```bash
fly launch
```

This reads your `Dockerfile` and `fly.toml` and asks a series of questions:

- **"Would you like to copy its configuration to the new app?"** → Yes, use the existing `fly.toml`.
- **App name** → accept the default or pick your own (must be globally unique across all Fly users — if `hybrid-trainer-api` is taken, try `hybrid-trainer-api-yourname`).
- **Region** → pick whichever is closest to your Supabase project's region from Part 1.1 — keeping the database and server geographically close reduces query latency.
- **"Would you like to set up a Postgresql database now?"** → **No** — you already have Supabase.
- **"Would you like to set up an Upstash Redis database now?"** → **No** — you already have Upstash from Part 1.4.
- **"Would you like to deploy now?"** → **No** — secrets need to be set first, or the app will crash on boot (`server.js` deliberately fails fast on missing environment variables).

This creates the app on Fly's side without deploying yet.

### 2.3 Set your secrets

Fly's equivalent of a "Variables" dashboard tab is `fly secrets set`, run from your terminal:

```bash
fly secrets set DATABASE_URL="postgresql://postgres.xxxx:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
fly secrets set REDIS_URL="redis://default:password@your-instance.upstash.io:6379"
fly secrets set JWT_ACCESS_SECRET="$(openssl rand -hex 64)"
fly secrets set JWT_REFRESH_SECRET="$(openssl rand -hex 64)"
fly secrets set ANTHROPIC_API_KEY="sk-ant-your-key-here"
fly secrets set STRIPE_SECRET_KEY="sk_test_your_key_here"
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_pending"
fly secrets set STRIPE_PRICE_PRO_MONTHLY="price_xxx"
fly secrets set STRIPE_PRICE_PACK_500="price_xxx"
fly secrets set STRIPE_PRICE_PACK_1200="price_xxx"
fly secrets set STRIPE_PRICE_PACK_3000="price_xxx"
fly secrets set STRIPE_PRICE_PACK_10000="price_xxx"
fly secrets set APP_URL="https://your-frontend-domain.com"
fly secrets set ALLOWED_ORIGINS="https://your-frontend-domain.com"
```

The `DATABASE_URL` here is exactly the connection string you assembled in Part 1.4. The Stripe Price IDs come from creating your Products in the Stripe Dashboard (**Product catalog** → create "Pro Membership" at $14.99/month recurring, plus four one-time-price products for the $4.99/$9.99/$19.99/$49.99 credit packs) — copy each resulting `price_...` ID.

A few notes specific to this step:

- The `$(openssl rand -hex 64)` inline commands generate the two JWT secrets directly into the `fly secrets set` call. Run each line separately so you get two genuinely *different* random values, not the same one twice.
- `STRIPE_WEBHOOK_SECRET` is a placeholder for now — Stripe needs your live Fly URL before it can give you the real webhook signing secret, and you don't have that URL until after your first deploy. You'll fix this in step 2.6.
- You don't need to set `PORT` — `fly.toml` already specifies `internal_port = 3000`, matching `server.js`'s default.
- Setting a secret does **not** auto-redeploy the way saving a value in some dashboards does — you deploy explicitly in the next step.

Verify what's set (values are hidden, only names shown):

```bash
fly secrets list
```

### 2.4 Deploy

```bash
fly deploy
```

This builds your `Dockerfile` remotely on Fly's infrastructure (no local Docker install needed) and deploys it. If the build succeeds but the deploy's health check fails repeatedly, the app is almost certainly crashing on boot — check why with:

```bash
fly logs
```

The fail-fast check in `server.js` will name the exact missing/wrong secret if that's the cause.

### 2.5 Verify it's live

```bash
fly status
```

This shows your app's URL, something like `https://hybrid-trainer-api.fly.dev`. Visit `https://your-app-name.fly.dev/health` in a browser — you should see:

```json
{"status":"ok","timestamp":"..."}
```

### 2.6 Finish the Stripe webhook setup

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**.
2. Endpoint URL: `https://your-app-name.fly.dev/api/webhooks/stripe`
3. Select events: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
4. Copy the **Signing secret** (`whsec_...`) Stripe shows you.
5. Set the real value on Fly:
   ```bash
   fly secrets set STRIPE_WEBHOOK_SECRET="whsec_the_real_value_here"
   ```
   This triggers an automatic redeploy with the new secret applied.

### 2.7 Test end to end

```bash
curl -X POST https://your-app-name.fly.dev/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"testuser","password":"SomethingSecure123"}'

curl -X POST https://your-app-name.fly.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SomethingSecure123"}'
```

Take the `accessToken` from the login response and check your profile:

```bash
curl https://your-app-name.fly.dev/api/users/me \
  -H "Authorization: Bearer <paste accessToken here>"
```

You should see 25 credits and `membership_type: "free"`. For Stripe testing, use card number `4242 4242 4242 4242`, any future expiry, any CVC, while you're still on your `sk_test_...` key.

---

## Why `auto_stop_machines = false` in `fly.toml` matters for this app specifically

Fly's free allowance stretches further when machines are allowed to stop when idle and restart on the next request — but this app receives Stripe webhooks, and a webhook arriving while your machine is stopped means either a slow response while Fly cold-starts your container, or an outright timeout. Your webhook idempotency table (`stripe_webhook_events`) handles Stripe's retry correctly either way, but a real user staring at a credit balance that hasn't updated for the 10-30 seconds a cold start can take is a bad experience right after they've just paid you.

`fly.toml` in this project sets `auto_stop_machines = false` and `min_machines_running = 1` specifically to avoid this — your machine stays running continuously rather than scaling to zero. This uses more of your free allowance than a scale-to-zero config would, but for an app that needs to reliably receive webhooks, it's the right tradeoff. Revisit this setting later if you want to trade some reliability for a smaller footprint.

---

## Common issues

**Build succeeds, deploy fails health checks** → almost always a missing or wrong secret. `fly logs` will show the exact crash reason.

**"App name already taken"** during `fly launch` → pick a different name; Fly app names are globally unique across all users, like a subdomain.

**Database connection errors in logs** → double check you copied the Supabase **pooler** connection string (port 6543), not the direct one (port 5432), and that the password in the string is your real database password, not the literal placeholder text `[YOUR-PASSWORD]`.

**Redeploying after code changes** → run `fly deploy` again from your project folder any time you change code. There's no separate "connect to git" step the way some platforms auto-deploy from a repo — Fly deploys whatever's in your local folder (or your CI pipeline, if you set one up later) at the moment you run the command.
