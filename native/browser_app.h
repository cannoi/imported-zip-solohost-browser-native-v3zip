#pragma once
#include "include/cef_app.h"
#include <memory>
class BrowserApp : public CefApp, public CefBrowserProcessHandler {
public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnContextInitialized() override;
private:
  IMPLEMENT_REFCOUNTING(BrowserApp);
};
