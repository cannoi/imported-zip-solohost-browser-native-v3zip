#include "browser_client.h"
#include "display_server.h"
#include "json_util.h"
#include <jpeglib.h>
#include <cstring>
#include <sstream>
#include <algorithm>

BrowserClient::BrowserClient(DisplayServer* server,std::string id,int width,int height)
  :server_(server),id_(std::move(id)),width_(width),height_(height){}

bool BrowserClient::GetViewRect(CefRefPtr<CefBrowser>,CefRect& rect){rect=CefRect(0,0,width_.load(),height_.load());return true;}
void BrowserClient::resize(int w,int h){width_=std::max(1,w);height_=std::max(1,h);std::lock_guard<std::mutex> l(browser_mutex_);if(browser_)browser_->GetHost()->WasResized();}
void BrowserClient::setActive(bool active){active_=active;CefRefPtr<CefBrowser> b;{std::lock_guard<std::mutex> l(browser_mutex_);b=browser_;}if(b)b->GetHost()->WasHidden(!active);}
void BrowserClient::OnAfterCreated(CefRefPtr<CefBrowser> b){{std::lock_guard<std::mutex> l(browser_mutex_);browser_=b;}setActive(active_.load());server_->broadcastJson("{\"type\":\"tab\",\"event\":\"created\",\"id\":"+jsonutil::quote(id_)+"}");}
void BrowserClient::OnBeforeClose(CefRefPtr<CefBrowser>){closed_=true;server_->broadcastJson("{\"type\":\"tab\",\"event\":\"closed\",\"id\":"+jsonutil::quote(id_)+"}");}
void BrowserClient::OnTitleChange(CefRefPtr<CefBrowser>,const CefString& title){server_->broadcastJson("{\"type\":\"tab\",\"event\":\"state\",\"id\":"+jsonutil::quote(id_)+",\"title\":"+jsonutil::quote(title.ToString())+"}");}
void BrowserClient::OnAddressChange(CefRefPtr<CefBrowser>,CefRefPtr<CefFrame>,const CefString& url){server_->broadcastJson("{\"type\":\"tab\",\"event\":\"state\",\"id\":"+jsonutil::quote(id_)+",\"url\":"+jsonutil::quote(url.ToString())+"}");}
void BrowserClient::OnLoadError(CefRefPtr<CefBrowser>,CefRefPtr<CefFrame> frame,ErrorCode error,const CefString&,const CefString& failedUrl){if(error==ERR_ABORTED)return;if(frame&&frame->IsMain())server_->broadcastJson("{\"type\":\"error\",\"id\":"+jsonutil::quote(id_)+",\"url\":"+jsonutil::quote(failedUrl.ToString())+",\"code\":"+std::to_string((int)error)+"}");}

std::vector<uint8_t> BrowserClient::encodeJpeg(const void* buffer,int width,int height) const{
  std::vector<uint8_t> out; jpeg_compress_struct cinfo{}; jpeg_error_mgr jerr{}; cinfo.err=jpeg_std_error(&jerr);jpeg_create_compress(&cinfo);unsigned char* mem=nullptr;unsigned long size=0;jpeg_mem_dest(&cinfo,&mem,&size);cinfo.image_width=width;cinfo.image_height=height;cinfo.input_components=3;cinfo.in_color_space=JCS_RGB;jpeg_set_defaults(&cinfo);jpeg_set_quality(&cinfo,78,TRUE);jpeg_start_compress(&cinfo,TRUE);
  const uint8_t* src=(const uint8_t*)buffer;std::vector<uint8_t> row((size_t)width*3);JSAMPROW rp[1];while(cinfo.next_scanline<cinfo.image_height){const uint8_t* p=src+(size_t)cinfo.next_scanline*width*4;for(int x=0;x<width;++x){row[x*3]=p[x*4+2];row[x*3+1]=p[x*4+1];row[x*3+2]=p[x*4];}rp[0]=row.data();jpeg_write_scanlines(&cinfo,rp,1);}jpeg_finish_compress(&cinfo);out.assign(mem,mem+size);free(mem);jpeg_destroy_compress(&cinfo);return out;
}
void BrowserClient::OnPaint(CefRefPtr<CefBrowser>,PaintElementType type,const RectList&,const void* buffer,int width,int height){if(type!=PET_VIEW||!active_)return;auto jpeg=encodeJpeg(buffer,width,height);server_->broadcastFrame(width,height,jpeg);}
