# Browser Agent (AI task mode) — V10.8.0

Turn on the Agent button in the existing AI Panel Chat tab and give a task, for example:

- `tìm phim hay trên youtube và mở video đầu tiên`
- `mở thanhnien.vn và cho tôi 3 tiêu đề đầu trang`
- `tóm tắt nội dung trang đang mở`
- `search the price of Laptop Pro 14 on shop.example`

The panel shows backend progress and a Stop button. If a sensitive action is proposed, the UI asks for Allow/Deny. If the agent needs a user-only input, it asks instead of requesting a password or OTP.

## Architecture

```text
AI Panel UI
  | task + authenticated session id/token
  v
/api/browser/agent/tasks
  | backend-owned task loop
  +--> observe current backend session snapshot
  +--> lib/browser-agent.js: prompt + validate one action
  +--> domBridge / WebKit worker: execute navigation, click, input, select, scroll
  +--> task progress/results/confirmation API
  v
AI Panel UI polls progress and refreshes the sanitized browser viewport
```

The UI does not inspect `iframe.contentDocument`, click page elements, or type into the page. Website actions run against the authenticated backend session. The existing `/api/browser/agent/step` endpoint remains for planner compatibility, but the shipped AI Panel uses the backend task API.

## Supported actions

`navigate`, `search`, `click`, `type` (non-secret fields, optional submit), `select`, `scroll`, `read` (paged text), `back`, `forward` (within this task's URL history), `wait`, `ask_user`, `done`, and `fail`. A single task is allowed per browser session, has a bounded step limit, and has a repeat-action guard.

## Safety

- Page text and labels are untrusted data; prompt-injection instructions found on a website must not be followed.
- Sensitive clicks and sensitive form submissions require an explicit user confirmation.
- Password, OTP, card and other secret fields are never filled by the agent and their values are not sent in observations.
- API task endpoints require the existing browser session token. The server rate-limits task creation.
- Navigation is restricted by the existing public HTTP URL/SSRF validation.
- Progress logs avoid recording the session token; WebKit stderr details redact common token/API-key query parameters.

## Compatibility limits

The live backend engine is WebKitGTK, not Chromium. It executes website JavaScript and applies CSS in the backend, then exports a sanitized DOM snapshot to the existing UI. Scripts are deliberately not executed in the SoloHost-origin viewport. Some cross-origin iframes, canvas/WebGL, CAPTCHA, DRM, anti-bot pages, file upload and complex login flows may not fully work; use Open externally when required. When WebKit is unavailable, proxy fallback cannot perform JavaScript-driven clicks/inputs and the agent reports that limitation rather than pretending success.

## Verification

- `npm test` includes planner, security, bridge, compatibility, YouTube and backend-agent regression tests.
- `test-agent-e2e.js` is a legacy client-DOM harness and is intentionally skipped in V10.8; an integration test needs a running SoloHost instance with WebKitGTK and an authenticated backend session.
