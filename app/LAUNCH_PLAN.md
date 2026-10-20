# Takeoff launch plan

The single checklist from now to public launch. Tick items here as they land; nothing lives only in chat.
Owner: **C** = Claude (code), **P** = Pranay (accounts, money, decisions). Updated 2026-10-20.

Scope decided: free planner + paid "Kodi Pro" (our own digital service, individual KYC, no company yet).
Hotels/flights stay **booking requests** a person completes; we never collect trip money.

---

## Phase 0–2: done
- [x] Backend: chat (streaming), guardrails (prices, facts), itinerary engine, rate limits — C
- [x] Frontend: home (old UI kept), chat UI, map, saved trips, share link + PDF — C
- [x] Accounts: email + Google login, verify/reset, email change, devices, lockout, export/delete — C
- [x] Tests: backend 269 (vitest), frontend e2e 31 (Playwright), CI — C

## Phase 3: model + everything that doesn't need it (NOW)

### 3A. Model track (Mac runs it in the background)
- [x] Training works on the Mac (official Qwen3.5-0.8B base; corrupt base trashed) — C
- [x] Destination guide: 117 places, verbatim Wikivoyage sentences — C
- [x] Backend serves the real guide to the model (`get_destination_info`) — C
- [ ] Generate v3 conversations (teacher 4B, ~180) — running — C
- [ ] Re-run the failed ones once; show Pranay a sample — C
- [ ] Build dataset, fine-tune v3 overnight — C
- [ ] Export GGUF, run 30-scenario eval; ship only if avg ≥3 and 0 critical — C
- [ ] If it fails: fix weak spots, add data, retrain (≈ +1 day per round) — C
- [ ] Put v3 in the app; end-to-end check in the real chat — C
- [x] Model-down fallback: friendly message, chat stays usable — C

### 3B. Parallel track (no model, no business papers needed) — pulled forward from Phase 5
- [x] Destination hub `/destinations` + 117 place pages from the guide (SEO) — C
- [x] 14 sample itineraries `/trips/<slug>` that open in chat (Ladakh, Coorg skipped: map data too thin) — C
- [x] How it works page — C
- [x] SEO basics: titles/descriptions, sitemap.xml, robots.txt, share images — C
- [x] Thumbs up/down on Kodi replies (feeds future training) — C
- [x] Admin panel v1: dashboard, booking requests, contact inbox, users, audit log — C
- [x] Admin v2: conversations (personal details hidden), flagged replies, "send to training", email customers — C
- [x] Admin security: role-based, 2-step sign-in, audit log — C
- [x] Cookie policy page — C

### 3C. Pranay, now (each takes minutes; approvals take days)
- [ ] Start Razorpay **individual** KYC (PAN, bank, Aadhaar; category: digital services/SaaS) — P
- [ ] Buy a domain — P
- [ ] Rotate the Resend API key (it was shared in chat) — P
- [ ] Make yourself admin: sign up with your email, then `npm run admin -- grant <email>` on the server; set `ADMIN_SECRET_KEY` in production — P
- [ ] Create Cloudflare Turnstile keys (free) — P
- [ ] Decide Pro price (e.g. ₹199/month or ₹1,499/year) and the free limit — P

## Phase 4: payments (needs Razorpay test keys)
- [ ] Plans in code: Free limits, Pro monthly/yearly, optional one-time expert plan — C
- [ ] Razorpay Checkout (UPI, cards, netbanking); webhook is the only source of "paid" — C
- [ ] Subscriptions: renew, cancel, failed-payment retry, Pro features on/off — C
- [ ] Billing in Account: plan, invoices (PDF), cancel — C
- [ ] Refunds from the admin panel — C
- [ ] Tests: test-mode payments, webhook replay, double-payment guard — C
- [ ] Pages: Pricing, Refund & cancellation policy, Pro FAQ — C
- [ ] CA check on GST/payments before live keys — P

## Phase 5: launch
### Infrastructure
- [ ] SQLite → Postgres (Neon/Supabase), migrations, daily backups + restore test — C
- [ ] Frontend on Vercel; backend on Railway/Render/VPS; staging + production — C
- [ ] Model server: GPU (RunPod/Vast) or CPU box for 0.8B; pick by cost/speed test — C + P (card)
- [ ] Domain DNS, HTTPS, secrets in host settings — C + P
- [ ] Host forwards `/sitemap.xml` to the backend; add the `Sitemap:` line to robots.txt; submit to Google Search Console — C + P
- [ ] Pre-render public pages (destinations, trips) so search engines get HTML, not an empty shell — C
### Email
- [ ] Resend on own domain (SPF/DKIM); welcome, receipt, booking-request emails — C
### Security
- [ ] Turnstile on; MapTiler + Google keys restricted to the domain — C + P
- [ ] Security headers (CSP), dependency audit, load-check rate limits — C
### Legal (individual)
- [ ] Privacy policy: payments + processors (Razorpay, Resend, host), DPDP — C
- [ ] Terms: AI planner, estimates, requests, refunds — C
- [ ] Grievance contact (name + email) — P supplies, C adds
### Quality
- [ ] Real phones: Android Chrome, iPhone Safari — C + P
- [ ] Lighthouse > 90, accessibility pass, 50-user load test — C
- [ ] Sentry errors + uptime alerts — C
### Go live
- [ ] Full run on staging, then production — C
- [ ] One real ₹1 payment + refund — P
- [ ] Soft launch: 20–50 friends, one week, fix what breaks — P + C
- [ ] Public: Product Hunt, Reddit, Instagram reels — P

## After launch (weekly)
- [ ] Read flagged chats → good examples → retrain (v4, v5…) — C
- [ ] New destination pages / itineraries — C
- [ ] When revenue grows: register business → real suppliers, GST — P
