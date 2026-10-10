#!/usr/bin/env python3
"""
SoloHost Browser — WebKitGTK backend worker.
Protocol: one JSON object per line on stdin; one JSON response per line on stdout.
No pixel streaming. No VNC. Controlled only by parent Node process via stdin.
"""
from __future__ import annotations

import json
import os
import sys
import signal
import threading
import time
import traceback
from typing import Any, Dict, Optional

# Headless display: parent should set DISPLAY (e.g. Xvfb :99)
# Fail soft if WebKit not installed — report engine unavailable.

MAX_SESSIONS = int(os.environ.get("SOLOHOST_WEBKIT_MAX_SESSIONS", "3"))
# Container-safe defaults (avoid Fontconfig/dconf permission spam)
os.environ.setdefault("HOME", "/tmp/solohost-browser")
os.environ.setdefault("XDG_CACHE_HOME", os.path.join(os.environ["HOME"], ".cache"))
os.environ.setdefault("XDG_CONFIG_HOME", os.path.join(os.environ["HOME"], ".config"))
os.environ.setdefault("XDG_RUNTIME_DIR", os.path.join(os.environ["HOME"], "run"))
os.environ.setdefault("GSETTINGS_BACKEND", "memory")
for _d in (os.environ["HOME"], os.environ["XDG_CACHE_HOME"], os.environ["XDG_CONFIG_HOME"], os.environ["XDG_RUNTIME_DIR"]):
    try:
        os.makedirs(_d, exist_ok=True)
    except Exception:
        pass
NAV_TIMEOUT_MS = int(os.environ.get("SOLOHOST_WEBKIT_NAV_TIMEOUT_MS", "30000"))
WORKER_ID = os.environ.get("SOLOHOST_WEBKIT_WORKER_ID", "wk1")

_lock = threading.Lock()
_sessions: Dict[str, Dict[str, Any]] = {}
_session_seq = 0
_webkit_ok = False
_webkit_error = "not_initialized"
_main_loop = None

def log_err(msg: str) -> None:
    sys.stderr.write("[webkit-worker] " + msg + "\n")
    sys.stderr.flush()

def reply(req_id: Any, ok: bool, result: Any = None, error: str = None) -> None:
    out: Dict[str, Any] = {"id": req_id, "ok": ok}
    if ok:
        out["result"] = result if result is not None else {}
    else:
        out["error"] = error or "error"
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def try_init_webkit() -> bool:
    global _webkit_ok, _webkit_error, _main_loop
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        try:
            gi.require_version("WebKit2", "4.1")
        except ValueError:
            gi.require_version("WebKit2", "4.0")
        from gi.repository import Gtk, WebKit2, GLib

        # Offscreen: need DISPLAY; Gtk.init checks it
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            _webkit_error = "no_display"
            return False

        Gtk.init([])
        _main_loop = GLib.MainLoop()
        _webkit_ok = True
        _webkit_error = ""
        # Keep references for session use
        globals()["Gtk"] = Gtk
        globals()["WebKit2"] = WebKit2
        globals()["GLib"] = GLib
        return True
    except Exception as e:
        _webkit_ok = False
        _webkit_error = str(e)
        log_err("init failed: " + _webkit_error)
        return False

def engine_status() -> Dict[str, Any]:
    return {
        "workerId": WORKER_ID,
        "ready": _webkit_ok,
        "error": _webkit_error or None,
        "sessions": len(_sessions),
        "maxSessions": MAX_SESSIONS,
        "navTimeoutMs": NAV_TIMEOUT_MS,
        "pid": os.getpid(),
        "display": os.environ.get("DISPLAY") or None,
        "engine": "webkitgtk" if _webkit_ok else "unavailable",
    }

