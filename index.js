// Cloudflare Worker: DNS-over-HTTPS (DoH) Proxy with Health Checks
//
// This worker does the following:
// 1. Exposes a public DoH endpoint on /dns-query for clients to query
// 2. Forwards queries to one or more upstream DNS resolvers (Cloudflare, Google, AdGuard, etc.)
// 3. Provides a /healthz endpoint that measures upstream latency
// 4. Serves a nice dashboard UI on the root path for monitoring and testing
//
// Configuration:
// Set environment variables UPSTREAMS (comma-separated URLs) or UPSTREAM (single URL)
// to override the default list of resolvers. If not set, uses Cloudflare, Google, and AdGuard.

// Default upstream resolvers (if not configured via env vars)
const DEFAULT_UPSTREAMS = [
  { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { name: "Google", url: "https://dns.google/dns-query" },
  { name: "AdGuard", url: "https://dns.adguard-dns.com/dns-query" },
];

// Pre-built DNS query for "example.com A record" (used for health checks)
// This is a standard DNS wire-format query, base64url-encoded
const HEALTH_CHECK_DNS_QUERY = "AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE";

// ---- Logging Configuration ----
// Disable by default to save compute time; enable for debugging
const DEFAULT_ENABLE_LOGGING = false;

function isLoggingEnabled() {
  if (typeof ENABLE_LOGGING === "string") {
    const v = ENABLE_LOGGING.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  if (typeof ENABLE_LOGGING === "boolean") return ENABLE_LOGGING;
  return DEFAULT_ENABLE_LOGGING;
}

function log(...args) {
  if (isLoggingEnabled()) console.log("[WORKER]", ...args);
}

function logError(...args) {
  if (isLoggingEnabled()) console.error("[WORKER]", ...args);
}

// ---- Request Router ----
// Cloudflare Workers entry point: listen for all fetch events

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  log(method, path + url.search);

  // Handle OPTIONS (CORS preflight)
  if (method === "OPTIONS") {
    return makeCorsPreflightResponse();
  }

  // Route to appropriate handler based on path
  if (path === "/" || path === "") {
    return serveHomePage(url);
  }

  if (path === "/dns-query") {
    return handleDoHProxy(request, url);
  }

  if (path === "/healthz") {
    return handleHealthz(request);
  }

  return new Response("Not found", {
    status: 404,
    headers: buildCorsHeaders(),
  });
}

// ---- Upstream Configuration ----
// Load upstream resolvers from environment variables or use defaults

function getUpstreamsFromEnvOrDefault() {
  // Check for comma-separated list of upstreams
  if (typeof UPSTREAMS === "string" && UPSTREAMS.trim() !== "") {
    const items = UPSTREAMS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length > 0) {
      return items.map((url, idx) => ({
        name: `env-${idx + 1}`,
        url,
      }));
    }
  }

  // Check for single upstream URL
  if (typeof UPSTREAM === "string" && UPSTREAM.trim() !== "") {
    return [{ name: "env-single", url: UPSTREAM.trim() }];
  }

  // Fall back to defaults
  return DEFAULT_UPSTREAMS;
}

// Pick a random upstream from the list for load balancing
function pickRandomUpstream(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return DEFAULT_UPSTREAMS[0];
  }
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

// ---- DoH Proxy Handler ----
// Accept DoH queries (GET or POST) and forward to a random upstream resolver

