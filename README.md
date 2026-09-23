# public-dns-directory

A directory of public, regional, and privacy-focused DNS servers.

Every provider is stored as an individual JSON file in `providers/`. A weekly GitHub Action tests each endpoint (UDP port 53, DoH, and DoT) and compiles all working resolvers into a single `index.json`.

---

## Disclaimer

I used AI to find and scrape most of these providers and their endpoints. While I have automated tests running weekly to verify that the servers actually respond, things change, servers shut down, and AI can get things wrong.

Use this at your own risk.

- I do not run, own, or manage any of these DNS servers.
- I am not responsible for anything that happens if you use them—whether your connection drops, your data gets logged, or your traffic gets redirected.
- Know what you are using. Some of these are regional or state-owned providers that enforce censorship; others are strict ad-blockers or privacy-first setups. Check their privacy policies and terms before pointing your router or device to them.

---

## Getting the Data

You can fetch the compiled, minified JSON directly:

```text
https://vindei.github.io/public-dns-directory/index.json
```

Or via CDN:

```text
https://cdn.jsdelivr.net/gh/VindEi/public-dns-directory@gh-pages/index.json
```

### JSON Format

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

Every Sunday at 04:00 UTC (and on every PR), GitHub Actions runs `scripts/test-resolvers.mjs`:

- **UDP 53:** Resolves `example.com` directly against the IPv4 endpoints.
- **DoT:** Connects to port 853 and validates the TLS certificate.
- **DoH:** Sends DNS queries over HTTP/2 (with HTTP/1.1 fallback) using RFC 8484 wireformat.
- **Intranet/Private IPs:** Addresses in private IP ranges (like `10.x.x.x`) are automatically skipped so domestic bypass networks don't break CI.
- **Closed Telcos:** ISP recursors that only allow their own paying subscribers to query them are treated as non-fatal warnings instead of hard failures.

---

## Adding a Provider

1. Fork the repo.
2. Add a new file in `providers/<provider-id>.json`. The filename must match the `id` field inside the file.
3. Make sure it follows `schema/provider.schema.json`.
4. Open a pull request. CI will test your endpoints automatically before merging.

---

## License

MIT
