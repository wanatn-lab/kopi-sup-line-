// Kopi Order Cloud — Cloudflare Worker
// Serves the order-splitting tool (embedded HTML) + a tiny JSON API backed by Workers KV
// so the shared ingredient/supplier database stays in sync between the shop PC and any phone.
// No login required — anyone with the URL can view/edit the shared data.
//
// SETUP (one time, in the Cloudflare dashboard — no CLI needed):
//   1. Workers & Pages -> Create application -> Hello World template -> Deploy
//   2. Edit code -> select all, paste this ENTIRE file's contents -> Deploy
//   3. Settings -> Bindings -> Add -> KV Namespace
//        Variable name:  KOPI_KV
//        KV namespace:   kopi-order-cloud-state   (already created)

const STATE_KEY = "kopi_state_v1";
const ACTIVE_ADMIN_KEY = "line_active_admin_user_id";


// ============================================================================
// Smart Order Splitter — LINE Bot layer
// Reuses the SAME matching rules as the web UI (normalize / alias / containment /
// near-duplicate), but as pure functions that take DICT/ALIAS_TABLE as arguments
// instead of reading module-level globals — safer under a Worker's request
// concurrency (no shared mutable state between overlapping requests).
// ============================================================================

const UNIT_WORDS_LINE = ["กิโลกรัม","กก\\.?","โล","ถุง","ห่อ","แถว","แผง","ใบ","ฟอง","คู่","กล่อง","หิ้ว","ลัง","แพ็ค","แพค","ขวด","แกลลอน","หัว","ชิ้น","ขีด","มัด","ฝา"];
const UNIT_REGEX_LINE = new RegExp("^(.*?)\\s*([\\d]+(?:\\.\\d+)?)\\s*(" + UNIT_WORDS_LINE.join("|") + ")?\\s*$");
const STORE_NAMES_LINE = ["ร้านโกปี๊ หลังโรงไม้", "The Old Offset"];
const PENDING_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days — plenty for "approve later today/tomorrow"

function lnNormalize(s){
  return (s||"").toString().toLowerCase().replace(/[\s().*=\-–—:：]/g,"");
}
function lnFirstToken(s){
  return (s||"").toString().trim().split(/\s+/)[0] || "";
}
function lnResolveCanonicalViaAlias(aliasTable, name){
  const norm = lnNormalize(name);
  let best = null, bestLen = 0;
  (aliasTable||[]).forEach(a => {
    const tNorm = lnNormalize(a.typed);
    if (tNorm && tNorm.length >= 2 && norm.includes(tNorm) && tNorm.length > bestLen){
      best = a.canonical; bestLen = tNorm.length;
    }
  });
  return best;
}
function lnFindSupplierMatches(dict, aliasTable, rawName){
  const norm = lnNormalize(rawName);

  let exact = (dict||[]).find(entry => lnNormalize(entry.name) === norm);
  if (exact) return [{ supplier: exact.supplier, canonicalName: exact.name }];

  if (/\s/.test((rawName||"").trim())){
    const firstNorm = lnNormalize(lnFirstToken(rawName));
    if (firstNorm && firstNorm !== norm){
      const firstWordMatch = (dict||[]).find(entry => lnNormalize(entry.name) === firstNorm);
      if (firstWordMatch) return [{ supplier: firstWordMatch.supplier, canonicalName: firstWordMatch.name }];
    }
  }

  const aliasCanonical = lnResolveCanonicalViaAlias(aliasTable, rawName);
  if (aliasCanonical){
    const aliasNorm = lnNormalize(aliasCanonical);
    const target = (dict||[]).find(entry => lnNormalize(entry.name) === aliasNorm);
    if (target) return [{ supplier: target.supplier, canonicalName: target.name }];
    return [{ supplier: null, canonicalName: aliasCanonical, missingSupplier: true }];
  }

  let candidates = [], bestLen = 0;
  for (const entry of (dict||[])){
    const entryNorm = lnNormalize(entry.name);
    let hit = false;
    if (norm.length >= 3 && entryNorm.includes(norm)) hit = true;
    else if (entryNorm.length >= 3 && norm.includes(entryNorm)) hit = true;
    if (hit){
      const len = entryNorm.length;
      if (len > bestLen){ candidates = [entry]; bestLen = len; }
      else if (len === bestLen){ candidates.push(entry); }
    }
  }
  const bySupplier = {};
  candidates.forEach(c => { bySupplier[c.supplier] = c.name; });
  return Object.keys(bySupplier).map(s => ({ supplier: s, canonicalName: bySupplier[s], viaContainment: true }));
}
function lnParseLine(line){
  let s = line.trim();
  if (!s) return null;
  s = s.replace(/ครึ่ง/g, "0.5 ");
  const m = s.match(UNIT_REGEX_LINE);
  let name, qty, unit;
  if (m && m[2]){
    name = m[1].trim().replace(/[=(]+$/,"").trim();
    qty = m[2];
    unit = m[3] || "";
  } else {
    const strippedForTokens = s.replace(/\(.*?\)/g,"").trim();
    const tokens = strippedForTokens.split(/\s+/);
    if (tokens.length >= 2){
      name = tokens[0]; qty = tokens[1]; unit = tokens[2] || "";
    } else {
      name = strippedForTokens; qty = "?"; unit = "";
    }
  }
  name = name.replace(/(เหลือ|หมด)\s*$/,"").trim();
  if (!name) name = s;
  return { raw: line.trim(), name, qty, unit };
}
function lnIsStoreHeader(line){
  const norm = lnNormalize(line);
  if (!norm || norm.length > 40) return null;
  if (norm.includes(lnNormalize("โกปี๊")) || norm.includes("kopi")) return STORE_NAMES_LINE[0];
  if (norm.includes("oldoffset") || norm.includes(lnNormalize("ดิโอลด์"))) return STORE_NAMES_LINE[1];
  return null;
}
function lnGenId(prefix){
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Parses one LINE text message into { bySupplier: {supplierName: [items]}, unmatched: [rawLine,...] }
// — grouped by supplier (not by store department) since that's what the bot needs to build one
// Flex bubble per supplier to approve/send.
function lnParseMessageIntoSupplierGroups(rawText, dict, aliasTable){
  const lines = (rawText || "").split("\n");
  const bySupplier = {};
  const supplierOrder = [];
  const unmatched = [];
  let currentDept = null;

  lines.forEach(line => {
    if (!line.trim()) return;
    const headerMatch = lnIsStoreHeader(line);
    if (headerMatch){ currentDept = headerMatch; return; }
    const parsed = lnParseLine(line);
    if (!parsed) return;

    const matches = lnFindSupplierMatches(dict, aliasTable, parsed.name);
    let supplier = null, label = parsed.name;
    if (matches.length >= 1 && matches[0].supplier && !matches[0].viaContainment){
      supplier = matches[0].supplier; label = matches[0].canonicalName;
    } else if (matches.length === 1 && matches[0].supplier && matches[0].viaContainment){
      // containment guess — good enough for an automated bot suggestion, not a full app
      // confirmation flow like the web UI, so treat it as resolved but keep the guessed name.
      supplier = matches[0].supplier; label = matches[0].canonicalName;
    }

    if (!supplier){
      unmatched.push({ id: lnGenId("u"), raw: parsed.raw, label, qty: parsed.qty, unit: parsed.unit, department: currentDept });
      return;
    }
    if (!bySupplier[supplier]){ bySupplier[supplier] = []; supplierOrder.push(supplier); }
    const existing = bySupplier[supplier].find(i => i.label === label && i.unit === parsed.unit);
    if (existing && parsed.qty !== "?" && existing.qty !== "?"){
      existing.qty = (parseFloat(existing.qty) || 0) + (parseFloat(parsed.qty) || 0);
    } else {
      bySupplier[supplier].push({ id: lnGenId("i"), label, qty: parsed.qty, unit: parsed.unit, department: currentDept });
    }
  });

  return { bySupplier, supplierOrder, unmatched };
}

// ---------------- LINE signature verification (Web Crypto — Workers has no Node `crypto`) ----------------
function lnBase64FromBuffer(buffer){
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
async function verifyLineSignature(rawBody, signatureHeader, channelSecret){
  if (!signatureHeader || !channelSecret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(channelSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return lnBase64FromBuffer(sigBuffer) === signatureHeader;
}

// ---------------- LINE Messaging API helpers ----------------
async function lineReply(replyToken, messages, accessToken){
  return fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
    body: JSON.stringify({ replyToken, messages })
  });
}
async function linePush(userId, messages, accessToken){
  return fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken },
    body: JSON.stringify({ to: userId, messages })
  });
}

// The order controls must never be sent to the person who placed an order.
// Keep the original single-admin setting, while allowing an optional comma-separated
// ADMIN_LINE_USER_IDS list if another manager is added later.
function isAdminLineUser(env, userId, activeAdminId){
  if (!userId) return false;
  const adminIds = [activeAdminId || env.OWNER_LINE_USER_ID]
    .concat(String(env.ADMIN_LINE_USER_IDS || "").split(","))
    .map(id => id && id.trim())
    .filter(Boolean);
  return adminIds.includes(userId);
}

async function getActiveAdminId(env){
  const pairedAdminId = env.KOPI_KV && await env.KOPI_KV.get(ACTIVE_ADMIN_KEY);
  return pairedAdminId || env.OWNER_LINE_USER_ID || "";
}

// ---------------- Flex Message (Carousel) builder ----------------
// Unique list of supplier names known in the shared dict — used to build the
// "ย้ายไปซัพอื่น" (move to another supplier) quick-reply choices.
function getKnownSuppliers(dict){
  const seen = new Set();
  const list = [];
  (dict || []).forEach(entry => {
    if (entry && entry.supplier && !seen.has(entry.supplier)){
      seen.add(entry.supplier);
      list.push(entry.supplier);
    }
  });
  return list;
}
function buildSupplierBubble(supplierName, items, pendingId, liffBaseUrl){
  const rows = items.map(it => ({
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: it.label, size: "sm", flex: 4, wrap: true, color: "#1f2937" },
      { type: "text", text: (it.qty || "?") + " " + (it.unit || ""), size: "sm", flex: 2, align: "end", color: "#6b7280" }
    ]
  }));
  const bubble = {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "vertical",
      backgroundColor: "#ecfdf5",
      contents: [{ type: "text", text: "📦 " + supplierName, weight: "bold", size: "md", color: "#065f46" }]
    },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: rows.length ? rows : [{ type: "text", text: "(ไม่มีรายการ)", size: "sm", color: "#9ca3af" }] },
    footer: {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        {
          type: "button", style: "primary", color: "#16a34a", height: "sm",
          action: { type: "postback", label: "✅ ส่งเลย", data: "send:" + pendingId + ":" + encodeURIComponent(supplierName), displayText: "ส่ง " + supplierName + " เลย" }
        },
        {
          type: "button", style: "secondary", height: "sm",
          action: liffBaseUrl
            ? { type: "uri", label: "✏️ แก้ไข", uri: liffBaseUrl + "?id=" + encodeURIComponent(pendingId) + "&supplier=" + encodeURIComponent(supplierName) }
            : { type: "postback", label: "✏️ แก้ไข", data: "editsup:" + pendingId + ":" + encodeURIComponent(supplierName), displayText: "แก้ไข " + supplierName }
        }
      ]
    }
  };
  return bubble;
}
// การ์ดแก้ไขรายการก่อนส่ง: ปรับจำนวน +/- ทีละ 1 หรือย้ายรายการไปซัพพลายเออร์อื่น
// ทั้งหมดทำผ่านปุ่มในแชท (postback) ไม่ต้องเปิดหน้าเว็บ LIFF เลย
function buildEditItemsBubble(supplierName, items, pendingId){
  const itemBoxes = (items || []).map((it, idx) => ({
    type: "box", layout: "vertical", spacing: "xs", margin: idx === 0 ? "none" : "md",
    contents: [
      { type: "text", text: it.label, size: "sm", wrap: true, weight: "bold", color: "#1f2937" },
      {
        type: "box", layout: "horizontal", spacing: "sm", alignItems: "center",
        contents: [
          {
            type: "button", style: "secondary", height: "sm", flex: 1,
            action: { type: "postback", label: "➖", data: "qty:" + pendingId + ":" + encodeURIComponent(supplierName) + ":" + idx + ":-1", displayText: "ลดจำนวน " + it.label }
          },
          { type: "text", text: (it.qty || "?") + " " + (it.unit || ""), size: "sm", align: "center", flex: 2, color: "#111827", gravity: "center" },
          {
            type: "button", style: "secondary", height: "sm", flex: 1,
            action: { type: "postback", label: "➕", data: "qty:" + pendingId + ":" + encodeURIComponent(supplierName) + ":" + idx + ":1", displayText: "เพิ่มจำนวน " + it.label }
          },
          {
            type: "button", style: "secondary", height: "sm", flex: 2,
            action: { type: "postback", label: "🔀 ย้ายซัพ", data: "movesup:" + pendingId + ":" + encodeURIComponent(supplierName) + ":" + idx, displayText: "ย้าย " + it.label + " ไปซัพอื่น" }
          }
        ]
      }
    ]
  }));
  return {
    type: "bubble", size: "mega",
    header: {
      type: "box", layout: "vertical", backgroundColor: "#fffbeb",
      contents: [{ type: "text", text: "✏️ แก้ไข: " + supplierName, weight: "bold", size: "md", color: "#92400e", wrap: true }]
    },
    body: { type: "box", layout: "vertical", spacing: "md", contents: itemBoxes.length ? itemBoxes : [{ type: "text", text: "(ไม่มีรายการ)", size: "sm", color: "#9ca3af" }] },
    footer: {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        {
          type: "button", style: "primary", color: "#16a34a", height: "sm",
          action: { type: "postback", label: "✅ ส่งเลย", data: "send:" + pendingId + ":" + encodeURIComponent(supplierName), displayText: "ส่ง " + supplierName + " เลย" }
        },
        {
          type: "button", style: "secondary", height: "sm",
          action: { type: "postback", label: "🔙 กลับ", data: "back:" + pendingId, displayText: "กลับไปหน้าสรุปออเดอร์" }
        }
      ]
    }
  };
}
function buildUnmatchedBubble(unmatchedItems, pendingId, liffBaseUrl){
  const rows = unmatchedItems.map(it => ({
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: it.label, size: "sm", flex: 4, wrap: true, color: "#7f1d1d" },
      { type: "text", text: (it.qty || "?") + " " + (it.unit || ""), size: "sm", flex: 2, align: "end", color: "#b91c1c" }
    ]
  }));
  return {
    type: "bubble", size: "kilo",
    header: {
      type: "box", layout: "vertical", backgroundColor: "#fef2f2",
      contents: [{ type: "text", text: "⚠️ รายการที่จัดกลุ่มไม่ได้", weight: "bold", size: "md", color: "#b91c1c", wrap: true }]
    },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: rows },
    footer: {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: liffBaseUrl ? [
        { type: "button", style: "primary", color: "#b91c1c", height: "sm", action: { type: "uri", label: "✏️ แก้ไข", uri: liffBaseUrl + "?id=" + encodeURIComponent(pendingId) + "&unmatched=1" } },
        { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "🔄 สรุปใหม่", data: "back:" + pendingId, displayText: "ดูสรุปออเดอร์ล่าสุด" } }
      ] : [{ type: "text", text: "ตั้งค่า LIFF ก่อนเพื่อแก้ไขรายการ", size: "xs", color: "#9ca3af", wrap: true }]
    }
  };
}
function buildOrderFlexMessage(bySupplier, supplierOrder, unmatched, pendingId, liffBaseUrl){
  const bubbles = supplierOrder.map(sup => buildSupplierBubble(sup, bySupplier[sup], pendingId, liffBaseUrl));
  if (unmatched && unmatched.length) bubbles.push(buildUnmatchedBubble(unmatched, pendingId, liffBaseUrl));
  if (bubbles.length === 0){
    return { type: "text", text: "ไม่พบรายการสินค้าที่อ่านออกได้เลยครับ ลองพิมพ์ใหม่ เช่น \"น้ำมันพืช 2 ขวด\"" };
  }
  return {
    type: "flex",
    altText: "สรุปออเดอร์แยกซัพพลายเออร์ " + supplierOrder.length + " ราย" + (unmatched.length ? " (มีรายการที่จัดกลุ่มไม่ได้ " + unmatched.length + " รายการ)" : ""),
    contents: { type: "carousel", contents: bubbles }
  };
}

function buildAdminDraftFlexMessage(bubbles){
  if (!bubbles.length) return { type: "text", text: "ไม่พบรายการที่ส่งต่อให้แอดมิน" };
  return {
    type: "flex",
    altText: "มีรายการรอตรวจสอบ " + bubbles.length + " หมวด",
    contents: { type: "carousel", contents: bubbles.slice(0, 12) }
  };
}

function draftKey(adminId, name){
  return "line_open_draft:" + encodeURIComponent(adminId) + ":" + encodeURIComponent(name);
}

function mergeDraftItems(existingItems, incomingItems){
  const merged = Array.isArray(existingItems) ? existingItems.slice() : [];
  (incomingItems || []).forEach((incoming) => {
    const found = merged.find((item) => item.label === incoming.label && item.unit === incoming.unit && item.department === incoming.department);
    if (found && found.qty !== "?" && incoming.qty !== "?") {
      found.qty = String(Math.round(((Number(found.qty) || 0) + (Number(incoming.qty) || 0)) * 100) / 100);
    } else {
      merged.push(incoming);
    }
  });
  return merged;
}

async function upsertSupplierDraft(kv, adminId, supplier, items, metadata){
  const key = draftKey(adminId, supplier);
  const existingId = await kv.get(key);
  let pendingId = existingId || lnGenId("p");
  let record = existingId ? await kv.get("line_pending:" + existingId, { type: "json" }) : null;
  if (!record || record.sentSuppliers && record.sentSuppliers[supplier]) {
    pendingId = lnGenId("p");
    record = { bySupplier: {}, supplierOrder: [supplier], unmatched: [], createdAt: Date.now(), userId: metadata.userId, submittedByAdmin: metadata.submittedByAdmin, sentSuppliers: {} };
  }
  record.bySupplier = record.bySupplier || {};
  record.bySupplier[supplier] = mergeDraftItems(record.bySupplier[supplier], items);
  if (!Array.isArray(record.supplierOrder)) record.supplierOrder = [supplier];
  if (!record.supplierOrder.includes(supplier)) record.supplierOrder.push(supplier);
  record.updatedAt = Date.now();
  await kv.put("line_pending:" + pendingId, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
  await kv.put(key, pendingId, { expirationTtl: PENDING_TTL_SECONDS });
  return { pendingId, record };
}

async function upsertUnmatchedDraft(kv, adminId, items, metadata){
  const key = draftKey(adminId, "__unmatched__");
  const existingId = await kv.get(key);
  let pendingId = existingId || lnGenId("p");
  let record = existingId ? await kv.get("line_pending:" + existingId, { type: "json" }) : null;
  if (!record) {
    record = { bySupplier: {}, supplierOrder: [], unmatched: [], createdAt: Date.now(), userId: metadata.userId, submittedByAdmin: metadata.submittedByAdmin, sentSuppliers: {} };
  }
  record.unmatched = mergeDraftItems(record.unmatched, items);
  record.updatedAt = Date.now();
  await kv.put("line_pending:" + pendingId, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
  await kv.put(key, pendingId, { expirationTtl: PENDING_TTL_SECONDS });
  return { pendingId, record };
}

async function pushLatestDraftCard(env, adminUserId, pendingId, record, notice){
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !adminUserId || !record) return;
  const liffBaseUrl = env.LIFF_ID ? (env.LIFF_BASE_URL || ("https://liff.line.me/" + env.LIFF_ID)) : "";
  const supplierOrder = (record.supplierOrder || Object.keys(record.bySupplier || {}))
    .filter((supplier) => Array.isArray(record.bySupplier && record.bySupplier[supplier]) && record.bySupplier[supplier].length);
  const summary = buildOrderFlexMessage(record.bySupplier || {}, supplierOrder, record.unmatched || [], pendingId, liffBaseUrl);
  const cardMessage = summary.type === "flex"
    ? summary
    : { type: "text", text: summary.text || "ออเดอร์นี้ไม่มีรายการเหลือแล้ว" };
  const response = await linePush(
    adminUserId,
    [{ type: "text", text: "✏️ อัปเดตล่าสุด: " + notice }, cardMessage],
    env.LINE_CHANNEL_ACCESS_TOKEN
  );
  if (!response.ok) console.error("[line latest-draft push failed]", response.status, await response.text());
}

function formatSupplierPlainText(supplierName, items){
  const date = new Date().toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" });
  let text = "รายการสั่งของวันที่ " + date + "\n- ซัพพลายเออร์ " + supplierName + ":\n";
  items.forEach(it => { text += "  • " + it.label + " " + (it.qty || "?") + " " + (it.unit || "") + "\n"; });
  return text.trim();
}

// A LIFF URL contains a pending-order ID, but it is not authentication. Verify
// the raw ID token with LINE and allow only the configured admin to edit orders.
async function getVerifiedLiffOwnerId(request, env){
  const idToken = request.headers.get("X-LIFF-ID-TOKEN");
  if (!idToken) return { error: new Response("LIFF login required", { status: 401 }) };
  const activeAdminId = await getActiveAdminId(env);
  if (!env.LIFF_CHANNEL_ID || !activeAdminId) {
    return { error: new Response("LIFF admin settings are incomplete", { status: 503 }) };
  }
  try {
    const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: env.LIFF_CHANNEL_ID }).toString()
    });
    if (!response.ok) return { error: new Response("Invalid LIFF login", { status: 401 }) };
    const profile = await response.json();
    if (!isAdminLineUser(env, profile.sub, activeAdminId)) {
      return { error: new Response("Admin permission required", { status: 403 }) };
    }
    return { userId: profile.sub };
  } catch (error) {
    console.error("[liff token verification failed]", error);
    return { error: new Response("Could not verify LIFF login", { status: 502 }) };
  }
}

