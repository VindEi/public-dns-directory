import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Resolver } from 'node:dns/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const schema = JSON.parse(fs.readFileSync('./schema/provider.schema.json', 'utf8'));
const validate = ajv.compile(schema);

const providersDir = './providers';
const files = fs.readdirSync(providersDir).filter(f => f.endsWith('.json'));

let hasFailures = false;

// Pre-built wireformat DNS query for example.com (type A, IN class)
const DNS_WIRE_QUERY = Buffer.from([
  0x12, 0x34, // ID
  0x01, 0x00, // Flags: standard query, RD=1
  0x00, 0x01, // QDCOUNT: 1
  0x00, 0x00, // ANCOUNT: 0
  0x00, 0x00, // NSCOUNT: 0
  0x00, 0x00, // ARCOUNT: 0
  0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, // "example"
  0x03, 0x63, 0x6f, 0x6d, // "com"
  0x00,       // null terminator
  0x00, 0x01, // Type A
  0x00, 0x01  // Class IN
]);

async function testUdpDns(ip) {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers([ip]);
  await resolver.resolve4('example.com');
}

async function testDot(host, dotHostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: host,
      port: 853,
      servername: dotHostname || host,
      timeout: 4000,
      rejectUnauthorized: true
    }, () => {
      socket.end();
      resolve();
    });

    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

async function testDoh(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/dns-message',
        'accept': 'application/dns-message'
      },
      body: DNS_WIRE_QUERY,
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP status ${res.status}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

for (const file of files) {
  const filePath = path.join(providersDir, file);
  console.log(`\n🔍 Verifying: ${file}`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // 1. Schema Validation
  if (!validate(data)) {
    console.error(`  ❌ Schema validation failed:\n`, validate.errors);
    hasFailures = true;
    continue;
  }

  const { endpoints } = data;

  // 2. UDP 53 Probes
  for (const key of ['primaryDns', 'secondaryDns']) {
    const ip = endpoints[key];
    if (!ip) continue;
    try {
      await testUdpDns(ip);
      console.log(`  ✅ UDP 53 (${key}: ${ip})`);
    } catch (err) {
      console.error(`  ❌ UDP 53 (${key}: ${ip}): ${err.message}`);
      hasFailures = true;
    }
  }

  // 3. DoT Probes
  if (endpoints.dotHostname) {
    const targetHost = endpoints.primaryDns || endpoints.dotHostname;
    try {
      await testDot(targetHost, endpoints.dotHostname);
      console.log(`  ✅ DoT (${endpoints.dotHostname})`);
    } catch (err) {
      console.error(`  ❌ DoT (${endpoints.dotHostname}): ${err.message}`);
      hasFailures = true;
    }
  }

  // 4. DoH Probes
  if (endpoints.dohUrl) {
    try {
      await testDoh(endpoints.dohUrl);
      console.log(`  ✅ DoH (${endpoints.dohUrl})`);
    } catch (err) {
      console.error(`  ❌ DoH (${endpoints.dohUrl}): ${err.message}`);
      hasFailures = true;
    }
  }
}

if (hasFailures) {
  console.error('\n❌ Resolver testing failed.');
  process.exit(1);
} else {
  console.log('\n✨ All providers passed checks.');
}
