'use strict';
/**
 * Lean intent classifier — CHAT | QUICK_LOOKUP | TASK
 * Fast deterministic rules first; no AI call required for clear cases.
 */
function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function isAgentBrief(text) {
  const t = normalize(text);
  if (t.length > 500) return true;
  if (/role\s*:|goal\s*:|step-by-step instructions|required output format|guardrails/i.test(t)) return true;
  if (/(?:hãy thực hiện|hay thuc hien|thực hiện ngay|execute now|run this task|bắt đầu ngay)/i.test(t)) return true;
  return false;
}

function isQuickLookup(text) {
  const t = normalize(text);
  if (!t || t.length > 400) return false;
  // Direct URL open
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(?:mở|mo|open|truy cập|truy cap|đi tới|di toi|go to|visit)\s+https?:\/\//i.test(t)) return true;
  // Single site open/search without multi-source comparison
  if (/^(?:hãy\s+|vui lòng\s+|please\s+)?(?:mở|mo|open|tìm trên|search on)\s+(?:youtube|google|facebook|tiktok)\b/i.test(t) && !isTask(text)) return true;
  return false;
}

function isTask(text) {
  const t = normalize(text);
  const low = t.toLowerCase();
  if (isAgentBrief(t)) return true;

  // Multi-source / research / comparison — even short natural questions
  if (/(?:so sánh|so sanh|compare|versus|\bvs\.?\b)/i.test(low)) return true;
  if (/(?:giá|price|bao nhiêu tiền|cost of|how much).{0,80}(?:rẻ|cheap|nơi bán|where to buy|nhà bán|retailer|store|cửa hàng)/i.test(low)) return true;
  if (/(?:nơi nào bán|where (?:can i )?buy|best price|giá rẻ nhất)/i.test(low)) return true;
  if (/(?:tổng hợp|tong hop|digest|tin tức|news).{0,40}(?:24\s*h|hôm nay|today|nhiều nguồn|multiple)/i.test(low)) return true;
  if (/(?:nghiên cứu|nghien cuu|research|deep dive|thu thập|thu thap|extract|crawl|scrape)/i.test(low)) return true;
  if (/(?:tìm\s+\d+|find\s+\d+|top\s*\d+|liệt kê|liet ke|list\s+\d+)/i.test(low)) return true;
  if (/(?:báo cáo|bao cao|markdown table|ma trận|matrix)/i.test(low)) return true;
  // Product + price without explicit "compare"
  if (/(?:iphone|samsung|pixel|laptop|macbook|ipad).{0,60}(?:giá|price|bao nhiêu)/i.test(low)) return true;
  if (/(?:giá|price).{0,60}(?:iphone|samsung|pixel|laptop|macbook)/i.test(low)) return true;
  // Multi-URL in one request
  const urls = t.match(/https?:\/\/[^\s]+/gi) || [];
  if (urls.length >= 2) return true;
  // Long imperative with web target
  if (t.length > 120 && /(?:hãy|please|giúp|help).{0,20}(?:tìm|find|search|mở|open|đọc|read)/i.test(low)) return true;
  return false;
}

function isChat(text) {
  const t = normalize(text);
  if (!t) return true;
  if (isTask(t) || isQuickLookup(t)) return false;
  // Greetings / pure Q&A
  if (/^(?:xin chào|chào|hello|hi|hey|cảm ơn|thanks|who are you|bạn là ai)\b/i.test(t)) return true;
  if (/^(?:giải thích|explain|viết|write|dịch|translate|tóm tắt đoạn)\b/i.test(t) && !/(https?:|giá|price|so sánh)/i.test(t)) return true;
  return true; // default chat when not task/lookup
}

/**
 * @returns {{ kind: 'CHAT'|'QUICK_LOOKUP'|'TASK', reason: string }}
 */
function classifyIntent(text) {
  const t = normalize(text);
  if (!t) return { kind: 'CHAT', reason: 'empty' };
  if (isTask(t)) return { kind: 'TASK', reason: 'multi_step_or_research' };
  if (isQuickLookup(t)) return { kind: 'QUICK_LOOKUP', reason: 'single_open_or_search' };
  return { kind: 'CHAT', reason: 'conversational' };
}

module.exports = { classifyIntent, isTask, isQuickLookup, isChat, isAgentBrief, normalize };
