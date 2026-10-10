# Browser Agent (AI task mode) — v10.4.0

Turn on the 🤖 button in the AI panel → Chat tab, then give a task, e.g.

* `tìm phim hay trên youtube và mở video đầu tiên`
* `mở vnexpress.net và cho tôi 3 tiêu đề đầu trang`
* `search the price of Laptop Pro 14 on shop.example`

While the agent runs the panel hides and a green bar shows the current step and a **Stop** button.
When it finishes the panel reopens with the answer. If the AI needs something from you it asks
(`❓`); your next message continues the same task (start a fresh one with `/new …`).

## How it works

```
 public/browser-agent.js (client)        lib/browser-agent.js (server)        AI provider
 observe page (text + numbered     ──►   build prompt, call ai.complete  ──►  your configured model
 links/buttons/fields)                   validate the returned action   ◄──
 execute action in the iframe      ◄──   {thought, action}
 repeat (max 15 steps)
```

* **observe** – URL, title, ~3000 chars of visible text (paged with `read`), up to 70 visible interactive elements with ids,
  scroll position. Password/card values are never sent.
* **actions** – `navigate`, `search`, `click`, `type` (+submit), `select`, `scroll`, `read`, `back`, `forward`, `wait`,
  `ask_user`, `done`, `fail`. Anything else is rejected (server and client).
* **endpoint** – `POST /api/browser/agent/step` (rate-limited 60/min/IP). No AI key is ever sent to the browser.

## Safety

* Website text is fenced as untrusted data in the prompt; the model is told never to follow instructions found on pages.
* Host-side confirmation (Allow/Deny) for clicks whose label/link matches buy/pay/delete/send/post/confirm/log out/… (EN+VI)
  and for submitting any form that contains a password/card field. A model cannot skip this.
* Password / card / OTP fields can never be filled by the agent (client enforces it).
* Only `http(s)` navigation; `target=_blank` is neutralised; hard step cap; repeat-loop guard; Stop button.
* Existing SSRF protections of the proxy are unchanged and still apply to everything the agent opens.

## Works / does not work

Works: pages rendered by the proxy (same-origin): news, wikis, shops with plain links/GET forms, Google (→ DuckDuckGo results),
YouTube search + opening a video.

Does **not** work (honest limits): controlling anything inside cross-origin embeds (e.g. the Play button of the YouTube player,
embedded payment frames); CAPTCHA/login/2FA; DRM streaming (use ↗ Open); file upload/download; sites that require POST
submission (the proxy is GET-only); drag & drop, hover menus, canvas/WebGL pages; infinite-scroll SPAs that keep their UI in
shadow DOM; sites that block the proxy (`proxy.blocked`). Without an AI provider only trivial commands work (offline rules).

## Tests

* `npm test` includes `test-agent.js` (planner, validation, prompt-injection fencing, provider path).
* `node test-agent-e2e.js` (optional; needs Playwright + Chromium, `PLAYWRIGHT_PATH=…`) drives the real UI in a real browser
  against a fake shop + scripted model: multi-step task, confirm Allow/Deny, password block, stale/hallucinated ids,
  repeat guard, step limit, Stop, scroll, YouTube search→video, panel tabs still working.
