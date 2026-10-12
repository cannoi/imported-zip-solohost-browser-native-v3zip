# SoloHost Browser v10.20.0

Version 10.16.0 routes YouTube watch/Shorts/live clicks through the official player shell and improves policy-compliant diagnostics. Version 10.15.0 adds a configurable default search engine (Bing, Google, DuckDuckGo, Brave Search, or a custom HTTP(S) URL template), native browser viewing for direct media/images/PDF links, and a wider but explicit CSP allowlist for official media embeds (YouTube, TikTok, Vimeo, Spotify, Twitch, Dailymotion). The AI Panel knowledge is generated at runtime from the installed package version and engine capabilities, and documents current architecture, search settings, media support and limitations.

Existing UI, Bridge, tabs, context menu, AI/Feedback/Settings/Logs, security checks and adaptive rendering are retained. See `docs/V10.15.0_MEDIA_SEARCH_AI_REPORT.md`.


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
See `docs/V10.21.0_ADAPTIVE_BRIDGE_TEMPLATES_REPORT.md` for the bridge fidelity fix, page-family detection, regression tests, and limitations.