def session_create(args: Dict[str, Any]) -> Dict[str, Any]:
    global _session_seq
    if not _webkit_ok:
        raise RuntimeError("engine_unavailable:" + (_webkit_error or "unknown"))
    with _lock:
        if len(_sessions) >= MAX_SESSIONS:
            # Close oldest instead of hard-fail (zombie leak recovery)
            oldest = sorted(_sessions.items(), key=lambda kv: kv[1].get("createdAt") or 0)
            if oldest:
                try:
                    session_close({"sessionId": oldest[0][0]})
                except Exception:
                    _sessions.pop(oldest[0][0], None)
            if len(_sessions) >= MAX_SESSIONS:
                raise RuntimeError("max_sessions")
        _session_seq += 1
        sid = "s%d" % _session_seq

    WebKit2 = globals()["WebKit2"]
    Gtk = globals()["Gtk"]
    GLib = globals()["GLib"]

    ctx = WebKit2.WebContext.get_default()
    # Ephemeral-ish: do not persist cookies to disk by default
    webview = WebKit2.WebView.new_with_context(ctx)
    # Hidden window required for some GTK/WebKit builds
    win = Gtk.OffscreenWindow() if hasattr(Gtk, "OffscreenWindow") else Gtk.Window()
    win.set_default_size(1280, 720)
    win.add(webview)
    win.show_all()

    state = {
        "id": sid,
        "url": "about:blank",
        "title": "",
        "loading": False,
        "error": None,
        "ready": True,
        "createdAt": time.time(),
        "webview": webview,
        "window": win,
        "load_result": None,
    }

    def on_load_changed(view, event):
        try:
            # WebKit2.LoadEvent: STARTED, REDIRECTED, COMMITTED, FINISHED
            name = event.value_nick if hasattr(event, "value_nick") else str(event)
            if name in ("started", "WEBKIT_LOAD_STARTED", "0"):
                state["loading"] = True
                state["error"] = None
            elif name in ("finished", "WEBKIT_LOAD_FINISHED", "3"):
                state["loading"] = False
                state["url"] = view.get_uri() or state["url"]
                state["title"] = view.get_title() or state["title"]
                state["load_result"] = "finished"
            elif name in ("committed", "WEBKIT_LOAD_COMMITTED", "2"):
                state["url"] = view.get_uri() or state["url"]
        except Exception as ex:
            log_err("load_changed: " + str(ex))

    def on_failed(view, event, failing_uri, error):
        state["loading"] = False
        state["error"] = str(getattr(error, "message", error))
        state["load_result"] = "failed"
        try:
            state["url"] = failing_uri or state["url"]
        except Exception:
            pass

    webview.connect("load-changed", on_load_changed)
    try:
        webview.connect("load-failed", on_failed)
    except Exception:
        pass

    with _lock:
        _sessions[sid] = state
    return {"sessionId": sid, "url": state["url"], "ready": True}

def session_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    if not _webkit_ok:
        raise RuntimeError("engine_unavailable")
    sid = args.get("sessionId")
    url = (args.get("url") or "").strip()
    if not sid or sid not in _sessions:
        raise RuntimeError("session_not_found")
    if not url or not (url.startswith("http://") or url.startswith("https://") or url == "about:blank"):
        raise RuntimeError("invalid_url")
    # Block obvious private hosts at worker layer (defense in depth; Node also filters)
    low = url.lower()
    for bad in ("://127.", "://localhost", "://0.0.0.0", "://10.", "://192.168.", "://[::1]"):
        if bad in low and os.environ.get("SOLOHOST_WEBKIT_ALLOW_LOOPBACK") != "1":
            raise RuntimeError("blocked_host")

    state = _sessions[sid]
    webview = state["webview"]
    GLib = globals()["GLib"]
    state["loading"] = True
    state["error"] = None
    state["load_result"] = None
    timeout_s = max(5, NAV_TIMEOUT_MS / 1000.0)

    done = {"v": False}

    def do_load():
        try:
            webview.load_uri(url)
        except Exception as e:
            state["error"] = str(e)
            state["loading"] = False
            done["v"] = True

    GLib.idle_add(do_load)

    # Pump main loop until finished or timeout
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if state.get("load_result") in ("finished", "failed") or state.get("error"):
            break
        # iterate main context briefly
        ctx = GLib.MainContext.default()
        ctx.iteration(False)
        time.sleep(0.05)

    if state.get("load_result") is None and not state.get("error"):
        state["error"] = "navigation_timeout"
        state["loading"] = False

    return {
        "sessionId": sid,
        "url": state.get("url") or url,
        "title": state.get("title") or "",
        "loading": bool(state.get("loading")),
        "error": state.get("error"),
        "ready": True,
    }

def session_get_state(args: Dict[str, Any]) -> Dict[str, Any]:
    sid = args.get("sessionId")
    if not sid or sid not in _sessions:
        raise RuntimeError("session_not_found")
    state = _sessions[sid]
    # Pump once for pending events
    if _webkit_ok:
        try:
            GLib = globals()["GLib"]
            GLib.MainContext.default().iteration(False)
            view = state["webview"]
            state["url"] = view.get_uri() or state["url"]
            state["title"] = view.get_title() or state["title"]
        except Exception:
            pass
    return {
        "sessionId": sid,
        "url": state.get("url"),
        "title": state.get("title"),
        "loading": bool(state.get("loading")),
        "error": state.get("error"),
        "ready": bool(state.get("ready")),
    }

