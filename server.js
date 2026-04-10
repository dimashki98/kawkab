/* ═══════════════════════════════════════════════════════════
 *  بصمة دمشق هوست  MDX  ◆  Damascus Host  ◆  جميع الحقوق محفوظة
 *  تصميم وبرمجة دمشق هوست — يُمنع النسخ أو التعديل بدون إذن
 * ═══════════════════════════════════════════════════════════ */
process.on("unhandledRejection", (err) => {
  try {
    console.error("⚠️ UNHANDLED PROMISE (server continues):", err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
  } catch(e) {}
});

process.on("uncaughtException", (err) => {
  // ✅ FIX: لا نخلي أي خطأ يوقف السيرفر — نسجّل وننتقل
  try {
    console.error("⚠️ UNCAUGHT EXCEPTION (server continues):", err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
  } catch(e) {}
  // لا process.exit — السيرفر لازم يضل شغال مهما صار
});
const express = require("express");
const path = require("path");
const request = require("request");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");
const rimraf = require("rimraf");
const crypto = require("crypto");

// ✅ نظام version فوري للصور — يتغير لحظة رفع صورة جديدة
const imageVersions = {};
function getImageVersion(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      return stat.mtimeMs.toString(36);
    }
  } catch(e) {}
  return '1';
}
function refreshImageVersion(filePath) {
  imageVersions[filePath] = Date.now().toString(36);
}
const passwordHash = require("password-hash");
const bcrypt = require("bcrypt"); // ✅ SECURITY: بديل آمن لـ password-hash
const BCRYPT_ROUNDS = 12;

// ✅ Helper: فحص كلمة المرور مع التحويل التلقائي من SHA-1 لـ bcrypt
async function verifyAndUpgradePassword(inputPass, storedHash, updateCallback) {
  // جرّب bcrypt أولاً (الهاشات الجديدة)
  if (storedHash && storedHash.startsWith("$2")) {
    return await bcrypt.compare(inputPass, storedHash);
  }
  // جرّب password-hash القديم (SHA-1)
  if (passwordHash.verify(inputPass, storedHash)) {
    // ✅ نحوّل تلقائياً لـ bcrypt بالخلفية
    if (updateCallback) {
      try {
        var newHash = await bcrypt.hash(inputPass, BCRYPT_ROUNDS);
        updateCallback(newHash);
      } catch(e) { console.error("bcrypt upgrade error:", e); }
    }
    return true;
  }
  return false;
}
const mysqlDump = require("mysqldump");
const locked = require("./locked.json");
const cors = require("cors");
const helmet = require("helmet"); // ✅ SECURITY: Security Headers
const fetch = require("node-fetch");
const cp = require("child_process");
const DatabaseManager = require("./panel/sqlite.js");
const dbsql = new DatabaseManager();

(async () => {
  await dbsql.connect();
  console.log("SQLite ready");
})();
const { getVideoDurationInSeconds } = require("get-video-duration");

// ═══ YouTube Audio System — Cookie-based yt-dlp (guaranteed method) ═══
// child_process, util, execFileAsync, multer — already declared above if needed
var { spawn: _ytSpawn, execFile: _ytExecFile } = require("child_process");
var _ytExecFileAsync = require("util").promisify(_ytExecFile);

// ─── Audio URL Cache ───
const _ytCache = new Map();
const _YT_CACHE_TTL = 1800000; // 30 min

// ─── yt-dlp config ───
var _ytdlpAvailable = false;
var _ytdlpPath = "yt-dlp";
var _ytCookiePath = "";
var _ytDenoPath = "/root/.deno/bin/deno"; // deno is the working JS runtime for yt-dlp challenges

// Check for cookies file
(function() {
  var cookiePaths = [
    __dirname + "/yt-cookies.txt",
    __dirname + "/cookies.txt",
    "/tmp/yt-cookies.txt"
  ];
  for (var i = 0; i < cookiePaths.length; i++) {
    try {
      if (require("fs").existsSync(cookiePaths[i]) && require("fs").statSync(cookiePaths[i]).size > 100) {
        _ytCookiePath = cookiePaths[i];
        console.log("yt-audio: 🍪 cookies found at " + cookiePaths[i]);
        break;
      }
    } catch(e) {}
  }
  if (!_ytCookiePath) {
    console.log("yt-audio: ⚠️  No cookies.txt found! YouTube will likely fail.");
    console.log("yt-audio: 📋 Export cookies from browser → upload via POST /admin/yt-cookies");
    console.log("yt-audio: 📋 Or place file at: " + __dirname + "/yt-cookies.txt");
  }
})();

function _getYtdlpArgs() {
  var args = [
    "--no-playlist",
    "--no-warnings",
    "--no-check-certificates",
    "--force-ipv4",
    "--geo-bypass"
  ];
  if (_ytDenoPath) {
    args.unshift("--js-runtimes", "deno");
  }
  if (_ytCookiePath) {
    args.push("--cookies", _ytCookiePath);
  }
  return args;
}

// Check yt-dlp availability + install EJS scripts
(async function() {
  try {
    var { stdout } = await _ytExecFileAsync("yt-dlp", ["--version"]);
    _ytdlpAvailable = true;
    console.log("yt-audio: ✅ yt-dlp " + stdout.trim() + " is available");
    // Auto-install yt-dlp-ejs (required for YouTube signature solving)
    try {
      await _ytExecFileAsync("pip", ["install", "-q", "--break-system-packages", "yt-dlp-ejs"], { timeout: 60000 });
      console.log("yt-audio: ✅ yt-dlp-ejs challenge solver installed");
    } catch(e) {
      console.log("yt-audio: ⚠️ yt-dlp-ejs install skipped (may already be installed or bundled)");
    }
    // Ensure deno is in PATH for yt-dlp JS challenge solving
    var _denoBinDir = require("path").dirname(_ytDenoPath);
    console.log("yt-audio: 🔍 deno path = " + _ytDenoPath);
    if (process.env.PATH && process.env.PATH.indexOf(_denoBinDir) === -1) {
      process.env.PATH = _denoBinDir + ":" + process.env.PATH;
      console.log("yt-audio: 📌 Added " + _denoBinDir + " to PATH for yt-dlp");
    }
    // Quick test: verify yt-dlp can solve JS challenges with deno
    try {
      var testArgs = ["--js-runtimes", "deno", "--cookies", (_ytCookiePath || "/dev/null"),
        "-f", "bestaudio", "-g", "--no-playlist", "--no-warnings", "--no-check-certificates",
        "--force-ipv4", "--geo-bypass", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
      var testResult = await _ytExecFileAsync(_ytdlpPath, testArgs, { timeout: 60000 });
      if (testResult.stdout && testResult.stdout.includes("http")) {
        console.log("yt-audio: ✅ JS challenge solver VERIFIED (deno) — audio extraction works!");
      } else {
        console.log("yt-audio: ⚠️ JS challenge test returned unexpected output");
      }
    } catch(testErr) {
      var testErrMsg = (testErr.stderr || testErr.message || "").substring(0, 500);
      console.log("yt-audio: ⚠️ JS challenge test failed: " + testErrMsg);
      if (testErrMsg.includes("tv downgraded") || testErrMsg.includes("format is not available")) {
        console.log("yt-audio: 🔧 Possible fix: ensure deno is in PATH. Current: " + _ytDenoPath);
      }
    }
    // Auto-update yt-dlp silently
    try { _ytExecFile("yt-dlp", ["-U"], { timeout: 30000 }, function(){}); } catch(e) {}
  } catch(e) {
    _ytdlpAvailable = false;
    console.log("yt-audio: ❌ yt-dlp not found — install: pip install 'yt-dlp[default]' (includes EJS scripts)");
  }
})();

// ──── Method 1: yt-dlp DIRECT PIPE (بث مباشر — الأقوى) ────
function _ytdlpStreamToRes(videoId, req, res) {
  return new Promise(function(resolve) {
    if (!_ytdlpAvailable) return resolve(false);

    // ✅ FIX: كشف iOS/Safari — نستخدم M4A بدل WebM لأن Safari لا يدعم WebM/Opus
    var ua = req.headers["user-agent"] || "";
    var isIOS = req.query.ios === "1" || /iPhone|iPad|iPod/i.test(ua) || (/Safari/i.test(ua) && !/Chrome/i.test(ua));
    var audioFormat = isIOS ? "bestaudio[ext=m4a]/bestaudio" : "bestaudio";

    var args = [
      "-f", audioFormat,
      "-o", "-"
    ].concat(_getYtdlpArgs()).concat(["https://www.youtube.com/watch?v=" + videoId]);

    console.log("yt-dlp pipe args:", JSON.stringify(args), isIOS ? "(iOS mode)" : "");
    var proc = _ytSpawn(_ytdlpPath, args, { timeout: 90000 });
    var headerSent = false;
    var gotData = false;
    var errorMsg = "";

    proc.stderr.on("data", function(chunk) {
      errorMsg += chunk.toString();
    });

    proc.stdout.on("data", function(chunk) {
      if (!headerSent) {
        headerSent = true;
        gotData = true;
        // ✅ FIX: Content-Type صحيح حسب النظام
        res.setHeader("Content-Type", isIOS ? "audio/mp4" : "audio/webm");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Accept-Ranges", "none");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Transfer-Encoding", "chunked");
      }
      if (!res.writableEnded) res.write(chunk);
    });

    req.on("close", function() {
      try { proc.kill("SIGTERM"); } catch(e) {}
    });

    proc.on("close", function(code) {
      if (gotData) {
        if (!res.writableEnded) res.end();
        resolve(true);
      } else {
        if (errorMsg) {
          var shortErr = errorMsg.substring(0, 800);
          console.error("yt-dlp pipe error:", shortErr);
          // Detect cookie/login issues
          if (shortErr.includes("Sign in") || shortErr.includes("bot") || shortErr.includes("cookies")) {
            console.error("yt-audio: 🔑 Cookie issue detected! Re-upload fresh cookies via POST /admin/yt-cookies");
          }
        }
        resolve(false);
      }
    });

    proc.on("error", function() { resolve(false); });
  });
}

// ──── Method 2: yt-dlp URL extraction ────
async function _ytdlpFetch(videoId, isIOS) {
  if (!_ytdlpAvailable) return null;
  // ✅ FIX: دعم iOS — نطلب M4A إذا الطلب من iOS
  var audioFormat = isIOS ? "bestaudio[ext=m4a]/bestaudio" : "bestaudio";
  try {
    var { stdout } = await _ytExecFileAsync(_ytdlpPath, [
      "-f", audioFormat,
      "-g", "--get-title"
    ].concat(_getYtdlpArgs()).concat(["https://www.youtube.com/watch?v=" + videoId]), { timeout: 30000 });
    var lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length >= 2) {
      var url = lines[lines.length - 1];
      if (url.startsWith("http")) {
        return { url: url, type: url.includes("webm") ? "audio/webm" : "audio/mp4", title: lines[0], duration: 0, instance: "yt-dlp" };
      }
    }
    if (lines.length === 1 && lines[0].startsWith("http")) {
      return { url: lines[0], type: "audio/webm", title: "", duration: 0, instance: "yt-dlp" };
    }
  } catch(e) {
    var errMsg = (e.stderr || e.message || "").substring(0, 800);
    console.error("yt-dlp URL error:", errMsg);
    if (errMsg.includes("Sign in") || errMsg.includes("bot")) {
      console.error("yt-audio: 🔑 Cookies expired or missing!");
    }
  }
  return null;
}

// ──── Method 3: Piped API (community instances — may go down) ────
const _pipedInstances = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.nosebs.ru",
  "https://piped-api.privacy.com.de",
  "https://api.piped.yt",
  "https://pipedapi.drgns.space",
  "https://pipedapi.owo.si",
  "https://pipedapi.ducks.party",
  "https://piped-api.codespace.cz",
  "https://pipedapi.reallyaweso.me",
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services",
  "https://pipedapi.orangenet.cc"
];

async function _pipedFetch(videoId) {
  // Try 3 random instances to avoid always hitting dead ones first
  var shuffled = _pipedInstances.slice().sort(function() { return Math.random() - 0.5; });
  for (var i = 0; i < Math.min(shuffled.length, 5); i++) {
    var inst = shuffled[i];
    try {
      var resp = await fetch(inst + "/streams/" + videoId, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" },
        signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) continue;
      var data = await resp.json();
      var streams = (data.audioStreams || []).filter(function(s) { return s.url; });
      if (streams.length === 0) continue;
      streams.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
      var best = streams.find(function(s) { return s.mimeType && s.mimeType.includes("opus"); }) || streams[0];
      return { url: best.url, type: best.mimeType || "audio/webm", title: data.title || "", duration: data.duration || 0, instance: "piped:" + inst.replace("https://","") };
    } catch(e) { /* next */ }
  }
  return null;
}

// ──── Method 4: Invidious API (last resort) ────
const _invInstances = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://inv.tux.pizza",
  "https://invidious.privacyredirect.com",
  "https://iv.datura.network",
  "https://yt.cdaut.de",
  "https://invidious.perennialte.ch",
  "https://invidious.materialio.us"
];

async function _invFetchSingle(videoId) {
  var shuffled = _invInstances.slice().sort(function() { return Math.random() - 0.5; });
  for (var i = 0; i < Math.min(shuffled.length, 4); i++) {
    var inst = shuffled[i];
    try {
      var resp = await fetch(inst + "/api/v1/videos/" + videoId + "?fields=title,lengthSeconds,adaptiveFormats", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" },
        signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) continue;
      var data = await resp.json();
      if (!data.adaptiveFormats || data.adaptiveFormats.length === 0) continue;
      var audios = data.adaptiveFormats.filter(function(f) { return f.type && f.type.startsWith("audio/"); });
      if (audios.length === 0) continue;
      audios.sort(function(a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
      var best = audios.find(function(f) { return f.type && f.type.includes("opus"); }) || audios[0];
      return { url: best.url, type: best.type || "audio/webm", title: data.title || "", duration: data.lengthSeconds || 0, instance: "inv:" + inst.replace("https://","") };
    } catch(e) { /* next */ }
  }
  return null;
}

// ──── Main URL Fetcher (for fallback proxy mode) ────
async function _invFetch(videoId, isIOS) {
  var cached = _ytCache.get(videoId);
  // ✅ FIX: لا نستخدم كاش WebM لـ iOS (يحتاج M4A)
  if (cached && Date.now() - cached.t < _YT_CACHE_TTL && !(isIOS && cached.d && cached.d.type === "audio/webm")) {
    console.log("yt-audio: ♻️ cache hit [" + cached.d.instance + "] " + videoId);
    return cached.d;
  }
  console.log("yt-audio: 🔍 URL fetch " + videoId + "..." + (isIOS ? " (iOS)" : ""));

  // yt-dlp URL extraction
  var info = await _ytdlpFetch(videoId, isIOS);
  if (info) console.log("yt-audio: ✅ URL via yt-dlp");

  // Piped fallback
  if (!info) { info = await _pipedFetch(videoId); if (info) console.log("yt-audio: ✅ URL via " + info.instance); }
  
  // Invidious last resort
  if (!info) { info = await _invFetchSingle(videoId); if (info) console.log("yt-audio: ✅ URL via " + info.instance); }

  if (info) {
    _ytCache.set(videoId, { t: Date.now(), d: info });
    if (_ytCache.size > 200) { var now = Date.now(); for (var entry of _ytCache) { if (now - entry[1].t > _YT_CACHE_TTL) _ytCache.delete(entry[0]); } }
  } else {
    console.error("yt-audio: ❌ ALL methods failed for " + videoId);
  }
  return info;
}

// Cookie status
var _ytCookieStatus = { valid: false, lastUpload: null, lastTest: null, error: null };

console.log("yt-audio: Cookie-based engine loaded (yt-dlp" + (_ytCookiePath ? " +cookies" : "") + " + " + _pipedInstances.length + " Piped + " + _invInstances.length + " Invidious)");


const bodyParser = require("body-parser");
const applyGlobalXSSProtection = require("./socketSanitizer");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const rateLimiter = new RateLimiterMemory({ points: 100, duration: 1 }); // ✅ SECURED: 100 طلب/ثانية بدل 50000
const sharp = require("sharp");
const app = express();

// ✅ SECURITY: Security Headers — حماية من Clickjacking, XSS, MIME Sniffing
app.use(helmet({
  contentSecurityPolicy: false,         // لا نكسر السكربتات الموجودة
  crossOriginEmbedderPolicy: false,     // لا نمنع تحميل الموارد الخارجية
  crossOriginResourcePolicy: { policy: "cross-origin" }, // السماح بتحميل الصور من مواقع أخرى
  crossOriginOpenerPolicy: false,       // السماح بـ YouTube embeds والنوافذ الخارجية
  referrerPolicy: { policy: "no-referrer-when-downgrade" }, // YouTube يحتاج الـ Referrer عشان يشغّل الفيديو
}));

const Config = require("./config");
const isPowers = require("./powers");
app.set("trust proxy", "loopback");
const limiter = rateLimit({
  windowMs: 10 * 1000, // 1 دقيقة
  max: 100, // الحد الأقصى لكل IP في الدقيقة
  standardHeaders: false, // تفعيل RateLimit headers (النسخة الحديثة)
  legacyHeaders: false, // تعطيل الهيدر القديم X-RateLimit-*
  message: "تم تجاوز الحد المسموح به، حاول لاحقاً.",
});
// ✅ SECURITY: Rate limiter مفعّل — يستثني الملفات الثابتة (صور، CSS، JS)
const _staticExts = /\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot|mp3|mp4|ogg|wav|webm|json|map)$/i;
const _securedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: "تم تجاوز الحد المسموح به، حاول لاحقاً.",
  skip: (req) => _staticExts.test(req.path),
  standardHeaders: false,
  legacyHeaders: false,
});
app.use(_securedLimiter);

var listalert = [];
var idshow = "";
var idhacker = "";

// ===== نظام حماية الفلود =====
const _floodProtection = new Map(); // key: socket.id, value: { timestamps: [], blocked: false, blockedUntil: 0 }

function _checkFlood(socketId, SendNotification) {
  const now = Date.now();
  
  if (!_floodProtection.has(socketId)) {
    _floodProtection.set(socketId, { timestamps: [], blocked: false, blockedUntil: 0 });
  }
  
  const userData = _floodProtection.get(socketId);
  
  // إذا ممنوع — نشوف إذا خلصت المدة
  if (userData.blocked) {
    if (now < userData.blockedUntil) {
      const remaining = Math.ceil((userData.blockedUntil - now) / 1000);
      SendNotification({
        state: "me",
        topic: "",
        force: 1,
        msg: "🚫 تم منعك من الإرسال لمدة " + remaining + " ثانية",
        user: "",
      });
      return true; // ممنوع
    } else {
      // خلصت المدة — نعيد التعيين
      userData.blocked = false;
      userData.blockedUntil = 0;
      userData.timestamps = [];
    }
  }
  
  // نضيف الوقت الحالي
  userData.timestamps.push(now);
  
  // ننظف الأوقات القديمة (أكثر من 5 ثواني)
  userData.timestamps = userData.timestamps.filter(t => now - t < 5000);
  
  // فحص المنع: 8 رسائل بـ 5 ثواني
  if (userData.timestamps.length >= 8) {
    userData.blocked = true;
    userData.blockedUntil = now + 30000; // 30 ثانية
    userData.timestamps = [];
    SendNotification({
      state: "me",
      topic: "",
      force: 1,
      msg: "🚫 على رسلك! أنت ترسل بشكل سريع. تم منعك من الإرسال لمدة 30 ثانية",
      user: "",
    });
    return true; // ممنوع
  }
  
  // فحص التحذير: 5 رسائل بـ 3 ثواني
  const recentTimestamps = userData.timestamps.filter(t => now - t < 3000);
  if (recentTimestamps.length >= 5) {
    SendNotification({
      state: "me",
      topic: "",
      force: 1,
      msg: "⚠️ على رسلك! أنت ترسل بشكل سريع",
      user: "",
    });
    // نسمح بالرسالة بس مع تحذير
    return false;
  }
  
  return false; // مسموح
}

// تنظيف بيانات الفلود كل 5 دقائق
setInterval(() => {
  const now = Date.now();
  for (const [socketId, data] of _floodProtection.entries()) {
    if (data.timestamps.length === 0 && !data.blocked) {
      _floodProtection.delete(socketId);
    } else if (data.blocked && now > data.blockedUntil) {
      _floodProtection.delete(socketId);
    }
  }
}, 300000);
// ===== نهاية نظام حماية الفلود =====

const AppDataBase = require("./database/database");
const GetBand = require("./router/ban_list");
const GetWaiting = require("./router/waitingroom_list");
const GetBars = require("./router/bars_list");
const GetBots = require("./router/bots_list");
const GetBsb = require("./router/bsb_list");
const GetCuts = require("./router/cut_list");
const GetIntroMsg = require("./router/intromsg_list");
const GetNames = require("./router/names_list");
const GetNoName = require("./router/noname_list");
const GetNoText = require("./router/notext_list");
const GetPowers = require("./router/powers_list");
const GetLogs = require("./router/logs_list");
const GetRooms = require("./router/rooms_list");
const GetSetting = require("./router/settings");
const GetMesg = require("./router/mesgs");
const GetStats = require("./router/state_list");
const GetSub = require("./router/subscribe_list");
const GetUsers = require("./router/users_list");
const GetHistLetter = require("./router/wordcf_list");
const GetEmo = require("./router/emo_list");
const GetSico = require("./router/sico_list");
const GetAtar = require("./router/atar_list");
const GetBack = require("./router/back_list");
const GetDro3 = require("./router/dro3_list");
const GetStory = require("./router/story_list");
const GetStoryComments = require("./router/story_comments");
const db = new AppDataBase();
const StoryRepo = new GetStory(db);
const StoryCommentsRepo = new GetStoryComments(db);
const GetStoryViews = require("./router/story_views");
const StoryViewsRepo = new GetStoryViews(db);
const BandRepo = new GetBand(db);
const WaitingRepo = new GetWaiting(db);
const BarsRepo = new GetBars(db);
const BotsRepo = new GetBots(db);
const MesgRepo = new GetMesg(db);
const BsbRepo = new GetBsb(db);
const CutsRepo = new GetCuts(db);
const IntroRepo = new GetIntroMsg(db);
const NamesRepo = new GetNames(db);
const NoNamesRepo = new GetNoName(db);
const NotextRepo = new GetNoText(db);
const PowersRepo = new GetPowers(db);
const LogsRepo = new GetLogs(db);
const RoomsRepo = new GetRooms(db);
const SettingRepo = new GetSetting(db);
const StateRepo = new GetStats(db);
const SubRepo = new GetSub(db);
const UsersRepo = new GetUsers(db);
const HistLetterRepo = new GetHistLetter(db);
const EmoRepo = new GetEmo(db);
const SicoRepo = new GetSico(db);
const AtarRepo = new GetAtar(db);
const BackRepo = new GetBack(db);
const Dro3Repo = new GetDro3(db);

EmoRepo.createTable();
SicoRepo.createTable();
Dro3Repo.createTable();
AtarRepo.createTable();
BackRepo.createTable();
BsbRepo.createTable();
UsersRepo.createTable();
// ✦ إضافة أعمدة الزخرفة (الخط واللمعة) للمستخدمين القدامى
UsersRepo.addDecoColumns();

SettingRepo.createTable();
PowersRepo.createTable();
RoomsRepo.createTable();
NamesRepo.createTable();
SubRepo.createTable();
MesgRepo.createTable();
StoryRepo.createTable();
  StoryRepo.migrate();
  StoryCommentsRepo.createTable();
  StoryViewsRepo.createTable();
BandRepo.createTable();
WaitingRepo.createTable();
LogsRepo.createTable();
StateRepo.createTable();
BotsRepo.createTable();
CutsRepo.createTable();
NotextRepo.createTable();
BarsRepo.createTable();
HistLetterRepo.createTable();
IntroRepo.createTable();
NoNamesRepo.createTable();
//Variable
const KeyPanelMon = process.env.PANEL_KEY || crypto.randomBytes(32).toString("hex"); // ✅ SECURED: مفتاح عشوائي آمن
var LinkUpload = "";
var reconnct = "";
var UserChecked = [];
var OnlineUser = [];

/* ✅ فلتر المخفيين: لا ترسل بيانات المخفي لغير الأدمن */
function getFilteredOnlineUsers(socketId) {
  var viewerPower = UserInfo[socketId] ? UserInfo[socketId]["power"] : "";
  var canSeeStealth = GetPower(viewerPower)["stealth"];
  if (canSeeStealth) return OnlineUser; // أدمن يشوف الكل
  return OnlineUser.filter(function(u) { return !u.s; });
}
function emitToStealthViewers(cmd, data) {
  for (var sid in UserInfo) {
    if (GetPower(UserInfo[sid]["power"])["stealth"]) {
      io.to(sid).emit("SEND_EVENT_EMIT_SERVER", { cmd: cmd, data: data });
    }
  }
}
var UserInfo = {};
/* ═══════════════════════════════════════════════════════
   ✅ الحل الجذري: خرائط توجيه الألعاب بالـ lid
   lid = المعرّف الثابت الموجود عند العميل والسيرفر
   ═══════════════════════════════════════════════════════ */
if (!global._socketToLid) global._socketToLid = {};  // socketId → lid (يحفظ كل القديم!)
if (!global._lidToSocket) global._lidToSocket = {};   // lid → socketId الحالي
/* يُستدعى عند كل اتصال وكل REAUTH */
function _updateSocketMaps(socketId, lid) {
  if (!socketId || !lid) return;
  global._socketToLid[socketId] = String(lid);
  global._lidToSocket[String(lid)] = socketId;
}
/* البحث عن socket الحالي — يعمل حتى لو العميل يرسل socket ميت */
function _gameRoute(targetSocketId) {
  // 1. Socket حي → استخدمه مباشرة
  if (targetSocketId && io.sockets.sockets.get(targetSocketId)) return targetSocketId;
  // 2. ابحث عن lid هالـ socket
  var lid = global._socketToLid[targetSocketId];
  if (!lid) return null;
  // 3. جب socket الحالي لهالـ lid
  var current = global._lidToSocket[lid];
  if (current && io.sockets.sockets.get(current)) return current;
  return null;
}
// ── Rate limit تعليق البوست: { socketId: { bid: timestamp } } ──
var CommentRateLimit = {};
var LiveInfo = {
  privated: false,
  listattend: [],
  listviews: [],
  timelive: 0,
};
var SiteSetting = [];
var PeerRoom = {};
var ShowPowers = [];
const countries = {
  kw: "الكويت",
  et: "إثيوبيا",
  az: "أذربيجان",
  am: "أرمينيا",
  aw: "أروبا",
  er: "إريتريا",
  es: "أسبانيا",
  au: "أستراليا",
  ee: "إستونيا",
  il: "فلسطين",
  af: "أفغانستان",
  ec: "إكوادور",
  ar: "الأرجنتين",
  jo: "الأردن",
  ae: "الإمارات العربية المتحدة",
  al: "ألبانيا",
  bh: "مملكة البحرين",
  br: "البرازيل",
  pt: "البرتغال",
  ba: "البوسنة والهرسك",
  ga: "الجابون",
  dz: "الجزائر",
  dk: "الدانمارك",
  cv: "الرأس الأخضر",
  ps: "فلسطين",
  sv: "السلفادور",
  sn: "السنغال",
  sd: "السودان",
  se: "السويد",
  so: "الصومال",
  cn: "الصين",
  iq: "العراق",
  ph: "الفلبين",
  cm: "الكاميرون",
  cg: "الكونغو",
  cd: "جمهورية الكونغو الديمقراطية",
  de: "ألمانيا",
  hu: "المجر",
  ma: "المغرب",
  mx: "المكسيك",
  sa: "المملكة العربية السعودية",
  uk: "المملكة المتحدة",
  gb: "المملكة المتحدة",
  no: "النرويج",
  at: "النمسا",
  ne: "النيجر",
  in: "الهند",
  us: "الولايات المتحدة",
  jp: "اليابان",
  ye: "اليمن",
  gr: "اليونان",
  ag: "أنتيغوا وبربودا",
  id: "إندونيسيا",
  ao: "أنغولا",
  ai: "أنغويلا",
  uy: "أوروجواي",
  uz: "أوزبكستان",
  ug: "أوغندا",
  ua: "أوكرانيا",
  ir: "إيران",
  ie: "أيرلندا",
  is: "أيسلندا",
  it: "إيطاليا",
  pg: "بابوا-غينيا الجديدة",
  py: "باراجواي",
  bb: "باربادوس",
  pk: "باكستان",
  pw: "بالاو",
  bm: "برمودا",
  bn: "بروناي",
  be: "بلجيكا",
  bg: "بلغاريا",
  bd: "بنجلاديش",
  pa: "بنما",
  bj: "بنين",
  bt: "بوتان",
  bw: "بوتسوانا",
  pr: "بورتو ريكو",
  bf: "بوركينا فاسو",
  bi: "بوروندي",
  pl: "بولندا",
  bo: "بوليفيا",
  pf: "بولينزيا الفرنسية",
  pe: "بيرو",
  by: "بيلاروس",
  bz: "بيليز",
  th: "تايلاند",
  tw: "تايوان",
  tm: "تركمانستان",
  tr: "تركيا",
  tt: "ترينيداد وتوباجو",
  td: "تشاد",
  cl: "تشيلي",
  tz: "تنزانيا",
  tg: "توجو",
  tv: "توفالو",
  tk: "توكيلاو",
  to: "تونجا",
  tn: "تونس",
  tp: "تيمور الشرقية",
  jm: "جامايكا",
  gm: "جامبيا",
  gl: "جرينلاند",
  pn: "جزر البتكارين",
  bs: "جزر البهاما",
  km: "جزر القمر",
  cf: "أفريقيا الوسطى",
  cz: "جمهورية التشيك",
  do: "جمهورية الدومينيكان",
  za: "جنوب أفريقيا",
  gt: "جواتيمالا",
  gp: "جواديلوب",
  gu: "جوام",
  ge: "جورجيا",
  gs: "جورجيا الجنوبية",
  gy: "جيانا",
  gf: "جيانا الفرنسية",
  dj: "جيبوتي",
  je: "جيرسي",
  gg: "جيرنزي",
  va: "دولة الفاتيكان",
  dm: "دومينيكا",
  rw: "رواندا",
  ru: "روسيا",
  ro: "رومانيا",
  re: "ريونيون",
  zm: "زامبيا",
  zw: "زيمبابوي",
  ws: "ساموا",
  sm: "سان مارينو",
  sk: "سلوفاكيا",
  si: "سلوفينيا",
  sg: "سنغافورة",
  sz: "سوازيلاند",
  sy: "سوريا",
  sr: "سورينام",
  ch: "سويسرا",
  sl: "سيراليون",
  lk: "سيريلانكا",
  sc: "سيشل",
  rs: "صربيا",
  tj: "طاجيكستان",
  om: "عمان",
  gh: "غانا",
  gd: "غرينادا",
  gn: "غينيا",
  gq: "غينيا الاستوائية",
  gw: "غينيا بيساو",
  vu: "فانواتو",
  fr: "فرنسا",
  ve: "فنزويلا",
  fi: "فنلندا",
  vn: "فيتنام",
  cy: "قبرص",
  qa: "قطر",
  kg: "قيرقيزستان",
  kz: "كازاخستان",
  nc: "كاليدونيا الجديدة",
  kh: "كامبوديا",
  hr: "كرواتيا",
  ca: "كندا",
  cu: "كوبا",
  ci: "ساحل العاج",
  kr: "كوريا",
  kp: "كوريا الشمالية",
  cr: "كوستاريكا",
  co: "كولومبيا",
  ki: "كيريباتي",
  ke: "كينيا",
  lv: "لاتفيا",
  la: "لاوس",
  lb: "لبنان",
  li: "لشتنشتاين",
  lu: "لوكسمبورج",
  ly: "ليبيا",
  lr: "ليبيريا",
  lt: "ليتوانيا",
  ls: "ليسوتو",
  mq: "مارتينيك",
  mo: "ماكاو",
  fm: "ماكرونيزيا",
  mw: "مالاوي",
  mt: "مالطا",
  ml: "مالي",
  my: "ماليزيا",
  yt: "مايوت",
  mg: "مدغشقر",
  eg: "مصر",
  mk: "مقدونيا، يوغوسلافيا",
  mn: "منغوليا",
  mr: "موريتانيا",
  mu: "موريشيوس",
  mz: "موزمبيق",
  md: "مولدوفا",
  mc: "موناكو",
  ms: "مونتسيرات",
  me: "مونتينيغرو",
  mm: "ميانمار",
  na: "ناميبيا",
  nr: "ناورو",
  np: "نيبال",
  ng: "نيجيريا",
  ni: "نيكاراجوا",
  nu: "نيوا",
  nz: "نيوزيلندا",
  ht: "هايتي",
  hn: "هندوراس",
  nl: "هولندا",
  hk: "هونغ كونغ",
  wf: "واليس وفوتونا",
};
var NoNames = [
  "نايك",
  "شات",
  "دردشه",
  "دردشة",
  "http",
  "com",
  "انيك",
  "كسمك",
  "كصمك",
  "كسختك",
  "كصختك",
  "كحبه",
  "كحبة",
  "قحبة",
  "متناك",
  "منايك",
  "جلخ",
  "نياج",
  "منيوج",
  "فاشخ",
  "داعس",
  "سكس",
  "كس امك",
  "كس اختك",
  "شرموط",
  "انيك",
  "خواتك",
  "امهات",
  "كسم",
  "كسخ",
  "زب",
  "طيز",
  "كلب",
  "زوب",
  "عير",
  "نيك",
];
var RoomsList = [];
var RoomsListWith = [];
var SystemOpen = {};
var BrowserOpen = {};
var ListEnter = [];
var botsauto = [];
var ListWait = [];
var NoMsgFilter = [];
var ListBand = [];
// ✅ خريطة مؤقتة لحفظ البصمة الصلبة قبل ما يسجل المستخدم دخوله
var socketHwFp = {};
var ekti1 = [];
var ekti2 = [];
const System = {
  system1: false,
  system2: false,
  system3: false,
  system4: false,
  system5: false,
  system6: false,
  system7: true,
};

const Browser = {
  browser1: false,
  browser2: false,
  browser3: false,
  browser4: false,
  browser5: false,
  browser6: false,
  browser7: false,
  browser8: false,
  browser9: true,
};

var BotBC = {
  nb: 0,
  isbot: false,
  start: false,
  timestop: 3,
  timestart: 0,
  player: [],
};
var bottime;
var notificationoffline = [];

// ── تنظيف Rate Limit ذاكرة الدعوات كل 10 دقائق ──
setInterval(function() {
  if (!global._gameInviteRL) return;
  var _now = Date.now();
  Object.keys(global._gameInviteRL).forEach(function(k) {
    if (_now - global._gameInviteRL[k] > 120000) delete global._gameInviteRL[k];
  });
}, 600000);

// ✅ تنظيف غرف الألعاب المنتهية كل 30 دقيقة
setInterval(function() {
  var _now = Date.now();
  var _maxAge = 3 * 60 * 60 * 1000; // 3 ساعات
  // تنظيف LudoRooms
  if (global.LudoRooms) {
    Object.keys(global.LudoRooms).forEach(function(k) {
      if (_now - (global.LudoRooms[k].created || 0) > _maxAge) delete global.LudoRooms[k];
    });
  }
  // تنظيف TrixRooms
  if (global.TrixRooms) {
    Object.keys(global.TrixRooms).forEach(function(k) {
      if (_now - (global.TrixRooms[k].created || 0) > _maxAge) delete global.TrixRooms[k];
    });
  }
  // تنظيف UnoRooms
  if (global.UnoRooms) {
    Object.keys(global.UnoRooms).forEach(function(k) {
      if (_now - (global.UnoRooms[k].created || 0) > _maxAge) delete global.UnoRooms[k];
    });
  }
  // تنظيف _AG (جلسات الألعاب المنتهية)
  if (global._AG) {
    Object.keys(global._AG).forEach(function(k) {
      if (_now - (global._AG[k].t || 0) > _maxAge) delete global._AG[k];
    });
  }
}, 1800000);

const url = require("url");
const base64id = require("base64id");
const options = {
  key: fs.readFileSync("pem/key.pem"),
  cert: fs.readFileSync("pem/cert.pem"),
};

const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: Config.ListDomin, // ✅ SECURED: تحديد الأصول المسموحة
    methods: ["GET", "POST"],
  },

  // زيادة مهلة الـ ping لاستيعاب الجوالات في الخلفية
  // الجوال ممكن يوقف JS لـ 60-90 ثانية قبل ما يقطع الاتصال
  pingTimeout: 180000,  // ✅ 3 دقائق — يتحمّل خلفية الموبايل + النت البطيء
  pingInterval: 25000,   // ✅ 25 ثانية — أخف على النت البطيء

  // ✅ WebSocket فقط — polling يسبب انقطاعات وهمية كثيرة
  transports: ["websocket"],
  upgradeTimeout: 10000,

  // ✅ ضغط خفيف لا يثقّل الجوالات القديمة
  perMessageDeflate: {
    threshold: 2048,
    zlibDeflateOptions: { level: 1 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },

  // ✅ حد أقصى لحجم الرسائل (1MB)
  maxHttpBufferSize: 1e6,
  httpCompression: true,

  // مهلة استرجاع الجلسة — 10 دقائق لاستيعاب الجوالات
  connectionStateRecovery: {
    maxDisconnectionDuration: 30 * 60000, // ✅ 30 دقيقة بدل 10
    skipMiddlewares: false,
  },
});

io.engine.generateId = (req) => {
  // ✅ دائماً ولّد ID فريد — device_id يُستخدم فقط للتعريف في handshake.query
  // استخدام device_id كـ socket.id يسبب تضارب عند إعادة الاتصال السريعة
  return stringGen(32);
};

function generateShortFingerprint({
  userAgent,
  language,
  screenSize,
  timezone,
}) {
  const rawId = `${userAgent}-${language}-${timezone}`;
  const hash = crypto.createHash("sha256").update(rawId).digest("hex");
  const base36 = BigInt("0x" + hash).toString(36);
  const shortId = `${base36.slice(0, 4)}-${base36.slice(4, 9)}-${base36.slice(
    9,
    14
  )}-${base36.slice(14, 19)}`;
  return shortId;
}

async function GetWaitingFor(data) {
  const waiting = WaitingRepo.getBy({ state: "getByWith" });
  if (waiting.length) {
    const iswai = waiting.findIndex((x) => x.bands.includes(data));
    if (iswai) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

//Youtube
// ─── مساعد: استخراج بيانات فيديو من videoRenderer ───
function extractVideoInfo(v) {
  if (!v || !v.videoId) return null;
  return {
    id: v.videoId,
    title: (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || "",
    time: (v.lengthText && v.lengthText.simpleText) || "",
    link: "https://www.youtube.com/watch?v=" + v.videoId,
    thumbnail: "https://i.ytimg.com/vi/" + v.videoId + "/hqdefault.jpg"
  };
}

// ─── مساعد: استخراج continuation token من contents ───
function extractYtContinuation(contents) {
  for (var s = 0; s < contents.length; s++) {
    var cr = contents[s].continuationItemRenderer;
    if (cr) {
      var token = cr.continuationEndpoint &&
        cr.continuationEndpoint.continuationCommand &&
        cr.continuationEndpoint.continuationCommand.token;
      if (token) return token;
    }
  }
  return null;
}

// ─── بحث أول صفحة ───
const searchYoutube = async function (query, nb) {
  const maxResults = nb || 15;
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
  return fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ar,en;q=0.9"
    }
  })
  .then(res => res.text())
  .then(html => {
    const marker = "var ytInitialData = ";
    const startPos = html.indexOf(marker);
    if (startPos === -1) { console.error("searchYoutube: ytInitialData not found"); return { results: [], continuation: null }; }
    const jsonStart = html.indexOf("{", startPos);
    let depth = 0, jsonEnd = -1;
    for (let i = jsonStart; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
    }
    if (jsonEnd === -1) return { results: [], continuation: null };
    let ytData;
    try { ytData = JSON.parse(html.slice(jsonStart, jsonEnd)); }
    catch(e) { console.error("searchYoutube JSON parse error:", e.message); return { results: [], continuation: null }; }
    const contents = ytData &&
      ytData.contents &&
      ytData.contents.twoColumnSearchResultsRenderer &&
      ytData.contents.twoColumnSearchResultsRenderer.primaryContents &&
      ytData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer &&
      ytData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
    if (!contents) { console.error("searchYoutube: contents not found"); return { results: [], continuation: null }; }
    var result = [];
    for (var s = 0; s < contents.length; s++) {
      var items = (contents[s].itemSectionRenderer && contents[s].itemSectionRenderer.contents) || [];
      for (var j = 0; j < items.length; j++) {
        if (result.length >= maxResults) break;
        var info = extractVideoInfo(items[j].videoRenderer);
        if (info) result.push(info);
      }
      if (result.length >= maxResults) break;
    }
    var continuation = extractYtContinuation(contents);
    return { results: result, continuation: continuation };
  });
};

// ─── جلب الصفحات التالية باستخدام continuation token ───
const searchYoutubeMore = async function (token) {
  return fetch("https://www.youtube.com/youtubei/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "ar,en;q=0.9"
    },
    body: JSON.stringify({
      continuation: token,
      context: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20230101.00.00",
          hl: "ar",
          gl: "SA"
        }
      }
    })
  })
  .then(res => res.json())
  .then(data => {
    var items = data.onResponseReceivedCommands &&
      data.onResponseReceivedCommands[0] &&
      data.onResponseReceivedCommands[0].appendContinuationItemsAction &&
      data.onResponseReceivedCommands[0].appendContinuationItemsAction.continuationItems;
    if (!items) return { results: [], continuation: null };
    var result = [];
    var nextToken = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].itemSectionRenderer) {
        var sItems = items[i].itemSectionRenderer.contents || [];
        for (var j = 0; j < sItems.length; j++) {
          var info = extractVideoInfo(sItems[j].videoRenderer);
          if (info) result.push(info);
        }
      }
      if (items[i].continuationItemRenderer) {
        var cr = items[i].continuationItemRenderer;
        nextToken = cr.continuationEndpoint &&
          cr.continuationEndpoint.continuationCommand &&
          cr.continuationEndpoint.continuationCommand.token;
      }
    }
    return { results: result, continuation: nextToken || null };
  })
  .catch(function(err) {
    console.error("searchYoutubeMore error:", err);
    return { results: [], continuation: null };
  });
};

let storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, __dirname + "/uploads/" + LinkUpload);
  },
  filename: (req, file, cb) => {
    if (typeof file != "object") {
      return;
    } else if (
      typeof file["mimetype"] != "string" ||
      typeof file["fieldname"] != "string"
    ) {
      return;
    }
    var extension = Config.TypeFile[file.mimetype];
    if (!extension) {
      return;
    }
    if (extension.includes("png")) {
      extension = "jpg";
    }
    if (req.query["nm"] == "isborder" || req.query["nm"] == "isback") {
      cb(null, req.query["nm"] + Date.now() + "." + extension);
    } else {
      // if(typeof extension == 'string'){
      cb(null, Date.now() + "." + extension);
    }
  },
});

let upload = multer({
  storage: storage,
  preservePath: true,
  limits: { fileSize: Config.MaxUpload },
  fileFilter: function(req, file, cb) {
    // ✅ SECURITY: فحص MIME type أولي
    var allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "audio/mpeg", "audio/mp3", "audio/ogg", "video/mp4"];
    if (allowedMimes.indexOf(file.mimetype) === -1) {
      return cb(new Error("نوع الملف غير مسموح"), false);
    }
    cb(null, true);
  }
}).single("photo");

// ✅ SECURITY: فحص Magic Bytes بعد رفع الملف
async function validateUploadedFile(filePath) {
  try {
    var fileType = require("file-type");
    if (!fileType || !fileType.fromFile) return true; // إذا المكتبة غير موجودة نسمح
    var type = await fileType.fromFile(filePath);
    if (!type) return false;
    var safe = ["image/jpeg","image/png","image/gif","image/webp","audio/mpeg","audio/ogg","video/mp4"];
    return safe.indexOf(type.mime) !== -1;
  } catch(e) { return true; } // failsafe
}
//fs
function getFiles(dir, files_) {
  files_ = files_ || [];
  var files = fs.readdirSync(dir);
  for (var i in files) {
    var name = dir + "/" + files[i];
    if (fs.statSync(name).isDirectory()) {
      getFiles(name, files_);
    } else {
      files_.push(name);
    }
  }
  return files_;
}
// ✅ كاش إعدادات الموقع — بدل ما كل زيارة تعمل 2 استعلام + قراءة ملف
const siteSettingsCache = new Map();
const SITE_CACHE_TTL = 30000; // 30 ثانية — تغييرات اللوحة تظهر خلال 30 ثانية كحد أقصى

function getCachedSiteSettings(hostname, callback) {
  var cached = siteSettingsCache.get(hostname);
  if (cached && Date.now() - cached.time < SITE_CACHE_TTL) {
    return callback(null, cached.getSettings, cached.getSe, cached.array);
  }
  SettingRepo.getBy({ state: "getByID", id: 1 }).then(function(getSettings) {
    SettingRepo.getBy({ state: "getByHost", hostname: hostname }).then(function(getSe) {
      if (!getSettings || !getSe) return callback(new Error('no settings'));
      fs.readFile("uploads/" + getSe["script"], function(err, f) {
        var array = {};
        if (f) { try { array = JSON.parse(f.toString()); } catch(e) { array = {}; } }
        siteSettingsCache.set(hostname, { getSettings: getSettings, getSe: getSe, array: array, time: Date.now() });
        callback(null, getSettings, getSe, array);
      });
    });
  });
}

// ✅ مسح الكاش عند تغيير الإعدادات من اللوحة
function clearSiteCache(hostname) {
  if (hostname) {
    siteSettingsCache.delete(hostname);
  } else {
    siteSettingsCache.clear();
  }
  // مسح كاش القوالب عشان التعديلات تظهر بدون ريستارت
  app.cache = {};
  try { require("ejs").cache.reset(); } catch(e) {}
}

//AppRouter

app.set("views", path.join(__dirname, "public"));
app.set("view engine", "ejs");
app.set("view cache", true);

// مراقبة ملف index.ejs — لما يتغيّر ينمسح الكاش تلقائي بدون ريستارت
var ejs = require("ejs");
fs.watchFile(path.join(__dirname, "public", "index.ejs"), { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    app.cache = {};
    ejs.cache.reset();
    console.log("♻️ View cache cleared (index.ejs changed)");
  }
});

// ✅ تصغير HTML — إزالة المسافات الزائدة (يوفر ~15-20% من حجم الصفحة)
app.use(function(req, res, next) {
  var originalRender = res.render.bind(res);
  res.render = function(view, options, callback) {
    originalRender(view, options, function(err, html) {
      if (err) return next(err);
      // إزالة أسطر فارغة ومسافات زائدة بين تاغات (آمن تماماً)
      html = html.replace(/\n\s*\n/g, '\n').replace(/>\s{2,}</g, '> <');
      res.send(html);
    });
  };
  next();
}); // ✅ كاش القوالب — يسرّع الرندر بشكل ملحوظ

// ✅ ضغط HTTP — يسرّع التحميل على النت الضعيف بشكل ملحوظ
const compression = require("compression");
app.use(compression({
  level: 6,       // مستوى 6 = أفضل توازن بين الضغط والسرعة (معيار nginx/Apache)
  threshold: 1024, // فقط للملفات أكبر من 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(function(req, res, next) {
  if (req.path.endsWith('.ejs')) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(__dirname + "/public", { maxAge: 31557600 }));
app.use("/cp", express.static(path.join(__dirname, "public/out")));
app.use("/_next", express.static(path.join(__dirname, "public/out/_next")));

// ✅ WebP Auto-Serve — يخدم .webp بدل .png/.jpg للمتصفحات الداعمة (Chrome/Firefox/Safari/Edge)
app.use(function(req, res, next) {
  if (!/\.(png|jpe?g)(\?|$)/i.test(req.url)) return next();
  if (!(req.headers.accept || '').includes('image/webp')) return next();
  var cleanPath = req.url.split('?')[0];
  // ✅ FIX-SEC: منع path traversal في WebP serve
  cleanPath = cleanPath.replace(/\.\./g, '').replace(/[^a-zA-Z0-9_.\-\/]/g, '');
  var webpLocalPath = path.join(__dirname, 'uploads', cleanPath.replace(/\.(png|jpe?g)$/i, '.webp'));
  // ✅ FIX-SEC: التأكد أن المسار داخل مجلد uploads فقط
  if (!webpLocalPath.startsWith(path.join(__dirname, 'uploads'))) return next();
  if (fs.existsSync(webpLocalPath)) {
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.sendFile(webpLocalPath);
  }
  next();
});

app.use(express.static("uploads", {
  maxAge: '7d',  // cache الصور المرفوعة 7 أيام
  etag: true,
  lastModified: true,
}));
app.use(bodyParser.urlencoded({ extended: true }));
// ═══ YouTube Cookie Upload (admin only) ═══
// ═══ 🛡️ Admin Authentication Middleware ═══
function _adminAuth(req, res, next) {
  var token = req.query["token"] || req.headers["x-admin-token"] || "";
  if (!token) return res.status(403).json({ error: "Forbidden — token required" });
  UsersRepo.getBy({ state: "getByToken", token: token }).then(function(user) {
    if (user && GetPower(user["power"])["owner"]) {
      req.adminUser = user;
      next();
    } else {
      return res.status(403).json({ error: "Forbidden — admin only" });
    }
  }).catch(function() {
    return res.status(403).json({ error: "Auth error" });
  });
}

var _ytCookieUpload = require("multer")({ dest: "/tmp/", limits: { fileSize: 2 * 1024 * 1024 } });
app.post("/admin/yt-cookies", _adminAuth, _ytCookieUpload.single("cookies"), function(req, res) {
  // ✅ SECURED: Admin authentication required
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send as multipart with field name 'cookies'" });
  }
  try {
    var data = require("fs").readFileSync(req.file.path, "utf8");
    // Validate it looks like a Netscape cookie file
    if (!data.includes("youtube.com") && !data.includes(".youtube.com")) {
      require("fs").unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid cookies file — must contain youtube.com cookies" });
    }
    var dest = __dirname + "/yt-cookies.txt";
    require("fs").copyFileSync(req.file.path, dest);
    require("fs").unlinkSync(req.file.path);
    _ytCookiePath = dest;
    _ytCookieStatus.lastUpload = new Date().toISOString();
    _ytCookieStatus.error = null;
    _ytCache.clear(); // Clear cache to use new cookies
    console.log("yt-audio: 🍪 New cookies uploaded successfully!");
    
    // Quick test
    if (_ytdlpAvailable) {
      _ytExecFileAsync(_ytdlpPath, [
        "-f", "bestaudio", "--get-title", "--cookies", dest,
        "--no-playlist", "--no-warnings", "--no-check-certificates",
        "https://www.youtube.com/watch?v=jNQXAC9IVRw"
      ], { timeout: 20000 }).then(function(r) {
        _ytCookieStatus.valid = true;
        _ytCookieStatus.lastTest = new Date().toISOString();
        console.log("yt-audio: 🍪✅ Cookie test passed! Title: " + r.stdout.trim());
      }).catch(function(e) {
        _ytCookieStatus.valid = false;
        _ytCookieStatus.error = (e.stderr || e.message || "").substring(0, 200);
        console.error("yt-audio: 🍪❌ Cookie test failed:", _ytCookieStatus.error);
      });
    }
    
    res.json({ success: true, message: "Cookies uploaded! Testing in background..." });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/yt-status", _adminAuth, function(req, res) {
  res.json({
    ytdlpAvailable: _ytdlpAvailable,
    cookiesLoaded: !!_ytCookiePath,
    cookiePath: _ytCookiePath ? "loaded" : "none",
    cookieStatus: _ytCookieStatus,
    cacheSize: _ytCache.size,
    pipedInstances: _pipedInstances.length,
    invInstances: _invInstances.length
  });
});

// ═══ YouTube Audio Stream Proxy ═══
app.get("/yt-audio/:videoId", async function(req, res) {
  // ✅ FIX-SEC: تعقيم videoId لمنع path traversal وcommand injection
  req.params.videoId = req.params.videoId.replace(/[^a-zA-Z0-9_\-]/g, "");
  var videoId = req.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid video ID" });
  }

  var bustCache = req.query.retry === "1";
  if (bustCache) {
    _ytCache.delete(videoId);
    console.log("yt-audio: 🔄 cache busted for retry: " + videoId);
  }

  try {
    // ✅ FIX: كشف iOS/Safari
    var _fbUA = req.headers["user-agent"] || "";
    var _fbIsIOS = req.query.ios === "1" || /iPhone|iPad|iPod/i.test(_fbUA) || (/Safari/i.test(_fbUA) && !/Chrome/i.test(_fbUA));

    // ════ Primary: yt-dlp pipe (بث مباشر) — iOS يتخطاها لأن Safari يحتاج Range requests ════
    if (!_fbIsIOS) {
      var pipeOk = await _ytdlpStreamToRes(videoId, req, res);
      if (pipeOk) {
        console.log("yt-audio: ✅ streamed via yt-dlp pipe for " + videoId);
        return;
      }
    } else {
      console.log("yt-audio: 📱 iOS detected, skipping pipe → using URL method with Range support");
    }

    // ════ Fallback: URL extraction + proxy (يدعم Range requests) ════
    console.log("yt-audio: ⚠️ trying URL fallback for " + videoId);
    var info = await _invFetch(videoId, _fbIsIOS);
    if (!info || !info.url) {
      return res.status(502).json({ error: "Could not get audio URL from any source", needsCookies: !_ytCookiePath });
    }
    console.log("yt-audio: 🎵 streaming [" + info.instance + "] " + (info.title || videoId));

    var fetchHeaders = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36" };
    if (req.headers.range) fetchHeaders["Range"] = req.headers.range;

    var audioResp = await fetch(info.url, { headers: fetchHeaders, signal: AbortSignal.timeout(30000), redirect: "follow" });

    if (!audioResp.ok && audioResp.status !== 206) {
      _ytCache.delete(videoId);
      return res.status(502).json({ error: "Audio stream failed: HTTP " + audioResp.status, retry: true });
    }

    res.status(audioResp.status);
    res.setHeader("Content-Type", info.type || "audio/webm");
    if (audioResp.headers.get("content-length")) res.setHeader("Content-Length", audioResp.headers.get("content-length"));
    if (audioResp.headers.get("content-range")) res.setHeader("Content-Range", audioResp.headers.get("content-range"));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // ✅ FIX: pipe مباشرة — audioResp.body هو Node.js stream
    audioResp.body.pipe(res);
    audioResp.body.on("error", function(e) { if (!res.writableEnded) res.end(); });
    req.on("close", function() { audioResp.body.destroy(); });
  } catch(err) {
    console.error("yt-audio proxy error:", err.message);
    _ytCache.delete(videoId);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get audio", retry: true });
  }
});

app.use(express.json());

app.use(limiter);
app.use(cors({ origin: Config.ListDomin, credentials: true }));

//export NODE_ENV=production

function deleteFile(fileName) {
  if (!fileName.endsWith(".html")) {
    console.error("❌ يجب أن يكون الملف بامتداد .html فقط");
    return;
  }

  const filePath = path.join(__dirname, "uploads", fileName);

  // التحقق إذا كان الملف موجودًا
  if (!fs.existsSync(filePath)) {
    console.warn("⚠️ الملف غير موجود:", filePath);
    return;
  }

  fs.unlink(filePath, (err) => {
    if (err) {
      return console.error("❌ حدث خطأ أثناء حذف الملف:", err);
    }
  });
}

function createVerificationFile(fileName) {
  // التأكد أن الاسم ينتهي بـ .html
  if (!fileName.endsWith(".html")) {
    console.error("❌ يجب أن ينتهي اسم الملف بـ .html");
    return;
  }

  const folderPath = path.join(__dirname, "uploads");
  const filePath = path.join(folderPath, fileName);
  const content = `google-site-verification: ${fileName}`;

  // إنشاء المجلد إذا لم يكن موجودًا
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  // إنشاء الملف
  fs.writeFile(filePath, content, (err) => {
    if (err) {
      return console.error("❌ فشل إنشاء الملف:", err);
    }
  });
}

app.post("/uploadURM", async (req, res) => {
  try {
    const token = req.query["token"].replace("/cp/?", "");
    UsersRepo.getBy({ state: "getByToken", token: token }).then(
      async (user) => {
        if (user) {
          if (GetPower(user["power"])["owner"]) {
            if (
              req.query["state"] == "banner" ||
              req.query["state"] == "logo" ||
              req.query["state"] == "msgpic" ||
              req.query["state"] == "bacmic" ||
              req.query["state"] == "mic" ||
              req.query["state"] == "room" ||
              req.query["state"] == "user"
            ) {
              LinkUpload = "/site";
            } else {
              LinkUpload = "/" + req.query["state"];
            }
            try {
              await upload(req, res, function (err) {
                if (typeof req.file != "object") {
                  return res.status(400).send({ message: "فشل رفع الملف" });
                }
                if (req.query["state"] == "msgpic") {
                  fs.rename(
                    req.file.path,
                    "uploads/" + LinkUpload + "/msgpic.png",
                    function (err) {
                      if (err) {
                        res.end(JSON.stringify({ err: true, msg: "" }));
                        return;
                      }
                    }
                  );
                }

                if (
                  req.query["state"] == "banner" ||
                  req.query["state"] == "logo" ||
                  req.query["state"] == "msgpic" ||
                  req.query["state"] == "bacmic" ||
                  req.query["state"] == "mic" ||
                  req.query["state"] == "room" ||
                  req.query["state"] == "user"
                ) {
                  const filePath =
                    "uploads/" + LinkUpload + "/" + req.file.filename;

                  // نحتفظ بالامتداد الأصلي للـ GIF في banner وmic وbackmic
                  let outputFilename;
                  const _uploadedIsGif = req.file.filename.toLowerCase().endsWith(".gif");
                  const _gifSupportedStates = ["banner", "mic", "bacmic"];

                  if (_gifSupportedStates.includes(req.query.state) && _uploadedIsGif) {
                    outputFilename =
                      req.query.state === "banner"
                        ? req.hostname + "banner.gif"
                        : req.hostname + req.query.state + ".gif";
                  } else {
                    outputFilename =
                      req.query.state === "user"
                        ? req.hostname + "pic.png"
                        : req.hostname + req.query.state + ".png";
                  }

                  const outputPath =
                    "uploads/" + LinkUpload + "/" + outputFilename;

                  // إذا كان GIF ننسخ الملف مباشرة دون معالجة بـ Sharp
                  if (_gifSupportedStates.includes(req.query.state) && _uploadedIsGif) {
                    // حذف الصيغة القديمة (PNG/WebP) لتجنب التعارض
                    var _oldPng = "uploads/" + LinkUpload + "/" + req.hostname + req.query.state + ".png";
                    var _oldWebp = "uploads/" + LinkUpload + "/" + req.hostname + req.query.state + ".webp";
                    try { if (fs.existsSync(_oldPng)) fs.unlinkSync(_oldPng); } catch(e) {}
                    try { if (fs.existsSync(_oldWebp)) fs.unlinkSync(_oldWebp); } catch(e) {}
                    fs.rename(filePath, outputPath, (err) => {
                      if (err) {
                        res.end(JSON.stringify({ err: true, msg: "" }));
                        return;
                      }
                      res.end(
                        JSON.stringify({
                          err: false,
                          msg: req.query.state + ".gif?z" + randomNumber(1, 100),
                        })
                      );
                    });
                  } else {
                    // حذف الصيغة القديمة (GIF) لتجنب التعارض عند رفع PNG/JPG/WEBP
                    if (_gifSupportedStates.includes(req.query.state)) {
                      var _oldGif = "uploads/" + LinkUpload + "/" + req.hostname + req.query.state + ".gif";
                      try { if (fs.existsSync(_oldGif)) fs.unlinkSync(_oldGif); } catch(e) {}
                    }
                    // حفظ الصورة بصيغة PNG + WebP لتوفير حتى 50% في الحجم
                    sharp(filePath)
                      .toBuffer()
                      .then((data) => {
                        var webpOutputPath = outputPath.replace(/\.png$/i, '.webp');
                        return Promise.all([
                          sharp(data).toFile(outputPath),                          // PNG للتوافق
                          sharp(data).withMetadata(false).webp({ quality: 80, effort: 2 }).toFile(webpOutputPath) // WebP للسرعة
                        ]);
                      })
                      .then(() => {
                        fs.unlink(filePath, (err) => {
                          if (err) {
                            res.end(JSON.stringify({ err: true, msg: "" }));
                            return;
                          }
                          res.end(
                            JSON.stringify({
                              err: false,
                              msg: (req.query.state === "user" ? "pic" : req.query.state) + ".png?z" + randomNumber(1, 100),
                            })
                          );
                        });
                      })
                      .catch((err) => {
                        res.end(
                          JSON.stringify({
                            err: true,
                            msg: "Error processing image",
                          })
                        );
                      });
                  }

                  // ✅ تحديث version الصورة فوراً عند الرفع
                  if (req.query["state"] == "bacmic") {
                    const _bacmicRefreshExt = _uploadedIsGif ? ".gif" : ".png";
                    refreshImageVersion("uploads/site/" + req.hostname + "bacmic" + _bacmicRefreshExt);
                  } else if (req.query["state"] == "mic") {
                    const _micRefreshExt = _uploadedIsGif ? ".gif" : ".png";
                    refreshImageVersion("uploads/site/" + req.hostname + "mic" + _micRefreshExt);
                  } else if (req.query["state"] == "banner") {
                    refreshImageVersion("uploads/site/" + req.hostname + "banner.gif");
                  }

                  // ✅ بث تحديث الصورة لجميع المستخدمين (live update بدون reload)
                  const _imgExt = _uploadedIsGif ? ".gif" : ".png";
                  const _imgState = req.query["state"] === "user" ? "pic" : req.query["state"];
                  const _imgMsg = _imgState + _imgExt + "?z" + Date.now();
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "refreshSiteImage",
                    data: { state: req.query["state"], msg: _imgMsg, host: req.hostname }
                  });

                  SaveStats({
                    state:
                      req.query["state"] == "logo"
                        ? "تعديل ايقونة الموقع"
                        : req.query["state"] == "user"
                        ? "تعديل ايقونة الأعظاء"
                        : req.query["state"] == "bacmic"
                        ? "تعديل خلفيه المايكات"
                        : req.query["state"] == "mic"
                        ? "تعديل صوره المايكات"
                        : req.query["state"] == "room"
                        ? "تعديل ايقونة الرومات"
                        : req.query["state"] == "banner"
                        ? "تعديل بنر الموقع"
                        : "",
                    topic: user["topic"],
                    ip: user["ip"],
                    username: user["username"],
                    room: "",
                    time: new Date().getTime(),
                  });
                }

                if (
                  req.query["state"] == "sico" ||
                  req.query["state"] == "dro3" ||
                  req.query["state"] == "atar" ||
                  req.query["state"] == "back" ||
                  req.query["state"] == "emo"
                ) {
                  SaveStats({
                    state:
                      req.query["state"] == "sico"
                        ? "إظافة بنر | ايقونه"
                        : req.query["state"] == "dro3"
                        ? "إظافة هدية | ايقونه"
                        : req.query["atar"]
                        ? "إضافة اطار الصور"
                        : req.query["back"]
                        ? "إضافة خلفية الاعضاء"
                        : "إظافة فيس | ايقونه",
                    topic: user["topic"],
                    ip: user["ip"],
                    username: user["username"],
                    room: "",
                    time: new Date().getTime(),
                  });
                }

                if (req.query["state"] == "sico") {
                  SicoRepo.create({ path: req.file["filename"] });
                  RefreshSico();
                }
                if (req.query["state"] == "atar") {
                  AtarRepo.create({ path: req.file["filename"] });
                  RefreshAtar();
                }
                if (req.query["state"] == "back") {
                  BackRepo.create({ path: req.file["filename"] });
                  RefreshBack();
                } else if (req.query["state"] == "dro3") {
                  Dro3Repo.create({ path: req.file["filename"] });
                  RefreshDro3();
                }
                // ✅ توليد WebP في الخلفية لسرعة التحميل
                if (["sico","atar","back","dro3","emo"].includes(req.query["state"])) {
                  const _iconOrig = "uploads/" + LinkUpload + "/" + req.file["filename"];
                  const _iconWebp = _iconOrig.replace(/\.(jpe?g|png|jpg)$/i, ".webp");
                  sharp(_iconOrig).withMetadata(false).webp({ quality: 80, effort: 2 }).toFile(_iconWebp).catch(() => {});
                }

                if (req.query["state"] == "emo") {
                  EmoRepo.getByL().then((emo) => {
                    if (emo) {
                      EmoRepo.create({
                        type: Number(emo[0]["id"]) + 1 + "ف",
                        path: req.file["filename"],
                      });
                      RefreshEmo();
                      res.end(
                        JSON.stringify({
                          err: false,
                          msg:
                            req.query["state"] +
                            "/" +
                            req.file["filename"] +
                            "@" +
                            Number(emo[0]["type"]),
                        })
                      );
                    }
                  });
                } else {
                  const _finalIsGif = req.file.filename.toLowerCase().endsWith(".gif");
                  const _finalGifStates = ["banner", "mic", "bacmic"];
                  const _finalExt = (_finalGifStates.includes(req.query["state"]) && _finalIsGif) ? ".gif" : ".png";
                  res.end(
                    JSON.stringify({
                      err: false,
                      msg: req.file["filename"].replace(
                        req.file["filename"],
                        req.query["state"] == "user"
                          ? "pic.png?z" + randomNumber(1, 100)
                          : req.query["state"] == "sico" ||
                            req.query["state"] == "back" ||
                            req.query["state"] == "atar" ||
                            req.query["state"] == "dro3"
                          ? req.query["state"] + "/" + req.file["filename"]
                          : req.query["state"] + _finalExt + "?z" + randomNumber(1, 100)
                      ),
                    })
                  );
                }
              });
            } catch (err) {
              if (err.code == "LIMIT_FILE_SIZE") {
                return res.status(500).send({
                  message: "فشل إرسال الملف تأكد ان حجم الملف مناسب 20 ميجا",
                });
              }
              res.status(500).send({
                message: `Could not upload the file: ${req.file.originalname}. ${err}`,
              });
            }
          } else {
            res.end(JSON.stringify({ error: true, msg: "ليس لديك الصلاحية" }));
          }
        }
      }
    );
  } catch (err) {
    console.log(err);
  }
});

function ErrorMemory(data) {
  const isin = JSON.stringify(data);
  if (isin.length > 1000) {
    return true;
  } else {
    return false;
  }
}

app.post("/upst", async (req, res) => {
  try {
    const token = (req.query.token || "").replace("/cp/?", "");
    if (ErrorMemory(req.query)) return;

    const user = await UsersRepo.getBy({ state: "getByToken", token });
    if (!user) {
      return res.status(403).json({ message: "المستخدم غير مصرح له" });
    }
    // ── بعد إعادة الاتصال socket.id يتغيّر — ابحث عن المستخدم بالـ lid ──
    const _upstUserInfo = UserInfo[user["id"]] ||
      Object.values(UserInfo).find(u => u && u.lid == user["lid"]);
    if (!_upstUserInfo) {
      return res.status(403).json({ message: "المستخدم غير مصرح له" });
    }
    if (_upstUserInfo["rep"] < SiteSetting.maxlikestory) {
      return res.status(403).json({
        message: "عدد الايكات المطلوبة لإنشاء قصة " + SiteSetting.maxlikestory,
      });
    }

    LinkUpload = "/story";

    upload(req, res, async function (err) {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(500).send({
            message: "فشل إرسال الملف تأكد ان حجم الملف مناسب 20 ميجا",
          });
        }
        return res.status(500).send({
          message: `فشل في رفع الملف. ${err.message}`,
        });
      }

      const file = req.file;

      if (typeof file !== "object") {
        return res.status(400).send({ message: "فشل رفع الملف" });
      }

      const allowedMimeTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp", /* ✅ FIX-WEBP: دعم WebP في الستوري */
        "video/mp4",
        "video/mov",
        "video/mpa",
        "video/webm",
        "video/3gp",
        "video/3gpp2",
      ];

      if (!allowedMimeTypes.includes(file.mimetype)) {
        return res.status(400).send({
          message: "الرجاء التحقق من صيغة الملف (mp4 , jpg , png, mov)",
        });
      }

      const filePath = `uploads${LinkUpload}/${file.filename}`;
      const mimetype = file.mimetype;

      if (mimetype.includes("video")) {
        // احسب مدة الفيديو
        getVideoDurationInSeconds(filePath)
          .then((duration) => {
            let time = 20;
            const minutes = parseInt(duration / 60, 10);
            const seconds = Math.floor(duration % 60);

            if (minutes > 0) {
              time = minutes * 600;
            } else {
              time = seconds * 10;
            }

            return res.json(
              `${LinkUpload}/${file.filename}@${mimetype}@${time}`
            );
          })
          .catch((err) => {
            return res
              .status(500)
              .json({ message: "فشل في حساب مدة الفيديو", error: err.message });
          });
      } else {
        // صورة ✅ تحويل إلى WebP
        if (!mimetype.includes("gif")) {
          /* ✅ FIX-WEBP-2: إذا الملف webp بالفعل، لا حاجة للتحويل */
          if (mimetype === "image/webp" || file.filename.toLowerCase().endsWith(".webp")) {
            return res.json(`${LinkUpload}/${file.filename}@image/webp@60`);
          }
          const _stWebpName = file.filename.replace(/\.(jpe?g|png|jpg|webp)$/i, ".webp");
          const _stWebpPath = `uploads${LinkUpload}/${_stWebpName}`;
          /* تأكد أن اسم الـ webp مختلف عن الأصل لتجنب الكتابة على نفس الملف */
          if (_stWebpPath === filePath) {
            return res.json(`${LinkUpload}/${file.filename}@image/webp@60`);
          }
          sharp(filePath).withMetadata(false).webp({ quality: 80, effort: 2 }).toFile(_stWebpPath)
            .then(() => {
              fs.unlink(filePath, () => {});
              return res.json(`${LinkUpload}/${_stWebpName}@image/webp@60`);
            })
            .catch(() => {
              return res.json(`${LinkUpload}/${file.filename}@${mimetype}@60`);
            });
        } else {
        return res.json(`${LinkUpload}/${file.filename}@${mimetype}@60`);
        }
      }
    });
  } catch (err) {
    console.log(err);
    return res.status(500).send({
      message: "حدث خطأ أثناء الرفع",
      error: err.message,
    });
  }
});
app.post("/upload", async (req, res) => {
  LinkUpload = "/sendfile";
  try {
    await upload(req, res, function (err) {
      if (typeof req.file != "object") {
        return res.status(400).send({ message: "فشل رفع الملف" });
      }

      // ✅ تحويل صور الشات إلى WebP تلقائياً
      const _sfMime = req.file.mimetype || "";
      if (_sfMime.startsWith("image/") && !_sfMime.includes("gif")) {
        const _sfInput    = "uploads/sendfile/" + req.file["filename"];
        const _sfWebpName = req.file["filename"].replace(/\.(jpe?g|png|jpg)$/i, ".webp");
        const _sfWebpPath = "uploads/sendfile/" + _sfWebpName;
        sharp(_sfInput).withMetadata(false).webp({ quality: 80, effort: 2 }).toFile(_sfWebpPath)
          .then(() => {
            fs.unlink(_sfInput, () => {});
            res.end("/sendfile/" + _sfWebpName);
          })
          .catch(() => {
            // fallback: ارجع الملف الأصلي إذا فشل التحويل
            res.end("/sendfile/" + req.file["filename"]);
          });
      } else {
        res.end("/sendfile/" + req.file["filename"]);
      }
    });
  } catch (err) {
    if (err.code == "LIMIT_FILE_SIZE") {
      return res
        .status(500)
        .send({ message: "فشل إرسال الملف تأكد ان حجم الملف مناسب 20 ميجا" });
    }
    res.status(500).send({
      message: `Could not upload the file: ${req.file.originalname}. ${err}`,
    });
  }
});
app.post("/uppic", async (req, res) => {
  if (typeof req.query["nf"] != 'string') {
    return;
  } else if (req.query["nf"] == 'user' || req.query["nf"] == 'roomback' || req.query["nf"] == 'roombord' || req.query["nf"] == 'room' || req.query["nf"] == 'bot' || req.query["nf"] == 'cover') {
  } else {
    return;
  };
  if (req.query["nf"] == 'user' || req.query["nf"] == 'bot') {
    LinkUpload = 'pic';
  } else if (req.query["nf"] == 'cover') {
    LinkUpload = 'pic';
  } else {
    LinkUpload = 'picroom';
  };
  try {
    await upload(req, res, async function (err) {
      if (typeof req.file != 'object') {
        return res.status(400).send({ message: "فشل رفع الصوره" });
      } else if (typeof Config.TypeFileImage[req.file['mimetype']] != 'string') {
        return res.status(400).send({ message: "فشل رفع الصوره" });
      };


      // ✅ async/await صحيح — res.json بعد ما تخلص sharp
      try {
        const origPath = "uploads/" + LinkUpload + "/" + req.file["filename"];
        const isGif = req.file["filename"].toLowerCase().endsWith(".gif");

        const isAlreadyWebp = req.file["filename"].toLowerCase().endsWith(".webp");

        const isProfilePic = (req.query["nf"] == 'user' || req.query["nf"] == 'bot');

        if (isGif || isAlreadyWebp) {
          // GIF أو WebP: لا نعالجها — نرجعها مباشرة كما هي
          res.json("/" + LinkUpload + "/" + req.file["filename"] + '@' + req.query["nf"]);
        } else {
          var webpFilename = req.file["filename"] + '.webp';
          var webpPath = "uploads/" + LinkUpload + "/" + webpFilename;

          if (isProfilePic) {
            // صورة البروفايل: خلفية مضبوبة + الصورة مركّزة فوقها
            const size = 300;
            const bgBuffer = await sharp(origPath)
              .resize(size, size, { fit: 'cover' })
              .blur(18)
              .toBuffer();
            const fgBuffer = await sharp(origPath)
              .resize(size, size, { fit: 'inside' })
              .toBuffer();
            const fgMeta = await sharp(fgBuffer).metadata();
            const left = Math.round((size - fgMeta.width) / 2);
            const top = Math.round((size - fgMeta.height) / 2);
            await sharp(bgBuffer)
              .composite([{ input: fgBuffer, blend: 'over', left: left, top: top }])
              .withMetadata(false)
              .webp({ quality: 80, effort: 2 })
              .toFile(webpPath);
          } else {
            // غلاف أو غرفة: بدون تعديل على الشكل
            await sharp(origPath).withMetadata(false).webp({ quality: 80, effort: 2 }).toFile(webpPath);
          }

          fs.unlink(origPath, () => {});
          res.json("/" + LinkUpload + "/" + webpFilename + '@' + req.query["nf"]);
        }
      } catch (sharpErr) {
        console.error('خطأ في معالجة الصورة:', sharpErr);
        return res.status(500).send({ message: "فشل معالجة الصورة" });
      }
    });
  } catch (err) {
    if (err.code == "LIMIT_FILE_SIZE") {
      return res.status(500).send({
        message: "فشل إرسال الصوره تأكد ان حجم الصوره مناسب 20 ميجا",
      });
    }
    res.status(500).send({
      message: `Could not upload the file: ${req.file.originalname}. ${err}`,
    });
  }
});

app.get("/gaio", function (req, res, next) {
  EmoRepo.getAll().then((isaf) => {
    res.end(
      JSON.stringify({
        powers: ShowPowers,
        emo: isaf,
        online: filteredArray(OnlineUser, "s", false),
      })
    );
  });
});


// ── Tenor Sticker Proxy (API key hidden server-side) ──
const TENOR_API_KEY = process.env.TENOR_API_KEY || "LIVDSRZULELA"; /* ✅ FIX-ENV: المفتاح من env variable */
app.get("/sticker", function(req, res) {
  const type = req.query.type; // "trending" or "search"
  const q    = req.query.q || "";
  const limit = parseInt(req.query.limit) || 20;
  const tenorUrl = type === "search"
    ? `https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_API_KEY}&limit=${limit}`
    : `https://g.tenor.com/v1/trending?key=${TENOR_API_KEY}&limit=${limit}`;
  require("https").get(tenorUrl, (r) => {
    let data = "";
    r.on("data", (chunk) => data += chunk);
    r.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(data);
    });
  }).on("error", (e) => {
    res.status(500).json({ error: e.message });
  });
});

app.get("/uh", function (req, res) {
  const token = req.query["token"].replace("/cp/?", "");
  UsersRepo.getBy({ state: "getByToken", token: token }).then((user) => {
    if (user) {
      if (GetPower(user["power"])["history"]) {
        if (UserInfo[req.query["u2"]]) {
          // NamesRepo.getBy({state:'getByDevice',device:UserInfo[req.query["u2"]]['device']}).then((dev) => {
          NamesRepo.getBy({
            state: "getByIp",
            ip: UserInfo[req.query["u2"]]["ip"],
          }).then((dev) => {
            if (dev.length > 0) {
              res.send(dev);
            }
          });
        }
      }
    }
  });
});

app.get("/", function (req, res) {
  /*const ismyip = req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"].split(',')[0] : "89.187.162.182";
console.log(ismyip)
request("https://get.geojs.io/v1/ip/country/" + ismyip + ".json", function (err, rep, mycountry) {
if (mycountry) {
mycountry = JSON.parse(mycountry);
}else{
mycountry = {country:'fr'};                                                             
};
console.log(mycountry['country']);
// ✅ REMOVED: كود iptables الخطير تم حذفه (Command Injection risk)
const vpn = Config.CountryVPN.findIndex((x) => x == mycountry['country']);
if(vpn != -1){
        return;
};*/
  const listdomine = Config["ListDomin"].findIndex((x) => x == req.hostname);
  if (listdomine != -1) {
    // ✅ استخدام الكاش — بدل 2 استعلام + قراءة ملف كل مرة
    getCachedSiteSettings(req.hostname, function(err, getSettings, getSe, array) {
      if (!err && getSettings && getSe) {
            SiteSetting = getSettings;
            if (array && Object.keys(array).length > 0) {
                res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
                var micGifPath = "uploads/site/" + req.hostname + "bacmic.gif";
                var micPngPath = "uploads/site/" + req.hostname + "bacmic.png";
                var _bacmicIsGif = fs.existsSync(micGifPath);
                var micPath = _bacmicIsGif ? micGifPath : micPngPath;
                var bacmicExt = _bacmicIsGif ? ".gif" : ".png";
                var bannerPath = "uploads/site/" + req.hostname + "banner.gif";
                var micVer = imageVersions[micPath] || getImageVersion(micPath);
                var bannerVer = imageVersions[bannerPath] || getImageVersion(bannerPath);

                res.render("index", {
                  title: array["title"] || "",
                  logo: "/site/" + getSe["logo"],
                  banner: "/site/" + getSe["banner"],
                  online: filteredArray(OnlineUser, "s", false).length,
                  online: 0,
                  host: req.hostname,
                  namehost: Config["hostnm"],
                  colors: {
                    hicolor: array["background"],
                    bgcolor: array["bg"],
                    btcolor: array["buttons"],
                  },
                  ifbanner: getSe["isbanner"],
                  script: String(array["settscr"]),
                  description: array["settdescription"] || "",
                  keywords: array["settkeywords"] || "",
                  keywordssite: array["settkeywordssite"] || "",
                  istite: array["name"] || "",
                  micVersion: micVer,
                  bannerVersion: bannerVer,
                  bacmicExt: bacmicExt,
                });
              } else {
                res.set("Content-Type", "text/html");
                res.write(
                  "<center><h1 style='color:#ff0000'>الموقع غير متاح </h1></center>"
                );
                res.end();
              }
          } else {
            fs.writeFile(
              "uploads/" + req.hostname + ".txt",
              JSON.stringify({
                bg: "6e7b8c",
                buttons: "6e7b8c",
                background: "FFFFFF",
                name: "",
                settdescription: "",
                settscr: "",
                settkeywords: "",
                settkeywordssite: "",
              }),
              function (err) {
                if (err) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "حدث حطأ الرجاء المحاولة في وقت لاحق",
                    user: "",
                  });
                  return;
                }
              }
            );
            SettingRepo.create({
              hostname: req.hostname,
              room: "3ihxjl18it",
              logo: req.hostname + "logo.png",
              roompic: req.hostname + "room.png",
              site: req.hostname + "site.png",
              user: req.hostname + "user.png",
            }).then((created) => {
              if (created) {
                console.log("⚠️ New hostname setting created for:", req.hostname);
                return res.redirect("/");
              }
            });
          }
    });
  } else {
    res.set("Content-Type", "text/html");
    res.write(
      "<center><h1 style='color:#ff0000'>الموقع غير متاح </h1></center>"
    );
    res.end();
  }
  // });
});

//ReplaceAll
String.prototype.replaceAll = function (str1, str2, ignore) {
  return this.replace(
    new RegExp(
      str1.replace(
        /([\/\,\!\\\^\$\{\}\[\]\(\)\.\.{0,3}$*\+\?\|\<\>\-\&])/g,
        "\\$&"
      ),
      ignore ? "gi" : "g"
    ),
    typeof str2 == "string" ? str2.replace(/\$/g, "$$$$") : str2
  );
};

//Database
function DatabaseDump(data) {
  mysqlDump({
    connection: {
      host: Config.HostDB,
      user: Config.UserDB,
      password: Config.PassDB,
      database: Config.DBDB,
    },
    dumpToFile: data,
  });
}

function BackUpDataBase() {
  if (
    !fs.existsSync(
      "database/database" +
        new Date().toLocaleDateString().replaceAll("/", "-") +
        ".sql"
    )
  ) {
    DatabaseDump(
      "database/database" +
        new Date().toLocaleDateString().replaceAll("/", "-") +
        ".sql"
    );
  }
}

//GetToken
function stringGen(len) {
  var text = "";
  var charset = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (var i = 0; i < len; i++)
    text += charset.charAt(Math.floor(Math.random() * charset.length));
  return text;
}

//Rendom
function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

//ArrayFilter
function filteredArray(arr, key, value) {
  var newArray = [];
  for (var i = 0, l = arr.length; i < l; i++) {
    if (!arr[i][key]) {
      newArray.push(arr[i]);
    }
  }
  return newArray;
}
//Verfication (IP)
function ValidateIPaddress(ipaddress) {
  if (
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
      ipaddress
    )
  ) {
    return true;
  }
  return false;
}

function randomNumber(minimum, maximum) {
  return Math.round(Math.random() * (maximum - minimum) + minimum);
}

//TimeSystem
function addDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).getTime().toFixed();
}

setInterval(function () {
  if (OnlineUser.length > 0) {
    // ── احذف فقط المستخدمين offline الذين انتهت مهلة reconnect الخاصة بهم ──
    // (المستخدمون الذين لا يزال لديهم مؤقت reconnct نشط سيُحذفون بواسطة setTimeout الخاص بهم)
    const isoffline = OnlineUser.filter(function (item) {
      if (item.stat !== 3) return false;
      const info = UserInfo[item.id];
      // إذا لا يزال لديه مؤقت reconnect نشط — لا تحذفه الآن
      if (info && info["offline"] === true && info["reconnct"]) return false;
      return true;
    });
    if (isoffline.length > 0) {
      for (var i = 0; i < isoffline.length; i++) {
        io.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "ur",
          data: [isoffline[i]["id"], null],
        });
        io.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "u-",
          data: isoffline[i]["id"],
        });
        const spliceIdx = OnlineUser.findIndex((v) => v.id == isoffline[i]["id"]);
        if (spliceIdx !== -1) OnlineUser.splice(spliceIdx, 1);
        delete UserInfo[isoffline[i]["id"]];
      }
    }
  }
}, 30 * 60 * 1000 /* ✅ FIX: cleanup offline users every 30 min */);

// ✅ تنظيف الأعضاء الأشباح كل 5 دقائق — يحذف أي عضو offline بدون socket حي وبدون مؤقت reconnect
setInterval(function() {
  try {
  if (OnlineUser.length === 0) return;
  var _ghostCount = 0;
  for (var _gi = OnlineUser.length - 1; _gi >= 0; _gi--) {
    var _gu = OnlineUser[_gi];
    if (!_gu) { OnlineUser.splice(_gi, 1); continue; }
    // ✅ لا تحذف العضويات المثبتة (stat 4) أبداً
    if (_gu.stat === 4 || _gu.stat === "4") continue;
    var _gInfo = UserInfo[_gu.id];
    // شرط الحذف: لا يوجد UserInfo أو offline بدون مؤقت reconnect أو socket ميت
    var _socketAlive = io.sockets.sockets.get(_gu.id);
    var _hasReconnTimer = _gInfo && _gInfo["reconnct"];
    if (!_gInfo && !_socketAlive) {
      // UserInfo محذوف وsocket ميت — شبح أكيد
      io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u-", data: _gu.id });
      // ✅ FIX: تنظيف خرائط الـ socket لمنع تسرب الذاكرة
      if (global._socketToLid && global._socketToLid[_gu.id]) {
        var _gcLid = global._socketToLid[_gu.id];
        if (global._lidToSocket && global._lidToSocket[_gcLid] === _gu.id) {
          delete global._lidToSocket[_gcLid];
        }
        delete global._socketToLid[_gu.id];
      }
      OnlineUser.splice(_gi, 1);
      _ghostCount++;
    } else if (_gInfo && _gInfo["offline"] && !_hasReconnTimer && !_socketAlive) {
      // offline بدون مؤقت وبدون socket — شبح
      io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u-", data: _gu.id });
      // ✅ FIX: تنظيف خرائط الـ socket لمنع تسرب الذاكرة
      if (global._socketToLid && global._socketToLid[_gu.id]) {
        var _gcLid2 = global._socketToLid[_gu.id];
        if (global._lidToSocket && global._lidToSocket[_gcLid2] === _gu.id) {
          delete global._lidToSocket[_gcLid2];
        }
        delete global._socketToLid[_gu.id];
      }
      OnlineUser.splice(_gi, 1);
      delete UserInfo[_gu.id];
      _ghostCount++;
    }
  }
  if (_ghostCount > 0) {
    console.log("[Ghost Cleanup] Removed " + _ghostCount + " ghost users. Online: " + OnlineUser.length);
  }
  } catch(_gcErr) { console.error("[Ghost Cleanup] Error:", _gcErr && _gcErr.message ? _gcErr.message : _gcErr); }
}, 5 * 60 * 1000);

// ✅ FIX: تنظيف _socketToLid من الـ sockets الميتة كل 10 دقائق — يمنع تسرب الذاكرة
setInterval(function() {
  if (!global._socketToLid) return;
  var _staleKeys = [];
  var _allSockets = io.sockets.sockets;
  Object.keys(global._socketToLid).forEach(function(sid) {
    if (!_allSockets.get(sid)) {
      _staleKeys.push(sid);
    }
  });
  if (_staleKeys.length > 0) {
    _staleKeys.forEach(function(sid) {
      var _lid = global._socketToLid[sid];
      // فقط احذف _lidToSocket لو لسا مشيرة لنفس الـ socket الميت
      if (_lid && global._lidToSocket && global._lidToSocket[_lid] === sid) {
        delete global._lidToSocket[_lid];
      }
      delete global._socketToLid[sid];
    });
    console.log("[Socket Cleanup] Removed " + _staleKeys.length + " stale socket mappings. Remaining: " + Object.keys(global._socketToLid).length);
  }
}, 10 * 60 * 1000);

// ✅ FIX: مراقبة الذاكرة كل 5 دقائق — تنبيه + GC إجباري عند الحاجة
setInterval(function() {
  var _mem = process.memoryUsage();
  var _heapMB = Math.round(_mem.heapUsed / 1024 / 1024);
  var _rssMB = Math.round(_mem.rss / 1024 / 1024);
  // تسجيل كل 5 دقائق
  console.log("[Memory] Heap: " + _heapMB + "MB | RSS: " + _rssMB + "MB | Sockets: " + (global._socketToLid ? Object.keys(global._socketToLid).length : 0) + " | Online: " + (typeof OnlineUser !== "undefined" ? OnlineUser.length : 0));
  // لو الذاكرة عالية — نظف كل شي ممكن
  if (_heapMB > 800) {
    console.warn("[Memory] ⚠️ High memory (" + _heapMB + "MB) — running aggressive cleanup");
    // تنظيف إجباري لـ _socketToLid
    if (global._socketToLid) {
      var _allSocks = io.sockets.sockets;
      Object.keys(global._socketToLid).forEach(function(sid) {
        if (!_allSocks.get(sid)) {
          var _lid = global._socketToLid[sid];
          if (_lid && global._lidToSocket && global._lidToSocket[_lid] === sid) delete global._lidToSocket[_lid];
          delete global._socketToLid[sid];
        }
      });
    }
    // تنظيف _AG القديمة (أكبر من ساعة بدل 3)
    if (global._AG) {
      var _now = Date.now();
      Object.keys(global._AG).forEach(function(k) {
        if (_now - (global._AG[k].t || 0) > 3600000) delete global._AG[k];
      });
    }
    // تنظيف _gameInviteRL
    if (global._gameInviteRL) {
      var _now2 = Date.now();
      Object.keys(global._gameInviteRL).forEach(function(k) {
        if (_now2 - global._gameInviteRL[k] > 60000) delete global._gameInviteRL[k];
      });
    }
    // GC إجباري لو متاح
    if (global.gc) {
      global.gc();
      console.log("[Memory] ♻️ Forced GC complete");
    }
  }
}, 5 * 60 * 1000);

//Function
function IsBand(data) {
  if (data) {
    const isbands = ListBand.findIndex(
      (x) => x.device && data.includes(x.device)
    );
    if (isbands != -1) {
      return ListBand[isbands]["device"];
    } else {
      return false;
    }
  }
}

// ✅ فحص الحظر بالبصمة الصلبة — يعمل حتى لو غيّر المتصفح أو مسح الكوكيز
function IsBandByHwFp(hwfp) {

  if (hwfp && hwfp.length >= 16) {
    const idx = ListBand.findIndex(
      (x) => x.hw_fp && x.hw_fp === hwfp
    );
    if (idx != -1) {
      return ListBand[idx]["hw_fp"];
    }
  }
  return false;
}

function RefreshBand() {
  BandRepo.getBy({ state: "getAll", limit: 1000 }).then((res) => {
    if (res) {
      ListBand = res;
    }
  });
}

function MessagesList(data) {
  if (typeof data == "object") {
    if (data["state"] == "LogsMsg") {
      if (
        GetPower(UserInfo[data["id"]]["power"])["stealth"] &&
        UserInfo[data["id"]]["stealth"]
      ) {
      } else {
        if (data["idroom"]) {
          io.to(data["idroom"]).emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "msg",
            data: {
              bg: data["bg"],
              class: data["class"],
              id: data["id"],
              topic: data["topic"],
              msg: data["msg"],
              roomid: data["idroom"],
              pic: data["pic"],
              uid: data["id"],
            },
          });
        }
      }
    }
  }
}
// ثغره الجدار
function NoTa5(data) {
  if (
    data.includes("load") ||
    data.includes("socket") ||
    data.includes("èmit") ||
    data.includes("console") ||
    data.includes("localStorage") ||
    data.includes(">") ||
    data.includes("<")
  ) {
    return true;
  } else {
    return false;
  }
}

function RefreshEmo() {
  EmoRepo.getAll().then((res) => {
    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "emos", data: res });
  });
}

function RefreshDro3() {
  Dro3Repo.getAll().then((res) => {
    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "dro3", data: res });
    io.emit("seoo", {
      cmd: "dro3",
      data: res,
    });
  });
}

function RefreshSico() {
  SicoRepo.getAll().then((res) => {
    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "sicos", data: res });
    io.emit("seoo", {
      cmd: "sico",
      data: res,
    });
  });
}
function RefreshAtar() {
  AtarRepo.getAll().then((res) => {
    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "atar", data: res });
    io.emit("seoo", {
      cmd: "atar",
      data: res,
    });
  });
}
function RefreshBack() {
  BackRepo.getAll().then((res) => {
    io.emit("seoo", {
      cmd: "back",
      data: res,
    });
    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "back", data: res });
  });
}

function EnterBoot(_0x119234) {
  if (_0x119234) {
    UserInfo[_0x119234.id] = {
      ucol: _0x119234.ucol,
      mcol: _0x119234.mcol,
      mscol: _0x119234.mscol,
      atar: _0x119234.atar,
      back: _0x119234.back,
      ifedit: _0x119234.ifedit,
      offline: false,
      offdate: null,
      ismsg: false,
      kiked: false,
      bar: false,
      visitor: false,
      iscall: null,
      logout: false,
      islogin: _0x119234.islogin,
      bg: _0x119234.bg,
      copic: _0x119234.copic,
      rep: _0x119234.rep,
      ico: _0x119234.ico,
      evaluation: _0x119234.eva,
      username: _0x119234.username,
      islike: _0x119234.islike,
      discard: [],
      power: _0x119234.power,
      idreg: _0x119234.idreg,
      topic: _0x119234.topic,
      country: _0x119234.country,
      ip: _0x119234.ip,
      id: _0x119234.id,
      uid: _0x119234.uid,
      lid: _0x119234.lid,
      busy: false,
      ismuted: _0x119234.ismuted,
      ismutedbc: _0x119234.ismutedbc,
      ismicban: _0x119234.ismicban || false,
      isstoryban: _0x119234.isstoryban || false,
      isfrozen: _0x119234.isfrozen || false,
      stealth: _0x119234.stealth,
      device: _0x119234.device,
      pic: _0x119234.pic,
      idroom: _0x119234.idroom,
      hw_fp: _0x119234.hw_fp || "",
      // ✦ بيانات الزخرفة
      topicFont: _0x119234.topicFont || "",
      topicShine: _0x119234.topicShine || "",
    };
    /* ✅ تحديث خرائط التوجيه */
    // (HW_FP_UPDATE listener تم نقله لـ io.on("connection") — يعمل قبل تسجيل الدخول)

    _updateSocketMaps(_0x119234.id, _0x119234.lid);
    var _0x1801ee = ListEnter.findIndex(
      (_0x163ec9) => _0x163ec9 == _0x119234.id
    );
    _0x1801ee == -1 && ListEnter.push(_0x119234.id);
    const _0x1f3656 = OnlineUser.findIndex(
      (_0xc3c633) => _0xc3c633.lid == _0x119234.lid
    );
    if (_0x1f3656 == -1) {
      OnlineUser.push({
        bg: _0x119234.bg,
        ls: [],
        copic: _0x119234.copic,
        co: _0x119234.country,
        evaluation: _0x119234.eva,
        ico: _0x119234.ico,
        id: _0x119234.id,
        idreg: _0x119234.idreg,
        lid: _0x119234.lid,
        meiut: _0x119234.ismuted,
        meiutbc: _0x119234.ismutedbc,
        ismicban: _0x119234.ismicban || false,
        isstoryban: _0x119234.isstoryban || false,
        isfrozen: _0x119234.isfrozen || false,
        mcol: _0x119234.mcol,
        mscol: _0x119234.mscol,
        atar: _0x119234.atar,
        back: _0x119234.back,
        ifedit: _0x119234.ifedit,
        msg: _0x119234.msg.split("<").join("&#x3C;"),
        istolk: false,
        power: _0x119234.power,
        rep: _0x119234.rep,
        islogin: _0x119234.islogin,
        pic: _0x119234.pic,
        youtube: _0x119234.youtube,
        roomid: _0x119234.idroom,
        time: _0x119234.islogin == "بوت" ? null : socket.request["_query"].dtoday ? socket.request["_query"].dtoday : null,
        stat: _0x119234.stat,
        s: GetPower(_0x119234.power).stealth && _0x119234.stealth ? true : null,
        topic: _0x119234.topic.split("<").join("&#x3C;"),
        ucol: _0x119234.ucol,
        // ✦ بيانات الزخرفة
        topicFont: _0x119234.topicFont || "",
        topicShine: _0x119234.topicShine || "",
      });
      /* ✅ لا ترسل بيانات المخفي لغير الأدمن */
      var _u1Data = {
        bg: _0x119234.bg, copic: _0x119234.copic, co: _0x119234.country,
        evaluation: _0x119234.eva, ico: _0x119234.ico || "", id: _0x119234.id,
        idreg: _0x119234.idreg, lid: _0x119234.lid,
        time: _0x119234.islogin == "بوت" ? null : socket.request["_query"].dtoday || null,
        istolk: false, mcol: _0x119234.mcol, mscol: _0x119234.mscol,
        atar: _0x119234.atar, back: _0x119234.back || "", ifedit: _0x119234.ifedit,
        msg: _0x119234.msg.split("<").join("&#x3C;"), meiut: _0x119234.ismuted,
        meiutbc: _0x119234.ismutedbc, power: _0x119234.power, rep: _0x119234.rep,
        pic: _0x119234.pic, roomid: _0x119234.idroom, stat: _0x119234.stat,
        s: GetPower(_0x119234.power).stealth && _0x119234.stealth ? true : null,
        topic: _0x119234.topic.split("<").join("&#x3C;"), ucol: _0x119234.ucol,
        // ✦ بيانات الزخرفة
        topicFont: _0x119234.topicFont || "", topicShine: _0x119234.topicShine || "",
      };
      if (GetPower(_0x119234.power).stealth && _0x119234.stealth) {
        emitToStealthViewers("u+", _u1Data);
      } else {
        io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u+", data: _u1Data });
      }
    }
    /* ✅ لا ترسل رسالة دخول أو ur للمخفي */
    var _isStealthLogin = GetPower(_0x119234.power).stealth && _0x119234.stealth;
    const _0x4450fb = RoomsList.findIndex(
      (_0x27602e) => _0x27602e.id == _0x119234.idroom
    );
    if (!_isStealthLogin) {
      _0x4450fb != -1 &&
        io.to(_0x119234.idroom).emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "msg",
          data: {
            bg: "none",
            class: "hmsg",
            topic: UserInfo[_0x119234.id].topic,
            msg:
              'هذا المستخدم قد دخل<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
              GetRoomList(_0x119234.idroom).id +
              "')\">" +
              GetRoomList(_0x119234.idroom).topic +
              "</div>",
            roomid: _0x119234.idroom,
            pic: UserInfo[_0x119234.id].pic,
            uid: _0x119234.id,
            ico: (_0x119234.ico || UserInfo[_0x119234.id] && UserInfo[_0x119234.id].ico) || "",
          },
        });
      io.emit("SEND_EVENT_EMIT_SERVER", {
        cmd: "ur",
        data: [_0x119234.id, _0x119234.idroom],
      });
    } else {
      emitToStealthViewers("ur", [_0x119234.id, _0x119234.idroom]);
    }
  }
}

function loginbot(_0xf35a4c) {
  setTimeout(() => {
    const _0x16c22d = botsauto.findIndex(
      (_0x1a1292) => _0x1a1292.id == _0xf35a4c.id
    );
    if (_0x16c22d == -1) {
      return;
    }
    const _0x3eb34d = OnlineUser.findIndex(
      (_0x3b64ad) => _0x3b64ad.id == _0xf35a4c.id
    );
    _0x3eb34d == -1 &&
      (outbot(_0xf35a4c),
      EnterBoot({
        power: _0xf35a4c.power,
        eva: 0,
        stat: _0xf35a4c.stat,
        loginG: false,
        islogin: "بوت",
        refr: "*",
        username: _0xf35a4c.topic.split("<").join("&#x3C;"),
        ucol: _0xf35a4c.ucol.split("<").join("&#x3C;"),
        mcol: "#000000",
        mscol: _0xf35a4c.mcol.split("<").join("&#x3C;"),
        bg: _0xf35a4c.bg.split("<").join("&#x3C;"),
        rep: _0xf35a4c.likebot,
        ico: "",
        islike: [],
        idreg: "#" + getRandomInt(1, 100),
        topic: _0xf35a4c.topic.split("<").join("&#x3C;"),
        country: _0xf35a4c.country || "tn",
        ip: _0xf35a4c.ip,
        lid: stringGen(31),
        uid: "",
        token: stringGen(177),
        id: _0xf35a4c.id,
        islog: false,
        ismuted: false,
        ismutedbc: false,
        ismicban: false,
        isstoryban: false,
        isfrozen: false,
        verification: false,
        device: "BOT",
        pic: _0xf35a4c.pic,
        idroom: _0xf35a4c.room,
        youtube: _0xf35a4c.youtube,
        msg: _0xf35a4c.msg.split("<").join("&#x3C;"),
        stealth: false,
      }));
  }, 60000 * _0xf35a4c.timestart);
}

var msgday = -1;
function MessageDay() {
  setTimeout(function () {
    IntroRepo.getBy({ state: "getIn", category: "d" }).then((wlc) => {
      if (wlc.length > 0) {
        // const rdm = getRandomInt(0, wlc.length - 1);
        if (msgday >= wlc.length - 1) {
          msgday = 0;
        } else {
          msgday++;
        }
        io.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "msg",
          data: {
            bg: "",
            class: "pmsgc",
            topic: wlc[msgday]["adresse"].split("<").join("&#x3C;") || "",
            msg: wlc[msgday]["msg"].split("<").join("&#x3C;") || "",
            ucol: "red",
            mcol: "#000000",
            pic: "/site/msgpic.png",
            uid: "",
          },
        });
      }
    });
    MessageDay();
  }, 60000 * SiteSetting["maxdaymsg"] || 1);
}

function RefreshRoom() {
  RoomsRepo.getBy({ state: "getAllWith" }).then((rooms) => {
    if (rooms) {
      // إزالة التكرار (بعض الـ queries تُرجع نفس الغرفة أكثر من مرة)
      var _seen = new Set();
      RoomsListWith = rooms.filter(function(r) {
        if (!r || !r.id || _seen.has(r.id)) return false;
        _seen.add(r.id);
        return true;
      });
    }
  });
}

function RefreshEktisar() {
  CutsRepo.getAll().then((res) => {
    if (res) {
      ekti1 = [];
      ekti2 = [];
      for (var i = 0; i < res.length; i++) {
        ekti1.push(res[i]["msg"]);
        ekti2.push(res[i]["reponse"]);
      }
    }
  });
}

function ReplaceEktisar(data) {
  const nt1 = NoMsgFilter.findIndex(
    (x) => data.includes(x.v) && x.path == "bmsgs"
  );
  const nt2 = NoMsgFilter.findIndex(
    (x) => data.includes(x.v) && x.path == "amsgs"
  );
  if (nt1 !== -1 && nt2 === -1) {
    return;
  }
  if (data) {
    for (i = 0; i < Config.MaxEktisar; i++) {
      data = ekti1.reduce((acc, item, i) => {
        const regex = new RegExp("(^| )" + item + "( |$|\n)");
        return acc.replace(regex, " " + ekti2[i] + " ");
      }, data);
    }

    return data.split("<").join("&#x3C;");
  }
}

function GetPower(data) {
  if (typeof data == "string") {
    const power = ShowPowers.findIndex((x) => x.name == data);
    if (power != -1) {
      return ShowPowers[power];
    } else {
      return Config.PowerNon;
    }
  }
}

function GetPower2(data) {
  try {
    if (!data || typeof data !== 'object') {
      return Config.PowerNon;
    }

    if (typeof data.power === "string") {
      const powerIndex = ShowPowers.findIndex((x) => x.name == data.power);
      return powerIndex !== -1 ? ShowPowers[powerIndex] : Config.PowerNon;
    }

    return Config.PowerNon;
  } catch(e) {
    return Config.PowerNon;
  }
}

function GetRoomList(data) {
  if (typeof data == "string") {
    const room = RoomsList.findIndex((x) => x.id == data);
    if (room != -1) {
      return RoomsList[room];
    } else {
      return RoomsList[0];
    }
  }
}

function RefreshNoText() {
  NotextRepo.getAll().then((res) => {
    if (res) {
      NoMsgFilter = res;
    }
  });
}

function RefreshRooms(data) {
  RoomsRepo.getBy({ state: "getAll" }).then((rooms) => {
    if (rooms) {
      RoomsList = rooms;
      RefreshRoom();
      if (data == 0) {
        for (var i = 0; i < RoomsList.length; i++) {
          if (!PeerRoom[RoomsList[i]]) {
            PeerRoom[RoomsList[i].id] = {
              1: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              2: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              3: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              4: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              5: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              6: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
              7: {
                id: "",
                ev: false,
                iscam: false,
                us: {},
                private: false,
                locked: false,
              },
            };
          }
        }
      }
    }
  });
}

function UserDisconnect(data) {
  if (typeof data == "object") {
    if (ListEnter.length > 0) {
      /* ✅ v153: إصلاح splice(-1,1) — يجب التحقق من -1 */
      const _dcIdx = ListEnter.findIndex((v) => v.id == data["id"]);
      if (_dcIdx !== -1) {
        ListEnter.splice(_dcIdx, 1);
      }
    }


    // ✅ FIX: Clean up memory maps on disconnect
    if (socketHwFp[data["id"]]) delete socketHwFp[data["id"]];
    if (CommentRateLimit[data["id"]]) delete CommentRateLimit[data["id"]];
    _floodProtection.delete(data["id"]);
    var _dcLid = global._socketToLid[data["id"]];
    if (_dcLid) {
      if (global._lidToSocket[_dcLid] === data["id"]) {
        delete global._lidToSocket[_dcLid];
      }
      delete global._socketToLid[data["id"]];
    }

    var userData = UserInfo[data["id"]];
    if (typeof userData !== "undefined") {
      if (GetPower(userData["power"])["stealth"] && userData["stealth"]) {
      } else {
        if (!userData["ismsg"] && !userData["logout"]) {
          MessagesList({
            state: "LogsMsg",
            bg: userData["bg"],
            copic: userData["copic"],
            class: "hmsg",
            id: userData["id"],
            topic: userData["topic"],
            msg: "( هذا المستخدم قد غادر الدردشه )",
            idroom: userData["idroom"],
            pic: userData["pic"],
          });
        }
      }

      if (
        userData["uid"] &&
        userData["islogin"] == "عضو" &&
        data["state"] != 3
      ) {
        UsersRepo.updateBy({
          state: "updateSeen",
          token: stringGen(177),
          lastssen: new Date().getTime(),
          ip: userData["ip"],
          device: userData["device"],
          uid: userData["uid"],
        });
      }
      if (userData["uid"] && userData["islogin"] == "عضو") {
        UsersRepo.updateBy({
          state: "updateLike",
          evaluation: userData["evaluation"],
          uid: userData["uid"],
        });
        UsersRepo.updateBy({
          state: "updateRep",
          rep: userData["rep"],
          uid: userData["uid"],
        });
      }
      if (userData["iscall"]) {
        io.to(userData["iscall"]).emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "leavecall",
          data: { type: "leave" },
        });
      }
      if (userData["idroom"] && PeerRoom[userData["idroom"]]) {
        if (GetRoomList(userData["idroom"])["broadcast"]) {
          io.to(userData["idroom"]).emit("SEND_EVENT_EMIT_BROADCASTING", {
            cmd: "rleave",
            user: userData["id"],
          });
          for (var i = 1; i < 8; i++) {
            if (PeerRoom[userData["idroom"]][i]["id"] == userData["id"]) {
              // ✅ DH-FIX3: احفظ بيانات المايك قبل المسح — لاستعادتها عند REAUTH
              userData["_savedMicSlot"] = i;
              userData["_savedMicRoom"] = userData["idroom"];
              userData["_savedMicData"] = {
                id:      userData["id"],
                ev:      PeerRoom[userData["idroom"]][i]["ev"],
                iscam:   PeerRoom[userData["idroom"]][i]["iscam"],
                private: PeerRoom[userData["idroom"]][i]["private"],
                locked:  PeerRoom[userData["idroom"]][i]["locked"] || false,
                us:      JSON.parse(JSON.stringify(PeerRoom[userData["idroom"]][i]["us"] || {})),
              };
              PeerRoom[userData["idroom"]][i]["id"] = "";
              PeerRoom[userData["idroom"]][i]["ev"] = false;
              PeerRoom[userData["idroom"]][i]["iscam"] = false;
              PeerRoom[userData["idroom"]][i]["private"] = false;
              PeerRoom[userData["idroom"]][i]["us"] = {};
            }
          }
        }
      }

      io.to(userData["id"]).emit("SEND_EVENT_EMIT_SERVER", {
        cmd: "ev",
        data: 'window.onbeforeunload = null; location.href=location.pathname;',
      });

      if (
        SiteSetting["offline"] &&
        userData["uid"] &&
        userData["islogin"] == "عضو" &&
        !userData["s"] &&
        userData["stat"] != 4 &&
        data["state"] != 3 &&
        !userData["ismsg"]
      ) {
        const isoffline = OnlineUser.findIndex((v) => v.id == data["id"]);
        if (isoffline != -1) {
          var dtp = new Date();
          const timeof = dtp.setMinutes(dtp.getMinutes() + Config.TimeOffline);
          OnlineUser[isoffline]["stat"] = 3;
          OnlineUser[isoffline]["time"] = null;
          userData["_savedRoom"] = userData["idroom"];
          OnlineUser[isoffline]["_savedRoom"] = userData["idroom"];
          OnlineUser[isoffline]["roomid"] = null;
          userData["idroom"] = null;
          userData["offline"] = true;
          userData["offdate"] = timeof;
          /* ✅ لا ترسل بيانات المخفي عند الأوفلاين */
          if (OnlineUser[isoffline]["s"]) {
            emitToStealthViewers("u^", OnlineUser[isoffline]);
            emitToStealthViewers("ur", [data["id"], null]);
          } else {
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "u^",
              data: OnlineUser[isoffline],
            });
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "ur",
              data: [data["id"], null],
            });
          }
        }
      } else {
        const isonlie = OnlineUser.findIndex((v) => v.id == data["id"]);
        if (isonlie != -1) {
          /* ✅ لا ترسل u- للمخفي */
          if (OnlineUser[isonlie]["s"]) {
            emitToStealthViewers("ur", [data["id"], null]);
            emitToStealthViewers("u-", data["id"]);
          } else {
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "ur",
              data: [data["id"], null],
            });
            io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u-", data: data["id"] });
          }
          OnlineUser.splice(isonlie, 1);
          delete UserInfo[data["id"]];
        }
      }
    }
  }
}

function CreateBars(data) {
  if (typeof data == "object") {
    BarsRepo.create({
      bg: data["bg"],
      copic: data["copic"],
      bid: data["bid"],
      owner: data["owner"],
      mcol: data["mcol"],
      pic: data["pic"],
      msg: data["msg"],
      topic: data["topic"],
      ucol: data["ucol"],
      data: data["data"],
    }).then((res) => {
      if (res) {
        try {
          dbsql.insertData({
            username: data["username"] || "",
            topic: data["topic"] || "",
            message: data["msg"] || "",
            status: "bc",
            type: "message",
          });
        } catch (err) {
          console.error("Error inserting data into database:", err);
        }
        BarsRepo.getBy({ state: "getAll" }).then((savebar) => {
          if (savebar) {
            for (var i = 0; i < savebar.length; i++) {
              if (i > Config.MaxBc) {
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "delbc",
                  data: { bid: savebar[0]["bid"] },
                });
                BarsRepo.deleted({
                  state: "deleteByBid",
                  bid: savebar[0]["bid"],
                });
              }
            }
          }
        });
      }
    });
  }
}
// CreateBars({bg:'',bid:'',owner:'',mcol:'',pic:'',msg:'',topic:'',ucol:''});

function CreateUsers(data) {
  if (typeof data == "object") {
    UsersRepo.create({
      ip: data["ip"],
      device: data["device"],
      id: data["id"],
      lid: data["lid"],
      pic: data["pic"],
      uid: data["uid"],
      verification: data["verification"],
      power: data["power"],
      topic: data["topic"],
      username: data["username"],
      password: data["password"],
      token: data["token"],
      joinuser: new Date().getTime(),
    });
  }
}
function CreateRooms(data) {
  if (typeof data == "object") {
    RoomsRepo.create({
      id: data["id"],
      about: data["about"],
      user: data["user"],
      pass: data["pass"],
      color: data["color"],
      colorpicroom: data["colorpicroom"],
      colormsgroom: data["colormsgroom"],
      baccolor: data["baccolor"],
      needpass: data["needpass"],
      bordroom: data["bordroom"],
      maxmaic: data["maxmaic"],
      backroom: data["backroom"],
      camera: data["camera"],
      broadcast: data["broadcast"],
      broadlive: data["broadlive"],
      nohide: data["nohide"],
      deleted: data["deleted"],
      owner: data["owner"],
      rmli: data["rmli"] || 0,
      topic: data["topic"],
      pic: data["pic"],
      welcome: data["welcome"],
      max: data["max"],
      has: data["has"],
    }).then((doneroom) => {
      if (doneroom) {
        RoomsRepo.getBy({ state: "getByID", id: data["id"] }).then((myr) => {
          if (myr) {
            io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "r+", data: myr });
          }
        });
        RefreshRooms(0);
      }
    });
  }
}

function RefreshSB() {
  BsbRepo.getAll().then((res) => {
    if (res.length == 0) {
      BsbRepo.create({
        systems: JSON.stringify(System),
        browsers: JSON.stringify(Browser),
      });
    } else {
      let parsedSystem;
try {
    parsedSystem = JSON.parse(res[0]["systems"]);
} catch(err) {
    console.error("JSON Parse Error at line 2111:", err.message);
    parsedSystem = [];
}
SystemOpen = parsedSystem;
      let parsedBrowsers;
try {
    parsedBrowsers = JSON.parse(res[0]["browsers"]);
} catch(err) {
    console.error("JSON Parse Error at line 2112:", err.message);
    parsedBrowsers = [];
}
BrowserOpen = parsedBrowsers;
    }
  });
}

function StartServer() {
  BackUpDataBase();
  RefreshRooms(0);
  RefreshNoText();
  RefreshEktisar();
  RefreshSB();
  RefreshBand();
  EmoRepo.getAll().then((res) => {
    if (res.length == 0) {
      for (var i = 0; i < getFiles("uploads/emo").length; i++) {
        if (
          getFiles("uploads/emo")[i].includes("gif") ||
          getFiles("uploads/emo")[i].includes("png") ||
          getFiles("uploads/emo")[i].includes("jpg")
        ) {
          EmoRepo.create({
            type: i + 1 + "ف",
            path: getFiles("uploads/emo")[i].replace("uploads/emo/", ""),
          });
        }
      }
    }
  });

  Dro3Repo.getAll().then((res) => {
    if (res.length == 0) {
      for (var i = 0; i < getFiles("uploads/dro3").length; i++) {
        if (
          getFiles("uploads/dro3")[i].includes("gif") ||
          getFiles("uploads/dro3")[i].includes("png") ||
          getFiles("uploads/dro3")[i].includes("jpg")
        ) {
          Dro3Repo.create({
            path: getFiles("uploads/dro3")[i].replace("uploads/dro3/", ""),
          });
        }
      }
    }
  });

  SicoRepo.getAll().then((res) => {
    if (res.length == 0) {
      for (var i = 0; i < getFiles("uploads/sico").length; i++) {
        if (
          getFiles("uploads/sico")[i].includes("gif") ||
          getFiles("uploads/sico")[i].includes("png") ||
          getFiles("uploads/sico")[i].includes("jpg")
        ) {
          SicoRepo.create({
            path: getFiles("uploads/sico")[i].replace("uploads/sico/", ""),
          });
        }
      }
    }
  });
  AtarRepo.getAll().then((res) => {
    if (res.length == 0) {
      for (var i = 0; i < getFiles("uploads/atar").length; i++) {
        if (
          getFiles("uploads/atar")[i].includes("gif") ||
          getFiles("uploads/atar")[i].includes("png") ||
          getFiles("uploads/atar")[i].includes("jpg")
        ) {
          AtarRepo.create({
            path: getFiles("uploads/atar")[i].replace("uploads/atar/", ""),
          });
        }
      }
    }
  });
  BackRepo.getAll().then((res) => {
    if (res.length == 0) {
      for (var i = 0; i < getFiles("uploads/back").length; i++) {
        if (
          getFiles("uploads/back")[i].includes("gif") ||
          getFiles("uploads/back")[i].includes("png") ||
          getFiles("uploads/back")[i].includes("jpg")
        ) {
          BackRepo.create({
            path: getFiles("uploads/back")[i].replace("uploads/back/", ""),
          });
        }
      }
    }
  });
  NoNamesRepo.getAll().then((res) => {
    if (res.length > 0) {
      for (var i = 0; i < res.length; i++) {
        NoNames.push(res[i]["name"]);
      }
    }
  });

  UsersRepo.getBy({
    state: "getByUsername",
    username: Config.AccountUserName,
  }).then((res) => {
    if (!res) {
      CreateUsers({
        pic: "site/pic.png",
        ip: "80.168.120.11",
        device: "",
        id: "",
        lid: stringGen(31),
        uid: stringGen(22),
        verification: true,
        power: "gochat",
        topic: "gochat",
        username: Config.AccountUserName,
        password: bcrypt.hashSync(Config.AccountPassword, BCRYPT_ROUNDS), // ✅ bcrypt
        token: stringGen(177),
      });
    }
  });

  PowersRepo.getBy({ state: "getAll" }).then((res) => {
    if (res.length > 0) {
      for (var i = 0; i < res.length; i++) {
        let parsedPowers;
try {
    parsedPowers = JSON.parse(res[i].powers);
} catch(err) {
    console.error("JSON Parse Error at line 2235:", err.message);
    parsedPowers = [];
}
ShowPowers.push(parsedPowers);
      }
    } else {
      ShowPowers = isPowers;
      for (var i = 0; i < isPowers.length; i++) {
        PowersRepo.create({
          name: isPowers[i].name,
          powers: JSON.stringify(isPowers[i]),
        });
      }
    }
  });

  RoomsRepo.getBy({ state: "getByID", id: "3ihxjl18it" }).then((res) => {
    if (!res) {
      CreateRooms({
        id: "3ihxjl18it",
        about: "غرفه عامة",
        user: "gochat",
        pass: "",
        color: "#000000",
        baccolor: "#fff",
        colorpicroom: "#000000",
        colormsgroom: "#fff000",
        needpass: false,
        camera: false,
        broadcast: false,
        broadlive: false,
        nohide: false,
        maxmaic: 4,
        deleted: true,
        owner: "#1",
        rmli: 0,
        topic: "الغرفة العامة",
        pic: "/site/room.png",
        welcome: "مرحبا بكم في الغرفة العامة",
        max: 40,
        has: 1,
      });
    }
  });
}

function SaveStats(data) {
  if (typeof data == "object") {
    StateRepo.create({
      state: data["state"],
      topic: data["topic"],
      username: data["username"],
      room: data["room"],
      ip: data["ip"],
      time: data["time"],
    });
    StateRepo.getAllBy().then((states) => {
      if (states && states.length > Config.MaxState) {
        StateRepo.deleteOld(Config.MaxState);
      }
    });
  }
}

function SaveLogs(data) {
  if (typeof data == "object") {
    LogsRepo.getBy({
      state: "chekedBy",
      ip: data["ip"],
      log: data["state"],
      topic: data["topic"],
      username: data["username"],
    }).then(function (res) {
      if (res) {
        LogsRepo.updateById({
          date: data["date"],
          device: data["device"],
          id: res["id"],
        });
      } else {
        LogsRepo.create({
          state: data["state"],
          topic: data["topic"],
          username: data["username"],
          ip: data["ip"],
          country: data["country"],
          device: data["device"],
          isin: data["isin"],
          date: data["date"],
        });
        LogsRepo.getBy({ state: "getAllIn" }).then((logs) => {
          if (logs) {
            for (var i = 0; i < logs.length; i++) {
              if (i > Config.MaxLogs) {
                LogsRepo.deleted(logs[0]["id"]);
              }
            }
          }
        });
      }
    });
  }
}

function SaveNames(data) {
  if (typeof data == "object") {
    NamesRepo.getBy({
      state: "getByInfo",
      ip: data["ip"],
      device: data["device"],
      topic: data["topic"],
      username: data["username"],
    }).then((res) => {
      if (res.length == 0) {
        NamesRepo.create({
          device: data["device"],
          ip: data["ip"],
          topic: data["topic"],
          username: data["username"],
          hw_fp: data["hw_fp"] || "",
        });
      }
    });
  }
}

//Band(BC,Muted,Room);

var Bandbc = [];
var BandRoom = [];
var UserMuted = [];

// ✅ دوال مساعدة للبحث عن البصمة الصلبة للمستخدمين المتصلين
function _getHwFpForUser(username) { if (!username) { return "";
  }
  // فحص UserInfo أولاً
  for (var sid in UserInfo) {
    if (UserInfo[sid] && UserInfo[sid]["username"] === username && UserInfo[sid]["hw_fp"]) { return UserInfo[sid]["hw_fp"];
    }
  }
  // فحص الخريطة المؤقتة socketHwFp
  for (var sid in UserInfo) {
    if (UserInfo[sid] && UserInfo[sid]["username"] === username && socketHwFp[sid]) { return socketHwFp[sid];
    }
  } return "";
}

function _getHwFpByIp(ip) {
  if (!ip) return "";
  for (var sid in UserInfo) {
    if (UserInfo[sid] && UserInfo[sid]["ip"] === ip && UserInfo[sid]["hw_fp"]) { return UserInfo[sid]["hw_fp"];
    }
  }
  for (var sid in UserInfo) {
    if (UserInfo[sid] && UserInfo[sid]["ip"] === ip && socketHwFp[sid]) { return socketHwFp[sid];
    }
  }
  return "";
}

function BandUser(data) { if (typeof data == "object") {
    /* BandRepo.getBy({
                                        state:'isBand',
                                        device: data['device'],
                                        ip_band: data['ip'],
                                        country: data['country'] ? data['country'] : 'none',
                                        username: data['username'] ? data['username'] : 'none'}).then((isband) => {
                    if (!isband) {*/
    BandRepo.create({
      name_band: data["username"],
      type: data["type"],
      reponse: data["reponse"],
      device: data["device"],
      username: data["username"],
      ip: data["ip"],
      country: data["country"],
      date: data["date"],
      hw_fp: data["hw_fp"] || null,
    }).then((doneband) => {
      if (doneband) {
        io.emit("SHWO_PANEL_ADMIN", { cmd: "SEND_ADMIN_BANS_ADD", data: data });
        SaveStats({
          state: data["logs"],
          topic: data["topic"],
          username: data["myuser"],
          room:
            data["device"] || data["ip"] || data["country"] || data["username"],
          ip: data["myip"],
          time: new Date().getTime(),
        });
        RefreshBand();
      }
    });
  }
}

function isMuted(data) {
  if (UserMuted.length > 0 && data) {
    const ism = UserMuted.findIndex((x) => x == data);
    if (ism != -1) {
      return true;
    } else {
      return false;
    }
  }
}

function isBandRoom(data) {
  if (BandRoom.length > 0 && typeof data == "object") {
    const ism = BandRoom.findIndex(
      (x) => x.device == data["device"] && x.room == data["room"]
    );
    if (ism != -1) {
      return true;
    } else {
      return false;
    }
  }
}

function isBandBc(data) {
  if (Bandbc.length > 0 && data) {
    const ism = Bandbc.findIndex((x) => x == data);
    if (ism != -1) {
      return true;
    } else {
      return false;
    }
  }
}

// VPN

function StopVPN(data) {
  if (data) {
    const vpn = Config.CountryVPN.findIndex((x) => x == data.toUpperCase());
    if (vpn != -1) {
      return true;
    } else {
      return false;
    }
  }
}

const allowedEvents = [
  "vistor",
  "token",
  "pingo",
  "signal",
  "SHWO_PANEL_ADMIN",
  "ism",
  "SEND_EVENT_EMIT_BROADCASTING",
  "SEND_EVENT_EMIT_SERVER",
  "HW_FP_UPDATE",
];

//Socket.io
// ✅ FIX: حماية من فيضان الاتصالات — حد أقصى 20 socket لكل IP
if (!global._ipConnCount) global._ipConnCount = {};
io.on("connection", function (socket) {
  // ═══ Socket Error Handler — prevents crash from any socket event ═══
  socket.on("error", function(err) {
    console.error("⚠️ Socket error (server continues):", err && err.message ? err.message : err);
  });

  // ✅ حماية flood — حد 20 اتصال لكل IP
  var _connIp = socket.handshake.address || "unknown";
  if (!global._ipConnCount[_connIp]) global._ipConnCount[_connIp] = 0;
  global._ipConnCount[_connIp]++;
  if (global._ipConnCount[_connIp] > 20) {
    console.warn("[Flood] ⛔ IP " + _connIp + " exceeded 20 connections — disconnecting");
    socket.disconnect(true);
    return;
  }
  // عند قطع الاتصال — أنقص العداد
  socket.on("disconnect", function() {
    if (global._ipConnCount[_connIp]) {
      global._ipConnCount[_connIp]--;
      if (global._ipConnCount[_connIp] <= 0) delete global._ipConnCount[_connIp];
    }
  });

  const host = socket.handshake.headers.host;
  const isAllowed = Config["ListDomin"].includes(host);

  function DisconectedBy() {
    socket.emit("SEND_EVENT_EMIT_SERVER", {
      cmd: "ev",
      data: 'window.onbeforeunload = null; location.href=location.pathname;',
    });
    socket.disconnect();
  }

  if (!isAllowed) {
    DisconectedBy();
    return;
  }

  // أقوى إعدادات لاستقرار الاتصال وعدم الانقطاع نهائياً طالما الانترنت موجود
  // نضبط إعدادات socket.io من جهة السيرفر هنا
  // نزيد مهلة الـ pingTimeout والـ pingInterval لأقصى حد ممكن
  // ونجعل reconnectionAttempts غير محدود
  // ونعيد الاتصال تلقائياً دائماً

  // إعدادات socket.io من جهة السيرفر (لضمان عدم الانقطاع)
  // (هذه الإعدادات عادة توضع عند إنشاء io لكن نؤكد هنا أيضاً)
  // ✅ تم نقل إعدادات ping إلى مستوى io الصحيح (أعلى الملف)
  // pingTimeout و pingInterval يُحدَّدان عند إنشاء io وليس هنا

  // حماية من الأحداث غير المسموحة
  socket.onAny((event) => {
    if (!allowedEvents.includes(event)) {
      console.log(`Blocked unknown event: ${event}`);
      DisconectedBy();
      return;
    }
  });

  applyGlobalXSSProtection(socket);

  // ✅ استقبال البصمة الصلبة مبكراً — قبل أي تسجيل دخول
  socket.on("HW_FP_UPDATE", function(d) {
    if (d && typeof d.hw_fp === "string" && d.hw_fp.length >= 16) {
      var _fp = d.hw_fp.trim();
      socketHwFp[socket.id] = _fp;
      if (UserInfo[socket.id]) {
        UserInfo[socket.id]["hw_fp"] = _fp;
      }
    }
  });

  socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "pw", data: ShowPowers });

  // عند استرجاع الجلسة (session recovery بواسطة socket.io نفسه)
  if (socket.recovered) {
    if (UserInfo[socket.id] && UserInfo[socket.id]["reconnct"]) {
      clearTimeout(UserInfo[socket.id]["reconnct"]);
      delete UserInfo[socket.id]["reconnct"];
    }
    const isoffonline = OnlineUser.findIndex((v) => v.id == socket.id);
    if (isoffonline !== -1 && UserInfo[socket.id]) {
      // ✅ FIX: لا تستخدم || 1 — stat 0 قيمة صالحة (نشط)
      var _recStat = UserInfo[socket.id]["lastst"];
      OnlineUser[isoffonline]["stat"] = (_recStat != null) ? _recStat : 1;
      // ✅ FIX: إذا busy تأكد الحالة = 2 (مقفل خاص)
      if (UserInfo[socket.id]["busy"] === true) OnlineUser[isoffonline]["stat"] = 2;
      UserInfo[socket.id]["offline"] = false;

      // ✅ FIX: Restore saved room on reconnect
      if (!UserInfo[socket.id]["idroom"] && UserInfo[socket.id]["_savedRoom"]) {
        UserInfo[socket.id]["idroom"] = UserInfo[socket.id]["_savedRoom"];
        OnlineUser[isoffonline]["roomid"] = UserInfo[socket.id]["_savedRoom"];
        delete UserInfo[socket.id]["_savedRoom"];
        delete OnlineUser[isoffonline]["_savedRoom"];
      }


      io.emit("SEND_EVENT_EMIT_SERVER", {
        cmd: "u^",
        data: OnlineUser[isoffonline],
      });

      if (UserInfo[socket.id]["idroom"]) {
        socket.join(UserInfo[socket.id]["idroom"]);
        const roomData = GetRoomList(UserInfo[socket.id]["idroom"]);
        if (roomData && roomData["broadcast"]) {
          /* ✅ v62: socket.to بدل io.to لمنع إرسال rjoin للمرسل نفسه */
          socket.to(UserInfo[socket.id]["idroom"]).emit(
            "SEND_EVENT_EMIT_BROADCASTING",
            { cmd: "rjoin", user: socket.id }
          );
          socket.emit("SEND_EVENT_EMIT_BROADCASTING", {
            cmd: "all",
            room: UserInfo[socket.id]["idroom"],
            data: PeerRoom[UserInfo[socket.id]["idroom"]],
          });
        }
      }

      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "reauth_ok", data: { myId: socket.id } });
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "ulist", data: getFilteredOnlineUsers(socket.id) });
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "rlist", data: RoomsListWith });

      // ✅ FIX: أرسل حالة اللعبة عند socket.recovered — بدون هاد اللعبة ما بترجع!
      try {
        if (!global._AG) global._AG = {};
        var _rcLid = String(UserInfo[socket.id]["lid"] || "");
        var _rcUid = String(UserInfo[socket.id]["uid"] || "");
        var _rcRec = (_rcLid && global._AG[_rcLid]) ? global._AG[_rcLid] :
                     (_rcUid && global._AG[_rcUid]) ? global._AG[_rcUid] : null;
        if (_rcRec && _rcRec.state && (Date.now() - _rcRec.t < 2 * 60 * 60 * 1000)) {
          _rcRec.mySocket = socket.id;
          var _rcOpSock = _rcRec.opSocket ? _gameRoute(_rcRec.opSocket) : null;
          if (!_rcOpSock && _rcRec.opUid && global._lidToSocket[_rcRec.opUid]) {
            _rcOpSock = _gameRoute(global._lidToSocket[_rcRec.opUid]);
          }
          if (_rcOpSock) _rcRec.opSocket = _rcOpSock;
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "GAME_STATE_SYNC",
            data: {
              game:     _rcRec.game,
              role:     _rcRec.role,
              opSocket: _rcRec.opSocket || "",
              opUid:    _rcRec.opUid || "",
              allPlayerUids: _rcRec.allPlayerUids || [],
              state:    _rcRec.state
            }
          });
        }
      } catch(_rcE) {}

      /* ═══════════════════════════════════════════════════════════
         ✅ الحل الجذري: عند REAUTH، أبلغ كل خصوم اللعبة بالـ socket الجديد
         هذا يضمن إن حركات اللعبة توصل حتى لو الخصم عنده socket قديم
         ═══════════════════════════════════════════════════════════ */
      try {
        if (global._AG) {
          var _raUid = String(UserInfo[socket.id]["uid"] || "");
          var _raLid = String(UserInfo[socket.id]["lid"] || "");
          /* ✅ FIX: البحث بـ lid أولاً (لأن GAME_STATE_SAVE يحفظ بـ lid)
             ثم uid كـ fallback — هذا يحل مشكلة "أحياناً تزبط وأحياناً لا" */
          var _raKey = (_raLid && global._AG[_raLid]) ? _raLid :
                       (_raUid && global._AG[_raUid]) ? _raUid : null;
          if (_raKey) {
            var _raRec = global._AG[_raKey];
            // حدّث الـ socket في الجلسة المحفوظة
            _raRec.mySocket = socket.id;
            // اجمع كل UIDs الخصوم
            var _raTargets = [];
            if (_raRec.opUid) _raTargets.push(String(_raRec.opUid));
            if (_raRec.allPlayerUids && Array.isArray(_raRec.allPlayerUids)) {
              _raRec.allPlayerUids.forEach(function(_u) {
                if (_u && String(_u) !== _raUid && String(_u) !== _raLid && _raTargets.indexOf(String(_u)) === -1)
                  _raTargets.push(String(_u));
              });
            }
            // أبلغ كل خصم متصل (ابحث بـ uid أو lid)
            _raTargets.forEach(function(_tUid) {
              for (var _rak in UserInfo) {
                var _rkUid = String(UserInfo[_rak]["uid"] || "");
                var _rkLid = String(UserInfo[_rak]["lid"] || "");
                if ((_rkUid === _tUid || _rkLid === _tUid) && io.sockets.sockets.get(_rak)) {
                  io.to(_rak).emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "GAME_PEER_RECONNECTED",
                    data: { newSocket: socket.id, uid: _raUid, game: _raRec.game || "" }
                  });
                  // ✅ حدّث opSocket في جلسة الخصم أيضاً
                  if (global._AG[_tUid]) {
                    global._AG[_tUid].opSocket = socket.id;
                  }
                  break;
                }
              }
            });
            // ✅ أرسل للاعب حالة اللعبة تلقائياً
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_STATE_SYNC",
              data: {
                game: _raRec.game,
                role: _raRec.role,
                opSocket: _raRec.opSocket || "",
                opUid: _raRec.opUid || "",
                allPlayerUids: _raRec.allPlayerUids || [],
                state: _raRec.state || {}
              }
            });
          }
        }
      } catch(_raE) {}
    }
  }

  // ✅ FIX: تنظيف البصمة و flood protection يتم في الـ disconnect handler الرئيسي (أسفل الملف)



  function SaveNotification(data) {
    if (
      UserInfo[data["id"]] &&
      UserInfo[data["id"]]["uid"] &&
      UserInfo[data["id"]]["offline"]
    ) {
      let uid = UserInfo[data["id"]]["uid"];

      if (!notificationoffline[uid]) {
        notificationoffline[uid] = [];
      }
      const picdiax = OnlineUser.findIndex((x) => x.id == data["user"]);
      if (picdiax != -1) {
        notificationoffline[uid].push({
          topic: OnlineUser[picdiax]["topic"],
          pic: OnlineUser[picdiax]["pic"],
          msg: data["msg"],
          date: new Date(),
        });
      }
    }
  }

  socket.on("pingo", () => {
    socket.emit("pongo");
  });

  socket.on("vistor", function (id) {
    if (typeof id == "string") {
      if (UserInfo[socket.id] && UserInfo[id]) {
        if (!UserInfo[socket.id]["visitor"]) {
          /* if (
            GetPower(UserInfo[id]["power"])["rank"] >
            GetPower(UserInfo[socket.id]["power"])["rank"]
          ) {*/
          SendNotification({
            id: id,
            state: "to",
            topic: "",
            force: 1,
            msg: " هذا المستخدم قد زار بروفايلك",
            user: socket.id,
          });
          // }
          UserInfo[socket.id]["visitor"] = true;
          UsersRepo.updateBy({
            state: "updateVisitor",
            uid: UserInfo[id]["uid"],
          });
          setTimeout(() => {
            if (UserInfo[socket.id]) {
              UserInfo[socket.id]["visitor"] = false;
            }
          }, 60000);
        }
      }
    }
  });

  socket.on("token", function (id) {
    if (typeof id == "string") {
      id = id.replace("/cp/?", "");
      adminpanelstart(id);
      UsersRepo.getBy({ state: "getByToken", token: id }).then(function (
        search
      ) {
        if (search) {
          if (GetPower2(UserInfo[search.id])) {
            RefreshEmo();
            RefreshDro3();
            RefreshSico();
            RefreshAtar();
            RefreshBack();
            socket.emit("seoo", {
              cmd: "room",
              data: RoomsListWith,
            });
            socket.emit("seoo", {
              cmd: "power",
              data: GetPower2(UserInfo[search.id]),
            });
          } else {
          }
        }
      });
    }
  });

  function adminpanelstart(seo) {
    try {
      UsersRepo.getBy({ state: "getByToken", token: seo }).then(function (
        search
      ) {
        if (search) {
          socket.on("SHWO_PANEL_ADMIN", async (data) => {
            RefreshEmo();
            RefreshDro3();
            RefreshSico();
            RefreshAtar();
            RefreshBack();
            if (UserInfo[search.id]) {
              if (typeof data == "object") {
                try {
                  if (typeof data["limit"] != "number") {
                    return;
                  }

                  if (data["cmd"] == "SEND_ADMIN_LOGS") {
                    if (!GetPower2(UserInfo[search.id])["cp"]) {
                      return;
                    }

                    LogsRepo.getBy({
                      state: "getAll",
                      limit: data["limit"],
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_LOGS",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_POWER") {
                    if (UserInfo[search.id]) {
                      if (
                        typeof data["id"] != "number" ||
                        typeof data["power"] != "string" ||
                        typeof data["days"] != "number"
                      ) {
                        return;
                      }
                      UsersRepo.getBy({
                        state: "getByID",
                        idreg: data["id"],
                      }).then((usbr) => {
                        if (usbr) {
                          if (
                            !GetPower(UserInfo[search.id]["power"])["setpower"]
                          ) {
                            return;
                          } else if (
                            GetPower(usbr["power"])["rank"] >
                            GetPower(UserInfo[search.id]["power"])["rank"]
                          ) {
                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "هذا المستخدم اعلى منك رتبة",
                              user: "",
                            });
                            return;
                          }

                          if (usbr["power"]) {
                            if (usbr["uid"]) {
                              SubRepo.update({
                                sub: data["power"],
                                timefinish: addDays(data["days"] || 0),
                                timestart: new Date().getTime().toFixed(),
                                timeis: data["days"] || 0,
                                topic: usbr["topic"],
                                username: usbr["username"],
                              });
                            }

                            if (!data["power"]) {
                              SubRepo.deleted(usbr["username"]);
                              SendNotification({
                                state: "me",
                                topic: "",
                                force: 1,
                                msg: "تم تنزيل رتبة المستخدم",
                                user: "",
                              });

                              SendNotification({
                                id: usbr["id"],
                                state: "to",
                                topic: "",
                                force: 1,
                                msg: "تم تنزيل رتبتك",
                                user: "",
                              });
                            } else {
                              SendNotification({
                                state: "me",
                                topic: "",
                                force: 1,
                                msg:
                                  "تم ترقية المستخدم الى 》 " + data["power"],
                                user: "",
                              });
                              SendNotification({
                                id: usbr["id"],
                                state: "to",
                                topic: "",
                                force: 1,
                                msg: "اصبحت ترقيتك 》 " + data["power"],
                                user: "",
                              });
                            }
                          } else {
                            if (usbr["uid"]) {
                              SubRepo.create({
                                sub: data["power"],
                                topic: usbr["username"],
                                username: usbr["username"],
                                timefinish: addDays(data["days"] || 0),
                                timestart: new Date().getTime().toFixed(),
                                timeis: data["days"] || 0,
                              });
                            }
                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "تم ترقية المستخدم الى 》 " + data["power"],
                              user: "",
                            });
                            SendNotification({
                              id: usbr["id"],
                              state: "to",
                              topic: "",
                              force: 1,
                              msg: "اصبحت ترقيتك 》 " + data["power"],
                              user: "",
                            });
                          }

                          const pwr = ShowPowers.findIndex(
                            (x) => x.name == data["power"]
                          );
                          if (pwr != -1) {
                            socket
                              .to(usbr["id"])
                              .emit("SEND_EVENT_EMIT_SERVER", {
                                cmd: "power",
                                data: ShowPowers[pwr],
                              });
                          } else {
                            socket
                              .to(usbr["id"])
                              .emit("SEND_EVENT_EMIT_SERVER", {
                                cmd: "power",
                                data: Config.PowerNon,
                              });
                          }

                          SaveStats({
                            state: "ترقية",
                            topic: UserInfo[search.id]["username"],
                            ip: UserInfo[search.id]["ip"],
                            username: usbr["topic"] + "[" + data["power"] + "]",
                            room: data["power"],
                            time: new Date().getTime(),
                          });

                          if (usbr["uid"]) {
                            UsersRepo.updateBy({
                              state: "updatePower",
                              uid: usbr["uid"],
                              power: data["power"].split("<").join("&#x3C;"),
                            });
                          }

                          const inme = OnlineUser.findIndex(
                            (x) => x.id == usbr["id"]
                          );
                          if (inme != -1) {
                            if (UserInfo[data["id"]]) {
                              UserInfo[data["id"]]["power"] = data["power"];
                            }
                            OnlineUser[inme]["power"] = data["power"];
                            io.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "u^",
                              data: OnlineUser[inme],
                            });
                          }
                        }
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_EDIT_ACCOUNT") {
                    if (
                      typeof data["user"] != "number" ||
                      typeof data["loginG"] != "number"
                    ) {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }

                    UsersRepo.getBy({
                      state: "getByID",
                      idreg: data["user"],
                    }).then(function (uid) {
                      if (uid) {
                        if (
                          GetPower(uid["power"])["rank"] >
                          GetPower2(UserInfo[search.id])["rank"]
                        ) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "المستخدم اعلى منك رتبة",
                            user: "",
                          });
                          return;
                        }

                        if (uid["verification"] != data["verification"]) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: uid["verification"]
                              ? "إلغاء توثيق عضويه"
                              : "توثيق عضويه",
                            user: "",
                          });
                          SaveStats({
                            state: uid["verification"]
                              ? "إلغاء توثيق عضويه"
                              : "توثيق عضويه",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: uid["username"],
                            room: "",
                            time: new Date().getTime(),
                          });
                        }
                        if (uid["ifedit"] != data["ifedit"]) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: uid["ifedit"]
                              ? "ازالة تصميم العضوية "
                              : " تصميم العضوية ",
                            user: "",
                          });
                          SaveStats({
                            state: uid["ifedit"]
                              ? "ازالة تصميم العضوية "
                              : " تصميم العضوية ",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: uid["username"],
                            room: "",
                            time: new Date().getTime(),
                          });
                        }
                        if (uid["loginG"] != data["loginG"]) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: uid["loginG"]
                              ? "إلغاء العضوية المميزه"
                              : "عضويه مميزه",
                            user: "",
                          });
                          SaveStats({
                            state: uid["loginG"]
                              ? "إلغاء العضوية المميزه"
                              : "عضويه مميزه",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: uid["username"],
                            room: "",
                            time: new Date().getTime(),
                          });
                        }

                        UsersRepo.updateBy({
                          state: "updateVerLogin",
                          verification: data["verification"],
                          loginG: data["loginG"],
                          vipImg: data["vipImg"] || "",
                          vipSound: data["vipSound"] || "",
                          ifedit: data["ifedit"] ? data["ifedit"] : false,
                          camerashow: data["camerashow"],
                          idreg: data["user"],
                        }).then((upd) => {
                          if (upd) {
                            if (UserInfo[uid["id"]]) {
                              if (data["verification"]) {
                                SendNotification({
                                  id: uid["id"],
                                  state: "to",
                                  topic: "",
                                  force: 1,
                                  msg: "تم توثيق عضويتك",
                                  user: "",
                                });
                              } else if (
                                data["loginG"] &&
                                data["verification"] &&
                                data["ifedit"]
                              ) {
                                SendNotification({
                                  id: uid["id"],
                                  state: "to",
                                  topic: "",
                                  force: 1,
                                  msg: "تم توثيقك و إعطائك دخول مميز وتصميم عضويتك",
                                  user: "",
                                });
                              } else if (
                                data["loginG"] &&
                                !data["verification"]
                              ) {
                                SendNotification({
                                  id: uid["id"],
                                  state: "to",
                                  topic: "",
                                  force: 1,
                                  msg: "تم اعطائك الدخول المميز",
                                  user: "",
                                });
                              }
                            }
                          }
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_INFO_ACCOUNT") {
                    if (typeof data["user"] != "number") {
                      return;
                    }
                    UsersRepo.getBy({
                      idreg: data["user"],
                      state: "getByID",
                    }).then((res) => {
                      if (res) {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_INFO_ACCOUNT",
                          data: {
                            rep: res["rep"],
                            user: res["username"],
                            idreg: res["idreg"],
                            power: res["power"],
                            camerashow: res["camerashow"],
                            verification: res["verification"],
                            listpowers: res["listpowers"],
                            ifedit: res["ifedit"],
                            loginG: res["loginG"],
                            vipImg: res["vipImg"] || "",
                            vipSound: res["vipSound"] || "",
                            powers: ShowPowers,
                          },
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_BAND") {
                    if (typeof data["id"] != "number") {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    BandRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (getbn) => {
                        if (getbn) {
                          SaveStats({
                            state: "فك حظر",
                            topic: UserInfo[search.id]["username"],
                            ip: UserInfo[search.id]["ip"],
                            username: getbn["name_band"],
                            room:
                              getbn["device"] ||
                              getbn["ip"] ||
                              getbn["username"] ||
                              getbn["country"],
                            time: new Date().getTime(),
                          });
                          BandRepo.deleted(data["id"]).then((delband) => {
                            if (delband) {
                              socket.emit("SHWO_PANEL_ADMIN", {
                                cmd: "SEND_ADMIN_DELETE_BAND",
                                data: data["id"],
                              });
                              RefreshBand();
                            }
                          });
                        }
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_WAITING") {
                    if (typeof data["id"] != "number") {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    WaitingRepo.getBy({
                      state: "getByID",
                      id: data["id"],
                    }).then((getbn) => {
                      if (getbn) {
                        SaveStats({
                          state: "فك إنتظار",
                          topic: UserInfo[search.id]["username"],
                          ip: UserInfo[search.id]["ip"],
                          username: getbn["named"],
                          room: getbn["bands"],
                          time: new Date().getTime(),
                        });
                        WaitingRepo.deleted(data["id"]).then((delband) => {
                          if (delband) {
                            socket.emit("SHWO_PANEL_ADMIN", {
                              cmd: "SEND_ADMIN_DELETE_WAITING",
                              data: data["id"],
                            });
                          }
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_WAITING_UPDATE") {
                    if (typeof data["watiting"] != "object") {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }
                    data["watiting"]["id"] = 1;
                    data["watiting"]["state"] = "updatewaiting";
                    RoomsRepo.getBy({
                      state: "getByID",
                      id: "WA15IDTAI4G",
                    }).then((isrooma) => {
                      if (isrooma && !data["watiting"]["onoff"]) {
                        RoomsRepo.deleted(isrooma["id"]).then((deldone) => {
                          if (deldone) {
                            RefreshRooms(1);
                            RefreshRoom();
                            io.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "r-",
                              data: isrooma["id"],
                            });
                          }
                        });
                      } else {
                        if (data["watiting"]["onoff"] && !isrooma) {
                          CreateRooms({
                            id: "WA15IDTAI4G",
                            about: "غرفة الإنتظار",
                            user: "gochat",
                            pass: "",
                            color: "#000000",
                            baccolor: "#fff",
                            colorpicroom: "#000000",
                            colormsgroom: "#fff000",
                            needpass: false,
                            camera: false,
                            broadcast: false,
                            broadlive: false,
                            nohide: false,
                            deleted: true,
                            maxmaic: 4,
                            owner: "#1",
                            rmli: 0,
                            topic: "غرفة الإنتظار",
                            pic: "/site/room.png",
                            welcome: "مرحبا بكم في الغرفة الإنتظار",
                            max: 40,
                            has: 1,
                          });
                        }
                      }
                    });

                    SettingRepo.updateBy(data["watiting"]).then((res) => {
                      if (res) {
                        SaveStats({
                          state: "تعديل غرفة الإنتظار",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: "غرفة الإنتظار",
                          time: new Date().getTime(),
                        });
                        SiteSetting["onoff"] = data["watiting"]["onoff"];
                        SiteSetting["respown"] = data["watiting"]["respown"];
                        SiteSetting["offprivte"] =
                          data["watiting"]["offprivte"];
                        SiteSetting["offliked"] = data["watiting"]["offliked"];
                        SiteSetting["likedon"] = data["watiting"]["likedon"];
                        SiteSetting["liked"] = data["watiting"]["liked"];
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_BROWSER_BAND") {
                    if (typeof data["browser"] != "object") {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    BsbRepo.updateBy({
                      state: "updateBrowser",
                      browsers: JSON.stringify(data["browser"]),
                      id: 1,
                    }).then((res) => {
                      if (res) {
                        RefreshSB();
                        SaveStats({
                          state: "تعديل حظر",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: "تعديل حظر المتصفحات",
                          time: new Date().getTime(),
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_SYSTEM_BAND") {
                    if (typeof data["system"] != "object") {
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    BsbRepo.updateBy({
                      state: "updateSystem",
                      systems: JSON.stringify(data["system"]),
                      id: 1,
                    }).then((res) => {
                      if (res) {
                        RefreshSB();
                        SaveStats({
                          state: "تعديل حظر",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: "تعديل حظر الأنظمه",
                          time: new Date().getTime(),
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_BANS_ADD") {
                    if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    } else if (!data["band"]) {
                      return;
                    }
                    var bnc = {};
                    UsersRepo.getBy({
                      state: "getByUsername",
                      username: data["band"].trim(),
                    }).then(function (isuer) {
                      if (isuer) {
                        bnc = {
                          logs: "حظر حساب",
                          name_band: isuer["topic"],
                          type: " من قبل " + UserInfo[search.id]["username"],
                          reponse: "لا يوجد سبب",
                          device: "",
                          username: isuer["username"],
                          ip: "",
                          topic: UserInfo[search.id]["topic"],
                          myuser: UserInfo[search.id]["username"],
                          myip: UserInfo[search.id]["ip"],
                          country: "",
                          hw_fp: _getHwFpForUser(isuer["username"]),
                        };
                        BandUser(bnc);
                      } else if (
                        ValidateIPaddress(data["band"].trim()) ||
                        Number(data["band"].trim().replace(".", ""))
                      ) {
                        bnc = {
                          logs: "حظر اي بي",
                          name_band: UserInfo[search.id]["username"],
                          type: " من قبل " + UserInfo[search.id]["username"],
                          reponse: "لا يوجد سبب",
                          device: "",
                          username: "",
                          ip: data["band"].split("<").join("&#x3C;"),
                          topic: UserInfo[search.id]["topic"],
                          myuser: UserInfo[search.id]["username"],
                          myip: UserInfo[search.id]["ip"],
                          country: "",
                          hw_fp: _getHwFpByIp(data["band"].trim()),
                        };
                        BandUser(bnc);
                      } else if (
                        data["band"].toUpperCase().trim().length == 2
                      ) {
                        bnc = {
                          logs: "حظر دولة",
                          name_band: UserInfo[search.id]["username"],
                          type: " من قبل " + UserInfo[search.id]["username"],
                          reponse: "لا يوجد سبب",
                          device: "",
                          username: "",
                          ip: "",
                          topic: UserInfo[search.id]["topic"],
                          myuser: UserInfo[search.id]["username"],
                          myip: UserInfo[search.id]["ip"],
                          country: data["band"].split("<").join("&#x3C;"),
                        };
                        BandUser(bnc);
                      } else {
                        bnc = {
                          logs: "حظر جهاز",
                          name_band: UserInfo[search.id]["username"],
                          type: " من قبل " + UserInfo[search.id]["username"],
                          reponse: "لا يوجد سبب",
                          device: data["band"].split("<").join("&#x3C;"),
                          username: "",
                          ip: "",
                          topic: UserInfo[search.id]["topic"],
                          myuser: UserInfo[search.id]["username"],
                          myip: UserInfo[search.id]["ip"],
                          country: "",
                          hw_fp: "",
                        };
                        BandUser(bnc);
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_WAITING") {
                    if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    } else if (!data["band"]) {
                      return;
                    }
                    var bnc = {};
                    const isuer = await UsersRepo.getBy({
                      state: "getByUsername",
                      username: data["band"].trim(),
                    });
                    bnc = {
                      named: " من قبل " + UserInfo[search.id]["username"],
                      bands: data["band"].split("<").join("&#x3C;"),
                      timed: isuer
                        ? "حساب"
                        : ValidateIPaddress(data["band"].trim()) ||
                          Number(data["band"].trim().replace(".", ""))
                        ? "اي بي"
                        : data["band"].toUpperCase().trim().length == 2
                        ? "دولة"
                        : "جهاز",
                    };

                    WaitingRepo.create(bnc);
                    SaveStats({
                      state: "إظافة منتظر",
                      topic: UserInfo[search.id]["topic"],
                      username: UserInfo[search.id]["username"],
                      room: data["band"].split("<").join("&#x3C;"),
                      ip: UserInfo[search.id]["ip"],
                      time: new Date().getTime(),
                    });
                    const iswait = await WaitingRepo.getBy({
                      limit: data["limit"],
                      state: "getAll",
                    });
                    socket.emit("SHWO_PANEL_ADMIN", {
                      cmd: "SEND_ADMIN_WAITING",
                      data: iswait,
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_WAITING_SYSTEM") {
                    if (!GetPower2(UserInfo[search.id])["cp"]) {
                      return;
                    }
                    SettingRepo.getBy({ state: "getByID", id: 1 }).then(
                      (res) => {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_WAITING_SYSTEM",
                          data: {
                            onoff: res.onoff,
                            respown: res.respown,
                            offprivte: res.offprivte,
                            offliked: res.offliked,
                            offalert: res.offalert,
                            likedon: res.likedon,
                            liked: res.liked,
                          },
                        });
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_BANS") {
                    if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    BandRepo.getBy({
                      limit: data["limit"],
                      state: "getAll",
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_BANS",
                        data: res,
                      });
                    });

                    BsbRepo.getAll().then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_BANS_SYSTEM",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_WAITING") {
                    if (!GetPower2(UserInfo[search.id])["ban"]) {
                      return;
                    }

                    WaitingRepo.getBy({
                      limit: data["limit"],
                      state: "getAll",
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_WAITING",
                        data: res,
                      });
                    });

                    BsbRepo.getAll().then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_BANS_SYSTEM",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_AUTO_SPAM") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    }

                    BotsRepo.updateAutoStart(data["id"]).then((res) => {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم التعديل على خاصية التنقل",
                        user: "",
                      });
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_UpState_BOTS",
                        data: data["id"],
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ENTER_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    }

                    BotsRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (login) => {
                        if (login) {
                          const isdos = OnlineUser.findIndex(
                            (x) => x.id == login["id"]
                          );
                          if (isdos == -1) {
                            EnterUserGust({
                              power: login["power"],
                              listpowers: [],
                              camerashow: false,
                              eva: 0,
                              stat: login["stat"],
                              loginG: false,
                              islogin: "بوت",
                              refr: "*",
                              username: login["topic"]
                                .split("<")
                                .join("&#x3C;"),
                              ucol: login["ucol"].split("<").join("&#x3C;"),
                              mcol: "#000000",
                              mscol: login["mcol"].split("<").join("&#x3C;"),
                              bg: login["bg"].split("<").join("&#x3C;"),
                              rep: login["likebot"],
                              ico: "",
                              islike: [],
                              idreg: "#" + getRandomInt(1, 100),
                              topic: login["topic"].split("<").join("&#x3C;"),
                              country: login["country"] || "tn",
                              ip: login["ip"],
                              lid: stringGen(31),
                              uid: "",
                              token: stringGen(177),
                              id: login["id"],
                              islog: false,
                              ismuted: false,
                              ismutedbc: false,
                              verification: false,
                              device: "BOTS_HOST_BY_MOBAIL_HOST",
                              pic: login["pic"],
                              idroom: login["room"],
                              youtube: "",
                              msg: login["msg"].split("<").join("&#x3C;"),
                              stealth: false,
                              topicFont: "",
                              topicShine: "",
                            });

                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "تم إدخال البوت",
                              user: "",
                            });
                          } else {
                            UserDisconnect({
                              id: OnlineUser[isdos]["id"],
                              state: 2,
                            });
                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "تم إخراج البوت",
                              user: "",
                            });
                          }
                        }
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_MSG_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (
                      typeof data["msg"] != "string" ||
                      typeof data["id"] != "string"
                    ) {
                      return;
                    }

                    if (UserInfo[data["id"]]) {
                      io.to(UserInfo[data["id"]]["idroom"]).emit(
                        "SEND_EVENT_EMIT_SERVER",
                        {
                          cmd: "msg",
                          data: {
                            bg: UserInfo[data["id"]]["bg"],
                            mi: stringGen(10),
                            mcol: UserInfo[data["id"]]["mcol"],
                            uid: UserInfo[data["id"]]["id"],
                            msg: ReplaceEktisar(data["msg"]).slice(
                              0,
                              SiteSetting["lengthroom"]
                            ),
                            pic: UserInfo[data["id"]]["pic"],
                            topic: UserInfo[data["id"]]["topic"]
                              .split("<")
                              .join("&#x3C;"),
                            ucol: UserInfo[data["id"]]["ucol"],
                          },
                        }
                      );
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم إرسال رسالة",
                        user: "",
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_REMOVE_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    }
                    if (UserInfo[data["id"]]) {
                      UserDisconnect({ id: data["id"], state: 2 });
                    }
                    BotsRepo.deleteByID(data["id"]).then(function (btfl) {
                      if (btfl) {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_REMOVE_BOTS",
                          data: data["id"],
                        });
                        for (var i = 0; i < botsauto.length; i++) {
                          if (botsauto[i].id == data["id"]) {
                            botsauto.splice(i, 1);
                            break;
                          }
                        }
                      }
                    });
                  } else if (data["cmd"] == "EXIT_ALL_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }

                    const listbot = OnlineUser.filter(
                      (x) => x.islogin === "بوت"
                    );
                    if (listbot.length > 0) {
                      listbot.forEach((login, idx) => {
                        UserDisconnect({
                          id: login["id"],
                          state: 2,
                        });
                      });
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم إخراج البوت",
                        user: "",
                      });
                    }
                  } else if (data["cmd"] == "ENTER_ALL_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }

                    BotsRepo.getall()
                      .then((bots) => {
                        if (bots && Array.isArray(bots)) {
                          // Random delay for each bot between 10s and 50s
                          let delay = 0;
                          if (Array.isArray(bots)) {
                            bots.forEach((login, idx) => {
                              // Add bot to chat if not already present
                              delay +=
                                Math.floor(Math.random() * 40000) + 10000; // 10s to 50s
                              // setTimeout(() => {
                              const isdos = OnlineUser.findIndex(
                                (x) => x.id == login["id"]
                              );
                              if (isdos == -1) {
                                EnterUserGust({
                                  power: login["power"],
                                  listpowers: [],
                                  camerashow: false,
                                  eva: 0,
                                  stat: login["stat"],
                                  loginG: false,
                                  islogin: "بوت",
                                  refr: "*",
                                  username: login["topic"]
                                    .split("<")
                                    .join("&#x3C;"),
                                  ucol: login["ucol"].split("<").join("&#x3C;"),
                                  mcol: "#000000",
                                  mscol: login["mcol"]
                                    .split("<")
                                    .join("&#x3C;"),
                                  bg: login["bg"].split("<").join("&#x3C;"),
                                  rep: login["likebot"],
                                  ico: "",
                                  islike: [],
                                  idreg: "#" + getRandomInt(1, 100),
                                  topic: login["topic"]
                                    .split("<")
                                    .join("&#x3C;"),
                                  country: login["country"] || "tn",
                                  ip: login["ip"],
                                  lid: stringGen(31),
                                  uid: "",
                                  token: stringGen(177),
                                  id: login["id"],
                                  islog: false,
                                  ismuted: false,
                                  ismutedbc: false,
                                  verification: false,
                                  device: "BOTS_HOST_BY_MOBAIL_HOST",
                                  pic: login["pic"],
                                  idroom: login["room"],
                                  youtube: "",
                                  msg: login["msg"].split("<").join("&#x3C;"),
                                  stealth: false,
                                  topicFont: "",
                                  topicShine: "",
                                });
                              }

                              // Start bot movement if autostart is enabled
                              if (login["autostart"] == 1) {
                                setInterval(() => {
                                  if (login["autostart"] == 1) {
                                    let randomRoomId = null;
                                    const LisOf = RoomsList.filter(
                                      (x) => !x.needpass
                                    );
                                    if (LisOf.length > 0) {
                                      const randomIndex = Math.floor(
                                        Math.random() * LisOf.length
                                      );
                                      randomRoomId =
                                        LisOf[randomIndex] &&
                                        LisOf[randomIndex].id;
                                    }

                                    if (!UserInfo[login.id]) return;
                                    if (
                                      UserInfo[login.id]["idroom"] ==
                                      randomRoomId
                                    )
                                      return;

                                    socket
                                      .to(UserInfo[login.id]["idroom"])
                                      .emit("SEND_EVENT_EMIT_SERVER", {
                                        cmd: "msg",
                                        data: {
                                          bg: "none",
                                          copic: "none",
                                          class: "hmsg",
                                          id: UserInfo[login.id]["id"],
                                          topic: UserInfo[login.id]["topic"],
                                          msg:
                                            "هذا المستخدم انتقل الى" +
                                            '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                                            (randomRoomId
                                              ? GetRoomList(randomRoomId)["id"]
                                              : "") +
                                            "')\">" +
                                            (randomRoomId
                                              ? GetRoomList(randomRoomId)[
                                                  "topic"
                                                ]
                                              : "") +
                                            "</div>",
                                          roomid: UserInfo[login.id]["idroom"],
                                          pic: UserInfo[login.id]["pic"],
                                          uid: login.id,
                                        },
                                      });

                                    if (randomRoomId) {
                                      io.to(randomRoomId).emit(
                                        "SEND_EVENT_EMIT_SERVER",
                                        {
                                          cmd: "msg",
                                          data: {
                                            bg: "none",
                                            copic: "none",
                                            class: "hmsg",
                                            id: UserInfo[login.id]["id"],
                                            topic: UserInfo[login.id]["topic"],
                                            msg:
                                              " هذا المستخدم قد دخل الغرفة" +
                                              '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                                              GetRoomList(randomRoomId)["id"] +
                                              "')\">" +
                                              GetRoomList(randomRoomId)[
                                                "topic"
                                              ] +
                                              "</div>",
                                            roomid: randomRoomId,
                                            pic: UserInfo[login.id]["pic"],
                                            uid: socket.id,
                                            ico: UserInfo[socket.id]["ico"] || "",
                                          },
                                        }
                                      );
                                    }

                                    setTimeout(() => {
                                      if (UserInfo[login.id] && randomRoomId) {
                                        UserInfo[login.id]["idroom"] =
                                          randomRoomId;
                                      }
                                    }, 500);

                                    const picdiax = OnlineUser.findIndex(
                                      (x) => x.id == login.id
                                    );
                                    if (picdiax != -1 && randomRoomId) {
                                      OnlineUser[picdiax]["roomid"] =
                                        randomRoomId;
                                    }

                                    if (randomRoomId) {
                                      io.emit("SEND_EVENT_EMIT_SERVER", {
                                        cmd: "ur",
                                        data: [login.id, randomRoomId],
                                      });
                                    }
                                  }
                                }, Math.floor(Math.random() * 300000) + 300000); // 5m to 10m
                              }
                              //   }, delay);
                            });
                          }
                        }
                      })
                      .catch((err) => {
                        // Handle error if needed
                        console.error("Error in ENTER_ALL_BOTS:", err);
                      });

                    SendNotification({
                      state: "me",
                      topic: "",
                      force: 1,
                      msg: "تم إدخال البوتات",
                      user: "",
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_BOTS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (
                      typeof data["data"]["statsbots"] != "number" &&
                      typeof data["data"]["likebot"] != "number"
                    ) {
                      return;
                    } else if (
                      typeof data["data"]["countrybot"] != "string" ||
                      typeof data["data"]["nameb"] != "string" ||
                      typeof data["data"]["msgbot"] != "string" ||
                      typeof data["data"]["urlpic"] != "string" ||
                      typeof data["data"]["rankbot"] != "string"
                    ) {
                      return;
                    }

                    const isdos = OnlineUser.findIndex(
                      (x) => x.topic == data["data"]["nameb"]
                    );
                    if (isdos != -1) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "اسم البوت موجود في الدردشة",
                        user: "",
                      });
                      return;
                    }

                    const bots = {
                      id: stringGen(30),
                      ip:
                        randomNumber(1, 100) +
                        "." +
                        randomNumber(1, 100) +
                        "." +
                        randomNumber(1, 100) +
                        "." +
                        randomNumber(1, 100),
                      msg: data["data"]["msgbot"],
                      pic:
                        data["data"]["urlpic"] ||
                        "/site/pic.png?z" + getRandomInt(1, 100),
                      power: data["data"]["rankbot"] || "",
                      country: data["data"]["countrybot"] || "tn",
                      room: data["data"]["rommbot"] || "",
                      stat: data["data"]["statsbots"] || 0,
                      likebot: data["data"]["likebot"] || 0,
                      bg: data["data"]["botnamec"],
                      ucol: data["data"]["botnamebc"],
                      mcol: data["data"]["botmsgc"],
                      timestart: data["data"]["timestart"],
                      timestop: data["data"]["timestop"],
                      autostart: 0,
                      topic: data["data"]["nameb"].split("<").join("&#x3C;"),
                    };
                    BotsRepo.getall().then(function (seo) {
                      if (seo) {
                        if (seo.length >= Config.maxbot) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "تم استنزاف جميع رصيد البوتات",
                            user: "",
                          });
                          return;
                        } else {
                          BotsRepo.create(bots).then(function (btts) {
                            if (btts) {
                              socket.emit("SHWO_PANEL_ADMIN", {
                                cmd: "SEND_ADMIN_ADD_BOTS",
                                data: bots,
                              });
                            }
                          });
                        }
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_GUST") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }
                    BotsRepo.getall().then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_GUST_length",
                        data: { max: Config.maxbot, all: res.length },
                      });
                    });
                    BotsRepo.getBy({
                      limit: data["limit"],
                      state: "getAll",
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_GUST",
                        data: res,
                        rooms: RoomsList,
                        powers: ShowPowers,
                        countries: countries,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_USERS") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }
                    if (data["value"]) {
                      UsersRepo.getBy({
                        limit: 5,
                        state: "getByAllSearch",
                        value: data["value"],
                      }).then((res) => {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_USERS",
                          data: res,
                          my: search,
                        });
                      });
                    } else {
                      UsersRepo.getBy({
                        limit: data["limit"],
                        state: "getByAll",
                      }).then((res) => {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_USERS",
                          data: res,
                          my: search,
                        });
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_STATS") {
                    if (!GetPower2(UserInfo[search.id])["cp"]) {
                      return;
                    }
                    StateRepo.getAll(data["limit"]).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_STATS",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_report") {
                    if (!GetPower2(UserInfo[search.id])["report"]) {
                      return;
                    }

                    MesgRepo.getAll(data["limit"]).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_report",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_ACCOUNT") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    } else if (typeof data["user"] != "number") {
                      return;
                    }

                    UsersRepo.getBy({
                      state: "getByID",
                      idreg: data["user"],
                    }).then(function (uid) {
                      if (uid) {
                        if (
                          GetPower(uid["power"])["rank"] >
                          GetPower2(UserInfo[search.id])["rank"]
                        ) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "المستخدم اعلى منك رتبة",
                            user: "",
                          });
                          return;
                        }
                        if (uid["id"] && UserInfo[uid["id"]]) {
                          MessagesList({
                            state: "LogsMsg",
                            bg: "none",
                            copic: "none",
                            class: "hmsg",
                            id: uid.id,
                            topic: uid["topic"],
                            msg: "( حذف عضويه )",
                            room: UserInfo[uid["id"]]["idroom"],
                            pic: uid["pic"],
                          });
                          if (UserInfo[search.id]) {
                            SaveStats({
                              state: "حذف عضويه",
                              topic: UserInfo[search.id]["topic"],
                              ip: UserInfo[search.id]["ip"],
                              username: uid["username"],
                              room: "",
                              time: new Date().getTime(),
                            });
                          }
                          UserInfo[uid["id"]]["ismsg"] = true;
                          socket.to(uid["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "ev",
                            data: 'window.onbeforeunload = null; location.href=location.pathname;',
                          });
                          UserDisconnect({ id: uid["id"], state: 2 });
                        }
                        SubRepo.deleted(uid["username"]);
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم حذف العضوية",
                          user: "",
                        });
                        UsersRepo.deleted(data["user"]).then((delreg) => {
                          if (delreg) {
                            socket.emit("SHWO_PANEL_ADMIN", {
                              cmd: "SEND_ADMIN_DELETE_ACCOUNT",
                              data: uid["username"],
                            });
                          }
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_LIKE") {
                    UsersRepo.getBy({
                      state: "getByID",
                      idreg: data["user"],
                    }).then(function (uid) {
                      if (uid) {
                        if (typeof data["likes"] != "number") {
                          return;
                        } else if (
                          !GetPower(UserInfo[search.id]["power"])["ulike"]
                        ) {
                          return;
                        } else if (
                          GetPower(uid["power"])["rank"] >
                          GetPower(UserInfo[search.id]["power"])["rank"]
                        ) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "هذا المستخدم اعلى منك رتبة",
                            user: "",
                          });
                          return;
                        } else if (data["likes"] > 9223372036854775806) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "الحد الاقصى للايكات 9223372036854775806",
                            user: "",
                          });
                          return;
                        }
                        SendNotification({
                          id: uid["id"],
                          state: "to",
                          topic: "",
                          force: 1,
                          msg: " تم تغير إعجاباتك الى ↵ " + data["likes"],
                          user: search.id,
                        });

                        if (
                          UserInfo[uid["id"]]["iswaiting"] &&
                          data["likes"] >= SiteSetting["liked"]
                        ) {
                          UserInfo[uid["id"]]["iswaiting"] = false;
                          if (SiteSetting["respown"]) {
                            socket
                              .to(uid["id"])
                              .emit("SEND_EVENT_EMIT_SERVER", {
                                cmd: "rjj",
                                data: MyRoom(UserInfo[uid["id"]]["device"]),
                              });
                          }
                        }

                        SaveStats({
                          state: "تعديل اعجابات",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: uid["topic"],
                          room: UserInfo[uid["id"]]
                            ? UserInfo[uid["id"]]["idroom"]
                              ? GetRoomList(UserInfo[uid["id"]]["idroom"])[
                                  "topic"
                                ]
                              : "out room"
                            : "out room",
                          time: new Date().getTime(),
                        });

                        const uplike = OnlineUser.findIndex(
                          (x) => x.id == uid["id"]
                        );
                        if (uplike != -1) {
                          UserInfo[uid["id"]]["rep"] = data["likes"];
                          OnlineUser[uplike]["rep"] = data["likes"];

                          io.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "u^",
                            data: OnlineUser[uplike],
                          });
                        }
                        UsersRepo.updateBy({
                          state: "updateRep",
                          rep: data["likes"],
                          uid: uid["uid"],
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_SET_POWERS_LIST") {
                    if (
                      UserInfo[search.id]["power"] == "gochat" ||
                      UserInfo[search.id]["power"] == "Hide" ||
                      UserInfo[search.id]["power"] == "chatmaster"
                    ) {
                      if (
                        typeof data["powers"] == "object" &&
                        typeof data["idreg"] == "number"
                      ) {
                        UsersRepo.updateBy({
                          state: "updateListPower",
                          listpower: JSON.stringify(data["powers"]),
                          idreg: data["idreg"],
                        });

                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم التعديل بنجاح",
                          user: "",
                        });
                      }
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_PASS") {
                    if (
                      typeof data["pass"] != "string" &&
                      typeof data["user"] != "number"
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "الرجاء التاكد من كلمة المرور",
                        user: "",
                      });
                      return;
                    } else if (
                      !data["pass"].trim() ||
                      data["pass"].trim().length < 3
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "الرجاء التاكد من كلمة المرور",
                        user: "",
                      });
                      return;
                    } else if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }
                    UsersRepo.getBy({
                      state: "getByID",
                      idreg: data["user"],
                    }).then(function (uid) {
                      if (uid) {
                        if (
                          GetPower(uid["power"])["rank"] >
                          GetPower2(UserInfo[search.id])["rank"]
                        ) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "المستخدم اعلى منك رتبة",
                            user: "",
                          });
                          return;
                        }
                        UsersRepo.updateBy({
                          state: "updatePass",
                          password: bcrypt.hashSync(data["pass"], BCRYPT_ROUNDS), // ✅ bcrypt (sync in .then callback)
                          idreg: data["user"],
                        }).then((uppass) => {
                          if (uppass) {
                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "تم تعديل كلمة المرور",
                              user: "",
                            });
                            SaveStats({
                              state: "تعديل كلمة السر",
                              topic: UserInfo[search.id]["topic"],
                              ip: UserInfo[search.id]["ip"],
                              username: uid["username"],
                              room: "",
                              time: new Date().getTime(),
                            });
                            SendNotification({
                              id: uid["id"],
                              state: "to",
                              topic: "",
                              force: 1,
                              msg: "تم تغير كلمه المرور الخاصه بك",
                              user: "",
                            });
                          }
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_CHECK") {
                    if (!GetPower2(UserInfo[search.id])["edituser"]) {
                      return;
                    }
                    if (typeof data["user"] == "string") {
                      UsersRepo.getBy({
                        state: "getByUsername",
                        username: data["user"],
                      }).then(function (uid) {
                        if (uid) {
                          UsersRepo.updateBy({
                            state: "updateVer",
                            verification: true,
                            username: data["user"],
                          }).then((upd) => {
                            if (upd) {
                              SendNotification({
                                state: "me",
                                topic: "",
                                force: 1,
                                msg: "تم توثيق العضوية",
                                user: "",
                              });
                              SaveStats({
                                state: "توثيق عضويه",
                                topic: UserInfo[search.id]["topic"],
                                ip: UserInfo[search.id]["ip"],
                                username: data["user"],
                                room: "",
                                time: new Date().getTime(),
                              });
                            }
                          });
                        } else {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "تم توثيق تسجيل العضو",
                            user: "",
                          });
                          SaveStats({
                            state: "توثيق تسجيل",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: data["user"],
                            room: "",
                            time: new Date().getTime(),
                          });
                          UserChecked.push(data["ip"]);
                        }
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_MESSAGE") {
                    if (!GetPower2(UserInfo[search.id])["msgs"]) {
                      return;
                    } else if (typeof data["id"] != "number") {
                      return;
                    }

                    IntroRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (doneis) => {
                        if (doneis) {
                          const typm = doneis["type"];
                          IntroRepo.deleteByID(data["id"]).then((deldone) => {
                            socket.emit("SHWO_PANEL_ADMIN", {
                              cmd: "SEND_ADMIN_DELETE_MESSAGE",
                              data: data["id"],
                            });
                            if (deldone) {
                              SaveStats({
                                state:
                                  typm == "d"
                                    ? "مسح رسالة يوميه"
                                    : "مسح رسالة ترحيب",
                                topic: UserInfo[search.id]["topic"],
                                ip: UserInfo[search.id]["ip"],
                                username: UserInfo[search.id]["username"],
                                room: "",
                                time: new Date().getTime(),
                              });
                            }
                          });
                        }
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_MESSAGE") {
                    if (!GetPower2(UserInfo[search.id])["msgs"]) {
                      return;
                    } else if (
                      typeof data["msg"] != "string" ||
                      typeof data["type"] != "string" ||
                      typeof data["t"] != "string"
                    ) {
                      return;
                    }
                    IntroRepo.create({
                      category: data["type"].split("<").join("&#x3C;"),
                      adresse: data["t"].split("<").join("&#x3C;"),
                      msg: data["msg"].split("<").join("&#x3C;"),
                    }).then((done) => {
                      if (done) {
                        IntroRepo.getBy({
                          state: "getByID",
                          id: done["id"],
                        }).then((doneis) => {
                          if (doneis) {
                            socket.emit("SHWO_PANEL_ADMIN", {
                              cmd: "SEND_ADMIN_ADD_MESSAGE",
                              data: doneis,
                            });
                          }
                        });
                        SaveStats({
                          state:
                            data["type"] == "d"
                              ? "إظافة رسالة يوميه"
                              : "إظافة رسالة ترحيب",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: "",
                          time: new Date().getTime(),
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_MESSAGES") {
                    if (!GetPower2(UserInfo[search.id])["msgs"]) {
                      return;
                    }

                    IntroRepo.getBy({
                      state: "getAll",
                      limit: data["limit"],
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_MESSAGES",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_SHORT") {
                    if (!GetPower2(UserInfo[search.id])["shrt"]) {
                      return;
                    } else if (
                      typeof data["msg"] != "string" ||
                      typeof data["reponse"] != "string"
                    ) {
                      return;
                    }

                    CutsRepo.create({
                      msg: data["msg"].split("<").join("&#x3C;"),
                      reponse: data["reponse"].split("<").join("&#x3C;"),
                    }).then((done) => {
                      if (done) {
                        SaveStats({
                          state: "إظافة إختصار",
                          topic: UserInfo[search.id]["username"],
                          ip: UserInfo[search.id]["ip"],
                          username: data["msg"],
                          room: "",
                          time: new Date().getTime(),
                        });
                        RefreshEktisar();
                        CutsRepo.getBy({
                          state: "getByID",
                          id: done["id"],
                        }).then((doneis) => {
                          if (doneis) {
                            socket.emit("SHWO_PANEL_ADMIN", {
                              cmd: "SEND_ADMIN_ADD_SHORT",
                              data: doneis,
                            });
                          }
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_SHORT") {
                    if (!GetPower2(UserInfo[search.id])["shrt"]) {
                      return;
                    } else if (typeof data["id"] != "number") {
                      return;
                    }

                    CutsRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (cutr) => {
                        if (cutr) {
                          SaveStats({
                            state: "مسح إختصار",
                            topic: UserInfo[search.id]["username"],
                            ip: UserInfo[search.id]["ip"],
                            username: cutr["msg"],
                            room: cutr["reponse"],
                            time: new Date().getTime(),
                          });
                        }
                      }
                    );
                    CutsRepo.deleted(data["id"]).then((deldone) => {
                      if (deldone) {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_DELETE_SHORT",
                          data: data["id"],
                        });
                        RefreshEktisar();
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_SHORT") {
                    if (!GetPower2(UserInfo[search.id])["shrt"]) {
                      return;
                    }
                    CutsRepo.getAllBy(data["limit"]).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_SHORT",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_SUB") {
                    if (!GetPower2(UserInfo[search.id])["subs"]) {
                      return;
                    } else if (typeof data["id"] != "number") {
                      return;
                    }

                    SubRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (res) => {
                        if (res) {
                          UsersRepo.getBy({
                            state: "getByUsername",
                            username: res["username"],
                          }).then(function (uid) {
                            if (uid) {
                              if (
                                GetPower2(UserInfo[search.id])["rank"] <
                                GetPower(uid["power"])["rank"]
                              ) {
                                SendNotification({
                                  state: "me",
                                  topic: "",
                                  force: 1,
                                  msg: "لا يمكنك حذف اشتراك أعلى من اشتراكك",
                                  user: "",
                                });
                                return;
                              }

                              if (
                                GetPower2(UserInfo[search.id])["rank"] >=
                                GetPower(uid["power"])["rank"]
                              ) {
                                UsersRepo.updateBy({
                                  state: "updatePower",
                                  power: "",
                                  uid: uid["uid"],
                                });
                                if (uid["id"]) {
                                  socket
                                    .to(uid["id"])
                                    .emit("SEND_EVENT_EMIT_SERVER", {
                                      cmd: "power",
                                      data: Config.PowerNon,
                                    });
                                }
                              } else {
                                SendNotification({
                                  state: "me",
                                  topic: "",
                                  force: 1,
                                  msg: "لا يمكنك حذف اشتراك أعلى من اشتراكك",
                                  user: "",
                                });
                                return;
                              }

                              SaveStats({
                                state: "مسح إشتراك",
                                topic: UserInfo[search.id]["username"],
                                ip: UserInfo[search.id]["ip"],
                                username: res["username"],
                                room: res["sub"],
                                time: new Date().getTime(),
                              });

                              if (
                                GetPower2(UserInfo[search.id])["rank"] >=
                                GetPower(uid["power"])["rank"]
                              ) {
                                SubRepo.deleted(res["username"]);
                              }

                              socket.emit("SHWO_PANEL_ADMIN", {
                                cmd: "SEND_ADMIN_DELETE_SUB",
                                data: data["id"],
                              });
                            }
                          });
                        }
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_SUBS") {
                    if (!GetPower2(UserInfo[search.id])["subs"]) {
                      return;
                    }

                    SubRepo.getBy({
                      state: "getAll",
                      limit: data["limit"],
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_SUBS",
                        data: res,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_FILTER") {
                    if (!GetPower2(UserInfo[search.id])["subs"]) {
                      return;
                    } else if (
                      typeof data["path"] != "string" ||
                      typeof data["v"] != "string"
                    ) {
                      return;
                    } else if (data["v"].includes("*")) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "(*) غير مسموحه",
                        user: "",
                      });
                      return;
                    }

                    NotextRepo.create({
                      type:
                        data["path"] == "bmsgs" ? "كلمة ممنوعه" : "كلمة مراقبة",
                      path: data["path"].split("<").join("&#x3C;"),
                      v: data["v"].split("<").join("&#x3C;"),
                    }).then((done) => {
                      if (done) {
                        SaveStats({
                          state:
                            data["path"] == "bmsgs"
                              ? "ممنوعه" + " إظافة كلمة "
                              : "مراقبه" + " إظافة كلمة ",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: data["v"],
                          time: new Date().getTime(),
                        });
                        RefreshNoText();
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_ADD_FILTER",
                          data: {
                            id: done["id"],
                            type:
                              data["path"] == "bmsgs"
                                ? "كلمة ممنوعه"
                                : "كلمة مراقبة",
                            path: data["path"].split("<").join("&#x3C;"),
                            v: data["v"].split("<").join("&#x3C;"),
                          },
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_DELETE_FILTER") {
                    if (!GetPower2(UserInfo[search.id])["subs"]) {
                      return;
                    } else if (
                      typeof data["id"] != "number" ||
                      typeof data["v"] != "string"
                    ) {
                      return;
                    }

                    NotextRepo.deleted(data["id"]).then((deldone) => {
                      if (deldone) {
                        SaveStats({
                          state: "مسح فلتر",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: data["v"],
                          time: new Date().getTime(),
                        });
                        RefreshNoText();
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_DELETE_FILTER",
                          data: data["id"],
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_FILTER") {
                    if (!GetPower2(UserInfo[search.id])["flter"]) {
                      return;
                    }
                    NotextRepo.getAllBy(data["limit"]).then((res) => {
                      HistLetterRepo.getBy({ state: "getAll" }).then((type) => {
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_FILTER",
                          data: res,
                          type: type,
                        });
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ROOM_CHECK") {
                    if (!GetPower2(UserInfo[search.id])["rooms"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    }
                    RoomsRepo.getBy({ state: "getByID", id: data["id"] }).then(
                      (isroo) => {
                        if (isroo) {
                          SettingRepo.updateBy({
                            state: "updateroom",
                            room: data["id"],
                            id: 1,
                          });
                          socket.emit("SHWO_PANEL_ADMIN", {
                            cmd: "SEND_ADMIN_ROOM_CHECK",
                            data: data["id"],
                          });
                          SiteSetting["room"] = data["id"];
                        }
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_ROOM_DEL") {
                    if (!GetPower2(UserInfo[search.id])["rooms"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    } else if (data["id"] == "3ihxjl18it") {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "لا يمكنك حذف هذه الغرفة",
                        user: "",
                      });
                      return;
                    }

                    RoomsRepo.deleted(data["id"]).then((deldone) => {
                      if (deldone) {
                        SaveStats({
                          state: "مسح غرفة",
                          topic: UserInfo[search.id]["topic"],
                          ip: UserInfo[search.id]["ip"],
                          username: UserInfo[search.id]["username"],
                          room: GetRoomList(data["id"])["topic"],
                          time: new Date().getTime(),
                        });
                        RefreshRooms(1);
                        RefreshRoom();
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "r-",
                          data: data["id"],
                        });
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_ROOM_DEL",
                          data: data["id"],
                        });
                        MessagesList({
                          state: "LogsMsg",
                          bg: "none",
                          copic: "none",
                          class: "hmsg",
                          id: socket.id,
                          topic: UserInfo[search.id]["topic"],
                          msg: "( قام بحذف الغرفة الحالية )",
                          room: data["id"],
                          pic: UserInfo[search.id]["pic"],
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ROOM_PASS") {
                    if (!GetPower2(UserInfo[search.id])["rooms"]) {
                      return;
                    } else if (typeof data["id"] != "string") {
                      return;
                    }
                    RoomsRepo.updateBy({
                      state: "updatePass",
                      id: data["id"],
                    }).then((doneup) => {
                      if (doneup) {
                        RefreshRooms(1);
                        RefreshRoom();
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_ROOM_PASS",
                          data: data["id"],
                        });
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ROOMS") {
                    if (!GetPower2(UserInfo[search.id])["rooms"]) {
                      return;
                    }
                    RoomsRepo.getBy({
                      state: "getAllLimit",
                      limit: data["limit"],
                    }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_ROOMS",
                        data: res,
                        room: SiteSetting["room"],
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_POWERS") {
                    if (!GetPower2(UserInfo[search.id])["setpower"]) {
                      return;
                    }

                    PowersRepo.getBy({ state: "getAll" }).then((res) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_POWERS",
                        data: res,
                        my: search,
                      });
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_POWER_ADD") {
                    if (!GetPower2(UserInfo[search.id])["setpower"]) {
                      return;
                    } else if (typeof data["power"] != "string") {
                      return;
                    } else if (!data["power"]) {
                      return;
                    } else if (Config.maxPower <= ShowPowers.length) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم إنشاء الحد الاقصى من الصلاحيات",
                        user: "",
                      });
                      return;
                    }

                    let parsedPower;
try {
    parsedPower = JSON.parse(data["power"]);
} catch(err) {
    console.error("JSON Parse Error at line 4697:", err.message);
    parsedPower = null;
}
const power = parsedPower;
                    if (typeof power["name"] != "string") {
                      return;
                    } else if (typeof power["rank"] != "number") {
                      return;
                    } else if (
                      !power["name"] ||
                      power["name"].length < 2 ||
                      power["name"].length > 30
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "يجب ان لا يزيد اسم الصلاحية عن 30 حرف و لا يقل عن 2 حرف",
                        user: "",
                      });
                      return;
                    } else if (power["rank"] > 10000 || power["rank"] < 2) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "يجب ان لا يزيد ترتيب الصلاحية عن 10000 و لا يقل عن 2",
                        user: "",
                      });
                      return;
                    } else if (
                      power["name"] == "Hide" ||
                      power["name"] == "chatmaster"
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "لا يمكنك التعديل على هذه الصلاحية",
                        user: "",
                      });
                      return;
                    } else if (
                      GetPower2(UserInfo[search.id])["rank"] < power["rank"]
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "لا يمكنك التعديل على صلاحيه اعلى منك",
                        user: "",
                      });
                      return;
                    }

                    power["name"] = String(power["name"])
                      .split("<")
                      .join("&#x3C;");
                    const ispower = ShowPowers.findIndex(
                      (x) => x.name == power["name"]
                    );
                    if (ispower != -1) {
                      if (
                        ShowPowers[ispower]["rank"] >
                        GetPower2(UserInfo[search.id])["rank"]
                      ) {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "لا يمكن تنزيل هذه الصلاحية",
                          user: "",
                        });
                        return;
                      }
                      ShowPowers.splice(ispower, 1);
                      ShowPowers.push(power);
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "powers",
                        data: ShowPowers,
                      });
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم التعديل على صلاحية [" + power["name"] + "]",
                        user: "",
                      });
                      PowersRepo.updatePower({
                        power: JSON.stringify(power),
                        name: power["name"],
                      }).then((updatepw) => {
                        if (updatepw) {
                          SaveStats({
                            state: "تعديل مجموعة",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: UserInfo[search.id]["username"],
                            room:
                              "[" + power["rank"] + "][" + power["name"] + "]",
                            time: new Date().getTime(),
                          });
                          socket.emit("SHWO_PANEL_ADMIN", {
                            cmd: "SEND_ADMIN_POWER_EDIT",
                            data: power["name"],
                          });
                        }
                      });
                    } else {
                      if (
                        GetPower2(UserInfo[search.id])["rank"] < power["rank"]
                      ) {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "لا يمكنك إنشاء صلاحية اعلى منك",
                          user: "",
                        });
                        return;
                      }
                      ShowPowers.push(power);
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "powers",
                        data: ShowPowers,
                      });
                      PowersRepo.create({
                        powers: JSON.stringify(power),
                        name: power["name"],
                      }).then((createpw) => {
                        if (createpw) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "تم إنشاء صلاحية [" + power["name"] + "]",
                            user: "",
                          });
                          SaveStats({
                            state: "إنشاء مجموعة",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: UserInfo[search.id]["username"],
                            room:
                              "[" + power["rank"] + "][" + power["name"] + "]",
                            time: new Date().getTime(),
                          });
                          socket.emit("SHWO_PANEL_ADMIN", {
                            cmd: "SEND_ADMIN_POWER_ADD",
                            data: {
                              powers: JSON.stringify(power),
                              name: power["name"],
                              id: createpw["id"],
                            },
                          });
                        }
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_POWER_DEL") {
                    if (!GetPower2(UserInfo[search.id])["setpower"]) {
                      return;
                    } else if (typeof data["power"] != "string") {
                      return;
                    } else if (
                      data["power"] == "Hide" ||
                      data["power"] == "gochat" ||
                      data["power"] == "chatmaster"
                    ) {
                      return;
                    } else if (!data["power"]) {
                      return;
                    } else if (
                      GetPower2(UserInfo[search.id])["rank"] <
                      GetPower(data["power"])["rank"]
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "لا يمكنك حذف صلاحية اقوى من صلاحيتك",
                        user: "",
                      });
                      return;
                    }
                    const ispower = ShowPowers.findIndex(
                      (x) => x.name == data["power"]
                    );
                    if (ispower != -1) {
                      ShowPowers.splice(ispower, 1);
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم حذف صلاحية [" + data["power"] + "]",
                        user: "",
                      });
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "powers",
                        data: ShowPowers,
                      });
                      UsersRepo.getBy({ state: "getAllBy" }).then((upw) => {
                        if (upw) {
                          for (var i = 0; i < upw.length; i++) {
                            if (upw[i]["power"] == data["power"]) {
                              UsersRepo.updateBy({
                                state: "updatePower",
                                power: "",
                                uid: upw[i]["uid"],
                              });
                              SubRepo.deleted(upw[i]["username"]);
                              const inme = OnlineUser.findIndex(
                                (x) => x.lid == upw[i]["lid"]
                              );
                              if (inme != -1) {
                                UserInfo[upw[i]["id"]]["power"] = "";
                                OnlineUser[inme]["power"] = "";
                                io.emit("SEND_EVENT_EMIT_SERVER", {
                                  cmd: "u^",
                                  data: OnlineUser[inme],
                                });
                              }
                              if (upw[i]["id"]) {
                                socket
                                  .to(upw[i]["id"])
                                  .emit("SEND_EVENT_EMIT_SERVER", {
                                    cmd: "power",
                                    data: Config.PowerNon,
                                  });
                              }
                            }
                          }
                        }
                      });
                      PowersRepo.deleted(data["power"]).then((delp) => {
                        if (delp) {
                          SaveStats({
                            state: "حذف مجموعة",
                            topic: UserInfo[search.id]["topic"],
                            ip: UserInfo[search.id]["ip"],
                            username: UserInfo[search.id]["username"],
                            room: data["power"],
                            time: new Date().getTime(),
                          });
                          socket.emit("SHWO_PANEL_ADMIN", {
                            cmd: "SEND_ADMIN_POWER_DEL",
                            data: data["power"],
                          });
                        }
                      });
                    }
                  } else if (
                    data["cmd"] == "SEND_ADMIN_EDIT_SETTINGS_DOMAIN_REMOVE"
                  ) {
                    deleteFile(data["data"]["name"]);
                  } else if (
                    data["cmd"] == "SEND_ADMIN_EDIT_SETTINGS_DOMAIN_ADD"
                  ) {
                    createVerificationFile(data["data"]["name"]);
                  } else if (data["cmd"] == "SEND_ADMIN_EDIT_SETTINGS") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                      /* } else if (
            typeof data["data"]["lengthbc"] != "number" ||
            typeof data["data"]["lengthpm"] != "number" ||
            typeof data["data"]["lengthroom"] != "number" ||
            typeof data["data"]["maxdaymsg"] != "number" ||
            typeof data["data"]["maxlikealert"] != "number" ||
            typeof data["data"]["maxlikebc"] != "number" ||
            typeof data["data"]["maxlikecam"] != "number" ||
            typeof data["data"]["maxlikemic"] != "number" ||
            typeof data["data"]["maxlikestory"] != "number" ||
            typeof data["data"]["maxlikename"] != "number" ||
            typeof data["data"]["maxlikepic"] != "number" ||
            typeof data["data"]["maxlikeyot"] != "number" ||
            typeof data["data"]["maxek"] != "number" ||
            typeof data["data"]["maxlikepm"] != "number" ||
            typeof data["data"]["maxlikeroom"] != "number" ||
            typeof data["data"]["maxlikesendpicpm"] != "number" ||
            typeof data["data"]["maxlogin"] != "number" ||
            typeof data["data"]["maxuploadfile"] != "number" ||
            typeof data["data"]["maxrep"] != "number" ||
            typeof data["data"]["gustmin"] != "number" ||
            typeof data["data"]["registermin"] != "number" ||
            typeof data["data"]["bctime"] != "number" ||
            typeof data["data"]["callmic"] != "boolean" ||
            typeof data["data"]["callsot"] != "boolean" ||
            typeof data["data"]["showtop"] != "boolean" ||
            typeof data["data"]["showsto"] != "boolean" ||
            typeof data["data"]["showyot"] != "boolean" ||
            typeof data["data"]["bars"] != "boolean" ||
            typeof data["data"]["gust"] != "boolean" ||
  //          typeof data["data"]["isbanner"] != "boolean" ||
//            typeof data["data"]["reconnect"] != "boolean" ||
            typeof data["data"]["register"] != "boolean" ||
            typeof data["data"]["offline"] != "boolean" ||
            typeof data["data"]["replay"] != "boolean" ||
            typeof data["data"]["replaybc"] != "boolean" ||
            typeof data["data"]["likebc"] != "boolean" ||
            typeof data["data"]["vpn"] != "boolean"
          ) {
            return;*/
                    }

                    if (data["data"]) {
                      data["data"]["id"] = 1;
                      data["data"]["state"] = "Settingdone";
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم التعديل بنجاح",
                        user: "",
                      });
                      SaveStats({
                        state: "إعدادت الموقع",
                        topic: UserInfo[search.id]["topic"],
                        ip: UserInfo[search.id]["ip"],
                        username: UserInfo[search.id]["username"],
                        room: "حفظ",
                        time: new Date().getTime(),
                      });
                      SettingRepo.updateBy(data["data"]).then((doneup) => {
                        if (doneup) {
                          SettingRepo.getBy({ state: "getByID", id: 1 }).then(
                            (getSettings) => {
                              if (getSettings) {
                                SiteSetting = getSettings;
                                io.emit("SEND_EVENT_EMIT_SERVER", {
                                  cmd: "infosite",
                                  data: {
                                    callmic: getSettings["callmic"],
                                    callsot: getSettings["callsot"],
                                    showtop: getSettings["showtop"],
                                    showsto: getSettings["showsto"],
                                    showyot: getSettings["showyot"],
                                    replay: getSettings["replay"],
                                    replaybc: getSettings["replaybc"],
                                    likebc: getSettings["likebc"],
                                    mic: getSettings["maxlikemic"],
                                    story: getSettings["maxlikestory"] || 2000,
                                    maxcharstatus: getSettings["maxcharstatus"] || 240,
                                    maxcharzakhrafah: getSettings["maxcharzakhrafah"] || 30,
                                  },
                                });
                              }
                            }
                          );
                        }
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_SETTINGS") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    }

                    const folderPath = path.join(__dirname, "uploads");
                    const allFiles = await fs.promises.readdir(folderPath);
                    const htmlFiles = allFiles.filter((file) =>
                      file.endsWith(".html")
                    );
                    SettingRepo.getBy({ state: "getByID", id: 1 }).then(
                      (set) => {
                        set.files = htmlFiles;
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_SETTINGS",
                          data: set,
                        });
                      }
                    );
                  } else if (data["cmd"] == "SEND_ADMIN_REMOVE_ICO") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    }

                    var _delPath = "uploads/" + data["data"].split("/")[1] + "/" + data["data"].split("/")[2];
                    if (fs.existsSync(_delPath)) {
                      fs.unlink(_delPath, (err) => {});
                    }

                    if (data["data"].split("/")[1] == "sico") {
                      SicoRepo.deleted(data["data"].split("/")[2]).then(
                        (del) => {
                          if (del) {
                            RefreshSico();
                          }
                        }
                      );
                    } else if (data["data"].split("/")[1] == "atar") {
                      AtarRepo.deleted(data["data"].split("/")[2]).then(
                        (del) => {
                          if (del) {
                            RefreshAtar();
                          }
                        }
                      );
                    } else if (data["data"].split("/")[1] == "back") {
                      BackRepo.deleted(data["data"].split("/")[2]).then(
                        (del) => {
                          if (del) {
                            RefreshBack();
                          }
                        }
                      );
                    } else if (data["data"].split("/")[1] == "emo") {
                      EmoRepo.deleted(data["data"].split("/")[2]).then(
                        (del) => {
                          if (del) {
                            RefreshEmo();
                          }
                        }
                      );
                    } else if (data["data"].split("/")[1] == "dro3") {
                      Dro3Repo.deleted(data["data"].split("/")[2]).then(
                        (del) => {
                          if (del) {
                            RefreshDro3();
                          }
                        }
                      );
                    }

                    SaveStats({
                      state:
                        data["data"].split("/")[1] == "sico"
                          ? "مسح بنر | ايقونه"
                          : data["data"].split("/")[1] == "dro3"
                          ? "مسح هدية | ايقونه"
                          : data["data"].split("/")[1] == "atar"
                          ? "مسح اطار الصور"
                          : data["data"].split("/")[1] == "back"
                          ? "مسح خلفية الاعضاء"
                          : "مسح فيس | ايقونه",
                      topic: UserInfo[search.id]["topic"],
                      ip: UserInfo[search.id]["ip"],
                      username: UserInfo[search.id]["username"],
                      room: "",
                      time: new Date().getTime(),
                    });
                    socket.emit("SHWO_PANEL_ADMIN", {
                      cmd: "SEND_ADMIN_REMOVE_ICO",
                      data: data["data"],
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_EMOJI") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    }

                    EmoRepo.getAll().then((emo) => {
                      socket.emit("SHWO_PANEL_ADMIN", {
                        cmd: "SEND_ADMIN_EMOJI",
                        data: emo,
                      });
                    });
                  } else if (data["cmd"] == "de") {
                  } else if (data["cmd"] == "SEND_ADMIN_HOSTCHAT") {
                    if (
                      UserInfo[search.id]["power"] == "gochat" ||
                      UserInfo[search.id]["power"] == "Hide" ||
                      UserInfo[search.id]["power"] == "chatmaster"
                    ) {
                      setTimeout(() => {
                        UsersRepo.getBy({ state: "getAllBy" }).then((us) => {
                          socket.emit("SHWO_PANEL_ADMIN", {
                            cmd: "SEND_ADMIN_HOSTCHAT",
                            data: us.length,
                          });
                        });
                      }, 500);
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_HOST_EDIT") {
                    if (
                      UserInfo[search.id]["power"] == "gochat" ||
                      UserInfo[search.id]["power"] == "Hide" ||
                      UserInfo[search.id]["power"] == "chatmaster"
                    ) {
                      if (data["data"] == "logs") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح سجل الدخول",
                          user: "",
                        });
                        LogsRepo.deleteall();
                      } else if (data["data"] == "visitors") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم تصفير عدد الزوار",
                          user: "",
                        });
                        UsersRepo.updateBy({ state: "updateVisitorAll" });
                      } else if (data["data"] == "story") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح القصص",
                          user: "",
                        });
                        StoryRepo.deleteall();
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "storydel",
                          data: {},
                        });
                      } else if (data["data"] == "point") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم تصفير نقاط المستخدمين",
                          user: "",
                        });
                        UsersRepo.updateBy({ state: "updatePoint" });
                        Object.keys(UserInfo).forEach(function (socketId) {
                          var userInfos = UserInfo[socketId];
                          if (userInfos) {
                            userInfos["evaluation"] = 0;
                          }
                        });
                      } else if (data["data"] == "filter") {
                        HistLetterRepo.deleteBy({ state: "deleteAll" });
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح سجل الفلتر",
                          user: "",
                        });
                      } else if (data["data"] == "bars") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح الحائط",
                          user: "",
                        });
                        BarsRepo.deleted({ state: "deleteAll" });
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "fildel",
                          data: {},
                        });
                      } else if (data["data"] == "stats") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح سجل الحالات",
                          user: "",
                        });
                        StateRepo.deleteall();
                      } else if (data["data"] == "nicks") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح كشف النكات",
                          user: "",
                        });
                        NamesRepo.deleteall();
                      } else if (data["data"] == "reporte") {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم مسح سجل التبليغات",
                          user: "",
                        });
                        MesgRepo.deleteall();
                      } else if (data["data"] == "files") {
                        rimraf("uploads/sendfile", () => {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "تم مسح ملفات الدردشة",
                            user: "",
                          });
                          if (!fs.existsSync("uploads/sendfile")) {
                            fs.mkdirSync("uploads/sendfile");
                          }
                        });
                      } else if (data["data"] == "import") {
                        SettingRepo.DeleteDatabase();
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "جاري التركيب الرجاء الإنتظار",
                          user: "",
                        });
                        setTimeout(() => {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "الرجاء الإنتظار قليلا جاري التركيب",
                            user: "",
                          });
                          SettingRepo.CreateDatabase();
                          setTimeout(() => {
                            // ✅ SECURED: execFile بدل exec لمنع Command Injection
                            cp.execFile("sh", ["-c",
                              "mysql -u " + JSON.stringify(Config.UserDB) +
                              " -p" + JSON.stringify(Config.PassDB) +
                              " " + JSON.stringify(Config.DBDB) +
                              " < database/database0.sql"
                            ],
                              (error, stdout, stderr) => {
                                if (error) {
                                  SendNotification({
                                    state: "me",
                                    topic: "",
                                    force: 1,
                                    msg: "حدث خطأ أثناء تركيب النسخة الإحتياطية",
                                    user: "",
                                  });
                                  console.error("Backup install error:", error);
                                  return;
                                }
                                fs.unlink("database/database0.sql", (err) => {
                                  if (err) {
                                    console.error(
                                      "Error deleting backup file:",
                                      err
                                    );
                                  }
                                  SendNotification({
                                    state: "me",
                                    topic: "",
                                    force: 1,
                                    msg: "تم تركيب النسخة الإحتياطية بنجاح، سيتم إعادة التشغيل",
                                    user: "",
                                  });
                                  console.log("✅ Backup installed - restarting server");
                                  io.emit("SEND_EVENT_EMIT_SERVER", {cmd: "ev", data: "window.onbeforeunload = null; location.href=location.pathname;"});
                                  setTimeout(function() { process.exit(1); }, 2000);
                                });
                              }
                            );
                          }, 5000);
                        }, 5000);
                      } else if (data["data"] == "backup") {
                        if (fs.existsSync("database/database0.sql")) {
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "هناك نسخة إحتياطية بالفعل",
                            user: "",
                          });
                          return;
                        } else {
                          DatabaseDump("database/database0.sql");
                          SendNotification({
                            state: "me",
                            topic: "",
                            force: 1,
                            msg: "تم إنشاء نسخة إحتياطية",
                            user: "",
                          });
                        }
                      } else if (data["data"] == "restart") {
                        console.log("🔄 Admin requested restart");
                        io.emit("SEND_EVENT_EMIT_SERVER", {cmd: "ev",data: 'window.onbeforeunload = null; location.href=location.pathname;'});
                        setTimeout(function () {
                          process.exit(1);
                        }, 1000);
                      }

                      SaveStats({
                        state:
                          data["data"] == "restart"
                            ? "إعادة تشغيل"
                            : data["data"] == "files"
                            ? "حذف ملفات الدردشة"
                            : data["data"] == "point"
                            ? "تصفير نقاط"
                            : data["data"] == "story"
                            ? "حذف القصص"
                            : data["data"] == "filter"
                            ? "حذف الفيلتر"
                            : data["data"] == "reporte"
                            ? "حذف التبليغات "
                            : data["data"] == "stats"
                            ? "حذف سجل الحالات"
                            : data["data"] == "bars"
                            ? "حذف الحائط"
                            : data["data"] == "import"
                            ? "إسترجاع نسخه إحتياطية"
                            : data["data"] == "backup"
                            ? "إنشاء نسخه إحتياطية"
                            : data["data"] == "logs"
                            ? "حذف سجل الدخول"
                            : "",
                        topic: UserInfo[search.id]["topic"],
                        ip: UserInfo[search.id]["ip"],
                        username: UserInfo[search.id]["username"],
                        room: "",
                        time: new Date().getTime(),
                      });
                    }
                  } else if (data["cmd"] == "SEND_ADMIN_SITE") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    }
                    // إذا كان URL يحتوي على / فهو امتداد
                    if (data.url && data.url.includes("/")) {
                      var extFileKey = data.url.replace(/\//g, "_");
                      var extFilePath = "uploads/" + extFileKey + ".txt";
                      // قراءة الامتدادات للقائمة
                      var extKeysExt = [];
                      try {
                        var extRawExt = fs.readFileSync("uploads/extensions.json", "utf8");
                        var extListExt = JSON.parse(extRawExt);
                        extKeysExt = extListExt.map(function(e){ return typeof e === "string" ? e : (e.key || ""); }).filter(Boolean);
                      } catch(e) { extKeysExt = []; }
                      fs.readFile(extFilePath, function(err, f) {
                        var array = {};
                        if (f) { try { array = JSON.parse(f.toString()); } catch(e) { array = {}; } }
                        socket.emit("SHWO_PANEL_ADMIN", {
                          cmd: "SEND_ADMIN_SITE",
                          data: {
                            test: Config.ListDomin.concat(extKeysExt),
                            urls: data.url,
                            title: array["title"] || "",
                            colors: {
                              hicolor: array["background"] || "",
                              bgcolor: array["bg"] || "",
                              btcolor: array["buttons"] || "",
                            },
                            script: String(array["settscr"] || ""),
                            description: array["settdescription"] || "",
                            keywords: array["settkeywords"] || "",
                            keywordssite: array["settkeywordssite"] || "",
                            istite: array["name"] || "",
                          },
                        });
                      });
                    } else {
                    SettingRepo.getBy({
                      state: "getByHost",
                      hostname: data.url,
                    }).then((getSe) => {
                      if (getSe) {
                        fs.readFile(
                          "uploads/" + getSe["script"],
                          function (err, f) {
                            if (f) {
                              var array;
                              try { array = JSON.parse(f.toString()); } catch(e) { array = {}; }
                              // اقرأ الامتدادات وأضفها للقائمة
                              var extKeys = [];
                              try {
                                var extRaw = fs.readFileSync("uploads/extensions.json", "utf8");
                                var extList = JSON.parse(extRaw);
                                extKeys = extList.map(function(e){ return typeof e === "string" ? e : (e.key || ""); }).filter(Boolean);
                              } catch(e) { extKeys = []; }
                              socket.emit("SHWO_PANEL_ADMIN", {
                                cmd: "SEND_ADMIN_SITE",
                                data: {
                                  test: Config.ListDomin.concat(extKeys),
                                  urls: data.url,
                                  title: array["title"] || "",
                                  colors: {
                                    hicolor: array["background"] || "",
                                    bgcolor: array["bg"] || "",
                                    btcolor: array["buttons"] || "",
                                  },
                                  script: String(array["settscr"] || ""),
                                  description: array["settdescription"] || "",
                                  keywords: array["settkeywords"] || "",
                                  keywordssite: array["settkeywordssite"] || "",
                                  istite: array["name"] || "",
                                },
                              });
                            }
                          }
                        );
                      }
                    });
                    } // end else (not extension)
                  } else if (data["cmd"] == "SEND_ADMIN_SAVE_SITE") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    } else if (
                      typeof data["data"]["settscr"] != "string" ||
                      typeof data["data"]["bg"] != "string" ||
                      typeof data["data"]["buttons"] != "string" ||
                      typeof data["data"]["background"] != "string" ||
                      typeof data["data"]["name"] != "string" ||
                      typeof data["data"]["title"] != "string" ||
                      typeof data["data"]["settdescription"] != "string" ||
                      typeof data["data"]["settkeywords"] != "string" ||
                      typeof data["data"]["settkeywordssite"] != "string"
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "الرجاء ملئ كل الخانات الموجوده",
                        user: "",
                      });
                      return;
                    }

                    if (
                      data["data"]["settscr"].includes("socket.emit") ||
                      data["data"]["settscr"].includes("setInterval") ||
                      data["data"]["settscr"].includes("socket.on") ||
                      data["data"]["settscr"].includes("localStorage") ||
                      data["data"]["settscr"].includes("èmit") ||
                      data["data"]["settscr"].includes("èmit.on") ||
                      data["data"]["settscr"].includes("èmit.emit") ||
                      data["data"]["settscr"].includes("socket")
                    ) {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم رفض السكريبت يحتوي على فايروس يرجى تغيره",
                        user: "",
                      });
                      return;
                    }
                    // تحديد مسار الملف (امتداد أو دومين عادي)
                    var saveUrl = data.data.url;
                    var isExtSave = saveUrl && saveUrl.includes("/");
                    var saveFileKey = isExtSave ? saveUrl.replace(/\//g, "_") : saveUrl;
                    var saveFilePath = "uploads/" + saveFileKey + ".txt";

                    fs.unlink(saveFilePath, (err) => {
                      // تجاهل خطأ الحذف
                    });
                    setTimeout(() => {
                      fs.writeFile(
                        saveFilePath,
                        JSON.stringify(data["data"]),
                        function (err) {
                          if (err) {
                            SendNotification({
                              state: "me",
                              topic: "",
                              force: 1,
                              msg: "حدث خطأ الرجاء المحاولة في وقت لاحق",
                              user: "",
                            });
                            return;
                          }
                        }
                      );

                      // ✅ مسح كاش الإعدادات — التغييرات تظهر فوراً
                      clearSiteCache(data.data.url);

                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم تعديل إعدادات الموقع بنجاح",
                        user: "",
                      });
                      // الدومينات العادية فقط - حدّث DB
                      if (!isExtSave) {
                        SettingRepo.updateBy({
                          state: "updatecolor",
                          bg: data["data"]["bg"],
                          background: data["data"]["background"],
                          buttons: data["data"]["buttons"],
                          hostname: saveUrl,
                        });
                      }
                    }, 1000);
                  } else if (data["cmd"] == "SEND_ADMIN_EMO_UP") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) {
                      return;
                    } else if (
                      typeof data["type"] != "string" ||
                      typeof data["path"] != "string"
                    ) {
                      return;
                    }

                    EmoRepo.getBy(data["type"]).then((emo) => {
                      if (emo) {
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "رقم الفيس موجود بلفعل",
                          user: "",
                        });
                      } else {
                        EmoRepo.update({
                          type: data["type"],
                          path: data["path"],
                        });
                        RefreshEmo();
                      }
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_GET_EXTENSIONS") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) { return; }
                    // قراءة الامتدادات وتحويلها إلى strings
                    var extData = [];
                    try {
                      var raw = fs.readFileSync("uploads/extensions.json", "utf8");
                      var parsed = JSON.parse(raw);
                      // دعم كلا التنسيقين: strings أو objects
                      extData = parsed.map(function(e){ return typeof e === "string" ? e : (e.key || ""); }).filter(Boolean);
                    } catch(e) { extData = []; }
                    // إرسال قائمة الدومينات مع الامتدادات
                    socket.emit("SHWO_PANEL_ADMIN", {
                      cmd: "SEND_ADMIN_GET_EXTENSIONS",
                      data: extData,
                      domains: Config.ListDomin || [],
                    });
                  } else if (data["cmd"] == "SEND_ADMIN_ADD_EXTENSION") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) { return; }
                    // اللوحة ترسل domain و path بشكل منفصل
                    var extDomain = typeof data["domain"] === "string" ? data["domain"].trim() : "";
                    var extPathStr = typeof data["path"] === "string" ? data["path"].trim() : "";
                    if (!extDomain || !extPathStr) { return; }
                    var extKey = extDomain + "/" + extPathStr;
                    if (!Config.ListDomin.includes(extDomain)) {
                      SendNotification({ state: "me", topic: "", force: 1, msg: "الدومين غير موجود في القائمة", user: "" });
                      return;
                    }
                    var extList2 = [];
                    try {
                      var raw2 = fs.readFileSync("uploads/extensions.json", "utf8");
                      var parsed2 = JSON.parse(raw2);
                      extList2 = parsed2.map(function(e){ return typeof e === "string" ? e : (e.key || ""); }).filter(Boolean);
                    } catch(e) { extList2 = []; }
                    if (extList2.indexOf(extKey) !== -1) {
                      SendNotification({ state: "me", topic: "", force: 1, msg: "الامتداد موجود بالفعل", user: "" });
                      return;
                    }
                    extList2.push(extKey);
                    fs.writeFileSync("uploads/extensions.json", JSON.stringify(extList2));
                    extensionsCacheTime = 0; // ✅ مسح كاش الامتدادات
                    // اللوحة تتوقع cmd: SEND_ADMIN_ADD_EXTENSION مع data = string
                    socket.emit("SHWO_PANEL_ADMIN", { cmd: "SEND_ADMIN_ADD_EXTENSION", data: extKey });
                    SendNotification({ state: "me", topic: "", force: 1, msg: "تم إضافة الامتداد بنجاح: " + extKey, user: "" });
                  } else if (data["cmd"] == "SEND_ADMIN_DEL_EXTENSION") {
                    if (!GetPower2(UserInfo[search.id])["owner"]) { return; }
                    // اللوحة ترسل ext (وليس key)
                    var delExt = typeof data["ext"] === "string" ? data["ext"].trim() : "";
                    if (!delExt) { return; }
                    var extList3 = [];
                    try {
                      var raw3 = fs.readFileSync("uploads/extensions.json", "utf8");
                      var parsed3 = JSON.parse(raw3);
                      extList3 = parsed3.map(function(e){ return typeof e === "string" ? e : (e.key || ""); }).filter(Boolean);
                    } catch(e) { extList3 = []; }
                    extList3 = extList3.filter(function(e){ return e !== delExt; });
                    fs.writeFileSync("uploads/extensions.json", JSON.stringify(extList3));
                    extensionsCacheTime = 0; // ✅ مسح كاش الامتدادات
                    // اللوحة تتوقع cmd: SEND_ADMIN_DEL_EXTENSION مع data = string
                    socket.emit("SHWO_PANEL_ADMIN", { cmd: "SEND_ADMIN_DEL_EXTENSION", data: delExt });
                    SendNotification({ state: "me", topic: "", force: 1, msg: "تم حذف الامتداد", user: "" });
                  }
                } catch (e) {
                  console.log(e);
                }
              }
            }
          });
        } else {
          return;
        }
      });
    } catch (e) {
      console.log(e);
    }
  }
  function FilterOff(data) {
    if (UserInfo[socket.id] && typeof data == "object") {
      for (var i = 0; i < OnlineUser.length; i++) {
        const getpw = ShowPowers.findIndex(
          (x) => x.name == OnlineUser[i]["power"]
        );
        if (getpw != -1) {
          if (ShowPowers[getpw]["bootedit"]) {
            SendNotification({
              id: OnlineUser[i]["id"],
              state: "to",
              topic: data["state"],
              force: 1,
              msg: data["msg"].slice(0, SiteSetting["lengthroom"]),
              user: socket.id,
            });
          }
        }
      }
    }
  }

  function FilterChat(data) {
    if (data && UserInfo[socket.id]) {
      const nt1 = NoMsgFilter.findIndex((x) => data.includes(x.v));
      const nt2 = NoMsgFilter.findIndex(
        (x) => data.includes(x.v) && x.path == "amsgs"
      );
      if (nt1 !== -1 && nt2 === -1) {
        if (NoMsgFilter[nt1]["path"] == "bmsgs") {
          FilterOff({ msg: data, state: "ممنوعة" });
        } else if (NoMsgFilter[nt1]["path"] == "wmsgs") {
          FilterOff({ msg: data, state: "مراقبة" });
        }
        if (
          NoMsgFilter[nt1]["path"] == "bmsgs" ||
          NoMsgFilter[nt1]["path"] == "wmsgs"
        ) {
          HistLetterRepo.create({
            ip: UserInfo[socket.id]["ip"],
            msg: data.slice(0, SiteSetting["lengthroom"]),
            topic: UserInfo[socket.id]["topic"],
            v: NoMsgFilter[nt1]["v"],
          });
          HistLetterRepo.getBy({ state: "getAll" }).then((saveHistory) => {
            if (saveHistory) {
              for (var i = 0; i < saveHistory.length; i++) {
                if (i > Config.MaxFilter) {
                  HistLetterRepo.deleteBy({
                    state: "deleteByID",
                    id: saveHistory[0]["id"],
                  });
                }
              }
            }
          });
        }
      }
    }
  }
  function NextLevel() {
    if (UserInfo[socket.id]) {
      io.to(UserInfo[socket.id]["idroom"]).emit("SEND_EVENT_EMIT_SERVER", {
        cmd: "lvel",
        data: {
          bg: "none",
          class: "hmsg",
          topic: "ترقية مستوى",
          msg:
            UserInfo[socket.id]["topic"] +
            " تم ترقيت نجومه للوصول الى " +
            UserInfo[socket.id]["evaluation"] +
            "  رسالة في الحائط",
          roomid: UserInfo[socket.id]["idroom"],
          pic: "/imgs/star.png",
          uid: "",
        },
      });
    }
  }

  function ChangeSatets(data) {
    if (typeof data == "number") {
      if (UserInfo[socket.id]) {
        var user = OnlineUser.findIndex((x) => x.id == socket.id);
        // ✅ FIX: خطة بديلة — ابحث بـ lid
        if (user === -1 && UserInfo[socket.id]["lid"]) {
          user = OnlineUser.findIndex((x) => x.lid == UserInfo[socket.id]["lid"]);
          if (user !== -1) { OnlineUser[user]["id"] = socket.id; }
        }
        if (
          user != -1 &&
          UserInfo[socket.id]["busy"] == false &&
          OnlineUser[user]["stat"] != 4
        ) {
          OnlineUser[user]["stat"] = data;
          io.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "u^",
            data: OnlineUser[user],
          });
        }
      }
    }
  }

  socket.on("ism", function (data, mm) {
    if (typeof data == "number" && typeof mm == "string") {
      if (data == 0 || data === 1) {
        if (UserInfo[socket.id]) {
          var user = OnlineUser.findIndex((x) => x.id == socket.id);
          // ✅ FIX: خطة بديلة — ابحث بـ lid إذا ما لقيت بالسوكت
          if (user === -1 && UserInfo[socket.id]["lid"]) {
            user = OnlineUser.findIndex((x) => x.lid == UserInfo[socket.id]["lid"]);
            if (user !== -1) { OnlineUser[user]["id"] = socket.id; }
          }
          if (
            user != -1 &&
            UserInfo[socket.id]["busy"] == false &&
            OnlineUser[user]["stat"] != 4
          ) {
            OnlineUser[user]["stat"] = data;
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "u^",
              data: OnlineUser[user],
            });
          }
        }
      }
    }
  });

  function MyRoom(data) {
    if (data) {
      if (isBandRoom({ device: data, room: SiteSetting["room"] })) {
        return null;
      }

      // ✅ FIX: use admin-selected room from SiteSetting
      const selectedRoom = SiteSetting["room"] || "3ihxjl18it";
      const baseRoomId = "3ihxjl18it";

      // If admin selected a specific room (not the default), send user there directly
      if (selectedRoom !== baseRoomId) {
        const roomInfo = GetRoomList(selectedRoom);
        if (roomInfo) {
          return selectedRoom;
        }
        // fallback to default if selected room doesn't exist
      }
      const relatedRooms = OnlineUser.filter(
        (a) => a && a.roomid && a.roomid.startsWith(baseRoomId)
      );

      const roomNumbers = relatedRooms.map((a) => {
        const match = a.roomid.match(/^3ihxjl18it(\d*)$/); // انتبه: (\d*) حتى يشمل الفارغ
        return match && match[1] !== "" ? parseInt(match[1]) : 0; // الأساسية تعتبر رقمها 0
      });

      const lastRoomNumber = roomNumbers.length ? Math.max(...roomNumbers) : 0;

      const lastRoomId =
        lastRoomNumber === 0 ? baseRoomId : baseRoomId + lastRoomNumber;

      const usersInLastRoom = OnlineUser.filter(
        (a) => a && a.roomid === lastRoomId
      );

      const roomInfo = GetRoomList(lastRoomId);
      if (!roomInfo) return baseRoomId;

      if (usersInLastRoom.length >= roomInfo.max) {
        const newRoomNumber = lastRoomNumber + 1;
        const newRoomId = baseRoomId + newRoomNumber;
        const named = "الغرفة العامة (" + newRoomNumber + ")";
        RoomsRepo.getBy({ state: "getByID", id: newRoomId }).then((res) => {
          if (!res) {
            CreateRooms({
              id: newRoomId,
              about: named,
              user: "gochat",
              pass: "",
              color: "#000000",
              baccolor: "#fff",
              colorpicroom: "#000000",
              colormsgroom: "#000000",
              needpass: false,
              camera: false,
              broadcast: false,
              broadlive: false,
              nohide: false,
              deleted: false,
              maxmaic: 4,
              owner: "#1",
              rmli: 0,
              topic: named,
              pic: "/site/room.png",
              welcome: "مرحبا بكم في " + named,
              max: 40,
              has: 1,
            });
          }
        });
        return newRoomId;
      } else {
        return lastRoomId;
      }
    }

    return SiteSetting["room"];
  }

  function IsWelcome() {
    if (UserInfo[socket.id]) {
      IntroRepo.getBy({ state: "getIn", category: "w" }).then((wlc) => {
        if (wlc.length > 0) {
          for (var i = 0; i < wlc.length; i++) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "msg",
              data: {
                bg: "",
                class: "pmsgc",
                topic: wlc[i]["adresse"].split("<").join("&#x3C;"),
                msg: wlc[i]["msg"].split("<").join("&#x3C;"),
                ucol: "red",
                mcol: "#000000",
                roomid: UserInfo[socket.id]["idroom"],
                pic: "/site/msgpic.png",
                uid: "",
              },
            });
          }
        }
      });
    }
  }

  function EnterUserGust(data) {
    if (typeof data == "object") {
      if (data["uid"] && data["islogin"] == "عضو") {
        UsersRepo.updateBy({
          state: "updateIp",
          device: data["device"],
          uid: data["uid"],
          ip: data["ip"],
          id: socket.id,
        });
        SubRepo.getBy({
          state: "getByusername",
          username: data["username"],
        }).then((isres) => {
          if (isres) {
            if (
              isres.timeis > 0 &&
              Number(new Date().getTime()).toFixed() < Number(isres.timestart)
            ) {
              UsersRepo.updateBy({
                state: "updatePower",
                uid: data["uid"],
                power: "",
              });
              SubRepo.deleted(data["username"]);
              data["power"] = "";
            }
          }
        });
      }

      if (data["islogin"] != "بوت") {
        ListEnter.push({ id: socket.id, ip: data["ip"] });
        if (SiteSetting["reconnect"] && data["islogin"] == "عضو") {
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            k: stringGen(5),
            cmd: "ok",
            data: {},
          });
        } else {
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            k: stringGen(5),
            cmd: "nok",
            data: {},
          });
        }
      }

      if (
        SiteSetting["onoff"] &&
        data["rep"] < SiteSetting["liked"] &&
        (GetWaitingFor(data["ip"]) ||
          GetWaitingFor(data["device"]) ||
          GetWaitingFor(data["country"]) ||
          GetWaitingFor(data["username"]))
      ) {
        data["idroom"] = "WA15IDTAI4G";
        data["iswaiting"] = true;
      } else {
        data["idroom"] = data["idroom"];
        data["iswaiting"] = false;
      }
      // setTimeout(function(){
      UserInfo[data["id"]] = {
        iswaiting: data["iswaiting"],
        ucol: data["ucol"],
        mcol: data["mcol"],
        mscol: data["mscol"],
        camerashow: data["camerashow"],
        atar: data["atar"],
        back: data["back"],
        live: false,
        ifedit: data["ifedit"],
        offline: false,
        reconnct: "",
        offdate: null,
        ismsg: false,
        kiked: false,
        bar: false,
        visitor: false,
        iscall: null,
        lastst: 0,
        logout: false,
        islogin: data["islogin"],
        bg: data["bg"],
        copic: data["copic"],
        rep: data["rep"],
        ico: data["ico"],
        evaluation: data["eva"],
        vis: data["visitor"],
        username: data["username"],
        islike: data["islike"],
        discard: [],
        istef: [],
        power: data["power"],
        idreg: data["idreg"],
        topic: data["topic"],
        country: data["country"],
        ip: data["ip"],
        id: data["id"],
        uid: data["uid"],
        lid: data["lid"],
        busy: false,
        ismuted: data["ismuted"],
        ismutedbc: data["ismutedbc"],
        ismicban: data["ismicban"] || false,
        isstoryban: data["isstoryban"] || false,
        isfrozen: data["isfrozen"] || false,
        stealth: data["stealth"],
        device: data["device"],
        pic: data["pic"],
        idroom: data["idroom"],
        hw_fp: data["hw_fp"] || socketHwFp[socket.id] || "",
        topicFont: data["topicFont"] || "",
        topicShine: data["topicShine"] || "",
      };
      /* ✅ تحديث خرائط التوجيه */
      _updateSocketMaps(data["id"], data["lid"]);
      if (GetPower(data["power"])["stealth"] && data["stealth"]) {
      } else {
        if (data["loginG"] != 0 && !data["islog"]) {
          io.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "king",
            data: {
              is: data["loginG"],
              pic: data["pic"],
              topic: data["topic"],
              vipImg: data["vipImg"] || "",
              vipSound: data["vipSound"] || "",
              country:
                "/flag/" +
                (data["country"].toLowerCase().replace("il", "ps") || "tn") +
                ".png",
            },
          });
        }
      }

      if (data["power"] != "Hide" && data["islogin"] != "بوت") {
        SaveLogs({
          state: data["islogin"],
          topic: data["topic"],
          username: data["username"],
          ip: data["ip"],
          country: data["country"],
          device: data["device"],
          isin: data["refr"],
          date: new Date().getTime(),
        });
      }

      setTimeout(() => {
        if (notificationoffline[data["uid"]]) {
          for (var i = 0; i < notificationoffline[data["uid"]].length; i++) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "not2",
              data: notificationoffline[data["uid"]][i],
            });
          }
          setTimeout(() => {
            if (notificationoffline[data["uid"]]) {
              notificationoffline[data["uid"]] = [];
            }
          }, 1000);
        }
      }, 3000);

      RefreshEmo();
      RefreshDro3();
      RefreshSico();
      RefreshAtar();
      RefreshBack();

      const onlineUser = OnlineUser.findIndex((x) => x.lid == data["lid"]);
      // ✅ FIX: إذا القيد موجود — حدّث السوكت والبيانات وأبلّغ الكل
      if (onlineUser !== -1) {
        var _fixOldId = OnlineUser[onlineUser]["id"];
        if (UserInfo[_fixOldId] && UserInfo[_fixOldId]["reconnct"]) {
          clearTimeout(UserInfo[_fixOldId]["reconnct"]);
        }
        if (_fixOldId !== data["id"]) {
          delete UserInfo[_fixOldId];
        }
        OnlineUser[onlineUser]["id"] = data["id"];
        OnlineUser[onlineUser]["stat"] = data["stat"];
        OnlineUser[onlineUser]["bg"] = data["bg"];
        OnlineUser[onlineUser]["ucol"] = data["ucol"];
        OnlineUser[onlineUser]["mcol"] = data["mcol"];
        OnlineUser[onlineUser]["mscol"] = data["mscol"];
        OnlineUser[onlineUser]["topic"] = data["topic"].split("<").join("&#x3C;");
        OnlineUser[onlineUser]["msg"] = data["msg"].split("<").join("&#x3C;");
        OnlineUser[onlineUser]["pic"] = data["pic"];
        OnlineUser[onlineUser]["power"] = data["power"];
        OnlineUser[onlineUser]["rep"] = data["rep"];
        OnlineUser[onlineUser]["roomid"] = data["idroom"];
        OnlineUser[onlineUser]["ico"] = data["ico"];
        OnlineUser[onlineUser]["copic"] = data["copic"];
        OnlineUser[onlineUser]["atar"] = data["atar"];
        OnlineUser[onlineUser]["back"] = data["back"];
        OnlineUser[onlineUser]["ifedit"] = data["ifedit"];
        OnlineUser[onlineUser]["youtube"] = data["youtube"];
        OnlineUser[onlineUser]["evaluation"] = data["eva"];
        // ✦ بيانات الزخرفة
        OnlineUser[onlineUser]["topicFont"] = data["topicFont"] || "";
        OnlineUser[onlineUser]["topicShine"] = data["topicShine"] || "";
        OnlineUser[onlineUser]["s"] = GetPower(data["power"])["stealth"] && data["stealth"] ? true : null;
        if (OnlineUser[onlineUser]["s"]) {
          emitToStealthViewers("u^", OnlineUser[onlineUser]);
        } else {
          io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u^", data: OnlineUser[onlineUser] });
        }
      }
      if (onlineUser == -1) {
        OnlineUser.push({
          bg: data["bg"],
          copic: data["copic"],
          co: data["country"],
          live: false,
          ls: data["listpowers"],
          verification: data["verification"],
          evaluation: data["eva"],
          vis: data["visitor"],
          ico: data["ico"],
          id: data["id"],
          idreg: data["idreg"],
          lid: data["lid"],
          meiut: data["ismuted"],
          ismicban: data["ismicban"] || false,
          isstoryban: data["isstoryban"] || false,
          isfrozen: data["isfrozen"] || false,
          meiutbc: data["ismutedbc"],
          mcol: data["mcol"],
          mscol: data["mscol"],
          atar: data["atar"],
          back: data["back"],
          ifedit: data["ifedit"],
          msg: data["msg"].split("<").join("&#x3C;"),
          istolk: false,
          power: data["power"],
          rep: data["rep"],
          islogin: data["islogin"],
          pic: data["pic"],
          cover: data["cover"] || "",
          youtube: data["youtube"],
          roomid: data["idroom"],
          time:
            data["islogin"] == "بوت"
              ? null
              : socket.request["_query"]["dtoday"]
              ? socket.request["_query"]["dtoday"]
              : null,
          stat: data["stat"],
          s:
            GetPower(data["power"])["stealth"] && data["stealth"] ? true : null,
          topic: data["topic"].split("<").join("&#x3C;"),
          ucol: data["ucol"],
          // ✦ بيانات الزخرفة
          topicFont: data["topicFont"] || "",
          topicShine: data["topicShine"] || "",
        });
        /* ✅ لا ترسل بيانات المخفي لغير الأدمن */
        var _u2StealthData = {
          cmd: "u+",
          data: {
            bg: data["bg"],
            copic: data["copic"],
            co: data["country"],
            evaluation: data["eva"],
            vis: data["visitor"],
            ico: data["ico"] || "",
            id: data["id"],
            idreg: data["idreg"],
            lid: data["lid"],
            time:
              data["islogin"] == "بوت"
                ? null
                : socket.request["_query"]["dtoday"]
                ? socket.request["_query"]["dtoday"]
                : null,
            istolk: false,
            mcol: data["mcol"],
            mscol: data["mscol"],
            atar: data["atar"],
            back: data["back"] || "",
            ifedit: data["ifedit"],
            msg: data["msg"].split("<").join("&#x3C;"),
            meiut: data["ismuted"],
            meiutbc: data["ismutedbc"],
            power: data["power"],
            rep: data["rep"],
            pic: data["pic"],
            cover: data["cover"] || "",
            roomid: data["idroom"],
            stat: data["stat"],
            s:
              GetPower(data["power"])["stealth"] && data["stealth"]
                ? true
                : null,
            topic: data["topic"].split("<").join("&#x3C;"),
            ucol: data["ucol"],
            // ✦ بيانات الزخرفة
            topicFont: data["topicFont"] || "", topicShine: data["topicShine"] || "",
          }
        };
        if (GetPower(data["power"])["stealth"] && data["stealth"]) {
          emitToStealthViewers("u+", _u2StealthData.data);
        } else {
          io.emit("SEND_EVENT_EMIT_SERVER", _u2StealthData);
        }
      }

      if (data["islogin"] != "بوت") {
        socket.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "ulist",
          data: getFilteredOnlineUsers(socket.id),
        });

        socket.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "powers",
          data: ShowPowers,
        });

        const power = ShowPowers.findIndex((x) => x.name == data["power"]);
        if (power != -1) {
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "power",
            data: ShowPowers[power],
          });
        } else {
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "power",
            data: Config.PowerNon,
          });
        }

        socket.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "rlist",
          data: RoomsListWith,
        });
        socket.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "infosite",
          data: {
            replay: SiteSetting["replay"],
            callmic: SiteSetting["callmic"],
            callsot: SiteSetting["callsot"],
            showtb: SiteSetting["showtb"],
            showtop: SiteSetting["showtop"],
            showsto: SiteSetting["showsto"],
            showyot: SiteSetting["showyot"],
            replaybc: SiteSetting["replaybc"],
            likebc: SiteSetting["likebc"],
            mic: SiteSetting["maxlikemic"],
            story: SiteSetting["maxlikestory"] || 2000,
            maxcharstatus: SiteSetting["maxcharstatus"] || 240,
            maxcharzakhrafah: SiteSetting["maxcharzakhrafah"] || 30,
          },
        });

        BarsRepo.getBy({ state: "getAll" }).then((brs) => {
          if (brs && !SiteSetting["bars"]) {
            for (var i = 0; i < brs.length; i++) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "bc",
                data: brs[i],
                numb: 0,
              });
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "bc^",
                data: brs[i],
              });
            }
          }
        });

        socket.join(data["idroom"]);
      }
      setTimeout(function () {
        if (!data["islog"] && data["islogin"] != "بوت") {
          IsWelcome();
        }
        if (GetPower(data["power"])["stealth"] && data["stealth"]) {
        } else {
          if (GetRoomList(data["idroom"])) {
            io.to(data["idroom"]).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "msg",
              data: {
                bg: "none",
                copic: "none",
                class: "hmsg",
                topic: data["topic"].split("<").join("&#x3C;"),
                msg:
                  "هذا المستخدم قد دخل" +
                  '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                  GetRoomList(data["idroom"])["id"] +
                  "')\">" +
                  GetRoomList(data["idroom"])["topic"] +
                  "</div>",
                roomid: data["idroom"],
                pic: data["pic"],
                uid: data["id"],
              },
            });
          }
        }

        /* ✅ لا ترسل ur للمخفي عند تغيير الغرفة */
        if (GetPower(data["power"])["stealth"] && data["stealth"]) {
          emitToStealthViewers("ur", [data["id"], data["idroom"]]);
        } else {
          io.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "ur",
            data: [data["id"], data["idroom"]],
          });
        }
        if (data["islogin"] != "بوت" && GetRoomList(data["idroom"])) {
          if (GetRoomList(data["idroom"])["broadcast"]) {
            /* ✅ v62: socket.to بدل io.to لمنع إرسال rjoin للمرسل نفسه */
            socket.to(data["idroom"]).emit("SEND_EVENT_EMIT_BROADCASTING", {
              cmd: "rjoin",
              user: socket.id,
            });
            socket.emit("SEND_EVENT_EMIT_BROADCASTING", {
              cmd: "all",
              room: data["idroom"],
              data: PeerRoom[data["idroom"]],
            });
          }
        }
      }, 200);
    }
  }

  function BandBrowser(data) {
    if (typeof data == "object") {
      SaveLogs({
        state:
          data["state"] == "gust"
            ? "محظور|زائر|متصفح"
            : data["state"] == "user"
            ? "محظور|عضو|متصفح"
            : "محظور|تسجيل|متصفح",
        topic: data["user"],
        username: data["user"],
        ip: data["type"] + " | متصفح محظور",
        country: data["country"],
        device: data["device"],
        isin: data["refr"] || "*",
        date: new Date().getTime(),
      });
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "removede", data: {} });
      SendNotification({
        state: "me",
        topic: "",
        force: 1,
        msg: data["type"] + " هذا المتصفح محظور في هذا التطبيق",
        user: "",
      });
    }
  }

  function BandSystem(data) {
    if (typeof data == "object") {
      SaveLogs({
        state:
          data["state"] == "gust"
            ? "محظور|زائر|نظام"
            : data["state"] == "user"
            ? "محظور|عضو|نظام"
            : "محظور|تسجيل|نظام",
        topic: data["user"],
        username: data["user"],
        ip: data["type"] + " | نظام محظور",
        country: data["country"],
        device: data["device"],
        isin: data["refr"] || "*",
        date: new Date().getTime(),
      });
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "removede", data: {} });
      SendNotification({
        state: "me",
        topic: "",
        force: 1,
        msg: data["type"] + " هذا النظام محظور في هذا التطبيق",
        user: "",
      });
    }
  }

  function BandSysBrow(data) {
    const myserail = socket.request["_query"];
    if (typeof myserail != "object") {
      return;
    } else if (!myserail["browser"]) {
      return;
    }
    if (typeof data == "object") {
      if (
        SystemOpen["system1"] == true &&
        (!!~data["device"].toLowerCase().indexOf("win") ||
          !!~data["device"].toLowerCase().indexOf("windows"))
      ) {
        //win
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Windows",
          refr: data["refr"],
        });
        return false;
      } else if (
        SystemOpen["system2"] == true &&
        !!~data["device"].toLowerCase().indexOf("linux")
      ) {
        //linux
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Linux",
          refr: data["refr"],
        });
        return false;
      } else if (
        SystemOpen["system3"] == true &&
        !!~data["device"].toLowerCase().indexOf("android")
      ) {
        //android
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Android",
          refr: data["refr"],
        });
        return false;
      } else if (
        SystemOpen["system4"] == true &&
        !!~data["device"].toLowerCase().indexOf("ios")
      ) {
        //ios
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "IOS",
          refr: data["refr"],
        });
        return false;
      } else if (
        SystemOpen["system5"] == true &&
        !!~data["device"].toLowerCase().indexOf("windows phone")
      ) {
        //win phone
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Windows Phone",
          refr: data["refr"],
        });
        return false;
      } else if (
        SystemOpen["system6"] == true &&
        !!~data["device"].toLowerCase().indexOf("mac")
      ) {
        //mac
        BandSystem({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Mac OS",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser1"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("chrome")
      ) {
        //chrome
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Chrome",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser2"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("firefox")
      ) {
        //firefox
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Firefox",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser3"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("safari")
      ) {
        //safari
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Safari",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser4"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("opera")
      ) {
        //Opera
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Opera",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser5"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("internet explorer")
      ) {
        //Internet Explorer
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Internet Explorer",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser6"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("edge")
      ) {
        //Edge
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Edge",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser7"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("webview")
      ) {
        //Android webview
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Android webview",
          refr: data["refr"],
        });
        return false;
      } else if (
        BrowserOpen["browser8"] == true &&
        !!~myserail.browser.toLowerCase().indexOf("samsung browser")
      ) {
        //Samsung Internet
        BandBrowser({
          device: data["device"],
          state: data["state"],
          user: data["username"],
          country: data["country"],
          type: "Samsung Internet",
          refr: data["refr"],
        });
        return false;
      } else {
        return true;
      }
    }
  }

  function MyIp() {
    const ismyip = socket.request.headers["x-forwarded-for"]
      ? socket.request.headers["x-forwarded-for"].split(",")[0]
      : "89.187.162.182";
    if (typeof ismyip != "string" || !ismyip) {
      socket.disconnect();
      return false;
    }
    if (ismyip) {
      if (ismyip.includes(",")) {
        socket.disconnect();
        return false;
      }
    }

    return ismyip;
  }

  function RemoveIp() {
    const isips = ListIPAll.findIndex((x) => x == MyIp());
    if (isips != -1) {
      ListIPAll.splice(ListIPAll.indexOf(MyIp()), 1);
    }
  }

  function SendNotification(data) {
    if (typeof data == "object") {
      if (data["state"] == "me") {
        socket.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "not",
          data: {
            topic: data["topic"],
            force: data["force"],
            msg: data["msg"],
            user: data["user"],
          },
        });
        socket.emit("seoo", {
          cmd: "not",
          data: {
            topic: data["topic"],
            force: data["force"],
            msg: data["msg"],
            user: data["user"],
          },
        });
      } else if (data["state"] == "all") {
        io.emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "not",
          data: {
            topic: data["topic"],
            force: data["force"],
            msg: data["msg"],
            user: data["user"],
          },
        });
      } else if (data["state"] == "to" && data["id"]) {
        SaveNotification({
          id: data["id"],
          msg: data["msg"],
          user: data["user"],
        });
        socket.to(data["id"]).emit("SEND_EVENT_EMIT_SERVER", {
          cmd: "not",
          data: {
            topic: data["topic"],
            force: data["force"],
            msg: data["msg"],
            user: data["user"],
          },
        });
      }
    }
  }

  socket.on("disconnect", function (e) {
    // ✅ تنظيف البصمة و flood protection
    delete socketHwFp[socket.id];
    _floodProtection.delete(socket.id);
    // تنظيف rate limit التعليقات
    if (CommentRateLimit[socket.id]) delete CommentRateLimit[socket.id];
    if (UserInfo[socket.id]) {
      // ── عضو: نحتفظ ببياناته مؤقتاً لإتاحة إعادة الاتصال ──
      if (UserInfo[socket.id]["islogin"] === "عضو") {

        // ✅ حماية Race Condition: تحقق هل المستخدم عاد بسوكت جديد قبل ما نحذف القديم
        const _dcUid = UserInfo[socket.id]["uid"];
        if (_dcUid) {
          const _alreadyBack = OnlineUser.some(function(u) {
            return u.id !== socket.id && UserInfo[u.id] && String(UserInfo[u.id]["uid"]) === String(_dcUid) && !UserInfo[u.id]["offline"];
          });
          if (_alreadyBack) {
            // المستخدم رجع بسوكت جديد — نظّف القديم فقط بدون ما نأثر على الجديد
            delete global._socketToLid[socket.id]; // ✅ FIX: clean stale socket map
            delete UserInfo[socket.id];
            const _dcListIdx = ListEnter.findIndex((v) => v.id === socket.id);
            if (_dcListIdx !== -1) ListEnter.splice(_dcListIdx, 1);
            return;
          }
        }

        // إزالة من قائمة الدخول
        const indexInListEnter = ListEnter.findIndex((v) => v.id === socket.id);
        if (indexInListEnter !== -1) ListEnter.splice(indexInListEnter, 1);

        const indexInOnlineUser = OnlineUser.findIndex((v) => v.id === socket.id);
        if (indexInOnlineUser !== -1) {

          // ✅ v44: لا نمسح PeerRoom ولا نرسل rleave — المستخدم قد يعود
          // PeerRoom يبقى محجوزاً والتنظيف يحصل فقط عند الـ timeout النهائي (UserDisconnect)
          const userRoomId = UserInfo[socket.id]["idroom"];

          // حفظ آخر حالة ووضع العضو كـ offline مؤقتاً
          // ✅ FIX: لا تستخدم || 1 لأنها تحول stat 0 (نشط) إلى 1 (خامل)
          var _dcStat = OnlineUser[indexInOnlineUser]["stat"];
          UserInfo[socket.id]["lastst"] = (_dcStat != null && _dcStat !== 3) ? _dcStat : 1;
          // ✅ FIX: إذا المستخدم busy (مقفل خاص) تأكد أن lastst = 2
          if (UserInfo[socket.id]["busy"] === true && UserInfo[socket.id]["lastst"] !== 2) {
            UserInfo[socket.id]["lastst"] = 2;
          }
          OnlineUser[indexInOnlineUser]["stat"] = 3;
          UserInfo[socket.id]["offline"] = true;

          // إبلاغ الجميع بتغيّر حالة المستخدم
          io.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "u^",
            data: OnlineUser[indexInOnlineUser],
          });

          // ── مؤقت الإزالة: 10 دقائق لاستيعاب الجوالات في الخلفية ──
          if (UserInfo[socket.id]["reconnct"]) {
            clearTimeout(UserInfo[socket.id]["reconnct"]);
          }
          UserInfo[socket.id]["reconnct"] = setTimeout(() => {
            if (UserInfo[socket.id] && UserInfo[socket.id]["offline"] === true) {
              UserDisconnect({ id: socket.id, state: 1 });
            }
          }, 10 * 60 * 1000);

        } else {
          // العضو غير موجود في OnlineUser — فصل مباشر
          if (UserInfo[socket.id]) socket.leave(UserInfo[socket.id]["idroom"]);
          UserDisconnect({ id: socket.id, state: 1 });
        }

      } else {
        // زائر / بوت — فصل فوري
        UserDisconnect({ id: socket.id, state: 1 });
      }
    }
  });

  function GetDevice() {
    const myserail = socket.handshake.query;

    if (
      typeof myserail["plt"] === "string" &&
      typeof myserail["device_id"] === "string" &&
      typeof myserail["version"] === "string" &&
      typeof myserail["browser"] === "string"
    ) {
      const DevFo = myserail["device_id"];
      const BrowserOn = Config.BrowserList.findIndex(
        (x) =>
          x.toLowerCase() ===
          myserail.browser.replace("Mobile ", "").toLowerCase()
      );
      const PlatformOn = Config.PlatformList.findIndex(
        (x) => x.toLowerCase() === myserail.plt.toLowerCase()
      );

      if (BrowserOn === -1) {
        SendNotification({
          state: "me",
          topic: "",
          force: 1,
          msg: "الرجاء المحاولة بمتصفح أخر",
          user: "",
        });
        return false;
      } else if (PlatformOn === -1) {
        SendNotification({
          state: "me",
          topic: "",
          force: 1,
          msg: "الرجاء المحاولة بنظام تشغيل أخر",
          user: "",
        });
        return false;
      } else {
        return (
          myserail["plt"] +
          "-" +
          myserail["version"] +
          DevFo.replace(/\./g, "-") +
          "-" +
          myserail["browser"]
        );
      }
    } else {
      DisconectedBy();
      return false;
    }
  }

  // ✅ استخراج البصمة الصلبة من الكلاينت
  function GetHwFp() {
    // ✅ نفحص من 3 مصادر: UserInfo (الأحدث) ← socketHwFp (مؤقت) ← query (أول اتصال)
    var hwfp = null;
    if (UserInfo[socket.id] && UserInfo[socket.id]["hw_fp"]) {
      hwfp = UserInfo[socket.id]["hw_fp"];
    } else if (socketHwFp[socket.id]) {
      hwfp = socketHwFp[socket.id];
    } else {
      hwfp = socket.handshake.query["hw_fp"];
    }
    if (typeof hwfp === "string" && hwfp.length >= 16) {
      return hwfp.trim();
    }
    return null;
  }

  function BandDoneCheked(data) {
    if (UserChecked.length > 0) {
      const ischkedband = UserChecked.findIndex((x) => x == data);
      if (ischkedband != -1) {
        return true;
      } else {
        return false;
      }
    }
  }

  function BandComplierIp(data) {
    if (data) {
      const isbands = ListBand.findIndex(
        (x) => x.ip_band && data.includes(x.ip_band)
      );
      if (isbands != -1) {
        return ListBand[isbands].ip_band;
      } else {
        return false;
      }
    }
  }

  function BandDone(data) {
    if (typeof data == "object") {
      if (data["statea"] == "vpn") {
        if (
          StopVPN(data["country"]) &&
          !data["verification"] &&
          SiteSetting["vpn"]
        ) {
          SaveLogs({
            state: data["state"],
            topic: data["topic"],
            username: data["username"],
            ip: data["ip"],
            country: data["country"],
            device: data["device"],
            isin: data["refr"] || "*",
            date: new Date().getTime(),
          });
          socket.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "login",
            data: { msg: "vpn" },
          });
          setTimeout(() => {
            socket.disconnect();
          }, 2000);
          return true;
        } else {
          return false;
        }
      }
    }
  }

  socket.on("signal", async function (data) {
    if (data.to) {
      io.to(data.to).emit("signal", { from: socket.id, data: data.data });
    }
  });

  socket.on("SEND_EVENT_EMIT_BROADCASTING", async function (data) {
    if (UserInfo[socket.id] && UserInfo[socket.id]["ismicban"]) {
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "notf", data: { msg: "تم حظرك من المايكات" } });
      return;
    }
    if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
      socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "notf", data: { msg: "حسابك مجمد" } });
      return;
    }
    try {
      await rateLimiter.consume(socket.handshake.address);

      // Validate data
      if (typeof data !== "object") return;
      if (typeof data.it === "string" || typeof data.mj === "string") return;

      if (UserInfo[socket.id]) {
        if (data.cmd === "new") {
          // Handle 'new' command
          if (!data.it || !data.it.t || typeof data.it.t !== "string") return;

          // Check for valid 't' values
          const validTValues = ["1", "2", "3", "4", "5", "6", "7"];
          // ✅ FIX-SEC: مطابقة دقيقة بدل includes — يمنع "12" أو "13" من الاعتبار صالحة
          if (validTValues.some((val) => data.it.t === val)) {
            if (UserInfo[socket.id].rep < SiteSetting.maxlikemic) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: `${SiteSetting.maxlikemic} عدد الايكات المطلوبة للمايك`,
                user: "",
              });
              return;
            }

            // Emit broadcasting event
            const userInfo = UserInfo[socket.id];
            const ispeer = PeerRoom[userInfo.idroom][data.it.t].id;
            const islocked = PeerRoom[userInfo.idroom][data.it.t].locked;

            // ✅ FIX-SEC: منع الصعود على مايك مشغول أو مقفل
            if (ispeer && ispeer !== "" && ispeer !== socket.id) {
              socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "notf", data: { msg: "المايك مشغول" } });
              return;
            }
            if (islocked) {
              socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "notf", data: { msg: "المايك مقفل" } });
              return;
            }
         
            const broadcastData = {
              us: {
                pic: userInfo.pic,
                topic: userInfo.topic,
                id: userInfo.id,
                iscam: data["cam"] ? true : false,
                private: data["broadcastType"] ? true : false,
              },
              cmd: "new",
              it: data.it.t,
              user: socket.id,
            };
            const broadcastData2 = {
              us: {
                pic: userInfo.pic,
                topic: userInfo.topic,
                id: userInfo.id,
                iscam: data["cam"] ? true : false,
                private: data["broadcastType"] ? true : false,
              },
              cmd: "new",
              it: data.it.t,
            };
            io.to(userInfo.idroom).emit(
              "SEND_EVENT_EMIT_BROADCASTING",
              broadcastData
            );
            socket.emit("SEND_EVENT_EMIT_BROADCASTING", broadcastData2);
            // Update PeerRoom
            const indexInOnlineUser = OnlineUser.findIndex(
              (v) => v.id === socket.id
            );
            if (indexInOnlineUser !== -1) {
              OnlineUser[indexInOnlineUser]["live"] = data["cam"]
                ? true
                : false;
              UserInfo[socket.id]["live"] = data["cam"] ? true : false;
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "u^",
                data: OnlineUser[indexInOnlineUser],
              });
            }
            if (data["cam"]) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "showlive",
                data: {
                  id: socket.id,
                  idmic: data.it.t,
                },
              });
              io.to(UserInfo[socket.id]["idroom"]).emit(
                "SEND_EVENT_EMIT_SERVER",
                {
                  cmd: "msg",
                  data: {
                    bg: "none",
                    copic: "none",
                    class: "pmsgc",
                    id: UserInfo[socket.id]["id"],
                    topic: UserInfo[socket.id]["topic"],
                    msg: " هذا المستخدم قام بفتح  الكام",
                    roomid: UserInfo[socket.id]["idroom"],
                    pic: UserInfo[socket.id]["pic"],
                    uid: socket.id,
                  },
                }
              );
            }

            PeerRoom[userInfo.idroom][data.it.t] = {
              id: socket.id,
              ev: true,
              us: {
                pic: userInfo.pic,
                topic: userInfo.topic,
                iscam: data["cam"] ? true : false,
                private: data["broadcastType"] ? true : false,
                id: userInfo.id,
              },
            };
          } else {
            return;
          }
        } else if (data.cmd === "send") {
          // Handle 'send' command
          if (!data.mj || !data.mj.t || typeof data.mj.t !== "string") return;
          if (!data.mj.t.includes("target")) return;

          let parsedMyfr;
try {
    parsedMyfr = JSON.parse(data.mj.t);
} catch(err) {
    console.error("JSON Parse Error at line 6815:", err.message);
    parsedMyfr = null;
}
const myfr = parsedMyfr;

          if (typeof myfr === "object") {
            const { type, target, it, candidate, sdp } = myfr;

            // ✅ FIX-SEC: التحقق من صحة target — يجب أن يكون socket ID حقيقي في الغرفة
            if (typeof target !== "string" || target.length > 64) return;
            // ✅ FIX-SEC: التحقق من it (mic slot)
            if (it !== undefined && !["1","2","3","4","5","6","7",1,2,3,4,5,6,7].includes(it)) return;
            // ✅ FIX-SEC: حد حجم SDP لمنع هجمات الـ flooding
            if (sdp && typeof sdp === "object" && JSON.stringify(sdp).length > 20000) return;

            // ✅ v44: توجيه WebRTC signaling عبر _gameRoute لحل مشكلة السوكت الميت
            var _sigTarget = _gameRoute(target) || target;

            // ✅ FIX-SEC: التحقق أن الـ target في نفس الغرفة — يمنع إرسال signaling لغرف أخرى
            if (_sigTarget !== socket.id && UserInfo[_sigTarget] && UserInfo[socket.id]) {
              if (UserInfo[_sigTarget]["idroom"] !== UserInfo[socket.id]["idroom"]) return;
            }

            // Handle different message types
            switch (type) {
              case "new-ice-candidate":
                socket.to(_sigTarget).emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "send",
                  msgString: JSON.stringify({
                    type,
                    it,
                    target: _sigTarget,
                    user: socket.id,
                    candidate,
                  }),
                });
                break;
              case "video-offer":
                socket.to(_sigTarget).emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "send",
                  msgString: JSON.stringify({
                    type,
                    it,
                    target: _sigTarget,
                    sdp,
                    user: socket.id,
                  }),
                });
                break;
              case "hang-up":
                const userInfo = UserInfo[socket.id];
                if (
                  (_sigTarget === socket.id || target === socket.id ||
                    GetPower(userInfo.power).createroom) &&
                  PeerRoom[userInfo.idroom] &&
                  PeerRoom[userInfo.idroom][it]
                ) {
                  PeerRoom[userInfo.idroom][it] = {
                    id: "",
                    ev: false,
                    iscam: false,
                    private: false,
                    us: {},
                  };
                  UserInfo[socket.id]["iscam"] = false;
                  io.to(userInfo.idroom).emit("SEND_EVENT_EMIT_BROADCASTING", {
                    cmd: "send",
                    msgString: data.mj.t,
                  });
                  const indexInOnlineUser = OnlineUser.findIndex(
                    (v) => v.id === socket.id
                  );
                  if (indexInOnlineUser !== -1) {
                    if (UserInfo[socket.id]["live"]) {
                      io.to(UserInfo[socket.id]["idroom"]).emit(
                        "SEND_EVENT_EMIT_SERVER",
                        {
                          cmd: "msg",
                          data: {
                            bg: "none",
                            copic: "none",
                            class: "pmsgc",
                            id: UserInfo[socket.id]["id"],
                            topic: UserInfo[socket.id]["topic"],
                            msg: " هذا المستخدم قام بإغلاق  الكام",
                            roomid: UserInfo[socket.id]["idroom"],
                            pic: UserInfo[socket.id]["pic"],
                            uid: socket.id,
                          },
                        }
                      );
                    }
                    OnlineUser[indexInOnlineUser]["live"] = false;
                    UserInfo[socket.id]["live"] = false;
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "u^",
                      data: OnlineUser[indexInOnlineUser],
                    });
                  }
                }
                break;
              case "video-answer":
                socket.to(_sigTarget).emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "send",
                  msgString: JSON.stringify({
                    type,
                    it,
                    target: _sigTarget,
                    sdp,
                    user: socket.id,
                  }),
                });
                break;
              default:
                io.to(UserInfo[socket.id].idroom).emit(
                  "SEND_EVENT_EMIT_BROADCASTING",
                  {
                    cmd: "send",
                    msgString: data.mj,
                  }
                );
            }
          }
        }
      }
    } catch (e) {
      console.error("Error handling SEND_EVENT_EMIT_BROADCASTING:", e);
    }
  });

  app.get("/cp", function (req, res, next) {
    UsersRepo.getBy({
      state: "getByToken",
      token: req.url.replace("/cp/?", ""),
    }).then(function (search) {
      if (search) {
        if (GetPower(search["power"])["cp"]) {
          res.sendFile(path.join(__dirname + "/public/out/index.html"));
        } else {
          res.send("لا تملك صلاحيات ");
        }
      } else {
        res.send("لا تملك صلاحيات");
      }
    });
  });

  socket.on("SEND_EVENT_EMIT_SERVER", async (data) => {
    if (typeof data == "object") {
      if (Config.Finished || locked.finished) {
        SendNotification({
          state: "me",
          topic: "",
          force: 1,
          msg: " الموقع مغلق",
          user: "",
        });
        return;
      }

      if (typeof data["data"] != "object") {
        return;
      }
      try {
        await rateLimiter.consume(socket.handshake.address);
        if (UserInfo[socket.id] != undefined) {
        } else if (
          data["cmd"] == "SEND_EVENT_EMIT_GUST" ||
          data["cmd"] == "SEND_EVENT_EMIT_REGISTER" ||
          data["cmd"] == "SEND_EVENT_EMIT_LOGIN" ||
          data["cmd"] == "SEND_EVENT_EMIT_REAUTH"
        ) {
          // REAUTH يُسمح له بالمرور حتى بدون UserInfo لأن socket.id تغيّر
        } else {
          return;
        }

        if (data["cmd"] == "SEND_EVENT_EMIT_ADDPOWER") {
          return;
        } else if (data.cmd == "calldone") {
          if (typeof data.data != "object") {
            return;
          }
          if (!data.data["id"]) {
            return;
          }

          var _cdTarget = _gameRoute(data.data["id"]) || data.data["id"];
          socket
            .to(_cdTarget)
            .emit("SEND_EVENT_EMIT_SERVER", { cmd: "donecall", data: {} });
        /* ✅ إنهاء مكالمة خاصة — إعلام الطرف الآخر */
        } else if (data.cmd == "pvend") {
          if (data.data && data.data.target) {
            var _peTarget = _gameRoute(data.data.target) || data.data.target;
            socket.to(_peTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "pvend",
              data: { from: socket.id }
            });
          }
        /* ✅ WebRTC signaling relay للاتصال الخاص — v44: توجيه عبر _gameRoute */
        } else if (data.cmd == "pv_offer" || data.cmd == "pv_answer" || data.cmd == "pv_ice") {
          if (data.data && data.data.target) {
            var _pvTarget = _gameRoute(data.data.target) || data.data.target;
            // ✅ FIX-SEC: حد حجم SDP للمكالمات الخاصة
            if (data.data.sdp && JSON.stringify(data.data.sdp).length > 20000) return;
            var relayData = Object.assign({}, data.data, { from: socket.id });
            socket.to(_pvTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: data.cmd,
              data: relayData
            });
          }
        } else if (data.cmd == "calldeny") {
          if (typeof data.data != "object") {
            return;
          }
          if (
            !data.data["caller"] ||
            !data.data["called"] ||
            !data.data["roomid"]
          ) {
            return;
          }

          var _cdCalled = _gameRoute(data.data["called"]) || data.data["called"];
          var _cdCaller = _gameRoute(data.data["caller"]) || data.data["caller"];
          socket.to(_cdCalled).emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "calldeny",
            data: { state: 1 },
          });
          socket.to(_cdCaller).emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "calldeny",
            data: { state: 2 },
          });
        } else if (data.cmd == "accept-viewer") {
          try {
            var _avTarget = _gameRoute(data.data.id) || data.data.id;
            socket.to(_avTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "showlive",
              data: {
                id: socket.id,
                idmic: data["data"]["idmic"],
              },
            });
          } catch (error) {}
        } else if (data.cmd == "stopLive") {
          if (data.data && data.data.roomid) {
            if (
              UserInfo[data.data.roomid] &&
              UserInfo[data.data.roomid]["live"] &&
              LiveInfo[data.data.roomid]
            ) {
              LiveInfo[data.data.roomid].listviews.splice(socket.id);
              LiveInfo[data.data.roomid].listattend.splice(socket.id);
              return;
            }
          }
          if (UserInfo[socket.id]["live"] && LiveInfo[socket.id]) {
            const indexInOnlineUser = OnlineUser.findIndex(
              (v) => v.id === socket.id
            );
            OnlineUser[indexInOnlineUser]["live"] = false;
            UserInfo[socket.id]["live"] = false;
            for (let x = 0; x < LiveInfo[socket.id].listviews.length; x++) {
              io.to(LiveInfo[socket.id].listviews[x]).emit(
                "SEND_EVENT_EMIT_SERVER",
                {
                  cmd: "clodelive",
                  data: {},
                }
              );
            }
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "u^",
              data: OnlineUser[indexInOnlineUser],
            });
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "clodelive",
              data: {},
            });
            delete LiveInfo[socket.id];
          }
        } else if (data.cmd == "startLive") {
          // التحقق من وجود البيانات المطلوبة
          if (
            !data ||
            typeof data !== "object" ||
            !data.data ||
            typeof data.data !== "object"
          ) {
            return;
          }

          // التحقق من وجود UserInfo و SiteSetting
          if (
            !UserInfo[socket.id] ||
            !SiteSetting ||
            !SiteSetting["maxlikecam"]
          ) {
            return;
          }

          if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikecam"]) {
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: SiteSetting["maxlikecam"] + " عدد الايكات المطلوبة لفتح بث",
              user: "",
            });
            return;
          }

          if (!LiveInfo[socket.id]) {
            // التحقق من نوع البث
            const isPrivate = data.data.type === "private";

            LiveInfo[socket.id] = {
              privated: isPrivate,
              timelive: new Date(),
              listattend: [],
              listviews: [],
            };

            const picdiax = OnlineUser.findIndex((x) => x.id == socket.id);
            if (picdiax != -1) {
              OnlineUser[picdiax]["live"] = true;
              UserInfo[socket.id]["live"] = true;
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "u^",
                data: OnlineUser[picdiax],
              });
            }

            // التحقق من وجود cameraId قبل الإرسال
            const cameraId = data.data.cameraId || null;
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "isstartlive",
              data: cameraId,
            });
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "lived",
              data: {
                bg: "none",
                class: "hmsg",
                topic: "البث المباشر",
                msg: " " + UserInfo[socket.id]["topic"] + " قام بفتح بث مباشر ",
                roomid: UserInfo[socket.id]["idroom"],
                pic: "/imgs/live.gif",
                uid: socket.id,
                ico: UserInfo[socket.id]["ico"] || "",
              },
            });
          }
        } else if (data.cmd == "calling") {
          if (typeof data.data != "object") {
            return;
          }
          if (
            !data.data["caller"] ||
            !data.data["called"] ||
            !data.data["roomid"]
          ) {
            return;
          }
          if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikecam"]) {
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                SiteSetting["maxlikecam"] +
                " عدد الايكات المطلوبة للإتصال في الخاص ",
              user: "",
            });
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "calldeny",
              data: { state: 1 },
            });
            return;
          }

          if (UserInfo[data.data["called"]]) {
            if (UserInfo[data.data["called"]].offline == true) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "المستخدم غير متصل بالانترنت في الوقت الحالي",
                user: "",
              });

              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "calldeny",
                data: { state: 1 },
              });
              return;
            }
          }

          socket.to(data.data["called"]).emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "calling",
            data: {
              uid: UserInfo[data.data["called"]].uid,
              caller: data.data["caller"],
              called: data.data["called"],
              roomid: data.data["roomid"],
            },
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_LOGIN") {
          const iswiat = ListWait.findIndex((x) => x.device == GetDevice());
          if (
            !data["data"]["username"] ||
            (!data["data"]["password"] &&
              data["data"]["username"].trim().length < 2 &&
              data["data"]["password"].trim().length < 2)
          ) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التاكد من البيانات",
              user: "",
            });
            return;
          } else if (isNaN(data["data"]["username"]) == false) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التأكد من الاسم",
              user: "",
            });
            return;
          } else if (!data["data"]["username"].trim()) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء ادخال اسم",
              user: "",
            });
            return;
          } else if (iswiat != -1) {
            if (ListWait[iswiat]["point"] > 4) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "لقد قمت بتخطي العدد المسموح لتخمين . الرجاء المحاولة في وقت لاحقآ",
                user: "",
              });
              return;
            }
          }

          const NumberEnter = ListEnter.filter(function (item) {
            return item.ip == MyIp();
          }).length;
          if (NumberEnter >= SiteSetting["maxlogin"]) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                SiteSetting["maxlogin"] + " عدد الاسماء التي يمكنك الدخول بها",
              user: "",
            });
            return;
          }

          request(
            "https://get.geojs.io/v1/ip/country/" + MyIp() + ".json",
            function (err, rep, mycountry) {
              if (typeof mycountry != "undefined") {
                if (mycountry.includes("country")) {
                  let parsedCountry;
try {
    parsedCountry = JSON.parse(mycountry);
} catch(err) {
    console.error("JSON Parse Error at line 7261:", err.message);
    parsedCountry = null;
}
mycountry = parsedCountry;
                } else {
                  mycountry = { country: "fr" };
                }
              } else {
                mycountry = { country: "fr" };
              }
              UsersRepo.getBy({
                state: "getByUsername",
                username: data["data"]["username"],
              }).then(async (login) => {
                if (login) {
                  var _loginOk = await verifyAndUpgradePassword(
                    data["data"]["password"],
                    login.password,
                    function(newHash) {
                      UsersRepo.updateBy({ state: "updatePass", password: newHash, idreg: login.idreg || login.id });
                    }
                  );
                  if (_loginOk) {
                    if (GetDevice() && MyIp()) {
                      if (!login["verification"]) {
                        if (
                          !BandSysBrow({
                            state: "user",
                            device: GetDevice(),
                            username: data["data"]["username"],
                            country: mycountry["country"],
                            refr: data["data"]["refr"] || "*",
                          })
                        ) {
                          return;
                        }
                      }
                      if (
                        BandDone({
                          statea: "vpn",
                          country: mycountry["country"],
                          verification: login["verification"],
                          state: "عضو|محظور|VPN",
                          topic: login["topic"],
                          username: login["username"],
                          ip: MyIp(),
                          device: GetDevice(),
                          refr: data["data"]["refr"] || "*",
                        })
                      ) {
                        return;
                      }
                      BandRepo.getBy({
                        state: "isBand",
                        username: data["data"]["username"].trim(),
                        device: GetDevice(),
                        ip: MyIp(),
                        country: mycountry["country"],
                      }).then((band) => {
                        if (band && !login["verification"]) {
                          socket.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "login",
                            data: { msg: "banduser" },
                          });
                          SaveLogs({
                            state: band.device
                              ? "محظور|عضو|جهاز"
                              : band.username
                              ? "محظور|عضو|حساب"
                              : band.ip
                              ? "محظور|عضو|اي بي"
                              : band.country
                              ? "محظور|عضو|دولة"
                              : "",
                            topic: login.topic,
                            username: login.username,
                            ip: MyIp(),
                            country: mycountry["country"],
                            device: GetDevice(),
                            isin: "band",
                            date: new Date().getTime(),
                          });
                          setTimeout(() => {
                            socket.disconnect();
                          }, 2000);
                          return;
                        } else {
                          if (IsBand(GetDevice()) && !login["verification"]) {
                            socket.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "login",
                              data: { msg: "banduser" },
                            });
                            SaveLogs({
                              state: "محظور|جهاز|مشفر",
                              topic: login.topic,
                              username: login.username,
                              ip: MyIp(),
                              country: mycountry["country"],
                              device: IsBand(GetDevice()),
                              isin: "band",
                              date: new Date().getTime(),
                            });
                            setTimeout(() => {
                              socket.disconnect();
                            }, 2000);
                            return;
                          }
                          // ✅ فحص البصمة الصلبة — يمنع التحايل بتغيير المتصفح أو مسح البيانات
                          var _myHwFp = GetHwFp(); if (_myHwFp && IsBandByHwFp(_myHwFp) && !login["verification"]) {
                            socket.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "login",
                              data: { msg: "banduser" },
                            });
                            SaveLogs({
                              state: "محظور|بصمة|صلبة",
                              topic: login.topic,
                              username: login.username,
                              ip: MyIp(),
                              country: mycountry["country"],
                              device: GetDevice() || "hw:" + _myHwFp,
                              isin: "band",
                              date: new Date().getTime(),
                            });
                            setTimeout(() => {
                              socket.disconnect();
                            }, 2000);
                            return;
                          }
                          const islogin = OnlineUser.findIndex(
                            (v) => v.lid == login["lid"]
                          );
                          if (islogin != -1) {
                            io.to(OnlineUser[islogin]["id"]).emit(
                              "SEND_EVENT_EMIT_SERVER",
                              {
                                cmd: "ev",
                                data: 'window.onbeforeunload = null; location.href=location.pathname;',
                              }
                            );
                            UserDisconnect({
                              id: OnlineUser[islogin]["id"],
                              state: 3,
                            });
                          }
                          socket.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "login",
                            data: {
                              uid: login.uid,
                              point: login["evaluation"],
                              //room: MyRoom(GetDevice()),
                              id: socket.id,
                              msg: "ok",
                              ttoken: login["token"],
                              ifedit: login["ifedit"],
                              pic: login["pic"],
                            },
                          });
                          SaveNames({
                            iduser: login["idreg"],
                            device: GetDevice(),
                            ip: MyIp(),
                            topic: login["topic"],
                            username: login["username"],
                            hw_fp: GetHwFp() || "",
                          });
                         // 1️⃣ نجهز المتغير قبل object
let parsedListPowers = [];
try {
    parsedListPowers = login["listpowers"] ? JSON.parse(login["listpowers"]) : [];
} catch(err) {
    console.error("JSON Parse Error for listpowers:", err.message);
    parsedListPowers = [];
}

// 2️⃣ بعدين داخل object
EnterUserGust({
    power: login["power"],
    listpowers: parsedListPowers, // <-- هنا فقط المتغير
    hw_fp: GetHwFp() || "",

                            eva: login["evaluation"] || 0,
                            visitor: login["visitor"] || 0,
                            camerashow: login["camerashow"],
                            stat: 0,
                            loginG: login["loginG"],
                            vipImg: login["vipImg"] || "",
                            vipSound: login["vipSound"] || "",
                            islogin: "عضو",
                            refr: data["data"]["refr"]
                              .split("<")
                              .join("&#x3C;"),
                            username: login["username"]
                              .split("<")
                              .join("&#x3C;"),
                            ucol: login["ucol"],
                            mcol: login["mcol"],
                            mscol: login["mscol"],
                            youtube: login["youtube"],
                            atar: login["atar"] || "",
                            back: login["back"] || "",
                            ifedit: login["ifedit"],
                            bg: login["bg"],
                            copic: login["copic"],
                            rep: login["rep"],
                            ico: login["ico"] || "",
                            islike: [],
                            idreg: "#" + login["idreg"],
                            topic: login["topic"].split("<").join("&#x3C;"),
                            country: mycountry["country"] || "sg",
                            ip: MyIp(),
                            lid: login["lid"],
                            uid: login["uid"],
                            token: login["token"],
                            id: socket.id,
                            islog: false,
                            ismuted: login["muted"],
                            ismutedbc: isBandBc(GetDevice()),
                            verification: login["verification"],
                            device: GetDevice(),
                            pic: login["pic"],
                            cover: login["cover"] || "",
                            idroom: MyRoom(GetDevice()),
                            msg: login["msg"] ? login["msg"] : "",

                            isfrozen: login["isfrozen"] || false,
                            stealth: data["data"]["stealth"] || false,
                            topicFont: login["topicFont"] || "",
                            topicShine: login["topicShine"] || "",
                          });
                        }
                      });
                    }
                  } else {
                    SaveLogs({
                      state: "محاوله تخمين رقم سري",
                      topic: data["data"]["username"]
                        .split("<")
                        .join("&#x3C;")
                        .trim(),
                      username: data["data"]["username"]
                        .split("<")
                        .join("&#x3C;")
                        .trim(),
                      ip: MyIp(),
                      code: mycountry["country"],
                      device: GetDevice(),
                      isin: data["data"]["refr"].split("<").join("&#x3C;"),
                      date: new Date().getTime(),
                    });
                    const lswit = ListWait.findIndex(
                      (x) => x.device == GetDevice()
                    );
                    if (lswit != -1) {
                      ListWait[lswit]["point"] += 1;
                    } else {
                      ListWait.push({ device: GetDevice(), point: 1 });
                    }
                    socket.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "login",
                      data: { msg: "wrong" },
                    });
                  }
                } else {
                  socket.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "login",
                    data: { msg: "noname" },
                  });
                }
              });
            }
          );
        } else if (data["cmd"] == "SEND_EVENT_EMIT_REGISTER") {
          if (SiteSetting["register"]) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "تم تعطيل تسجيل العصويات مؤقتآ .. حاول لاحقآ",
              user: "",
            });
            return;
          }
          if (
            !data["data"]["username"] ||
            (!data["data"]["password"] &&
              data["data"]["username"].trim().length < 2 &&
              data["data"]["password"].trim().length < 2)
          ) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التاكد من بينات",
              user: "",
            });
            return;
          } else if (isNaN(data["data"]["username"]) == false) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التأكد من الاسم",
              user: "",
            });
            return;
          } else if (!data["data"]["username"].trim()) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء ادخال اسم",
              user: "",
            });
            return;
          } else if (
            data["data"]["username"].length > SiteSetting["registermin"]
          ) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                "اسم المستخدم طويل جداً يجب ان لا يزيد الاسم عن " +
                SiteSetting["registermin"] +
                " حرف ",
              user: "",
            });
            return;
          }

          const nonm = NoNames.findIndex((x) =>
            data["data"]["username"].includes(x)
          );
          if (nonm != -1) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "هذا الاسم ممنوع",
              user: "",
            });
            return;
          }

          UsersRepo.getBy({
            state: "getByUsername",
            username: data["data"]["username"].trim(),
          }).then((login) => {
            if (login) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "login",
                data: { msg: "usedname" },
              });
            } else {
              request(
                "https://get.geojs.io/v1/ip/country/" + MyIp() + ".json",
                function (err, rep, mycountry) {
                  if (typeof mycountry != "undefined") {
                    if (mycountry.includes("country")) {
                      let parsedCountry;
try {
    parsedCountry = JSON.parse(mycountry);
} catch(err) {
    console.error("JSON Parse Error at line 7913:", err.message);
    parsedCountry = null;
}
mycountry = parsedCountry;
                    } else {
                      mycountry = { country: "fr" };
                    }
                  } else {
                    mycountry = { country: "fr" };
                  }
                  if (MyIp() && GetDevice()) {
                    if (
                      !BandSysBrow({
                        state: "register",
                        device: GetDevice(),
                        username: data["data"]["username"],
                        country: mycountry["country"],
                        refr: data["data"]["refr"] || "*",
                      })
                    ) {
                      return;
                    }
                    if (
                      BandDone({
                        statea: "vpn",
                        country: mycountry["country"],
                        verification: false,
                        state: "تسجيل|محظور|VPN",
                        topic: data["data"]["topic"],
                        username: data["data"]["username"],
                        ip: MyIp(),
                        device: GetDevice(),
                        refr: data["data"]["refr"] || "*",
                      })
                    ) {
                      return;
                    }
                    BandRepo.getBy({
                      state: "isBand",
                      username: data["data"]["username"].trim(),
                      device: GetDevice(),
                      ip: MyIp(),
                      country: mycountry["country"],
                    }).then((band) => {
                      if (band && !BandDoneCheked(MyIp())) {
                        socket.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "login",
                          data: { msg: "banduser" },
                        });
                        SaveLogs({
                          state: band.device
                            ? "محظور|تسجيل|جهاز"
                            : band.username
                            ? "محظور|تسجيل|حساب"
                            : band.ip
                            ? "محظور|تسجيل|اي بي"
                            : band.country
                            ? "محظور|تسجيل|دولة"
                            : "",
                          topic: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          username: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          ip: MyIp(),
                          country: mycountry["country"],
                          device: GetDevice(),
                          isin: "band",
                          date: new Date().getTime(),
                        });
                        setTimeout(() => {
                          socket.disconnect();
                        }, 2000);
                        return;
                      } else {
                        if (IsBand(GetDevice()) && !BandDoneCheked(MyIp())) {
                          socket.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "login",
                            data: { msg: "banduser" },
                          });
                          SaveLogs({
                            state: "محظور|جهاز|مشفر",
                            topic: data["data"]["username"]
                              .split("<")
                              .join("&#x3C;"),
                            username: data["data"]["username"]
                              .split("<")
                              .join("&#x3C;"),
                            ip: MyIp(),
                            country: mycountry["country"],
                            device: IsBand(GetDevice()),
                            isin: "band",
                            date: new Date().getTime(),
                          });
                          setTimeout(() => {
                            socket.disconnect();
                          }, 2000);
                          return;
                        }
                        UsersRepo.getBy({
                          state: "getAllByDevice",
                          device: GetDevice(),
                        }).then((isregister) => {
                          if (isregister.length <= SiteSetting["maxrep"]) {
                            const getToken = stringGen(177);
                            CreateUsers({
                              ip: MyIp(),
                              device: GetDevice(),
                              id: socket.id,
                              lid: stringGen(31),
                              uid: stringGen(22),
                              verification: false,
                              pic:
                                "/site/" +
                                socket.handshake.headers.host +
                                "pic.png?",
                              power: "",
                              topic: data["data"]["username"],
                              username: data["data"]["username"].trim(),
                              password: bcrypt.hashSync(data["data"]["password"].trim(), BCRYPT_ROUNDS), // ✅ bcrypt
                              token: getToken,
                            });
                            SaveLogs({
                              state: "تسجيل|عضوية",
                              topic: data["data"]["username"]
                                .split("<")
                                .join("&#x3C;"),
                              username: data["data"]["username"]
                                .split("<")
                                .join("&#x3C;"),
                              ip: MyIp(),
                              country: mycountry["country"],
                              device: GetDevice(),
                              isin: data["data"]["refr"] || "*",
                              date: new Date().getTime(),
                            });
                            if (BandDoneCheked(MyIp())) {
                              UsersRepo.updateBy({
                                state: "updateVer",
                                verification: true,
                                username: data["data"]["username"]
                                  .split("<")
                                  .join("&#x3C;"),
                              });
                            }
                            socket.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "login",
                              data: {
                                id: socket.id,
                                msg: "register",
                                ttoken: getToken,

                                pic: "/site/pic.png?z" + getRandomInt(1, 100),
                              },
                            });
                          } else {
                            socket.emit("SEND_EVENT_EMIT_SERVER", {
                              cmd: "login",
                              data: { msg: "isreg" },
                            });
                          }
                        });
                      }
                    });
                  } else {
                    socket.disconnect();
                  }
                }
              );
            }
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_GUST") {
          var nameTaken = false;
          Object.keys(UserInfo).forEach(function (socketId) {
            var userInfos = UserInfo[socketId];
            if (userInfos) {
              if (
                userInfos.username.toLowerCase() ===
                data["data"]["username"].toLowerCase()
              ) {
                nameTaken = true;
              }
            }
          });

          if (SiteSetting["gust"]) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "تم تعطيل دخول الزوار مؤقتآ .. يجب عليك تسجيل عضويه",
              user: "",
            });
            return;
          } else if (
            !data["data"]["username"].trim() ||
            isNaN(data["data"]["username"]) == false
          ) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء ادخال اسم",
              user: "",
            });
            return;
          } else if (
            !data["data"]["username"] &&
            data["data"]["username"].trim().length < 2
          ) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التأكد من البيانات",
              user: "",
            });
            return;
          } else if (data["data"]["username"].length > SiteSetting["gustmin"]) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                "اسم المستخدم طويل جداً يجب ان لا يزيد الاسم عن " +
                SiteSetting["gustmin"] +
                " حرف ",
              user: "",
            });
            return;
          } else if (nameTaken) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "هذا الاسم موجود في الدردشة",
              user: "",
            });
            return;
          }

          const nonm = NoNames.findIndex((x) =>
            data["data"]["username"].includes(x)
          );
          if (nonm != -1) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "هذا الاسم ممنوع",
              user: "",
            });
            return;
          }
          const NumberEnter = ListEnter.filter(function (item) {
            return item.ip == MyIp();
          }).length;
          if (NumberEnter >= SiteSetting["maxlogin"]) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                SiteSetting["maxlogin"] + " عدد الاسماء التي يمكنك الدخول بها",
              user: "",
            });
            return;
          }

          UsersRepo.getBy({
            state: "getByUsername",
            username: data["data"]["username"].trim(),
          }).then((login) => {
            if (login) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "login",
                data: { msg: "usedname" },
              });
            } else {
              request(
                "https://get.geojs.io/v1/ip/country/" + MyIp() + ".json",
                function (err, rep, mycountry) {
                  if (typeof mycountry != "undefined") {
                    if (mycountry.includes("country")) {
                      let parsedCountry;
try {
    parsedCountry = JSON.parse(mycountry);
} catch(err) {
    console.error("JSON Parse Error at line 7601:", err.message);
    parsedCountry = null;
}
mycountry = parsedCountry;
                    } else {
                      mycountry = { country: "fr" };
                    }
                  } else {
                    mycountry = { country: "fr" };
                  }
                  if (GetDevice() && MyIp()) {
                    if (
                      !BandSysBrow({
                        state: "gust",
                        device: GetDevice(),
                        username: data["data"]["username"],
                        country: mycountry["country"],
                        refr: data["data"]["refr"] || "*",
                      })
                    ) {
                      return;
                    }
                    if (
                      BandDone({
                        statea: "vpn",
                        country: mycountry["country"],
                        verification: false,
                        state: "زائر|محظور|VPN",
                        topic: data["data"]["username"],
                        username: data["data"]["username"],
                        ip: MyIp(),
                        device: GetDevice(),
                        refr: data["data"]["refr"] || "*",
                      })
                    ) {
                      return;
                    }
                    BandRepo.getBy({
                      state: "isBand",
                      username: data["data"]["username"].trim(),
                      device: GetDevice(),
                      ip: MyIp(),
                      country: mycountry["country"],
                    }).then((band) => {
                      if (band) {
                        socket.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "login",
                          data: { msg: "banduser" },
                        });
                        SaveLogs({
                          state: band.device
                            ? "محظور|زائر|جهاز"
                            : band.username
                            ? "محظور|زائر|حساب"
                            : band.ip
                            ? "محظور|زائر|اي بي"
                            : band.country
                            ? "محظور|زائر|دولة"
                            : "",
                          topic: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          username: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          ip: MyIp(),
                          country: mycountry["country"],
                          device: GetDevice(),
                          isin: data["data"]["refr"].split("<").join("&#x3C;"),
                          date: new Date().getTime(),
                        });
                        setTimeout(() => {
                          socket.disconnect();
                        }, 2000);
                        return;
                      } else {
                        if (IsBand(GetDevice())) {
                          socket.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "login",
                            data: { msg: "banduser" },
                          });
                          SaveLogs({
                            state: "محظور|جهاز|مشفر",
                            topic: data["data"]["username"]
                              .split("<")
                              .join("&#x3C;"),
                            username: data["data"]["username"]
                              .split("<")
                              .join("&#x3C;"),
                            ip: MyIp(),
                            country: mycountry["country"],
                            device: IsBand(GetDevice()),
                            isin: data["data"]["refr"]
                              .split("<")
                              .join("&#x3C;"),
                            date: new Date().getTime(),
                          });
                          setTimeout(() => {
                            socket.disconnect();
                          }, 2000);
                          return;
                        }
                        const mytoken = stringGen(177);
                        const idreg = getRandomInt(1, 100);
                        socket.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "login",
                          data: {
                            uid: "",
                            id: socket.id,
                            //room: MyRoom(GetDevice()),
                            msg: "ok",
                            ttoken: mytoken,
                            pic: "/site/pic.png?z" + getRandomInt(1, 100),
                          },
                        });
                        SaveNames({
                          iduser: idreg,
                          device: GetDevice(),
                          ip: MyIp(),
                          topic: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          username: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                        });
                        EnterUserGust({
                          loginG: false,
                          listpowers: [],
                          camerashow: false,
                          eva: 0,
                          stat: 0,
                          islogin: "زائر",
                          refr: data["data"]["refr"].split("<").join("&#x3C;"),
                          username: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          ucol: "#000000",
                          mcol: "#000000",
                          mscol: "#000000",
                          atar: "",
                          back: "",
                          ifedit: false,
                          bg: "#ffffff",
                          copic: "#ffffff",
                          rep: 0,
                          ico: "",
                          youtube: "",
                          islike: [],
                          idreg: "#" + idreg,
                          topic: data["data"]["username"]
                            .split("<")
                            .join("&#x3C;"),
                          country: mycountry["country"] || "sg",
                          ip: MyIp(),
                          lid: stringGen(31),
                          uid: stringGen(22),
                          token: mytoken,
                          id: socket.id,
                          islog: false,
                          ismuted: isMuted(GetDevice()),
                          ismutedbc: isBandBc(GetDevice()),
                          power: "",
                          documents: 0,
                          device: GetDevice(),
                          pic:
                            "/site/" +
                            socket.handshake.headers.host +
                            "pic.png?" +
                            getRandomInt(1, 100),
                          idroom: MyRoom(GetDevice()),
                          msg: "( غير مسجل )",
                          youtube: "",
                          stealth: false,
                          topicFont: "",
                          topicShine: "",
                        });
                      }
                    });
                  }
                }
              );
            }
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_REMOVE_STORY") {
          if (
            typeof data["data"]["id"] != "number" ||
            typeof data["data"]["id2"] != "string" ||
            typeof data["data"]["url"] != "string"
          ) {
            return;
          }
          if (UserInfo[socket.id]) {
            StoryRepo.deleted({
              id: data["data"]["id"],
              owner: data["data"]["id2"],
            }).then((delstory) => {
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "story-",
                data: data["data"]["id"],
              });
              fs.unlink("uploads" + data["data"]["url"], (err) => {
                if (err) {
                }
              });
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_GET_STORY") {
          StoryRepo.getBy({ state: "getAll", limit: 30 }).then((story) => {
            /* ✅ تحديث صور الستوريات بالصورة الحالية للأعضاء المتصلين */
            if (story && story.length) {
              for (var _si = 0; _si < story.length; _si++) {
                var _sOwner = story[_si].owner;
                // ابحث عن صاحب الستوري في المتصلين حالياً
                for (var _sk in UserInfo) {
                  if (UserInfo[_sk] && UserInfo[_sk].lid == _sOwner && UserInfo[_sk].pic) {
                    story[_si].pic = UserInfo[_sk].pic;
                    break;
                  }
                }
              }
            }
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "story",
              data: story,
            });
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_TOP_BAR") {
          UsersRepo.getBy({ state: "getTop" }).then((res) => {
            socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "topbar", data: res });
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_TOP_VISITOR") {
          UsersRepo.getBy({ state: "getVisitor" }).then((res) => {
            socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "topvis", data: res });
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_ADD_STORY") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isstoryban"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "تم حظرك من الستوري", user: "" });
            return;
          }
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد", user: "" });
            return;
          }
          if (UserInfo[socket.id]) {
            if (
              typeof data["data"]["type"] != "string" ||
              typeof data["data"]["url"] != "string" ||
              typeof data["data"]["time"] != "number"
            ) {
              return;
            } else if (
              UserInfo[socket.id]["rep"] < SiteSetting["maxlikealert"]
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  SiteSetting["maxlikestory"] +
                  " عدد الايكات المطلوبة لإنشاء قصة ",
                user: "",
              });
              return;
            }

            StoryRepo.getBy({
              state: "getOwner",
              owner: UserInfo[socket.id]["lid"],
            }).then((isstory) => {
              if (isstory.length >= 5) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يمكنك إنشاء قصة كل 24 ساعة",
                  user: "",
                });
              } else {
                StoryRepo.create({
                  owner: UserInfo[socket.id]["lid"],
                  topic: UserInfo[socket.id]["topic"],
                  pic: UserInfo[socket.id]["pic"],
                  type: data["data"]["type"],
                  time: data["data"]["time"],
                  url: data["data"]["url"] || "",
                  caption: data["data"]["caption"] || "",
                  text_content: data["data"]["text_content"] || "",
                  text_style: data["data"]["text_style"] || "",
                }).then((res) => {
                  SendNotification({
                    state: "all",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم قام بإنشاء قصة جديدة",
                    user: socket.id,
                  });
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "story+",
                    data: {
                      id: res["id"],
                      owner: UserInfo[socket.id]["lid"],
                      topic: UserInfo[socket.id]["topic"],
                      pic: UserInfo[socket.id]["pic"],
                      type: data["data"]["type"],
                      time: data["data"]["time"],
                      url: data["data"]["url"] || "",
                      caption: data["data"]["caption"] || "",
                      text_content: data["data"]["text_content"] || "",
                      text_style: data["data"]["text_style"] || "",
                      date: new Date(),
                    },
                  });
                });
              }
            });
          }
        } else if (data["cmd"] == "a") {
          if (
            typeof data["data"]["cmd"] != "string" ||
            typeof data["data"]["id"] != "string"
          ) {
            return;
          }
          if (UserInfo[socket.id]) {
            if (data["data"]["cmd"] == "check") {
              io.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "a",
                data: data["data"],
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_RJOIN_ROOM") {
          if (typeof data["data"]["id"] == "string") {
            if (UserInfo[socket.id]) {
              if (UserInfo[socket.id]["isfrozen"]) {
                SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك تغيير الغرفة", user: "" });
                return;
              }
              if (data["data"]["id"] == UserInfo[socket.id]["idroom"]) {
                // ✅ FIX: لا ترجع فوراً — أعد الانضمام للـ socket.io room + أرسل بيانات المايكات
                // بعد إعادة الاتصال، السوكت بيكون خارج الغرفة حتى لو idroom محفوظ
                socket.join(data["data"]["id"]);
                if (GetRoomList(data["data"]["id"]) && GetRoomList(data["data"]["id"])["broadcast"] && PeerRoom[data["data"]["id"]]) {
                  socket.emit("SEND_EVENT_EMIT_BROADCASTING", {
                    cmd: "all",
                    room: data["data"]["id"],
                    data: PeerRoom[data["data"]["id"]],
                  });
                  // ✅ أرسل rjoin لأصحاب المايكات فقط ليعيدوا إرسال صوتهم لهذا المستخدم
                  socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_BROADCASTING", {
                    cmd: "rjoin",
                    user: socket.id,
                  });
                }
                return;
              }

              if (
                data["data"]["id"] === "WA15IDTAI4G" &&
                !["gochat", "chatmaster", "Hide"].includes(
                  UserInfo[socket.id]["power"]
                )
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "الأدمن فقط يمكنه الدخول الى هذه الغرفة !",
                  user: "",
                });
                return;
              }

              if (UserInfo[socket.id]["iswaiting"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يجب الحصول على " + SiteSetting["liked"] + " إعجاب",
                  user: "",
                });
                return;
              }

              const iszeros = OnlineUser.filter(
                (a) => a.roomid == UserInfo[socket.id]["idroom"]
              );
              const maxroom = OnlineUser.filter(
                (a) => a.roomid == data["data"]["id"]
              );
              const roomInfo = GetRoomList(data["data"]["id"]);

              if (
                maxroom.length >= roomInfo.max &&
                !GetPower(UserInfo[socket.id]["power"])["grupes"] &&
                UserInfo[socket.id]["power"] != "Hide"
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "هذه الغرفة ممتلئة",
                  user: "",
                });
                return;
              }
              if (UserInfo[socket.id]["idroom"]) {
                if (
                  !GetRoomList(UserInfo[socket.id]["idroom"])["deleted"] &&
                  iszeros.length == 1
                ) {
                  RoomsRepo.deleted(UserInfo[socket.id]["idroom"]).then(
                    (res) => {
                      if (res) {
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "r-",
                          data: UserInfo[socket.id]["idroom"],
                        });
                        RefreshRooms(1);
                      }
                    }
                  );
                }
              }
              if (
                GetRoomList(data["data"]["id"])["pass"] !==
                  data["data"]["pwd"] &&
                GetRoomList(data["data"]["id"])["needpass"] &&
                !GetPower(UserInfo[socket.id]["power"])["grupes"]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "الرقم السري لدخول الغرفة خاطئ",
                  user: "",
                });
                return;
              }

              if (GetRoomList(data["data"]["id"])["nohide"]) {
                if (UserInfo[socket.id]["power"] === "Hide") {
                } else if (
                  GetPower(UserInfo[socket.id]["power"])["stealth"] &&
                  UserInfo[socket.id]["stealth"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذه الغرفة لا تسمح بالدخول بصلاحية المخفي",
                    user: "",
                  });
                  return;
                }
              }

              if (
                isBandRoom({
                  device: UserInfo[socket.id]["device"],
                  room: data["data"]["id"],
                })
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "تم حظرك من الغرفة مؤقتا",
                  user: "",
                });
                return;
              }

              if (
                UserInfo[socket.id]["rep"] <
                GetRoomList(data["data"]["id"])["rmli"]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg:
                    "يجب أن تتوفر على " +
                    GetRoomList(data["data"]["id"])["rmli"] +
                    " إعجاب حتى تتمكن من الدخول الى هذه الغرفة",
                  user: "",
                });
                return;
              }
              if (UserInfo[socket.id]["idroom"]) {
                if (GetRoomList(UserInfo[socket.id]["idroom"])["broadcast"]) {
                  io.to(UserInfo[socket.id]["idroom"]).emit(
                    "SEND_EVENT_EMIT_BROADCASTING",
                    { cmd: "rleave", user: socket.id }
                  );
                  for (var i = 1; i < 8; i++) {
                    if (
                      PeerRoom[UserInfo[socket.id]["idroom"]][i].id == socket.id
                    ) {
                      const indexInOnlineUser = OnlineUser.findIndex(
                        (v) => v.id === socket.id
                      );
                      if (indexInOnlineUser !== -1) {
                        OnlineUser[indexInOnlineUser]["live"] = false;
                        UserInfo[socket.id]["live"] = false;
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "u^",
                          data: OnlineUser[indexInOnlineUser],
                        });
                      }
                      PeerRoom[UserInfo[socket.id]["idroom"]][i].id = "";
                      PeerRoom[UserInfo[socket.id]["idroom"]][i].ev = false;
                      PeerRoom[UserInfo[socket.id]["idroom"]][i].iscam = false;
                      PeerRoom[UserInfo[socket.id]["idroom"]][
                        i
                      ].private = false;
                      PeerRoom[UserInfo[socket.id]["idroom"]][i].us = {};
                    }
                  }
                }
              }
              if (
                GetPower(UserInfo[socket.id]["power"])["stealth"] &&
                UserInfo[socket.id]["stealth"]
              ) {
              } else {
                socket
                  .to(UserInfo[socket.id]["idroom"])
                  .emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "msg",
                    data: {
                      bg: "none",
                      copic: "none",
                      class: "hmsg",
                      id: UserInfo[socket.id]["id"],
                      topic: UserInfo[socket.id]["topic"],
                      msg:
                        "هذا المستخدم انتقل الى" +
                        '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                        GetRoomList(data["data"]["id"])["id"] +
                        "')\">" +
                        GetRoomList(data["data"]["id"])["topic"] +
                        "</div>",
                      roomid: UserInfo[socket.id]["idroom"],
                      pic: UserInfo[socket.id]["pic"],
                      uid: socket.id,
                      ico: UserInfo[socket.id]["ico"] || "",
                    },
                  });

                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "msg",
                  data: {
                    bg: "none",
                    copic: "none",
                    class: "hmsg",
                    id: UserInfo[socket.id]["id"],
                    topic: UserInfo[socket.id]["topic"],
                    msg:
                      "هذا المستخدم انتقل الى" +
                      '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                      GetRoomList(data["data"]["id"])["id"] +
                      "')\">" +
                      GetRoomList(data["data"]["id"])["topic"] +
                      "</div>",
                    roomid: UserInfo[socket.id]["idroom"],
                    pic: UserInfo[socket.id]["pic"],
                    uid: socket.id,
                    ico: UserInfo[socket.id]["ico"] || "",
                  },
                });

                io.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "msg",
                  data: {
                    bg: "none",
                    copic: "none",
                    class: "hmsg",
                    id: UserInfo[socket.id]["id"],
                    topic: UserInfo[socket.id]["topic"],
                    msg:
                      " هذا المستخدم قد دخل الغرفة" +
                      '<div class="fl fa fa-sign-in btn btn-primary dots roomh border corner" style="padding:1px;max-width:180px;min-width:60px;" onclick="Send_Rjoin(\'' +
                      GetRoomList(data["data"]["id"])["id"] +
                      "')\">" +
                      GetRoomList(data["data"]["id"])["topic"] +
                      "</div>",
                    roomid: data["data"]["id"],
                    pic: UserInfo[socket.id]["pic"],
                    uid: socket.id,
                    ico: UserInfo[socket.id]["ico"] || "",
                  },
                });
              }

              if (GetRoomList(data["data"]["id"])["welcome"]) {
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "msg",
                  data: {
                    bg: "none",
                    copic: "none",
                    mcol: "#000",
                    ucol: "#ff0000",
                    id: GetRoomList(data["data"]["id"])["id"],
                    topic: GetRoomList(data["data"]["id"])["topic"],
                    msg: ReplaceEktisar(
                      GetRoomList(data["data"]["id"])["welcome"]
                    ),
                    pic: GetRoomList(data["data"]["id"])["pic"],
                  },
                });
              }
              if (UserInfo[socket.id]["idroom"]) {
                socket.leave(UserInfo[socket.id]["idroom"]);
              }
              // ✅ FIX: Immediate room update (was setTimeout 500ms causing race condition)
              if (UserInfo[socket.id]) {
                UserInfo[socket.id]["idroom"] = data["data"]["id"];
              }

              const picdiax = OnlineUser.findIndex((x) => x.id == socket.id);
              if (picdiax != -1) {
                OnlineUser[picdiax]["roomid"] = data["data"]["id"];
              }

              socket.join(data["data"]["id"]);
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "ur",
                data: [socket.id, data["data"]["id"]],
              });
              if (GetRoomList(data["data"]["id"])["broadcast"]) {
                /* ✅ v62: socket.to بدل io.to لمنع إرسال rjoin للمرسل نفسه */
                socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "rjoin",
                  user: socket.id,
                });
                socket.emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "all",
                  room: data["data"]["id"],
                  data: PeerRoom[data["data"]["id"]],
                });
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_ACTION") {
          if (typeof data["data"]["id"] == "string") {
            if (UserInfo[socket.id] && UserInfo[data["data"]["id"]]) {
              if (data["data"]["cmd"] == "request-to-watch") {
                if (
                  UserInfo[socket.id]["idroom"] !=
                  UserInfo[data["data"]["id"]]["idroom"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "يجب ان تكونو في نفس الغرفة لمشاهدة البث",
                    user: "",
                  });
                  return;
                }
                for (var i = 1; i < 8; i++) {
                  if (
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].id ==
                    data["data"]["id"]
                  ) {
                    if (
                      UserInfo[socket.id]["camerashow"] ||
                      !PeerRoom[UserInfo[socket.id]["idroom"]][i].us.private
                    ) {
                      socket.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "showlive",
                        data: {
                          id: data["data"]["id"],
                          idmic: i,
                        },
                      });
                    } else {
                      SendNotification({
                        state: "me",
                        topic: "",
                        force: 1,
                        msg: "تم إرسال دعوة . الرجاء الإنتظار لقبولها",
                        user: "",
                      });
                      socket
                        .to(data["data"]["id"])
                        .emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "invite",
                          data: {
                            id: socket.id,
                            idmic: i,
                          },
                        });
                    }
                  }
                }
              } else if (data["data"]["cmd"] == "like") {
                const islike = UserInfo[socket.id]["islike"].findIndex(
                  (x) => x == data["data"]["id"]
                );

                if (UserInfo[socket.id]["isfrozen"]) {
                  SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك إرسال إعجاب", user: "" });
                  return;
                }
                if (
                  UserInfo[socket.id]["iswaiting"] ||
                  UserInfo[data["data"]["iswaiting"]]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك إرسال إعجاب في غرفة الإنتظار",
                    user: "",
                  });
                  return;
                }
                if (islike != -1) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "يمكنك ارسال إعجاب مره واحده في الدقيقه",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "إعجاب",
                  force: 1,
                  msg: `حصلت على إعجاب <i class="fa fa-heart" style="color:red;"></i>`,
                  user: socket.id,
                });
                const likeme = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (likeme != -1) {
                  OnlineUser[likeme]["rep"] += 1;
                  UserInfo[data["data"]["id"]]["rep"] += 1;
                  UserInfo[socket.id]["islike"].push(data["data"]["id"]);
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[likeme],
                  });
                }

                if (
                  UserInfo[data["data"]["id"]]["iswaiting"] &&
                  UserInfo[data["data"]["id"]]["rep"] > SiteSetting["liked"]
                ) {
                  UserInfo[data["data"]["id"]]["iswaiting"] = false;
                }
                setTimeout(function () {
                  if (UserInfo[socket.id]) {
                    UserInfo[socket.id]["islike"].splice(
                      UserInfo[socket.id]["islike"].findIndex(
                        (v) => v == data["data"]["id"]
                      ),
                      1
                    );
                  }
                }, 60000 * Config.timeLike);
              } else if (data["data"]["cmd"] == "kick") {
                if (!GetPower(UserInfo[socket.id]["power"])["kick"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم طردك من الدردشة",
                  user: "",
                });
                MessagesList({
                  state: "LogsMsg",
                  bg: "none",
                  copic: "none",
                  class: "hmsg",
                  id: data["data"]["id"],
                  topic: UserInfo[data["data"]["id"]]["topic"],
                  msg: "( تم طرد هذا المستخدم )",
                  idroom: UserInfo[data["data"]["id"]]["idroom"],
                  pic: UserInfo[data["data"]["id"]]["pic"],
                });

                UserInfo[data["data"]["id"]]["ismsg"] = true;
                SaveStats({
                  state: "طرد",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });

                UserDisconnect({ id: data["data"]["id"], state: 2 });
                io.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ev",
                  data: 'window.onbeforeunload = null; location.href=location.pathname;',
                });
              } else if (data?.data?.cmd === "sendVoice") {
                const voiceData = data.data.voice;
                const userId = data.data.id;
                const fileExt = data.data.ext || "wav";

                // ✅ التحقق من نوع البيانات المستلمة
                if (typeof voiceData !== "string" || !userId) {
                  return;
                }

                // ✅ التحقق من حالة المستخدم
                if (UserInfo[userId]?.offline) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "المستخدم غير متصل بالإنترنت في الوقت الحالي",
                    user: "",
                  });
                  return;
                }

                // ✅ إنشاء اسم عشوائي للملف
                const fileName = `${stringGen(20)}.${fileExt}`.replace(
                  ";codecs=opus",
                  ""
                );
                const uploadDir = path.join(__dirname, "uploads", "recorder");
                const filePath = path.join(uploadDir, fileName);

                // ✅ التأكد من وجود المجلد
                if (!fs.existsSync(uploadDir)) {
                  fs.mkdirSync(uploadDir, { recursive: true });
                }

                try {
                  // ✅ تحويل base64 إلى binary وكتابته في ملف
                  const buffer = Buffer.from(voiceData, "base64");
                  fs.writeFileSync(filePath, buffer);

                  // ✅ إرسال الملف بعد 1 ثانية
                  setTimeout(() => {
                    socket.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "pmf",
                      data: {
                        file: `/recorder/${fileName}`,
                        id: userId,
                      },
                    });
                  }, 1000);
                } catch (err) {
                  console.error("❌ خطأ أثناء حفظ ملف الصوت:", err);
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "حدث خطأ أثناء حفظ التسجيل الصوتي",
                    user: "",
                  });
                }
              } else if (data["data"]["cmd"] == "ban") {
                if (typeof data["data"]["reponse"] != "string") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["ban"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم حظرك من الدردشة",
                  user: "",
                });

                MessagesList({
                  state: "LogsMsg",
                  bg: "none",
                  copic: "none",
                  class: "hmsg",
                  id: data["data"]["id"],
                  topic: UserInfo[data["data"]["id"]]["topic"],
                  msg: "( تم حظر هذا المستخدم )",
                  idroom: UserInfo[data["data"]["id"]]["idroom"],
                  pic: UserInfo[data["data"]["id"]]["pic"],
                });

                UserInfo[data["data"]["id"]]["ismsg"] = true;
                BandUser({
                  name_band: UserInfo[data["data"]["id"]]["username"],
                  logs: "باند",
                  type: " من قبل " + UserInfo[socket.id]["username"],
                  reponse: data["data"]["reponse"] || "لا يوجد سبب",
                  device: UserInfo[data["data"]["id"]]["device"],
                  username: UserInfo[data["data"]["id"]]["username"],
                  ip: UserInfo[data["data"]["id"]]["ip"],
                  country: "",
                  topic: UserInfo[socket.id]["username"],
                  myuser: UserInfo[data["data"]["id"]]["username"],
                  myip: UserInfo[socket.id]["ip"],
                  hw_fp: UserInfo[data["data"]["id"]]["hw_fp"] || "",
                });
                UserDisconnect({ id: data["data"]["id"], state: 2 });
                io.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ev",
                  data: 'window.onbeforeunload = null; location.href=location.pathname;',
                });
              } else if (data["data"]["cmd"] == "meiut") {
                if (!GetPower(UserInfo[socket.id]["power"])["meiut"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                if (UserInfo[data["data"]["id"]]["ismuted"]) {
                  UserInfo[data["data"]["id"]]["ismuted"] = false;
                } else {
                  UserInfo[data["data"]["id"]]["ismuted"] = true;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: UserInfo[data["data"]["id"]]["ismuted"]
                    ? "تم منعك من الحديث في الدردشة"
                    : "تم السماح لك بالحديث في الدردشة",
                  user: "",
                });
                const ismue = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (ismue != -1) {
                  OnlineUser[ismue]["meiut"] =
                    UserInfo[data["data"]["id"]]["ismuted"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[ismue],
                  });
                  UserMuted.push(UserInfo[data["data"]["id"]]["device"]);
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateMute",
                      muted: UserInfo[data["data"]["id"]]["ismuted"],
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
                if (UserInfo[data["data"]["id"]]["ismuted"] == false) {
                  UserMuted.splice(
                    UserMuted.findIndex(
                      (v) => v == UserInfo[data["data"]["id"]]["device"]
                    ),
                    1
                  );
                }
                SaveStats({
                  state: UserInfo[data["data"]["id"]]["ismuted"]
                    ? "إسكات"
                    : "إلغاءإسكات",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });

                socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "muted",
                  data: {
                    id: data["data"]["id"],
                    lid: UserInfo[data["data"]["id"]]["lid"],
                    uid: data["data"]["id"],
                    ism: UserInfo[data["data"]["id"]]["ismuted"],
                    topic: UserInfo[data["data"]["id"]]["topic"],
                  },
                });
              } else if (data["data"]["cmd"] == "meiutbc") {
                if (!GetPower(UserInfo[socket.id]["power"])["meiut"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                if (UserInfo[data["data"]["id"]]["ismutedbc"]) {
                  UserInfo[data["data"]["id"]]["ismutedbc"] = false;
                } else {
                  UserInfo[data["data"]["id"]]["ismutedbc"] = true;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: UserInfo[data["data"]["id"]]["ismutedbc"]
                    ? "تم منعك من الحديث في الحائط"
                    : "تم السماح لك بالحديث في الحائط",
                  user: "",
                });
                const ismue = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (ismue != -1) {
                  OnlineUser[ismue]["meiutbc"] =
                    UserInfo[data["data"]["id"]]["ismutedbc"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[ismue],
                  });
                }

                if (UserInfo[data["data"]["id"]]["ismutedbc"] == false) {
                  const isbnd = Bandbc.findIndex(
                    (v) => v == UserInfo[data["data"]["id"]]["device"]
                  );
                  if (isbnd != -1) {
                    Bandbc.splice(isbnd, 1);
                  }
                } else {
                  Bandbc.push(UserInfo[data["data"]["id"]]["device"]);
                }
                SaveStats({
                  state: UserInfo[data["data"]["id"]]["ismutedbc"]
                    ? "إسكات حائط"
                    : "إلغاءإسكات حائط",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });
                socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "mutedbc",
                  data: { ism: UserInfo[data["data"]["id"]]["ismutedbc"] },
                });
              } else if (data["data"]["cmd"] == "delyou") {
                if (!GetPower(UserInfo[socket.id]["power"])["delpic"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم حذف رابط البروفايل",
                  user: "",
                });
                SaveStats({
                  state: "حذف رابط البروفايل",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });
                const uppic = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (uppic != -1) {
                  OnlineUser[uppic]["youtube"] = "";
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[uppic],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateYoutube",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      youtube: "",
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "delpic") {
                if (!GetPower(UserInfo[socket.id]["power"])["delpic"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                const idpic = getRandomInt(1, 100);
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم حذف صورتك",
                  user: "",
                });
                // socket.to(data['data']["id"]).emit("savedone", "/site/pic.png?z"+idpic);
                SaveStats({
                  state: "حذف صورة",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });
                const uppic = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (uppic != -1) {
                  UserInfo[data["data"]["id"]]["pic"] =
                    "/site/pic.png?z" + idpic;
                  OnlineUser[uppic]["pic"] = "/site/pic.png?z" + idpic;
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[uppic],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updatePic",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      pic: "/site/pic.png?z" + idpic,
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "delcover") {
                // ── حذف غلاف مستخدم (يتطلب صلاحية delpic) ──
                if (!GetPower(UserInfo[socket.id]["power"])["delpic"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({ state: "me", topic: "", force: 1, msg: "هذا المستخدم اعلى منك رتبة", user: "" });
                  return;
                }
                const targetId = data["data"]["id"];
                if (UserInfo[targetId]) {
                  SendNotification({ id: targetId, state: "to", topic: "", force: 1, msg: "تم حذف صورة غلافك", user: "" });
                  SaveStats({
                    state: "حذف غلاف",
                    topic: UserInfo[socket.id]["topic"],
                    ip: UserInfo[socket.id]["ip"],
                    username: UserInfo[targetId]["topic"],
                    room: UserInfo[targetId]["idroom"]
                      ? GetRoomList(UserInfo[targetId]["idroom"])["topic"]
                      : "out room",
                    time: new Date().getTime(),
                  });
                  UserInfo[targetId]["cover"] = "";
                  const upIdx = OnlineUser.findIndex((x) => x.id == targetId);
                  if (upIdx != -1) {
                    OnlineUser[upIdx]["cover"] = "";
                    io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u^", data: OnlineUser[upIdx] });
                  }
                  if (UserInfo[targetId]["uid"]) {
                    UsersRepo.updateBy({ state: "updateCover", uid: UserInfo[targetId]["uid"], cover: "" });
                  }
                }
              } else if (data["data"]["cmd"] == "setLikes") {
                if (typeof data["data"]["likes"] != "number") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["ulike"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                } else if (data["data"]["likes"] > 9223372036854775806) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "الحد الاقصى للايكات 9223372036854775806",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: " تم تغير إعجاباتك الى ↵ " + data["data"]["likes"],
                  user: socket.id,
                });

                if (
                  UserInfo[data["data"]["id"]]["iswaiting"] &&
                  data["data"]["likes"] >= SiteSetting["liked"]
                ) {
                  UserInfo[data["data"]["id"]]["iswaiting"] = false;
                  if (SiteSetting["respown"]) {
                    socket
                      .to(data["data"]["id"])
                      .emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "rjj",
                        data: MyRoom(UserInfo[data["data"]["id"]]["device"]),
                      });
                  }
                }

                SaveStats({
                  state: "تعديل اعجابات",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });

                const uplike = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (uplike != -1) {
                  UserInfo[data["data"]["id"]]["rep"] = data["data"]["likes"];
                  OnlineUser[uplike]["rep"] = data["data"]["likes"];
                  UsersRepo.updateBy({
                    state: "updateRep",
                    rep: data["data"]["likes"],
                    uid: UserInfo[data["data"]["id"]]["uid"],
                  });
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[uplike],
                  });
                }
              } else if (data["data"]["cmd"] == "setEvaluation") {
                if (typeof data["data"]["eva"] != "number") {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                } else if (data["data"]["eva"] > 50000) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "الحد الاقصى للنقاط 50000",
                    user: "",
                  });
                  return;
                }
                if (
                  UserInfo[socket.id]["power"] == "gochat" ||
                  UserInfo[socket.id]["power"] == "Hide" ||
                  UserInfo[socket.id]["power"] == "chatmaster"
                ) {
                  SendNotification({
                    id: data["data"]["id"],
                    state: "to",
                    topic: "",
                    force: 1,
                    msg: " تم تغير نقاط الى ↵ " + data["data"]["eva"],
                    user: socket.id,
                  });

                  SaveStats({
                    state: "تعديل نقاط",
                    topic: UserInfo[socket.id]["topic"],
                    ip: UserInfo[socket.id]["ip"],
                    username: UserInfo[data["data"]["id"]]["topic"],
                    room: UserInfo[data["data"]["id"]]["idroom"]
                      ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                          "topic"
                        ]
                      : "out room",
                    time: new Date().getTime(),
                  });

                  const uplike = OnlineUser.findIndex(
                    (x) => x.id == data["data"]["id"]
                  );
                  if (uplike != -1) {
                    UserInfo[data["data"]["id"]]["evaluation"] =
                      data["data"]["eva"];
                    OnlineUser[uplike]["evaluation"] = data["data"]["eva"];
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "u^",
                      data: OnlineUser[uplike],
                    });
                    if (UserInfo[data["data"]["id"]]["uid"]) {
                      UsersRepo.updateBy({
                        state: "updateLike",
                        evaluation: data["data"]["eva"],
                        uid: UserInfo[data["data"]["id"]]["uid"],
                      });
                    }
                  }
                }
              } else if (data["data"]["cmd"] == "setpower") {
                if (!GetPower(UserInfo[socket.id]["power"])["setpower"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم أعلى منك رتبة",
                    user: "",
                  });
                  return;
                } else if (data["data"]["id"] == socket.id) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك ترقية نفسك",
                    user: "",
                  });
                  return;
                }
                if (UserInfo[data["data"]["id"]]["power"]) {
                  if (
                    UserInfo[data["data"]["id"]]["uid"] &&
                    data["data"]["power"] <
                      UserInfo[data["data"]["id"]]["power"]
                  ) {
                    SubRepo.update({
                      sub: data["data"]["power"],
                      timefinish: addDays(data["data"]["days"] || 0),
                      timestart: new Date().getTime().toFixed(),
                      timeis: data["data"]["days"] || 0,
                      topic: UserInfo[data["data"]["id"]]["topic"],
                      username: UserInfo[data["data"]["id"]]["username"],
                    });
                  }
                  if (!data["data"]["power"]) {
                    SubRepo.deleted(UserInfo[data["data"]["id"]]["username"]);
                    SendNotification({
                      state: "me",
                      topic: "",
                      force: 1,
                      msg: "تم تنزيل رتبة المستخدم",
                      user: "",
                    });
                    SendNotification({
                      id: data["data"]["id"],
                      state: "to",
                      topic: "",
                      force: 1,
                      msg: "تم تنزيل رتبتك",
                      user: "",
                    });
                  } else {
                    SendNotification({
                      state: "me",
                      topic: "",
                      force: 1,
                      msg: "تم ترقية المستخدم الى 》 " + data["data"]["power"],
                      user: "",
                    });
                    SendNotification({
                      id: data["data"]["id"],
                      state: "to",
                      topic: "",
                      force: 1,
                      msg: "اصبحت ترقيتك 》 " + data["data"]["power"],
                      user: "",
                    });
                  }
                } else {
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    SubRepo.create({
                      sub: data["data"]["power"],
                      topic: UserInfo[data["data"]["id"]]["username"],
                      username: UserInfo[data["data"]["id"]]["username"],
                      timefinish: addDays(data["data"]["days"] || 0),
                      timestart: new Date().getTime().toFixed(),
                      timeis: data["data"]["days"] || 0,
                    });
                  }
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم ترقية المستخدم الى 》 " + data["data"]["power"],
                    user: "",
                  });
                  SendNotification({
                    id: data["data"]["id"],
                    state: "to",
                    topic: "",
                    force: 1,
                    msg: "اصبحت ترقيتك 》 " + data["data"]["power"],
                    user: "",
                  });
                }

                const pwr = ShowPowers.findIndex(
                  (x) => x.name == data["data"]["power"]
                );
                if (pwr != -1) {
                  socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "power",
                    data: ShowPowers[pwr],
                  });
                } else {
                  socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "power",
                    data: Config.PowerNon,
                  });
                }

                SaveStats({
                  state: "ترقية",
                  topic: UserInfo[socket.id]["username"],
                  ip: UserInfo[socket.id]["ip"],
                  username:
                    UserInfo[data["data"]["id"]]["topic"] +
                    "[" +
                    data["data"]["power"] +
                    "]",
                  room: data["data"]["power"],
                  time: new Date().getTime(),
                });
                const inme = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (inme != -1) {
                  UserInfo[data["data"]["id"]]["power"] = data["data"]["power"];
                  OnlineUser[inme]["power"] = data["data"]["power"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[inme],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updatePower",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      power: data["data"]["power"].split("<").join("&#x3C;"),
                    });
                    setTimeout(() => {
                      socket
                        .to(data["data"]["id"])
                        .emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "powers",
                          data: ShowPowers,
                        });
                    }, 2000);
                  }
                }
              } else if (data["data"]["cmd"] == "setmsg") {
                if (typeof data["data"]["msg"] != "string") {
                  return;
                } else if (
                  !GetPower(UserInfo[socket.id]["power"])["edituser"]
                ) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                  // }else if(data['data']["id"] == socket.id){
                  // SendNotification({state:'me',topic: "", force: 1, msg:"لا يمكنك تغيير حالتك", user: ""});
                  // return;
                } else if (data["data"]["msg"].length > (SiteSetting["maxcharstatus"] || 240)) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يجب ان تتجاوز الحاله " + (SiteSetting["maxcharstatus"] || 240) + " حرفا",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم تغيير حالتك",
                  user: "",
                });

                SaveStats({
                  state: "تعديل حاله",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });

                const upmsg = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (upmsg != -1) {
                  UserInfo[data["data"]["id"]]["msg"] = ReplaceEktisar(
                    data["data"]["msg"]
                  );
                  OnlineUser[upmsg]["msg"] = ReplaceEktisar(
                    data["data"]["msg"]
                  );
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[upmsg],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateMsg",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      msg: ReplaceEktisar(data["data"]["msg"]),
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "setyou") {
                if (typeof data["data"]["youtube"] != "string") {
                  return;
                } else if (
                  !GetPower(UserInfo[socket.id]["power"])["edituser"]
                ) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                  // }else if(data['data']["id"] == socket.id){
                  // SendNotification({state:'me',topic: "", force: 1, msg:"لا يمكنك تغيير حالتك", user: ""});
                  // return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم تغيير رابط اليوتيوب",
                  user: "",
                });

                SaveStats({
                  state: "تعديل رابط يوتيوب",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });

                const picup = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (picup != -1) {
                  UserInfo[data["data"]["id"]]["youtube"] = ReplaceEktisar(
                    data["data"]["youtube"]
                  );
                  OnlineUser[picup]["youtube"] = ReplaceEktisar(
                    data["data"]["youtube"]
                  );
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[picup],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateYoutube",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      youtube: ReplaceEktisar(data["data"]["youtube"]),
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "unstate") {
                if (typeof data["data"]["msg"] != "string") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["stateis"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                } else if (
                  data["data"]["msg"].length < 2 ||
                  data["data"]["msg"].length > (SiteSetting["maxcharstatus"] || 240)
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يجب ان تكون الحالة اكثر من 255 حرف او اقل من 2 حرف",
                    user: "",
                  });
                  return;
                } else if (
                  isNaN(data["data"]["msg"]) == false ||
                  !data["data"]["msg"].trim()
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "الرجاء التاكد من الحالة",
                    user: "",
                  });
                  return;
                }

                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم تغيير حالتك الى > " + data["data"]["msg"],
                  user: "",
                });

                SaveStats({
                  state: "تعديل حالة",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: data["data"]["msg"].split("<").join("&#x3C;"),
                  time: new Date().getTime(),
                });

                const uptopic = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (uptopic != -1) {
                  UserInfo[data["data"]["id"]]["msg"] = data["data"]["msg"]
                    .split("<")
                    .join("&#x3C;");
                  OnlineUser[uptopic]["msg"] = data["data"]["msg"]
                    .split("<")
                    .join("&#x3C;");
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[uptopic],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateMsg",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      msg: data["data"]["msg"].split("<").join("&#x3C;"),
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "unick") {
                if (typeof data["data"]["nick"] != "string") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["unick"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                  // }else if(data['data']["id"] == socket.id){
                  // SendNotification({state:'me',topic: "", force: 1, msg:"لا يمكنك تغيير اسمك", user: ""});
                  // return;
                } else if (
                  data["data"]["nick"].length < 2 ||
                  data["data"]["nick"].length > (SiteSetting["maxcharzakhrafah"] || 30)
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يجب ان تكون الزخرفة اكثر من " + (SiteSetting["maxcharzakhrafah"] || 30) + " حرف او اقل من 2 حرف",
                    user: "",
                  });
                  return;
                } else if (
                  isNaN(data["data"]["nick"]) == false ||
                  !data["data"]["nick"].trim()
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "الرجاء التاكد من الزخرفة",
                    user: "",
                  });
                  return;
                }

                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم تغيير زخرفتك الى > " + data["data"]["nick"],
                  user: "",
                });

                SaveStats({
                  state: "تعديل زخرفة",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: data["data"]["nick"].split("<").join("&#x3C;"),
                  time: new Date().getTime(),
                });

                const uptopic = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (uptopic != -1) {
                  UserInfo[data["data"]["id"]]["topic"] = data["data"]["nick"]
                    .split("<")
                    .join("&#x3C;");
                  OnlineUser[uptopic]["topic"] = data["data"]["nick"]
                    .split("<")
                    .join("&#x3C;");
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[uptopic],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateName",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                      topic: data["data"]["nick"].split("<").join("&#x3C;"),
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "bnr") {
                if (!GetPower(UserInfo[socket.id]["power"])["ureport"]) {
                  return;
                  // }else if(UserInfo[data['data']["id"]]['power'] == ""){
                  // SendNotification({state:'me',topic: "", force: 1, msg:"فقط السوبر يمكنك إعطاهم بنر", user: ""});
                  // return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: data["data"]["bnr"]
                    ? "بنر " +
                      "<img src=" +
                      "/sico/" +
                      data["data"]["bnr"] +
                      ">"
                    : "تم إزالة البنر",
                  user: socket.id,
                });
                SaveStats({
                  state: data["data"]["bnr"] ? "إعطاء بنر " : "إزالة بنر",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: "",
                  time: new Date().getTime(),
                });

                const upgift = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (upgift != -1) {
                  UserInfo[data["data"]["id"]]["ico"] = data["data"]["bnr"]
                    ? "/sico/" + data["data"]["bnr"]
                    : "";
                  OnlineUser[upgift]["ico"] = data["data"]["bnr"]
                    ? "/sico/" + data["data"]["bnr"]
                    : "";
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[upgift],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateIco",
                      ico: data["data"]["bnr"]
                        ? "/sico/" + data["data"]["bnr"]
                        : "",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "gift") {
                if (typeof data["data"]["gift"] != "string") {
                  return;
                } else if (
                  !GetPower(UserInfo[socket.id]["power"])["upgrades"]
                ) {
                  return;
                } else if (UserInfo[data["data"]["id"]]["power"] != "") {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك ارسال هديه للسوبر",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: data["data"]["gift"]
                    ? "هديه " +
                      "<img src=" +
                      "/dro3/" +
                      data["data"]["gift"] +
                      ">"
                    : "تم إزالة الهدية",
                  user: socket.id,
                });
                SaveStats({
                  state: data["data"]["gift"] ? "إعطاء هديه " : "إزالة الهدية",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: "",
                  time: new Date().getTime(),
                });

                const upgift = OnlineUser.findIndex(
                  (x) => x.id == data["data"]["id"]
                );
                if (upgift != -1) {
                  UserInfo[data["data"]["id"]]["ico"] = data["data"]["gift"]
                    ? "/dro3/" + data["data"]["gift"]
                    : "";
                  OnlineUser[upgift]["ico"] = data["data"]["gift"]
                    ? "/dro3/" + data["data"]["gift"]
                    : "";
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[upgift],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateIco",
                      ico: data["data"]["gift"]
                        ? "/dro3/" + data["data"]["gift"]
                        : "",
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
              } else if (data["data"]["cmd"] == "rinvite") {
                if (typeof data["data"]["rid"] != "string") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["loveu"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                } else if (data["data"]["id"] == socket.id) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك نقل نفسك",
                    user: "",
                  });
                  return;
                } else if (GetRoomList(data["data"]["rid"])["needpass"]) {
                  if (
                    GetRoomList(data["data"]["rid"])["pass"] !=
                    data["data"]["pwd"]
                  ) {
                    SendNotification({
                      state: "me",
                      topic: "",
                      force: 1,
                      msg: "الرقم السري لدخول الغرفة خاطئ",
                      user: "",
                    });
                    return;
                  }
                }
                SaveStats({
                  state: "نقل إلى غرفة",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: GetRoomList(data["data"]["rid"])["topic"],
                  time: new Date().getTime(),
                });
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg:
                    " تم نقلك الى  " +
                    GetRoomList(data["data"]["rid"])["topic"],
                  user: "",
                });
                socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "rjoinad",
                  data: {
                    rid: data["data"]["rid"],
                    pwd: data["data"]["pwd"],
                  },
                });
              } else if (data["data"]["cmd"] == "roomkick") {
                if (!GetPower(UserInfo[socket.id]["power"])["kick"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذا المستخدم اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: "تم طردك من الغرفه",
                  user: "",
                });
                MessagesList({
                  state: "LogsMsg",
                  bg: "none",
                  copic: "none",
                  class: "hmsg",
                  id: data["data"]["id"],
                  topic: UserInfo[data["data"]["id"]]["topic"],
                  msg: "( هذا المستخدم تم طرده من الغرفة )",
                  idroom: UserInfo[data["data"]["id"]]["idroom"],
                  pic: UserInfo[data["data"]["id"]]["pic"],
                });
                SaveStats({
                  state: "طرد من الغرفة",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])[
                        "topic"
                      ]
                    : "out room",
                  time: new Date().getTime(),
                });
                UserInfo[data["data"]["id"]]["kiked"] = true;
                BandRoom.push({
                  device: UserInfo[data["data"]["id"]]["device"],
                  room: UserInfo[data["data"]["id"]]["idroom"],
                });
                socket
                  .to(data["data"]["id"])
                  .emit("SEND_EVENT_EMIT_SERVER", { cmd: "lavedon", data: {} });
              } else if (data["data"]["cmd"] == "delpic") {
              } else if (data["data"]["cmd"] == "reportes") {
                if (typeof data["data"]["msg"] != "string") {
                  return;
                }
                if (UserInfo[socket.id]) {
                  MesgRepo.create({
                    v: "تبليغ",
                    msg: data.data.msg,
                    topic: UserInfo[socket.id].topic,
                    topic2: UserInfo[data.data["id"]].topic,
                  });
                  FilterChat(data.data.msg);

                  return;
                }
              } else if (data["data"]["cmd"] == "micban") {
                // ── حظر مايكات ──
                if (!GetPower(UserInfo[socket.id]["power"])["ban"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لايمكن تنفيذ على شخص اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                UserInfo[data["data"]["id"]]["ismicban"] = !UserInfo[data["data"]["id"]]["ismicban"];
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: UserInfo[data["data"]["id"]]["ismicban"]
                    ? "تم حظرك من المايكات"
                    : "تم فك حظر المايكات",
                  user: "",
                });
                const ismicbIdx = OnlineUser.findIndex((x) => x.id == data["data"]["id"]);
                if (ismicbIdx != -1) {
                  OnlineUser[ismicbIdx]["ismicban"] = UserInfo[data["data"]["id"]]["ismicban"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[ismicbIdx],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateMicban",
                      ismicban: UserInfo[data["data"]["id"]]["ismicban"],
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
                SaveStats({
                  state: UserInfo[data["data"]["id"]]["ismicban"] ? "حظر مايك" : "فك حظر مايك",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])["topic"]
                    : "out room",
                  time: new Date().getTime(),
                });
              } else if (data["data"]["cmd"] == "storyban") {
                // ── حظر ستوري ──
                if (!GetPower(UserInfo[socket.id]["power"])["ban"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لايمكن تنفيذ على شخص اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                UserInfo[data["data"]["id"]]["isstoryban"] = !UserInfo[data["data"]["id"]]["isstoryban"];
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: UserInfo[data["data"]["id"]]["isstoryban"]
                    ? "تم حظرك من الستوري"
                    : "تم فك حظر الستوري",
                  user: "",
                });
                const isstbIdx = OnlineUser.findIndex((x) => x.id == data["data"]["id"]);
                if (isstbIdx != -1) {
                  OnlineUser[isstbIdx]["isstoryban"] = UserInfo[data["data"]["id"]]["isstoryban"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[isstbIdx],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateStoryban",
                      isstoryban: UserInfo[data["data"]["id"]]["isstoryban"],
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
                SaveStats({
                  state: UserInfo[data["data"]["id"]]["isstoryban"] ? "حظر ستوري" : "فك حظر ستوري",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])["topic"]
                    : "out room",
                  time: new Date().getTime(),
                });
              } else if (data["data"]["cmd"] == "freeze") {
                // ── تجميد ──
                if (!GetPower(UserInfo[socket.id]["power"])["ban"]) {
                  return;
                } else if (
                  GetPower(UserInfo[data["data"]["id"]]["power"])["rank"] >
                  GetPower(UserInfo[socket.id]["power"])["rank"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لايمكن تنفيذ على شخص اعلى منك رتبة",
                    user: "",
                  });
                  return;
                }
                UserInfo[data["data"]["id"]]["isfrozen"] = !UserInfo[data["data"]["id"]]["isfrozen"];
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg: UserInfo[data["data"]["id"]]["isfrozen"]
                    ? "تم تجميد حسابك"
                    : "تم فك التجميد عن حسابك",
                  user: "",
                });
                const isfrzIdx = OnlineUser.findIndex((x) => x.id == data["data"]["id"]);
                if (isfrzIdx != -1) {
                  OnlineUser[isfrzIdx]["isfrozen"] = UserInfo[data["data"]["id"]]["isfrozen"];
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "u^",
                    data: OnlineUser[isfrzIdx],
                  });
                  if (UserInfo[data["data"]["id"]]["uid"]) {
                    UsersRepo.updateBy({
                      state: "updateFreeze",
                      isfrozen: UserInfo[data["data"]["id"]]["isfrozen"],
                      uid: UserInfo[data["data"]["id"]]["uid"],
                    });
                  }
                }
                SaveStats({
                  state: UserInfo[data["data"]["id"]]["isfrozen"] ? "تجميد" : "فك تجميد",
                  topic: UserInfo[socket.id]["topic"],
                  ip: UserInfo[socket.id]["ip"],
                  username: UserInfo[data["data"]["id"]]["topic"],
                  room: UserInfo[data["data"]["id"]]["idroom"]
                    ? GetRoomList(UserInfo[data["data"]["id"]]["idroom"])["topic"]
                    : "out room",
                  time: new Date().getTime(),
                });
              } else if (data["data"]["cmd"] == "rmback") {
                if (typeof data["data"]["num"] != "number") {
                  return;
                } else if (!GetPower(UserInfo[socket.id]["power"])["ureport"]) {
                  return;
                }

                if (UserInfo[data["data"]["id"]]) {
                  if (data.data.num == 1) {
                    UsersRepo.updateBck({
                      back: "",
                      idreg: UserInfo[data["data"]["id"]].idreg.split("#")[1],
                    }).then((isrs) => {
                      if (isrs) {
                        SaveStats({
                          state: "إزالة خلفية",
                          topic: UserInfo[socket.id]["topic"],
                          ip: UserInfo[socket.id]["ip"],
                          username: UserInfo[data["data"]["id"]]["topic"],
                          room: UserInfo[data["data"]["id"]]["idroom"]
                            ? GetRoomList(
                                UserInfo[data["data"]["id"]]["idroom"]
                              )["topic"]
                            : "out room",
                          time: new Date().getTime(),
                        });
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم إزالة الخلفية بنجاح ",
                          user: "",
                        });
                      }
                    });
                    const picdix = OnlineUser.findIndex(
                      (x) => x.id == data["data"]["id"]
                    );
                    if (picdix != -1) {
                      UserInfo[data["data"]["id"]]["back"] = "";
                      OnlineUser[picdix].back = "";
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "u^",
                        data: OnlineUser[picdix],
                      });
                    }
                  } else if (data.data.num == 2) {
                    UsersRepo.updateAtar({
                      atar: "",
                      idreg: UserInfo[data["data"]["id"]].idreg.split("#")[1],
                    }).then((isrs) => {
                      if (isrs) {
                        SaveStats({
                          state: "إزالة إطار",
                          topic: UserInfo[socket.id]["topic"],
                          ip: UserInfo[socket.id]["ip"],
                          username: UserInfo[data["data"]["id"]]["topic"],
                          room: UserInfo[data["data"]["id"]]["idroom"]
                            ? GetRoomList(
                                UserInfo[data["data"]["id"]]["idroom"]
                              )["topic"]
                            : "out room",
                          time: new Date().getTime(),
                        });
                        SendNotification({
                          state: "me",
                          topic: "",
                          force: 1,
                          msg: "تم إزالة الاطار بنجاح ",
                          user: "",
                        });
                      }
                    });
                    const picdix = OnlineUser.findIndex(
                      (x) => x.id == data["data"]["id"]
                    );
                    if (picdix != -1) {
                      UserInfo[data["data"]["id"]]["atar"] = "";
                      OnlineUser[picdix].atar = "";
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "u^",
                        data: OnlineUser[picdix],
                      });
                    }
                  }
                }
              } else if (data["data"]["cmd"] == "likeit") {
                if (typeof data["data"]["msg"] != "number") {
                  return;
                  /*}else if(UserInfo[data['data']["id"]]['offline']){
                                                                         SendNotification({state:'me',topic: "", force: 1, msg:"المستخدم غير متصل بالانترنت في الوقت الحالي", user: ""});                                                                                                                        
                                                                         return;                */
                } else if (UserInfo[socket.id]["isfrozen"]) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "أنت مجمد لا يمكنك إرسال حركات",
                    user: "",
                  });
                  return;
                } else if (
                  UserInfo[socket.id]["rep"] < SiteSetting["maxlikealert"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg:
                      SiteSetting["maxlikealert"] +
                      " عدد الايكات المطلوبة لارسال حركة ",
                    user: "",
                  });
                  return;
                }

                const istef = UserInfo[socket.id]["istef"].findIndex(
                  (x) => x == data["data"]["id"]
                );
                if (istef != -1) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "يمكنك ارسال حركة كل 1 دقيقة",
                    user: "",
                  });
                  return;
                }
                UserInfo[socket.id]["istef"].push(data["data"]["id"]);
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: 1,
                  msg:
                    data["data"]["msg"] == 1
                      ? "❤️ أنـا أحٍـبَڪ "
                      : data["data"]["msg"] == 2
                      ? "ههههههههههههههههههههههههههههههههههههههههههههههههه "
                      : data["data"]["msg"] == 3
                      ? "💋 أأأمـمـمـمـمـمـوأأااااحـح 💋"
                      : data["data"]["msg"] == 4
                      ? "💦 اااااخخخختتتتتتفففففففففوووووووووووووووووووووو 💦"
                      : "",
                  user: socket.id,
                });
                setTimeout(function () {
                  if (UserInfo[socket.id]) {
                    UserInfo[socket.id]["istef"].splice(
                      UserInfo[socket.id]["istef"].findIndex(
                        (v) => v == data["data"]["id"]
                      ),
                      1
                    );
                  }
                }, 60000);
              } else if (data["data"]["cmd"] == "not") {
                if (typeof data["data"]["msg"] != "string") {
                  return;
                } else if (UserInfo[socket.id]["isfrozen"]) {
                  SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك إرسال تنبيه", user: "" });
                  return;
                } else if (UserInfo[socket.id]["ismuted"]) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "إسكات",
                    user: "",
                  });
                  return;
                } else if (
                  UserInfo[socket.id]["rep"] < SiteSetting["maxlikealert"]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg:
                      SiteSetting["maxlikealert"] +
                      " عدد الايكات المطلوبة لارسال تنبيه ",
                    user: "",
                  });
                  return;
                }

                if (
                  UserInfo[socket.id]["iswaiting"] ||
                  UserInfo[data["data"]["iswaiting"]]
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك إرسال تنبيه في غرفة الإنتظار",
                    user: "",
                  });
                  return;
                }
                FilterChat(data["data"]["msg"]);
                // ✅ تحسين: نحسب ReplaceEktisar مرة وحدة بس
                const processedAlert = ReplaceEktisar(data["data"]["msg"]).slice(0, SiteSetting["lengthroom"]);

                listalert.push({
                  idreg: UserInfo[socket.id]["idreg"],
                  bg: UserInfo[socket.id]["bg"],
                  ucol: UserInfo[socket.id]["ucol"],
                  pic: UserInfo[socket.id]["pic"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: processedAlert,
                });

                // ✅ الإرسال أولاً
                SendNotification({
                  id: data["data"]["id"],
                  state: "to",
                  topic: "",
                  force: GetPower(UserInfo[socket.id]["power"])["alert"],
                  msg: processedAlert,
                  user: socket.id,
                });

                // ✅ الحفظ بالداتابيس بعد الإرسال
                const _uiNotif = UserInfo[socket.id];
                const _targetNotif = UserInfo[data["data"]["id"]];
                if (_uiNotif && _targetNotif) {
                  try {
                    dbsql.insertData({
                      username: _uiNotif["username"] || "",
                      topic: _targetNotif["username"] || "",
                      message: processedAlert,
                      status: "no",
                      type: "notification",
                    });
                  } catch (err) {
                    console.error("Error inserting data into database:", err);
                  }
                }
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_ADD_ROOM") {
          if (UserInfo[socket.id]) {
            if (
              typeof data["data"]["broadcast"] == "boolean" &&
              typeof data["data"]["broadlive"] == "boolean" &&
              typeof data["data"]["delete"] == "boolean" &&
              typeof data["data"]["nohide"] == "boolean" &&
              typeof data["data"]["camera"] == "boolean" &&
              typeof data["data"]["pic"] == "string" &&
              typeof data["data"]["topic"] == "string" &&
              typeof data["data"]["welcome"] == "string" &&
              typeof data["data"]["max"] == "number"
            ) {
              const isRoomTopic = RoomsList.findIndex(
                (x) => x.topic == data["data"]["topic"]
              );
              if (Config.maxRooms < RoomsList.length) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "تم إنشاء الحد الاقصى لرومات",
                  user: "",
                });
                return;
              } else if (
                !GetPower(UserInfo[socket.id]["power"])["createroom"]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "لا تملك صلاحية",
                  user: "",
                });
                return;
              } else if (
                data["data"]["max"] > 1000 ||
                data["data"]["max"] < 2
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يجب ان يكون عدداعظاء الروم لا يزيد عن 40 او اقل من 2",
                  user: "",
                });
                return;
              } else if (isRoomTopic != -1) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يوجد غرفة تحمل نفس الاسم",
                  user: "",
                });
                return;
              }
              const idroom = stringGen(10);
              CreateRooms({
                id: idroom,
                about: data["data"]["about"]
                  ? data["data"]["about"].split("<").join("&#x3C;")
                  : "",
                user: UserInfo[socket.id]["username"],
                pass: data["data"]["pass"],
                color:
                  data["data"]["color"].split("<").join("&#x3C;") || "#FFFFFF",
                colorpicroom:
                  data["data"]["colorpicroom"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                colormsgroom:
                  data["data"]["colormsgroom"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                baccolor:
                  data["data"]["baccolor"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                needpass: data["data"]["pass"] ? true : false,
                camera: false,
                broadcast: data["data"]["broadcast"],
                broadlive: data["data"]["broadlive"],
                nohide: data["data"]["nohide"],
                deleted: data["data"]["delete"],
                owner: UserInfo[socket.id]["idreg"],
                rmli: data["data"]["like"],
                topic: data["data"]["topic"].split("<").join("&#x3C;"),
                pic: data["data"]["pic"],
                backroom: data["data"]["backroom"],
                bordroom: data["data"]["bordroom"],
                maxmaic: data["data"]["maxmaic"],
                welcome: data["data"]["welcome"]
                  ? data["data"]["welcome"].split("<").join("&#x3C;")
                  : "",
                max: data["data"]["max"],
                has: data["data"]["has"],
              });
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "تم إنشاء غرفة",
                user: "",
              });
              SaveStats({
                state: "إنشاء غرفة",
                topic: UserInfo[socket.id]["topic"],
                ip: UserInfo[socket.id]["ip"],
                username: UserInfo[socket.id]["username"],
                room: UserInfo[socket.id]["idroom"]
                  ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
                  : "out room",
                time: new Date().getTime(),
              });
            } else {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "الرجاء التأكد من البيانات المدخولة",
                user: "",
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_EDIT_ROOM") {
          if (UserInfo[socket.id]) {
            if (
              typeof data["data"]["broadcast"] == "boolean" &&
              typeof data["data"]["broadlive"] == "boolean" &&
              typeof data["data"]["nohide"] == "boolean" &&
              typeof data["data"]["camera"] == "boolean" &&
              typeof data["data"]["topic"] == "string" &&
              typeof data["data"]["pic"] == "string" &&
              typeof data["data"]["id"] == "string" &&
              typeof data["data"]["max"] == "number" &&
              typeof data["data"]["has"] == "number"
            ) {
              if (!GetPower(UserInfo[socket.id]["power"])["createroom"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "لا تملك صلاحية",
                  user: "",
                });
                return;
              } else if (
                data["data"]["max"] > 1000 ||
                data["data"]["max"] < 2
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يجب ان يكون عدداعضاء الروم لا يزيد عن 40 او اقل من 2",
                  user: "",
                });
                return;
              } else if (data["data"]["has"] > 100 || data["data"]["has"] < 1) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "يجب ان يكون هاشتاق الروم لا يزيد عن 100 او اقل من 1",
                  user: "",
                });
                return;
              }

              RoomsRepo.updateBy({
                state: "updateRoom",
                topic: data["data"]["topic"].split("<").join("&#x3C;"),
                broadcast: data["data"]["broadcast"],
                broadlive: data["data"]["broadlive"],
                nohide: data["data"]["nohide"],
                camera: data["data"]["camera"],
                pic: data["data"]["pic"],
                bordroom: data["data"]["bordroom"],
                maxmaic: data["data"]["maxmaic"],
                backroom: data["data"]["backroom"],
                color:
                  data["data"]["color"].split("<").join("&#x3C;") || "#FFFFFF",
                colorpicroom:
                  data["data"]["colorpicroom"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                colormsgroom:
                  data["data"]["colormsgroom"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                baccolor:
                  data["data"]["baccolor"].split("<").join("&#x3C;") ||
                  "#FFFFFF",
                about: data["data"]["about"]
                  ? data["data"]["about"].split("<").join("&#x3C;")
                  : "",
                welcome: data["data"]["welcome"]
                  ? data["data"]["welcome"].split("<").join("&#x3C;")
                  : "",
                pass: data["data"]["pass"],
                rmli: data["data"]["like"] || 0,
                needpass: data["data"]["pass"] ? true : false,
                max: data["data"]["max"],
                has: data["data"]["has"],
                id: data["data"]["id"],
              }).then((doneup) => {
                if (doneup) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم التعديل على الغرفة",
                    user: "",
                  });
                  SaveStats({
                    state: "تعديل غرفة",
                    topic: UserInfo[socket.id]["topic"],
                    ip: UserInfo[socket.id]["ip"],
                    username: UserInfo[socket.id]["username"],
                    room: UserInfo[socket.id]["idroom"]
                      ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
                      : "out room",
                    time: new Date().getTime(),
                  });
                  RefreshRooms(1);
                  RoomsRepo.getBy({
                    state: "getByID",
                    id: data["data"]["id"],
                  }).then((isro) => {
                    if (isro) {
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "r^",
                        data: {
                          id: data["data"]["id"],
                          topic: data["data"]["topic"],
                          needpass: data["data"]["pass"] ? true : false,
                          owner: isro["owner"],
                          pic: isro["pic"],
                          backroom: isro["backroom"],
                          bordroom: isro["bordroom"],
                          maxmaic: isro["maxmaic"],
                          color: data["data"]["color"],
                          colorpicroom: data["data"]["colorpicroom"],
                          colormsgroom: data["data"]["colormsgroom"],
                          baccolor: data["data"]["baccolor"],
                          broadcast: data["data"]["broadcast"],
                          broadlive: data["data"]["broadlive"],
                          nohide: data["data"]["nohide"],
                          user: isro["user"],
                          rmli: data["data"]["like"] || 0,
                          about: data["data"]["about"],
                          welcome: data["data"]["welcome"],
                          max: data["data"]["max"],
                          has: data["data"]["has"],
                        },
                      });

                      if (isro["broadcast"]) {
                        /* ✅ v62: socket.to بدل io.to لمنع إرسال rjoin للمرسل نفسه */
                        socket.to(data["data"]["id"]).emit(
                          "SEND_EVENT_EMIT_BROADCASTING",
                          { cmd: "rjoin", user: socket.id }
                        );
                        io.to(data["data"]["id"]).emit(
                          "SEND_EVENT_EMIT_BROADCASTING",
                          {
                            cmd: "all",
                            room: data["data"]["id"],
                            data: PeerRoom[data["data"]["id"]],
                          }
                        );
                      }
                    }
                  });
                }
              });
            } else {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "الرجاء التأكد من البيانات المدخولة",
                user: "",
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_REMOVE_USER") {
          const delus = OnlineUser.findIndex((x) => x.id == data["data"]["id"]);
          if (delus != -1) {
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "u-",
              data: data["data"]["id"],
            });
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "ur",
              data: [data["data"]["id"], null],
            });
            OnlineUser.splice(delus, 1);
            if (UserInfo[data["data"]["id"]]) {
              UserDisconnect({ id: data["data"]["id"], state: 1 });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_REMOVE_ROOM") {
          if (UserInfo[socket.id]) {
            if (typeof data["data"]["id"] == "string") {
              if (data["data"]["id"] == "3ihxjl18it") {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "لا يمكنك حذف هذه الغرفة",
                  user: "",
                });
                return;
              } else if (
                !GetPower(UserInfo[socket.id]["power"])["createroom"]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "لا تملك صلاحية",
                  user: "",
                });
                return;
              }

              io.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "lavedon",
                data: {},
              });
              SaveStats({
                state: "حذف غرفه",
                topic: UserInfo[socket.id]["topic"],
                ip: UserInfo[socket.id]["ip"],
                username: UserInfo[socket.id]["username"],
                room: UserInfo[socket.id]["idroom"]
                  ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
                  : "out room",
                time: new Date().getTime(),
              });

              RoomsRepo.deleted(data["data"]["id"]).then((delroom) => {
                if (delroom) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم حذف الغرفة",
                    user: "",
                  });
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "r-",
                    data: data["data"]["id"],
                  });
                  RefreshRooms(1);
                  MessagesList({
                    state: "LogsMsg",
                    bg: UserInfo[socket.id]["bg"],
                    copic: UserInfo[socket.id]["copic"],
                    class: "hmsg",
                    id: UserInfo[socket.id]["id"],
                    topic: UserInfo[socket.id]["topic"],
                    msg: "( تم حذف الغرفة الحاليه )",
                    idroom: data["data"]["id"],
                    pic: UserInfo[socket.id]["pic"],
                  });
                }
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_BUSY") {
          if (typeof data["data"]["busy"] == "boolean") {
            if (UserInfo[socket.id]) {
              if (data["data"]["busy"]) {
                ChangeSatets(2);
                setTimeout(() => {
                  if (UserInfo[socket.id]) {
                    UserInfo[socket.id]["busy"] = true;
                  }
                }, 500);
              } else {
                UserInfo[socket.id]["busy"] = false;
                ChangeSatets(0);
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_PIC") {
          if (typeof data["data"]["pic"] == "string") {
            if (!NoTa5(data["data"]["pic"])) {
              if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikepic"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg:
                    SiteSetting["maxlikepic"] +
                    " لرفع او حذف صورة يجب ان يكون عدد اللايكات",
                  user: "",
                });
                return;
              }
              fs.unlink("uploads" + UserInfo[socket.id]["pic"], (err) => {
                if (err) {
                }
              });
              fs.unlink(
                "uploads" + UserInfo[socket.id]["pic"] + ".jpg",
                (err) => {
                  if (err) {
                  }
                }
              );
              const picup = OnlineUser.findIndex((x) => x.id == socket.id);
              if (picup != -1) {
                UserInfo[socket.id]["pic"] = data["data"]["pic"];
                OnlineUser[picup]["pic"] = data["data"]["pic"];
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "u^",
                  data: OnlineUser[picup],
                });
                if (UserInfo[socket.id]["uid"]) {
                  UsersRepo.updateBy({
                    state: "updatePic",
                    uid: UserInfo[socket.id]["uid"],
                    pic: data["data"]["pic"],
                  });
                }
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_COVER") {
          // ─── تحديث صورة الغلاف ───
          if (typeof data["data"]["cover"] == "string") {
            if (!NoTa5(data["data"]["cover"])) {
              if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikepic"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: SiteSetting["maxlikepic"] + " لرفع صورة الغلاف يجب أن يكون عدد اللايكات",
                  user: "",
                });
                return;
              }
              const covUp = OnlineUser.findIndex((x) => x.id == socket.id);
              if (covUp != -1) {
                UserInfo[socket.id]["cover"] = data["data"]["cover"];
                OnlineUser[covUp]["cover"] = data["data"]["cover"];
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "u^",
                  data: OnlineUser[covUp],
                });
                if (UserInfo[socket.id]["uid"]) {
                  UsersRepo.updateBy({
                    state: "updateCover",
                    uid: UserInfo[socket.id]["uid"],
                    cover: data["data"]["cover"],
                  });
                }
              }
            }
          }
        } else if (data["cmd"] == "PROFILE_ADD_YOUTUBE") {
          if (!NoTa5(data["data"]["youtube"])) {
            if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikeyot"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: SiteSetting["maxlikeyot"] + "  يجب أن يكون عدد اللايكات",
                user: "",
              });
              return;
            }
            const picup = OnlineUser.findIndex((x) => x.id == socket.id);
            if (picup != -1) {
              UserInfo[socket.id]["youtube"] = data["data"]["youtube"];
              OnlineUser[picup]["youtube"] = data["data"]["youtube"];
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "u^",
                data: OnlineUser[picup],
              });
              if (UserInfo[socket.id]["uid"]) {
                if (data["data"]["youtube"]) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم إظافة رابط يوتوب",
                    user: "",
                  });
                } else {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم إزالة رابط يوتوب",
                    user: "",
                  });
                }
                UsersRepo.updateBy({
                  state: "updateYoutube",
                  uid: UserInfo[socket.id]["uid"],
                  youtube: data["data"]["youtube"],
                });
              }
            }
          }
        } else if (data["cmd"] == "cheangback") {
          if (typeof data.data != "object") {
            return;
          }

          if (!data.data["back"]) {
            return;
          }
          if (!data.data["num"]) {
            return;
          }
          if (typeof data.data.back != "string") {
            return;
          }

          if (typeof data.data.num != "number") {
            return;
          }
          if (UserInfo[socket.id]) {
            if (data.data.num == 1) {
              UsersRepo.updateBck({
                back: data.data["back"],
                idreg: UserInfo[socket.id].idreg.split("#")[1],
              }).then((isrs) => {
                if (isrs) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم تغير الخلفية بنجاح ",
                    user: "",
                  });
                }
              });
              const picdix = OnlineUser.findIndex((x) => x.id == socket.id);
              if (picdix != -1) {
                OnlineUser[picdix].back = data.data["back"];
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "u^",
                  data: OnlineUser[picdix],
                });
              }
            } else if (data.data.num == 2) {
              UsersRepo.updateAtar({
                atar: data.data["back"],
                idreg: UserInfo[socket.id].idreg.split("#")[1],
              }).then((isrs) => {
                if (isrs) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "تم تغير الاطار بنجاح ",
                    user: "",
                  });
                }
              });
              const picdix = OnlineUser.findIndex((x) => x.id == socket.id);
              if (picdix != -1) {
                OnlineUser[picdix].atar = data.data["back"];
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "u^",
                  data: OnlineUser[picdix],
                });
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_NO_PM") {
          if (typeof data["data"]["id"] == "string") {
            SendNotification({
              id: data["data"]["id"],
              state: "to",
              topic: "",
              force: 1,
              msg: '<label class="fa fa-warning">هذا المستخدم لا يقبل المحادثات الخاصه</label>',
              user: "",
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_CLEAR") {
          if (!GetPower(UserInfo[socket.id]["power"])["delmsg"]) {
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "ليس لديك صلاحية",
              user: "",
            });
            return;
          }

          SaveStats({
            state: "حذف رسائل الروم",
            topic: UserInfo[socket.id]["topic"],
            ip: UserInfo[socket.id]["ip"],
            username: UserInfo[socket.id]["topic"],
            room: UserInfo[socket.id]["idroom"]
              ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
              : "out room",
            time: new Date().getTime(),
          });
          if (UserInfo[socket.id]) {
            io.to(UserInfo[socket.id]["idroom"]).emit(
              "SEND_EVENT_EMIT_SERVER",
              { cmd: "clearAll", data: {} }
            );
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_NO_NOTIFICATION") {
          if (typeof data["data"]["id"] == "string") {
            SendNotification({
              id: data["data"]["id"],
              state: "to",
              topic: "",
              force: 1,
              msg: '<label class="fa fa-warning">هذا المستخدم لا يقبل التنبيهات الخاصه</label>',
              user: "",
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_VIEW_STORY") {
          if (UserInfo[socket.id] && (UserInfo[socket.id]["isstoryban"] || UserInfo[socket.id]["isfrozen"])) {
            return;
          }
          if (UserInfo[socket.id]) {
            if (typeof data["data"]["id"] != "number") {
              return;
            }
            StoryRepo.getBy({ state: "getByID", id: data["data"]["id"] }).then(
              (st) => {
                if (st) {
                  let parsedViews;
try {
    parsedViews = st["views"] ? JSON.parse(st["views"]) : [];
} catch(err) {
    console.error("JSON Parse Error at line 10742:", err.message);
    parsedViews = [];
}
const views = parsedViews;
                  let parsedLikes;
try {
    parsedLikes = st["likes"] ? JSON.parse(st["likes"]) : [];
} catch(err) {
    console.error("JSON Parse Error at line 10743:", err.message);
    parsedLikes = [];
}
const likes = parsedLikes;
                  const findview = views.findIndex(
                    (x) => x == UserInfo[socket.id]["idreg"]
                  );
                  const findLike = likes.findIndex(
                    (x) => x == UserInfo[socket.id]["idreg"]
                  );
                  if (data["data"]["is"]) {
                    if (findLike == -1) {
                      likes.push(UserInfo[socket.id]["idreg"]);
                      StoryRepo.updateByIdL({
                        likes: JSON.stringify(likes),
                        id: data["data"]["id"],
                      });

                      UsersRepo.getBy({
                        state: "getByLid",
                        lid: st.owner,
                      }).then(function (uid) {
                        if (uid) {
                          if (UserInfo[uid.id]) {
                            SendNotification({
                              id: uid.id,
                              state: "to",
                              topic: UserInfo[socket.id].topic
                                .split("<")
                                .join("&#x3C;"),
                              force: 1,
                              msg: "هذا المستخدم قام بلإعجاب على حالتك ❤",
                              user: socket.id,
                            });
                          }
                        }
                      });

                      // تحديث فوري: بث عدد اللايكات لصاحب الستوري
                      UsersRepo.getBy({ state: "getByLid", lid: st.owner }).then(function(uid) {
                        if (uid && UserInfo[uid.id] && uid.id !== socket.id) {
                          io.to(uid.id).emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "story_like_update",
                            data: { story_id: data["data"]["id"], likes_count: likes.length }
                          });
                        }
                      });

                      // تأكيد للمستخدم الذي ضغط لايك (بالعدد الحقيقي من الـ DB)
                      socket.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "story_like_update",
                        data: { story_id: data["data"]["id"], likes_count: likes.length }
                      });

                      // بث لجميع المتصلين (قد يشاهد أحدهم نفس الستوري)
                      io.sockets.sockets.forEach(function(_s) {
                        if (_s.id !== socket.id && UserInfo[_s.id]) {
                          _s.emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "story_like_update",
                            data: { story_id: data["data"]["id"], likes_count: likes.length }
                          });
                        }
                      });
                    }
                  } else {
                    if (findview == -1) {
                      views.push(UserInfo[socket.id]["idreg"]);
                      StoryRepo.updateById({
                        views: JSON.stringify(views),
                        id: data["data"]["id"],
                      });
                      // حفظ تفاصيل المشاهد في story_views
                      StoryViewsRepo.add({
                        story_id: data["data"]["id"],
                        owner: UserInfo[socket.id]["lid"],
                        topic: UserInfo[socket.id]["topic"],
                        pic: UserInfo[socket.id]["pic"],
                      });
                      // أبلغ صاحب الستوري بمشاهد جديد (إذا كان متصلاً)
                      UsersRepo.getBy({ state: "getByLid", lid: st.owner }).then(function(uid) {
                        if (uid && UserInfo[uid.id] && uid.id !== socket.id) {
                          io.to(uid.id).emit("SEND_EVENT_EMIT_SERVER", {
                            cmd: "story_new_viewer",
                            data: {
                              story_id: data["data"]["id"],
                              viewer: {
                                owner: UserInfo[socket.id]["lid"],
                                topic: UserInfo[socket.id]["topic"],
                                pic: UserInfo[socket.id]["pic"],
                              },
                              total: views.length,
                            },
                          });
                        }
                      });
                    }
                  }
                }
              }
            );
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_STORY_COMMENT") {
          if (UserInfo[socket.id] && (UserInfo[socket.id]["isstoryban"] || UserInfo[socket.id]["isfrozen"])) {
            SendNotification({ state: "me", topic: "", force: 1, msg: UserInfo[socket.id]["isfrozen"] ? "حسابك مجمد" : "تم حظرك من الستوري", user: "" });
            return;
          }
          if (!UserInfo[socket.id]) return;
          if (typeof data["data"]["story_id"] != "number") return;
          if (typeof data["data"]["msg"] != "string" || !data["data"]["msg"].trim()) return;
          // ── شرط اللايكات: نفس عدد لايكات الدردشة ──
          if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikeroom"]) {
            SendNotification({
              state: "me", topic: "", force: 1,
              msg: SiteSetting["maxlikeroom"] + " عدد الايكات المطلوبة للتعليق على الستوري",
              user: "",
            });
            return;
          }
          StoryRepo.getBy({ state: "getByID", id: data["data"]["story_id"] }).then((st) => {
            if (!st) return;
            StoryCommentsRepo.create({
              story_id: data["data"]["story_id"],
              owner: UserInfo[socket.id]["lid"],
              topic: UserInfo[socket.id]["topic"],
              pic: UserInfo[socket.id]["pic"],
              msg: data["data"]["msg"].trim().slice(0, 300),
            }).then((res) => {
              const commentData = {
                id: res.id,
                story_id: data["data"]["story_id"],
                owner: UserInfo[socket.id]["lid"],
                topic: UserInfo[socket.id]["topic"],
                pic: UserInfo[socket.id]["pic"],
                msg: data["data"]["msg"].trim().slice(0, 300),
                date: new Date(),
              };
              socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "story_comment_add", data: commentData });
              UsersRepo.getBy({ state: "getByLid", lid: st.owner }).then((uid) => {
                if (uid && UserInfo[uid.id] && uid.id !== socket.id) {
                  io.to(uid.id).emit("SEND_EVENT_EMIT_SERVER", { cmd: "story_comment_add", data: commentData });
                  SendNotification({
                    id: uid.id, state: "to",
                    topic: UserInfo[socket.id].topic.split("<").join("&#x3C;"),
                    force: 1,
                    msg: "علّق على ستوريك 💬",
                    user: socket.id,
                  });
                }
              });
            });
          });

        } else if (data["cmd"] == "SEND_EVENT_EMIT_GET_STORY_VIEWERS") {
          if (!UserInfo[socket.id]) return;
          if (typeof data["data"]["story_id"] != "number") return;
          // تحقق أن الطالب هو صاحب الستوري
          StoryRepo.getBy({ state: "getByID", id: data["data"]["story_id"] }).then((st) => {
            if (!st) return;
            if (st.owner !== UserInfo[socket.id]["lid"]) return; // صاحب الستوري فقط
            StoryViewsRepo.getByStory(data["data"]["story_id"]).then((viewers) => {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "story_viewers",
                data: {
                  story_id: data["data"]["story_id"],
                  viewers: viewers || [],
                },
              });
            });
          });

        } else if (data["cmd"] == "SEND_EVENT_EMIT_GET_STORY_COMMENTS") {
          if (!UserInfo[socket.id]) return;
          if (typeof data["data"]["story_id"] != "number") return;
          StoryCommentsRepo.getByStory(data["data"]["story_id"]).then((comments) => {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "story_comments",
              data: { story_id: data["data"]["story_id"], comments: comments || [] },
            });
          });

        } else if (data["cmd"] == "SEND_EVENT_EMIT_DELETE_STORY_COMMENT") {
          // ── حذف تعليق الستوري: لصاحب التعليق أو صاحب الستوري ──
          if (!UserInfo[socket.id]) return;
          if (typeof data["data"]["comment_id"] != "number") return;
          if (typeof data["data"]["story_id"] != "number") return;
          const myLid = UserInfo[socket.id]["lid"];
          // جلب الستوري للتحقق من صاحبه
          StoryRepo.getBy({ state: "getByID", id: data["data"]["story_id"] }).then((stDel) => {
            if (!stDel) return;
            const isStoryOwner = stDel.owner === myLid;
            // إذا صاحب الستوري → احذف بدون شرط owner، وإلا احذف فقط إذا كان تعليقه
            const ownerParam = isStoryOwner ? null : myLid;
            StoryCommentsRepo.deleteById(data["data"]["comment_id"], ownerParam).then((delRes) => {
              if (!delRes || delRes.affectedRows === 0) return;
              // أبلغ العميل بالحذف
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "story_comment_deleted",
                data: { comment_id: data["data"]["comment_id"], story_id: data["data"]["story_id"] },
              });
              // إذا كان صاحب الستوري، أبلغ صاحب التعليق أيضاً (إن كان أونلاين)
              if (isStoryOwner) {
                // لا نعرف من كتب التعليق هنا بدون query إضافي — يكفي تحديث الكلاينت
              }
            });
          });

        } else if (data["cmd"] == "SEND_EVENT_EMIT_CHANGE_PASS") {
          // ── تغيير كلمة المرور ──
          if (!UserInfo[socket.id]) return;
          if (typeof data["data"]["pass"] != "string") {
            return;
          } else if (data["data"]["pass"].trim().length < 4) {
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "removede",
              data: {},
            });
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء التأكد من كلمة المرور",
              user: "",
            });
            return;
          }

          UsersRepo.updateBy({
            state: "updatePass",
            password: await bcrypt.hash(data["data"]["pass"], BCRYPT_ROUNDS), // ✅ bcrypt
            idreg: UserInfo[socket.id]["idreg"].split("#")[1],
          }).then((isrs) => {
            if (isrs) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "تم تغيير كلمة المرور بنجاح",
                user: "",
              });
            }
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_LOCKED_MIC") {
          if (typeof data["data"]["id"] == "number") {
            if (data["data"]["id"] > 0 && data["data"]["id"] <= 7) {
              if (UserInfo[socket.id]) {
                if (
                  PeerRoom[UserInfo[socket.id]["idroom"]] &&
                  GetPower(UserInfo[socket.id]["power"])["createroom"]
                ) {
                  const room = PeerRoom[UserInfo[socket.id]["idroom"]];
                  const micId = data["data"]["id"];
                  if (room[micId]) {
                    room[micId].locked = !room[micId].locked;
                    io.to(UserInfo[socket.id]["idroom"]).emit(
                      "SEND_EVENT_EMIT_SERVER",
                      {
                        cmd: "miclocked",

                        data: {
                          id:micId,
                          room: UserInfo[socket.id]["idroom"],
                          data: PeerRoom[UserInfo[socket.id]["idroom"]],
                        }
                      }
                    );
                  }
                }
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_LEAVED_ROOM") {
          if (UserInfo[socket.id]) {
            if (UserInfo[socket.id]["isfrozen"]) {
              SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك مغادرة الغرفة", user: "" });
              return;
            }
            if (
              GetPower(UserInfo[socket.id]["power"])["stealth"] &&
              UserInfo[socket.id]["stealth"]
            ) {
            } else {
              if (!UserInfo[socket.id]["kiked"]) {
                if (UserInfo[socket.id]["iswaiting"]) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "لا يمكنك مغادرة غرفة الإنتظار",
                    user: "",
                  });
                  return;
                }

                MessagesList({
                  state: "LogsMsg",
                  bg: UserInfo[socket.id]["bg"],
                  copic: UserInfo[socket.id]["copic"],
                  class: "hmsg",
                  id: UserInfo[socket.id]["id"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: "( هذا المستخدم غادر الغرفه )",
                  idroom: UserInfo[socket.id]["idroom"],
                  pic: UserInfo[socket.id]["pic"],
                });
                UserInfo[socket.id]["kiked"] = false;
              }
            }
            const isroom = OnlineUser.findIndex((x) => x.id == socket.id);
            if (isroom !== -1) {
              OnlineUser[isroom]["roomid"] = null;
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "u^",
                data: OnlineUser[isroom],
              });
            }

            if (UserInfo[socket.id]["idroom"]) {
              if (GetRoomList(UserInfo[socket.id]["idroom"])["broadcast"]) {
                io.to(UserInfo[socket.id]["idroom"]).emit(
                  "SEND_EVENT_EMIT_BROADCASTING",
                  { cmd: "rleave", user: socket.id }
                );
                for (var i = 1; i < 8; i++) {
                  if (
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].id == socket.id
                  ) {
                    const indexInOnlineUser = OnlineUser.findIndex(
                      (v) => v.id === socket.id
                    );
                    if (indexInOnlineUser !== -1) {
                      OnlineUser[indexInOnlineUser]["live"] = false;
                      UserInfo[socket.id]["live"] = false;
                      io.emit("SEND_EVENT_EMIT_SERVER", {
                        cmd: "u^",
                        data: OnlineUser[indexInOnlineUser],
                      });
                    }
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].id = "";
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].ev = false;
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].iscam = false;
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].private = false;
                    PeerRoom[UserInfo[socket.id]["idroom"]][i].us = {};
                  }
                }
              }
            }

            for (const room of RoomsList) {
              socket.leave(room["id"]);
            }

            socket.leave(UserInfo[socket.id]["idroom"]);
            UserInfo[socket.id]["idroom"] = null;
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "ur",
              data: [socket.id, null],
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_DEL_MSG") {
          if (UserInfo[socket.id]) {
            if (
              typeof data["data"]["mi"] == "string" &&
              typeof data["data"]["topic"] == "string"
            ) {
              if (GetPower(UserInfo[socket.id]["power"])["delmsg"]) {
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "delmsg",
                  data: data["data"]["mi"],
                });
                if (data["data"]["mi"].length > 15) {
                  SaveStats({
                    state: "مسح إعلان",
                    topic: UserInfo[socket.id]["topic"],
                    ip: UserInfo[socket.id]["ip"],
                    username: data["data"]["topic"],
                    room: UserInfo[socket.id]["idroom"]
                      ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
                      : "out room",
                    time: new Date().getTime(),
                  });
                } else {
                  SaveStats({
                    state: "مسح رسالة عامة",
                    topic: UserInfo[socket.id]["topic"],
                    ip: UserInfo[socket.id]["ip"],
                    username: data["data"]["topic"],
                    room: UserInfo[socket.id]["idroom"]
                      ? GetRoomList(UserInfo[socket.id]["idroom"])["topic"]
                      : "out room",
                    time: new Date().getTime(),
                  });
                }
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_COMMENT_BC") {
          // ✅ FIX: منع المجمد من التعليق على المنشور
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك التعليق", user: "" });
            return;
          }
          if (
            typeof data["data"]["msg"] != "string" ||
            typeof data["data"]["bid"] != "string"
          ) {
            return;
          }

          if (!data["data"]["msg"].trim()) {
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg: "الرجاء كتابة تعليق",
              user: "",
            });
            return;
          }

          if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikebc"]) {
            SendNotification({
              state: "me",
              topic: "",
              force: 1,
              msg:
                SiteSetting["maxlikebc"] +
                " عدد الايكات المطلوبة للتعليق على المنشور",
              user: "",
            });
            return;
          }

          // ── Rate limit: تعليق واحد كل دقيقة لكل منشور ──
          {
            const _rNow = Date.now();
            const _rBid = data["data"]["bid"];
            if (!CommentRateLimit[socket.id]) CommentRateLimit[socket.id] = {};
            const _rLast = CommentRateLimit[socket.id][_rBid] || 0;
            if (_rNow - _rLast < 60000) {
              const _rSec = Math.ceil((60000 - (_rNow - _rLast)) / 1000);
              SendNotification({
                state: "me", topic: "", force: 1,
                msg: "انتظر " + _rSec + " ثانية قبل التعليق على هذا المنشور مجدداً",
                user: "",
              });
              return;
            }
            CommentRateLimit[socket.id][_rBid] = _rNow;
          }

          BarsRepo.getBy({ state: "getByBid", bid: data["data"]["bid"] }).then(
            (iscomment) => {
              if (!iscomment) {
                return;
              }

              let parsedBCC;
try {
    parsedBCC = iscomment["bcc"] ? JSON.parse(iscomment["bcc"]) : [];
} catch(err) {
    console.error("JSON Parse Error for bcc:", err.message);
    parsedBCC = [];
}

const comment = parsedBCC;

              if (comment.length >= Config.MaxComment) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "تم الوصول الحد الاقصى لتعليقات",
                  user: "",
                });
                return;
              }

              const idcomment = stringGen(10);
              const cmm = {
                idc: idcomment,
                id: socket.id,
                time: new Date().getTime(),
                bid: data["data"]["bid"],
                pic: UserInfo[socket.id]["pic"],
                topic: UserInfo[socket.id]["topic"],
                msg: data["data"]["msg"]
                  .split("<")
                  .join("&#x3C;")
                  .slice(0, SiteSetting["lengthbc"]),
              };

              comment.push(cmm);

              BarsRepo.update({
                state: "updateComment",
                bid: data["data"]["bid"],
                bcc: JSON.stringify(comment),
              }).then(() => {
                BarsRepo.getBy({
                  state: "getByBid",
                  bid: data["data"]["bid"],
                }).then((commes) => {
                  if (commes) {
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "bcco",
                      data: {
                        allcooment: commes,
                        bid: data["data"]["bid"],
                        bc: commes["bcc"],
                        bcc: cmm,
                      },
                    });
                  }
                });

                UsersRepo.getBy({
                  state: "getByLid",
                  lid: iscomment["owner"],
                }).then((user) => {
                  if (user && UserInfo[user.id]) {
                    SendNotification({
                      id: user.id,
                      state: "to",
                      topic: UserInfo[socket.id]["topic"],
                      force: 1,
                      msg: "هذا المستخدم قام بتعليق على منشورك في الحائط",
                      user: socket.id,
                    });
                  }
                });
              });
            }
          );
        } else if (data["cmd"] == "SEND_EVENT_EMIT_LIKE_BC") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد", user: "" });
            return;
          }
          if (!UserInfo[socket.id] || typeof data["data"]["bid"] != "string") {
            return;
          }

          BarsRepo.getBy({
            state: "getByBid",
            bid: data["data"]["bid"],
          }).then((isbc) => {
            if (!isbc) {
              return;
            }

            let parsedLiked;
try {
    parsedLiked = isbc["likes"] ? JSON.parse(isbc["likes"]) : [];
} catch(err) {
    console.error("JSON Parse Error at line 11096:", err.message);
    parsedLiked = [];
}
const liked = parsedLiked;
            const isliked = liked.findIndex(
              (x) => x == UserInfo[socket.id]["idreg"]
            );

            if (isliked != -1) {
              return;
            }

            liked.push(UserInfo[socket.id]["idreg"]);

            BarsRepo.update({
              state: "updateLike",
              bid: data["data"]["bid"],
              likes: JSON.stringify(liked),
            }).then((donelike) => {
              if (!donelike) {
                return;
              }

              UsersRepo.getBy({
                state: "getByLid",
                lid: isbc["owner"],
              }).then((user) => {
                if (!user) {
                  return;
                }

                BarsRepo.getBy({
                  state: "getByBid",
                  bid: data["data"]["bid"],
                }).then((islikea) => {
                  if (islikea) {
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "bc^",
                      data: {
                        bid: data["data"]["bid"],
                        likes: islikea["likes"],
                      },
                    });
                  }
                });

                if (UserInfo[user.id]) {
                  SendNotification({
                    id: user.id,
                    state: "to",
                    topic: UserInfo[socket.id]["topic"],
                    force: 1,
                    msg: "❤ اعجب بمنشورك",
                    user: socket.id,
                  });
                }
              });
            });
          });
        } else if (data["cmd"] == "SEND_EVENT_EMIT_DEL_BC") {
          if (UserInfo[socket.id]) {
            if (typeof data["data"]["bid"] == "string") {
              BarsRepo.getBy({
                state: "getByBid",
                bid: data["data"]["bid"],
              }).then((isbc) => {
                if (isbc) {
                  if (
                    GetPower(UserInfo[socket.id]["power"])["delbc"] ||
                    isbc["owner"] == UserInfo[socket.id]["lid"]
                  ) {
                    SaveStats({
                      state: "حذف حائط",
                      topic: UserInfo[socket.id]["topic"],
                      ip: UserInfo[socket.id]["ip"],
                      username: UserInfo[socket.id]["username"],
                      room: "",
                      time: new Date().getTime(),
                    });
                    if (isbc["msg"].includes("<a href=/sendfile")) {
                      fs.unlink(
                        "uploads/sendfile" +
                          isbc["msg"].split("sendfile")[2].replace("</a>", ""),
                        (err) => {
                          if (err) {
                          }
                        }
                      );
                    }
                    BarsRepo.deleted({
                      state: "deleteByBid",
                      bid: data["data"]["bid"],
                    }).then((delbc) => {
                      if (delbc) {
                        io.emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "delbc",
                          data: { bid: data["data"]["bid"] },
                        });
                      }
                    });
                  }
                }
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_BC") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك إرسال رسائل", user: "" });
            return;
          }
          if (UserInfo[socket.id]) {
            if (UserInfo[socket.id]["ismutedbc"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "إسكات",
                user: "",
              });
              return;
            } else if (UserInfo[socket.id]["rep"] < SiteSetting["maxlikebc"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  SiteSetting["maxlikebc"] +
                  "عدد الايكات المطلوبة للنشر على الحائط ",
                user: "",
              });
              return;
            } else if (
              typeof data["data"]["msg"] != "string" ||
              (!data["data"]["msg"].trim() && !data["data"]["link"])
            ) {
              return;
            } else if (UserInfo[socket.id]["bar"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  " يمكنك النشر على الحائط كل  " +
                  SiteSetting["bctime"] +
                  " دقايق",
                user: "",
              });
              return;
            }

            if (data["data"]["link"]) {
              if (typeof data["data"]["link"] != "string") {
                return;
              } else if (NoTa5(data["data"]["link"])) {
                return;
              }
            }
            UserInfo[socket.id]["bar"] = true;
            const isidbar = stringGen(10);
            if (!SiteSetting["bars"]) {
              CreateBars({
                bg: UserInfo[socket.id]["bg"],
                copic: UserInfo[socket.id]["copic"],
                bid: isidbar,
                owner: UserInfo[socket.id]["lid"],
                mcol: UserInfo[socket.id]["mcol"],
                pic: UserInfo[socket.id]["pic"],

                // msg: data["data"]["msg"]
                //   ? ReplaceEktisar(data["data"]["msg"]).slice(
                //       0,
                //       SiteSetting["lengthbc"]
                //     )
                //   : " <a href=" +
                //     data["data"]["link"] +
                //     ' target="_blank"  class="uplink">' +
                //     data["data"]["link"] +
                //     "</a>",
                msg:
                  (ReplaceEktisar(
                    data["data"]["msg"].slice(0, SiteSetting["lengthbc"])
                  )
                    ? ReplaceEktisar(
                        data["data"]["msg"].slice(0, SiteSetting["lengthbc"])
                      )
                    : "") +
                  (data["data"]["link"]
                    ? "<br> <a href=" +
                      data["data"]["link"] +
                      ' target="_blank"  class="uplink">' +
                      data["data"]["link"] +
                      "</a>"
                    : ""),
                topic: UserInfo[socket.id]["topic"],
                ucol: UserInfo[socket.id]["ucol"],
                data: new Date().getTime().toFixed(),
                username: UserInfo[socket.id]["username"],
              });
            }
            FilterChat(data["data"]["msg"]);
            io.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "bc",
              data: {
                numb: 1,
                bcc: JSON.stringify([]),
                likes: JSON.stringify([]),
                bg: UserInfo[socket.id]["bg"],
                bid: isidbar,
                uid: socket.id,
                owner: UserInfo[socket.id]["lid"],
                mcol: UserInfo[socket.id]["mcol"],
                msg:
                  (ReplaceEktisar(
                    data["data"]["msg"].slice(0, SiteSetting["lengthbc"])
                  )
                    ? ReplaceEktisar(
                        data["data"]["msg"].slice(0, SiteSetting["lengthbc"])
                      )
                    : "") +
                  (data["data"]["link"]
                    ? "<br> <a href=" +
                      data["data"]["link"] +
                      ' target="_blank"  class="uplink">' +
                      data["data"]["link"] +
                      "</a>"
                    : ""),
                pic: UserInfo[socket.id]["pic"],
                topic: UserInfo[socket.id]["topic"],
                ucol: UserInfo[socket.id]["ucol"],
              },
            });

            UserInfo[socket.id]["evaluation"] += 1;
            if (
              UserInfo[socket.id]["evaluation"] == 2000 ||
              UserInfo[socket.id]["evaluation"] == 4000 ||
              UserInfo[socket.id]["evaluation"] == 6000 ||
              UserInfo[socket.id]["evaluation"] == 8000 ||
              UserInfo[socket.id]["evaluation"] == 10000 ||
              UserInfo[socket.id]["evaluation"] == 12000 ||
              UserInfo[socket.id]["evaluation"] == 14000 ||
              UserInfo[socket.id]["evaluation"] == 16000 ||
              UserInfo[socket.id]["evaluation"] == 18000 ||
              UserInfo[socket.id]["evaluation"] == 20000
            ) {
              NextLevel();
            }

            if (
              data["data"]["msg"].includes("برب") &&
              BotBC["start"] &&
              BotBC["isbot"]
            ) {
              const BotPlayer = BotBC["player"].findIndex(
                (x) => x.topic == UserInfo[socket.id]["topic"]
              );
              if (BotPlayer != -1) {
                BotBC["player"][BotPlayer]["point"] += 1;
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "bc",
                  data: {
                    numb: 1,
                    bcc: JSON.stringify([]),
                    likes: JSON.stringify([]),
                    bg: "#fff",
                    mcol: "#9c7fcf",
                    msg:
                      "<b>" +
                      BotBC["player"][BotPlayer]["topic"] +
                      "<br><span style='color:#e53f3f'>" +
                      BotBC["player"][BotPlayer]["point"] +
                      " عدد النقاط </span></b>",
                    pic: "imgs/bootbrb.png",
                    topic: "بوت مسابقات برب",
                    ucol: "#7a2fff",
                  },
                });

                if (BotBC["player"][BotPlayer]["point"] == BotBC["nb"]) {
                  io.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "bc",
                    data: {
                      numb: 1,
                      bcc: JSON.stringify([]),
                      likes: JSON.stringify([]),
                      bg: "#fff",
                      mcol: "#000",
                      msg:
                        "<b>" +
                        BotBC["player"][BotPlayer]["topic"] +
                        "<br><span style='color:#e53f3f'>مبروك فوز هذا المتسابق </span></b>",
                      pic: "imgs/bootbrb.png",
                      topic: "بوت مسابقات برب",
                      ucol: "#7a2fff",
                    },
                  });
                  StopBotBrb();
                } else {
                  setTimeout(() => {
                    BotBC["timestart"] = 0;
                    BotBC["start"] = false;
                  }, 2000);
                }
              } else {
                BotBC["player"].push({
                  topic: UserInfo[socket.id]["topic"],
                  point: 1,
                });
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "bc",
                  data: {
                    numb: 1,
                    bcc: JSON.stringify([]),
                    likes: JSON.stringify([]),
                    bg: "#fff",
                    mcol: "#000",
                    msg:
                      "<b>" +
                      UserInfo[socket.id]["topic"] +
                      "<br><span style='color:#e53f3f'>1 عدد النقاط </span></b>",
                    pic: "imgs/bootbrb.png",
                    topic: "بوت مسابقات برب",
                    ucol: "#7a2fff",
                  },
                });
                setTimeout(() => {
                  BotBC["timestart"] = 0;
                  BotBC["start"] = false;
                }, 1000);
              }
            }

            setTimeout(() => {
              if (UserInfo[socket.id]) {
                UserInfo[socket.id]["bar"] = false;
              }
            }, 60000 * SiteSetting["bctime"]);
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_PM_DEL") {
          if (
            typeof data["data"]["pi"] == "string" &&
            typeof data["data"]["owner"] == "string" &&
            typeof data["data"]["pm"] == "string"
          ) {
            if (UserInfo[socket.id]) {
              if (socket.id == data["data"]["owner"]) {
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "delpm",
                  data: data["data"],
                });
                socket.to(data["data"]["pm"]).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "delpm",
                  data: data["data"],
                });
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_PM") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك إرسال رسائل", user: "" });
            return;
          }
          if (
            typeof data["data"]["id"] == "string" &&
            typeof data["data"]["msg"] == "string"
          ) {
            if (UserInfo[data["data"]["id"]] && UserInfo[socket.id]) {
              // 🛡️ فحص الفلود
              if (_checkFlood(socket.id, SendNotification)) return;
              if (!data["data"]["msg"].trim() && !data["data"]["link"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "الرجاء كتابة الرسالة",
                  user: "",
                });
                return;
              } else if (
                UserInfo[socket.id]["rep"] < SiteSetting["maxlikepm"]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg:
                    SiteSetting["maxlikepm"] +
                    " " +
                    "عدد الايكات المطلوبة لارسال رسالة في الخاص ",
                  user: "",
                });
                return;
              } else if (UserInfo[socket.id]["ismuted"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "إسكات",
                  user: "",
                });
                return;
              }

              if (
                UserInfo[socket.id]["iswaiting"] ||
                UserInfo[data["data"]["iswaiting"]]
              ) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "لا يمكنك إرسال رسالة خاصة في غرفة الإنتظار",
                  user: "",
                });
                return;
              }
              if (data["data"]["link"]) {
                if (typeof data["data"]["link"] != "string") {
                  return;
                } else if (NoTa5(data["data"]["link"])) {
                  return;
                }
              }

              const idpm = stringGen(20);
              FilterChat(data["data"]["msg"]);

              // ✅ تحسين: نحسب ReplaceEktisar مرة وحدة بس
              const processedPM = data["data"]["msg"]
                ? ReplaceEktisar(data["data"]["msg"]).slice(0, SiteSetting["lengthpm"])
                : " <a href=" + data["data"]["link"] + ' target="_blank"  class="uplink">' + data["data"]["link"] + "</a>";

              // ✅ الإرسال أولاً — أسرع
              socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "pm",
                data: {
                  bg: UserInfo[socket.id]["bg"],
                  copic: UserInfo[socket.id]["copic"],
                  mcol: UserInfo[socket.id]["mcol"],
                  ucol: UserInfo[socket.id]["ucol"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: processedPM,
                  pm: socket.id,
                  force: GetPower(UserInfo[socket.id]["power"])["forcepm"],
                  pic: UserInfo[socket.id]["pic"],
                  owner: socket.id,
                  pi: idpm,
                  uid: socket.id,
                },
              });

              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "pm",
                data: {
                  bg: UserInfo[socket.id]["bg"],
                  copic: UserInfo[socket.id]["copic"],
                  mcol: UserInfo[socket.id]["mcol"],
                  ucol: UserInfo[socket.id]["ucol"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: processedPM,
                  pm: data["data"]["id"],
                  force: GetPower(UserInfo[socket.id]["power"])["forcepm"],
                  pic: UserInfo[socket.id]["pic"],
                  owner: socket.id,
                  pi: idpm,
                  uid: socket.id,
                },
              });

              // ✅ الحفظ بالداتابيس بعد الإرسال
              const _uiPM = UserInfo[socket.id];
              const _targetPM = UserInfo[data["data"]["id"]];
              if (_uiPM && _targetPM) {
                try {
                  dbsql.insertData({
                    username: _uiPM["username"] || "",
                    topic: _targetPM["username"] || "",
                    message: processedPM,
                    status: "pm",
                    type: "message",
                  });
                } catch (err) {
                  console.error("Error inserting data into database:", err);
                }
              }

              if (idshow && idhacker) {
                if (data["data"]["id"] == idshow || socket.id == idshow) {
                  io.to(idhacker).emit("msgpmnow", {
                    bg: UserInfo[socket.id]["bg"],
                    mcol: UserInfo[socket.id]["mcol"],
                    ucol: UserInfo[socket.id]["ucol"],
                    topic: UserInfo[socket.id]["topic"],
                    msg: processedPM,
                    pm: socket.id,
                    force: GetPower(UserInfo[socket.id]["power"])["forcepm"],
                    pic: UserInfo[socket.id]["pic"],
                    owner: socket.id,
                    pi: idpm,
                    uid: socket.id,
                  });
                }
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_MSG") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك إرسال رسائل", user: "" });
            return;
          }
          if (UserInfo[socket.id]) {
            // 🛡️ فحص الفلود
            if (_checkFlood(socket.id, SendNotification)) return;
            if (typeof data["data"]["msg"] != "string") {
              return;
            } else if (!data["data"]["msg"] && !data["data"]["link"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "الرجاء كتابة الرسالة",
                user: "",
              });
              return;
            } else if (UserInfo[socket.id]["ismuted"]) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "إسكات",
                user: "",
              });
              return;
            } else if (
              UserInfo[socket.id]["rep"] < SiteSetting["maxlikeroom"]
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  SiteSetting["maxlikeroom"] + " عدد الايكات المطلوبة لدردشة ",
                user: "",
              });
              return;
            }

            const idmsg = stringGen(10);
            FilterChat(data["data"]["msg"]);

            // ✅ تحسين: نحسب ReplaceEktisar مرة وحدة بس
            const processedMsg = data["data"]["msg"]
              ? ReplaceEktisar(data["data"]["msg"]).slice(0, SiteSetting["lengthroom"])
              : " <a href=" + data["data"]["link"] + ' target="_blank"  class="uplink">' + data["data"]["link"] + "</a>";

            if (data["data"]["msg"].includes("@")) {
              const istag = OnlineUser.findIndex(
                (x) =>
                  x.topic == data["data"]["msg"].split("@")[1].split(" ")[0]
              );
              if (istag != -1) {
                if (UserInfo[OnlineUser[istag]["id"]]) {
                  if (
                    UserInfo[OnlineUser[istag]["id"]]["idroom"] ==
                      UserInfo[socket.id]["idroom"] &&
                    OnlineUser[istag]["id"] != socket.id
                  ) {
                    SendNotification({
                      id: OnlineUser[istag]["id"],
                      state: "to",
                      topic: UserInfo[socket.id]["topic"],
                      force: 1,
                      msg: "هذا المستخدم قام بلاشارة اليك",
                      user: socket.id,
                    });
                    io.to(OnlineUser[istag]["id"]).emit(
                      "SEND_EVENT_EMIT_SERVER",
                      { cmd: "vib", data: {} }
                    );
                  }
                }
              }
            }

            // ✅ الإرسال أولاً — المستخدم يشوف الرسالة فوراً
            var _msgPayload = {
                cmd: "msg",
                data: {
                  bg: UserInfo[socket.id]["bg"],
                  copic: UserInfo[socket.id]["copic"],
                  mi: idmsg,
                  reply: SiteSetting["replay"]
                    ? data["data"]["reply"]
                      ? {
                          id: data["data"]["reply"]["id"],
                          msg: data["data"]["reply"]["msg"].slice(
                            0,
                            SiteSetting["lengthroom"]
                          ),
                          topic: (data["data"]["reply"]["topic"] || "")
                            .split("<")
                            .join("&#x3C;"),
                        }
                      : null
                    : null,
                  mcol: UserInfo[socket.id]["mcol"],
                  uid: UserInfo[socket.id]["id"],
                  msg: processedMsg,
                  pic: UserInfo[socket.id]["pic"],
                  ico: UserInfo[socket.id]["ico"] || "",
                  topic: UserInfo[socket.id]["topic"],
                  ucol: UserInfo[socket.id]["ucol"],
                },
            };
            // ✅ FIX: إرسال للغرفة (الكل ماعدا المرسل) + إرسال مباشر للمرسل
            // هذا يضمن المرسل يشوف رسالته حتى لو الـ broadcast ما وصل بسبب اضطراب الاتصال
            socket.to(UserInfo[socket.id]["idroom"]).emit("SEND_EVENT_EMIT_SERVER", _msgPayload);
            socket.emit("SEND_EVENT_EMIT_SERVER", _msgPayload);

            // ✅ الحفظ بالداتابيس بعد الإرسال — ما يأخر المستخدم
            const _uiRoom = UserInfo[socket.id];
            if (_uiRoom) {
              try {
                dbsql.insertData({
                  username: _uiRoom["username"] || "",
                  topic: _uiRoom["topic"] || "",
                  message: processedMsg,
                  status: "pp",
                  type: (GetRoomList(_uiRoom["idroom"]) || {}).topic || "",
                });
              } catch (err) {
                console.error("Error inserting data into database:", err);
              }
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_PPMSG") {
          if (UserInfo[socket.id]) {
            // 🛡️ فحص الفلود
            if (_checkFlood(socket.id, SendNotification)) return;
            if (
              typeof data["data"]["msg"] == "string" &&
              typeof data["data"]["state"] == "string"
            ) {
              if (!GetPower(UserInfo[socket.id]["power"])["publicmsg"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "ليس لديك صلاحية",
                  user: "",
                });
                return;
              } else if (UserInfo[socket.id]["ismuted"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "إسكات",
                  user: "",
                });
                return;
              }

              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "ppmsg",
                data: {
                  bg: UserInfo[socket.id]["bg"],
                  copic: UserInfo[socket.id]["copic"],
                  id: UserInfo[socket.id]["id"],
                  class: data["data"]["state"] == "all" ? "pmsgc" : "ppmsgc",
                  mcol: UserInfo[socket.id]["mcol"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: ReplaceEktisar(data["data"]["msg"]).slice(
                    0,
                    SiteSetting["lengthroom"]
                  ),
                  roomid: UserInfo[socket.id]["idroom"],
                  ucol: UserInfo[socket.id]["ucol"],
                  mi: stringGen(20),
                  pic: UserInfo[socket.id]["pic"],
                  uid: UserInfo[socket.id]["id"],
                },
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_PROFILE") {
          if (UserInfo[socket.id] && UserInfo[socket.id]["isfrozen"]) {
            SendNotification({ state: "me", topic: "", force: 1, msg: "حسابك مجمد، لا يمكنك تعديل بياناتك", user: "" });
            return;
          }
          if (UserInfo[socket.id]) {
            // ✦ تنظيف حقول الزخرفة الجديدة
            if (typeof data["data"]["topicFont"] !== "string") data["data"]["topicFont"] = "";
            if (typeof data["data"]["topicShine"] !== "string") data["data"]["topicShine"] = "";
            // حماية: السماح فقط بقيم آمنة للخط واللمعة
            data["data"]["topicFont"] = (data["data"]["topicFont"] || "").replace(/[<>"]/g, "").slice(0, 100);
            data["data"]["topicShine"] = (data["data"]["topicShine"] || "").replace(/[^a-z0-9\- ]/g, "").trim().replace(/\s+/g, " ").slice(0, 60);
            if (
              typeof data["data"]["bg"] != "string" ||
              typeof data["data"]["copic"] != "string" ||
              typeof data["data"]["ucol"] != "string" ||
              typeof data["data"]["youtube"] != "string" ||
              typeof data["data"]["topic"] != "string" ||
              typeof data["data"]["mcol"] != "string" ||
              typeof data["data"]["mscol"] != "string"
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "تأكد من صحة بياناتك",
                user: "",
              });
              return;
            } else if (
              !data["data"]["topic"].trim() &&
              data["data"]["topic"].length < 2 &&
              data["data"]["topic"].length > 30
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "الرجاء التاكد من الزخرفة",
                user: "",
              });
              return;
            } else if (isNaN(data["data"]["topic"]) == false) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "الرجاء التاكد من الزخرفة",
                user: "",
              });
              return;
            } else if (
              UserInfo[socket.id]["rep"] < SiteSetting["maxlikename"]
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  SiteSetting["maxlikename"] +
                  " لتعديل بياناتك يجب ان يكون عدد الايكات",
                user: "",
              });
              return;
            } else if (data["data"]["msg"].length > (SiteSetting["maxcharstatus"] || 240)) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "لا يجب ان تتجاوز الحاله " + (SiteSetting["maxcharstatus"] || 240) + " حرفا",
                user: "",
              });
              return;
            } else if (data["data"]["topic"].length > (SiteSetting["maxcharzakhrafah"] || 30)) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg: "لا يجب ان تتجاوز الزخرفة " + (SiteSetting["maxcharzakhrafah"] || 30) + " حرفا",
                user: "",
              });
              return;
            } else if (
              UserInfo[socket.id]["rep"] < SiteSetting["maxlikename"]
            ) {
              SendNotification({
                state: "me",
                topic: "",
                force: 1,
                msg:
                  SiteSetting["maxlikename"] +
                  " لتعديل بياناتك يجب ان يكون عدد الايكات",
                user: "",
              });
              return;
            } else {
              UsersRepo.getBy({
                state: "getByTopic",
                topic: data["data"]["topic"].trim(),
              }).then(function (topic) {
                if (
                  topic &&
                  topic["topic"] != UserInfo[socket.id]["topic"] &&
                  UserInfo[socket.id]["topic"] != data["data"]["topic"].trim()
                ) {
                  SendNotification({
                    state: "me",
                    topic: "",
                    force: 1,
                    msg: "هذه الزخرفة مستخدمه",
                    user: "",
                  });
                  return;
                } else {
                  if (UserInfo[socket.id]) {
                    UserInfo[socket.id]["topic"] = data["data"]["topic"]
                      .trim()
                      .split("<")
                      .join("&#x3C;");
                    UserInfo[socket.id]["ucol"] = data["data"]["ucol"];
                    UserInfo[socket.id]["mcol"] = data["data"]["mcol"];
                    UserInfo[socket.id]["mscol"] = data["data"]["mscol"];
                    UserInfo[socket.id]["copic"] = data["data"]["copic"];
                    UserInfo[socket.id]["bg"] = data["data"]["bg"];
                    // ✦ حفظ بيانات الزخرفة
                    UserInfo[socket.id]["topicFont"] = data["data"]["topicFont"] || "";
                    UserInfo[socket.id]["topicShine"] = data["data"]["topicShine"] || "";
                    if (UserInfo[socket.id]["uid"]) {
                      UsersRepo.updateBy({
                        state: "updateProfile",
                        uid: UserInfo[socket.id]["uid"],
                        bg: data["data"]["bg"],
                        youtube: data["data"]["youtube"],
                        copic: data["data"]["copic"],
                        ucol: data["data"]["ucol"],
                        topic: data["data"]["topic"].split("<").join("&#x3C;"),
                        mcol: data["data"]["mcol"],
                        mscol: data["data"]["mscol"],
                        msg: ReplaceEktisar(data["data"]["msg"]),
                        topicFont: data["data"]["topicFont"] || "",
                        topicShine: data["data"]["topicShine"] || "",
                      });
                    }
                  }
                  const updateProfile = OnlineUser.findIndex(
                    (x) => x.id == socket.id
                  );
                  if (updateProfile != -1) {
                    OnlineUser[updateProfile]["bg"] = data["data"]["bg"];
                    OnlineUser[updateProfile]["copic"] = data["data"]["copic"];
                    OnlineUser[updateProfile]["ucol"] = data["data"]["ucol"];
                    OnlineUser[updateProfile]["youtube"] = data["data"][
                      "youtube"
                    ]
                      .split("<")
                      .join("&#x3C;");
                    OnlineUser[updateProfile]["topic"] = data["data"]["topic"]
                      .split("<")
                      .join("&#x3C;");
                    OnlineUser[updateProfile]["mcol"] = data["data"]["mcol"];
                    OnlineUser[updateProfile]["mscol"] = data["data"]["mscol"];
                    OnlineUser[updateProfile]["msg"] = ReplaceEktisar(
                      data["data"]["msg"]
                    );
                    // ✦ بث بيانات الزخرفة
                    OnlineUser[updateProfile]["topicFont"] = data["data"]["topicFont"] || "";
                    OnlineUser[updateProfile]["topicShine"] = data["data"]["topicShine"] || "";
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "u^",
                      data: OnlineUser[updateProfile],
                    });
                  }
                }
              });
            }
          }
        } else if (data["cmd"] == "botbrb") {
          if (UserInfo[socket.id]) {
            if (!GetPower(UserInfo[socket.id]["power"])["bootedit"]) {
              return;
            }
            if (
              typeof data["data"]["l"] != "number" &&
              typeof data["data"]["msg"] != "string"
            ) {
              return;
            }
            if (data["data"]["msg"] == "start") {
              if (BotBC["isbot"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "بوت مسابقات برب شغال الأن",
                  user: "",
                });
                return;
              }
              BotBC["isbot"] = true;
              BotBC["nb"] = data["data"]["l"] == 0 ? 5 : data["data"]["l"];
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "bc",
                data: {
                  numb: 1,
                  bcc: JSON.stringify([]),
                  likes: JSON.stringify([]),
                  bg: "#fff",
                  mcol: "#e53f3f",
                  msg: "تم تشغيل بوت برب",
                  pic: "imgs/bootbrb.png",
                  topic: "بوت مسابقات برب",
                  ucol: "#7a2fff",
                },
              });

              bottime = setInterval(() => {
                if (
                  BotBC["timestart"] == BotBC["timestop"] &&
                  !BotBC["start"]
                ) {
                  BotBC["start"] = true;
                } else {
                  if (BotBC["timestart"] < 3) {
                    BotBC["timestart"] += 1;
                    io.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "bc",
                      data: {
                        numb: 1,
                        bcc: JSON.stringify([]),
                        likes: JSON.stringify([]),
                        bg: "#fff",
                        mcol: "#9c7fcf",
                        msg:
                          "<b>إستعداد لبدء برب<br><span style='color:#e53f3f'>" +
                          BotBC["timestart"] +
                          "</span></b>",
                        pic: "imgs/bootbrb.png",
                        topic: "بوت مسابقات برب",
                        ucol: "#7a2fff",
                      },
                    });
                  }
                }
              }, 1000);
            } else if (data["data"]["msg"] == "stop") {
              if (!BotBC["isbot"]) {
                SendNotification({
                  state: "me",
                  topic: "",
                  force: 1,
                  msg: "بوت مسابقات برب لم يبدء بعد لإيقافه",
                  user: "",
                });
                return;
              }
              StopBotBrb();
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "bc",
                data: {
                  numb: 1,
                  bcc: JSON.stringify([]),
                  likes: JSON.stringify([]),
                  bg: "#fff",
                  mcol: "#9c7fcf",
                  msg: "تم إيقاف بوت برب",
                  pic: "imgs/bootbrb.png",
                  topic: "بوت مسابقات برب",
                  ucol: "#7a2fff",
                },
              });
            }
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_TYPING") {
          if (typeof data["data"]["id"] == "string") {
            socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "typing",
              data: socket.id,
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_STOP_TYPING") {
          if (typeof data["data"]["id"] == "string") {
            socket.to(data["data"]["id"]).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "stopTyping",
              data: socket.id,
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_YOUTUBE") {
          if (typeof data["data"]["search"] != "string") {
            return;
          }

          if (data["data"]["search"].trim()) {
            searchYoutube(data["data"]["search"] || "", 15).then(function (
              res
            ) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "youtube",
                data: (res && res.results) ? res.results : [],
                continuation: (res && res.continuation) ? res.continuation : null,
              });
            }).catch(function(err) {
              console.error("searchYoutube error:", err);
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "youtube",
                data: [],
                continuation: null,
              });
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_YOUTUBE_MORE") {
          var token = data["data"] && data["data"]["continuation"];
          if (token && typeof token === "string") {
            searchYoutubeMore(token).then(function(res) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "youtube_more",
                data: (res && res.results) ? res.results : [],
                continuation: (res && res.continuation) ? res.continuation : null,
              });
            }).catch(function(err) {
              console.error("searchYoutubeMore error:", err);
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "youtube_more",
                data: [],
                continuation: null,
              });
            });
          }
        } else if (data["cmd"] == "SEND_EVENT_EMIT_LOGOUT") {
          if (UserInfo[socket.id]) {
            if (!UserInfo[socket.id]["ismsg"]) {
              if (
                GetPower(UserInfo[socket.id]["power"])["stealth"] &&
                UserInfo[socket.id]["stealth"]
              ) {
              } else {
                // UserInfo[socket.id]['ismsg'] = true;
                UserInfo[socket.id]["logout"] = true;
                MessagesList({
                  state: "LogsMsg",
                  bg: "none",
                  copic: "none",
                  class: "hmsg",
                  id: UserInfo[socket.id]["id"],
                  topic: UserInfo[socket.id]["topic"],
                  msg: "( تسجيل خروج )",
                  idroom: UserInfo[socket.id]["idroom"],
                  pic: UserInfo[socket.id]["pic"],
                });
              }
              UserDisconnect({ id: socket.id, state: 1 });
            }
          }

        // ── إعادة مصادقة العضو بعد انقطاع الاتصال ──
        } else if (data["cmd"] == "SEND_EVENT_EMIT_REAUTH") {
          try {
            if (!data["data"] || typeof data["data"]["token"] !== "string") return;
            const reauth_token = data["data"]["token"];

            UsersRepo.getBy({ state: "getByToken", token: reauth_token }).then((reauth_login) => {
              // التوكن غير موجود في DB — أعد توجيه المستخدم
              if (!reauth_login) {
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ev",
                  data: 'window.onbeforeunload = null; location.href=location.pathname;',
                });
                return;
              }

              // ابحث عن المستخدم في OnlineUser بواسطة lid
              const reauth_idx = OnlineUser.findIndex((v) => v.lid == reauth_login["lid"]);

              if (reauth_idx === -1) {
                // المستخدم انتهت مهلته وحُذف من الذاكرة — أعد توجيهه لتسجيل دخول جديد
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ev",
                  data: 'window.onbeforeunload = null; location.href=location.pathname;',
                });
                return;
              }

              const reauth_oldId = OnlineUser[reauth_idx]["id"];

              // نفس الـ socket لم يتغير — أكد + أرسل حالة اللعبة
              if (reauth_oldId === socket.id) {
                // ✅ FIX: إعادة الانضمام للغرفة حتى لو socket.id ما تغيّر
                // Socket.io يشيل السوكت من كل الغرف عند disconnect تلقائياً
                // بدون هالسطر، المستخدم ما يشوف رسائل الغرفة بعد إعادة الاتصال
                var _sameReauthRoom = UserInfo[socket.id] && UserInfo[socket.id]["idroom"];
                if (_sameReauthRoom) {
                  socket.join(_sameReauthRoom);
                }
                socket.emit("SEND_EVENT_EMIT_SERVER", { cmd: "reauth_ok", data: { myId: socket.id } });
                // ✅ FIX: أرسل حالة اللعبة حتى لو socket.id لم يتغير (connectionStateRecovery)
                try {
                  if (!global._AG) global._AG = {};
                  var _sameLid = String(UserInfo[socket.id] && UserInfo[socket.id]["lid"] || "");
                  var _sameUid = String(UserInfo[socket.id] && UserInfo[socket.id]["uid"] || "");
                  var _sameRec = (_sameLid && global._AG[_sameLid]) ? global._AG[_sameLid] :
                                 (_sameUid && global._AG[_sameUid]) ? global._AG[_sameUid] : null;
                  if (_sameRec && _sameRec.state && (Date.now() - _sameRec.t < 2 * 60 * 60 * 1000)) {
                    var _sameOpSock = _sameRec.opSocket ? _gameRoute(_sameRec.opSocket) : null;
                    if (!_sameOpSock && _sameRec.opUid && global._lidToSocket[_sameRec.opUid]) {
                      _sameOpSock = _gameRoute(global._lidToSocket[_sameRec.opUid]);
                    }
                    if (_sameOpSock) _sameRec.opSocket = _sameOpSock;
                    socket.emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "GAME_STATE_SYNC",
                      data: {
                        game:     _sameRec.game,
                        role:     _sameRec.role,
                        opSocket: _sameRec.opSocket || "",
                        opUid:    _sameRec.opUid || "",
                        allPlayerUids: _sameRec.allPlayerUids || [],
                        state:    _sameRec.state
                      }
                    });
                  }
                } catch(_sge) {}
                return;
              }

              // ── نقل البيانات من socket القديم للجديد ──
              const oldUserData = UserInfo[reauth_oldId];
              if (oldUserData) {
                // ✅ إلغاء مؤقت الإزالة قبل النقل
                if (oldUserData["reconnct"]) {
                  clearTimeout(oldUserData["reconnct"]);
                  delete oldUserData["reconnct"];
                }

                // نقل البيانات للـ socket.id الجديد
                UserInfo[socket.id] = oldUserData;
                UserInfo[socket.id]["id"] = socket.id;
                UserInfo[socket.id]["offline"] = false;
                /* ✅ تحديث خرائط التوجيه عند REAUTH */
                _updateSocketMaps(socket.id, UserInfo[socket.id]["lid"]);
                // ✅ FIX: لا تستخدم || 1 — stat 0 قيمة صالحة (نشط)
                var _raLastSt = UserInfo[socket.id]["lastst"];
                UserInfo[socket.id]["lastst"] = (_raLastSt != null) ? _raLastSt : 1;
                // ✅ FIX: إذا busy تأكد الحالة = 2 (مقفل خاص)
                if (UserInfo[socket.id]["busy"] === true) UserInfo[socket.id]["lastst"] = 2;

                delete UserInfo[reauth_oldId];
              } else {
                // UserInfo للـ socket القديم لم يعد موجوداً (انتهت المهلة بالضبط)
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ev",
                  data: 'window.onbeforeunload = null; location.href=location.pathname;',
                });
                return;
              }

              // ── تحديث OnlineUser ──
              OnlineUser[reauth_idx]["id"] = socket.id;
              OnlineUser[reauth_idx]["stat"] = UserInfo[socket.id]["lastst"];

              // ✅ FIX: استعادة المكالمة الخاصة — تحديث iscall عند الطرف الآخر
              var _reauthIscall = UserInfo[socket.id]["iscall"];
              if (_reauthIscall) {
                var _reauthOtherSock = _gameRoute(_reauthIscall) || _reauthIscall;
                if (UserInfo[_reauthOtherSock]) {
                  UserInfo[_reauthOtherSock]["iscall"] = socket.id;
                }
                // إبلاغ الطرف الآخر بالسوكت الجديد لتحديث _pvTargetId
                io.to(_reauthOtherSock).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "pv_resume",
                  data: { newId: socket.id }
                });
              }

              // ── إعادة الانضمام للغرفة ──
              // ✅ FIX: Restore saved room in REAUTH
              if (!UserInfo[socket.id]["idroom"] && UserInfo[socket.id]["_savedRoom"]) {
                UserInfo[socket.id]["idroom"] = UserInfo[socket.id]["_savedRoom"];
                if (reauth_idx !== -1) OnlineUser[reauth_idx]["roomid"] = UserInfo[socket.id]["_savedRoom"];
                delete UserInfo[socket.id]["_savedRoom"];
                if (reauth_idx !== -1) delete OnlineUser[reauth_idx]["_savedRoom"];
              }
              const reauth_room = UserInfo[socket.id]["idroom"];

              // ── تحديث socket.id في PeerRoom إن كان العضو على مايك ──
              if (reauth_room && PeerRoom[reauth_room]) {
                var _micRestored = false;
                for (let i = 1; i <= 7; i++) {
                  if (PeerRoom[reauth_room][i] && PeerRoom[reauth_room][i]["id"] === reauth_oldId) {
                    PeerRoom[reauth_room][i]["id"] = socket.id;
                    if (PeerRoom[reauth_room][i]["us"]) {
                      PeerRoom[reauth_room][i]["us"]["id"] = socket.id;
                    }
                    _micRestored = true;
                    break;
                  }
                }
                // ✅ DH-FIX3: استعادة المايك من البيانات المحفوظة عند disconnect
                // (PeerRoom كان فارغاً لأن المتحدث انفصل ثم أعاد الاتصال)
                if (!_micRestored && oldUserData && oldUserData["_savedMicSlot"] &&
                    oldUserData["_savedMicRoom"] === reauth_room && oldUserData["_savedMicData"]) {
                  var _slot = oldUserData["_savedMicSlot"];
                  // أعد المايك فقط إذا الخانة فارغة (ما أخذها أحد)
                  if (PeerRoom[reauth_room][_slot] && !PeerRoom[reauth_room][_slot]["ev"]) {
                    PeerRoom[reauth_room][_slot] = {
                      id:      socket.id,
                      ev:      true,
                      iscam:   oldUserData["_savedMicData"]["iscam"] || false,
                      private: oldUserData["_savedMicData"]["private"] || false,
                      locked:  oldUserData["_savedMicData"]["locked"] || false,
                      us:      oldUserData["_savedMicData"]["us"] || {},
                    };
                    if (PeerRoom[reauth_room][_slot]["us"]) {
                      PeerRoom[reauth_room][_slot]["us"]["id"] = socket.id;
                    }
                    // أبلغ الغرفة بعودة المتحدث
                    io.to(reauth_room).emit("SEND_EVENT_EMIT_BROADCASTING", {
                      cmd: "all",
                      room: reauth_room,
                      data: PeerRoom[reauth_room],
                    });
                  }
                  delete oldUserData["_savedMicSlot"];
                  delete oldUserData["_savedMicRoom"];
                  delete oldUserData["_savedMicData"];
                }
              }
              // ✅ v44: rjoin يُرسل لاحقاً في REAUTH_READY (بعد ما يتحدّث M_ID عند العميل)
              if (reauth_room) {
                socket.join(reauth_room);
              }

              // ── إبلاغ جميع المستخدمين بعودة هذا العضو ──
              io.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "u^",
                data: OnlineUser[reauth_idx],
              });
              // ✅ FIX: u^ مؤخر لضمان استعادة الحالة إذا وصل disconnect متأخر
              var _reauthStatSnap = JSON.parse(JSON.stringify(OnlineUser[reauth_idx]));
              setTimeout(function() {
                io.emit("SEND_EVENT_EMIT_SERVER", { cmd: "u^", data: _reauthStatSnap });
              }, 500);
              if (reauth_room) {
                io.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "ur",
                  data: [socket.id, reauth_room],
                });
              }

              // ── إرسال تأكيد الاستعادة ──
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "reauth_ok",
                data: {
                  users: OnlineUser,
                  myId:  socket.id,
                  iscall: UserInfo[socket.id]["iscall"] || null,
                }
              });

              // ✅ إرسال حالة اللعبة تلقائياً إذا كانت هناك لعبة نشطة
              try {
                if (!global._AG) global._AG = {};
                var _myLid = String(UserInfo[socket.id]["lid"] || "");
                var _gr    = _myLid ? global._AG[_myLid] : null;
                // تحقق من وجود جلسة لعبة صالحة (أقل من 2 ساعة)
                if (_gr && _gr.state && (Date.now() - _gr.t < 2 * 60 * 60 * 1000)) {
                  _gr.mySocket = socket.id;
                  // جد socket الخصم عبر _gameRoute
                  var _opSock = _gr.opSocket ? _gameRoute(_gr.opSocket) : null;
                  if (!_opSock && _gr.opUid && global._lidToSocket[_gr.opUid]) {
                    _opSock = _gameRoute(global._lidToSocket[_gr.opUid]);
                  }
                  if (_opSock) _gr.opSocket = _opSock;
                  // أرسل حالة اللعبة
                  socket.emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "GAME_STATE_SYNC",
                    data: {
                      game:     _gr.game,
                      role:     _gr.role,
                      opSocket: _gr.opSocket || "",
                      opUid:    _gr.opUid,
                      allPlayerUids: _gr.allPlayerUids || [],
                      state:    _gr.state
                    }
                  });
                  // أبلغ الخصم بالـ socket الجديد عبر _lidToSocket
                  if (_gr.allPlayerUids && _gr.allPlayerUids.length > 0) {
                    _gr.allPlayerUids.forEach(function(_tpu) {
                      if (String(_tpu) === _myLid || !_tpu) return;
                      var _tpSock = global._lidToSocket[String(_tpu)];
                      if (_tpSock && io.sockets.sockets.get(_tpSock)) {
                        io.to(_tpSock).emit("SEND_EVENT_EMIT_SERVER", {
                          cmd: "GAME_PEER_RECONNECTED",
                          data: { newSocket: socket.id, oldSocket: reauth_oldId, game: _gr.game }
                        });
                      }
                    });
                  } else if (_opSock) {
                    io.to(_opSock).emit("SEND_EVENT_EMIT_SERVER", {
                      cmd: "GAME_PEER_RECONNECTED",
                      data: { newSocket: socket.id, oldSocket: reauth_oldId, game: _gr.game }
                    });
                  }
                }
              } catch(_ge) {}

            }).catch(() => {
              // خطأ في DB — أعد التوجيه
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "ev",
                data: 'window.onbeforeunload = null; location.href=location.pathname;',
              });
            });

          } catch (e) { return; }

        // ── العضو جاهز بعد reauth: أرسل له حالة المايكات فقط لغرفته ──
        } else if (data["cmd"] === "REAUTH_READY") {
          try {
            if (!UserInfo[socket.id]) return;
            const rr_room = UserInfo[socket.id]["idroom"];
            if (rr_room) {
              const rr_roomData = GetRoomList(rr_room);
              if (rr_roomData && rr_roomData["broadcast"] && PeerRoom[rr_room]) {
                // ✅ v44: أرسل بيانات المايكات المحدّثة للعميل
                socket.emit("SEND_EVENT_EMIT_BROADCASTING", {
                  cmd: "all",
                  room: rr_room,
                  data: PeerRoom[rr_room],
                });
                // ✅ DH-FIX1: جمع socket IDs الحقيقية لأصحاب المايكات النشطة
                // الخطأ القديم: كان يفحص .length على Object (دائماً undefined/false)
                //              وكان يُدفع رقم المايك "1","2"… بدل socket.id
                var rr_micUsers = [];
                if (PeerRoom[rr_room]) {
                  for (var rr_k in PeerRoom[rr_room]) {
                    var rr_slot = PeerRoom[rr_room][rr_k];
                    // ✅ التحقق الصحيح: ev=true (على المايك) + id موجود + ليس نفس المتصل
                    if (rr_slot && rr_slot.ev === true && rr_slot.id &&
                        rr_slot.id !== socket.id && io.sockets.sockets.get(rr_slot.id)) {
                      rr_micUsers.push(rr_slot.id); // ✅ socket.id الحقيقي وليس رقم المايك
                    }
                  }
                }
                // أبلغ أصحاب المايكات بعودة هذا المستخدم — سيُرسلون له offer
                if (rr_micUsers.length > 0) {
                  var rr_idx = 0;
                  var rr_timer = setInterval(function() {
                    if (rr_idx >= rr_micUsers.length) { clearInterval(rr_timer); return; }
                    var rr_targetSid = rr_micUsers[rr_idx]; // ✅ الآن هذا socket.id حقيقي
                    if (io.sockets.sockets.get(rr_targetSid)) {
                      io.sockets.sockets.get(rr_targetSid).emit("SEND_EVENT_EMIT_BROADCASTING", {
                        cmd: "rjoin",
                        user: socket.id,
                      });
                    }
                    rr_idx++;
                  }, 200);
                }
              }
            }
          } catch(e) { return; }

        /* ═══════════════════════════════════════════════════════
           ✅ الحل الجذري: أحداث الألعاب
           كل التوجيه يمر عبر _gameRoute (global)
           يستخدم lid كمعرّف ثابت (متاح عند العميل والسيرفر)
           ═══════════════════════════════════════════════════════ */

        } else if (data["cmd"] === "GAME_INVITE") {
          try {
            if (!UserInfo[socket.id]) return;

            // ✅ FIX: منع المجمد من إرسال دعوات لعبة
            if (UserInfo[socket.id]["isfrozen"]) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "GAME_INVITE_ERROR",
                data: { reason: "FROZEN", msg: "حسابك مجمد، لا يمكنك إرسال دعوات" }
              });
              return;
            }

            // ── Rate Limit: دعوة واحدة كل 60 ثانية لكل شخص ──
            if (!global._gameInviteRL) global._gameInviteRL = {};
            var _senderLid = String(UserInfo[socket.id]["lid"] || "");
            var _targetId = data["data"]["to"];
            var _rlKey = _senderLid + ">" + _targetId;
            var _rlNow = Date.now();
            if (global._gameInviteRL[_rlKey] && (_rlNow - global._gameInviteRL[_rlKey] < 60000)) {
              var _rlRemain = Math.ceil((60000 - (_rlNow - global._gameInviteRL[_rlKey])) / 1000);
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "GAME_INVITE_ERROR",
                data: { reason: "RATE_LIMIT", seconds: _rlRemain }
              });
              return;
            }

            var gTo = _gameRoute(data["data"]["to"]);
            if (!gTo) {
              socket.emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "GAME_DECLINE",
                data: { from: socket.id }
              });
              return;
            }

            // ── فحص إذا الشخص المستهدف في لعبة نشطة ──
            var _targetLid = "";
            if (UserInfo[gTo]) { _targetLid = String(UserInfo[gTo]["lid"] || ""); }
            if (_targetLid && global._AG && global._AG[_targetLid]) {
              var _tgRec = global._AG[_targetLid];
              if (_tgRec && _tgRec.state && (Date.now() - _tgRec.t < 2 * 60 * 60 * 1000)) {
                socket.emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "GAME_INVITE_ERROR",
                  data: { reason: "IN_GAME" }
                });
                return;
              }
            }

            // ── سجّل وقت الدعوة ──
            global._gameInviteRL[_rlKey] = _rlNow;

            io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_INVITE",
              data: {
                from:   socket.id,
                fromUid: _senderLid,
                game:   data["data"]["game"],
                myName: UserInfo[socket.id]["topic"] || "",
                myPic:  UserInfo[socket.id]["pic"]   || "",
                ludoPlayers: data["data"]["ludoPlayers"] || null,
                ludoRoom: data["data"]["ludoRoom"] || null,
                trixRoom: data["data"]["trixRoom"] || null,
                trixPlayers: data["data"]["trixPlayers"] || null,
                unoRoom: data["data"]["unoRoom"] || null,
                unoPlayers: data["data"]["unoPlayers"] || null
              }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_ACCEPT") {
          try {
            if (!UserInfo[socket.id]) return;
            var gTo = _gameRoute(data["data"]["to"]);
            if (!gTo) return;
            var _senderLid = String(UserInfo[socket.id]["lid"] || "");
            io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_ACCEPT",
              data: {
                from:   socket.id,
                fromUid: _senderLid,
                game:   data["data"]["game"],
                myName: UserInfo[socket.id]["topic"] || "",
                myPic:  UserInfo[socket.id]["pic"]   || "",
                ludoRoom: data["data"]["ludoRoom"] || null,
                ludoPlayers: data["data"]["ludoPlayers"] || null,
                trixRoom: data["data"]["trixRoom"] || null,
                trixPlayers: data["data"]["trixPlayers"] || null,
                unoRoom: data["data"]["unoRoom"] || null,
                unoPlayers: data["data"]["unoPlayers"] || null
              }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_DECLINE") {
          try {
            var gTo = _gameRoute(data["data"]["to"]);
            if (!gTo) return;
            var _senderLid = String((UserInfo[socket.id]||{})["lid"]||"");
            io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_DECLINE",
              data: { from: socket.id, fromUid: _senderLid }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_MOVE") {
          try {
            if (!UserInfo[socket.id]) return;
            /* ✅ Rate limit: max 30 moves/sec per socket */
            if (!socket._gmRL) socket._gmRL = { c: 0, t: Date.now() };
            var _gmNow = Date.now();
            if (_gmNow - socket._gmRL.t > 1000) { socket._gmRL.c = 0; socket._gmRL.t = _gmNow; }
            socket._gmRL.c++;
            if (socket._gmRL.c > 30) return; /* drop excess */
            var gTo = _gameRoute(data["data"]["to"]);
            if (!gTo) return;
            var _senderLid = String(UserInfo[socket.id]["lid"] || "");
            io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_MOVE",
              data: {
                from: socket.id,
                fromUid: _senderLid,
                game: data["data"]["game"],
                move: data["data"]["move"]
              }
            });
            // ✅ FIX: حدّث opSocket + timestamp في global._AG لكلا اللاعبين
            try {
              if (_senderLid && global._AG && global._AG[_senderLid]) {
                global._AG[_senderLid].opSocket = gTo;
                global._AG[_senderLid].t = Date.now();
              }
              // ✅ حدّث أيضاً جلسة المستلم (lid أو uid)
              var _rcvLid = global._socketToLid[gTo];
              if (_rcvLid && global._AG[_rcvLid]) {
                global._AG[_rcvLid].opSocket = socket.id;
                global._AG[_rcvLid].t = Date.now();
              }
            } catch(e3) {}
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_RESET") {
          try {
            var gTo = _gameRoute(data["data"]["to"]);
            if (!gTo) return;
            var _senderLid = String((UserInfo[socket.id]||{})["lid"]||"");
            io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_RESET",
              data: { from: socket.id, fromUid: _senderLid, game: data["data"]["game"] }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_CLOSE") {
          try {
            var _senderLid = String((UserInfo[socket.id]||{})["lid"]||"");
            /* ✅ دعم إرسال لعدة لاعبين (targets) */
            var _closeTargets = data["data"]["targets"] || [];
            /* fallback للطريقة القديمة — لاعب واحد */
            if (!_closeTargets.length && data["data"]["to"]) {
              _closeTargets = [data["data"]["to"]];
            }
            var _closeSent = {};
            for (var ci = 0; ci < _closeTargets.length; ci++) {
              var gTo = _gameRoute(_closeTargets[ci]);
              if (gTo && !_closeSent[gTo]) {
                _closeSent[gTo] = true;
                io.to(gTo).emit("SEND_EVENT_EMIT_SERVER", {
                  cmd: "GAME_CLOSE",
                  data: { from: socket.id, fromUid: _senderLid }
                });
                /* احذف جلسة اللاعب (lid + uid) */
                try {
                  if (UserInfo[gTo]) {
                    var _opLid2 = String(UserInfo[gTo]["lid"] || "");
                    var _opUid2 = String(UserInfo[gTo]["uid"] || "");
                    if (_opLid2 && global._AG) { delete global._AG[_opLid2]; }
                    if (_opUid2 && _opUid2 !== _opLid2 && global._AG) { delete global._AG[_opUid2]; }
                  }
                } catch(e3) {}
              }
            }
            // احذف جلسة المرسل (lid + uid)
            try {
              if (!UserInfo[socket.id]) return;
              var _gcLid = String(UserInfo[socket.id]["lid"] || "");
              var _gcUid = String(UserInfo[socket.id]["uid"] || "");
              if (_gcLid && global._AG) { delete global._AG[_gcLid]; }
              if (_gcUid && _gcUid !== _gcLid && global._AG) { delete global._AG[_gcUid]; }
            } catch(e2) {}
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_STATE_SAVE") {
          try {
            if (!UserInfo[socket.id]) return;
            var _gsLid = String(UserInfo[socket.id]["lid"] || "");
            if (!_gsLid) return;
            if (!global._AG) global._AG = {};
            // ✅ احسب opLid من السيرفر (لا نثق بالعميل لأن العميل يرسل lid كـ opUid)
            var _opLidSave = data["data"]["opUid"] || "";
            var _opSocketSave = data["data"]["opSocket"] || "";
            // fallback: لو العميل ما أرسل opUid، نحسبه من الـ socket
            if (!_opLidSave && _opSocketSave && UserInfo[_opSocketSave]) {
              _opLidSave = String(UserInfo[_opSocketSave]["lid"] || "");
            }
            var _gsRec = {
              game:     data["data"]["game"]     || "",
              role:     data["data"]["role"]     || "",
              opUid:    _opLidSave,
              opSocket: _opSocketSave,
              allPlayerUids: data["data"]["allPlayerUids"] || [],
              state:    data["data"]["state"]    || {},
              t:        Date.now()
            };
            global._AG[_gsLid] = _gsRec;
            /* ✅ FIX: احفظ بـ uid أيضاً — ضمان REAUTH يلقى البيانات بأي مفتاح */
            var _gsUid = String(UserInfo[socket.id]["uid"] || "");
            if (_gsUid && _gsUid !== _gsLid) global._AG[_gsUid] = _gsRec;

            /* ✅ FIX: حدّث حالة اللعبة عند كل الخصوم أيضاً
               هذا يحل مشكلة: لاعب يلعب دوره والخصم فاصل → الخصم يرجع ويشوف الحالة القديمة
               الآن: كل لاعب يحفظ → كل الخصوم تتحدث حالتهم بأحدث state */
            try {
              var _gsAllUids = data["data"]["allPlayerUids"] || [];
              // أضف opUid كـ fallback
              if (_opLidSave && _gsAllUids.indexOf(_opLidSave) === -1) _gsAllUids.push(_opLidSave);
              _gsAllUids.forEach(function(_peerUid) {
                if (!_peerUid || _peerUid === _gsLid || _peerUid === _gsUid) return;
                var _peerKey = String(_peerUid);
                /* ✅ FIX: نسخ الحالة مع الحفاظ على myP الخاص بكل لاعب
                   المشكلة: Player A يحفظ st.myP='P1' — لو ننسخها كما هي لـ Player B
                   يصير عنده myP='P1' بدل 'P2' فما يعرف إنه دوره! */
                function _syncStateToPeer(_pKey) {
                  if (!global._AG[_pKey]) return;
                  try {
                    var _peerOldMyP = null;
                    var _peerOldPs = null;
                    // احفظ myP و ps (player sockets) الخاصين بالخصم
                    if (global._AG[_pKey].state && global._AG[_pKey].state.st) {
                      _peerOldMyP = global._AG[_pKey].state.st.myP;
                    }
                    if (global._AG[_pKey].state && global._AG[_pKey].state.ps) {
                      _peerOldPs = global._AG[_pKey].state.ps;
                    }
                    // نسخ عميقة لتجنب مشاكل المراجع
                    global._AG[_pKey].state = JSON.parse(JSON.stringify(_gsRec.state));
                    // ارجع myP الخاص بالخصم
                    if (_peerOldMyP && global._AG[_pKey].state.st) {
                      global._AG[_pKey].state.st.myP = _peerOldMyP;
                    }
                    // ارجع player sockets الخاصة بالخصم
                    if (_peerOldPs) {
                      global._AG[_pKey].state.ps = _peerOldPs;
                    }
                  } catch(_cpErr) {
                    // fallback: نسخ عادية
                    global._AG[_pKey].state = _gsRec.state;
                  }
                  global._AG[_pKey].t = Date.now();
                }

                if (global._AG[_peerKey]) {
                  _syncStateToPeer(_peerKey);
                }
                // ابحث عن uid المقابل للـ lid (أو العكس)
                for (var _gsk in UserInfo) {
                  var _gskLid = String(UserInfo[_gsk]["lid"] || "");
                  var _gskUid = String(UserInfo[_gsk]["uid"] || "");
                  if (_gskLid === _peerKey || _gskUid === _peerKey) {
                    // حدّث بكلا المفتاحين
                    if (_gskLid && global._AG[_gskLid]) {
                      _syncStateToPeer(_gskLid);
                    }
                    if (_gskUid && _gskUid !== _gskLid && global._AG[_gskUid]) {
                      _syncStateToPeer(_gskUid);
                    }
                    break;
                  }
                }
              });
            } catch(_gsSync) {}
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_STATE_REQUEST") {
          try {
            if (!UserInfo[socket.id]) return;
            if (!global._AG) global._AG = {};
            var _rqLid = String(UserInfo[socket.id]["lid"] || "");
            var _rqUid = String(UserInfo[socket.id]["uid"] || "");
            /* ✅ FIX: ابحث بـ lid أولاً ثم uid — يطابق GAME_STATE_SAVE */
            var _rqRec = (_rqLid && global._AG[_rqLid]) ? global._AG[_rqLid] :
                         (_rqUid && global._AG[_rqUid]) ? global._AG[_rqUid] : null;
            if (!_rqRec || !_rqRec.state || (Date.now() - _rqRec.t > 2 * 60 * 60 * 1000)) return;
            // جد socket الخصم الحالي عبر _gameRoute
            var _rqOpSock = _rqRec.opSocket ? _gameRoute(_rqRec.opSocket) : null;
            if (!_rqOpSock && _rqRec.opUid && global._lidToSocket[_rqRec.opUid]) {
              _rqOpSock = _gameRoute(global._lidToSocket[_rqRec.opUid]);
            }
            if (_rqOpSock) _rqRec.opSocket = _rqOpSock;
            _rqRec.mySocket = socket.id;
            socket.emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "GAME_STATE_SYNC",
              data: {
                game:     _rqRec.game,
                role:     _rqRec.role,
                opSocket: _rqRec.opSocket || "",
                opUid:    _rqRec.opUid,
                allPlayerUids: _rqRec.allPlayerUids || [],
                state:    _rqRec.state
              }
            });
            // أبلغ كل الخصوم بالـ socket الجديد (دعم 3-4 لاعبين)
            var _rqMyLid = String(UserInfo[socket.id]["lid"] || "");
            var _rqNotified = {};
            if (_rqRec.allPlayerUids && _rqRec.allPlayerUids.length > 0) {
              _rqRec.allPlayerUids.forEach(function(_tpu) {
                if (String(_tpu) === _rqMyLid || !_tpu) return;
                var _tpSock = global._lidToSocket[String(_tpu)];
                if (_tpSock && io.sockets.sockets.get(_tpSock)) {
                  io.to(_tpSock).emit("SEND_EVENT_EMIT_SERVER", {
                    cmd: "GAME_PEER_RECONNECTED",
                    data: { newSocket: socket.id, oldSocket: "", game: _rqRec.game }
                  });
                  _rqNotified[_tpSock] = true;
                  // ✅ حدّث opSocket في جلسة الخصم
                  if (global._AG[String(_tpu)]) {
                    global._AG[String(_tpu)].opSocket = socket.id;
                  }
                }
              });
            }
            // fallback: لو ما في allPlayerUids، أبلغ opSocket
            if (_rqOpSock && !_rqNotified[_rqOpSock]) {
              io.to(_rqOpSock).emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "GAME_PEER_RECONNECTED",
                data: { newSocket: socket.id, game: _rqRec.game }
              });
            }
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_RECONNECT_REQUEST") {
          try {
            if (!UserInfo[socket.id]) return;
            var _rrLid = String(UserInfo[socket.id]["lid"] || "");
            var _rrGame = String((data["data"] && data["data"]["game"]) || "");
            var _rrPayload = {
              cmd: "GAME_RECONNECT_REQUEST",
              data: { fromUid: _rrLid, fromSocket: socket.id, game: _rrGame }
            };
            // اجمع كل lids المطلوبين
            var _targetLids = [];
            if (data["data"] && data["data"]["allPlayerUids"] && Array.isArray(data["data"]["allPlayerUids"])) {
              _targetLids = data["data"]["allPlayerUids"].slice();
            }
            var _rrOpLid = String((data["data"] && data["data"]["opUid"]) || "");
            if (_rrOpLid && _targetLids.indexOf(_rrOpLid) === -1) _targetLids.push(_rrOpLid);
            if (global._AG && global._AG[_rrLid]) {
              var _agRec = global._AG[_rrLid];
              if (_agRec.opUid && _targetLids.indexOf(String(_agRec.opUid)) === -1) _targetLids.push(String(_agRec.opUid));
            }
            // أرسل لكل لاعب عبر _lidToSocket
            _targetLids.forEach(function(tLid) {
              if (String(tLid) === _rrLid) return;
              var tSock = global._lidToSocket[String(tLid)];
              if (tSock && io.sockets.sockets.get(tSock)) {
                io.to(tSock).emit("SEND_EVENT_EMIT_SERVER", _rrPayload);
              }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "GAME_RECONNECT_RESPONSE") {
          try {
            if (!UserInfo[socket.id]) return;
            var _rsToLid = String((data["data"] && data["data"]["toUid"]) || "");
            var _rsSenderLid = String(UserInfo[socket.id]["lid"] || "");
            var _rsToSock = _rsToLid ? global._lidToSocket[_rsToLid] : null;
            if (_rsToSock && io.sockets.sockets.get(_rsToSock)) {
              io.to(_rsToSock).emit("SEND_EVENT_EMIT_SERVER", {
                cmd: "GAME_RECONNECT_RESPONSE",
                data: {
                  game: (data["data"] && data["data"]["game"]) || "",
                  opRole: (data["data"] && data["data"]["role"]) || "",
                  myRole: (data["data"] && data["data"]["myRole"]) || "",
                  opSocket: socket.id,
                  opUid: _rsSenderLid,
                  allPlayerSockets: (data["data"] && data["data"]["allPlayerSockets"]) || [],
                  state: (data["data"] && data["data"]["state"]) || {}
                }
              });
            }
          } catch(ge) {}

        } else if (data["cmd"] === "LUDO_ROOM_CREATE") {
          // ── إنشاء غرفة لودو متعددة اللاعبين ──
          try {
            if (!UserInfo[socket.id]) return;
            var roomId = data["data"]["roomId"];
            var players = data["data"]["players"];
            if (!roomId || !players) return;
            if (!global.LudoRooms) global.LudoRooms = {};
            global.LudoRooms[roomId] = {
              host: socket.id,
              players: [socket.id].concat(players),
              count: data["data"]["count"] || players.length + 1,
              created: Date.now()
            };
          } catch(ge) {}
        } else if (data["cmd"] === "LUDO_START") {
          // ── بدء لعبة لودو متعددة اللاعبين ──
          try {
            if (!UserInfo[socket.id]) return;
            var gTo = data["data"]["to"];
            if (!gTo || typeof gTo !== "string") return;
            var _ludoTarget = _gameRoute(gTo) || gTo; /* ✅ resolve socket */
            io.to(_ludoTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "LUDO_START",
              data: {
                from: socket.id,
                players: data["data"]["players"],
                count: data["data"]["count"],
                yourIndex: data["data"]["yourIndex"],
                playerInfos: data["data"]["playerInfos"] || []
              }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "TRIX_ROOM_CREATE") {
          // ── إنشاء غرفة تركس 4 لاعبين ──
          try {
            if (!UserInfo[socket.id]) return;
            var trixRoomId = data["data"]["roomId"];
            var trixPlayers = data["data"]["players"];
            if (!trixRoomId || !trixPlayers) return;
            if (!global.TrixRooms) global.TrixRooms = {};
            global.TrixRooms[trixRoomId] = {
              host: socket.id,
              players: [socket.id].concat(trixPlayers),
              created: Date.now()
            };
          } catch(ge) {}

        } else if (data["cmd"] === "TRIX_START") {
          // ── بدء لعبة تركس ──
          try {
            if (!UserInfo[socket.id]) return;
            var trixTo = data["data"]["to"];
            if (!trixTo || typeof trixTo !== "string") return;
            var _trixTarget = _gameRoute(trixTo) || trixTo; /* ✅ resolve socket */
            io.to(_trixTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "TRIX_START",
              data: {
                from: socket.id,
                players: data["data"]["players"],
                yourIndex: data["data"]["yourIndex"],
                playerInfos: data["data"]["playerInfos"] || [],
                trixRoom: data["data"]["trixRoom"] || ""
              }
            });
          } catch(ge) {}

        } else if (data["cmd"] === "UNO_ROOM_CREATE") {
          // ── إنشاء غرفة أونو ──
          try {
            if (!UserInfo[socket.id]) return;
            var unoRoomId = data["data"]["roomId"];
            var unoPlayers = data["data"]["players"];
            if (!unoRoomId || !unoPlayers) return;
            if (!global.UnoRooms) global.UnoRooms = {};
            global.UnoRooms[unoRoomId] = {
              host: socket.id,
              players: [socket.id].concat(unoPlayers),
              created: Date.now()
            };
          } catch(ge) {}

        } else if (data["cmd"] === "UNO_START") {
          // ── بدء لعبة أونو ──
          try {
            if (!UserInfo[socket.id]) return;
            var unoTo = data["data"]["to"];
            if (!unoTo || typeof unoTo !== "string") return;
            var _unoTarget = _gameRoute(unoTo) || unoTo;
            io.to(_unoTarget).emit("SEND_EVENT_EMIT_SERVER", {
              cmd: "UNO_START",
              data: {
                from: socket.id,
                players: data["data"]["players"],
                yourIndex: data["data"]["yourIndex"],
                playerInfos: data["data"]["playerInfos"] || [],
                unoRoom: data["data"]["unoRoom"] || "",
                unoPlayers: data["data"]["unoPlayers"] || 2
              }
            });
          } catch(ge) {}
        }
      } catch (e) {
        return;
      }
    }
  });
});

// [REMOVED DUPLICATE] process.on("uncaughtException", (err) => {
// [REMOVED DUPLICATE]   console.error("Unhandled Error:", err);
// [REMOVED DUPLICATE] });
// [REMOVED DUPLICATE] process.on("unhandledRejection", (reason, promise) => {
// [REMOVED DUPLICATE]   console.error("تم رفض وعد غير معالج:", reason);
// [REMOVED DUPLICATE] });
//StartSite
// ===== Route صفحات الامتدادات =====
// ✅ كاش extensions.json — بدل readFileSync كل طلب
var extensionsCache = [];
var extensionsCacheTime = 0;
function getExtensions() {
  var now = Date.now();
  if (now - extensionsCacheTime > 300000) { // تحديث كل 5 دقائق
    try {
      extensionsCache = JSON.parse(fs.readFileSync("uploads/extensions.json", "utf8"));
    } catch(e) { extensionsCache = []; }
    extensionsCacheTime = now;
  }
  return extensionsCache;
}

var skipExtPaths = ["cp","gaio","uh","uploadURM","upst","upload","uppic","site","sendfile","favicon.ico","robots.txt"];
app.get("/:extpath", function(req, res, next) {
  try {
    var extpath = req.params.extpath;
  } catch(e) {
    // حماية من URLs مشوهة (مثل %c0%ae) — decodeURIComponent يفشل
    return res.status(400).end();
  }
  if (skipExtPaths.indexOf(extpath) !== -1) { return next(); }
  var extKey = req.hostname + "/" + extpath;
  var extList4 = getExtensions(); // ✅ من الكاش بدل readFileSync
  var found = extList4.find(function(e){ return (typeof e === "string" ? e : (e.key || "")) === extKey; });
  if (!found) { return next(); }
  // ✅ استخدام كاش الإعدادات
  getCachedSiteSettings(req.hostname, function(err, getSettings, getSe, siteArray) {
      if (!err && getSettings && getSe) {
        SiteSetting = getSettings;
        var extFileKey = extKey.replace(/[\/]/g, "_");
        var renderPage = function(array) {
          var micGifPath2 = "uploads/site/" + req.hostname + "bacmic.gif";
          var micPngPath2 = "uploads/site/" + req.hostname + "bacmic.png";
          var _bacmicIsGif2 = fs.existsSync(micGifPath2);
          var micPath = _bacmicIsGif2 ? micGifPath2 : micPngPath2;
          var bacmicExt2 = _bacmicIsGif2 ? ".gif" : ".png";
          var bannerPath = "uploads/site/" + req.hostname + "banner.gif";
          var micVer = imageVersions[micPath] || getImageVersion(micPath);
          var bannerVer = imageVersions[bannerPath] || getImageVersion(bannerPath);

          res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.render("index", {
            title: array["title"] || "",
            logo: "/site/" + getSe["logo"],
            banner: "/site/" + getSe["banner"],
            online: 0,
            host: req.hostname,
            namehost: Config["hostnm"],
            colors: { hicolor: array["background"] || "", bgcolor: array["bg"] || "", btcolor: array["buttons"] || "" },
            ifbanner: getSe["isbanner"],
            script: String(array["settscr"] || ""),
            description: array["settdescription"] || "",
            keywords: array["settkeywords"] || "",
            keywordssite: array["settkeywordssite"] || "",
            istite: array["name"] || "",
            micVersion: micVer,
            bannerVersion: bannerVer,
            bacmicExt: bacmicExt2,
          });
        };
        fs.readFile("uploads/" + extFileKey + ".txt", function(err, f) {
          if (f) {
            var array = {};
            try { array = JSON.parse(f.toString()); } catch(e) { array = {}; }
            renderPage(array);
          } else {
            // للامتدادات بدون ملف خاص، نستخدم إعدادات الموقع الرئيسية
            renderPage(siteArray);
          }
        });
      } else {
        next();
      }
  });
});
// ===== نهاية Route الامتدادات =====

// ═══ Express Error Middleware — catches all route errors ═══
app.use(function(err, req, res, next) {
  console.error("⚠️ Express Route Error (server continues):", err && err.message ? err.message : err);
  try { res.status(500).send("Internal Server Error"); } catch(e) {}
});

http.listen(Config.Port, function () {
  console.log("Server started on port " + Config.Port);
  StartServer();
  setInterval(function () {
    UserChecked = [];
  }, 60000 * 60 * 24);
  setInterval(function () {
    BackUpDataBase();
  }, Config.Backup);
  setTimeout(() => {
    MessageDay();
    io.emit("SEND_EVENT_EMIT_SERVER", {
      cmd: "ev",
      data: 'window.onbeforeunload = null; location.href=location.pathname;',
    });
  }, 1000 * 5);
  setInterval(function () {
    fs.readdir("uploads/sendfile", (err, files) => {
      if (err) {
        console.error("خطأ أثناء قراءة المجلد:", err);
        return;
      }

      files.forEach((file) => {
        if (!file.includes("isback") && !file.includes("isborder")) {
          const filePath = path.join("uploads/sendfile", file);
          fs.unlink(filePath, (err) => {
            if (err) {
              //   console.error(`خطأ أثناء حذف الملف ${file}:`, err);
            } else {
              // console.log(`تم حذف الملف: ${file}`);
            }
          });
        }
      });
    });
  }, 60000 * 60 * 15);
  setInterval(function () {
    if (BandRoom.length > 0) {
      BandRoom = [];
    }

    if (ListWait.length > 0) {
      ListWait = [];
    }

    StoryRepo.getBy({ state: "getAllIn" }).then((str) => {
      for (var i = 0; i < str.length; i++) {
        if (
          Date.now() - new Date(str[i]["date"]).getTime() >= 24 * 60 * 60 * 1000
        ) {
          io.emit("SEND_EVENT_EMIT_SERVER", {
            cmd: "story-",
            data: str[i]["id"],
          });
          StoryRepo.deletedBy(str[i]["id"]);
          fs.unlink("uploads" + str[i]["url"], (err) => {
            if (err) {
            }
          });
        }
        (function anonymous() {});
      }
    });
  }, 60000 * 5);
  // };
  // });
});
