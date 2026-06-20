# Deploying Hybrid Trainer API — Supabase + Render (Starter, $7/mo)

Part 1 (Supabase) is unchanged from the earlier walkthrough — set that up first if you haven't already. This replaces Part 2 with Render's **paid Starter tier** specifically, which is the one that stays always-on with no cold starts. The free tier sleeps after 15 minutes of inactivity with a 30-60 second wake-up delay on the next request; Starter ($7/month) removes that entirely.

You'll need: your Supabase connection string from Part 1, a Stripe account, your Anthropic API key, and a credit card for Render (required even though you're paying — Render won't run a Starter service without one on file).

---

## Part 2 — Render

Unlike Fly.io, Render's whole flow happens in the web dashboard — no CLI required, though one exists if you want it later.

### 2.1 Push your code to GitHub

Render deploys from a GitHub (or GitLab) repo, not a zip upload or local folder push.

```bash
cd hybrid-trainer-backend
git init
git add .
git commit -m "Initial backend"
gh repo create hybrid-trainer-api --private --source=. --push
```

No `gh` CLI? Create an empty repo on github.com first, then `git remote add origin <url>` and `git push -u origin main`.

### 2.2 Create the Web Service

1. Go to dashboard.render.com, sign up or log in (GitHub sign-in is easiest, since it simplifies the next step).
2. **New** → **Web Service**.
3. Connect your GitHub account if you haven't, then select the `hybrid-trainer-api` repo.
4. Render auto-detects it's a Node app from `package.json`. Confirm these settings:
   - **Name**: whatever you want the service called (shows up in the default URL, e.g. `hybrid-trainer-api.onrender.com`).
   - **Region**: pick one close to your Supabase project's region — same latency reasoning as always.
   - **Branch**: `main`.
   - **Build Command**: `npm install` (Render usually fills this in correctly already).
   - **Start Command**: `node src/server.js`.
   - **Instance Type**: this is the critical one — select **Starter ($7/month)**, not Free. This is what removes the sleep behavior.
5. Don't click "Create Web Service" yet — go to the next step first, since the app will crash-loop without its environment variables and you'd just be watching failed deploys.

### 2.3 Set environment variables

Still on the creation screen (or afterward, under your service → **Environment** tab if you already created it), add each of these under **Environment Variables**:

```
DATABASE_URL=postgresql://postgres.xxxx:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
REDIS_URL=redis://default:password@your-instance.upstash.io:6379
JWT_ACCESS_SECRET=<generate with: openssl rand -hex 64>
JWT_REFRESH_SECRET=<generate a DIFFERENT one the same way>
ANTHROPIC_API_KEY=sk-ant-your-key-here
STRIPE_SECRET_KEY=sk_test_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_pending
STRIPE_PRICE_PRO_MONTHLY=price_xxx
STRIPE_PRICE_PACK_500=price_xxx
STRIPE_PRICE_PACK_1200=price_xxx
STRIPE_PRICE_PACK_3000=price_xxx
STRIPE_PRICE_PACK_10000=price_xxx
APP_URL=https://your-frontend-domain.com
ALLOWED_ORIGINS=https://your-frontend-domain.com
```

Notes specific to this step:

- `DATABASE_URL` is the Supabase **pooler** connection string from Part 1 — port 6543, not 5432.
- Run `openssl rand -hex 64` twice on your own machine's terminal for the two JWT secrets — they need to be two genuinely different values, not the same string reused.
- `STRIPE_WEBHOOK_SECRET` is a placeholder for now. Same chicken-and-egg issue as always: Stripe needs your live Render URL before it'll give you the real signing secret, and you don't have that URL until after your first deploy. You'll fix this in step 2.5.
- You do **not** need to set `PORT` — Render injects this automatically, and `server.js` already reads `process.env.PORT` correctly.
- Unlike Fly's `fly secrets set`, there's no separate "apply" step — saving variables here and deploying are part of the same flow once you hit Create/Deploy.

### 2.4 Deploy

Click **Create Web Service** (or **Save Changes** → **Manual Deploy** if you added variables after creating it). Render pulls your repo, runs `npm install`, and starts the service. Watch the **Logs** tab during this first deploy — if it crash-loops, it's almost always a missing or malformed environment variable, and `server.js`'s fail-fast check will name exactly which one in the log output.

### 2.5 Verify it's live

Once the deploy shows **Live** (green), your service has a URL at the top of the dashboard page, something like `https://hybrid-trainer-api.onrender.com`. Visit `https://your-service-name.onrender.com/health` — you should see:

```json
{"status":"ok","timestamp":"..."}
```

Reload that page a few times over the next minute or two — confirm the response time stays fast and consistent. On the free tier you'd see a slow first load after idling; on Starter, it should be quick every time, since the instance never spins down.

### 2.6 Finish the Stripe webhook setup

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**.
2. Endpoint URL: `https://your-service-name.onrender.com/api/webhooks/stripe`
3. Select events: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
4. Copy the **Signing secret** Stripe shows you.
5. Back in Render, go to your service → **Environment**, update `STRIPE_WEBHOOK_SECRET` with the real value, and save — this triggers an automatic redeploy with the new secret applied.

### 2.7 Test end to end

```bash
curl -X POST https://your-service-name.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","username":"testuser","password":"SomethingSecure123"}'

curl -X POST https://your-service-name.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SomethingSecure123"}'
```

Take the `accessToken` from the login response:

```bash
curl https://your-service-name.onrender.com/api/users/me \
  -H "Authorization: Bearer <paste accessToken here>"
```

You should see 25 credits and `membership_type: "free"`. For Stripe testing, use card number `4242 4242 4242 4242`, any future expiry, any CVC, while you're still on your `sk_test_...` key.

---

## Redeploying after code changes

Render auto-deploys on every push to your connected branch by default — `git push` to `main` and it picks it up on its own, no separate command needed. You can turn this off in **Settings** → **Build & Deploy** if you'd rather trigger deploys manually from the dashboard instead.

## Why Starter specifically, not Free

Render's free web services spin down after 15 minutes with no traffic, and the next request has to wait 30-60 seconds while it cold-starts. For most apps that's a minor annoyance; for this one specifically it's worse than usual, because Stripe webhooks land on this exact server — a payment succeeding while the instance is asleep means Stripe either times out waiting or the user sees their credits not show up immediately after paying. Your webhook idempotency table (`stripe_webhook_events`) means a retried webhook still resolves correctly either way, but a real person who just paid you and is staring at an unchanged balance for 30+ seconds is the actual cost of running this on the free tier. Starter's $7/month removes that scenario entirely — the instance never sleeps, so there's no cold start to wait out.

## Common issues

**Build succeeds, deploy fails / crash-loops** → check **Logs** in the dashboard first. Almost always a missing or wrong environment variable — the fail-fast check in `server.js` will say exactly which one.

**"Port scan timeout" error on deploy** → Render expects your app to bind to the `PORT` env var it provides, which `server.js` already does correctly (`process.env.PORT || 3000`, bound to `0.0.0.0`). If you see this error, double check you didn't accidentally hardcode a different port somewhere.

**Database connection errors in logs** → same as always: confirm you're using the Supabase **pooler** string (port 6543), and that the password in the connection string is your real database password, not the literal `[YOUR-PASSWORD]` placeholder text.

**Wrong instance type billed** → if you started on Free and want to switch to Starter (or vice versa), it's under your service → **Settings** → **Instance Type** — changing it takes effect on the next deploy, no need to recreate the service.