def session_close(args: Dict[str, Any]) -> Dict[str, Any]:
    sid = args.get("sessionId")
    if not sid or sid not in _sessions:
        return {"closed": False, "reason": "session_not_found"}
    state = _sessions.pop(sid, None)
    try:
        if state and state.get("webview"):
            state["webview"].destroy()
        if state and state.get("window"):
            state["window"].destroy()
    except Exception as e:
        log_err("close: " + str(e))
    return {"closed": True, "sessionId": sid}


def _run_js(webview, script: str, timeout_s: float = 10.0):
    """Run JS in WebKit and return string result (best-effort)."""
    GLib = globals()["GLib"]
    result_box = {"done": False, "value": None, "error": None}

    def on_ready(obj, result, user_data=None):
        try:
            # WebKit2.WebView.run_javascript_finish
            js_result = webview.run_javascript_finish(result)
            if js_result:
                val = js_result.get_js_value()
                result_box["value"] = val.to_string() if val else None
            result_box["done"] = True
        except Exception as e:
            result_box["error"] = str(e)
            result_box["done"] = True

    def start():
        try:
            webview.run_javascript(script, None, on_ready, None)
        except TypeError:
            # older signature
            try:
                webview.run_javascript(script, None, on_ready)
            except Exception as e:
                result_box["error"] = str(e)
                result_box["done"] = True
        except Exception as e:
            result_box["error"] = str(e)
            result_box["done"] = True

    GLib.idle_add(start)
    deadline = time.time() + timeout_s
    while time.time() < deadline and not result_box["done"]:
        GLib.MainContext.default().iteration(False)
        time.sleep(0.02)
    if not result_box["done"]:
        raise RuntimeError("js_timeout")
    if result_box["error"]:
        raise RuntimeError(result_box["error"])
    return result_box["value"]


CONTENT_JS = r"""
(function(){
  var id = 0;
  var map = {};
  function mark(el){
    if(!el || el.nodeType!==1) return;
    id++;
    var sid = 'e'+id;
    el.setAttribute('data-sh-id', sid);
    map[sid] = {tag: el.tagName, href: el.href||null, type: el.getAttribute('type'), name: el.getAttribute('name')};
  }
  var nodes = document.querySelectorAll('a,button,input,select,textarea,form,[onclick],[role="button"]');
  for(var i=0;i<nodes.length;i++) mark(nodes[i]);
  // strip scripts for transfer safety (engine already ran them)
  var scripts = document.querySelectorAll('script');
  for(var j=0;j<scripts.length;j++) scripts[j].remove();
  return JSON.stringify({
    html: document.documentElement ? document.documentElement.outerHTML : '',
    url: location.href,
    title: document.title||'',
    scrollY: window.scrollY||0,
    scrollX: window.scrollX||0,
    mapCount: id
  });
})();
"""


def session_get_content(args):
    if not _webkit_ok:
        raise RuntimeError("engine_unavailable")
    sid = args.get("sessionId")
    if not sid or sid not in _sessions:
        raise RuntimeError("session_not_found")
    state = _sessions[sid]
    webview = state["webview"]
    # wait if still loading briefly
    GLib = globals()["GLib"]
    deadline = time.time() + 2
    while state.get("loading") and time.time() < deadline:
        GLib.MainContext.default().iteration(False)
        time.sleep(0.03)
    raw = _run_js(webview, CONTENT_JS, timeout_s=12.0)
    data = json.loads(raw) if raw else {}
    state["url"] = data.get("url") or state.get("url")
    state["title"] = data.get("title") or state.get("title")
    state["mapCount"] = data.get("mapCount") or 0
    return {
        "sessionId": sid,
        "url": state.get("url"),
        "title": state.get("title"),
        "html": data.get("html") or "",
        "scrollX": data.get("scrollX") or 0,
        "scrollY": data.get("scrollY") or 0,
        "mapCount": state.get("mapCount") or 0,
        "loading": bool(state.get("loading")),
        "error": state.get("error"),
    }


