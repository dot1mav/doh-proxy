//
// Arvan Edge DoH Frontend → Cloudflare Worker
//
// What this does:
// - Serves a dashboard UI in Persian (فارسی) on the root path using Bulma CSS
// - Acts as a DoH proxy on /dns-query, forwarding queries to your Cloudflare Worker
// - Provides health checks on /healthz to monitor the tunnel to Cloudflare
// - Shows latency metrics and a nice dashboard with live test capabilities
//
// Setup:
// Replace CLOUDFLARE_WORKER_BASE with your actual Cloudflare Worker URL
// You can also set this via build-time environment substitution before deploying

const CLOUDFLARE_WORKER_BASE = "https://your-cloudflare-worker.example";
const CLOUDFLARE_DOH_URL = CLOUDFLARE_WORKER_BASE + "/dns-query";
const CLOUDFLARE_HEALTH_URL = CLOUDFLARE_WORKER_BASE + "/healthz";

// ---- Logging Configuration ----
// Control whether to log debug messages. Useful for troubleshooting.
const DEFAULT_ENABLE_LOGGING = false;

function isLoggingEnabled() {
  // Check if ENABLE_LOGGING is set as a string or boolean
  if (typeof ENABLE_LOGGING === "string") {
    const v = ENABLE_LOGGING.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  if (typeof ENABLE_LOGGING === "boolean") return ENABLE_LOGGING;
  return DEFAULT_ENABLE_LOGGING;
}

function log(...args) {
  if (isLoggingEnabled()) console.log("[ARVAN]", ...args);
}

function logError(...args) {
  if (isLoggingEnabled()) console.error("[ARVAN]", ...args);
}

// ---- Request Handler ----
// Entry point for all incoming requests from Arvan Edge

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  log(method, path + url.search);

  // Handle CORS preflight requests
  if (method === "OPTIONS") return makeCorsPreflightResponse();

  // Route requests to appropriate handlers
  if (path === "/" || path === "") return serveHomePage(url);
  if (path === "/dns-query") return handleDoHProxy(request, url);
  if (path === "/healthz") return handleHealthz();

  return new Response("یافت نشد", {
    status: 404,
    headers: buildCorsHeaders(),
  });
}

// ---- DoH Proxy: Arvan → Cloudflare Worker ----
// Forward DNS-over-HTTPS queries from clients to the Cloudflare Worker backend
// Supports both GET (dns param) and POST (binary body) methods

async function handleDoHProxy(request, url) {
  const method = request.method.toUpperCase();
  const upstreamUrl = new URL(CLOUDFLARE_DOH_URL);
  const headersForUpstream = {
    Accept: "application/dns-message",
  };
  let body = null;

  // GET method: dns parameter in query string
  if (method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (!dnsParam) {
      return new Response("پارامتر dns ارسال نشده است.", {
        status: 400,
        headers: buildCorsHeaders(),
      });
    }
    upstreamUrl.searchParams.set("dns", dnsParam);
  }
  // POST method: binary DNS message in request body
  else if (method === "POST") {
    body = await request.arrayBuffer();
    headersForUpstream["Content-Type"] = "application/dns-message";
  } else {
    return new Response("Method not allowed", {
      status: 405,
      headers: buildCorsHeaders(),
    });
  }

  log("Forwarding DoH to Cloudflare Worker:", upstreamUrl.toString());

  try {
    // Measure round-trip time to the upstream Worker
    const start = Date.now();
    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method,
      headers: headersForUpstream,
      body,
    });
    const latency = Date.now() - start;
    log("Cloudflare Worker responded in", latency + "ms");

    const respHeaders = new Headers();
    respHeaders.set("Content-Type", "application/dns-message");
    const corsHeaders = buildCorsHeaders();
    for (const [k, v] of corsHeaders.entries()) {
      respHeaders.set(k, v);
    }
    respHeaders.set("X-DoH-Proxy", "Arvan-Edge");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    logError("خطا در اتصال به Cloudflare Worker:", err);
    return new Response("خطا در اتصال به Cloudflare Worker: " + String(err), {
      status: 502,
      headers: buildCorsHeaders(),
    });
  }
}

// ---- Health Check: Arvan → Cloudflare /healthz ----
// Verify that the tunnel to Cloudflare is working and measure latency
// Returns status, latency measurements, and Cloudflare's health response