async function handleDoHProxy(request, url) {
  const method = request.method.toUpperCase();
  const upstreams = getUpstreamsFromEnvOrDefault();
  const upstream = pickRandomUpstream(upstreams);
  const upstreamUrl = new URL(upstream.url);

  const fetchOptions = {
    method,
    headers: {
      Accept: "application/dns-message",
    },
  };

  // GET: dns parameter contains base64url-encoded DNS query
  if (method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    if (!dnsParam) {
      return new Response("Missing dns query parameter", {
        status: 400,
        headers: buildCorsHeaders(),
      });
    }
    upstreamUrl.searchParams.set("dns", dnsParam);
  }
  // POST: binary DNS message in request body
  else if (method === "POST") {
    const body = await request.arrayBuffer();
    fetchOptions.body = body;
    fetchOptions.headers["Content-Type"] = "application/dns-message";
  } else {
    return new Response("Method not allowed", {
      status: 405,
      headers: buildCorsHeaders(),
    });
  }

  log("Proxying DoH to upstream:", upstreamUrl.toString());

  try {
    // Forward the query to the upstream resolver
    const upstreamResponse = await fetch(upstreamUrl.toString(), fetchOptions);

    // Build response headers, preserving CORS and adding proxy info
    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", "application/dns-message");
    const corsHeaders = buildCorsHeaders();
    for (const [key, value] of corsHeaders.entries()) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set("X-DoH-Upstream", upstream.url);
    responseHeaders.set("X-DoH-Proxy", "Cloudflare-Worker");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    logError("Upstream fetch failed:", error);
    return new Response("Upstream fetch failed: " + String(error), {
      status: 502,
      headers: buildCorsHeaders(),
    });
  }
}

// ---- Health Check Endpoint ----
// Sends a real DoH query to measure upstream latency and verify connectivity

async function handleHealthz(request) {
  const url = new URL(request.url);
  const workerBase = url.origin;
  const dohEndpoint = workerBase + "/dns-query";

  const upstreams = getUpstreamsFromEnvOrDefault();
  const upstream = pickRandomUpstream(upstreams);
  const upstreamUrl = new URL(upstream.url);
  upstreamUrl.searchParams.set("dns", HEALTH_CHECK_DNS_QUERY);

  // Measure time to upstream resolver
  const start = Date.now();
  try {
    const res = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: { Accept: "application/dns-message" },
    });
    const latency = Date.now() - start;

    // Build health response payload
    const body = {
      status: res.ok ? "ok" : "degraded",
      worker_base: workerBase,
      doh_endpoint: dohEndpoint,
      upstream_url: upstream.url,
      upstream_status: res.status,
      latency_ms: latency,
      upstream_latency_ms: latency,
      message: res.ok
        ? "Upstream DoH reachable"
        : "Upstream returned non-2xx/3xx status",
      checked_at: new Date().toISOString(),
    };

    return json(body, res.ok ? 200 : 502);
  } catch (error) {
    const body = {
      status: "error",
      worker_base: workerBase,
      doh_endpoint: dohEndpoint,
      upstream_url: upstream.url,
      upstream_status: null,
      latency_ms: null,
      upstream_latency_ms: null,
      message: String(error),
      checked_at: new Date().toISOString(),
    };
    logError("Health check failed:", error);
    return json(body, 502);
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

// ---- Dashboard UI ----
// Serves an interactive monitoring dashboard with live testing capabilities
// Users can check upstream health, test DoH queries, and view latency metrics

function serveHomePage(url) {
  const origin = url.origin;
  const upstreams = getUpstreamsFromEnvOrDefault();
  const firstUpstream = upstreams[0]
    ? upstreams[0].url
    : "No upstream configured";

  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <title>Cloudflare DoH Proxy Worker</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Bulma CSS Framework: responsive, component-based styling -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css"
  />

  <!-- Vazirmatn Font: modern, clean typeface for UI text -->
  <link
    rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap"
  />

  <style>
    /* Force dark mode in supporting browsers */
    :root {
      color-scheme: dark;
    }

    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
    }

    /* Main background: dark gradient */
    body {
      font-family: "Vazirmatn", system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #020617 0, #020617 40%, #020617 100%);
      color: #e5e7eb;
      direction: ltr;
    }

    /* Full viewport height container, centers content vertically */
    .page-section {
      min-height: 100vh;
      padding: 1.5rem 0.75rem;
      display: flex;
      align-items: center;
    }

    /* Centered card container with max width */
    .root-card {
      max-width: 960px;
      width: 100%;
      margin: 0 auto;
    }

    /* Main card: gradient background with border and shadow */
    .box.has-background-dark {
      background: linear-gradient(135deg, #020617 0%, #020617 40%, #020617 70%);
      border-radius: 1rem;
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.8);
      padding: 1.25rem 1.5rem;
    }

    /* Inner section boxes with subtle borders */
    .box-inner {
      background-color: #020617;
      border-radius: 0.85rem;
      border: 1px solid rgba(30, 64, 175, 0.4);
      padding: 0.9rem 1rem;
    }

    .main-title {
      margin-bottom: 0.25rem;
    }
    .main-subtitle {
      margin-bottom: 0.75rem;
    }

    /* Small status badge with indicator dot */
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

    /* Animated green dot inside badge */
    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.25);
    }

    /* Code blocks: monospace font, always LTR */
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
      font-size: 0.75rem;
      direction: ltr;
    }

    /* Pre: allow wrapping and scrolling */
    pre {
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: anywhere;
      overflow-x: auto;
      margin: 0;
    }

    /* Card for metrics displays */
    .latency-card {
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.25);
    }

    /* Large metric values */
    .mini-metric-value {
      font-size: 0.9rem;
      font-weight: 600;
    }

    /* Small labels above values */
    .mini-heading {
      font-size: 0.78rem;
      opacity: 0.8;
    }

    /* Progress bars for latency visualization */
    .progress {
      height: 0.5rem;
      border-radius: 999px;
    }

    /* Result notification boxes: scrollable if needed */
    #healthResult, #dohResult {
      max-height: 72px;
      overflow-y: auto;
      word-break: break-word;
    }

    /* Primary action button: gradient with hover effects */
    .button.is-primary {
      background: linear-gradient(135deg, #2563eb, #4f46e5);
      border: none;
      box-shadow: 0 8px 18px rgba(37, 99, 235, 0.55);
    }

    .button.is-primary:hover {
      filter: brightness(1.05);
      transform: translateY(-1px);
    }

    /* Secondary buttons: light outline style */
    .button.is-light.is-outlined {
      border-color: rgba(148, 163, 184, 0.6);
      color: #e5e7eb;
    }

    /* Remove shadow on button press */
    .button:active {
      transform: translateY(0);
      box-shadow: none;
    }

    /* Compact button group spacing */
    .buttons.is-compact .button {
      margin-bottom: 0.3rem;
    }

    /* Mobile responsiveness */
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
      .page-section {
        min-height: auto;
        padding: 1rem 0.75rem 1.5rem;
        display: block;
      }
    }
  </style>
