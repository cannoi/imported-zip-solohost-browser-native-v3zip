# SoloHost Browser v10.15.0

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
