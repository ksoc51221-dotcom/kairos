# Kairos public links: set-up guide

A normal Kairos link (`http://localhost:4747/v/…`) only opens on your Mac. A **public link** opens on any phone or computer, even when your Mac is asleep.
It costs nothing and needs **no credit card**:

```
Kairos (your Mac) ──upload on your click──▶ Backblaze B2 (private bucket, free 10 GB)
                                                    ▲ read-only key
Viewer's phone ─────────────────────────▶ Cloudflare Worker (free, this folder) ──▶ page + video
```

Only the small video copy and its title leave your Mac, and only when you press **Publish** on a video. Each copy is deleted after 30 days.
Recordings marked **Private** (or "Ask for email") can never be published. Allow about 20 minutes the first time.

> If Backblaze or Cloudflare asks for a credit card at any step, **stop**. That means a step went differently from this guide. Nothing here needs one.

## Part A: Backblaze (storage)

1. Go to **backblaze.com**, choose **B2 Cloud Storage → Sign Up**, and create an account. Verify your email.
2. **Buckets → Create a Bucket.** Name it something unique, for example `kairos-yourname-4821`. Set **Files in Bucket are: Private**. Leave encryption and Object Lock off.
3. Open the bucket → **Lifecycle Settings → Use custom lifecycle rules → Add rule**: File Path `p/`, Days Till Hide `31`, Days Till Delete `1`. (A safety net: even if Kairos is offline for a month, the copies still disappear.)
4. **Account → Caps & Alerts.** Set the daily caps for downloads and transactions to **$0.00**. This is what guarantees you can never be charged: if a limit is hit, the link shows "temporarily unavailable" until the next day instead of billing you.
5. **App Keys → Add a New Application Key**, twice:

   | Name | Allow access to | Type of access | File name prefix |
   |---|---|---|---|
   | `kairos-write` | **only your bucket** | **Read and Write** | leave empty |
   | `kairos-read` | **only your bucket** | **Read Only** | leave empty |

   Backblaze shows each `keyID` and `applicationKey` **once**. Copy all four values somewhere safe (a password manager, not a text file on your desktop).
   Never use the "master" key. Kairos refuses any key that is not limited to one bucket.

## Part B: Cloudflare (the Worker that serves the links)

1. Go to **cloudflare.com → Sign up** (free). Verify your email.
2. Open the Terminal and go to this folder:
   ```bash
   cd "/Users/Kien/Claude Code Projects/spool/cloud"
   ```
3. Open `wrangler.toml` in any editor. Replace `B2_KEY_ID` with the **kairos-read keyID** and `B2_BUCKET` with your bucket name. Save.
4. Log in (a browser tab opens; click **Allow**):
   ```bash
   npx wrangler login
   ```
5. Deploy. The first time it asks you to pick a free `workers.dev` name (for example `kien-links`); accept it:
   ```bash
   npx wrangler deploy
   ```
   It prints your address, like `https://kairos-links.kien-links.workers.dev`. **Copy it.**
6. Give the Worker its two secrets. Each command asks you to paste a value:
   ```bash
   npx wrangler secret put B2_APP_KEY      # paste the kairos-read applicationKey
   openssl rand -hex 24                     # prints a random string; copy it
   npx wrangler secret put COOKIE_KEY      # paste that random string
   ```

## Part C: Kairos

1. Open Kairos → **Personal settings → Public links**.
2. Fill in: **Worker address** (step B5), **Bucket name**, **Write key ID** (the `kairos-write` keyID), **Write key** (the `kairos-write` applicationKey).
3. Press **Save and test**. You want seven green ticks. If one is red, the message tells you which setting to fix (table below).
4. Open any finished recording → **Share → Public link**, tick the confirmation, **Publish**. When it says live, press **Copy** and send the link.
5. **The real test:** open the link on your phone with **Wi-Fi off** (mobile data). It should play and let you scrub.

## If the test shows a red ✗

| Step | What it means | Fix |
|---|---|---|
| Backblaze key | Kairos' write key is wrong, not limited to one bucket, or not Read and Write | Make a new `kairos-write` key as in A5 |
| Upload | Kairos could not upload (offline, wrong bucket name, or a cap is hit) | Check the bucket name and your internet |
| Worker address | Nothing answers at that address | Re-copy it from `npx wrangler deploy`; it must start with `https://` |
| Worker reads the bucket | The Worker cannot read the bucket | The message names the setting: `B2_KEY_ID` / `B2_BUCKET` in `wrangler.toml` (then `npx wrangler deploy` again), or the `B2_APP_KEY` / `COOKIE_KEY` secrets |
| Video streaming | The Worker answers but not in pieces | Redeploy (`npx wrangler deploy`) so you have this folder's latest `worker.js` |

## What to know (honestly)

- **Anyone with the link can watch** (unless you chose Password). The link is a 22-character random code, so it cannot be guessed, but it can be forwarded.
- **Passwords:** the viewer's browser turns the password into a key (PBKDF2, 200,000 rounds); the Worker only ever sees that key. There is **no lockout** after wrong guesses (each wrong try just takes half a second more). Use a long password, and treat Password as "keeps casual viewers out", not as a vault.
- **"Downloads off"** hides the Download button. Anyone who can play a video in a browser can still save it. If it must not be copied, do not publish it.
- **The Privacy Guard is not perfect.** It blurs what it recognises and bleeps what it hears, but it can miss things. That is why Kairos asks you to confirm each time and refuses videos it has not scanned.
- **Who can see the video:** Backblaze stores the copy unencrypted for up to 30 days; Cloudflare relays it. Do not publish anything you would not be comfortable with them holding.
- **Limits of the free tiers:** Backblaze 10 GB storage and a small daily download/transaction allowance (which the $0 caps turn into "temporarily unavailable"); Cloudflare Workers 100,000 requests a day. Kairos stops at 9 GB of public copies.
- **Turn it all off:** Personal settings → Public links → **Remove all public copies**, or delete the bucket in Backblaze.
- **Quick check from the Terminal** (any machine): `node scripts/public-check.js <link>` (add `--password …` for protected links).
