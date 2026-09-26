import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import https from "node:https";
import http2 from "node:http2";
import { Resolver } from "node:dns/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const CONCURRENCY_LIMIT = 10;

const ajv = new Ajv({ allErrors: true, validateSchema: false });
addFormats(ajv);

const schema = JSON.parse(
  fs.readFileSync("./schema/provider.schema.json", "utf8"),
);
const validate = ajv.compile(schema);

const providersDir = "./providers";
const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));

// Providers that restrict UDP port 53 or encryption to domestic lines or local subscribers
const SUBSCRIBER_OR_DOMESTIC_ONLY = new Set([
  "114dns",
  "airtel",
  "andrews-and-arnold",
  "arvancloud",
  "baidu",
  "begzar",
  "bt",
  "chunghwa-telecom",
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
  "yandex",
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
  const resolver = new Resolver({ timeout: 3500, tries: 2 });
  resolver.setServers([ip]);
  try {
    await resolver.resolve4("example.com");
  } catch (err) {
    await new Promise((r) => setTimeout(r, 500));
    await resolver.resolve4("example.com");
  }
}

async function testDot(dotHostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: dotHostname,
        port: 853,
        servername: dotHostname,
        timeout: 4500,
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

function testDohInternal(urlStr) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const url = new URL(urlStr);

    const client = http2.connect(url.origin, {
      timeout: 5000,
      servername: url.hostname,
      rejectUnauthorized: false,
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

    req.setTimeout(5000, () => {
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

function testDohHttp1(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const separator = urlStr.includes("?") ? "&" : "?";
    const queryPath = `${url.pathname}${separator}dns=${WIRE_QUERY_BASE64URL}`;

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: queryPath,
        method: "GET",
        headers: {
          accept: "application/dns-message",
          "user-agent": "Mozilla/5.0 (compatible; PublicDNSDirectoryCheck/1.0)",
        },
        rejectUnauthorized: false,
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP/1.1 timeout"));
    });

    req.on("error", reject);
    req.end();
  });
}

async function testDoh(urlStr) {
  try {
    await testDohInternal(urlStr);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 600));
    await testDohInternal(urlStr);
  }
}

const failures = [];
const warnings = [];
let totalProbes = 0;
let passedProbes = 0;
let completedFiles = 0;

async function testProviderFile(file) {
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
    completedFiles++;
    console.log(
      `[${String(completedFiles).padStart(2, " ")}/${files.length}] [PARSE ERROR] ${file}`,
    );
    return;
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
    completedFiles++;
    console.log(
      `[${String(completedFiles).padStart(2, " ")}/${files.length}] [SCHEMA FAIL] ${file}`,
    );
    return;
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

  completedFiles++;
  const progress = `${completedFiles}/${files.length}`.padEnd(7, " ");
  const targetId = data.id.padEnd(25, " ");
  if (fileHasError) {
    console.log(`${progress} ${targetId} [FAIL]`);
  } else {
    console.log(`${progress} ${targetId} [PASS]`);
  }
}

async function runPool(items, limit, workerFn) {
  const pool = new Set();
  for (const item of items) {
    const promise = Promise.resolve().then(() => workerFn(item));
    pool.add(promise);
    const clean = () => pool.delete(promise);
    promise.then(clean, clean);
    if (pool.size >= limit) {
      await Promise.race(pool);
    }
  }
  return Promise.all(pool);
}

// Main Execution
console.log(
  `\nTesting ${files.length} DNS providers (${CONCURRENCY_LIMIT} concurrent workers)...\n`,
);
const startTime = Date.now();

await runPool(files, CONCURRENCY_LIMIT, testProviderFile);

const duration = ((Date.now() - startTime) / 1000).toFixed(1);

failures.sort((a, b) => a.file.localeCompare(b.file));
warnings.sort((a, b) => a.file.localeCompare(b.file));

console.log("\n" + "=".repeat(105));
console.log(
  `PROBES COMPLETE: ${passedProbes}/${totalProbes} passed in ${duration}s (${failures.length} hard failures, ${warnings.length} warnings)`,
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
