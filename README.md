# SoloHost Browser v10.25.24

Version 10.16.0 routes YouTube watch/Shorts/live clicks through the official player shell and improves policy-compliant diagnostics. Version 10.15.0 adds a configurable default search engine (Bing, Google, DuckDuckGo, Brave Search, or a custom HTTP(S) URL template), native browser viewing for direct media/images/PDF links, and a wider but explicit CSP allowlist for official media embeds (YouTube, TikTok, Vimeo, Spotify, Twitch, Dailymotion). The AI Panel knowledge is generated at runtime from the installed package version and engine capabilities, and documents current architecture, search settings, media support and limitations.

Existing UI, Bridge, tabs, context menu, AI/Feedback/Settings/Logs, security checks and adaptive rendering are retained. See `docs/V10.15.0_MEDIA_SEARCH_AI_REPORT.md`. The Chromium DOM Bridge is the in-app website rendering path. It snapshots the live Chromium DOM using the legacy v10.20.0-reference `markInteractive(page)` method; the live page continues running in Chromium while a sanitized DOM copy is displayed. There is no separate Static Capture feature.

## v10.25.24 — Backend efficiency and Google sign-in handoff

- Reuses the live Chromium page for same-URL navigation; no `page.goto()` reload for duplicate navigation unless explicitly forced.
- Coalesces overlapping DOM snapshots and uses a short 160 ms cache, invalidated by navigation and interactive actions.
- Avoids full DOM cloning for every input/change/scroll event; structural actions still refresh the snapshot.
- Activates lazy images only in/near the viewport instead of eagerly loading every image on long pages.
- Uses Chromium's native User-Agent rather than a stale hard-coded Chrome 131 string. This improves version consistency but does not bypass Google's automation restrictions.
- Google sign-in handoff now points to the actual external target and explains that regular-browser cookies are isolated from SoloHost's backend Chromium profile.
- Test report: `docs/V10.25.24_BACKEND_EFFICIENCY_GOOGLE_HANDOFF_REPORT.md`.


## v10.25.23 — Restore v10.20.0 website acquisition/presentation behavior

- Reverted the post-v10.20.0 changes in the DOM Bridge HTML sanitizer that stripped supplied `<base>` tags, forced all anchors to `_self`, added `data-sh-nav`, and changed base-URL validation. The legacy sanitizer implementation is restored.
- Restored the v10.20.0 `frame-proxy.js` so newer injected layout fixes, rewritten anchor routing, and Bing redirect unwrapping no longer change the displayed website or its links.
- Removed post-baseline stealth fingerprinting and spoofed desktop User-Agent/client-hint behavior from the Chromium engine. The v10.20.0 Android/Linux User-Agent defaults and mobile default are restored.
- Removed the custom verification handoff page that replaced the website snapshot. Existing baseline verification handling remains.
- Preserved unrelated features including tab-to-session mapping, popup ownership, unowned-page recovery, persistent browser profiles, noVNC login browser, AI/memory/music/audio, agent tools, and tab sync.
- Validation details and unavoidable limitations: `docs/V10.25.23_WEBSITE_PIPELINE_REVERT_REPORT.md`.


## v10.19.0 — AI Tasks, Music Library and Site Verification

- The former Scripts panel is now **AI Tasks**. Ask AI Panel to create a scheduled task in natural language; manual task-entry fields are removed. Five built-in task examples are included.
- Daily scheduled playback runs only while the browser UI is open. YouTube search tasks resolve a result to the official embed player and stop after the configured duration.
- Playlist supports in-panel embedded playback for supported YouTube, Vimeo and TikTok video URLs. Some videos disable embedding or require sign-in/age/region checks.
- Bing verification is shown in-app with an embedded challenge when Bing permits framing, plus an official Open ↗ fallback. CAPTCHA remains user-completed.
- Google rejected sign-in redirects open the legitimate continuation URL in the system browser. Google cookies are not copied into the app.
- Optional access password: set `BROWSER_ACCESS_PASSWORD` in SoloHost config. Leave it empty to disable HTTP Basic authentication.
- Locale/time zone is best-effort detected from the server's public IP using ipapi.co; if unavailable, local time zone is used. Manual language selection is preserved.


## v10.20.0 — Unified AI Memory, Music Player Controls and Browser Profile Consistency

- Music Library places the embedded player and playback controls above the saved tracks. Added play/pause, previous/next, shuffle, repeat-all and repeat-one modes. Automatic next/repeat depends on official player event support; some providers block embeds.
- Removed the separate Agent-mode switch. One chat input routes clear browser-operation requests to the Browser Agent and ordinary questions to chat. Agent follow-up state persists, and sensitive actions still require confirmation.
- Added persistent per-browser-profile AI conversation history, long-term memories and reusable skills in `/app/data/ai-memory.json`. Explicit memory/skill commands are supported; credential-like strings are rejected; memory can be cleared by asking to forget all saved memories.
- Longer user requests and more recent conversation history are passed to the configured AI provider. Memory suggestions are bounded and filtered before saving.
- Browser engine sessions now use a stable local profile ID rather than the client IP as their persistent storage identity, so ordinary IP changes do not silently switch cookie/storage profiles. UI language and best-effort public-IP time zone are passed to new Playwright sessions.
- Browser compatibility audit aligns the declared locale/time zone and the bundled Chromium 131 user-agent with the actual configured engine profile. It does not hide automation, spoof unrelated fingerprints, transfer cookies from external browsers, solve CAPTCHAs or bypass site anti-bot controls.
- Compose defaults the container system time zone to UTC; app-level time-zone detection still prefers public-IP geolocation with fallback. SoloHost config schema drops the unsupported `id` field from the optional password field.


## v10.21.0 — Adaptive Bridge templates
Historical release note. The v10.25.24 release above further reverts post-baseline website pipeline changes while preserving independent browser features.


## v10.23.0 — Browser AI identity, private-tab and access-gate fixes

- Built-in bilingual app identity and current Browser AI knowledge.
- Fixed private-tab action registration and password-gate configuration semantics.
- See `docs/V10.23.0_BROWSER_AI_PRIVATE_AUTH_REPORT.md` for implemented work and remaining noVNC/audio limitations.

## v10.22.0 — Session persistence hardening
- Upgraded Playwright and its Docker base image together to 1.51.1 so browser storage snapshots can include IndexedDB as well as cookies and localStorage.
- Persist browser state on page load and on a low-frequency interval, in addition to existing navigation/interaction/close saves.
- Use a stable default profile identity when a profile ID is absent; do not key persistent sessions by the client IP.
- See `docs/V10.22.0_SESSION_PERSISTENCE_REPORT.md` for scope, limitations and validation.


## v10.25.22 — Legacy v10.20.0 website extraction/presentation behavior restored

- Restored `markInteractive(page)` byte-for-byte from the available v10.20.0 source archive.
- Removed the newer DOM-based family heuristics and page-family marker injection from the rendering path.
- Retained current sanitizer hardening, safe base URL handling, SoloHost link routing, tab synchronization, popup handling, persistent profiles, Reader, AI, media and other unrelated features.
- Exact v10.20.1/v10.20.2 archives were not available for direct comparison. See `docs/V10.25.22_V10.20.0_BEHAVIOR_RESTORATION_REPORT.md` for the baseline, tests and limitations.
