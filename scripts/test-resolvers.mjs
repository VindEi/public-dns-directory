import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { Resolver } from "node:dns/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// Initialize Schema Validator
const ajv = new Ajv({ allErrors: true, validateSchema: false });
addFormats(ajv);

const schema = JSON.parse(
  fs.readFileSync("./schema/provider.schema.json", "utf8"),
);
const validate = ajv.compile(schema);

const providersDir = "./providers";
const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));

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
  const resolver = new Resolver({ timeout: 3500, tries: 1 });
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
        timeout: 4000,
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

async function testDoh(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    // 1. First try RFC 8484 GET with ?dns=<base64url> (Mandatory by standard)
    const separator = url.includes("?") ? "&" : "?";
    const getUrl = `${url}${separator}dns=${WIRE_QUERY_BASE64URL}`;

    let res = await fetch(getUrl, {
      method: "GET",
      headers: { accept: "application/dns-message" },
      signal: controller.signal,
    });

    if (res.ok) return;

    // 2. Fallback to POST with explicit Content-Length if GET returned 4xx/5xx
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/dns-message",
        accept: "application/dns-message",
        "content-length": String(DNS_WIRE_QUERY.length),
      },
      body: DNS_WIRE_QUERY,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Global Results Store
const failures = [];
let totalProbes = 0;
let passedProbes = 0;

console.log(`\n🚀 Testing ${files.length} DNS providers...\n`);

for (const file of files) {
  const filePath = path.join(providersDir, file);
  let data;

  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    failures.push({
      file,
      profile: "FILE",
      target: file,
      type: "JSON",
      error: err.message,
    });
    console.log(`❌ [PARSE ERROR] ${file}`);
    continue;
  }

  if (file !== `${data.id}.json`) {
    failures.push({
      file,
      profile: "FILE",
      target: data.id,
      type: "SCHEMA",
      error: `ID mismatch with filename`,
    });
  }

  if (!validate(data)) {
    failures.push({
      file,
      profile: "FILE",
      target: "schema",
      type: "SCHEMA",
      error: JSON.stringify(validate.errors[0]?.message),
    });
    console.log(`❌ [SCHEMA FAIL] ${file}`);
    continue;
  }

  let fileHasError = false;

  for (const profile of data.profiles) {
    const { endpoints } = profile;

    // Probing UDP 53
    for (const key of ["primaryDns", "secondaryDns"]) {
      const ip = endpoints[key];
      if (!ip || isPrivateIp(ip)) continue;

      totalProbes++;
      try {
        await testUdpDns(ip);
        passedProbes++;
      } catch (err) {
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

    // Probing DoT
    if (endpoints.dotHostname) {
      totalProbes++;
      try {
        await testDot(endpoints.dotHostname);
        passedProbes++;
      } catch (err) {
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

    // Probing DoH
    if (endpoints.dohUrl) {
      totalProbes++;
      try {
        await testDoh(endpoints.dohUrl);
        passedProbes++;
      } catch (err) {
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

  // Single clean line per provider
  if (fileHasError) {
    console.log(`❌ [FAIL] ${data.id}`);
  } else {
    console.log(`✅ [PASS] ${data.id}`);
  }
}

// ------------------- UX REPORTING SECTION -------------------

console.log("\n" + "=".repeat(105));
console.log(
  `📊 TEST COMPLETE: ${passedProbes}/${totalProbes} probes passed (${failures.length} errors across ${files.length} providers)`,
);
console.log("=".repeat(105) + "\n");

if (failures.length > 0) {
  console.log("📋 CONSOLIDATED FAILURE SUMMARY:\n");

  // Format a clean terminal table
  const colWidths = { file: 22, profile: 15, type: 10, target: 30, error: 22 };
  const pad = (str, len) =>
    str.length > len ? str.slice(0, len - 3) + "..." : str.padEnd(len);

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

  // If running inside GitHub Actions, push Markdown table to Job Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryRows = failures
      .map(
        (f) =>
          `| \`${f.file}\` | \`${f.profile}\` | **${f.type}** | \`${f.target}\` | ${f.error} |`,
      )
      .join("\n");
    const markdown = `
### ❌ Resolver Verification Failures (${failures.length} issues)

| Provider | Profile | Type | Target | Error |
| :--- | :--- | :--- | :--- | :--- |
${summaryRows}
`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  process.exit(1);
} else {
  console.log("✨ All resolvers passed connectivity tests successfully.\n");
  process.exit(0);
}
