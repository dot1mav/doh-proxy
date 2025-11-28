# Edge DNS-over-HTTPS Proxy (Arvan Edge + Cloudflare Workers)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE.md)
[![Status](https://img.shields.io/badge/status-production-brightgreen)]()
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-yellow?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com)
[![Arvan Edge](https://img.shields.io/badge/Arvan-Edge%20Functions-lightblue)](https://www.arvancloud.ir/)
[![DNS over HTTPS](https://img.shields.io/badge/DNS-over%20HTTPS-success?logo=dns)](https://datatracker.ietf.org/doc/html/rfc8484)

> [!NOTE]
> **Production Ready:** This DoH proxy has been designed for edge deployment and is suitable for production environments. It provides minimal overhead, full HTTPS encryption, and comprehensive health monitoring.

A small edge-native **DNS-over-HTTPS (DoH) proxy** that terminates DoH on **Arvan Edge**, forwards it through a tunnel to a **Cloudflare Worker**, and then fans out to upstream DoH resolvers. Includes a minimal dashboard UI, health endpoint, and configurable logging.

---

## 🌐 Overview

This project is designed for scenarios where you want to:

* Expose a **single stable DoH endpoint** at the edge.
* Hide internal topology (Cloudflare Worker, upstream resolvers) behind that endpoint.
* Measure latency across the path (Arvan → Worker → upstream DoH resolver).
* Keep the implementation lightweight and fully edge-native.

High-level flow:

1. **Clients** send DoH queries to Arvan Edge: `https://<your-arvan-domain>/dns-query`
2. **Arvan Edge function** forwards the binary DoH payload to a **Cloudflare Worker**.
3. The **Cloudflare Worker** forwards the query to one of the configured upstream DoH resolvers (Cloudflare, Google, AdGuard, etc.).
4. The DNS response travels back along the same path to the client.

Both Arvan and Cloudflare provide a small UI and `/healthz` endpoint to inspect the path.

---

## ✨ Features

### Edge-native DoH proxy

* Public DoH endpoint on **Arvan Edge** (`/dns-query`).
* **Cloudflare Worker** acts as the core DoH proxy.
* Everything runs at the edge (no central server/VPS).

### Binary DoH support (RFC 8484 style)

* Supports **binary DNS wire format** over HTTPS.
* Handles both:

  * `GET /dns-query?dns=<base64url>`
  * `POST /dns-query` with `Content-Type: application/dns-message`.

### Upstream resolver load balancing

* Multiple upstream DoH resolvers, for example:

  * `https://cloudflare-dns.com/dns-query`
  * `https://dns.google/dns-query`
  * `https://dns.adguard-dns.com/dns-query`
* Configurable via environment variables:

```bash
# Multiple upstreams (comma-separated)
UPSTREAMS="https://cloudflare-dns.com/dns-query,https://dns.google/dns-query"

# Or a single upstream
UPSTREAM="https://cloudflare-dns.com/dns-query"

# Optional logging (default: disabled)
ENABLE_LOGGING="true"  # or "false"
```

On each request, the worker picks a random upstream from the configured list.

### Health & observability

#### Cloudflare Worker (`/healthz`)

* Issues a real DoH query for `example.com` using the GET `?dns=` format.
* Measures upstream latency (`upstream_latency_ms`).
* Returns a JSON payload:

```json
{
  "status": "ok",
  "worker_base": "https://<your-worker>.workers.dev",
  "doh_endpoint": "https://<your-worker>.workers.dev/dns-query",
  "upstream_url": "https://cloudflare-dns.com/dns-query",
  "upstream_status": 200,
  "latency_ms": 23,
  "upstream_latency_ms": 23,
  "message": "Upstream DoH reachable",
  "checked_at": "2025-11-26T17:16:39.972Z"
}
```

Status values:
- `"ok"` – Upstream responded with 2xx/3xx status.
- `"degraded"` – Upstream responded but with non-success status.
- `"error"` – Upstream fetch failed or unreachable.

#### Arvan Edge (`/healthz`)

* Calls the Cloudflare Worker `/healthz` endpoint.
* Adds its own **edge→worker latency** as `edge_latency_ms`.
* Returns both edge and upstream latency metrics:

```json
{
  "status": "ok",
  "edge_latency_ms": 15,
  "upstream_latency_ms": 23,
  "upstream_status": 200,
  "message": "Cloudflare /healthz قابل دسترس است.",
  "arvan_checked_at": "2025-11-26T17:16:39.972Z"
}
```

This gives you visibility into both hops: **Arvan → Worker** and **Worker → upstream**.

#### Latency thresholds (UI status indicators)

The dashboard uses these thresholds to color-code health status:

- **🟢 Green (Healthy)**: Latency < 400ms
- **🟡 Yellow (Degraded)**: Latency 400–800ms
- **🔴 Red (Error)**: Latency > 800ms

If latency data is unavailable, status shows as **yellow (unknown)**.

### Minimal dashboard UI

Each platform exposes a simple dashboard on `/` built with **Bulma** and **Vazirmatn**:

* **Status card** showing overall health, latency, and last check time.
* **Progress bars** visualizing latency for quick at-a-glance monitoring.
* Simple **test form** to:

  * Run `/healthz` and see both edge and upstream latency.
  * Send real DoH queries (GET/POST) via `/dns-query`.
  * Query any domain and inspect raw DNS response bytes.
* Responsive layout suitable for both desktop and mobile.

### Configurable logging

* Logging is controlled via an `ENABLE_LOGGING` flag.
* Defaults to `false` for privacy-friendly behavior.
* Accepts values like `"true"`, `"1"`, `"yes"`, `"on"`.

This allows you to enable detailed logs in development or debugging environments without changing the code.

---

## 🧱 Architecture

```text
Client (DoH)
   │
   ▼
Arvan Edge Function
   │  /dns-query  (binary DoH GET/POST)
   │  /healthz    (measure Arvan → Worker)
   ▼
Cloudflare Worker
   │  /dns-query  → chooses random upstream
   │  /healthz    (measure Worker → upstream)
   ▼
Upstream DoH Resolver (Cloudflare / Google / AdGuard / ...)
```

Health check flow:

```text
Client → Arvan /healthz → Cloudflare /healthz → Upstream DoH resolver
         └─ edge_latency_ms ─┘                └─ upstream_latency_ms ─┘
```

---

## 🚀 Getting started

### 1. Cloudflare Worker

1. Create a new Worker (or use an existing one).
2. Deploy `index.js` as the Worker script.
3. Configure environment variables (either in `wrangler.toml` or via the Cloudflare dashboard):

```toml
# wrangler.toml snippet
[env.production.vars]
UPSTREAMS = "https://cloudflare-dns.com/dns-query,https://dns.google/dns-query,https://dns.adguard-dns.com/dns-query"
ENABLE_LOGGING = "false"
```

4. Note the public Worker URL, e.g.:

```text
https://doh-proxy-example.yourname.workers.dev
```

### 2. Arvan Edge function

1. Deploy `arvan.js` as an Arvan Edge function.
2. **Important**: Update `CLOUDFLARE_WORKER_BASE` inside `arvan.js` to your Worker URL:

```js
const CLOUDFLARE_WORKER_BASE = "https://doh-proxy-example.yourname.workers.dev";
```

3. Optionally set `ENABLE_LOGGING` as an environment variable on Arvan.
4. Point a domain or subdomain on Arvan to this edge function.

Now your **client-facing DoH endpoint** becomes:

```text
https://your-arvan-domain/dns-query
```

### 3. Configure DoH clients

Use your Arvan DoH URL in:

* Operating systems (where custom DoH is supported).
* Browsers (Firefox, Chrome/Chromium with custom DNS over HTTPS).
* Other applications that support RFC 8484 DoH.

---

## 🔍 Endpoints

### Cloudflare Worker

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | `GET` | Dashboard UI (status, tests, endpoints) |
| `/dns-query` | `GET` | DoH endpoint; dns parameter contains base64url query |
| `/dns-query` | `POST` | DoH endpoint; binary query in body (`application/dns-message`) |
| `/healthz` | `GET` | Health check; measures upstream latency and status |

### Arvan Edge

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | `GET` | Dashboard UI (path overview + latency metrics) |
| `/dns-query` | `GET` | Public DoH endpoint (GET method) |
| `/dns-query` | `POST` | Public DoH endpoint (POST method) |
| `/healthz` | `GET` | Health check; measures Arvan→Worker and Worker→upstream latency |

---

## 🛡️ Security & privacy notes

* By default, logging is **disabled** (`ENABLE_LOGGING=false`) to avoid storing DNS query data.
* If you enable logging for debugging, be mindful of:

  * Potentially sensitive domain names in queries.
  * Any IP or request metadata exposed by your platform.
* You should run this behind HTTPS-only endpoints (both Arvan and Cloudflare provide this).

This project is intentionally minimal and doesn't do filtering, blocking, or access control out of the box. You can extend the Worker to add:

* IP allow/deny lists.
* Query pattern filtering or rate limiting.
* Custom headers or authentication.

---

## 🧪 Development & debugging

### Using the dashboard UI

1. Visit `https://your-arvan-domain/` (or your Worker URL) to access the dashboard.
2. Click **"💓 Check /healthz"** to run a health check and see latency metrics.
3. Enter a domain name (e.g., `example.com`) and click **"🌐 DoH (GET)"** or **"📦 DoH (POST)"** to test queries.

### Manual health checks

Use `curl` or any HTTP client:

```bash
# Check Arvan health
curl https://your-arvan-domain/healthz | jq

# Check Cloudflare Worker health
curl https://doh-proxy-example.yourname.workers.dev/healthz | jq
```

### Testing DoH queries

```bash
# Test a DoH GET query
curl "https://your-arvan-domain/dns-query?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE" \
  -H "Accept: application/dns-message" \
  -o response.bin

# Test a DoH POST query
dig @https://your-arvan-domain/dns-query example.com +https
```

### Enable logging

Temporarily set `ENABLE_LOGGING=true` on both Arvan and Cloudflare for detailed request/response logging (useful for troubleshooting).

---

## 📚 Tech & skills demonstrated

* Cloudflare Workers (edge compute).
* Arvan Edge Functions.
* DNS-over-HTTPS (DoH), RFC 8484 binary wire format.
* Binary DNS message construction and parsing in JavaScript.
* Edge-to-edge proxying and tunneling.
* Health endpoints and latency instrumentation.
* Minimal dashboard UI with Bulma CSS + Vazirmatn font.
* CORS handling and preflight requests.
* Load balancing across multiple upstream resolvers.

---

## 📝 License

Valdi is made available under the MIT [License](./LICENSE.md).

This project is licensed under the **MIT License** - see the [LICENSE.md](./LICENSE.md) file for details.

### Summary

- **Use freely** for personal, commercial, and educational purposes
- **Modify and distribute** - just include the license and copyright notice
- **No warranty** - provided as-is

For the full license text, see [LICENSE.md](./LICENSE.md).

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 🙋 Support & Questions

* Check the [FAQ](#frequently-asked-questions) section below
* Review [existing issues](../../issues)
* Open a [new issue](../../issues/new) for bug reports or feature requests

### Frequently Asked Questions

**Q: Can I use this in production?**  
A: Yes! This proxy is designed for production use on edge platforms. Start with health monitoring and gradually increase traffic.

**Q: What happens if an upstream resolver fails?**  
A: The health check will detect it and mark status as degraded. The worker will randomly pick another upstream on the next request.

**Q: Can I add my own custom upstream?**  
A: Yes! Set the `UPSTREAM` or `UPSTREAMS` environment variable to point to any RFC 8484-compliant DoH resolver.

**Q: Is there query logging?**  
A: No—logging is disabled by default for privacy. You can enable it with `ENABLE_LOGGING=true` for debugging only.

---

**Made with ❤️ for the edge computing community**
