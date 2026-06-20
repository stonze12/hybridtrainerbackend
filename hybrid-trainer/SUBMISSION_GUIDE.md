# Hybrid Trainer — iOS App Store Submission Guide
## From this folder to the App Store in 7 steps

---

## What's in this package

```
hybrid-trainer/
├── www/
│   └── index.html          ← Your complete app (all 8 tabs, 4275 lines)
├── ios/
│   └── App/
│       ├── App.xcodeproj   ← Open this in Xcode
│       └── App/
│           ├── Info.plist          ← Privacy strings, permissions
│           ├── AppDelegate.swift   ← iOS entry point
│           └── Assets.xcassets/
│               ├── AppIcon.appiconset/  ← 1024×1024 Exit Compass icon
│               └── Splash.imageset/    ← Launch screen image
├── capacitor.config.json   ← Capacitor settings
├── package.json
└── SUBMISSION_GUIDE.md     ← This file
```

---

## What you need before starting

| Requirement | Where to get it | Cost |
|---|---|---|
| **Mac with Xcode 15+** | Mac App Store (free) | Free |
| **Apple Developer Account** | developer.apple.com | $99/year |
| **Anthropic API Key** | console.anthropic.com | Pay-per-use (~$5 free credit) |
| **Node.js 18+** | nodejs.org | Free |

---

## Step 1 — Set up your Mac

```bash
# Install Node.js if not already installed (nodejs.org)
# Then install Capacitor CLI:
npm install -g @capacitor/cli

# Install Xcode from the Mac App Store (it's large, ~7GB — start this first)
```

---

## Step 2 — Copy this project to your Mac

Transfer the `hybrid-trainer` folder to your Mac. You can:
- Download from Claude's file output and unzip
- AirDrop the zip to your Mac
- Use a USB drive or cloud storage

Then open Terminal and navigate into the folder:
```bash
cd /path/to/hybrid-trainer
npm install
```

---

## Step 3 — Open in Xcode

```bash
npx cap open ios
```

This opens `ios/App/App.xcodeproj` in Xcode automatically.

**In Xcode:**

1. Click the **App** project in the left sidebar (the top blue icon)
2. Under **TARGETS → App → General:**
   - **Bundle Identifier:** `com.hybridwarfare.trainer` (or change to your own, e.g. `com.yourname.hybridtrainer`)
   - **Version:** `1.0`
   - **Build:** `1`
   - **Minimum Deployments:** iOS 16.0
3. Under **Signing & Capabilities:**
   - Check **Automatically manage signing**
   - Select your **Team** (your Apple Developer account)
   - Xcode will generate provisioning profiles automatically

---

## Step 4 — Add HealthKit capability (optional but recommended)

In Xcode → App target → **Signing & Capabilities** → **+ Capability** → search for **HealthKit** → Add.

This enables the workout logging to Apple Health feature.

---

## Step 5 — Build and test on your iPhone

1. Connect your iPhone via USB (or use a Simulator)
2. Select your device in the top toolbar
3. Press **⌘R** (Run) to build and install
4. The app should launch with the dark teal UI and Exit Compass splash screen

**Common first-run issues:**
- *"iPhone is not trusted"* — on your iPhone, go to Settings → General → VPN & Device Management → trust your developer certificate
- *"Bundle identifier already in use"* — change the Bundle Identifier to something unique

---

## Step 6 — TestFlight beta (highly recommended before App Store)

1. In Xcode: **Product → Archive**
2. When the Organizer opens, click **Distribute App**
3. Choose **TestFlight & App Store Connect**
4. Follow prompts to upload to App Store Connect
5. In **App Store Connect** (appstoreconnect.apple.com):
   - Find your build under TestFlight
   - Add testers by email (they get a link to install via the TestFlight app)
   - Test on real devices before submitting

---

## Step 7 — App Store submission

In App Store Connect, create a new app:

**App Information:**
- Name: `Hybrid Trainer`
- Subtitle: `Hybrid Warfare Muay Thai System`
- Bundle ID: `com.hybridwarfare.trainer`
- Category: **Health & Fitness** (primary) / Sports (secondary)
- Age Rating: **4+** (no restricted content)

**Privacy Policy URL:** Required — create one at termly.io (free) covering:
- Camera access (video analysis, meal photos)
- Local storage (no server-side user data)
- Anthropic API calls (user's own API key, never stored by you)

**Description (suggested):**

> The Hybrid Trainer is the official companion app for The Art of Hybrid Warfare — a complete Muay Thai system fusing the footwork geometry of Vasyl Lomachenko, the forward pressure of Buakaw Banchamek, and the creative misdirection of Saenchai.
>
> WHAT'S INSIDE:
> • All 18 signature combinations with strike sequences, coaching notes, and mandatory exit rules
> • 12 solo training drills — shadowboxing protocols and heavy bag work
> • Round timer with Muay Thai presets (3×5, 2×6, 30s blast rounds)
> • 12-week foundation program + 24-week extended program
> • AI coach trained on the book's full system (your API key required)
> • Video analysis — upload a technique clip for scored, system-specific feedback
> • Opponent scout — upload opponent footage for AI-generated game plans
> • Nutrition tracking with Mifflin-St Jeor TDEE calculation, 4 goal paths (cut, maintain, recomp, lean build), barcode lookup, and meal photo analysis
> • XP progression system with 11 levels, daily challenges, and streak tracking

**Keywords:** muay thai, boxing training, martial arts, MMA, combat sports, technique, striking, fitness tracker, workout, nutrition

**Screenshots required:**
- 6.7" iPhone (iPhone 14 Pro Max): 1290×2796px — 3–10 screenshots
- 5.5" iPhone (iPhone 8 Plus): 1242×2208px — same
- You can capture these directly from the Simulator in Xcode (⌘S)

---

## App Store Review — things to know

**What Apple checks:**
- Your privacy policy must accurately describe all data collection
- Camera and microphone usage descriptions in Info.plist must match actual usage (already done in this build)
- The app must work without a network connection for core features (the combo library, drills, timer, and workout tracker all work offline — ✓)
- In-app purchase rules: if you charge for the AI features separately in-app, Apple takes 30%. The current build uses the user's own API key, which sidesteps this entirely.

**Review timeline:** Usually 1–3 days for first submission, faster for updates.

---

## After approval — updating the app

When you update `www/index.html` (adding features, fixing bugs):

```bash
# From the hybrid-trainer folder on your Mac:
npx cap sync ios    # copies updated www/ into the iOS project
# Then open Xcode, increment Build number, Archive, and upload
```

---

## Your API key setup

The AI features (Coach, Video Analysis, Opponent Scout, Meal Photo Analysis) require an Anthropic API key. The current architecture has users enter their own key in the Coach tab — this means:

- No server costs for you
- No App Store in-app purchase complications
- Users with no key still get the full offline app (combos, drills, timer, workout, nutrition tracking, gamification)

**If you want to hide the API key requirement** (everyone gets AI for free, you pay):
1. Deploy `worker.js` to Cloudflare Workers (see PHASE2_NOTES.md)
2. In `www/index.html`, change the fetch URL from `https://api.anthropic.com/v1/messages` to your worker URL
3. Remove the API key setup card from the Coach, Analyze, and Nutrition tabs

At current model pricing (~$3 per million tokens input, $15 per million output), a typical user session costs well under $0.01. 1,000 active users at 5 AI queries/day ≈ ~$150/month.
