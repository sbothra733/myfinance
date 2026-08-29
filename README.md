# MyFinance — standalone deployment

This is the independently-hosted version of MyFinance. It no longer depends on Claude.ai for
anything — accounts, saved data, and share price lookups are all handled by your own Supabase
project and a small serverless function.

**Stack:** React (Vite) on Vercel · Auth + Postgres on Supabase · Share lookups via a Supabase
Edge Function calling Finnhub.

**Estimated cost:** $0/month to start (both platforms' free tiers), up to ~$25/month if you
outgrow Supabase's free tier (Vercel's free tier is generous for a personal/demo app and you're
unlikely to need to pay there unless traffic gets serious).

---

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up → **New project**.
2. Pick a name, a database password (save it somewhere), and a region close to you.
3. Once it's created, go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key
4. Go to **SQL Editor → New query**, paste in the contents of `supabase/schema.sql` from this
   project, and run it. This creates the `accounts` table and locks it down so each user can only
   ever see their own rows (Row Level Security).
5. Go to **Authentication → Providers** and make sure **Email** is enabled (it is by default).
6. Go to **Authentication → Settings** → decide whether to require **Confirm email** before
   login:
   - **On** (default, recommended for anything real people will use) — new users get a
     confirmation email before they can log in.
   - **Off** — signups work immediately with no email step, simplest for a quick demo, but means
     anyone can register with an email they don't own.

## 2. Get a Finnhub API key (for share price lookups)

1. Go to [finnhub.io](https://finnhub.io/register) → sign up (free).
2. Copy your API key from the dashboard.
3. Free tier covers 60 requests/minute for real-time US stock quotes — plenty for personal or
   small group use.

## 3. Deploy the Edge Function

This keeps your Finnhub key on the server, never exposed in the browser.

```bash
npm install -g supabase
supabase login
cd myfinance-standalone
supabase link --project-ref YOUR_PROJECT_REF   # found in your Supabase project's URL/settings
supabase secrets set FINNHUB_API_KEY=your_finnhub_key_here
supabase functions deploy lookup-share
```

If you'd rather not install the Supabase CLI, you can also paste the contents of
`supabase/functions/lookup-share/index.ts` into a new Edge Function directly from the Supabase
dashboard (**Edge Functions → New function**), then set `FINNHUB_API_KEY` under
**Edge Functions → Manage secrets**.

## 4. Configure and run locally

```bash
cp .env.example .env
```

Edit `.env` and fill in the Project URL and anon key from Step 1:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

Then:

```bash
npm install
npm run dev
```

Open the local URL it prints, sign up, and confirm the app loads, saves, and (if you did Step 3)
looks up a share price correctly before moving on to hosting it publicly.

## 5. Push to GitHub

Vercel deploys straight from a GitHub repo.

```bash
git init
git add .
git commit -m "Initial standalone MyFinance app"
```

Create a new repository on GitHub, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/myfinance.git
git branch -M main
git push -u origin main
```

**Important:** `.env` is already excluded via `.gitignore` in this project — don't remove that,
since it holds your Supabase keys. (The anon key is safe to expose in the browser bundle by
design — Row Level Security is what actually protects your data — but there's no reason to also
commit it to a public repo.)

## 6. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → sign up (free) → **Add New → Project**.
2. Import the GitHub repo you just pushed.
3. Vercel auto-detects Vite — leave the build settings as-is.
4. Before deploying, add your environment variables under **Environment Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Click **Deploy**.

You'll get a live URL like `myfinance-yourname.vercel.app` within a minute or two. That's your
permanent, independently-hosted app — share that link with anyone.

Every time you `git push` to `main` afterward, Vercel automatically redeploys.

## 7. (Optional) Add your own domain later

Once you own a domain: Vercel project → **Settings → Domains** → add it → follow the DNS
instructions Vercel gives you (usually one CNAME record). No code changes needed.

---

## What changed from the Claude-artifact version

- **Auth & storage**: `window.storage` and the custom SHA-256 password hashing are gone —
  replaced by Supabase Auth (real sessions, password reset support out of the box) and a Postgres
  `accounts` table with Row Level Security.
- **Sessions now persist across reloads** (a genuine improvement) — the old version required
  logging in every single time; Supabase keeps you signed in until you explicitly log out.
- **Share price lookups** now hit Finnhub through your own Edge Function instead of an
  Anthropic API call that only worked inside Claude's artifact sandbox. Dividend data quality may
  differ slightly — Finnhub's free-tier dividend endpoint is more limited than the AI-driven web
  search the old version used, so double-check any dividend figure that looks off.
- **Everything else — every calculation, every tab, every projection — is untouched.** The
  financial logic itself never depended on Claude at all, so none of it needed to change.

## Known limitations of this version

- No password-reset email flow is wired up in the UI yet (Supabase supports it — `supabase.auth.resetPasswordForEmail()` — this would be a follow-up addition, not currently in `App.jsx`).
- The Import/Export JSON feature still works exactly as before, useful for moving a profile between accounts or as a manual backup.
- Google Drive / AgentMail integrations from earlier in this project's history were things *I* (Claude) did directly in conversation, not features the running app itself calls — they have no equivalent here and weren't part of the app's code to begin with.
