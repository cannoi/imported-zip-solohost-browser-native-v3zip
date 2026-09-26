#pragma once
#include "include/cef_client.h"
#include "include/cef_render_handler.h"
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class DisplayServer;

class BrowserClient : public CefClient,
                      public CefLifeSpanHandler,
                      public CefDisplayHandler,
                      public CefLoadHandler,
                      public CefRenderHandler {
public:
  BrowserClient(DisplayServer* server, std::string id, int width, int height);

  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRenderHandler> GetRenderHandler() override { return this; }

  bool GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override;
  void OnPaint(CefRefPtr<CefBrowser>, PaintElementType, const RectList&, const void*, int, int) override;
  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString&) override;
  void OnAddressChange(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, const CefString&) override;
  void OnAfterCreated(CefRefPtr<CefBrowser>) override;
  void OnBeforeClose(CefRefPtr<CefBrowser>) override;
  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, ErrorCode, const CefString&, const CefString&) override;

  CefRefPtr<CefBrowser> browser() const { return browser_; }
  const std::string& id() const { return id_; }
  void resize(int w, int h);
  void setActive(bool active);
  bool closed() const { return closed_; }

private:
  std::vector<uint8_t> encodeJpeg(const void* buffer, int width, int height) const;
  DisplayServer* server_;
  std::string id_;
  std::atomic<int> width_;
  std::atomic<int> height_;
  std::atomic<bool> active_{false};
  std::atomic<bool> closed_{false};
  mutable std::mutex browser_mutex_;
  CefRefPtr<CefBrowser> browser_;
  IMPLEMENT_REFCOUNTING(BrowserClient);
};
