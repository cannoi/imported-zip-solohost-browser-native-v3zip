#include "display_server.h"
#include <algorithm>
#include <chrono>

DisplayServer::DisplayServer(uint16_t port):port_(port){
  server_.clear_access_channels(websocketpp::log::alevel::all);
  server_.clear_error_channels(websocketpp::log::elevel::all);
  server_.init_asio();
  server_.set_reuse_addr(true);
  server_.set_open_handler([this](Connection h){std::lock_guard<std::mutex> l(conn_mutex_);connections_.push_back(h);});
  server_.set_close_handler([this](Connection h){std::lock_guard<std::mutex> l(conn_mutex_);connections_.erase(std::remove_if(connections_.begin(),connections_.end(),[&](auto& x){return !x.owner_before(h)&&!h.owner_before(x);}),connections_.end());});
  server_.set_message_handler([this](Connection,Server::message_ptr m){std::lock_guard<std::mutex> l(cmd_mutex_);commands_.push_back(m->get_payload());});
}
DisplayServer::~DisplayServer(){stop();}
void DisplayServer::start(){if(running_.exchange(true))return;thread_=std::thread(&DisplayServer::run,this);}
void DisplayServer::run(){websocketpp::lib::error_code ec;auto a=websocketpp::lib::asio::ip::tcp::endpoint(websocketpp::lib::asio::ip::address::from_string("127.0.0.1",ec),port_);server_.listen(a,ec);if(ec){running_=false;return;}server_.start_accept(ec);if(ec){running_=false;return;}server_.run();running_=false;}
void DisplayServer::stop(){if(!running_.exchange(false))return;server_.stop_listening();server_.stop();if(thread_.joinable())thread_.join();}
void DisplayServer::broadcastJson(const std::string& json){std::lock_guard<std::mutex> l(conn_mutex_);for(auto h:connections_){websocketpp::lib::error_code ec;server_.send(h,json,websocketpp::frame::opcode::text,ec);}}
void DisplayServer::broadcastFrame(uint32_t w,uint32_t h,const std::vector<uint8_t>& jpeg){
  std::vector<uint8_t> packet(12+jpeg.size()); packet[0]='S';packet[1]='H';packet[2]='B';packet[3]='1';
  packet[4]=(w>>24)&255;packet[5]=(w>>16)&255;packet[6]=(w>>8)&255;packet[7]=w&255;
  packet[8]=(h>>24)&255;packet[9]=(h>>16)&255;packet[10]=(h>>8)&255;packet[11]=h&255;
  std::copy(jpeg.begin(),jpeg.end(),packet.begin()+12);
  std::lock_guard<std::mutex> l(conn_mutex_);for(auto hdl:connections_){websocketpp::lib::error_code ec;server_.send(hdl,packet.data(),packet.size(),websocketpp::frame::opcode::binary,ec);}
}
bool DisplayServer::hasCommand(){std::lock_guard<std::mutex> l(cmd_mutex_);return !commands_.empty();}
std::string DisplayServer::takeCommand(){std::lock_guard<std::mutex> l(cmd_mutex_);if(commands_.empty())return {};auto x=commands_.front();commands_.erase(commands_.begin());return x;}