</head>
<body>
  <!-- Main page container -->
  <section class="section page-section">
    <div class="root-card">
      <div class="box has-background-dark has-text-light">
        
        <!-- Header: title, badge, description -->
        <div class="mb-3">
          <!-- Status indicator badge -->
          <div class="badge mb-2">
            <span class="badge-dot"></span>
            <span>Cloudflare DNS-over-HTTPS Proxy</span>
          </div>

          <!-- Main page title -->
          <h1 class="title is-5 has-text-light main-title">
            Cloudflare DoH Proxy Worker
          </h1>

          <!-- Subtitle explaining service purpose -->
          <p class="subtitle is-7 has-text-grey-light main-subtitle">
            This worker exposes a DNS-over-HTTPS endpoint and forwards queries to one
            of the configured upstream resolvers (Cloudflare, Google, AdGuard, or
            custom ones via environment variables).
          </p>
        </div>

        <!-- Two-column layout: status/tests (left) and info/endpoints (right) -->
        <div class="columns is-variable is-5 is-vcentered is-multiline">
          
          <!-- Left column: upstream status and test controls -->
          <div class="column is-6">
            
            <!-- Status card: health and latency metrics -->
            <div class="box-inner latency-card mb-3">
              <div class="columns is-mobile">
                
                <!-- Column 1: Overall upstream health status -->
                <div class="column">
                  <p class="mini-heading">Upstream status</p>
                  <p class="mini-metric-value" id="statusText">
                    Waiting for health check…
                  </p>
                  <span
                    class="tag is-warning is-light is-rounded is-size-7 mt-1"
                    id="statusTag"
                  >
                    pending
                  </span>
                  <p
                    class="is-size-7 has-text-grey-light mt-2"
                    id="lastCheckAt"
                  >
                    Last check: -
                  </p>
                </div>

                <!-- Column 2: Latency to upstream resolver -->
                <div class="column">
                  <p class="mini-heading">DoH upstream latency</p>
                  <p class="mini-metric-value" id="latencyText">- ms</p>
                  <progress
                    class="progress is-info is-small"
                    value="0"
                    max="1000"
                    id="latencyProgress"
                  >
                    0 ms
                  </progress>
                </div>
              </div>
            </div>

            <!-- Test section: input and action buttons -->
            <div class="box-inner latency-card">
              <p class="mini-heading mb-2">Quick tests</p>

              <!-- Domain name input for testing -->
              <div class="field mb-2">
                <label class="label is-size-7 has-text-light" for="dnsName">
                  Domain to query
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

              <!-- Action buttons: health check and DoH tests -->
              <div class="buttons are-small is-compact mb-2">
                <!-- Health check button: tests upstream reachability -->
                <button
                  class="button is-primary"
                  type="button"
                  onclick="runHealthCheck()"
                  id="btnHealth"
                >
                  💓 Check /healthz
                </button>
                <!-- DoH GET method: query string parameter -->
                <button
                  class="button is-light is-outlined"
                  type="button"
                  onclick="runDoHTest('GET')"
                  id="btnDohGet"
                >
                  🌐 DoH (GET)
                </button>
                <!-- DoH POST method: binary request body -->
                <button
                  class="button is-light is-outlined"
                  type="button"
                  onclick="runDoHTest('POST')"
                  id="btnDohPost"
                >
                  📦 DoH (POST)
                </button>
              </div>

              <!-- Result displays for tests -->
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

          <!-- Right column: project information and endpoints -->
          <div class="column is-6">
            
            <!-- About section: explains worker features -->
            <div class="box-inner latency-card mb-3">
              <p class="mini-heading mb-1">About this worker</p>
              <p class="is-size-7 has-text-grey-light">
                This project is a small edge-native DoH proxy built on top of
                Cloudflare Workers:
              </p>
              <ul
                class="is-size-7 has-text-grey-light mt-2"
                style="list-style: disc; padding-left: 1.2rem;"
              >
                <li>Exposes a public DNS-over-HTTPS endpoint on this worker.</li>
                <li>Forwards binary DoH queries to one of the upstream resolvers.</li>
                <li>Upstreams can be configured via <code>UPSTREAMS</code> or
                  <code>UPSTREAM</code> environment variables.</li>
                <li>
                  <code>/healthz</code> sends a real DoH query and measures upstream latency.
                </li>
              </ul>
            </div>

            <!-- Endpoints section: shows available URLs -->
            <div class="box-inner latency-card">
              <p class="mini-heading mb-2">Endpoints</p>
              <div class="columns is-mobile">
                <!-- Public DoH endpoint for clients -->
                <div class="column">
                  <p class="mini-heading mb-1">Public DoH endpoint</p>
                  <pre class="has-background-black-ter p-2">