function normalizeEditedQuantity(value){
  const text = String(value == null ? "" : value).trim();
  if (text === "?") return "?";
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100);
}

function normalizeEditedUnit(value, fallback){
  if (value === undefined) return String(fallback || "").trim();
  if (typeof value !== "string") return null;
  const unit = value.trim().replace(/\s+/g, " ");
  if (unit.length > 30 || /[\r\n]/.test(unit)) return null;
  return unit;
}

function ensureUnmatchedItemIds(record){
  if (!Array.isArray(record.unmatched)) record.unmatched = [];
  record.unmatched = record.unmatched.map((item) => Object.assign({}, item, { id: item.id || lnGenId("u") }));
  return record.unmatched;
}

const HTML_PAGE = "<!doctype html>\n<html lang=\"th\">\n<head>\n<meta charset=\"utf-8\">\n<title>แยกออเดอร์สั่งของ — โกปี๊ / The Old Offset</title>\n<style>\n  :root { color-scheme: light; }\n  * { box-sizing: border-box; }\n  body {\n    margin: 0; padding: 24px; background: #F7F6F2; color: #2A2A28;\n    font-family: 'Segoe UI', 'Noto Sans Thai', Tahoma, Arial, sans-serif;\n    font-size: 14px; line-height: 1.5;\n  }\n  h1 { font-size: 20px; margin: 0 0 4px; color: #2F5233; }\n  .sub { color: #767267; margin: 0 0 20px; font-size: 13px; }\n  .card {\n    background: #fff; border: 1px solid #E7E3D8; border-radius: 10px;\n    padding: 18px; margin-bottom: 18px;\n  }\n  .card h2 { font-size: 15px; margin: 0 0 12px; color: #2F5233; }\n  textarea {\n    width: 100%; min-height: 220px; border: 1px solid #D8D3C4; border-radius: 8px;\n    padding: 10px; font-family: 'Noto Sans Thai', inherit; font-size: 13.5px; resize: vertical;\n  }\n  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }\n  select, input[type=text] {\n    border: 1px solid #D8D3C4; border-radius: 6px; padding: 7px 10px; font-size: 13px;\n    font-family: inherit;\n  }\n  button {\n    background: #2F5233; color: #fff; border: none; border-radius: 6px;\n    padding: 9px 16px; font-size: 13.5px; cursor: pointer; font-family: inherit;\n  }\n  button:hover { background: #244028; }\n  button.secondary { background: #fff; color: #2F5233; border: 1px solid #2F5233; }\n  button.secondary:hover { background: #EFF3EC; }\n  button.small { padding: 5px 10px; font-size: 12px; }\n  button.danger { background: #fff; color: #B3413A; border: 1px solid #B3413A; }\n  .store-block { margin-top: 22px; }\n  .store-title {\n    font-weight: 700; font-size: 15px; color: #2F5233; margin: 0 0 10px;\n    border-bottom: 2px solid #2F5233; padding-bottom: 6px;\n  }\n  .supplier-box {\n    border: 1px solid #E7E3D8; border-radius: 14px; margin-bottom: 12px; overflow: hidden;\n    box-shadow: 0 1px 3px rgba(20,20,18,.06);\n  }\n  .supplier-head {\n    background: #2F5233; color: #fff; padding: 12px 16px; font-weight: 700; font-size: 13.5px;\n    display: flex; justify-content: space-between; align-items: center;\n  }\n  .supplier-head .count-pill {\n    background: rgba(255,255,255,.22); border-radius: 999px; padding: 1px 9px;\n    font-size: 11.5px; font-weight: 700; margin-left: 6px;\n  }\n  .supplier-body {\n    padding: 12px 16px; white-space: pre-wrap; font-size: 13.5px; background: #FAFAF6;\n  }\n  .unmatched-table { width: 100%; border-collapse: collapse; font-size: 13px; }\n  .unmatched-table th, .unmatched-table td {\n    text-align: left; padding: 6px 8px; border-bottom: 1px solid #EEEBE1;\n  }\n  .unmatched-table th { color: #767267; font-weight: 600; font-size: 12px; }\n  .flag { color: #B3413A; font-weight: 600; }\n  .muted { color: #9A9587; font-size: 12px; }\n  details summary { cursor: pointer; font-weight: 600; color: #2F5233; }\n  .pill {\n    display: inline-block; background: #EFF3EC; color: #2F5233; border-radius: 999px;\n    padding: 2px 10px; font-size: 12px; margin-left: 6px;\n  }\n  .dict-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }\n  .dict-table th, .dict-table td { padding: 5px 7px; border-bottom: 1px solid #EEEBE1; text-align: left; }\n  .dict-group { border: 1px solid #E7E3D8; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }\n  .dict-group-head {\n    background: #EFF3EC; color: #2F5233; padding: 6px 12px; font-weight: 700; font-size: 12.5px;\n    display: flex; justify-content: space-between; align-items: center;\n  }\n  .dict-row {\n    display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-top: 1px solid #F0EDE3; font-size: 12.5px;\n  }\n  .dict-row input[type=text] { flex: 1; min-width: 0; padding: 5px 8px; font-size: 12.5px; }\n  .dict-row select { font-size: 12.5px; padding: 5px 8px; }\n  .toast {\n    position: fixed; bottom: 20px; right: 20px; background: #2F5233; color: #fff;\n    padding: 10px 16px; border-radius: 8px; font-size: 13px; opacity: 0; pointer-events: none;\n    transition: opacity .25s;\n  }\n  .toast.show { opacity: 1; }\n  .tab-bar {\n    display: flex; gap: 4px; border-bottom: 2px solid #E7E3D8; margin-bottom: 16px; flex-wrap: wrap;\n  }\n  .tab-btn {\n    background: none; border: none; padding: 10px 14px 9px; font-size: 13.5px; font-weight: 600;\n    color: #767267; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px;\n    font-family: inherit; border-radius: 0;\n  }\n  .tab-btn:hover { color: #2F5233; }\n  .tab-btn.active { color: #2F5233; border-bottom-color: #2F5233; }\n  .tab-panel { display: none; }\n  .tab-panel.active { display: block; }\n  .summary-row { cursor: pointer; }\n  .summary-row:hover td { background: #EFF3EC; }\n\n  /* ---------- Top-level Inbox / Dispatch / Menu layout ----------\n     A sticky white header + 3-tab bar sits above everything else — styled to match the\n     owner's reference mockup (rounded icon badge, circular refresh button, inline tabs with\n     an underlined active state) — while every feature underneath (processing, supplier\n     boxes, ฐานข้อมูลวัตถุดิบ, คำเทียบเคียง...) is completely untouched. */\n  .sticky-top { position: sticky; top: 0; z-index: 40; margin: -24px -24px 20px; background: #fff; }\n  .app-header { padding: 14px 20px 10px; border-bottom: 1px solid #F0EDE3; }\n  .app-header-inner { display: flex; justify-content: space-between; align-items: center; gap: 12px; }\n  .app-header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }\n  .app-icon {\n    width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;\n    background: linear-gradient(135deg, #0D7377, #14B8A6);\n    display: flex; align-items: center; justify-content: center; font-size: 19px;\n  }\n  .app-header h1 { color: #22201C; font-size: 16.5px; }\n  .app-header .sub { color: #9A9587; font-size: 12px; margin: 2px 0 0; }\n  .app-header #cloudStatus { color: #9A9587; font-size: 11px; margin: 6px 0 0; }\n  .refresh-btn {\n    width: 38px; height: 38px; flex-shrink: 0; border-radius: 50%;\n    background: #F3F1EA; color: #5B5748; border: 1px solid #E7E3D8;\n    font-size: 16px; cursor: pointer; font-family: inherit;\n    display: flex; align-items: center; justify-content: center; padding: 0;\n  }\n  .refresh-btn:hover { background: #EAE7DD; }\n  .refresh-btn:disabled { opacity: .5; cursor: default; }\n  .main-tab-bar { display: flex; gap: 22px; background: #fff; padding: 12px 20px 0; border-bottom: 1px solid #F0EDE3; }\n  .main-tab-btn {\n    display: flex; align-items: center; gap: 6px;\n    background: none; border: none; padding: 0 0 10px; font-size: 13px; font-weight: 600;\n    color: #9A9587; cursor: pointer; border-bottom: 2px solid transparent; font-family: inherit;\n  }\n  .main-tab-btn .icon { font-size: 15px; }\n  .main-tab-btn:hover { color: #0D7377; }\n  .main-tab-btn.active { color: #0D7377; font-weight: 700; border-bottom-color: #0D7377; }\n  .main-tab-btn .badge {\n    background: #F0873A; color: #fff; border-radius: 999px; min-width: 17px; text-align: center;\n    padding: 1px 6px; font-size: 10.5px; font-weight: 700; line-height: 1.5;\n  }\n  .main-tab-panel { display: none; }\n  .main-tab-panel.active { display: block; }\n  .btn-cta {\n    display: block; width: 100%; text-align: center;\n    background: linear-gradient(135deg, #0D7377, #14B8A6); color: #fff; border: none;\n    border-radius: 12px; padding: 13px 16px; font-size: 14.5px; font-weight: 700;\n    cursor: pointer; font-family: inherit; box-shadow: 0 3px 10px rgba(13,115,119,.25);\n  }\n  .btn-cta:hover { filter: brightness(1.06); }\n\n  /* ---------- Orders (Inbox) ---------- */\n  .compose-box {\n    border: 1px solid #E7E3D8; border-radius: 14px; padding: 16px; margin-bottom: 18px;\n    background: #fff; box-shadow: 0 1px 3px rgba(20,20,18,.06);\n  }\n  .compose-box .row2 { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }\n  .compose-box .row2 input[type=text], .compose-box .row2 select { flex: 1; min-width: 160px; }\n  .section-heading { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; font-weight: 700; font-size: 14px; color: #22201C; }\n  .section-heading .badge { background: #F0873A; color: #fff; border-radius: 999px; padding: 1px 9px; font-size: 12px; font-weight: 700; }\n  .order-card {\n    border: 1px solid #F0C98A; border-radius: 14px; margin-bottom: 12px; overflow: hidden;\n    background: #fff; box-shadow: 0 1px 3px rgba(20,20,18,.06);\n  }\n  .order-card.resolved { border-color: #C9DFC2; }\n  .order-head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; cursor: pointer; }\n  .order-head .status-dot { flex-shrink: 0; font-size: 18px; margin-top: 1px; }\n  .order-head .order-main { flex: 1; min-width: 0; }\n  .order-head .order-name { font-weight: 700; font-size: 13.5px; }\n  .order-head .dept-pill {\n    display: inline-block; background: #F3F1EA; color: #767267; border-radius: 999px;\n    padding: 1px 9px; font-size: 11px; margin-left: 6px;\n  }\n  .order-head .order-meta { color: #9A9587; font-size: 11.5px; margin-top: 2px; }\n  .order-head .order-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }\n  .icon-btn {\n    background: none; border: none; cursor: pointer; padding: 4px; font-size: 14px;\n    color: #9A9587; border-radius: 6px; line-height: 1;\n  }\n  .icon-btn:hover { background: #F3F1EA; color: #22201C; }\n  .status-pill { border-radius: 999px; padding: 3px 10px; font-size: 11px; font-weight: 700; white-space: nowrap; }\n  .status-pill.unmatched { background: #FDECD8; color: #C2691A; }\n  .status-pill.ready { background: #DCF3E8; color: #1F8A54; }\n  .order-content { padding: 0 14px 14px; }\n  .order-item-row {\n    border-top: 1px solid #F0EDE3; padding: 10px 0; display: flex; flex-wrap: wrap;\n    align-items: center; gap: 6px 10px;\n  }\n  .order-item-row .item-name { font-weight: 600; font-size: 13px; flex: 1 1 100%; }\n  .order-item-row .item-sub { color: #9A9587; font-size: 12px; flex: 1 1 100%; }\n  .order-item-row .item-suggest { color: #1F8A54; font-size: 12px; flex: 1 1 100%; }\n  .order-item-row select.supplier-select { flex: 1 1 100%; }\n  .order-actions-row { display: flex; gap: 8px; margin-top: 10px; }\n  .empty-state { text-align: center; padding: 40px 20px; color: #9A9587; }\n  .empty-state .emoji { font-size: 34px; margin-bottom: 8px; }\n\n  /* ---------- Menu (วัตถุดิบ/แมทคำ) ---------- */\n  .menu-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }\n  .info-banner {\n    background: #EAF7F5; border: 1px solid #BFE6E0; color: #0D5C5F; border-radius: 10px;\n    padding: 10px 14px; font-size: 12.5px; margin-bottom: 14px;\n  }\n  .category-group { margin-bottom: 18px; }\n  .category-group-head {\n    font-weight: 700; font-size: 13px; color: #22201C; margin-bottom: 8px;\n    display: flex; align-items: center; gap: 6px;\n  }\n  .category-group-head .crumb { color: #9A9587; font-weight: 400; font-size: 12px; }\n  .menu-item-card {\n    border: 1px solid #E7E3D8; border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; background: #fff;\n  }\n  .menu-item-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }\n  .menu-item-name { font-weight: 700; font-size: 13.5px; }\n  .menu-item-price { color: #9A9587; font-size: 12px; margin-top: 2px; }\n  .menu-item-actions { display: flex; gap: 4px; flex-shrink: 0; }\n  .alias-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }\n  .alias-pill {\n    display: inline-flex; align-items: center; gap: 4px; background: #F3F1EA; color: #5B5748;\n    border-radius: 999px; padding: 2px 9px; font-size: 11.5px;\n  }\n  .alias-pill .x { cursor: pointer; color: #B3413A; font-weight: 700; }\n  .inline-form { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #E7E3D8; display: flex; gap: 8px; flex-wrap: wrap; }\n  .inline-form input[type=text], .inline-form select { flex: 1; min-width: 120px; }\n\n  /* ---------- Safe Daily Reset modal ---------- */\n  .modal-overlay {\n    position: fixed; inset: 0; background: rgba(20,20,18,.5);\n    display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px;\n  }\n  .modal-box {\n    background: #fff; border-radius: 12px; padding: 20px 22px; max-width: 440px; width: 100%;\n    max-height: 82vh; overflow-y: auto; box-shadow: 0 8px 30px rgba(0,0,0,.25);\n  }\n  .modal-box h3 { margin: 0 0 10px; color: #2F5233; font-size: 16px; }\n  .btn-danger-solid { background: #B3413A; color: #fff; border: none; }\n  .btn-danger-solid:hover { background: #96332C; }\n\n  /* ---------- Mobile-only enhancements (desktop is untouched outside this query) ---------- */\n  .chevron { display: none; }\n  .quick-nav { display: none; }\n  .backtop-btn { display: none; }\n  @media (max-width: 700px) {\n    body { padding: 12px; font-size: 13.5px; }\n    h1 { font-size: 18px; }\n    .sub { font-size: 12.5px; }\n    .card { padding: 14px; }\n    textarea { min-height: 160px; }\n    table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }\n\n    .tab-bar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }\n    .tab-btn { flex: 0 0 auto; white-space: nowrap; }\n\n    .sticky-top { margin: -12px -12px 16px; }\n    .app-header { padding: 12px 16px 8px; }\n    .app-header-inner { gap: 8px; }\n    .app-icon { width: 34px; height: 34px; border-radius: 10px; font-size: 16px; }\n    .app-header h1 { font-size: 15px; }\n    .refresh-btn { width: 34px; height: 34px; font-size: 14px; }\n    .main-tab-bar { gap: 14px; padding: 10px 14px 0; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }\n    .main-tab-btn { font-size: 12px; white-space: nowrap; flex: 0 0 auto; }\n    .main-tab-btn .icon { font-size: 14px; }\n    .modal-box { padding: 16px 16px; }\n    .compose-box .row2 input[type=text], .compose-box .row2 select { flex: 1 1 100%; }\n    .order-head { padding: 10px 12px; }\n    .menu-toolbar { flex-direction: column; align-items: stretch; }\n\n    /* Supplier boxes collapse to just their header by default, so a long order list\n       doesn't force endless scrolling to find one supplier — tap the header to expand. */\n    .supplier-head { cursor: pointer; padding: 10px 14px; }\n    .supplier-box.collapsed .supplier-content { display: none; }\n    .chevron { display: inline-block; margin-left: 6px; transition: transform .15s; }\n    .supplier-box.collapsed .chevron { transform: rotate(-90deg); }\n\n    /* Quick-jump chip row per store — tap a supplier name to scroll straight to it\n       (and auto-expand it) instead of scrolling past every other supplier first. */\n    .quick-nav {\n      display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px;\n    }\n    .quick-nav-chip {\n      background: #EFF3EC; color: #2F5233; border: 1px solid #D7E2D2; border-radius: 999px;\n      padding: 5px 12px; font-size: 12.5px; cursor: pointer; white-space: nowrap;\n    }\n    .quick-nav-chip:active { background: #DCE7D7; }\n\n    /* Floating back-to-top so it's quick to get back to the input after checking a\n       supplier buried far down a long results list. */\n    .backtop-btn {\n      display: flex; align-items: center; justify-content: center;\n      position: fixed; right: 16px; bottom: 16px; width: 46px; height: 46px;\n      border-radius: 50%; background: #2F5233; color: #fff; font-size: 20px;\n      border: none; box-shadow: 0 2px 8px rgba(0,0,0,.25); cursor: pointer; z-index: 50;\n    }\n  }\n</style>\n</head>\n<body>\n\n<div class=\"sticky-top\" id=\"stickyTop\">\n  <div class=\"app-header\">\n    <div class=\"app-header-inner\">\n      <div class=\"app-header-left\">\n        <div class=\"app-icon\">📦</div>\n        <div>\n          <h1>หน้าแยกออเดอร์สั่งของ</h1>\n          <p class=\"sub\">คัดแยกออเดอร์และส่งซัพพลายเออร์ทาง LINE</p>\n        </div>\n      </div>\n      <button class=\"refresh-btn\" id=\"refreshBtn\" title=\"ดึงข้อมูลล่าสุดจากคลาวด์อีกครั้ง\">🔄</button>\n    </div>\n    <p class=\"muted\" id=\"cloudStatus\">🔄 กำลังโหลดข้อมูลจากคลาวด์...</p>\n  </div>\n  <nav class=\"main-tab-bar\">\n    <button class=\"main-tab-btn active\" data-maintab=\"inbox\"><span class=\"icon\">📥</span><span class=\"label\">กล่องออเดอร์</span><span class=\"badge\" id=\"inboxBadge\" style=\"display:none;\">0</span></button>\n    <button class=\"main-tab-btn\" data-maintab=\"dispatch\"><span class=\"icon\">🚚</span><span class=\"label\">ส่งซัพพลายเออร์</span><span class=\"badge\" id=\"dispatchBadge\" style=\"display:none;\">0</span></button>\n    <button class=\"main-tab-btn\" data-maintab=\"menu\"><span class=\"icon\">📋</span><span class=\"label\">วัตถุดิบ/แมทคำ</span></button>\n  </nav>\n</div>\n\n<section class=\"main-tab-panel active\" data-mainpanel=\"inbox\">\n<button class=\"btn-cta\" id=\"composeToggleBtn\">🗐 วางข้อความสั่งซื้อใหม่</button>\n\n<div class=\"compose-box\" id=\"composeBox\" style=\"display:none; margin-top:14px;\">\n  <div class=\"row2\">\n    <input type=\"text\" id=\"ordererInput\" placeholder=\"ชื่อผู้สั่ง (ไม่บังคับ)\">\n    <select id=\"departmentSelect\">\n      <option value=\"\">แผนก/ที่มา (ไม่บังคับ)</option>\n      <option value=\"ร้านโกปี๊ หลังโรงไม้\">ร้านโกปี๊ หลังโรงไม้</option>\n      <option value=\"The Old Offset\">The Old Offset</option>\n      <option value=\"__new__\">+ อื่นๆ (พิมพ์เอง)</option>\n    </select>\n    <input type=\"text\" id=\"departmentCustom\" placeholder=\"พิมพ์ชื่อแผนก/ที่มา\" style=\"display:none;\">\n  </div>\n  <p class=\"muted\" style=\"margin:0 0 8px;\">เคล็ดลับ: ถ้าปนสองร้านในข้อความเดียว ให้ขึ้นบรรทัดชื่อร้านไว้ก่อนรายการของร้านนั้น เช่น พิมพ์ \"ร้านโกปี๊\" แล้วตามด้วยรายการ จากนั้นพิมพ์ \"The Old Offset\" แล้วตามด้วยรายการของอีกร้าน — ระบบจะแยกเป็นออเดอร์คนละใบให้เอง</p>\n  <textarea id=\"rawInput\" placeholder=\"วางข้อความสั่งซื้อจาก LINE ที่นี่...&#10;เช่น:&#10;เนื้อหมูสับ 2 กก.&#10;ผักกาดขาว 3&#10;น้ำปลา 5 ขวด\"></textarea>\n  <div class=\"row\" style=\"margin-top:12px;\">\n    <button class=\"secondary\" id=\"composeCancelBtn\">ยกเลิก</button>\n    <button class=\"btn-cta\" id=\"processBtn\" style=\"flex:1;\">บันทึกออเดอร์ (0 รายการ)</button>\n  </div>\n</div>\n\n<div class=\"section-heading\" style=\"margin-top:18px;\">รอตรวจสอบ <span class=\"badge\" id=\"pendingCountBadge\" style=\"display:none;\">0</span></div>\n<div id=\"ordersList\"></div>\n</section>\n\n<section class=\"main-tab-panel\" data-mainpanel=\"dispatch\">\n<div class=\"row\" style=\"justify-content:space-between; margin-bottom:12px;\">\n  <button class=\"small secondary\" id=\"dailyResetBtn\">🗑️ ล้างหมด</button>\n  <button class=\"small secondary\" id=\"viewYesterdayBtn\" style=\"display:none;\">🕐 ดูข้อมูลเมื่อวาน</button>\n</div>\n<div id=\"results\"><p class=\"muted\">ยังไม่มีรายการที่แยกซัพพลายเออร์ไว้ — ไปที่ \"กล่องออเดอร์\" เพื่อแยกวัตถุดิบให้ซัพพลายเออร์ก่อน</p></div>\n</section>\n\n<section class=\"main-tab-panel\" data-mainpanel=\"menu\">\n<div class=\"card\">\n  <div class=\"menu-toolbar\">\n    <h2 style=\"margin:0;\">วัตถุดิบ &amp; แมทคำ <span class=\"pill\" id=\"dictCount\">0</span></h2>\n    <button class=\"small\" id=\"addItemToggleBtn\">+ เพิ่มวัตถุดิบ</button>\n  </div>\n  <div class=\"info-banner\">\n    💡 <b>แมทคำ</b> คือคำเหมือนที่พิมพ์ผิด/เรียกอย่างอื่น แต่อยากให้ระบบรู้จัก เช่น \"หมูดิ่มชำ\" → \"เนื้อหมูสับ (กก.)\" แตะที่ไอคอน 🔗 ของแต่ละวัตถุดิบเพื่อเพิ่มคำเหมือน\n  </div>\n\n  <div id=\"addItemForm\" class=\"inline-form\" style=\"display:none; border-top:none; padding-top:0; margin-top:0; margin-bottom:16px;\">\n    <input type=\"text\" id=\"newItemName\" placeholder=\"ชื่อวัตถุดิบ\">\n    <select id=\"newItemCategory\"></select>\n    <select id=\"newItemSupplier\"></select>\n    <input type=\"text\" id=\"newSupplierCustom\" placeholder=\"หรือพิมพ์ซัพพลายเออร์ใหม่\" style=\"display:none;\">\n    <input type=\"text\" id=\"newItemPrice\" placeholder=\"ราคา/หน่วย (ไม่บังคับ)\" style=\"max-width:140px;\">\n    <button class=\"small\" id=\"addDictBtn\">เพิ่ม / อัปเดต</button>\n  </div>\n  <div id=\"dictSimilarWarning\" style=\"display:none; margin-bottom:14px; padding:10px; background:#FFF8E6; border:1px solid #E0C468; border-radius:8px; font-size:12.5px;\"></div>\n\n  <p class=\"muted\" style=\"margin:0 0 6px; font-weight:600;\">🔍 ทดสอบการแมทคำ</p>\n  <input type=\"text\" id=\"nameCheckInput\" placeholder=\"พิมพ์คำที่ส่งมา เช่น กระดูกหมูซี่โครง หรือ หมูดิ่มชำ\" style=\"width:100%; margin-bottom:6px;\">\n  <div id=\"nameCheckResult\" style=\"margin-bottom:14px; font-size:13px;\"></div>\n\n  <input type=\"text\" id=\"dictSearch\" placeholder=\"🔍 ค้นหาวัตถุดิบ/คำเทียบเคียง... (พิมพ์บางส่วนก็เจอ)\" style=\"width:100%; margin-bottom:16px;\">\n\n  <div id=\"menuGroups\"></div>\n</div>\n</section>\n\n<div class=\"toast\" id=\"toast\"></div>\n<button class=\"backtop-btn\" id=\"backTopBtn\" title=\"กลับขึ้นบนสุด\" aria-label=\"กลับขึ้นบนสุด\">↑</button>\n\n<div class=\"modal-overlay\" id=\"resetModalOverlay\" style=\"display:none;\">\n  <div class=\"modal-box\">\n    <h3>ยืนยันการล้างข้อมูลรายวัน</h3>\n    <div id=\"resetModalSummary\"></div>\n    <p class=\"muted\" style=\"margin-top:10px;\">ฐานข้อมูลวัตถุดิบและคำเทียบเคียง (แท็บ \"จัดการเมนู\") จะไม่ถูกลบ — ล้างเฉพาะรายการออเดอร์ของวันนี้เท่านั้น ระบบจะบันทึกสำรองไว้ให้กด \"ดูข้อมูลเมื่อวาน\" ย้อนดูได้ 1 ครั้ง</p>\n    <div class=\"row\" style=\"justify-content:flex-end; margin-top:16px;\">\n      <button class=\"secondary\" id=\"resetModalCancel\">ยกเลิก</button>\n      <button class=\"btn-danger-solid\" id=\"resetModalConfirm\">ยืนยัน ล้างข้อมูล</button>\n    </div>\n  </div>\n</div>\n\n<script>\nconst STORAGE_KEY = \"kopi_master_dict_v1\";\nconst ALIAS_STORAGE_KEY = \"kopi_alias_table_v1\";\nconst PRICE_STORAGE_KEY = \"kopi_last_price_v1\";\n// Discrete \"orders\" — each compose-form submission becomes one (or more, if the pasted text\n// mixes two store headers) order card, persisted immediately so a refresh never loses them.\nconst ORDERS_STORAGE_KEY = \"kopi_orders_v1\";\n// Longer-lived checkpoint written only by the \"Safe Daily Reset\" flow — lets the owner peek at\n// exactly what was cleared out the last time they closed out the day.\nconst DAILY_SNAPSHOT_KEY = \"kopi_daily_snapshot_v1\";\nconst STORE_NAMES = [\"ร้านโกปี๊ หลังโรงไม้\", \"The Old Offset\"];\nconst CATEGORY_LIST = [\"เนื้อสัตว์\", \"ผัก-ผลไม้\", \"เครื่องปรุง/ของแห้ง\", \"บรรจุภัณฑ์\", \"อื่นๆ\"];\n\n// ---------- Seed dictionary (from real order data, 24/07/2026) ----------\nconst SEED_DICT = [\n  [\"น้ำจิ้มบ๊วย\",\"พพ\"],[\"กระปุกน้ำจิ้ม\",\"พพ\"],[\"เก๋ากี้\",\"พพ\"],[\"น้ำตาลปี๊บ\",\"พพ\"],\n  [\"จ๊อปู\",\"พพ\"],[\"ไส้กรอกสโมกี้\",\"พพ\"],[\"กุนเชียงหงส์หยก\",\"พพ\"],[\"เต้าหู้เหลือง\",\"พพ\"],\n  [\"ซอสฝาเขียว\",\"พพ\"],[\"พริกไทยป่น\",\"พพ\"],[\"ถุงหิ้ว\",\"พพ\"],[\"ไข่เยี่ยวม้า\",\"พพ\"],\n  [\"ไข่นกกระทา\",\"พพ\"],[\"ไข่ไก่\",\"พพ\"],[\"ปูอัดเล็ก\",\"พพ\"],[\"สาหร่ายแห้ง\",\"พพ\"],\n  [\"เส้นใหญ่\",\"พพ\"],[\"วุ้นเส้น\",\"พพ\"],[\"แปะก๊วย\",\"พพ\"],[\"หมูยอ\",\"พพ\"],\n  [\"น้ำมันพืช\",\"พพ\"],\n  [\"พริกไทยกระปุก\",\"MK\"],[\"กระดาษทิชชู่\",\"MK\"],[\"น้ำยาล้างจาน\",\"MK\"],[\"ชุดบักกุดเต๋\",\"MK\"],\n  [\"ขนมปังฟาร์มเฮ้า\",\"MK\"],[\"หมั่นโถมินิ\",\"MK\"],[\"กะทิอร่อยดี\",\"MK\"],[\"แป้งดาว\",\"MK\"],\n  [\"น้ำมันหอยนก\",\"MK\"],[\"ซีอิ๊วขาว\",\"MK\"],[\"ถุงขยะ\",\"MK\"],[\"หอยแมงภู่ฝา\",\"MK\"],\n  [\"ข้าวสารพนมรุ้ง\",\"MK\"],[\"ผงพะโล้\",\"MK\"],[\"กระเทียมปอก\",\"MK\"],[\"ซอสพริก\",\"MK\"],\n  [\"ซอสมะเขือเทศ\",\"MK\"],[\"แป้งมันฮ่องกง\",\"MK\"],[\"ซีอิ๊วหวานง่วนเชียง\",\"MK\"],[\"นมข้นมะลิโกล\",\"MK\"],\n  [\"ผักกาดขาว\",\"ผัก\"],[\"ผักกาดหอม\",\"ผัก\"],[\"เห็ดเข็ม\",\"ผัก\"],[\"ขิงซอย\",\"ผัก\"],\n  [\"บล็อกโคลี่\",\"ผัก\"],[\"แครอท\",\"ผัก\"],[\"มะระ\",\"ผัก\"],[\"กะหล่ำปลี\",\"ผัก\"],\n  [\"ข้าวโพดอ่อน\",\"ผัก\"],[\"เห็ดหอมสด\",\"ผัก\"],[\"พริกชี้ฟ้าแดง\",\"ผัก\"],[\"ต้นหอม\",\"ผัก\"],\n  [\"ตั้งโอ๋\",\"ผัก\"],[\"หอมใหญ่\",\"ผัก\"],[\"ขิงแก่\",\"ผัก\"],[\"เผือก\",\"ผัก\"],\n  [\"กวางตุ้งเบบี้\",\"ผัก\"],[\"พริกจินดาแดง\",\"ผัก\"],\n  [\"หมูบด\",\"หมูจิต\"],[\"มันหมูบด\",\"หมูจิต\"],\n  [\"ซี่โครงหมูสับ\",\"ซุปหมู\"],[\"หมูสันคอ\",\"ซุปหมู\"],[\"หมูสามชั้นแผ่น\",\"ซุปหมู\"],[\"กุนเชียงซุปเปอร์\",\"ซุปหมู\"],\n  [\"แฮมหมู\",\"Fusion\"],[\"เต้าหู้ชีส\",\"Fusion\"],[\"ฟองเต้าหู้ซีฟู้ด\",\"Fusion\"],[\"ก้ามปู\",\"Fusion\"],\n  [\"ปูอัดยักษ์\",\"Fusion\"],[\"หมูสามชั้นสไลซ์\",\"Fusion\"],[\"ตีนไก่ตัด\",\"Fusion\"],\n  [\"แป้งฮกแดง\",\"บุญ\"],[\"อัลมอนด์สไลซ์\",\"บุญ\"],[\"นมจืด Goodview\",\"บุญ\"],[\"หลอดสั้น\",\"บุญ\"],[\"หลอดยาว\",\"บุญ\"],\n];\n\n// ---------- Alias Mapping (แมทคำ) ----------\n// \"typed\" = a keyword/phrase staff might type freely; \"canonical\" = the standard item name\n// it should resolve to. Matching is CONTAINS-based: if a typed line includes this phrase\n// anywhere in it (e.g. \"ขอน้ำมันพืชหน่อย\" contains \"น้ำมันพืช\"), it maps to the canonical name.\nconst SEED_ALIASES = [\n  [\"น้ำตาลปีบ\", \"น้ำตาลปี๊บ\"],\n  [\"ไส้กรอกสโมกี้ไบ\", \"ไส้กรอกสโมกี้\"],\n  [\"กุญเชียงหงษ์หยก\", \"กุนเชียงหงส์หยก\"],\n  [\"ถุงหิ้ว8x16\", \"ถุงหิ้ว\"], [\"ถุงหิ้ว8*16\", \"ถุงหิ้ว\"],\n  [\"ใข่นก\", \"ไข่นกกระทา\"], [\"ไข่นก\", \"ไข่นกกระทา\"],\n  [\"ขนมปังฟาร์มเฮาส์\", \"ขนมปังฟาร์มเฮ้า\"],\n  [\"หมั่นโถวมินิ\", \"หมั่นโถมินิ\"],\n  [\"น้ำมันหอยตรานก\", \"น้ำมันหอยนก\"],\n  [\"ถุงขยะ30x40\", \"ถุงขยะ\"], [\"ถุงขยะ30*40\", \"ถุงขยะ\"],\n  [\"หอยแมลงภู่ฝา\", \"หอยแมงภู่ฝา\"],\n  [\"ซีอิ้วหวานง่วนเชียง\", \"ซีอิ๊วหวานง่วนเชียง\"],\n  [\"นมข้นมะลิโกลด์\", \"นมข้นมะลิโกล\"],\n  [\"บรอกโคลี\", \"บล็อกโคลี่\"],\n  [\"หอมหัวใหญ่\", \"หอมใหญ่\"],\n  [\"ขิงหัวแก่\", \"ขิงแก่\"],\n  [\"พริกแดงจินดา\", \"พริกจินดาแดง\"],\n  [\"ซี่โครงสับ\", \"ซี่โครงหมูสับ\"],\n  [\"หมูทำหมูแดงสันคอ\", \"หมูสันคอ\"],\n  [\"หมูทำหมูกรอบสามชั้นแผ่น\", \"หมูสามชั้นแผ่น\"],\n  [\"เต้าหู้ชีสpfp\", \"เต้าหู้ชีส\"],\n  [\"ปูอัดยัก\", \"ปูอัดยักษ์\"],\n  [\"สามชั้นสไลด์\", \"หมูสามชั้นสไลซ์\"],\n  [\"อัลมอนด์สไลด์\", \"อัลมอนด์สไลซ์\"],\n  [\"นมจืดgoodview\", \"นมจืด Goodview\"],\n  // examples of free-text phrasing around a keyword (contains-matching covers all of these\n  // via the single \"น้ำมันพืช\" rule above/below, these extra rows are just illustrative):\n  [\"ขอน้ำมันพืช\", \"น้ำมันพืช\"],\n  [\"น้ำมันพืชขอตอนเช้า\", \"น้ำมันพืช\"],\n];\n\nconst UNIT_WORDS = [\"กิโลกรัม\",\"กก\\\\.?\",\"โล\",\"ถุง\",\"ห่อ\",\"แถว\",\"แผง\",\"ใบ\",\"ฟอง\",\"คู่\",\"กล่อง\",\"หิ้ว\",\"ลัง\",\"แพ็ค\",\"แพค\",\"ขวด\",\"แกลลอน\",\"หัว\",\"ชิ้น\",\"ขีด\",\"มัด\",\"ฝา\"];\nconst UNIT_REGEX = new RegExp(\"^(.*?)\\\\s*([\\\\d]+(?:\\\\.\\\\d+)?)\\\\s*(\" + UNIT_WORDS.join(\"|\") + \")?\\\\s*$\");\n\nfunction normalize(s){\n  return (s||\"\").toString().toLowerCase().replace(/[\\s().*=\\-–—:：]/g,\"\");\n}\n\n// The part of a string before its first whitespace — used to catch cases like\n// \"หมูบด เกรดพิเศษ\" (an extra qualifier word typed between the item name and the\n// quantity): the first word alone still identifies the item correctly.\nfunction firstToken(s){\n  return (s||\"\").toString().trim().split(/\\s+/)[0] || \"\";\n}\n\nfunction escapeAttr(s){\n  return (s||\"\").toString().replace(/&/g,\"&amp;\").replace(/\"/g,\"&quot;\").replace(/</g,\"&lt;\");\n}\n\n// Best-effort starting category for an item that doesn't have one saved yet — purely a\n// convenience default; the owner can always correct it via the edit (✏️) icon in the Menu tab.\nfunction guessCategory(name){\n  const n = normalize(name);\n  const meatWords = [\"หมู\",\"ไก่\",\"เนื้อ\",\"กุ้ง\",\"ปู\",\"ปลา\",\"ไข่\",\"หอย\",\"กุนเชียง\",\"ไส้กรอก\",\"แฮม\",\"ตีนไก่\",\"เต้าหู้\"];\n  const vegWords = [\"ผักกาด\",\"ผัก\",\"กะหล่ำ\",\"แครอท\",\"บล็อกโคลี\",\"มะระ\",\"ข้าวโพด\",\"เห็ด\",\"ต้นหอม\",\"ตั้งโอ๋\",\"หอมใหญ่\",\"ขิง\",\"เผือก\",\"กวางตุ้ง\",\"พริกชี้ฟ้า\",\"พริกจินดา\"];\n  const packagingWords = [\"ถุง\",\"กล่อง\",\"หลอด\",\"ทิชชู่\",\"กระปุก\"];\n  if (meatWords.some(w => n.includes(normalize(w)))) return \"เนื้อสัตว์\";\n  if (vegWords.some(w => n.includes(normalize(w)))) return \"ผัก-ผลไม้\";\n  if (packagingWords.some(w => n.includes(normalize(w)))) return \"บรรจุภัณฑ์\";\n  return \"เครื่องปรุง/ของแห้ง\";\n}\n\n// Keep exactly one supplier per item name — if duplicates exist (e.g. saved before this\n// version, or legacy data), the LAST occurrence wins since it represents the most recent edit.\nfunction dedupeDict(dict){\n  const map = new Map();\n  dict.forEach(d => {\n    map.set(normalize(d.name), {\n      name: d.name, supplier: d.supplier, price: d.price || \"\",\n      category: d.category || \"\"\n    });\n  });\n  return Array.from(map.values());\n}\n\n// Cloud version: DICT/ALIAS_TABLE now live on the server (Cloudflare KV) behind /api/state,\n// instead of localStorage — so the same data shows up whether you're on the shop PC or your\n// phone. loadDict()/loadAliasTable() now take the value already fetched from the server\n// (or undefined on first-ever run) instead of reading localStorage themselves.\nasync function postState(partial){\n  try {\n    await fetch(\"/api/state\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify(partial)\n    });\n    setCloudStatus(\"☁️ ข้อมูล sync แล้ว\");\n  } catch(e){\n    setCloudStatus(\"⚠️ บันทึกขึ้นคลาวด์ไม่สำเร็จ — เช็คอินเทอร์เน็ตแล้วลองใหม่\");\n  }\n}\n// Returns null on failure (distinct from {} = \"server reachable but empty\") so callers can\n// tell \"offline, don't bother trying to save the fallback back up\" apart from \"brand new KV\".\nasync function fetchState(){\n  try {\n    const r = await fetch(\"/api/state\");\n    if (!r.ok) throw new Error(\"bad status\");\n    return await r.json();\n  } catch(e){\n    setCloudStatus(\"⚠️ โหลดข้อมูลจากคลาวด์ไม่สำเร็จ — เช็คอินเทอร์เน็ตแล้วรีเฟรชหน้านี้\");\n    return null;\n  }\n}\nfunction setCloudStatus(msg){\n  const el = document.getElementById(\"cloudStatus\");\n  if (el) el.textContent = msg;\n}\n\nfunction loadDict(fetched){\n  let saved = fetched;\n  if (!saved || !Array.isArray(saved) || saved.length === 0){\n    saved = SEED_DICT.map(([name,supplier]) => ({name, supplier}));\n  }\n  const deduped = dedupeDict(saved);\n  // Migration: backfill a category for any entry saved before categories existed (seed data,\n  // or real KV data from earlier versions of this tool) using the keyword-based best guess.\n  let backfilled = false;\n  deduped.forEach(d => {\n    if (!d.category){ d.category = guessCategory(d.name); backfilled = true; }\n  });\n  if (backfilled) DICT_NEEDS_CATEGORY_PUSH = true;\n  return deduped;\n}\nfunction saveDict(dict){ DICT = dict; postState({ dict }); }\nlet DICT_NEEDS_CATEGORY_PUSH = false;\n\n// Add a new item, or update the supplier/category/price of an existing one (matched by\n// normalized name). Returns \"added\" or \"updated\" so callers can show the right message.\nfunction upsertDict(name, supplier, price, category){\n  const norm = normalize(name);\n  const existing = DICT.find(d => normalize(d.name) === norm);\n  if (existing){\n    existing.supplier = supplier;\n    if (price !== undefined) existing.price = price;\n    if (category) existing.category = category;\n    saveDict(DICT);\n    return \"updated\";\n  }\n  DICT.push({ name, supplier, price: price !== undefined ? price : \"\", category: category || guessCategory(name) });\n  saveDict(DICT);\n  return \"added\";\n}\n\n// Cloud version: start empty and populate once /api/state responds (see initCloudData at\n// the bottom of this script) — desktop-artifact version used loadDict() synchronously here.\nlet DICT = [];\n\n// Keep one canonical mapping per typed phrase — last write wins on duplicates.\nfunction dedupeAliases(list){\n  const map = new Map();\n  list.forEach(a => { map.set(normalize(a.typed), { typed: a.typed, canonical: a.canonical }); });\n  return Array.from(map.values());\n}\n\nfunction loadAliasTable(fetched){\n  let saved = fetched;\n  if (!saved || !Array.isArray(saved) || saved.length === 0){\n    saved = SEED_ALIASES.map(([typed, canonical]) => ({ typed, canonical }));\n  }\n  return dedupeAliases(saved);\n}\nfunction saveAliasTable(list){ ALIAS_TABLE = list; postState({ alias: list }); }\n\nfunction upsertAlias(typed, canonical){\n  const norm = normalize(typed);\n  const existing = ALIAS_TABLE.find(a => normalize(a.typed) === norm);\n  if (existing){ existing.canonical = canonical; saveAliasTable(ALIAS_TABLE); return \"updated\"; }\n  ALIAS_TABLE.push({ typed, canonical });\n  saveAliasTable(ALIAS_TABLE);\n  return \"added\";\n}\n\nlet ALIAS_TABLE = [];\n\n// Optional last-entered price per canonical item name — purely a convenience prefill for\n// today's cost estimate; the price is never included in the copy-to-Line message text.\nfunction loadPrices(){\n  try { return JSON.parse(localStorage.getItem(PRICE_STORAGE_KEY) || \"{}\") || {}; }\n  catch(e){ return {}; }\n}\nfunction savePrice(name, price){\n  const prices = loadPrices();\n  if (price === \"\" || price == null) delete prices[normalize(name)];\n  else prices[normalize(name)] = price;\n  localStorage.setItem(PRICE_STORAGE_KEY, JSON.stringify(prices));\n}\nfunction getLastPrice(name){\n  const prices = loadPrices();\n  return prices[normalize(name)] || \"\";\n}\n\nfunction allSuppliers(){\n  const set = new Set(DICT.map(d => d.supplier));\n  return Array.from(set).sort();\n}\nfunction allCategories(){\n  const set = new Set(CATEGORY_LIST);\n  DICT.forEach(d => { if (d.category) set.add(d.category); });\n  return Array.from(set);\n}\n\n// Finds an existing (different) canonical name whose first 10-15 characters match the\n// candidate name's — a likely near-duplicate (typo, brand variant, extra word) rather than\n// a truly new item. Returns the matching DICT entry, or null.\nfunction findSimilarDictEntry(name){\n  const norm = normalize(name);\n  let best = null, bestLen = 0;\n  DICT.forEach(d => {\n    const dNorm = normalize(d.name);\n    if (dNorm === norm) return; // exact matches are handled elsewhere, not \"similar\"\n    const maxCheck = Math.min(15, norm.length, dNorm.length);\n    if (maxCheck < 10) return; // too short a prefix to mean anything\n    let common = 0;\n    for (let i = 0; i < maxCheck; i++){\n      if (norm[i] === dNorm[i]) common++; else break;\n    }\n    if (common >= 10 && common > bestLen){ best = d; bestLen = common; }\n  });\n  return best;\n}\n\n// Longest-matching alias whose \"typed\" phrase is contained anywhere within the input text.\nfunction resolveCanonicalViaAlias(name){\n  const norm = normalize(name);\n  let best = null, bestLen = 0;\n  ALIAS_TABLE.forEach(a => {\n    const tNorm = normalize(a.typed);\n    if (tNorm && tNorm.length >= 2 && norm.includes(tNorm) && tNorm.length > bestLen){\n      best = a.canonical;\n      bestLen = tNorm.length;\n    }\n  });\n  return best;\n}\n\nfunction findSupplierMatches(rawName){\n  const norm = normalize(rawName);\n\n  // Pass 1: exact match against a canonical item name — highest confidence, always wins.\n  let exact = DICT.find(entry => normalize(entry.name) === norm);\n  if (exact) return [{ supplier: exact.supplier, canonicalName: exact.name, viaAlias: false }];\n\n  // Pass 1b: \"name [space] qty [space] unit\" — if there's an extra qualifier word typed\n  // between the item name and the quantity (e.g. \"หมูบด เกรดพิเศษ\"), the text before the\n  // FIRST space still exactly names a known item — treat it as that item right away,\n  // same confidence as an exact match (no confirmation needed).\n  if (/\\s/.test((rawName||\"\").trim())){\n    const firstNorm = normalize(firstToken(rawName));\n    if (firstNorm && firstNorm !== norm){\n      const firstWordMatch = DICT.find(entry => normalize(entry.name) === firstNorm);\n      if (firstWordMatch) return [{ supplier: firstWordMatch.supplier, canonicalName: firstWordMatch.name, viaAlias: false, viaFirstWord: true }];\n    }\n  }\n\n  // Pass 2: alias mapping — typed phrase contains a known keyword/phrase (แมทคำ table).\n  const aliasCanonical = resolveCanonicalViaAlias(rawName);\n  if (aliasCanonical){\n    const aliasNorm = normalize(aliasCanonical);\n    const target = DICT.find(entry => normalize(entry.name) === aliasNorm);\n    if (target) return [{ supplier: target.supplier, canonicalName: target.name, viaAlias: true }];\n    // alias resolved to a canonical name that has no supplier yet — surface that clearly\n    return [{ supplier: null, canonicalName: aliasCanonical, viaAlias: true, missingSupplier: true }];\n  }\n\n  // Pass 3: fall back to longest containment match against canonical names themselves\n  let candidates = [];\n  let bestLen = 0;\n  for (const entry of DICT){\n    const entryNorm = normalize(entry.name);\n    let hit = false;\n    if (norm.length >= 3 && entryNorm.includes(norm)) hit = true;\n    else if (entryNorm.length >= 3 && norm.includes(entryNorm)) hit = true;\n    if (hit){\n      const len = entryNorm.length;\n      if (len > bestLen){ candidates = [entry]; bestLen = len; }\n      else if (len === bestLen){ candidates.push(entry); }\n    }\n  }\n  const bySupplier = {};\n  candidates.forEach(c => { bySupplier[c.supplier] = c.name; });\n  // Containment matches are a guess, not a confirmed identity — flagged so callers can\n  // ask \"merge or delete?\" instead of silently treating it as the same item.\n  return Object.keys(bySupplier).map(s => ({supplier: s, canonicalName: bySupplier[s], viaAlias: false, viaContainment: true}));\n}\n\nfunction parseLine(line){\n  let s = line.trim();\n  if (!s) return null;\n  const stockNote = /(เหลือ|หมด)/.test(s);\n  s = s.replace(/ครึ่ง/g, \"0.5 \");\n  const m = s.match(UNIT_REGEX);\n  let name, qty, unit;\n  if (m && m[2]){\n    name = m[1].trim().replace(/[=(]+$/,\"\").trim();\n    qty = m[2];\n    unit = m[3] || \"\";\n  } else {\n    // Fallback: strict \"ชื่อ [เว้นวรรค] จำนวน [เว้นวรรค] หน่วย\" split — catches lines the\n    // smarter regex above couldn't parse. Whatever comes right after the FIRST space is\n    // treated as the quantity regardless of whether it's written as digits or as a word\n    // (e.g. \"หมูบด เยอะ โล\"), and whatever follows the SECOND space is the unit.\n    const strippedForTokens = s.replace(/\\(.*?\\)/g,\"\").trim();\n    const tokens = strippedForTokens.split(/\\s+/);\n    // Don't misread a stock-status word (\"เหลือ\"/\"หมด\" with no number attached) as a\n    // quantity — that case is meant to fall through to the \"?\" branch below so it still\n    // surfaces for the owner to type a real qty.\n    const secondTokenIsStockWord = tokens[1] && /^(เหลือ|หมด)$/.test(tokens[1]);\n    // Also don't split apart a name that's already an exact, known multi-word canonical\n    // name in the dictionary (e.g. \"นมจืด Goodview\") typed with no quantity at all.\n    const wholeIsKnownMultiWordName = tokens.length >= 2 && DICT.some(d => normalize(d.name) === normalize(strippedForTokens));\n    if (tokens.length >= 2 && !secondTokenIsStockWord && !wholeIsKnownMultiWordName){\n      name = tokens[0];\n      qty = tokens[1];\n      unit = tokens[2] || \"\";\n    } else {\n      // strip trailing parenthetical stock notes like (เหลือ 1 แผง)\n      name = strippedForTokens;\n      qty = \"?\";\n      unit = \"\";\n    }\n  }\n  name = name.replace(/(เหลือ|หมด)\\s*$/,\"\").trim();\n  if (!name) name = s;\n  return { raw: line.trim(), name, qty, unit, stockNote };\n}\n\nfunction isStoreHeader(line){\n  const norm = normalize(line);\n  if (!norm || norm.length > 40) return null; // header lines are short labels, not item lines\n  if (norm.includes(normalize(\"โกปี๊\")) || norm.includes(\"kopi\")) return STORE_NAMES[0];\n  if (norm.includes(\"oldoffset\") || norm.includes(normalize(\"ดิโอลด์\"))) return STORE_NAMES[1];\n  return null;\n}\n\nfunction genId(prefix){\n  return prefix + \"_\" + Date.now().toString(36) + \"_\" + Math.random().toString(36).slice(2, 8);\n}\n\n// ============================================================================\n// Orders (Inbox) — each compose-form submission becomes one or more discrete\n// \"orders\", each tagged with an optional orderer name + department/source, and\n// each item tracked through to a confirmed supplier before it can be dispatched.\n// ============================================================================\nlet ORDERS = [];\n\nfunction loadOrders(){\n  try {\n    const saved = JSON.parse(localStorage.getItem(ORDERS_STORAGE_KEY) || \"[]\");\n    return Array.isArray(saved) ? saved : [];\n  } catch(e){ return []; }\n}\nfunction saveOrders(){\n  try { localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(ORDERS)); } catch(e){ /* storage full/unavailable — in-memory state still works this session */ }\n}\n\n// Builds one classified item from a single parsed line — mirrors the matching logic that\n// used to live inline in the old processInput(), now producing a flat per-item status\n// (matched / guessed-needs-confirm / totally-unknown / needs-qty) instead of separate tables.\nfunction classifyLine(parsed){\n  const matches = findSupplierMatches(parsed.name);\n  const item = {\n    id: genId(\"i\"),\n    raw: parsed.raw,\n    label: parsed.name,\n    qty: parsed.qty,\n    unit: parsed.unit,\n    supplier: null,\n    guessSupplier: null,\n    guessName: null,\n    needsQty: false\n  };\n\n  if (parsed.stockNote && parsed.qty === \"?\"){\n    item.needsQty = true;\n    if (matches.length === 1 && matches[0].supplier){\n      item.guessSupplier = matches[0].supplier;\n      item.guessName = matches[0].canonicalName;\n      item.label = matches[0].canonicalName;\n    }\n    return item;\n  }\n\n  if (matches.length === 1 && matches[0].supplier && matches[0].viaContainment){\n    // Only a guess (one name contains the other) — surfaced as a suggestion, not auto-applied.\n    item.guessSupplier = matches[0].supplier;\n    item.guessName = matches[0].canonicalName;\n    return item;\n  }\n  if (matches.length === 1 && matches[0].supplier){\n    item.supplier = matches[0].supplier;\n    item.label = matches[0].canonicalName;\n    return item;\n  }\n  if (matches.length === 1 && matches[0].missingSupplier){\n    item.label = matches[0].canonicalName;\n    item.guessName = matches[0].canonicalName;\n    return item;\n  }\n  if (matches.length > 1){\n    // Multiple possible suppliers for the same name — no single confident guess, owner picks.\n    item._choices = matches.map(m => m.supplier);\n    return item;\n  }\n  return item;\n}\n\n// Splits raw pasted text into one-or-more orders (mirrors the old multi-store-in-one-paste\n// detection), classifies every line, and merges same-name+unit duplicates within one paste\n// by summing quantities instead of asking for confirmation (the inline supplier dropdown +\n// editable qty already make it easy to fix by hand if a merge wasn't wanted).\nfunction parseTextIntoOrders(rawText, orderer, department){\n  const lines = rawText.split(\"\\n\");\n  const fallbackDept = department || STORE_NAMES[0];\n  const byDept = {}; // department -> array of items\n  const deptOrder = [];\n  let currentDept = department || null; // null until either explicitly set or auto-detected\n\n  lines.forEach(line => {\n    if (!line.trim()) return;\n    const headerMatch = isStoreHeader(line);\n    if (headerMatch){ currentDept = headerMatch; return; }\n\n    const parsed = parseLine(line);\n    if (!parsed) return;\n    const dept = currentDept || fallbackDept;\n    if (!byDept[dept]){ byDept[dept] = []; deptOrder.push(dept); }\n\n    const item = classifyLine(parsed);\n    const existing = item.supplier\n      ? byDept[dept].find(i => i.supplier === item.supplier && i.label === item.label && i.unit === item.unit)\n      : null;\n    if (existing && item.qty !== \"?\" && existing.qty !== \"?\"){\n      existing.qty = (parseFloat(existing.qty) || 0) + (parseFloat(item.qty) || 0);\n    } else {\n      byDept[dept].push(item);\n    }\n  });\n\n  return deptOrder.map(dept => ({\n    id: genId(\"o\"),\n    orderer: orderer || \"\",\n    department: dept,\n    createdAt: Date.now(),\n    status: \"pending\",\n    items: byDept[dept]\n  }));\n}\n\nfunction orderIsResolved(order){\n  return order.items.every(i => i.supplier && !i.needsQty);\n}\nfunction orderUnresolvedCount(order){\n  return order.items.filter(i => !i.supplier || i.needsQty).length;\n}\nfunction orderTotalPrice(order){\n  let total = 0, any = false;\n  order.items.forEach(i => {\n    const p = parseFloat(getLastPrice(i.label) || (DICT.find(d => normalize(d.name) === normalize(i.label)) || {}).price || \"\");\n    const q = parseFloat(i.qty);\n    if (!isNaN(p) && !isNaN(q)){ total += p * q; any = true; }\n  });\n  return any ? total : null;\n}\n\nfunction findOrder(orderId){ return ORDERS.find(o => o.id === orderId); }\nfunction findOrderItem(orderId, itemId){\n  const o = findOrder(orderId);\n  if (!o) return null;\n  return o.items.find(i => i.id === itemId) || null;\n}\n\nfunction deleteOrder(orderId){\n  ORDERS = ORDERS.filter(o => o.id !== orderId);\n  saveOrders();\n  renderOrders();\n  renderDispatch();\n  showToast(\"ลบออเดอร์นี้แล้ว\");\n}\n\nfunction markOrderDispatched(orderId){\n  const o = findOrder(orderId);\n  if (!o) return;\n  o.status = \"dispatched\";\n  saveOrders();\n  renderOrders();\n  showToast(\"ทำเครื่องหมายว่าส่งแล้ว\");\n}\n\n// Confirms a supplier for one item — if it's a brand-new item name not already in DICT, runs\n// the same near-duplicate safety check as before rather than silently writing a new row.\nfunction confirmItemSupplier(orderId, itemId, supplier, opts){\n  opts = opts || {};\n  const item = findOrderItem(orderId, itemId);\n  if (!item || !supplier) return;\n  const label = item.guessName || item.label;\n  const isNewName = !DICT.find(d => normalize(d.name) === normalize(label));\n  if (isNewName && !opts.skipSimilarCheck){\n    const similar = findSimilarDictEntry(label);\n    if (similar){\n      item._pendingSimilar = { label, supplier, similarName: similar.name, similarSupplier: similar.supplier };\n      renderOrders();\n      return;\n    }\n  }\n  upsertDict(label, supplier);\n  item.label = label;\n  item.supplier = supplier;\n  item.guessSupplier = null;\n  item.guessName = null;\n  item._choices = null;\n  item._pendingSimilar = null;\n  saveOrders();\n  renderMenuGroups();\n  renderOrders();\n  renderDispatch();\n  showToast(`ผูก \"${label}\" กับ ${supplier} แล้ว`);\n}\nfunction resolveSimilarAsExisting(orderId, itemId){\n  const item = findOrderItem(orderId, itemId);\n  if (!item || !item._pendingSimilar) return;\n  const { similarName, similarSupplier } = item._pendingSimilar;\n  item.label = similarName;\n  item.supplier = similarSupplier;\n  item.guessSupplier = null;\n  item.guessName = null;\n  item._pendingSimilar = null;\n  saveOrders();\n  renderOrders();\n  renderDispatch();\n  showToast(`ใช้ชื่อเดิม \"${similarName}\" แล้ว`);\n}\nfunction resolveSimilarAsNew(orderId, itemId){\n  const item = findOrderItem(orderId, itemId);\n  if (!item || !item._pendingSimilar) return;\n  const { label, supplier } = item._pendingSimilar;\n  item._pendingSimilar = null;\n  confirmItemSupplier(orderId, itemId, supplier, { skipSimilarCheck: true });\n}\nfunction editItemQty(orderId, itemId, qty, unit){\n  const item = findOrderItem(orderId, itemId);\n  if (!item) return;\n  item.qty = qty || \"?\";\n  item.unit = unit || \"\";\n  item.needsQty = item.qty === \"?\";\n  saveOrders();\n}\nfunction editItemLabel(orderId, itemId, label){\n  const item = findOrderItem(orderId, itemId);\n  if (!item) return;\n  item.label = label;\n  item.guessName = label;\n}\n\n// ---------- Rendering: Inbox (order cards) ----------\nfunction renderOrders(){\n  const list = document.getElementById(\"ordersList\");\n  const pending = ORDERS.filter(o => o.status !== \"dispatched\");\n  list.innerHTML = \"\";\n\n  if (pending.length === 0){\n    list.innerHTML = `<div class=\"empty-state\"><div class=\"emoji\">📥</div>รอตรวจสอบ<br>ยังไม่มีออเดอร์ที่รอตรวจสอบ — กด \"วางข้อความสั่งซื้อใหม่\" ด้านบนเพื่อเริ่ม</div>`;\n  } else {\n    pending.slice().sort((a,b) => b.createdAt - a.createdAt).forEach(order => {\n      list.appendChild(buildOrderCard(order));\n    });\n  }\n\n  const pendingBadge = document.getElementById(\"pendingCountBadge\");\n  const inboxBadge = document.getElementById(\"inboxBadge\");\n  const unresolvedTotal = pending.reduce((sum, o) => sum + orderUnresolvedCount(o), 0);\n  if (pendingBadge){\n    pendingBadge.textContent = pending.length;\n    pendingBadge.style.display = pending.length > 0 ? \"inline-block\" : \"none\";\n  }\n  if (inboxBadge){\n    if (unresolvedTotal > 0){ inboxBadge.textContent = unresolvedTotal; inboxBadge.style.display = \"inline-block\"; }\n    else { inboxBadge.style.display = \"none\"; }\n  }\n}\n\nfunction buildOrderCard(order){\n  const resolved = orderIsResolved(order);\n  const unresolvedCount = orderUnresolvedCount(order);\n  const total = orderTotalPrice(order);\n  const card = document.createElement(\"div\");\n  card.className = \"order-card\" + (resolved ? \" resolved\" : \"\");\n  card.id = \"ordercard_\" + order.id;\n\n  const d = new Date(order.createdAt);\n  const dateStr = String(d.getDate()).padStart(2,\"0\") + \"/\" + String(d.getMonth()+1).padStart(2,\"0\") + \" \" + String(d.getHours()).padStart(2,\"0\") + \":\" + String(d.getMinutes()).padStart(2,\"0\");\n\n  const head = document.createElement(\"div\");\n  head.className = \"order-head\";\n  head.innerHTML = `\n    <div class=\"status-dot\">${resolved ? \"✅\" : \"⚠️\"}</div>\n    <div class=\"order-main\">\n      <div class=\"order-name\">${escapeAttr(order.orderer || order.department || \"ออเดอร์\")}${order.orderer && order.department ? `<span class=\"dept-pill\">${escapeAttr(order.department)}</span>` : \"\"}</div>\n      <div class=\"order-meta\">${dateStr} · ${order.items.length} รายการ${total != null ? \" · ฿\" + total.toLocaleString(\"th-TH\",{maximumFractionDigits:2}) : \"\"}</div>\n    </div>\n    <div class=\"order-actions\">\n      <span class=\"status-pill ${resolved ? \"ready\" : \"unmatched\"}\">${resolved ? \"พร้อมส่ง\" : \"ไม่แมท \" + unresolvedCount}</span>\n      <span class=\"icon-btn chevron-toggle\">▾</span>\n    </div>\n  `;\n  const chevronEl = head.querySelector(\".chevron-toggle\");\n  const content = document.createElement(\"div\");\n  content.className = \"order-content\";\n  content.style.display = \"none\";\n  chevronEl.addEventListener(\"click\", () => {\n    const showing = content.style.display !== \"none\";\n    content.style.display = showing ? \"none\" : \"block\";\n    chevronEl.style.transform = showing ? \"\" : \"rotate(180deg)\";\n  });\n  head.addEventListener(\"click\", (e) => {\n    if (e.target.closest(\".icon-btn\")) return;\n    chevronEl.click();\n  });\n\n  order.items.forEach(item => {\n    content.appendChild(buildOrderItemRow(order, item));\n  });\n\n  const actionsRow = document.createElement(\"div\");\n  actionsRow.className = \"order-actions-row\";\n  const sendBtn = document.createElement(\"button\");\n  sendBtn.className = \"btn-cta\";\n  sendBtn.style.flex = \"1\";\n  sendBtn.textContent = \"📨 ทำเครื่องหมายว่าส่งแล้ว\";\n  sendBtn.addEventListener(\"click\", () => markOrderDispatched(order.id));\n  const delBtn = document.createElement(\"button\");\n  delBtn.className = \"icon-btn\";\n  delBtn.style.fontSize = \"18px\";\n  delBtn.textContent = \"🗑️\";\n  delBtn.title = \"ลบออเดอร์นี้\";\n  delBtn.addEventListener(\"click\", () => deleteOrder(order.id));\n  actionsRow.appendChild(sendBtn);\n  actionsRow.appendChild(delBtn);\n  content.appendChild(actionsRow);\n\n  card.appendChild(head);\n  card.appendChild(content);\n  return card;\n}\n\nfunction buildOrderItemRow(order, item){\n  const row = document.createElement(\"div\");\n  row.className = \"order-item-row\";\n  const qtyUnitText = item.qty !== \"?\" ? ` ${item.qty}${item.unit ? \" \" + item.unit : \"\"}` : \"\";\n\n  if (item.supplier){\n    row.innerHTML = `<div class=\"item-name\">${escapeAttr(item.label)}${qtyUnitText}</div><div class=\"item-sub\">✓ ${escapeAttr(item.supplier)}</div>`;\n    return row;\n  }\n\n  if (item._pendingSimilar){\n    const nameEl = document.createElement(\"div\");\n    nameEl.className = \"item-name\";\n    nameEl.textContent = item.label + qtyUnitText;\n    const warn = document.createElement(\"div\");\n    warn.className = \"item-sub\";\n    warn.style.color = \"#C2691A\";\n    warn.innerHTML = `พบชื่อคล้าย \"${escapeAttr(item._pendingSimilar.similarName)}\" (${escapeAttr(item._pendingSimilar.similarSupplier)}) ในระบบแล้ว — ใช่รายการเดียวกันไหม?`;\n    const btnRow = document.createElement(\"div\");\n    btnRow.style.display = \"flex\"; btnRow.style.gap = \"6px\"; btnRow.style.marginTop = \"4px\";\n    const useBtn = document.createElement(\"button\");\n    useBtn.className = \"small secondary\"; useBtn.textContent = \"ใช้ชื่อเดิม\";\n    useBtn.addEventListener(\"click\", () => resolveSimilarAsExisting(order.id, item.id));\n    const newBtn = document.createElement(\"button\");\n    newBtn.className = \"small\"; newBtn.textContent = \"สร้างใหม่แยกต่างหาก\";\n    newBtn.addEventListener(\"click\", () => resolveSimilarAsNew(order.id, item.id));\n    btnRow.appendChild(useBtn); btnRow.appendChild(newBtn);\n    row.appendChild(nameEl); row.appendChild(warn); row.appendChild(btnRow);\n    return row;\n  }\n\n  const nameId = \"itemname_\" + item.id;\n  const qtyId = \"itemqty_\" + item.id;\n  const unitId = \"itemunit_\" + item.id;\n  const selectId = \"itemsel_\" + item.id;\n  const newSupId = \"itemnewsup_\" + item.id;\n\n  let html = \"\";\n  html += `<div class=\"item-name\">\n    <input type=\"text\" id=\"${nameId}\" value=\"${escapeAttr(item.guessName || item.label)}\" style=\"width:100%; max-width:260px;\">\n  </div>`;\n  if (item.needsQty){\n    html += `<div class=\"item-sub\">แจ้งสต๊อกแต่ไม่ระบุจำนวนสั่ง — พิมพ์จำนวนที่ต้องการสั่งเพิ่ม</div>\n      <input type=\"text\" id=\"${qtyId}\" placeholder=\"จำนวน\" style=\"width:70px;\">\n      <input type=\"text\" id=\"${unitId}\" placeholder=\"หน่วย\" value=\"${escapeAttr(item.unit||\"\")}\" style=\"width:70px;\">`;\n  } else {\n    html += `<div class=\"item-sub\">${escapeAttr(item.raw)}${qtyUnitText ? \" (\" + qtyUnitText.trim() + \")\" : \"\"}</div>`;\n  }\n  if (item.guessSupplier){\n    html += `<div class=\"item-suggest\">✓ แนะนำ: ${escapeAttr(item.guessSupplier)} (จาก \"${escapeAttr(item.guessName || item.label)}\")</div>`;\n  }\n  const supOptions = allSuppliers().map(s => `<option value=\"${s}\" ${s===item.guessSupplier?\"selected\":\"\"}>${s}</option>`).join(\"\");\n  html += `<select id=\"${selectId}\" class=\"supplier-select\">\n      <option value=\"\">ยังไม่ได้แยกซัพพลายเออร์</option>\n      ${supOptions}\n      <option value=\"__newsup__\">+ ซัพพลายเออร์ใหม่</option>\n    </select>\n    <input type=\"text\" id=\"${newSupId}\" placeholder=\"ชื่อซัพใหม่ แล้วกด Enter\" style=\"display:none; width:100%;\">`;\n  row.innerHTML = html;\n\n  const selectEl = row.querySelector(\"#\" + CSS_ID(selectId));\n  const newSupInput = row.querySelector(\"#\" + CSS_ID(newSupId));\n  const nameInput = row.querySelector(\"#\" + CSS_ID(nameId));\n  selectEl.addEventListener(\"change\", () => {\n    if (selectEl.value === \"__newsup__\"){\n      newSupInput.style.display = \"block\";\n      newSupInput.focus();\n      return;\n    }\n    if (!selectEl.value) return;\n    editItemLabel(order.id, item.id, nameInput.value.trim() || item.label);\n    confirmItemSupplier(order.id, item.id, selectEl.value);\n  });\n  newSupInput.addEventListener(\"keydown\", (e) => {\n    if (e.key === \"Enter\"){\n      const val = newSupInput.value.trim();\n      if (!val) return;\n      editItemLabel(order.id, item.id, nameInput.value.trim() || item.label);\n      confirmItemSupplier(order.id, item.id, val);\n    }\n  });\n  if (item.needsQty){\n    const qtyInput = row.querySelector(\"#\" + CSS_ID(qtyId));\n    const unitInput = row.querySelector(\"#\" + CSS_ID(unitId));\n    const applyQty = () => editItemQty(order.id, item.id, qtyInput.value.trim(), unitInput.value.trim());\n    qtyInput.addEventListener(\"change\", applyQty);\n    unitInput.addEventListener(\"change\", applyQty);\n  }\n  return row;\n}\n// Some generated ids may contain characters that need no escaping today, but this keeps\n// querySelector safe if that ever changes (ids are always genId()-based, alnum/underscore).\nfunction CSS_ID(id){ return id; }\n\n// ---------- Rendering: Dispatch (supplier-grouped, ready to copy to LINE) ----------\n// Every resolved item across EVERY order (regardless of which order it came from, or whether\n// that order has been marked \"ส่งแล้ว\" yet) is combined here, grouped by department then\n// supplier — this is deliberately decoupled from per-order status so the owner always has ONE\n// combined list per supplier to copy into LINE, not one fragmented message per order card.\nfunction computeDispatchData(){\n  const byDept = {};\n  ORDERS.forEach(order => {\n    order.items.forEach(item => {\n      if (!item.supplier) return;\n      if (!byDept[order.department]) byDept[order.department] = {};\n      if (!byDept[order.department][item.supplier]) byDept[order.department][item.supplier] = [];\n      byDept[order.department][item.supplier].push({ label: item.label, qty: item.qty, unit: item.unit, raw: item.raw });\n    });\n  });\n  return byDept;\n}\n\nfunction renderDispatch(){\n  const byDept = computeDispatchData();\n  const container = document.getElementById(\"results\");\n  container.innerHTML = \"\";\n  const today = new Date();\n  const dateStr = String(today.getDate()).padStart(2,\"0\") + \"/\" + String(today.getMonth()+1).padStart(2,\"0\") + \"/\" + today.getFullYear();\n\n  let totalItems = 0;\n  Object.keys(byDept).forEach(dept => {\n    const groups = byDept[dept];\n    const suppliers = Object.keys(groups).sort();\n    if (!suppliers.length) return;\n\n    const block = document.createElement(\"div\");\n    block.className = \"card store-block\";\n    const title = document.createElement(\"div\");\n    title.className = \"store-title\";\n    title.textContent = dept;\n    block.appendChild(title);\n\n    const storeTotalEl = document.createElement(\"div\");\n    storeTotalEl.className = \"muted\";\n    storeTotalEl.style.marginBottom = \"6px\";\n    block.appendChild(storeTotalEl);\n\n    const summaryBox = document.createElement(\"div\");\n    summaryBox.style.marginBottom = \"14px\";\n    block.appendChild(summaryBox);\n    summaryBox.addEventListener(\"click\", (e) => {\n      const row = e.target.closest(\"tr[data-target]\");\n      if (!row) return;\n      const target = document.getElementById(row.getAttribute(\"data-target\"));\n      if (target){ target.classList.remove(\"collapsed\"); target.scrollIntoView({ behavior: \"smooth\", block: \"start\" }); }\n    });\n\n    const quickNav = document.createElement(\"div\");\n    quickNav.className = \"quick-nav\";\n    suppliers.forEach(supplier => {\n      const chip = document.createElement(\"span\");\n      chip.className = \"quick-nav-chip\";\n      chip.textContent = \"🛒 \" + supplier;\n      const targetId = `supplierbox_${dept}_${supplier}`.replace(/\\s+/g,\"_\");\n      chip.addEventListener(\"click\", () => {\n        const target = document.getElementById(targetId);\n        if (target){ target.classList.remove(\"collapsed\"); target.scrollIntoView({ behavior: \"smooth\", block: \"start\" }); }\n      });\n      quickNav.appendChild(chip);\n    });\n    block.appendChild(quickNav);\n\n    function recalcStoreTotal(){\n      let total = 0, missing = 0;\n      block.querySelectorAll(\".price-subtotal\").forEach(el => {\n        const v = parseFloat(el.getAttribute(\"data-value\"));\n        if (!isNaN(v)) total += v; else missing++;\n      });\n      storeTotalEl.textContent = total > 0\n        ? `ประมาณต้นทุนรวมวันนี้: ${total.toLocaleString(\"th-TH\",{maximumFractionDigits:2})} บาท${missing?` (ยังไม่ใส่ราคาอีก ${missing} รายการ)`:\"\"}`\n        : \"ยังไม่ได้ใส่ราคาประมาณการเลย — ใส่ในช่องราคาแต่ละรายการด้านล่างได้ (ไม่บังคับ)\";\n      const rows = suppliers.map(supplier => {\n        const supplierTotalId = `suptotal_${dept}_${supplier}`.replace(/\\s+/g,\"_\");\n        const supplierBoxId = `supplierbox_${dept}_${supplier}`.replace(/\\s+/g,\"_\");\n        const el = document.getElementById(supplierTotalId);\n        const text = el ? el.textContent : \"ยังไม่ได้ใส่ราคา\";\n        const known = text !== \"ยังไม่ได้ใส่ราคา\";\n        return `<tr class=\"summary-row\" data-target=\"${supplierBoxId}\"><td style=\"padding:3px 10px 3px 0;\">🛒 ${supplier}</td><td style=\"padding:3px 0; text-align:right; ${known?\"font-weight:600;color:#2F5233;\":\"color:#9A9587;\"}\">${text}</td></tr>`;\n      }).join(\"\");\n      summaryBox.innerHTML = `<div class=\"muted\" style=\"margin-bottom:4px;\">สรุปรวมราคาแต่ละซัพพลายเออร์:</div>\n        <table style=\"width:100%; border-collapse:collapse; font-size:13px;\"><tbody>${rows}</tbody></table>`;\n    }\n\n    suppliers.forEach(supplier => {\n      const items = groups[supplier];\n      totalItems += items.length;\n      const box = document.createElement(\"div\");\n      box.className = \"supplier-box collapsed\";\n      box.id = `supplierbox_${dept}_${supplier}`.replace(/\\s+/g,\"_\");\n      const head = document.createElement(\"div\");\n      head.className = \"supplier-head\";\n      head.innerHTML = `<span>🛒 ${supplier}<span class=\"count-pill\">${items.length}</span><span class=\"chevron\">▾</span></span>`;\n      head.addEventListener(\"click\", (e) => { if (e.target.closest(\"button\")) return; box.classList.toggle(\"collapsed\"); });\n      const copyBtn = document.createElement(\"button\");\n      copyBtn.className = \"small secondary\";\n      copyBtn.style.background = \"#fff\";\n      copyBtn.textContent = \"คัดลอก\";\n      function buildBodyText(){\n        return `สวัสดีครับ/ค่ะ ${dept} ขอสั่งของวันที่ ${dateStr}\\n` +\n          items.map(i => `- ${i.label}${i.qty!==\"?\" ? \" \" + i.qty : \"\"}${i.unit ? \" \" + i.unit : \"\"}`).join(\"\\n\") +\n          `\\nขอบคุณครับ/ค่ะ`;\n      }\n      const bodyText = buildBodyText();\n      const plainBody = document.createElement(\"div\");\n      plainBody.className = \"supplier-body\";\n      plainBody.style.display = \"none\";\n      plainBody.textContent = bodyText;\n      copyBtn.onclick = () => copyText(bodyText, copyBtn, plainBody);\n      head.appendChild(copyBtn);\n      box.appendChild(head);\n\n      const content = document.createElement(\"div\");\n      content.className = \"supplier-content\";\n      const preview = document.createElement(\"div\");\n      preview.className = \"supplier-body\";\n      preview.textContent = bodyText;\n      preview.title = \"คลิกขวาเพื่อคัดลอกข้อความทั้งหมด\";\n      preview.style.cursor = \"context-menu\";\n      preview.addEventListener(\"contextmenu\", (e) => { e.preventDefault(); copyText(bodyText, copyBtn, plainBody); });\n      content.appendChild(preview);\n      content.appendChild(plainBody);\n\n      const priceWrap = document.createElement(\"div\");\n      priceWrap.style.padding = \"0 14px 12px\";\n      priceWrap.style.background = \"#FAFAF6\";\n      const priceTbl = document.createElement(\"table\");\n      priceTbl.style.width = \"100%\"; priceTbl.style.borderCollapse = \"collapse\"; priceTbl.style.fontSize = \"12.5px\";\n      priceTbl.innerHTML = \"<thead><tr><th style='text-align:left;padding:4px 0;color:#9A9587;font-weight:600;font-size:11.5px;'>รายการ</th><th style='text-align:left;padding:4px 0;color:#9A9587;font-weight:600;font-size:11.5px;'>ราคา/หน่วย (ไม่บังคับ)</th><th style='text-align:right;padding:4px 0;color:#9A9587;font-weight:600;font-size:11.5px;'>รวม</th></tr></thead>\";\n      const priceTbody = document.createElement(\"tbody\");\n      const supplierTotalId = `suptotal_${dept}_${supplier}`.replace(/\\s+/g,\"_\");\n      function recalcSupplierTotal(){\n        let total = 0, missing = 0;\n        priceTbody.querySelectorAll(\".price-subtotal\").forEach(el => {\n          const v = parseFloat(el.getAttribute(\"data-value\"));\n          if (!isNaN(v)) total += v; else missing++;\n        });\n        const totalEl = document.getElementById(supplierTotalId);\n        if (totalEl){\n          totalEl.textContent = total > 0\n            ? `รวมประมาณ: ${total.toLocaleString(\"th-TH\",{maximumFractionDigits:2})} บาท${missing?` (เหลืออีก ${missing} รายการยังไม่ใส่ราคา)`:\"\"}`\n            : \"ยังไม่ได้ใส่ราคา\";\n        }\n        recalcStoreTotal();\n      }\n      items.forEach((i, itemIdx) => {\n        const tr = document.createElement(\"tr\");\n        const priceId = `price_${dept}_${supplier}_${itemIdx}`.replace(/\\s+/g,\"_\");\n        const subtotalId = `subtotal_${dept}_${supplier}_${itemIdx}`.replace(/\\s+/g,\"_\");\n        const dictEntryForPrice = DICT.find(d => normalize(d.name) === normalize(i.label));\n        const lastPrice = getLastPrice(i.label) || (dictEntryForPrice && dictEntryForPrice.price) || \"\";\n        tr.innerHTML = `\n          <td style=\"padding:3px 6px 3px 0;\">${i.label}${i.qty!==\"?\" ? \" \" + i.qty : \"\"}${i.unit ? \" \" + i.unit : \"\"}</td>\n          <td style=\"padding:3px 6px;\"><input type=\"text\" id=\"${priceId}\" value=\"${escapeAttr(lastPrice)}\" placeholder=\"ราคา\" style=\"width:70px;\"></td>\n          <td style=\"padding:3px 0; text-align:right;\"><span id=\"${subtotalId}\" class=\"price-subtotal\" data-value=\"\">-</span></td>\n        `;\n        priceTbody.appendChild(tr);\n        setTimeout(() => {\n          const priceInput = document.getElementById(priceId);\n          const subtotalEl = document.getElementById(subtotalId);\n          // Guards against a stale callback firing after a later render already replaced this\n          // box's contents (e.g. two dispatch-affecting actions happening in quick succession).\n          if (!priceInput || !subtotalEl) return;\n          function recalcLine(){\n            const priceVal = parseFloat(priceInput.value);\n            const qtyVal = parseFloat(i.qty);\n            if (!isNaN(priceVal) && !isNaN(qtyVal)){\n              const sub = priceVal * qtyVal;\n              subtotalEl.textContent = sub.toLocaleString(\"th-TH\",{maximumFractionDigits:2});\n              subtotalEl.setAttribute(\"data-value\", String(sub));\n            } else {\n              subtotalEl.textContent = \"-\";\n              subtotalEl.setAttribute(\"data-value\", \"\");\n            }\n            recalcSupplierTotal();\n          }\n          if (lastPrice) recalcLine();\n          priceInput.addEventListener(\"input\", () => { savePrice(i.label, priceInput.value.trim()); recalcLine(); });\n        }, 0);\n      });\n      priceTbl.appendChild(priceTbody);\n      priceWrap.appendChild(priceTbl);\n      const supplierTotalEl = document.createElement(\"div\");\n      supplierTotalEl.id = supplierTotalId;\n      supplierTotalEl.className = \"muted\";\n      supplierTotalEl.style.textAlign = \"right\";\n      supplierTotalEl.style.marginTop = \"4px\";\n      supplierTotalEl.textContent = \"ยังไม่ได้ใส่ราคา\";\n      priceWrap.appendChild(supplierTotalEl);\n      content.appendChild(priceWrap);\n      box.appendChild(content);\n      block.appendChild(box);\n    });\n\n    setTimeout(recalcStoreTotal, 0);\n    container.appendChild(block);\n  });\n\n  if (!container.innerHTML){\n    container.innerHTML = '<p class=\"muted\">ยังไม่มีรายการที่แยกซัพพลายเออร์ไว้ — ไปที่ \"กล่องออเดอร์\" เพื่อแยกวัตถุดิบให้ซัพพลายเออร์ก่อน</p>';\n  }\n  const badge = document.getElementById(\"dispatchBadge\");\n  if (badge){\n    if (totalItems > 0){ badge.textContent = totalItems; badge.style.display = \"inline-block\"; }\n    else { badge.style.display = \"none\"; }\n  }\n}\n\nfunction legacyCopy(text){\n  const ta = document.createElement(\"textarea\");\n  ta.value = text;\n  ta.style.position = \"fixed\";\n  ta.style.top = \"-1000px\";\n  ta.style.left = \"-1000px\";\n  ta.setAttribute(\"readonly\", \"\");\n  document.body.appendChild(ta);\n  ta.focus();\n  ta.select();\n  ta.setSelectionRange(0, text.length);\n  let ok = false;\n  try { ok = document.execCommand(\"copy\"); } catch (e) { ok = false; }\n  document.body.removeChild(ta);\n  return ok;\n}\n\nfunction selectBoxText(bodyEl){\n  const range = document.createRange();\n  range.selectNodeContents(bodyEl);\n  const sel = window.getSelection();\n  sel.removeAllRanges();\n  sel.addRange(range);\n}\n\nfunction copyText(text, btn, bodyEl){\n  const markSuccess = () => {\n    const old = btn.textContent;\n    btn.textContent = \"คัดลอกแล้ว ✓\";\n    setTimeout(() => btn.textContent = old, 1500);\n  };\n  const markManual = () => {\n    if (bodyEl) selectBoxText(bodyEl);\n    showToast(\"คัดลอกอัตโนมัติไม่ได้ในเบราว์เซอร์นี้ — เลือกข้อความให้แล้ว กด Ctrl+C / Cmd+C ต่อได้เลย\");\n  };\n  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false){\n    navigator.clipboard.writeText(text).then(markSuccess).catch(() => {\n      if (legacyCopy(text)) markSuccess(); else markManual();\n    });\n  } else {\n    if (legacyCopy(text)) markSuccess(); else markManual();\n  }\n}\n\nfunction showToast(msg){\n  const t = document.getElementById(\"toast\");\n  t.textContent = msg;\n  t.classList.add(\"show\");\n  setTimeout(() => t.classList.remove(\"show\"), 2200);\n}\n\n// ---------- Rendering: Menu (วัตถุดิบ & แมทคำ) — category, then supplier, then item ----------\nfunction renderMenuGroups(){\n  document.getElementById(\"dictCount\").textContent = DICT.length;\n  const container = document.getElementById(\"menuGroups\");\n  container.innerHTML = \"\";\n\n  const bySupplier = {};\n  DICT.forEach((d, idx) => { if (!bySupplier[d.supplier]) bySupplier[d.supplier] = []; bySupplier[d.supplier].push(idx); });\n  const byCategory = {};\n  DICT.forEach((d, idx) => {\n    const cat = d.category || \"อื่นๆ\";\n    if (!byCategory[cat]) byCategory[cat] = {};\n    if (!byCategory[cat][d.supplier]) byCategory[cat][d.supplier] = [];\n    byCategory[cat][d.supplier].push(idx);\n  });\n\n  Object.keys(byCategory).sort().forEach(cat => {\n    const group = document.createElement(\"div\");\n    group.className = \"category-group\";\n    group.dataset.category = cat;\n    Object.keys(byCategory[cat]).sort().forEach(supplier => {\n      const head = document.createElement(\"div\");\n      head.className = \"category-group-head\";\n      head.innerHTML = `🏷️ ${escapeAttr(cat)} <span class=\"crumb\">→ ซัพพลายเออร์${escapeAttr(supplier)}</span>`;\n      group.appendChild(head);\n      byCategory[cat][supplier].sort((a,b) => DICT[a].name.localeCompare(DICT[b].name, \"th\")).forEach(idx => {\n        group.appendChild(buildMenuItemCard(idx));\n      });\n    });\n    container.appendChild(group);\n  });\n\n  const noMatch = document.createElement(\"p\");\n  noMatch.id = \"menuNoMatch\";\n  noMatch.className = \"muted\";\n  noMatch.style.display = \"none\";\n  noMatch.textContent = \"ไม่พบวัตถุดิบที่ตรงกับคำค้นหา\";\n  container.appendChild(noMatch);\n\n  const supSel = document.getElementById(\"newItemSupplier\");\n  supSel.innerHTML = allSuppliers().map(s => `<option value=\"${s}\">${s}</option>`).join(\"\") + `<option value=\"__new__\">+ ซัพพลายเออร์ใหม่</option>`;\n  const catSel = document.getElementById(\"newItemCategory\");\n  catSel.innerHTML = allCategories().map(c => `<option value=\"${c}\">${c}</option>`).join(\"\") + `<option value=\"__newcat__\">+ หมวดใหม่</option>`;\n  const canonSel = document.getElementById(\"newAliasCanonicalGlobal\");\n  if (canonSel) canonSel.innerHTML = DICT.map(d => d.name).sort((a,b)=>a.localeCompare(b,\"th\")).map(n => `<option value=\"${n}\">${n}</option>`).join(\"\");\n\n  filterMenuRows();\n}\n\nfunction buildMenuItemCard(idx){\n  const d = DICT[idx];\n  const card = document.createElement(\"div\");\n  card.className = \"menu-item-card\";\n  card.dataset.name = normalize(d.name) + \" \" + normalize(d.supplier) + \" \" + normalize(d.category||\"\");\n  const aliases = ALIAS_TABLE.map((a, aIdx) => ({...a, aIdx})).filter(a => normalize(a.canonical) === normalize(d.name));\n  card.dataset.name += \" \" + aliases.map(a => normalize(a.typed)).join(\" \");\n\n  const top = document.createElement(\"div\");\n  top.className = \"menu-item-top\";\n  top.innerHTML = `\n    <div>\n      <div class=\"menu-item-name\">${escapeAttr(d.name)}</div>\n      <div class=\"menu-item-price\">${d.price ? \"฿\" + escapeAttr(d.price) : \"ยังไม่ได้ใส่ราคา\"}</div>\n    </div>\n    <div class=\"menu-item-actions\">\n      <button class=\"icon-btn\" data-act=\"alias\" title=\"เพิ่มแมทคำ\">🔗</button>\n      <button class=\"icon-btn\" data-act=\"edit\" title=\"แก้ไข\">✏️</button>\n      <button class=\"icon-btn\" data-act=\"del\" title=\"ลบ\">🗑️</button>\n    </div>\n  `;\n  card.appendChild(top);\n\n  const pills = document.createElement(\"div\");\n  pills.className = \"alias-pills\";\n  aliases.forEach(a => {\n    const pill = document.createElement(\"span\");\n    pill.className = \"alias-pill\";\n    pill.innerHTML = `🔗 ${escapeAttr(a.typed)} <span class=\"x\" title=\"ลบแมทคำนี้\">×</span>`;\n    pill.querySelector(\".x\").addEventListener(\"click\", () => {\n      ALIAS_TABLE.splice(a.aIdx, 1);\n      saveAliasTable(ALIAS_TABLE);\n      renderMenuGroups();\n    });\n    pills.appendChild(pill);\n  });\n  card.appendChild(pills);\n\n  const aliasForm = document.createElement(\"div\");\n  aliasForm.className = \"inline-form\";\n  aliasForm.style.display = \"none\";\n  aliasForm.innerHTML = `<input type=\"text\" placeholder=\"คำที่พนักงานพิมพ์ผิด/เรียกอย่างอื่น\" style=\"flex:1;\"><button class=\"small\">เพิ่ม</button>`;\n  const aliasInput = aliasForm.querySelector(\"input\");\n  aliasForm.querySelector(\"button\").addEventListener(\"click\", () => {\n    const typed = aliasInput.value.trim();\n    if (!typed){ showToast(\"พิมพ์คำเทียบเคียงก่อน\"); return; }\n    upsertAlias(typed, d.name);\n    aliasInput.value = \"\";\n    aliasForm.style.display = \"none\";\n    renderMenuGroups();\n    showToast(`เพิ่มแมทคำ \"${typed}\" → \"${d.name}\" แล้ว`);\n  });\n  card.appendChild(aliasForm);\n\n  const editForm = document.createElement(\"div\");\n  editForm.className = \"inline-form\";\n  editForm.style.display = \"none\";\n  const supOpts = allSuppliers().map(s => `<option value=\"${s}\" ${s===d.supplier?\"selected\":\"\"}>${s}</option>`).join(\"\");\n  const catOpts = allCategories().map(c => `<option value=\"${c}\" ${c===d.category?\"selected\":\"\"}>${c}</option>`).join(\"\");\n  editForm.innerHTML = `\n    <input type=\"text\" class=\"edit-name\" value=\"${escapeAttr(d.name)}\" placeholder=\"ชื่อวัตถุดิบ\">\n    <select class=\"edit-category\">${catOpts}</select>\n    <select class=\"edit-supplier\">${supOpts}</select>\n    <input type=\"text\" class=\"edit-price\" value=\"${escapeAttr(d.price||\"\")}\" placeholder=\"ราคา/หน่วย\" style=\"max-width:110px;\">\n    <button class=\"small\">บันทึก</button>\n  `;\n  editForm.querySelector(\"button\").addEventListener(\"click\", () => {\n    const name = editForm.querySelector(\".edit-name\").value.trim() || d.name;\n    const category = editForm.querySelector(\".edit-category\").value;\n    const supplier = editForm.querySelector(\".edit-supplier\").value;\n    const price = editForm.querySelector(\".edit-price\").value.trim();\n    DICT[idx].name = name;\n    DICT[idx].category = category;\n    DICT[idx].supplier = supplier;\n    DICT[idx].price = price;\n    saveDict(DICT);\n    renderMenuGroups();\n    showToast(\"บันทึกการแก้ไขแล้ว\");\n  });\n  card.appendChild(editForm);\n\n  top.querySelector('[data-act=\"alias\"]').addEventListener(\"click\", () => {\n    aliasForm.style.display = aliasForm.style.display === \"none\" ? \"flex\" : \"none\";\n    editForm.style.display = \"none\";\n  });\n  top.querySelector('[data-act=\"edit\"]').addEventListener(\"click\", () => {\n    editForm.style.display = editForm.style.display === \"none\" ? \"flex\" : \"none\";\n    aliasForm.style.display = \"none\";\n  });\n  top.querySelector('[data-act=\"del\"]').addEventListener(\"click\", () => {\n    DICT.splice(idx, 1);\n    saveDict(DICT);\n    renderMenuGroups();\n    showToast(\"ลบวัตถุดิบแล้ว\");\n  });\n\n  return card;\n}\n\nfunction filterMenuRows(){\n  const searchEl = document.getElementById(\"dictSearch\");\n  const term = normalize(searchEl ? searchEl.value : \"\");\n  let anyVisible = false;\n  document.querySelectorAll(\"#menuGroups .category-group\").forEach(group => {\n    let groupVisible = false;\n    group.querySelectorAll(\".menu-item-card\").forEach(card => {\n      const match = !term || (card.dataset.name || \"\").includes(term);\n      card.style.display = match ? \"\" : \"none\";\n      if (match) groupVisible = true;\n    });\n    group.style.display = groupVisible ? \"\" : \"none\";\n    if (groupVisible) anyVisible = true;\n  });\n  const noMatch = document.getElementById(\"menuNoMatch\");\n  if (noMatch) noMatch.style.display = (term && !anyVisible) ? \"block\" : \"none\";\n}\n\n// Standalone name-checker (แมทคำ tester): type any single ingredient name and see immediately\n// what it would resolve to, using the exact same matching logic as real order processing.\nfunction runNameCheck(){\n  const raw = document.getElementById(\"nameCheckInput\").value.trim();\n  const resultEl = document.getElementById(\"nameCheckResult\");\n  if (!raw){ resultEl.innerHTML = \"\"; return; }\n  const matches = findSupplierMatches(raw);\n  if (matches.length === 0){\n    resultEl.innerHTML = `<span class=\"flag\">❓ ยังไม่รู้จักชื่อนี้ในระบบ</span> — ถ้าประมวลผลออเดอร์จริง จะไปโผล่เป็นรายการที่ต้องเลือกซัพพลายเออร์`;\n  } else if (matches.length > 1){\n    const list = matches.map(m => `<b>${m.supplier}</b> (${m.canonicalName})`).join(\", \");\n    resultEl.innerHTML = `⚠️ ชื่อนี้จับคู่ได้หลายซัพพลายเออร์พร้อมกัน: ${list} — ถ้าประมวลผลจริงระบบจะให้เลือกเอง`;\n  } else {\n    const m = matches[0];\n    if (m.missingSupplier){\n      resultEl.innerHTML = `⚠️ จับคู่ผ่านแมทคำได้ชื่อมาตรฐาน \"<b>${m.canonicalName}</b>\" แต่ยังไม่มีซัพพลายเออร์ผูกไว้`;\n    } else if (m.viaContainment){\n      resultEl.innerHTML = `🔗 <b>เดา</b> ว่าอาจเป็นรายการเดียวกับ \"<b>${m.canonicalName}</b>\" (ซัพ ${m.supplier}) — เป็นแค่การเดา ถ้าประมวลผลจริงระบบจะถามยืนยันก่อน`;\n    } else if (m.viaAlias){\n      resultEl.innerHTML = `📎 จับคู่ผ่านแมทคำ → \"<b>${m.canonicalName}</b>\" (ซัพ <b>${m.supplier}</b>) — ลงกลุ่มนี้ทันที ไม่ต้องยืนยัน`;\n    } else if (m.viaFirstWord){\n      resultEl.innerHTML = `✅ คำแรกก่อนเว้นวรรคตรงกับ \"<b>${m.canonicalName}</b>\" (ซัพ <b>${m.supplier}</b>) เป๊ะ — ถือเป็นรายการเดียวกันทันที`;\n    } else {\n      resultEl.innerHTML = `✅ ตรงเป๊ะกับ \"<b>${m.canonicalName}</b>\" (ซัพ <b>${m.supplier}</b>) — ลงกลุ่มนี้ทันที`;\n    }\n  }\n}\ndocument.getElementById(\"nameCheckInput\").addEventListener(\"input\", runNameCheck);\ndocument.getElementById(\"dictSearch\").addEventListener(\"input\", filterMenuRows);\n\n// ---------- Compose form (Inbox: \"วางข้อความสั่งซื้อใหม่\") ----------\nfunction updateProcessBtnCount(){\n  const text = document.getElementById(\"rawInput\").value;\n  const lines = text.split(\"\\n\").map(l => l.trim()).filter(l => l && !isStoreHeader(l));\n  document.getElementById(\"processBtn\").textContent = `บันทึกออเดอร์ (${lines.length} รายการ)`;\n}\ndocument.getElementById(\"rawInput\").addEventListener(\"input\", updateProcessBtnCount);\n\nfunction openCompose(){\n  document.getElementById(\"composeBox\").style.display = \"block\";\n  document.getElementById(\"composeToggleBtn\").style.display = \"none\";\n}\nfunction closeCompose(){\n  document.getElementById(\"composeBox\").style.display = \"none\";\n  document.getElementById(\"composeToggleBtn\").style.display = \"block\";\n  document.getElementById(\"ordererInput\").value = \"\";\n  document.getElementById(\"departmentSelect\").value = \"\";\n  document.getElementById(\"departmentCustom\").style.display = \"none\";\n  document.getElementById(\"departmentCustom\").value = \"\";\n  document.getElementById(\"rawInput\").value = \"\";\n  updateProcessBtnCount();\n}\ndocument.getElementById(\"composeToggleBtn\").addEventListener(\"click\", openCompose);\ndocument.getElementById(\"composeCancelBtn\").addEventListener(\"click\", closeCompose);\ndocument.getElementById(\"departmentSelect\").addEventListener(\"change\", (e) => {\n  document.getElementById(\"departmentCustom\").style.display = e.target.value === \"__new__\" ? \"block\" : \"none\";\n});\ndocument.getElementById(\"processBtn\").addEventListener(\"click\", () => {\n  const rawText = document.getElementById(\"rawInput\").value;\n  if (!rawText.trim()){ showToast(\"วางข้อความสั่งซื้อก่อน\"); return; }\n  const orderer = document.getElementById(\"ordererInput\").value.trim();\n  let department = document.getElementById(\"departmentSelect\").value;\n  if (department === \"__new__\") department = document.getElementById(\"departmentCustom\").value.trim();\n  const newOrders = parseTextIntoOrders(rawText, orderer, department);\n  ORDERS = ORDERS.concat(newOrders);\n  saveOrders();\n  renderOrders();\n  renderDispatch();\n  closeCompose();\n  switchMainTab(\"inbox\");\n  showToast(`บันทึกออเดอร์แล้ว (${newOrders.length} ใบ)`);\n});\n\n// ---------- Add-item form (Menu tab) ----------\ndocument.getElementById(\"addItemToggleBtn\").addEventListener(\"click\", () => {\n  const form = document.getElementById(\"addItemForm\");\n  form.style.display = form.style.display === \"none\" ? \"flex\" : \"none\";\n});\ndocument.getElementById(\"newItemSupplier\").addEventListener(\"change\", (e) => {\n  document.getElementById(\"newSupplierCustom\").style.display = e.target.value === \"__new__\" ? \"inline-block\" : \"none\";\n});\ndocument.getElementById(\"newItemCategory\").addEventListener(\"change\", (e) => {\n  if (e.target.value === \"__newcat__\"){\n    const custom = prompt(\"พิมพ์ชื่อหมวดใหม่:\");\n    if (custom && custom.trim()){\n      const opt = document.createElement(\"option\");\n      opt.value = custom.trim(); opt.textContent = custom.trim(); opt.selected = true;\n      e.target.insertBefore(opt, e.target.querySelector('option[value=\"__newcat__\"]'));\n    } else {\n      e.target.value = CATEGORY_LIST[CATEGORY_LIST.length - 1];\n    }\n  }\n});\nfunction finalizeAddDictItem(name, supplier, price, category){\n  const result = upsertDict(name, supplier, price, category);\n  renderMenuGroups();\n  document.getElementById(\"newItemName\").value = \"\";\n  document.getElementById(\"newSupplierCustom\").value = \"\";\n  document.getElementById(\"newItemPrice\").value = \"\";\n  document.getElementById(\"dictSimilarWarning\").style.display = \"none\";\n  showToast(result === \"updated\" ? `\"${name}\" มีอยู่แล้ว — อัปเดตข้อมูลแล้ว` : \"เพิ่มรายการใหม่แล้ว\");\n}\ndocument.getElementById(\"addDictBtn\").addEventListener(\"click\", () => {\n  const name = document.getElementById(\"newItemName\").value.trim();\n  let supplier = document.getElementById(\"newItemSupplier\").value;\n  if (supplier === \"__new__\") supplier = document.getElementById(\"newSupplierCustom\").value.trim();\n  const price = document.getElementById(\"newItemPrice\").value.trim();\n  const category = document.getElementById(\"newItemCategory\").value;\n  if (!name || !supplier){ showToast(\"กรอกชื่อวัตถุดิบและซัพพลายเออร์ให้ครบ\"); return; }\n  const isNewName = !DICT.find(d => normalize(d.name) === normalize(name));\n  const similar = isNewName ? findSimilarDictEntry(name) : null;\n  if (similar){\n    const warn = document.getElementById(\"dictSimilarWarning\");\n    warn.style.display = \"block\";\n    warn.innerHTML = `พบชื่อคล้ายกับ <b>\"${similar.name}\"</b> (ซัพพลายเออร์ ${similar.supplier}) ที่มีอยู่แล้ว — เป็นอันเดียวกันไหม?\n      <div class=\"row\" style=\"margin-top:8px;\">\n        <button class=\"small\" id=\"simUseExisting\">ใช้ชื่อเดิม (ไม่ต้องเพิ่มใหม่)</button>\n        <button class=\"small secondary\" id=\"simCreateNew\">สร้างใหม่แยกต่างหาก: \"${name}\" → ${supplier}</button>\n      </div>`;\n    document.getElementById(\"simUseExisting\").addEventListener(\"click\", () => {\n      warn.style.display = \"none\";\n      document.getElementById(\"newItemName\").value = \"\";\n      showToast(`ใช้ชื่อเดิม \"${similar.name}\" (${similar.supplier}) แล้ว ไม่ได้เพิ่มรายการใหม่`);\n    });\n    document.getElementById(\"simCreateNew\").addEventListener(\"click\", () => {\n      finalizeAddDictItem(name, supplier, price, category);\n    });\n    return;\n  }\n  finalizeAddDictItem(name, supplier, price, category);\n});\n\n// Mobile-only floating button (hidden on desktop via CSS) — jumps back to the top after\n// scrolling down through a long results list.\ndocument.getElementById(\"backTopBtn\").addEventListener(\"click\", () => {\n  window.scrollTo({ top: 0, behavior: \"smooth\" });\n});\n\n// ---------- Top-level Inbox / Dispatch / Menu tabs ----------\nconst MAIN_TAB_STORAGE_KEY = \"kopi_active_main_tab_v1\";\nfunction switchMainTab(name){\n  document.querySelectorAll(\".main-tab-btn\").forEach(b => b.classList.toggle(\"active\", b.getAttribute(\"data-maintab\") === name));\n  document.querySelectorAll(\".main-tab-panel\").forEach(p => p.classList.toggle(\"active\", p.getAttribute(\"data-mainpanel\") === name));\n  try { localStorage.setItem(MAIN_TAB_STORAGE_KEY, name); } catch(e){}\n}\ndocument.querySelectorAll(\".main-tab-btn\").forEach(btn => {\n  btn.addEventListener(\"click\", () => switchMainTab(btn.getAttribute(\"data-maintab\")));\n});\nlet savedMainTab = \"inbox\";\ntry { savedMainTab = localStorage.getItem(MAIN_TAB_STORAGE_KEY) || \"inbox\"; } catch(e){}\nif (!document.querySelector(`.main-tab-panel[data-mainpanel=\"${savedMainTab}\"]`)) savedMainTab = \"inbox\";\nswitchMainTab(savedMainTab);\n\n// Refresh button in the sticky header — re-pulls ฐานข้อมูลวัตถุดิบ/แมทคำ from the server on\n// demand (Cloudflare KV has no realtime push, so this is the manual equivalent).\nasync function refreshCloudData(){\n  const btn = document.getElementById(\"refreshBtn\");\n  btn.disabled = true;\n  const remote = await fetchState();\n  if (remote){\n    DICT = loadDict(remote.dict);\n    ALIAS_TABLE = loadAliasTable(remote.alias);\n    renderMenuGroups();\n    setCloudStatus(\"☁️ ข้อมูล sync แล้ว\");\n    showToast(\"รีเฟรชข้อมูลจากคลาวด์แล้ว\");\n  }\n  btn.disabled = false;\n}\ndocument.getElementById(\"refreshBtn\").addEventListener(\"click\", refreshCloudData);\n\n// ---------- Safe Daily Reset (ล้างหมด) ----------\n// Confirms with a summary first, and always backs up what's being cleared to\n// DAILY_SNAPSHOT_KEY so \"ดูข้อมูลเมื่อวาน\" can bring it back (read-only, one step).\nfunction saveDailySnapshot(){\n  try { localStorage.setItem(DAILY_SNAPSHOT_KEY, JSON.stringify({ orders: ORDERS, savedAt: Date.now() })); }\n  catch(e){ /* storage unavailable — reset still proceeds, just without a backup */ }\n}\nfunction loadDailySnapshot(){\n  try { return JSON.parse(localStorage.getItem(DAILY_SNAPSHOT_KEY) || \"null\"); }\n  catch(e){ return null; }\n}\nfunction updateYesterdayBtnVisibility(){\n  const btn = document.getElementById(\"viewYesterdayBtn\");\n  if (!btn) return;\n  const snap = loadDailySnapshot();\n  btn.style.display = (snap && Array.isArray(snap.orders) && snap.orders.length) ? \"inline-block\" : \"none\";\n}\nfunction resetModalSummaryHTML(){\n  if (!ORDERS.length) return '<p class=\"muted\">ยังไม่มีออเดอร์วันนี้ให้ล้าง</p>';\n  let totalItems = 0;\n  const supplierSet = new Set();\n  ORDERS.forEach(o => o.items.forEach(i => { totalItems++; if (i.supplier) supplierSet.add(i.supplier); }));\n  return `<p>ทั้งหมด <b>${ORDERS.length}</b> ออเดอร์ (<b>${totalItems}</b> รายการ) จาก <b>${supplierSet.size}</b> ซัพพลายเออร์</p>`;\n}\nfunction openResetModal(){\n  document.getElementById(\"resetModalSummary\").innerHTML = resetModalSummaryHTML();\n  document.getElementById(\"resetModalOverlay\").style.display = \"flex\";\n}\nfunction closeResetModal(){\n  document.getElementById(\"resetModalOverlay\").style.display = \"none\";\n}\ndocument.getElementById(\"dailyResetBtn\").addEventListener(\"click\", openResetModal);\ndocument.getElementById(\"resetModalCancel\").addEventListener(\"click\", closeResetModal);\ndocument.getElementById(\"resetModalOverlay\").addEventListener(\"click\", (e) => {\n  if (e.target.id === \"resetModalOverlay\") closeResetModal();\n});\ndocument.getElementById(\"resetModalConfirm\").addEventListener(\"click\", () => {\n  if (ORDERS.length) saveDailySnapshot();\n  ORDERS = [];\n  saveOrders();\n  renderOrders();\n  renderDispatch();\n  updateYesterdayBtnVisibility();\n  closeResetModal();\n  showToast('ล้างหมดแล้ว — กด \"ดูข้อมูลเมื่อวาน\" เพื่อย้อนดูได้');\n});\ndocument.getElementById(\"viewYesterdayBtn\").addEventListener(\"click\", () => {\n  const snap = loadDailySnapshot();\n  if (!snap || !Array.isArray(snap.orders) || !snap.orders.length){ showToast(\"ยังไม่มีข้อมูลย้อนหลัง\"); return; }\n  const lines = snap.orders.map(o => {\n    const items = o.items.map(i => `&nbsp;&nbsp;- ${escapeAttr(i.label)}${i.qty!==\"?\" ? \" \" + i.qty : \"\"}${i.unit?\" \"+escapeAttr(i.unit):\"\"}${i.supplier ? \" (\" + escapeAttr(i.supplier) + \")\" : \" (ยังไม่แมท)\"}`).join(\"<br>\");\n    return `<p style=\"margin:8px 0 2px;\"><b>${escapeAttr(o.orderer || o.department || \"ออเดอร์\")}</b> <span class=\"muted\">${escapeAttr(o.department||\"\")}</span></p><p style=\"margin:0; font-size:12.5px;\">${items}</p>`;\n  }).join(\"\");\n  document.getElementById(\"resetModalSummary\").innerHTML = `<div style=\"max-height:50vh; overflow-y:auto;\">${lines}</div>`;\n  document.querySelector(\"#resetModalOverlay .modal-box h3\").textContent = \"ข้อมูลก่อนล้างครั้งล่าสุด\";\n  document.getElementById(\"resetModalConfirm\").style.display = \"none\";\n  document.getElementById(\"resetModalCancel\").textContent = \"ปิด\";\n  document.getElementById(\"resetModalOverlay\").style.display = \"flex\";\n  document.getElementById(\"resetModalCancel\").addEventListener(\"click\", function restoreModal(){\n    document.querySelector(\"#resetModalOverlay .modal-box h3\").textContent = \"ยืนยันการล้างข้อมูลรายวัน\";\n    document.getElementById(\"resetModalConfirm\").style.display = \"inline-block\";\n    document.getElementById(\"resetModalCancel\").textContent = \"ยกเลิก\";\n    document.getElementById(\"resetModalCancel\").removeEventListener(\"click\", restoreModal);\n  }, { once: true });\n});\n\n// Cloud version init: fetch the shared ฐานข้อมูลวัตถุดิบ/แมทคำ from the server, load today's\n// orders from localStorage (Ephemeral/Persistent-state: refresh must never lose in-progress\n// work), then render everything.\n(async function initCloudData(){\n  document.getElementById(\"processBtn\").disabled = true;\n  const remote = await fetchState();\n  DICT = loadDict(remote && remote.dict);\n  ALIAS_TABLE = loadAliasTable(remote && remote.alias);\n  if (remote){\n    if (!remote.dict || !Array.isArray(remote.dict) || remote.dict.length === 0 || DICT_NEEDS_CATEGORY_PUSH) postState({ dict: DICT });\n    if (!remote.alias || !Array.isArray(remote.alias) || remote.alias.length === 0) postState({ alias: ALIAS_TABLE });\n  }\n\n  renderMenuGroups();\n  updateYesterdayBtnVisibility();\n\n  ORDERS = loadOrders();\n  renderOrders();\n  renderDispatch();\n  updateProcessBtnCount();\n\n  document.getElementById(\"processBtn\").disabled = false;\n  if (remote) setCloudStatus(\"☁️ ข้อมูล sync แล้ว\");\n})();\n\n</script>\n</body>\n</html>\n";