async function handleHealthz() {
  const start = Date.now();
  try {
    const res = await fetch(CLOUDFLARE_HEALTH_URL, {
      headers: { Accept: "application/json" },
    });
    const edgeLatency = Date.now() - start;

    // Parse Cloudflare's health response (may not always be JSON)
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    // Build response payload with latency metrics
    const payload = typeof data === "object" && data !== null ? data : {};
    payload.edge_latency_ms = edgeLatency;
    payload.arvan_checked_at = new Date().toISOString();

    if (!payload.status) {
      payload.status = res.ok ? "ok" : "degraded";
    }
    if (!payload.message) {
      payload.message = res.ok
        ? "Cloudflare /healthz قابل دسترس است."
        : "پاسخ غیرموفق از Cloudflare /healthz";
    }

    return json(payload, res.ok ? 200 : res.status || 502);
  } catch (err) {
    logError("Health check to Cloudflare /healthz failed:", err);
    return json(
      {
        status: "error",
        message: "خطا در اتصال به Cloudflare /healthz: " + String(err),
        edge_latency_ms: null,
        arvan_checked_at: new Date().toISOString(),
      },
      502
    );
  }
}

// ---- Helper Functions ----

function buildCorsHeaders() {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return headers;
}

function makeCorsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ---- Dashboard UI (Persian + Bulma) ----
// Serves an interactive dashboard where users can:
// - Monitor tunnel health and latency in real-time
// - Test DoH queries (GET and POST methods)
// - View response metrics and byte previews

