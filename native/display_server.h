#pragma once
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <websocketpp/config/asio_no_tls.hpp>
#include <websocketpp/server.hpp>

class DisplayServer {
public:
  using Server = websocketpp::server<websocketpp::config::asio>;
  using Connection = websocketpp::connection_hdl;
  explicit DisplayServer(uint16_t port);
  ~DisplayServer();
  void start();
  void stop();
  void broadcastJson(const std::string& json);
  void broadcastFrame(uint32_t width, uint32_t height, const std::vector<uint8_t>& jpeg);
  std::string takeCommand();
  bool hasCommand();
private:
  void run();
  uint16_t port_;
  Server server_;
  std::thread thread_;
  std::mutex conn_mutex_;
  std::vector<Connection> connections_;
  std::mutex cmd_mutex_;
  std::vector<std::string> commands_;
  std::atomic<bool> running_{false};
};
