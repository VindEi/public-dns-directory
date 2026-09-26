# public-dns-directory

A directory of public, regional, and privacy-focused DNS servers.

Every provider is stored as an individual JSON file in `providers/`. An automated GitHub Action tests each endpoint weekly (UDP port 53, DoH, and DoT) and builds the results directly to the `data` branch.

---

## Disclaimer

I used AI to find and compile most of these providers and their endpoints. While automated tests run weekly to verify that the servers actually respond, things change, servers shut down, and AI can get things wrong.

Use this at your own risk.

* I do not run, own, or manage any of these DNS servers.
* I am not responsible for anything that happens if you use them—whether your connection drops, your data gets logged, or your traffic gets redirected.
* Know what you are using. Some of these are regional or state-owned providers that enforce censorship; others are strict ad-blockers or privacy-first setups. Check their privacy policies and terms before pointing your router or device to them.

---

## Getting the Data

All compiled files are published directly to the `data` branch and accessible via CDN or raw GitHub.

### 1. Full Dataset (`index.json`)
Contains all metadata, categories, tags, and complete endpoint configurations.

* jsDelivr CDN:
  ```text
  https://cdn.jsdelivr.net/gh/VindEi/public-dns-directory@data/index.json
  ```
* Raw GitHub:
  ```text
  https://raw.githubusercontent.com/VindEi/public-dns-directory/data/index.json
  ```

### 2. Plain-Text Provider List (`providers.txt`)
A simple line-delimited list of all active provider names, IDs, and country codes:

* jsDelivr CDN:
  ```text
  https://cdn.jsdelivr.net/gh/VindEi/public-dns-directory@data/providers.txt
  ```
* Raw GitHub:
  ```text
  https://raw.githubusercontent.com/VindEi/public-dns-directory/data/providers.txt
  ```

### 3. Lightweight Metadata Summary (`providers.json`)
A stripped-down JSON array containing only basic provider information and active profile IDs (without endpoint configs):

* jsDelivr CDN:
  ```text
  https://cdn.jsdelivr.net/gh/VindEi/public-dns-directory@data/providers.json
  ```
* Raw GitHub:
  ```text
  https://raw.githubusercontent.com/VindEi/public-dns-directory/data/providers.json
  ```

---

## JSON Structure

The full `index.json` payload matches this structure:

```json
{
  "lastUpdated": "2026-09-23T11:00:00.000Z",
  "count": 73,
  "providers": [
    {
      "id": "cloudflare",
      "name": "Cloudflare DNS",
      "website": "https://1.1.1.1",
      "country": "GLOBAL",
      "profiles": [
        {
          "id": "standard",
          "name": "Standard (Unfiltered)",
          "primaryCategory": "General",
          "tags": ["doh", "dot", "ipv4", "ipv6", "no-log"],
          "endpoints": {
            "primaryDns": "1.1.1.1",
            "secondaryDns": "1.0.0.1",
            "ipv6Primary": "2606:4700:4700::1111",
            "ipv6Secondary": "2606:4700:4700::1001",
            "dohUrl": "https://cloudflare-dns.com/dns-query",
            "dotHostname": "one.one.one.one"
          },
          "notes": "Fastest global Anycast resolver. Raw and unfiltered."
        }
      ]
    }
  ]
}
```

---

## How Testing Works

Every Sunday at 04:00 UTC (and on every pull request), GitHub Actions executes `scripts/test-resolvers.mjs`:

* **UDP 53:** Resolves `example.com` against target IPv4 endpoints (runs with retry backoff for rate-limited servers).
* **DoT:** Connects directly to port 853 on the declared hostname and verifies TLS certificates.
* **DoH:** Probes using native HTTP/2 (RFC 8484 GET with wireformat queries) and falls back to HTTP/1.1.
* **Private IPs:** Addresses in RFC 1918 space (like `10.x.x.x`) are automatically skipped during UDP probes so domestic Iranian bypass services do not break global runners.
* **Closed Telcos:** ISP recursors that drop non-subscriber traffic (like BT, Virgin Media, Airtel, and KPN) are logged as non-fatal warnings rather than hard CI failures.

---

## Adding a Provider

1. Fork the repo.
2. Add a new file in `providers/<provider-id>.json`. The filename must match the `id` field inside the file.
3. Make sure it adheres to `schema/provider.schema.json`.
4. Open a pull request. CI will test your endpoints automatically before merging.

---

## License

[MIT](LICENSE)