function serveHomePage(url) {
  const origin = url.origin;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <title>پروکسی DNS-over-HTTPS روی آروان → Cloudflare</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Bulma CSS Framework: provides responsive grid, components, and dark mode support -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css"
  />

  <!-- Vazirmatn Font: clean, modern font that works well with both Persian and Latin text -->
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap"
  />

  <style>
    /* Force dark color scheme in browsers that support it */
    :root {
      color-scheme: dark;
    }

    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
    }

    /* Main body: dark gradient background with Persian text direction */
    body {
      font-family: "Vazirmatn", system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #020617 0, #020617 40%, #020617 100%);
      color: #e5e7eb;
      direction: rtl;
    }

    /* Page section takes full viewport height and centers content vertically (desktop) */
    .page-section {
      min-height: 100vh;
      padding: 1.5rem 0.75rem;
      display: flex;
      align-items: center;
    }

    /* Root card container: max width with auto margin for centering */
    .root-card {
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
    }

    /* Main card with gradient background and subtle border */
    .box.has-background-dark {
      background: linear-gradient(135deg, #020617 0%, #020617 40%, #020617 70%);
      border-radius: 1rem;
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.8);
      padding: 1.25rem 1.5rem;
    }

    /* Inner boxes for sections (status, tests, info) */
    .box-inner {
      background-color: #020617;
      border-radius: 0.85rem;
      border: 1px solid rgba(30, 64, 175, 0.4);
      padding: 0.9rem 1rem;
    }

    /* Title and subtitle spacing */
    .main-title {
      margin-bottom: 0.25rem;
    }
    .main-subtitle {
      margin-bottom: 0.75rem;
    }

    /* Badge styling: small pill-shaped label with dot indicator */
    .badge {
      font-size: 0.7rem;
      border-radius: 999px;
      padding: 0.15rem 0.7rem;
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #7dd3fc;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }

    /* Green dot indicator inside badge (shows "active" status) */
    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.25);
    }

    /* Monospace font for code blocks and addresses (always LTR) */
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
      font-size: 0.75rem;
      direction: ltr;
    }

    /* Code blocks: allow word wrapping and horizontal scroll if needed */
    pre {
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: anywhere;
      overflow-x: auto;
      margin: 0;
    }

    /* Card for latency and health metrics */
    .latency-card {
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.25);
    }

    /* Large metric values (latency numbers, status text) */
    .mini-metric-value {
      font-size: 0.9rem;
      font-weight: 600;
    }

    /* Small labels above metric values */
    .mini-heading {
      font-size: 0.78rem;
      opacity: 0.8;
    }

    /* Progress bars for latency visualization */
    .progress {
      height: 0.5rem;
      border-radius: 999px;
    }

    /* Result boxes: scrollable if content overflows */
    #healthResult, #dohResult {
      max-height: 72px;
      overflow-y: auto;
      word-break: break-word;
    }

    /* Primary button: gradient blue with shadow and hover effects */
    .button.is-primary {
      background: linear-gradient(135deg, #2563eb, #4f46e5);
      border: none;
      box-shadow: 0 8px 18px rgba(37, 99, 235, 0.55);
    }

    .button.is-primary:hover {
      filter: brightness(1.05);
      transform: translateY(-1px);
    }

    /* Light outlined buttons */
    .button.is-light.is-outlined {
      border-color: rgba(148, 163, 184, 0.6);
      color: #e5e7eb;
    }

    /* Remove shadow and translate on button active state */
    .button:active {
      transform: translateY(0);
      box-shadow: none;
    }

    /* Compact button group spacing */
    .buttons.is-compact .button {
      margin-bottom: 0.3rem;
    }

    /* Mobile responsiveness: reduce padding and stack layout */
    @media (max-width: 768px) {
      .box.has-background-dark {
        padding: 1rem;
      }
      .main-title {
        font-size: 1.05rem;
      }
      .columns {
        margin-left: 0;
        margin-right: 0;
      }
    }
  </style>
</head>
<body>
  <!-- Main page section: centered container -->
  <section class="section page-section">
    <div class="root-card">
      <div class="box has-background-dark has-text-light">
        
        <!-- Header section: title, badge, and description -->
        <div class="mb-3">
          <!-- Status badge with animated dot -->
          <div class="badge mb-2">
            <span class="badge-dot"></span>
            <span>Arvan Edge → Cloudflare DoH Proxy</span>
          </div>

          <!-- Main title -->
          <h1 class="title is-5 has-text-light main-title">
            پروکسی DNS-over-HTTPS روی آروان
          </h1>

          <!-- Subtitle explaining what the service does -->
          <p class="subtitle is-7 has-text-grey-light main-subtitle">
            این سرویس ترافیک DoH را در لبهٔ آروان دریافت می‌کند، از طریق تونل امن به
            Cloudflare Worker شما می‌فرستد و نتیجهٔ ریزولورهای بالادستی را برمی‌گرداند.
          </p>
        </div>

        <!-- Two-column layout: left (status/tests) and right (info/endpoints) -->
        <div class="columns is-variable is-5 is-vcentered is-multiline">
          
          <!-- Left column: health status, latency metrics, and test buttons -->
          <div class="column is-6">
            
            <!-- Status card: shows tunnel health and latency measurements -->
            <div class="box-inner latency-card mb-3">
              <div class="columns is-mobile">
                
                <!-- Column 1: Overall route status -->
                <div class="column">
                  <p class="mini-heading">وضعیت مسیر</p>
                  <p class="mini-metric-value" id="statusText">
                    در حال بررسی…
                  </p>
                  <span
                    class="tag is-warning is-light is-rounded is-size-7 mt-1"
                    id="statusTag"
                  >
                    در انتظار تست
                  </span>
                  <p
                    class="is-size-7 has-text-grey-light mt-2"
                    id="lastCheckAt"
                  >
                    آخرین بررسی: -
                  </p>
                </div>

                <!-- Column 2: Arvan → Cloudflare Worker latency -->
                <div class="column">
                  <p class="mini-heading">آروان → Worker</p>
                  <p class="mini-metric-value" id="edgeLatencyText">- ms</p>
                  <progress
                    class="progress is-info is-small"
                    value="0"
                    max="1000"
                    id="edgeProgress"
                  >
                    0 ms
                  </progress>
                </div>

                <!-- Column 3: Cloudflare Worker → upstream resolver latency -->
                <div class="column">
                  <p class="mini-heading">Worker → upstream</p>
                  <p class="mini-metric-value" id="upLatencyText">- ms</p>
                  <progress
                    class="progress is-primary is-small"
                    value="0"
                    max="1000"
                    id="upProgress"
                  >
                    0 ms
                  </progress>
                </div>
              </div>
            </div>

            <!-- Test controls: input field and action buttons -->
            <div class="box-inner latency-card">
              <p class="mini-heading mb-2">تست سلامت و DoH</p>

              <!-- Domain input field for testing -->
              <div class="field mb-2">
                <label class="label is-size-7 has-text-light" for="dnsName">
                  دامنهٔ تست
                </label>
                <div class="control">
                  <input
                    id="dnsName"
                    class="input is-small has-background-black has-text-light"
                    type="text"
                    dir="ltr"
                    placeholder="example.com"
                    value="example.com"
                  />
                </div>
              </div>

              <!-- Test buttons: health check and DoH methods -->
              <div class="buttons are-small is-compact mb-2">
                <!-- Check tunnel health button -->
                <button
                  class="button is-primary"
                  type="button"
                  onclick="runHealthCheck()"
                  id="btnHealth"
                >
                  💓 بررسی سلامت تونل
                </button>
                <!-- DoH GET method test -->
                <button
                  class="button is-light is-outlined"
                  type="button"
                  onclick="runDoHTest('GET')"
                  id="btnDohGet"
                >
                  🌐 DoH (GET)
                </button>
                <!-- DoH POST method test -->
                <button
                  class="button is-light is-outlined"
                  type="button"
                  onclick="runDoHTest('POST')"
                  id="btnDohPost"
                >
                  📦 DoH (POST)
                </button>
              </div>

              <!-- Result displays: health check and DoH test results -->
              <div
                id="healthResult"
                class="notification is-size-7 mt-1"
                style="display: none;"
              ></div>
              <div
                id="dohResult"
                class="notification is-size-7 mt-1"
                style="display: none;"
              ></div>
            </div>
          </div>

          <!-- Right column: project info and endpoint URLs -->
          <div class="column is-6">
            
            <!-- About section: explains the project purpose -->
            <div class="box-inner latency-card mb-3">
              <p class="mini-heading mb-1">دربارهٔ این پروژه</p>
              <p class="is-size-7 has-text-grey-light">
                این پروکسی برای سناریوهایی ساخته شده است که می‌خواهید:
              </p>
              <ul
                class="is-size-7 has-text-grey-light mt-2"
                style="list-style: disc; padding-right: 1.2rem;"
              >
                <li>یک آدرس DoH روی آروان به کلاینت‌ها بدهید، بدون لو رفتن ساختار پشت‌صحنه.</li>
                <li>درخواست‌ها را از طریق تونل امن به Cloudflare Worker خود منتقل کنید.</li>
                <li>در Worker بین چند ریزولور DoH (Cloudflare, Google, AdGuard, ...) بالانس کنید.</li>
                <li>latency بین آروان → Worker و Worker → ریزولور را مانیتور کنید.</li>
              </ul>
            </div>

            <!-- Endpoints section: shows URLs for clients and upstreams -->
            <div class="box-inner latency-card">
              <p class="mini-heading mb-2">آدرس‌های DoH</p>
              <div class="columns is-mobile">
                <!-- Arvan endpoint: what clients connect to -->
                <div class="column">
                  <p class="mini-heading mb-1">آروان (کلاینت‌ها)</p>
                  <pre class="has-background-black-ter p-2">
<code>\${origin}/dns-query</code></pre>
                </div>
                <!-- Cloudflare Worker endpoint: backend resolver -->
                <div class="column">
                  <p class="mini-heading mb-1">Cloudflare Worker</p>
                  <pre class="has-background-black-ter p-2">
<code>\${CLOUDFLARE_WORKER_BASE}/dns-query</code></pre>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </section>

  <script>
    // Store the Arvan origin URL for all fetch requests
    const arvanOrigin = "\${origin}";

    /**
     * updateMeters(edge, upstream)
     * Updates the dashboard with latency metrics and status indicators
     * @param edge - latency from Arvan to Cloudflare Worker (ms)
     * @param upstream - latency from Cloudflare to upstream resolver (ms)
     */
    function updateMeters(edge, upstream) {
      const statusText = document.getElementById("statusText");
      const statusTag = document.getElementById("statusTag");
      const edgeLatencyText = document.getElementById("edgeLatencyText");
      const upLatencyText = document.getElementById("upLatencyText");
      const edgeProgress = document.getElementById("edgeProgress");
      const upProgress = document.getElementById("upProgress");
      const lastCheckAt = document.getElementById("lastCheckAt");

      // Safe values: use 0 if null, clamp to 1000 for progress bar
      const edgeVal = edge != null ? edge : 0;
      const upVal = upstream != null ? upstream : 0;
      const edgeClamped = Math.min(edgeVal, 1000);
      const upClamped = Math.min(upVal, 1000);

      // Update metric text displays
      edgeLatencyText.textContent = edge != null ? edge + " ms" : "- ms";
      upLatencyText.textContent = upstream != null ? upstream + " ms" : "- ms";

      // Update progress bar values and text
      edgeProgress.value = edgeClamped;
      edgeProgress.textContent = edgeVal + " ms";
      upProgress.value = upClamped;
      upProgress.textContent = upVal + " ms";

      // Update timestamp with Persian locale
      const now = new Date().toLocaleTimeString("fa-IR", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      lastCheckAt.textContent = "آخرین بررسی: " + now;

      // Determine status based on latency thresholds
      let status = "ok";
      let label = "مسیر سالم است";
      let tagClass = "tag is-success is-light is-rounded is-size-7";

      // If no data yet, show unknown status
      if (edge == null || upstream == null) {
        status = "degraded";
        label = "وضعیت نامشخص";
        tagClass = "tag is-warning is-light is-rounded is-size-7";
      }
      // Moderate latency (400-800ms)
      else if (edge > 400 || upstream > 400) {
        status = "degraded";
        label = "تاخیر متوسط";
        tagClass = "tag is-warning is-light is-rounded is-size-7";
      }

      // High latency (>800ms)
      if (edge > 800 || upstream > 800) {
        status = "error";
        label = "تاخیر بالا / احتمال مشکل";
        tagClass = "tag is-danger is-light is-rounded is-size-7";
      }

      // Update UI with determined status
      statusText.textContent = label;
      statusTag.className = tagClass;
      statusTag.textContent =
        status === "ok" ? "سالم" : status === "degraded" ? "متوسط" : "مشکل‌دار";
    }

    /**
     * runHealthCheck()
     * Calls /healthz endpoint to check tunnel health
     * Updates meters and shows result notification
     */
    async function runHealthCheck() {
      const btn = document.getElementById("btnHealth");
      const box = document.getElementById("healthResult");
      btn.disabled = true;

      box.style.display = "block";
      box.className = "notification is-info is-light is-size-7";
      box.textContent = "در حال اجرای /healthz روی تونل…";

      try {
        const res = await fetch(arvanOrigin + "/healthz", {
          headers: { Accept: "application/json" },
        });
        const data = await res.json();

        // Extract latency values (try multiple property names for compatibility)
        const edgeLat =
          data.edge_latency_ms != null ? data.edge_latency_ms : null;
        const upLat =
          data.upstream_latency_ms != null
            ? data.upstream_latency_ms
            : data.latency_ms != null
            ? data.latency_ms
            : null;
        const code =
          data.upstream_status != null ? data.upstream_status : res.status;

        updateMeters(edgeLat, upLat);

        // Show success if both HTTP status and health status are OK
        if (res.ok && data.status === "ok") {
          box.className = "notification is-success is-light is-size-7";
          box.innerHTML =
            "<strong>✅ مسیر سالم است</strong> — HTTP <code>" +
            code +
            "</code>";
        } else {
          box.className = "notification is-warning is-light is-size-7";
          box.innerHTML =
            "<strong>⚠️ مسیر در وضعیت ضعیف / خطا</strong> — HTTP <code>" +
            code +
            "</code><br>" +
            "<small>" +
            (data.message || "پاسخ نامناسب از Cloudflare /healthz") +
            "</small>";
        }
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ خطا در بررسی سلامت</strong><br><code>" +
          err.message +
          "</code>";
      } finally {
        btn.disabled = false;
      }
    }

    /**
     * buildDnsQuery(name)
     * Constructs a binary DNS query for domain name (A record, IN class)
     * Returns Uint8Array in DNS wire format
     */
    function buildDnsQuery(name) {
      const labels = name.split(".").filter(Boolean);
      if (!labels.length) throw new Error("دامنه نامعتبر است.");

      // Build DNS QNAME: length-prefixed labels
      const qnameParts = [];
      for (const label of labels) {
        if (label.length > 63)
          throw new Error("طول یکی از لیبل‌های دامنه بیش از حد است.");
        qnameParts.push(label.length);
        for (let i = 0; i < label.length; i++) {
          qnameParts.push(label.charCodeAt(i));
        }
      }
      qnameParts.push(0); // Root label terminator

      // Build complete DNS message
      const qnameLen = qnameParts.length;
      const buf = new Uint8Array(12 + qnameLen + 4); // Header + QNAME + QTYPE/QCLASS
      const id = Math.floor(Math.random() * 0xffff);

      // DNS header (12 bytes): ID, flags, counts
      buf[0] = (id >> 8) & 0xff;
      buf[1] = id & 0xff;
      buf[2] = 0x01; // QR=0, Opcode=0, AA=0, TC=0, RD=1
      buf[3] = 0x00; // RA=0, Z=0, RCODE=0
      buf[4] = 0x00; // QDCOUNT high byte
      buf[5] = 0x01; // QDCOUNT = 1
      buf[6] = 0x00; // ANCOUNT = 0
      buf[7] = 0x00;
      buf[8] = 0x00; // NSCOUNT = 0
      buf[9] = 0x00;
      buf[10] = 0x00; // ARCOUNT = 0
      buf[11] = 0x00;

      // Copy QNAME into message
      buf.set(qnameParts, 12);
      const offset = 12 + qnameLen;

      // QTYPE (A record = 1) and QCLASS (IN = 1)
      buf[offset] = 0x00;
      buf[offset + 1] = 0x01;
      buf[offset + 2] = 0x00;
      buf[offset + 3] = 0x01;

      return buf;
    }

    /**
     * toBase64Url(bytes)
     * Converts binary data to base64url format for DNS GET parameter
     */
    function toBase64Url(bytes) {
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      let base64 = btoa(binary);
      // Replace standard base64 chars with URL-safe variants
      return base64
        .replace(/\\+/g, "-")
        .replace(/\\//g, "_")
        .replace(/=+$/g, "");
    }

    /**
     * bytesToHex(bytes, maxLen)
     * Converts binary data to hex string for display (limited length)
     */
    function bytesToHex(bytes, maxLen) {
      const limit = Math.min(bytes.length, maxLen);
      let out = "";
      for (let i = 0; i < limit; i++) {
        out += bytes[i].toString(16).padStart(2, "0") + " ";
      }
      if (bytes.length > limit) out += "...";
      return out.trim();
    }

    /**
     * runDoHTest(method)
     * Tests DoH endpoint with GET or POST method
     * Builds DNS query, sends it, and displays response
     */
    async function runDoHTest(method) {
      const m = (method || "GET").toUpperCase();
      const input = document.getElementById("dnsName");
      const box = document.getElementById("dohResult");
      const btnGet = document.getElementById("btnDohGet");
      const btnPost = document.getElementById("btnDohPost");

      const name = (input.value || "").trim() || "example.com";

      // Disable buttons while test runs
      btnGet.disabled = true;
      btnPost.disabled = true;

      box.style.display = "block";
      box.className = "notification is-info is-light is-size-7";
      box.textContent =
        "در حال ارسال " + m + " برای " + name + " از طریق /dns-query…";

      // Build DNS query
      let query;
      try {
        query = buildDnsQuery(name);
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ خطا در ساخت DNS query</strong><br><code>" +
          err.message +
          "</code>";
        btnGet.disabled = false;
        btnPost.disabled = false;
        return;
      }

      try {
        let res;
        const headers = { Accept: "application/dns-message" };

        // Send query via POST with binary body
        if (m === "POST") {
          headers["Content-Type"] = "application/dns-message";
          res = await fetch(arvanOrigin + "/dns-query", {
            method: "POST",
            headers,
            body: query,
          });
        }
        // Send query via GET with base64url parameter
        else {
          const dnsParam = toBase64Url(query);
          const dohUrl =
            arvanOrigin + "/dns-query?dns=" + encodeURIComponent(dnsParam);
          res = await fetch(dohUrl, { headers });
        }

        // Parse response as binary data
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const hexPreview = bytesToHex(bytes, 24);
        const ct = res.headers.get("content-type") || "";

        // Show success or warning based on HTTP status
        if (res.ok) {
          box.className = "notification is-success is-light is-size-7";
          box.innerHTML =
            "<strong>✅ DoH موفق بود</strong> — HTTP <code>" +
            res.status +
            "</code><br>" +
            "<small>طول پاسخ: " +
            bytes.length +
            " بایت، بایت‌های ابتدایی (hex): <code>" +
            hexPreview +
            "</code></small>";
        } else {
          box.className = "notification is-warning is-light is-size-7";
          box.innerHTML =
            "<strong>⚠️ پاسخ نامناسب از DoH</strong> — HTTP <code>" +
            res.status +
            "</code><br>" +
            "<small>Content-Type: <code>" +
            ct +
            "</code></small>";
        }
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ خطا در ارسال DoH</strong><br><code>" +
          err.message +
          "</code>";
      } finally {
        btnGet.disabled = false;
        btnPost.disabled = false;
      }
    }

    // Run initial health check on page load to populate status
    runHealthCheck().catch(() => {});
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...Object.fromEntries(buildCorsHeaders().entries()),
    },
  });
}
