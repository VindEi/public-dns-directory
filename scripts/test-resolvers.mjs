import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import http2 from "node:http2";
import { Resolver } from "node:dns/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, validateSchema: false });
addFormats(ajv);

const schema = JSON.parse(
  fs.readFileSync("./schema/provider.schema.json", "utf8"),
);
const validate = ajv.compile(schema);

const providersDir = "./providers";
const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));

// Providers that restrict UDP port 53 to domestic lines or local subscribers
const SUBSCRIBER_OR_DOMESTIC_ONLY = new Set([
  "114dns",
  "airtel",
  "andrews-and-arnold",
  "arvancloud",
  "baidu",
  "begzar",
  "bt",
  "dnspod",
  "fdn",
  "kpn",
  "optus",
  "orange-france",
  "puntcat",
  "shecan",
  "shelter-dns",
  "singtel",
  "starhub",
  "telefonica",
  "telstra",
  "twnic-quad101",
  "virgin-media",
]);

// RFC 1035 wireformat query for example.com (A record, IN class)
const DNS_WIRE_QUERY = Buffer.from([
  0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07,
  0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00,
  0x01, 0x00, 0x01,
]);

const WIRE_QUERY_BASE64URL = DNS_WIRE_QUERY.toString("base64url");

function isPrivateIp(ip) {
  if (!ip) return false;
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^(172\.(1[6-9]|2[0-9]|3[0-1]))\./.test(ip) ||
    ip === "127.0.0.1" ||
    ip === "::1"
  );
}

async function testUdpDns(ip) {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers([ip]);
  await resolver.resolve4("example.com");
}

async function testDot(dotHostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: dotHostname,
        port: 853,
        servername: dotHostname,
        timeout: 5000,
        rejectUnauthorized: true,
      },
      () => {
        socket.end();
        resolve();
      },
    );

    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Port 853 timeout"));
    });
  });
}

async function testDoh(urlStr) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const url = new URL(urlStr);

    const client = http2.connect(url.origin, {
      timeout: 6000,
      servername: url.hostname,
    });

    client.on("error", () => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        testDohHttp1(urlStr).then(resolve).catch(reject);
      }
    });

    client.on("timeout", () => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        testDohHttp1(urlStr).then(resolve).catch(reject);
      }
    });

    const path = `${url.pathname}${url.search ? url.search + "&" : "?"}dns=${WIRE_QUERY_BASE64URL}`;
    const req = client.request({
      [http2.constants.HTTP2_HEADER_SCHEME]: "https",
      [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_GET,
      [http2.constants.HTTP2_HEADER_PATH]: path,
      accept: "application/dns-message",
      "user-agent": "Mozilla/5.0 (compatible; PublicDNSDirectoryCheck/1.0)",
    });

    req.setTimeout(6000, () => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        client.destroy();
        testDohHttp1(urlStr).then(resolve).catch(reject);
      }
    });

    req.on("response", (headers) => {
      if (resolved) return;
      resolved = true;
      const status = Number(headers[http2.constants.HTTP2_HEADER_STATUS]);
      client.destroy();
      if (status >= 200 && status < 400) {
        resolve();
      } else {
        reject(new Error(`HTTP ${status}`));
      }
    });

    req.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        testDohHttp1(urlStr).then(resolve).catch(reject);
      }
    });

    req.end();
  });
}

