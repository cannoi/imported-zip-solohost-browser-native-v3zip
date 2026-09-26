#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "browser_app.h"
#include "browser_client.h"
#include "display_server.h"
#include "json_util.h"
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <functional>
#include <unordered_map>
#include <cctype>
#include <thread>
#include <unistd.h>

namespace {
std::map<std::string,CefRefPtr<BrowserClient>> tabs;
std::string active;
int W=1280,H=800;

class LambdaTask : public CefTask {
public:
  explicit LambdaTask(std::function<void()> fn):fn_(std::move(fn)){}
  void Execute() override { fn_(); }
private:
  std::function<void()> fn_;
  IMPLEMENT_REFCOUNTING(LambdaTask);
};

void postUi(std::function<void()> fn){ CefPostTask(TID_UI,new LambdaTask(std::move(fn))); }
std::string value(const std::unordered_map<std::string,std::string>& m,const char* k,const std::string& d=""){auto i=m.find(k);return i==m.end()?d:i->second;}
int integer(const std::unordered_map<std::string,std::string>& m,const char* k,int d){try{return std::stoi(value(m,k,std::to_string(d)));}catch(...){return d;}}
int vk(const std::string& code){static const std::map<std::string,int> m={{"Enter",0x0D},{"Escape",0x1B},{"Backspace",0x08},{"Tab",0x09},{"Space",0x20},{"ArrowLeft",0x25},{"ArrowUp",0x26},{"ArrowRight",0x27},{"ArrowDown",0x28},{"Delete",0x2E},{"Home",0x24},{"End",0x23},{"PageUp",0x21},{"PageDown",0x22},{"Insert",0x2D},{"F5",0x74},{"F6",0x75},{"F7",0x76},{"F8",0x77},{"F9",0x78},{"F10",0x79},{"F11",0x7A},{"F12",0x7B}};auto i=m.find(code);if(i!=m.end())return i->second;if(code.rfind("Key",0)==0&&code.size()==4)return std::toupper((unsigned char)code[3]);if(code.rfind("Digit",0)==0&&code.size()==6)return code[5];return 0;}
void createTab(DisplayServer& ds,const std::string& id,const std::string& url){if(tabs.count(id))return;auto c=CefRefPtr<BrowserClient>(new BrowserClient(&ds,id,W,H));tabs[id]=c;CefWindowInfo wi;wi.SetAsWindowless(0);CefBrowserSettings bs;CefBrowserHost::CreateBrowser(wi,c,url.empty()?"about:blank":url,bs,nullptr,nullptr);}
void applyCommand(DisplayServer& ds,const std::string& raw){
  auto m=jsonutil::parseObject(raw);auto type=value(m,"type");std::string id=value(m,"id",active);
  if(type=="create"){createTab(ds,id,value(m,"url","about:blank"));active=id;for(auto& [tid,c]:tabs)c->setActive(tid==active);return;}
  auto it=tabs.find(id);if(it==tabs.end())return;auto b=it->second->browser();
  if(type=="activate"){active=id;for(auto& [tid,c]:tabs)c->setActive(tid==active);return;}
  if(!b)return;
  if(type=="navigate")b->GetMainFrame()->LoadURL(value(m,"url","about:blank"));
  else if(type=="back")b->GoBack();
  else if(type=="forward")b->GoForward();
  else if(type=="reload")b->Reload();
  else if(type=="stop")b->StopLoad();
  else if(type=="resize")it->second->resize(integer(m,"width",W),integer(m,"height",H));
  else if(type=="close"){b->GetHost()->CloseBrowser(false);tabs.erase(it);if(active==id&&!tabs.empty())active=tabs.begin()->first;}
  else if(type=="key"){
    CefKeyEvent e;e.type=CefKeyEvent::KEYEVENT_RAWKEYDOWN;e.windows_key_code=vk(value(m,"code"));e.native_key_code=e.windows_key_code;e.modifiers=0;
    if(value(m,"ctrl")=="1")e.modifiers|=EVENTFLAG_CONTROL_DOWN;if(value(m,"alt")=="1")e.modifiers|=EVENTFLAG_ALT_DOWN;if(value(m,"shift")=="1")e.modifiers|=EVENTFLAG_SHIFT_DOWN;if(value(m,"meta")=="1")e.modifiers|=EVENTFLAG_COMMAND_DOWN;
    b->GetHost()->SendKeyEvent(e);if(value(m,"phase")=="up"){e.type=CefKeyEvent::KEYEVENT_KEYUP;b->GetHost()->SendKeyEvent(e);}else{std::string key=value(m,"key");if(key.size()==1){e.type=CefKeyEvent::KEYEVENT_CHAR;e.character=(wchar_t)(unsigned char)key[0];e.unmodified_character=e.character;b->GetHost()->SendKeyEvent(e);}}
  } else if(type=="mouse"){
    CefMouseEvent e;e.x=integer(m,"x");e.y=integer(m,"y");e.modifiers=0;std::string button=value(m,"button");if(button=="left")b->GetHost()->SendMouseClickEvent(e,MBT_LEFT,value(m,"phase")=="up",1);else if(button=="right")b->GetHost()->SendMouseClickEvent(e,MBT_RIGHT,value(m,"phase")=="up",1);else if(button=="middle")b->GetHost()->SendMouseClickEvent(e,MBT_MIDDLE,value(m,"phase")=="up",1);else b->GetHost()->SendMouseMoveEvent(e,false);
  } else if(type=="wheel"){CefMouseEvent e;e.x=integer(m,"x");e.y=integer(m,"y");b->GetHost()->SendMouseWheelEvent(e,0,integer(m,"delta",-120));}
}
}

int main(int argc,char* argv[]){
  CefMainArgs args(argc,argv);auto app=CefRefPtr<BrowserApp>(new BrowserApp());int code=CefExecuteProcess(args,app,nullptr);if(code>=0)return code;
  CefSettings settings;settings.no_sandbox=false;settings.windowless_rendering_enabled=true;settings.multi_threaded_message_loop=false;settings.log_severity=LOGSEVERITY_WARNING;
  const char* data=std::getenv("SOLOHOST_BROWSER_DATA");CefString(&settings.user_data_path)=data?data:"/app/data/chromium";CefString(&settings.cache_path)=data?data:"/app/data/chromium";CefString(&settings.root_cache_path)=data?data:"/app/data/chromium";CefString(&settings.resources_dir_path)="/app/cef/Resources";CefString(&settings.locales_dir_path)="/app/cef/Release/locales";CefString(&settings.browser_subprocess_path)="/app/native-bin/solohost-browser-core";
  if(!CefInitialize(args,settings,app,nullptr))return 2;
  DisplayServer ds((uint16_t)(std::getenv("BROWSER_CORE_PORT")?std::atoi(std::getenv("BROWSER_CORE_PORT")):9223));ds.start();
  postUi([&ds](){createTab(ds,"tab-1","about:blank");active="tab-1";});
  std::atomic<bool> worker{true};std::thread commandThread([&](){while(worker){while(ds.hasCommand()){auto raw=ds.takeCommand();postUi([&ds,raw](){applyCommand(ds,raw);});}std::this_thread::sleep_for(std::chrono::milliseconds(4));}});
  CefRunMessageLoop();worker=false;if(commandThread.joinable())commandThread.join();ds.stop();CefShutdown();return 0;
}
