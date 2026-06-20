# Deploying to Fly.io — Step by Step

This assumes you've already set up Supabase (Postgres) following the earlier walkthrough, have an Upstash Redis instance, a Stripe account, and your Anthropic API key. This covers getting the Node server itself running continuously on Fly.io.

Unlike Railway, Fly.io's main interface is a CLI (`flyctl`) rather than a web dashboard for most setup steps — you'll still use the web dashboard for a couple of things (viewing logs, secrets), but app creation and deploys happen from your terminal.

---

## 1. Install the Fly CLI and log in

```bash
curl -L https://fly.io/install.sh | sh
```

(Windows: use the PowerShell command on fly.io/docs/flyctl/install — the steps after this are identical either way.)

Restart your terminal, then:

```bash
fly auth login
```

This opens a browser to log in or create a Fly.io account. You'll need a credit card on file even to use the free allowance — Fly requires this to prevent abuse, but you won't be charged as long as you stay within the free allowance (one shared-cpu-1x VM with 256MB, or this app's slightly larger 512MB config, generally still fits within what's covered for a single always-on app at this scale).

---

## 2. Launch the app

From inside your project folder (the unzipped `hybrid-trainer-backend`):

```bash
fly launch
```

This reads your `Dockerfile` and `fly.toml` and asks you a series of questions:

- **"Would you like to copy its configuration to the new app?"** → Yes, use the existing `fly.toml`.
- **App name** → accept the default or pick your own (must be globally unique across all Fly users — if `hybrid-trainer-api` is taken, try `hybrid-trainer-api-yourname`).
- **Region** → pick whichever is closest to your Supabase project's region (set back when you created the Supabase project) — keeping the database and server geographically close reduces query latency.
- **"Would you like to set up a Postgresql database now?"** → **No** — you already have Supabase.
- **"Would you like to set up an Upstash Redis database now?"** → **No** — you already have Upstash, or say yes here if you haven't created one yet and want Fly to provision it for you instead (either works; this walkthrough assumes you're bringing your own).
- **"Would you like to deploy now?"** → **No** — you need to set your secrets first, or the app will crash on boot (remember `server.js` deliberately fails fast on missing environment variables).

This creates the app on Fly's side but doesn't deploy yet.

---

## 3. Set your secrets

Fly's equivalent of Railway's "Variables" tab is `fly secrets set`. Run each of these from your terminal, filling in your real values:

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

A few notes specific to this step:

- The `$(openssl rand -hex 64)` inline commands generate the two JWT secrets directly into the `fly secrets set` call — you don't need to run them separately first. Run each line separately so you actually get two *different* random values, not the same one twice.
- `STRIPE_WEBHOOK_SECRET` is set to a placeholder (`whsec_pending`) for now — same chicken-and-egg problem as Railway: Stripe needs your live URL before it can give you the real webhook secret, and you don't have a live URL until after your first deploy. You'll update this in step 6.
- You don't need to set `PORT` — Fly's `fly.toml` already specifies `internal_port = 3000`, and your `server.js` defaults to 3000 if `PORT` isn't set, so these already agree.
- Setting a secret does **not** automatically redeploy on Fly the way saving a Railway variable does — you'll deploy explicitly in the next step.

You can verify what's set (values are hidden, only names shown) with:

```bash
fly secrets list
```

---

## 4. Deploy

```bash
fly deploy
```

This builds your `Dockerfile` (Fly builds it remotely on their infrastructure by default, so you don't need Docker installed locally) and deploys it. Watch the output — if the build succeeds but the deploy's health check fails repeatedly, that almost always means the app is crashing on boot, most commonly from a missing or malformed secret. Check logs with:

```bash
fly logs
```

The error from `server.js`'s fail-fast check (`Missing required environment variables: ...`) will tell you exactly which one to fix if that's the issue.

---

## 5. Verify it's live

```bash
fly status
```

This shows your app's URL, something like `https://hybrid-trainer-api.fly.dev`. Visit `https://your-app-name.fly.dev/health` in a browser — you should see:

```json
{"status":"ok","timestamp":"..."}
```

---

## 6. Finish the Stripe webhook setup

Same as the Railway walkthrough, just with your new `.fly.dev` URL:

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**.
2. Endpoint URL: `https://your-app-name.fly.dev/api/webhooks/stripe`
3. Select events: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
4. Copy the **Signing secret** (`whsec_...`) Stripe shows you.
5. Update the real value on Fly:
   ```bash
   fly secrets set STRIPE_WEBHOOK_SECRET="whsec_the_real_value_here"
   ```
   This triggers an automatic redeploy with the new secret applied.

---

## 7. Test end to end

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

Fly's free allowance is most generous when machines are allowed to stop when idle and restart on the next request — but this app receives Stripe webhooks, and a webhook arriving while your machine is stopped means Stripe sees a slow response (while Fly cold-starts your container) or a timeout, triggering a retry. Your webhook idempotency table handles retries correctly either way, but a user who just paid and is staring at their credit balance not updating for the 10-30 seconds a cold start can take is a bad first impression.

`fly.toml` in this project is set to `auto_stop_machines = false` / `min_machines_running = 1` specifically to avoid this — your one machine stays running continuously rather than scaling to zero. This uses more of your free allowance than a scale-to-zero config would, but for an app that needs to reliably receive webhooks, it's the right tradeoff. If you later want to reduce cost and can tolerate occasional webhook latency, this is the setting to revisit.

---

## Common issues

**Build succeeds, deploy fails health checks** → almost always a missing/wrong secret. `fly logs` will show the exact crash reason.

**"App name already taken"** during `fly launch` → pick a different name; Fly app names are globally unique across all users, like a subdomain.

**Database connection errors in logs** → double check you copied the Supabase **pooler** connection string (port 6543), not the direct one (port 5432) — see the earlier Supabase walkthrough. Also confirm the password in the connection string is your actual database password, not the placeholder `[YOUR-PASSWORD]` text.

**Redeploying after code changes** → just run `fly deploy` again from your project folder any time you push new code changes; there's no separate "connect to git" step the way Railway auto-deploys from a repo — Fly deploys whatever's in your local folder (or your CI pipeline, if you set one up later) at the moment you run the command.