const LIFF_PAGE = "<!DOCTYPE html>\n<html lang=\"th\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n<title>แก้ไขจำนวน — Smart Order Splitter</title>\n<script src=\"https://static.line-scdn.net/liff/edge/2/sdk.js\"></script>\n<style>\n  :root{ --green:#16a34a; --border:#e5e7eb; --bg:#f8fafc; }\n  *{ box-sizing:border-box; }\n  body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif; background:var(--bg); color:#1f2937; }\n  .wrap{ max-width:480px; margin:0 auto; min-height:100vh; background:#fff; display:flex; flex-direction:column; }\n  .head{ padding:16px; border-bottom:1px solid var(--border); position:sticky; top:0; background:#fff; z-index:5; }\n  .head h1{ font-size:17px; margin:0 0 2px; }\n  .head .sub{ font-size:13px; color:#6b7280; }\n  .body{ flex:1; padding:12px 16px; }\n  .item-row{ display:flex; align-items:center; gap:8px; padding:10px 0; border-bottom:1px solid #f1f5f9; }\n  .item-row .name{ flex:1; font-size:14px; }\n  .item-row input{ width:64px; padding:8px; border:1px solid var(--border); border-radius:8px; text-align:center; font-size:14px; }\n  .item-row .unit{ font-size:13px; color:#6b7280; width:44px; }\n  .footer{ padding:14px 16px; border-top:1px solid var(--border); position:sticky; bottom:0; background:#fff; }\n  .btn{ width:100%; padding:14px; border:none; border-radius:12px; background:var(--green); color:#fff; font-size:15px; font-weight:700; }\n  .btn:disabled{ background:#9ca3af; }\n  .msg{ text-align:center; padding:40px 16px; color:#6b7280; font-size:14px; }\n  .empty{ text-align:center; padding:40px 16px; color:#9ca3af; font-size:14px; }\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <div class=\"head\">\n    <h1 id=\"titleEl\">แก้ไขจำนวน</h1>\n    <div class=\"sub\" id=\"subEl\">กำลังโหลด...</div>\n  </div>\n  <div class=\"body\" id=\"bodyEl\"></div>\n  <div class=\"footer\">\n    <button class=\"btn\" id=\"confirmBtn\" disabled>ยืนยันจำนวน</button>\n  </div>\n</div>\n<script>\nconst LIFF_ID = \"__LIFF_ID__\";\nconst params = new URLSearchParams(location.search);\nconst pendingId = params.get(\"id\") || \"\";\nconst supplierName = params.get(\"supplier\") || \"\";\nlet currentItems = [];\n\nfunction qs(sel){ return document.querySelector(sel); }\n\nfunction renderItems(items){\n  currentItems = items;\n  const bodyEl = qs(\"#bodyEl\");\n  if (!items.length){ bodyEl.innerHTML = '<div class=\"empty\">ไม่พบรายการ (อาจถูกส่งหรือลบไปแล้ว)</div>'; return; }\n  bodyEl.innerHTML = \"\";\n  items.forEach((it, idx) => {\n    const row = document.createElement(\"div\");\n    row.className = \"item-row\";\n    row.innerHTML =\n      '<span class=\"name\">' + escapeHtml(it.label) + '</span>' +\n      '<input type=\"text\" inputmode=\"decimal\" value=\"' + escapeHtml(it.qty || \"\") + '\" data-idx=\"' + idx + '\">' +\n      '<span class=\"unit\">' + escapeHtml(it.unit || \"\") + '</span>';\n    bodyEl.appendChild(row);\n  });\n  qs(\"#confirmBtn\").disabled = false;\n}\nfunction escapeHtml(s){ return (s||\"\").toString().replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/\"/g,\"&quot;\"); }\n\nasync function loadPending(){\n  try {\n    const r = await fetch(\"/api/pending-order?id=\" + encodeURIComponent(pendingId) + \"&supplier=\" + encodeURIComponent(supplierName));\n    if (!r.ok) throw new Error(\"not found\");\n    const data = await r.json();\n    qs(\"#titleEl\").textContent = \"แก้ไขจำนวน — \" + (data.supplier || supplierName);\n    qs(\"#subEl\").textContent = (data.department ? data.department + \" · \" : \"\") + (data.items || []).length + \" รายการ\";\n    renderItems(data.items || []);\n  } catch(e){\n    qs(\"#subEl\").textContent = \"โหลดข้อมูลไม่สำเร็จ\";\n    qs(\"#bodyEl\").innerHTML = '<div class=\"empty\">ไม่พบออเดอร์นี้ ลิงก์อาจหมดอายุ</div>';\n  }\n}\n\nasync function confirmEdits(){\n  const btn = qs(\"#confirmBtn\");\n  btn.disabled = true; btn.textContent = \"กำลังบันทึก...\";\n  const inputs = document.querySelectorAll(\".item-row input\");\n  inputs.forEach(inp => { currentItems[+inp.dataset.idx].qty = inp.value; });\n  try {\n    const r = await fetch(\"/api/pending-order\", {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ id: pendingId, supplier: supplierName, items: currentItems })\n    });\n    const data = await r.json();\n    let sentToChat = false;\n    try {\n      if (window.liff && liff.isInClient && liff.isInClient()){\n        const summary = formatSummary(data.supplier || supplierName, currentItems);\n        await liff.sendMessages([{ type: \"text\", text: summary }]);\n        sentToChat = true;\n      }\n    } catch(e){ /* sendMessages unavailable outside a chat context — fall back to on-page confirmation */ }\n    qs(\"#bodyEl\").innerHTML = '<div class=\"msg\">✅ บันทึกจำนวนแล้ว' + (sentToChat ? \" และส่งสรุปกลับเข้าแชทแล้ว\" : \"\") + '</div>';\n    qs(\".footer\").style.display = \"none\";\n    setTimeout(() => { try { if (window.liff && liff.closeWindow) liff.closeWindow(); } catch(e){} }, sentToChat ? 800 : 0);\n  } catch(e){\n    btn.disabled = false; btn.textContent = \"ยืนยันจำนวน\";\n    alert(\"บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง\");\n  }\n}\nfunction formatSummary(supplier, items){\n  const date = new Date().toLocaleDateString(\"th-TH\", { year: \"numeric\", month: \"long\", day: \"numeric\" });\n  let text = \"รายการสั่งของวันที่ \" + date + \"\\n- ซัพพลายเออร์ \" + supplier + \":\\n\";\n  items.forEach(it => { text += \"  • \" + it.label + \" \" + (it.qty || \"?\") + \" \" + (it.unit || \"\") + \"\\n\"; });\n  return text.trim();\n}\n\nqs(\"#confirmBtn\").addEventListener(\"click\", confirmEdits);\n\n(async function init(){\n  try {\n    if (LIFF_ID){ await liff.init({ liffId: LIFF_ID }); }\n  } catch(e){ /* running outside LINE / no LIFF_ID configured yet — page still works standalone */ }\n  loadPending();\n})();\n</script>\n</body>\n</html>\n";