async function testDohHttp1(urlStr) {
  const separator = urlStr.includes("?") ? "&" : "?";
  const getUrl = `${urlStr}${separator}dns=${WIRE_QUERY_BASE64URL}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(getUrl, {
      method: "GET",
      headers: {
        accept: "application/dns-message",
        "user-agent": "Mozilla/5.0 (compatible; PublicDNSDirectoryCheck/1.0)",
      },
      signal: controller.signal,
    });

    if (res.status >= 200 && res.status < 400) return;
    throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

const failures = [];
const warnings = [];
let totalProbes = 0;
let passedProbes = 0;

console.log(`\nTesting ${files.length} DNS providers...\n`);

for (const file of files) {
  const filePath = path.join(providersDir, file);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    failures.push({
      file,
      profile: "FILE",
      type: "JSON",
      target: file,
      error: err.message,
    });
    console.log(`[PARSE ERROR] ${file}`);
    continue;
  }

  if (file !== `${data.id}.json`) {
    failures.push({
      file,
      profile: "FILE",
      type: "SCHEMA",
      target: data.id,
      error: "ID mismatch with filename",
    });
  }

  if (!validate(data)) {
    failures.push({
      file,
      profile: "FILE",
      type: "SCHEMA",
      target: "schema",
      error: JSON.stringify(validate.errors[0]?.message),
    });
    console.log(`[SCHEMA FAIL] ${file}`);
    continue;
  }

  let fileHasError = false;
  const isSubscriberRestricted = SUBSCRIBER_OR_DOMESTIC_ONLY.has(data.id);

  for (const profile of data.profiles) {
    const { endpoints } = profile;

    // UDP 53 Probes
    for (const key of ["primaryDns", "secondaryDns"]) {
      const ip = endpoints[key];
      if (!ip || isPrivateIp(ip)) continue;

      totalProbes++;
      try {
        await testUdpDns(ip);
        passedProbes++;
      } catch (err) {
        if (isSubscriberRestricted) {
          warnings.push({
            file,
            profile: profile.id,
            target: ip,
            type: "UDP 53",
            error: "SUBSCRIBER/GEO-RESTRICTED",
          });
        } else {
          fileHasError = true;
          failures.push({
            file,
            profile: profile.id,
            target: ip,
            type: "UDP 53",
            error: err.code || err.message,
          });
        }
      }
    }

    // DoT Probes
    if (endpoints.dotHostname) {
      totalProbes++;
      try {
        await testDot(endpoints.dotHostname);
        passedProbes++;
      } catch (err) {
        if (isSubscriberRestricted) {
          warnings.push({
            file,
            profile: profile.id,
            target: endpoints.dotHostname,
            type: "DoT 853",
            error: "GEO-RESTRICTED",
          });
        } else {
          fileHasError = true;
          failures.push({
            file,
            profile: profile.id,
            target: endpoints.dotHostname,
            type: "DoT 853",
            error: err.code || err.message,
          });
        }
      }
    }

    // DoH Probes
    if (endpoints.dohUrl) {
      totalProbes++;
      try {
        await testDoh(endpoints.dohUrl);
        passedProbes++;
      } catch (err) {
        if (isSubscriberRestricted) {
          warnings.push({
            file,
            profile: profile.id,
            target: endpoints.dohUrl,
            type: "DoH",
            error: "GEO-RESTRICTED",
          });
        } else {
          fileHasError = true;
          failures.push({
            file,
            profile: profile.id,
            target: endpoints.dohUrl,
            type: "DoH",
            error: err.message,
          });
        }
      }
    }
  }

  if (fileHasError) {
    console.log(`[FAIL] ${data.id}`);
  } else {
    console.log(`[PASS] ${data.id}`);
  }
}

console.log("\n" + "=".repeat(105));
console.log(
  `PROBES COMPLETE: ${passedProbes}/${totalProbes} passed (${failures.length} hard failures, ${warnings.length} warnings)`,
);
console.log("=".repeat(105) + "\n");

const colWidths = { file: 24, profile: 15, type: 10, target: 32, error: 22 };
const pad = (str, len) =>
  str.length > len ? str.slice(0, len - 3) + "..." : str.padEnd(len);

if (warnings.length > 0) {
  console.log("SUBSCRIBER-ONLY / REGION-RESTRICTED WARNINGS (NON-FATAL):\n");
  console.log(
    pad("PROVIDER FILE", colWidths.file) +
      pad("PROFILE", colWidths.profile) +
      pad("TYPE", colWidths.type) +
      pad("TARGET", colWidths.target) +
      "NOTICE",
  );
  console.log("-".repeat(105));
  for (const w of warnings) {
    console.log(
      pad(w.file, colWidths.file) +
        pad(w.profile, colWidths.profile) +
        pad(w.type, colWidths.type) +
        pad(w.target, colWidths.target) +
        w.error,
    );
  }
  console.log("-".repeat(105) + "\n");
}

if (failures.length > 0) {
  console.log("CRITICAL FAILURES (REQUIRING CONFIG FIX):\n");
  console.log(
    pad("PROVIDER FILE", colWidths.file) +
      pad("PROFILE", colWidths.profile) +
      pad("TYPE", colWidths.type) +
      pad("TARGET", colWidths.target) +
      "ERROR",
  );
  console.log("-".repeat(105));
  for (const f of failures) {
    console.log(
      pad(f.file, colWidths.file) +
        pad(f.profile, colWidths.profile) +
        pad(f.type, colWidths.type) +
        pad(f.target, colWidths.target) +
        f.error,
    );
  }
  console.log("-".repeat(105) + "\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryRows = failures
      .map(
        (f) =>
          `| \`${f.file}\` | \`${f.profile}\` | **${f.type}** | \`${f.target}\` | ${f.error} |`,
      )
      .join("\n");
    const markdown = `
### Resolver Verification Failures (${failures.length})

| Provider | Profile | Type | Target | Error |
| :--- | :--- | :--- | :--- | :--- |
${summaryRows}
`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  process.exit(1);
} else {
  console.log("All public resolvers verified successfully.\n");
  process.exit(0);
}
