#include "json_util.h"
#include <cctype>
#include <vector>

namespace {
std::string trim(std::string s) {
  size_t a=0,b=s.size();
  while(a<b && std::isspace((unsigned char)s[a])) ++a;
  while(b>a && std::isspace((unsigned char)s[b-1])) --b;
  return s.substr(a,b-a);
}
std::string unquote(std::string s) {
  s=trim(s);
  if(s.size()<2 || s.front()!='"' || s.back()!='"') return s;
  std::string o;
  bool esc=false;
  for(size_t i=1;i+1<s.size();++i){
    char c=s[i];
    if(esc){ if(c=='n') o+='\n'; else if(c=='r') o+='\r'; else if(c=='t') o+='\t'; else o+=c; esc=false; }
    else if(c=='\\') esc=true; else o+=c;
  }
  return o;
}
}
namespace jsonutil {
std::unordered_map<std::string,std::string> parseObject(const std::string& s){
  std::unordered_map<std::string,std::string> out;
  bool in=false,esc=false; size_t start=0; std::vector<std::string> parts;
  for(size_t i=0;i<s.size();++i){char c=s[i]; if(esc){esc=false;continue;} if(c=='\\'&&in){esc=true;continue;} if(c=='"')in=!in; if(c==','&&!in){parts.push_back(s.substr(start,i-start));start=i+1;}}
  if(start<s.size()) parts.push_back(s.substr(start));
  for(auto &p:parts){in=false;esc=false;size_t colon=std::string::npos;for(size_t i=0;i<p.size();++i){char c=p[i];if(esc){esc=false;continue;}if(c=='\\'&&in){esc=true;continue;}if(c=='"')in=!in;if(c==':'&&!in){colon=i;break;}}if(colon==std::string::npos)continue;out[unquote(p.substr(0,colon))]=unquote(p.substr(colon+1));}
  return out;
}
std::string escape(const std::string& s){std::string o;for(char c:s){if(c=='\\'||c=='"')o+='\\'; if(c=='\n')o+="\\n"; else if(c=='\r')o+="\\r"; else if(c=='\t')o+="\\t"; else o+=c;}return o;}
std::string quote(const std::string& s){return "\""+escape(s)+"\"";}
}
