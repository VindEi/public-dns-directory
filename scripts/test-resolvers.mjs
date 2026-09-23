import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { Resolver } from "node:dns/promises";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// Initialize Schema Validator
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const schemaPath = "./schema/provider.schema.json";
if (!fs.existsSync(schemaPath)) {
  console.error(`❌ Schema definition not found at: ${schemaPath}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const validate = ajv.compile(schema);

const providersDir = "./providers";
if (!fs.existsSync(providersDir)) {
  console.error(`❌ Providers directory not found at: ${providersDir}`);
  process.exit(1);
}

// 1. Strictly filter for .json files (ignores script.bat, filelist.txt, etc.)
const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));

let hasFailures = false;

// Pre-built wireformat DNS query for example.com (type A, IN class, RFC 1035)
const DNS_WIRE_QUERY = Buffer.from([
  0x12,
  0x34, // ID
  0x01,
  0x00, // Flags: standard query, RD=1
  0x00,
  0x01, // QDCOUNT: 1
  0x00,
  0x00, // ANCOUNT: 0
  0x00,
  0x00, // NSCOUNT: 0
  0x00,
  0x00, // ARCOUNT: 0
  0x07,
  0x65,
  0x78,
  0x61,
  0x6d,
  0x70,
  0x6c,
  0x65, // "example"
  0x03,
  0x63,
  0x6f,
  0x6d, // "com"
  0x00, // null terminator
  0x00,
  0x01, // Type A
  0x00,
  0x01, // Class IN
]);

/**
 * Checks if an IP belongs to RFC 1918 private/local non-routable address space.
 */
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

/**
 * UDP 53 Probe
 */
async function testUdpDns(ip) {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers([ip]);
  await resolver.resolve4("example.com");
}

/**
 * DNS-over-TLS (DoT port 853) Probe
 */
async function testDot(host, dotHostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: host,
        port: 853,
        servername: dotHostname || host,
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
      reject(new Error("TLS connection timed out (port 853)"));
    });
  });
}

/**
 * DNS-over-HTTPS (DoH RFC 8484) Probe
 */
async function testDoh(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/dns-message",
        accept: "application/dns-message",
      },
      body: DNS_WIRE_QUERY,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

console.log(
  `🚀 Starting verification across ${files.length} provider files...\n`,
);

for (const file of files) {
  const filePath = path.join(providersDir, file);
  console.log(`\n🔍 Verifying: ${file}`);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`  ❌ JSON Parse Error in ${file}: ${err.message}`);
    hasFailures = true;
    continue;
  }

  // 1. Filename must strictly match Provider ID
  const expectedFilename = `${data.id}.json`;
  if (file !== expectedFilename) {
    console.error(
      `  ❌ Filename mismatch: File is named '${file}', but 'id' is '${data.id}' (expected '${expectedFilename}')`,
    );
    hasFailures = true;
  }

  // 2. Schema Validation
  if (!validate(data)) {
    console.error(
      `  ❌ Schema validation failed for ${file}:\n`,
      validate.errors,
    );
    hasFailures = true;
    continue;
  }

  // 3. Profiles and Endpoints Verification
  for (const profile of data.profiles) {
    console.log(`  👉 Profile: [${profile.id}] ${profile.name}`);
    const { endpoints } = profile;

    // UDP 53 Probes
    for (const key of ["primaryDns", "secondaryDns"]) {
      const ip = endpoints[key];
      if (!ip) continue;

      // Safeguard: Skip RFC 1918 private/intranet addresses on CI
      if (isPrivateIp(ip)) {
        console.log(
          `    ⏭️ Skipping private/intranet IP probe (${key}: ${ip})`,
        );
        continue;
      }

      try {
        await testUdpDns(ip);
        console.log(`    ✅ UDP 53 (${key}: ${ip})`);
      } catch (err) {
        console.error(`    ❌ UDP 53 (${key}: ${ip}): ${err.message}`);
        hasFailures = true;
      }
    }

    // DoT Probes
    if (endpoints.dotHostname) {
      // If primary IP is private or null, fall back to dotHostname for TLS handshake
      const targetHost =
        endpoints.primaryDns && !isPrivateIp(endpoints.primaryDns)
          ? endpoints.primaryDns
          : endpoints.dotHostname;

      try {
        await testDot(targetHost, endpoints.dotHostname);
        console.log(
          `    ✅ DoT (${endpoints.dotHostname} via ${targetHost}:853)`,
        );
      } catch (err) {
        console.error(`    ❌ DoT (${endpoints.dotHostname}): ${err.message}`);
        hasFailures = true;
      }
    }

    // DoH Probes
    if (endpoints.dohUrl) {
      try {
        await testDoh(endpoints.dohUrl);
        console.log(`    ✅ DoH (${endpoints.dohUrl})`);
      } catch (err) {
        console.error(`    ❌ DoH (${endpoints.dohUrl}): ${err.message}`);
        hasFailures = true;
      }
    }
  }
}

// Final Exit Summary
if (hasFailures) {
  console.error("\n❌ Resolver verification failed. Check errors above.");
  process.exit(1);
} else {
  console.log(
    `\n✨ All ${files.length} provider files passed schema validation and connectivity health checks.`,
  );
  process.exit(0);
}