// Added after the original LIFF page so the embedded one-file Worker remains
// easy to paste into Cloudflare. It replaces the quantity-only UI with direct
// typing and per-line cancellation, while retaining the existing chat-based
// move-to-supplier flow.
const LIFF_ENHANCEMENTS = String.raw`<script>
(() => {
  const style = document.createElement("style");
  style.textContent = ".item-row{flex-wrap:wrap}.item-row .supplier-select,.item-row .unit-select{padding:7px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;font-size:13px}.item-row .supplier-select{width:100%}.item-row .unit-select{min-width:72px;max-width:112px}.item-row .remove-item{border:1px solid #fecaca;background:#fff;color:#dc2626;border-radius:8px;width:32px;height:32px;font-size:20px;line-height:1;cursor:pointer}";
  document.head.appendChild(style);
  const qs = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => (value || "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let token = "";
  let items = [];
  let suppliers = [];
  const standardUnits = ["", "ขีด", "โล", "กก.", "กิโลกรัม", "กรัม", "หัว", "ชิ้น", "ถุง", "ห่อ", "กล่อง", "ขวด", "แพ็ค", "แผง", "ใบ", "มัด", "ลัง", "ฟอง", "ลิตร", "มล."];
  let addedUnits = [];
  const unmatchedMode = new URLSearchParams(location.search).get("unmatched") === "1";
  const authHeaders = (extra) => Object.assign({ "X-LIFF-ID-TOKEN": token }, extra || {});

  // Rendering the rows recreates their inputs.  Keep every value currently typed
  // in the DOM before removing one row, otherwise an unrelated quantity reverts
  // to the value that was originally loaded from the server.
  function captureEditsFromForm() {
    document.querySelectorAll(".item-row input").forEach((input) => {
      const index = Number(input.dataset.idx);
      if (items[index]) items[index].qty = input.value.trim();
    });
    document.querySelectorAll(".supplier-select").forEach((select) => {
      const index = Number(select.dataset.supplierIdx);
      if (items[index]) items[index].supplier = select.value;
    });
    document.querySelectorAll(".unit-select").forEach((select) => {
      const index = Number(select.dataset.unitIdx);
      if (items[index] && select.value !== "__custom_unit__") items[index].unit = select.value;
    });
  }

  function unitOptions(selectedUnit) {
    const units = Array.from(new Set(standardUnits.concat(addedUnits, items.map((item) => item.unit || ""))));
    return units.map((unit) => '<option value="' + escapeHtml(unit) + '"' + (unit === (selectedUnit || "") ? " selected" : "") + '>' + escapeHtml(unit || "— ไม่ระบุหน่วย —") + '</option>').join("") + '<option value="__custom_unit__">＋ เพิ่มหน่วย…</option>';
  }

  function render() {
    const body = qs("#bodyEl");
    body.innerHTML = "";
    if (!items.length) {
      body.innerHTML = '<div class="empty">ไม่มีรายการเหลือแล้ว กดบันทึกเพื่อยืนยันการลบ</div>';
      qs("#confirmBtn").disabled = false;
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "item-row";
      const supplierOptions = (unmatchedMode ? '<option value="">เลือกซัพพลายเออร์</option>' : '') + suppliers.map((name) => '<option value="' + escapeHtml(name) + '"' + (name === item.supplier ? ' selected' : '') + '>' + escapeHtml(name) + '</option>').join("");
      row.innerHTML = '<span class="name">' + escapeHtml(item.label) + '</span><input type="text" inputmode="decimal" aria-label="จำนวน ' + escapeHtml(item.label) + '" value="' + escapeHtml(item.qty) + '" data-idx="' + index + '"><select class="unit-select" aria-label="หน่วยของ ' + escapeHtml(item.label) + '" data-unit-idx="' + index + '">' + unitOptions(item.unit) + '</select><button type="button" class="remove-item" data-remove="' + index + '" aria-label="ยกเลิกรายการ ' + escapeHtml(item.label) + '">×</button><select class="supplier-select" aria-label="ย้าย ' + escapeHtml(item.label) + ' ไปยังซัพพลายเออร์" data-supplier-idx="' + index + '">' + supplierOptions + '</select>';
      body.appendChild(row);
    });
    body.querySelectorAll(".unit-select").forEach((select) => {
      select.addEventListener("change", () => {
        const index = Number(select.dataset.unitIdx);
        if (select.value !== "__custom_unit__") {
          if (items[index]) items[index].unit = select.value;
          return;
        }
        captureEditsFromForm();
        const unit = (window.prompt("เพิ่มหน่วยใหม่ เช่น กระสอบ, ลัง, แท่ง") || "").trim();
        if (unit) {
          if (!addedUnits.includes(unit)) addedUnits.push(unit);
          if (items[index]) items[index].unit = unit;
          render();
        } else if (items[index]) {
          select.value = items[index].unit || "";
        }
      });
    });
    body.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.remove);
        captureEditsFromForm();
        if (items[index] && window.confirm("ยกเลิกรายการ " + items[index].label + " ใช่ไหม?")) {
          items.splice(index, 1);
          render();
        }
      });
    });
    qs("#confirmBtn").disabled = false;
  }

  async function load() {
    const response = await fetch("/api/pending-order?id=" + encodeURIComponent(pendingId) + "&supplier=" + encodeURIComponent(supplierName) + (unmatchedMode ? "&unmatched=1" : ""), { headers: authHeaders() });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    suppliers = Array.from(new Set([data.supplier].concat(data.suppliers || []).filter(Boolean)));
    items = (data.items || []).map((item) => Object.assign({}, item, { supplier: unmatchedMode ? "" : (data.supplier || supplierName) }));
    qs("#titleEl").textContent = unmatchedMode ? "จัดกลุ่มรายการที่ยังไม่แมท" : "แก้ไขออเดอร์ — " + (data.supplier || supplierName);
    qs("#subEl").textContent = unmatchedMode ? items.length + " รายการ · เลือกซัพ จำนวน หน่วย หรือลบ" : items.length + " รายการ · ปรับจำนวน/หน่วย ย้ายซัพ หรือกด × เพื่อลบ";
    render();
  }

  async function save() {
    captureEditsFromForm();
    if (unmatchedMode && items.some((item) => !item.supplier)) {
      window.alert("กรุณาเลือกซัพพลายเออร์ให้ทุกรายการ หรือกด × เพื่อลบรายการที่ไม่ต้องการ");
      return;
    }
    const button = qs("#confirmBtn");
    button.disabled = true;
    button.textContent = "กำลังบันทึก...";
    try {
      const response = await fetch("/api/pending-order", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: pendingId, supplier: supplierName, unmatched: unmatchedMode, items: items.map((item) => ({ id: item.id, qty: item.qty, unit: item.unit, supplier: item.supplier })) })
      });
      if (!response.ok) throw new Error(await response.text());
      qs("#bodyEl").innerHTML = '<div class="msg">✅ บันทึกแล้ว ' + (unmatchedMode ? 'กลับไปกด “สรุปใหม่” ในแชท แล้วกด “ส่งเลย” ได้ทันที' : 'กลับไปกด “ส่งเลย” ในแชทได้ทันที') + '</div>';
      qs(".footer").style.display = "none";
      setTimeout(() => { try { liff.closeWindow(); } catch (error) {} }, 700);
    } catch (error) {
      button.disabled = false;
      button.textContent = "บันทึกการแก้ไข";
      window.alert("บันทึกไม่สำเร็จ: " + error.message);
    }
  }

  (async () => {
    try {
      if (!LIFF_ID) throw new Error("LIFF_ID ยังไม่ได้ตั้งค่า");
      await liff.ready;
      token = liff.getIDToken() || "";
      if (!token) throw new Error("ต้องเปิด scope: openid");
      const originalButton = qs("#confirmBtn");
      const replacement = originalButton.cloneNode(true);
      originalButton.replaceWith(replacement);
      replacement.addEventListener("click", save);
      await load();
    } catch (error) {
      qs("#subEl").textContent = "เปิดหน้าแก้ไขไม่ได้";
      qs("#bodyEl").innerHTML = '<div class="empty">' + escapeHtml(error.message || "กรุณาเปิดจากปุ่มใน LINE") + '</div>';
    }
  })();
})();
</script>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      if (request.method === "GET") {
        const raw = (await env.KOPI_KV.get(STATE_KEY, { type: "json" })) || {};
        return Response.json(raw);
      }
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response("Bad JSON", { status: 400 });
        }
        const current = (await env.KOPI_KV.get(STATE_KEY, { type: "json" })) || {};
        const merged = Object.assign({}, current, body);
        await env.KOPI_KV.put(STATE_KEY, JSON.stringify(merged));
        return Response.json(merged);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // ---------------- LINE Bot webhook ----------------
    if (url.pathname === "/webhook/line") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const rawBody = await request.text();
      const signature = request.headers.get("x-line-signature");
      const validSig = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
      if (!validSig) return new Response("Invalid signature", { status: 401 });

      let payload;
      try { payload = JSON.parse(rawBody); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
      const events = payload.events || [];
      const state = (await env.KOPI_KV.get(STATE_KEY, { type: "json" })) || {};
      const dict = Array.isArray(state.dict) ? state.dict : [];
      const aliasTable = Array.isArray(state.alias) ? state.alias : [];
      // LIFF_BASE_URL, if supplied, must be a LIFF launch URL
      // (https://liff.line.me/<liff-id>), not the Worker endpoint URL.
      const liffBaseUrl = env.LIFF_ID
        ? (env.LIFF_BASE_URL || ("https://liff.line.me/" + env.LIFF_ID))
        : "";

      for (const event of events) {
        try {
          if (event.type === "message" && event.message && event.message.type === "text") {
            const senderId = (event.source || {}).userId || null;
            // เก็บ log userId ของคนพิมพ์ไว้เสมอ — ใช้หาค่า OWNER_LINE_USER_ID ตอนตั้งค่าครั้งแรก
            // (เช็คได้จาก Cloudflare Observability logs หลังพี่ทักบอทเอง 1 ครั้ง)
            console.log("[incoming line message]", "userId=", senderId, "text=", event.message.text);

            // LINE can insert zero-width characters when text is copied. Normalize
            // the pairing command so it is never mistaken for a purchase order.
            const setupText = event.message.text
              .normalize("NFKC")
              .replace(/[\u200B-\u200D\uFEFF]/g, "")
              .trim();
            const setupMatch = setupText.match(/^#\s*(ตั้งแอดมิน|สลับแอดมิน)\s+(.+?)\s*$/);
            const pairedAdminId = await env.KOPI_KV.get(ACTIVE_ADMIN_KEY);
            if (setupMatch) {
              const forceSwitch = setupMatch[1] === "สลับแอดมิน";
              const providedCode = setupMatch[2].normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
              const expectedCode = String(env.ADMIN_SETUP_CODE || "").normalize("NFKC").trim();
              let setupReplyText;
              if (!senderId) {
                setupReplyText = "ตั้งค่าแอดมินได้เฉพาะในแชตส่วนตัวกับบอตครับ";
              } else if (!expectedCode) {
                setupReplyText = "ระบบยังไม่ได้ตั้งรหัสจับคู่แอดมินครับ";
              } else if (providedCode !== expectedCode) {
                setupReplyText = "รหัสจับคู่ไม่ถูกต้อง กรุณาคัดลอกคำสั่งจากแอดมินระบบอีกครั้งครับ";
              } else if (pairedAdminId && !forceSwitch) {
                setupReplyText = "ระบบมีแอดมินที่จับคู่แล้ว หากต้องการย้ายเครื่องให้ใช้คำสั่ง #สลับแอดมิน ตามด้วยรหัสครับ";
              } else {
                await env.KOPI_KV.put(ACTIVE_ADMIN_KEY, senderId);
                setupReplyText = forceSwitch
                  ? "สลับเครื่องแอดมินแล้ว ✅ รายการใหม่จะถูกส่งมาที่แชตนี้"
                  : "ตั้งค่าเครื่องนี้เป็นแอดมินแล้ว ✅ รายการใหม่จะถูกส่งมาที่แชตนี้";
              }
              const pairedReply = await lineReply(
                event.replyToken,
                [{ type: "text", text: setupReplyText }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!pairedReply.ok) console.error("[line admin pairing reply failed]", pairedReply.status, await pairedReply.text());
              continue;
            }

            const activeAdminId = await getActiveAdminId(env);

            if (!activeAdminId) {
              const configReply = await lineReply(
                event.replyToken,
                [{ type: "text", text: "ระบบยังไม่ได้ตั้งค่าแอดมิน จึงยังรับออเดอร์ไม่ได้" }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!configReply.ok) console.error("[line admin-config reply failed]", configReply.status, await configReply.text());
              continue;
            }

            const { bySupplier, supplierOrder, unmatched } = lnParseMessageIntoSupplierGroups(event.message.text, dict, aliasTable);
            const metadata = { userId: senderId, submittedByAdmin: isAdminLineUser(env, senderId, activeAdminId) };
            const draftBubbles = [];
            for (const supplierName of supplierOrder) {
              const draft = await upsertSupplierDraft(env.KOPI_KV, activeAdminId, supplierName, bySupplier[supplierName], metadata);
              draftBubbles.push(buildSupplierBubble(supplierName, draft.record.bySupplier[supplierName], draft.pendingId, liffBaseUrl));
            }
            if (unmatched.length) {
              const unmatchedDraft = await upsertUnmatchedDraft(env.KOPI_KV, activeAdminId, unmatched, metadata);
              draftBubbles.push(buildUnmatchedBubble(unmatchedDraft.record.unmatched, unmatchedDraft.pendingId, liffBaseUrl));
            }
            const flexMessage = buildAdminDraftFlexMessage(draftBubbles);

            // Every order card goes only to the admin's 1:1 chat with the bot.
            // Staff (and people in a shared group) receive an acknowledgement only,
            // so they cannot see or operate supplier-send/edit controls.
            const senderIsAdmin = isAdminLineUser(env, senderId, activeAdminId);
            const sourceText = senderIsAdmin
              ? "📩 รายการใหม่จากแอดมิน"
              : "📩 รายการใหม่จากพนักงาน — รอตรวจสอบก่อนส่งซัพพลายเออร์";
            // Reply and push concurrently. This makes the staff confirmation visible
            // immediately even when a Flex card takes longer to reach the admin.
            const [ackRes, pushRes] = await Promise.all([
              lineReply(
                event.replyToken,
                [{ type: "text", text: "รับรายการแล้วครับ ✅ กำลังส่งให้แอดมินตรวจสอบ" }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              ),
              linePush(
                activeAdminId,
                [{ type: "text", text: sourceText }, flexMessage],
                env.LINE_CHANNEL_ACCESS_TOKEN
              )
            ]);
            console.log("[line order routing]", "fromAdmin=", senderIsAdmin, "pushStatus=", pushRes.status, "ackStatus=", ackRes.status);
            if (!pushRes.ok) {
              console.error("[line push to admin failed]", pushRes.status, await pushRes.text());
            }
            if (!ackRes.ok) {
              console.error("[line order acknowledgement failed]", ackRes.status, await ackRes.text());
            }

          } else if (event.type === "postback") {
            const data = event.postback && event.postback.data || "";

            // Cards are normally delivered only to the owner. Keep that rule if a
            // postback payload is copied into another chat.
            const postbackUserId = (event.source || {}).userId;
            const activeAdminId = await getActiveAdminId(env);
            if (!isAdminLineUser(env, postbackUserId, activeAdminId)) {
              const denied = await lineReply(
                event.replyToken,
                [{ type: "text", text: "รายการนี้แก้ไขได้โดยแอดมินเท่านั้นครับ" }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!denied.ok) console.error("[line unauthorized postback reply failed]", denied.status, await denied.text());
              continue;
            }

            if (data.startsWith("send:")) {
              const rest = data.slice("send:".length);
              const sepIdx = rest.indexOf(":");
              const pendingId = rest.slice(0, sepIdx);
              const supplierName = decodeURIComponent(rest.slice(sepIdx + 1));
              const record = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              if (record && record.sentSuppliers && record.sentSuppliers[supplierName]) {
                const alreadySent = await lineReply(event.replyToken, [{ type: "text", text: "หมวด " + supplierName + " ถูกส่งไปแล้วครับ รายการใหม่จะขึ้นเป็นการ์ดใหม่" }], env.LINE_CHANNEL_ACCESS_TOKEN);
                if (!alreadySent.ok) console.error("[line already-sent reply failed]", alreadySent.status, await alreadySent.text());
                continue;
              }
              const items = record && record.bySupplier ? (record.bySupplier[supplierName] || []) : [];
              const text = items.length
                ? formatSupplierPlainText(supplierName, items)
                : "ไม่พบรายการสำหรับ " + supplierName + " (อาจหมดอายุหรือถูกแก้ไขไปแล้ว)";
              const pbRes = await lineReply(event.replyToken, [{ type: "text", text }], env.LINE_CHANNEL_ACCESS_TOKEN);
              if (!pbRes.ok) {
                console.error("[line postback reply failed]", pbRes.status, await pbRes.text());
              } else if (record && items.length) {
                record.sentSuppliers = Object.assign({}, record.sentSuppliers, { [supplierName]: Date.now() });
                await env.KOPI_KV.put("line_pending:" + pendingId, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
                const key = draftKey(activeAdminId, supplierName);
                if (await env.KOPI_KV.get(key) === pendingId) await env.KOPI_KV.delete(key);
              }

            } else if (data.startsWith("editsup:")) {
              // เปิดการ์ดแก้ไขจำนวน/ย้ายซัพของซัพพลายเออร์นี้ (ในแชทเลย ไม่ต้องเปิดหน้าเว็บ)
              const rest = data.slice("editsup:".length);
              const sepIdx = rest.indexOf(":");
              const pendingId = rest.slice(0, sepIdx);
              const supplierName = decodeURIComponent(rest.slice(sepIdx + 1));
              const record = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              const items = record && record.bySupplier ? (record.bySupplier[supplierName] || []) : [];
              const editBubble = buildEditItemsBubble(supplierName, items, pendingId);
              const res = await lineReply(
                event.replyToken,
                [{ type: "flex", altText: "แก้ไขรายการ " + supplierName, contents: editBubble }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!res.ok) console.error("[line editsup reply failed]", res.status, await res.text());

            } else if (data.startsWith("qty:")) {
              // ปรับจำนวนสินค้าทีละ 1 หน่วย (+1 / -1) แล้วส่งการ์ดแก้ไขเวอร์ชันล่าสุดกลับไป
              const parts = data.slice("qty:".length).split(":");
              const pendingId = parts[0];
              const supplierName = decodeURIComponent(parts[1]);
              const itemIdx = parseInt(parts[2], 10);
              const delta = parseFloat(parts[3]);
              const record = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              if (record && record.bySupplier && record.bySupplier[supplierName] && record.bySupplier[supplierName][itemIdx]) {
                const item = record.bySupplier[supplierName][itemIdx];
                const current = parseFloat(item.qty) || 0;
                const next = Math.max(0, current + delta);
                item.qty = (Number.isInteger(next) ? next : Math.round(next * 100) / 100).toString();
                await env.KOPI_KV.put("line_pending:" + pendingId, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
              }
              const items = record && record.bySupplier ? (record.bySupplier[supplierName] || []) : [];
              const editBubble = buildEditItemsBubble(supplierName, items, pendingId);
              const res = await lineReply(
                event.replyToken,
                [{ type: "flex", altText: "แก้ไขรายการ " + supplierName, contents: editBubble }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!res.ok) console.error("[line qty reply failed]", res.status, await res.text());

            } else if (data.startsWith("movesup:")) {
              // ถามว่าจะย้ายรายการนี้ไปซัพพลายเออร์ไหน (แสดงเป็นปุ่ม quick reply)
              const parts = data.slice("movesup:".length).split(":");
              const pendingId = parts[0];
              const supplierName = decodeURIComponent(parts[1]);
              const itemIdx = parts[2];
              const knownSuppliers = getKnownSuppliers(dict).filter(s => s !== supplierName).slice(0, 12);
              const quickItems = knownSuppliers.map(s => ({
                type: "action",
                action: {
                  type: "postback",
                  label: s.slice(0, 20),
                  data: "moveto:" + pendingId + ":" + encodeURIComponent(supplierName) + ":" + itemIdx + ":" + encodeURIComponent(s),
                  displayText: "ย้ายไป " + s
                }
              }));
              const res = await lineReply(
                event.replyToken,
                [{ type: "text", text: "ย้ายรายการนี้ไปซัพพลายเออร์ไหนครับ?", quickReply: { items: quickItems } }],
                env.LINE_CHANNEL_ACCESS_TOKEN
              );
              if (!res.ok) console.error("[line movesup reply failed]", res.status, await res.text());

            } else if (data.startsWith("moveto:")) {
              // ย้ายรายการจากซัพพลายเออร์เดิมไปซัพพลายเออร์ใหม่ แล้วแสดงหน้าสรุปที่อัปเดตแล้ว
              const parts = data.slice("moveto:".length).split(":");
              const pendingId = parts[0];
              const srcSupplier = decodeURIComponent(parts[1]);
              const itemIdx = parseInt(parts[2], 10);
              const destSupplier = decodeURIComponent(parts[3]);
              const record = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              if (record && record.bySupplier && record.bySupplier[srcSupplier] && record.bySupplier[srcSupplier][itemIdx]) {
                const moved = record.bySupplier[srcSupplier].splice(itemIdx, 1)[0];
                if (!record.bySupplier[destSupplier]) record.bySupplier[destSupplier] = [];
                record.bySupplier[destSupplier].push(moved);
                if (!Array.isArray(record.supplierOrder)) record.supplierOrder = Object.keys(record.bySupplier);
                if (!record.supplierOrder.includes(destSupplier)) record.supplierOrder.push(destSupplier);
                await env.KOPI_KV.put("line_pending:" + pendingId, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
              }
              const updated = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              const flexMessage = updated
                ? buildOrderFlexMessage(updated.bySupplier, updated.supplierOrder || Object.keys(updated.bySupplier), updated.unmatched || [], pendingId, liffBaseUrl)
                : { type: "text", text: "ไม่พบออเดอร์นี้แล้ว (อาจหมดอายุ)" };
              const res = await lineReply(event.replyToken, [flexMessage], env.LINE_CHANNEL_ACCESS_TOKEN);
              if (!res.ok) console.error("[line moveto reply failed]", res.status, await res.text());

            } else if (data.startsWith("back:")) {
              // กลับไปหน้าสรุปออเดอร์ทั้งหมด (การ์ดรวมทุกซัพพลายเออร์)
              const pendingId = data.slice("back:".length);
              const record = await env.KOPI_KV.get("line_pending:" + pendingId, { type: "json" });
              const flexMessage = record
                ? buildOrderFlexMessage(record.bySupplier, record.supplierOrder || Object.keys(record.bySupplier), record.unmatched || [], pendingId, liffBaseUrl)
                : { type: "text", text: "ไม่พบออเดอร์นี้แล้ว (อาจหมดอายุ)" };
              const res = await lineReply(event.replyToken, [flexMessage], env.LINE_CHANNEL_ACCESS_TOKEN);
              if (!res.ok) console.error("[line back reply failed]", res.status, await res.text());
            }
          }
        } catch (e) {
          // One bad event shouldn't 500 the whole webhook batch — LINE retries on non-200.
          console.error("[webhook event error]", (e && e.stack) || e);
        }
      }
      return new Response("OK", { status: 200 });
    }

    // ---------------- LIFF edit-quantity page ----------------
    if (url.pathname === "/liff" || url.pathname === "/liff.html") {
      const page = LIFF_PAGE.replace("__LIFF_ID__", env.LIFF_ID || "").replace("</body>", LIFF_ENHANCEMENTS + "</body>");
      return new Response(page, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    // ---------------- Pending order read/update (used by the LIFF page) ----------------
    if (url.pathname === "/api/pending-order") {
      const owner = await getVerifiedLiffOwnerId(request, env);
      if (owner.error) return owner.error;

      if (request.method === "GET") {
        const id = url.searchParams.get("id") || "";
        const supplier = url.searchParams.get("supplier") || "";
        const unmatchedMode = url.searchParams.get("unmatched") === "1";
        const record = await env.KOPI_KV.get("line_pending:" + id, { type: "json" });
        if (!record || !record.bySupplier) return new Response("Not found", { status: 404 });
        const state = (await env.KOPI_KV.get(STATE_KEY, { type: "json" })) || {};
        const suppliers = getKnownSuppliers(Array.isArray(state.dict) ? state.dict : []);
        if (unmatchedMode) {
          const items = ensureUnmatchedItemIds(record);
          await env.KOPI_KV.put("line_pending:" + id, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
          return Response.json({ suppliers, items });
        }
        return Response.json({ supplier, suppliers, items: record.bySupplier[supplier] || [] });
      }
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
        const { id, supplier, items, unmatched: unmatchedMode } = body || {};
        if (!id || !Array.isArray(items) || (!unmatchedMode && !supplier)) return new Response("Bad request", { status: 400 });
        const record = await env.KOPI_KV.get("line_pending:" + id, { type: "json" });
        if (!record || !record.bySupplier || (!unmatchedMode && !Array.isArray(record.bySupplier[supplier]))) {
          return new Response("Not found", { status: 404 });
        }

        const state = (await env.KOPI_KV.get(STATE_KEY, { type: "json" })) || {};
        const allowedSuppliers = new Set(getKnownSuppliers(Array.isArray(state.dict) ? state.dict : []));
        if (unmatchedMode) {
          const existingById = new Map(ensureUnmatchedItemIds(record).map((item) => [item.id, item]));
          const seenIds = new Set();
          const addedSuppliers = [];
          for (const patch of items) {
            if (!patch || typeof patch.id !== "string" || seenIds.has(patch.id)) return new Response("Bad request", { status: 400 });
            const existing = existingById.get(patch.id);
            const qty = normalizeEditedQuantity(patch.qty);
            const unit = normalizeEditedUnit(patch.unit, existing && existing.unit);
            const targetSupplier = typeof patch.supplier === "string" ? patch.supplier : "";
            if (!existing || qty === null || unit === null || !allowedSuppliers.has(targetSupplier)) return new Response("Invalid item, quantity, unit, or supplier", { status: 400 });
            seenIds.add(patch.id);
            if (qty !== "0") {
              if (!record.bySupplier[targetSupplier]) record.bySupplier[targetSupplier] = [];
              record.bySupplier[targetSupplier].push({ id: existing.id, label: existing.label, qty, unit, department: existing.department || null });
              if (!addedSuppliers.includes(targetSupplier)) addedSuppliers.push(targetSupplier);
            }
          }
          record.unmatched = [];
          if (!Array.isArray(record.supplierOrder)) record.supplierOrder = Object.keys(record.bySupplier);
          addedSuppliers.forEach((name) => { if (!record.supplierOrder.includes(name)) record.supplierOrder.push(name); });
          await env.KOPI_KV.put("line_pending:" + id, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
          await pushLatestDraftCard(env, owner.userId, id, record, "จัดกลุ่มรายการที่ยังไม่แมทแล้ว");
          return Response.json({ suppliers: addedSuppliers, items: [] });
        }
        allowedSuppliers.add(supplier);

        // Client data may only update quantities, omit an existing line to cancel it,
        // or move it to a supplier that already exists in the ingredient database.
        // Product labels/units remain server-owned.
        const existingById = new Map(record.bySupplier[supplier].map((item) => [item.id, item]));
        const seenIds = new Set();
        const nextBySupplier = Object.assign({}, record.bySupplier, { [supplier]: [] });
        const addedSuppliers = [];
        for (const patch of items) {
          if (!patch || typeof patch.id !== "string" || seenIds.has(patch.id)) {
            return new Response("Bad request", { status: 400 });
          }
          const existing = existingById.get(patch.id);
          const qty = normalizeEditedQuantity(patch.qty);
          const unit = normalizeEditedUnit(patch.unit, existing && existing.unit);
          if (!existing || qty === null || unit === null) return new Response("Invalid item, quantity, or unit", { status: 400 });
          const targetSupplier = typeof patch.supplier === "string" && patch.supplier ? patch.supplier : supplier;
          if (!allowedSuppliers.has(targetSupplier)) return new Response("Invalid supplier", { status: 400 });
          seenIds.add(patch.id);
          if (qty !== "0") {
            if (!nextBySupplier[targetSupplier]) nextBySupplier[targetSupplier] = [];
            nextBySupplier[targetSupplier].push(Object.assign({}, existing, { qty, unit }));
            if (!addedSuppliers.includes(targetSupplier)) addedSuppliers.push(targetSupplier);
          }
        }
        Object.keys(nextBySupplier).forEach((name) => {
          if (!nextBySupplier[name].length) delete nextBySupplier[name];
        });
        record.bySupplier = nextBySupplier;
        const originalOrder = Array.isArray(record.supplierOrder) ? record.supplierOrder : Object.keys(nextBySupplier);
        record.supplierOrder = originalOrder.filter((name) => nextBySupplier[name]);
        addedSuppliers.forEach((name) => {
          if (nextBySupplier[name] && !record.supplierOrder.includes(name)) record.supplierOrder.push(name);
        });
        await env.KOPI_KV.put("line_pending:" + id, JSON.stringify(record), { expirationTtl: PENDING_TTL_SECONDS });
        await pushLatestDraftCard(env, owner.userId, id, record, "ออเดอร์ " + supplier + " ถูกแก้ไขแล้ว");
        return Response.json({ supplier, items: record.bySupplier[supplier] || [] });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    return new Response("Not found", { status: 404 });
  }
};