<code>\${origin}/dns-query</code></pre>
                </div>
                <!-- Example upstream resolver URL -->
                <div class="column">
                  <p class="mini-heading mb-1">Example upstream</p>
                  <pre class="has-background-black-ter p-2">
<code>\${firstUpstream}</code></pre>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </section>

  <script>
    // Store worker origin for API calls
    const workerOrigin = "\${origin}";

    /**
     * updateMeters(latency)
     * Updates the dashboard UI with latency metrics and status
     * @param latency - latency to upstream resolver in milliseconds
     */
    function updateMeters(latency) {
      const statusText = document.getElementById("statusText");
      const statusTag = document.getElementById("statusTag");
      const latencyText = document.getElementById("latencyText");
      const latencyProgress = document.getElementById("latencyProgress");
      const lastCheckAt = document.getElementById("lastCheckAt");

      // Safe value: use 0 if null, clamp to 1000 for progress bar max
      const val = latency != null ? latency : 0;
      const clamped = Math.min(val, 1000);

      // Update latency display and progress bar
      latencyText.textContent = latency != null ? val + " ms" : "- ms";
      latencyProgress.value = clamped;
      latencyProgress.textContent = val + " ms";

      // Update timestamp with UTC format
      const now = new Date().toLocaleTimeString("en-GB", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      lastCheckAt.textContent = "Last check: " + now;

      // Determine health status based on latency thresholds
      let status = "ok";
      let label = "Upstream is healthy";
      let tagClass = "tag is-success is-light is-rounded is-size-7";

      // No data yet
      if (latency == null) {
        status = "degraded";
        label = "Unknown / no data yet";
        tagClass = "tag is-warning is-light is-rounded is-size-7";
      }
      // Moderate latency (400-800ms)
      else if (latency > 400) {
        status = "degraded";
        label = "Latency is moderate";
        tagClass = "tag is-warning is-light is-rounded is-size-7";
      }

      // High latency (>800ms)
      if (latency > 800) {
        status = "error";
        label = "High latency / possible issues";
        tagClass = "tag is-danger is-light is-rounded is-size-7";
      }

      // Update status display
      statusText.textContent = label;
      statusTag.className = tagClass;
      statusTag.textContent =
        status === "ok" ? "healthy" : status === "degraded" ? "degraded" : "unhealthy";
    }

    /**
     * runHealthCheck()
     * Calls /healthz endpoint to verify upstream connectivity
     * Updates meters and displays result
     */
    async function runHealthCheck() {
      const btn = document.getElementById("btnHealth");
      const box = document.getElementById("healthResult");
      btn.disabled = true;

      box.style.display = "block";
      box.className = "notification is-info is-light is-size-7";
      box.textContent = "Calling /healthz…";

      try {
        const res = await fetch(workerOrigin + "/healthz", {
          headers: { Accept: "application/json" },
        });
        const data = await res.json();

        // Extract latency (try multiple property names for compatibility)
        const latency =
          data.upstream_latency_ms != null
            ? data.upstream_latency_ms
            : data.latency_ms != null
            ? data.latency_ms
            : null;
        const code =
          data.upstream_status != null ? data.upstream_status : res.status;

        updateMeters(latency);

        // Show success if both HTTP and health status are OK
        if (res.ok && data.status === "ok") {
          box.className = "notification is-success is-light is-size-7";
          box.innerHTML =
            "<strong>✅ Upstream is healthy</strong> — HTTP <code>" +
            code +
            "</code>";
        } else {
          box.className = "notification is-warning is-light is-size-7";
          box.innerHTML =
            "<strong>⚠️ Upstream degraded or error</strong> — HTTP <code>" +
            code +
            "</code><br>" +
            "<small>" +
            (data.message || "Non-2xx response from upstream / DoH health check") +
            "</small>";
        }
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ Health check failed</strong><br><code>" +
          err.message +
          "</code>";
      } finally {
        btn.disabled = false;
      }
    }

    /**
     * buildDnsQuery(name)
     * Builds a binary DNS query for domain name (A record, IN class)
     * Returns Uint8Array in DNS wire format
     */
    function buildDnsQuery(name) {
      const labels = name.split(".").filter(Boolean);
      if (!labels.length) throw new Error("Invalid domain name");

      // Build DNS QNAME: length-prefixed label sequence
      const qnameParts = [];
      for (const label of labels) {
        if (label.length > 63)
          throw new Error("One of the labels is too long.");
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

      // DNS header (12 bytes): ID, flags, section counts
      buf[0] = (id >> 8) & 0xff;
      buf[1] = id & 0xff;
      buf[2] = 0x01; // QR=0, Opcode=0, AA=0, TC=0, RD=1
      buf[3] = 0x00; // RA=0, Z=0, RCODE=0
      buf[4] = 0x00; // QDCOUNT high byte
      buf[5] = 0x01; // QDCOUNT = 1 (one question)
      buf[6] = 0x00; // ANCOUNT = 0 (no answers)
      buf[7] = 0x00;
      buf[8] = 0x00; // NSCOUNT = 0 (no nameservers)
      buf[9] = 0x00;
      buf[10] = 0x00; // ARCOUNT = 0 (no additional)
      buf[11] = 0x00;

      // Copy QNAME into message at offset 12
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
     * Converts binary data to base64url format (RFC 4648) for DoH GET parameter
     */
    function toBase64Url(bytes) {
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      let base64 = btoa(binary);
      // Replace standard base64 chars with URL-safe equivalents
      return base64
        .replace(/\\+/g, "-")
        .replace(/\\//g, "_")
        .replace(/=+$/g, "");
    }

    /**
     * bytesToHex(bytes, maxLen)
     * Converts binary data to space-separated hex string
     * Limited to maxLen bytes for display purposes
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
     * Tests DoH endpoint using GET or POST method
     * Builds DNS query, sends it, and displays response details
     */
    async function runDoHTest(method) {
      const m = (method || "GET").toUpperCase();
      const input = document.getElementById("dnsName");
      const box = document.getElementById("dohResult");
      const btnGet = document.getElementById("btnDohGet");
      const btnPost = document.getElementById("btnDohPost");

      const name = (input.value || "").trim() || "example.com";

      // Disable buttons during test
      btnGet.disabled = true;
      btnPost.disabled = true;

      box.style.display = "block";
      box.className = "notification is-info is-light is-size-7";
      box.textContent =
        "Sending " + m + " DoH query for " + name + " via /dns-query…";

      // Build DNS query
      let query;
      try {
        query = buildDnsQuery(name);
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ Failed to build DNS query</strong><br><code>" +
          err.message +
          "</code>";
        btnGet.disabled = false;
        btnPost.disabled = false;
        return;
      }

      try {
        let res;
        const headers = { Accept: "application/dns-message" };

        // POST: send query as binary request body
        if (m === "POST") {
          headers["Content-Type"] = "application/dns-message";
          res = await fetch(workerOrigin + "/dns-query", {
            method: "POST",
            headers,
            body: query,
          });
        }
        // GET: send query as base64url query parameter
        else {
          const dnsParam = toBase64Url(query);
          const dohUrl =
            workerOrigin + "/dns-query?dns=" + encodeURIComponent(dnsParam);
          res = await fetch(dohUrl, { headers });
        }

        // Parse response as binary data
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const hexPreview = bytesToHex(bytes, 24);
        const ct = res.headers.get("content-type") || "";

        // Display success or warning based on HTTP status
        if (res.ok) {
          box.className = "notification is-success is-light is-size-7";
          box.innerHTML =
            "<strong>✅ DoH succeeded</strong> — HTTP <code>" +
            res.status +
            "</code><br>" +
            "<small>Response length: " +
            bytes.length +
            " bytes, first bytes (hex): <code>" +
            hexPreview +
            "</code></small>";
        } else {
          box.className = "notification is-warning is-light is-size-7";
          box.innerHTML =
            "<strong>⚠️ Non-success DoH response</strong> — HTTP <code>" +
            res.status +
            "</code><br>" +
            "<small>Content-Type: <code>" +
            ct +
            "</code></small>";
        }
      } catch (err) {
        box.className = "notification is-danger is-light is-size-7";
        box.innerHTML =
          "<strong>❌ DoH request failed</strong><br><code>" +
          err.message +
          "</code>";
      } finally {
        btnGet.disabled = false;
        btnPost.disabled = false;
      }
    }

    // Run health check on page load to populate status card
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