def session_dispatch_event(args):
    if not _webkit_ok:
        raise RuntimeError("engine_unavailable")
    sid = args.get("sessionId")
    if not sid or sid not in _sessions:
        raise RuntimeError("session_not_found")
    state = _sessions[sid]
    webview = state["webview"]
    etype = (args.get("type") or "").lower()
    target = args.get("targetId") or args.get("target") or ""
    value = args.get("value")
    x = args.get("x")
    y = args.get("y")

    if etype == "scroll":
        sx = int(args.get("scrollX") or 0)
        sy = int(args.get("scrollY") or 0)
        script = "window.scrollTo(%d,%d); JSON.stringify({ok:true,scrollY:window.scrollY});" % (sx, sy)
    elif etype == "click":
        if not target:
            raise RuntimeError("targetId_required")
        # sanitize target id
        tid = "".join(c for c in str(target) if c.isalnum())
        script = r"""
(function(){
  var el = document.querySelector('[data-sh-id="%s"]');
  if(!el) return JSON.stringify({ok:false,error:'not_found'});
  if(el.tagName==='A' && el.href){ el.click(); return JSON.stringify({ok:true,nav:true}); }
  el.click();
  return JSON.stringify({ok:true});
})();
""" % tid
    elif etype in ("input", "change"):
        if not target:
            raise RuntimeError("targetId_required")
        tid = "".join(c for c in str(target) if c.isalnum())
        # JSON-escape value
        val_js = json.dumps("" if value is None else str(value))
        script = r"""
(function(){
  var el = document.querySelector('[data-sh-id="%s"]');
  if(!el) return JSON.stringify({ok:false,error:'not_found'});
  el.focus();
  el.value = %s;
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return JSON.stringify({ok:true});
})();
""" % (tid, val_js)
    elif etype == "submit":
        if not target:
            raise RuntimeError("targetId_required")
        tid = "".join(c for c in str(target) if c.isalnum())
        script = r"""
(function(){
  var el = document.querySelector('[data-sh-id="%s"]');
  if(!el) return JSON.stringify({ok:false,error:'not_found'});
  var form = el.tagName==='FORM' ? el : el.closest('form');
  if(!form) return JSON.stringify({ok:false,error:'no_form'});
  if(typeof form.requestSubmit==='function') form.requestSubmit();
  else form.submit();
  return JSON.stringify({ok:true,submitted:true});
})();
""" % tid
    elif etype == "navigate":
        url = (args.get("url") or "").strip()
        if not url:
            raise RuntimeError("url_required")
        return session_navigate({"sessionId": sid, "url": url})
    else:
        raise RuntimeError("unsupported_event:" + etype)

    state["loading"] = True  # navigation may start
    raw = _run_js(webview, script, timeout_s=8.0)
    try:
        result = json.loads(raw) if raw else {"ok": True}
    except Exception:
        result = {"ok": True, "raw": raw}

    # Allow load to settle
    GLib = globals()["GLib"]
    deadline = time.time() + 5
    while state.get("loading") and time.time() < deadline:
        GLib.MainContext.default().iteration(False)
        time.sleep(0.05)
    try:
        state["url"] = webview.get_uri() or state.get("url")
        state["title"] = webview.get_title() or state.get("title")
    except Exception:
        pass
    state["loading"] = False
    return {
        "sessionId": sid,
        "event": etype,
        "result": result,
        "url": state.get("url"),
        "title": state.get("title"),
        "error": state.get("error"),
    }


def handle(msg: Dict[str, Any]) -> None:
    req_id = msg.get("id")
    cmd = msg.get("cmd") or msg.get("method")
    args = msg.get("args") or msg.get("params") or {}
    try:
        if cmd == "engine.status":
            reply(req_id, True, engine_status())
        elif cmd == "session.create":
            reply(req_id, True, session_create(args))
        elif cmd == "session.navigate":
            reply(req_id, True, session_navigate(args))
        elif cmd == "session.getState":
            reply(req_id, True, session_get_state(args))
        elif cmd == "session.close":
            reply(req_id, True, session_close(args))
        elif cmd == "session.getContent":
            reply(req_id, True, session_get_content(args))
        elif cmd == "session.dispatchEvent":
            reply(req_id, True, session_dispatch_event(args))
        elif cmd == "ping":
            reply(req_id, True, {"pong": True, "ts": time.time()})
        elif cmd == "shutdown":
            reply(req_id, True, {"bye": True})
            # close all
            for sid in list(_sessions.keys()):
                try:
                    session_close({"sessionId": sid})
                except Exception:
                    pass
            sys.exit(0)
        else:
            reply(req_id, False, error="unknown_cmd:" + str(cmd))
    except Exception as e:
        reply(req_id, False, error=str(e))

def main() -> None:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    try_init_webkit()
    # Announce ready line for parent (not JSON-RPC)
    sys.stderr.write("[webkit-worker] boot ready=%s error=%s\n" % (_webkit_ok, _webkit_error))
    sys.stderr.flush()
    # Do not emit unsolicited JSON on stdout (parent matches by id).
    # Boot is logged on stderr only.

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            reply(None, False, error="invalid_json")
            continue
        handle(msg)

if __name__ == "__main__":
    main()
