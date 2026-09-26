import fs from "node:fs";
import path from "node:path";

const providersDir = "./providers";
const distDir = "./dist";

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const files = fs.readdirSync(providersDir).filter((f) => f.endsWith(".json"));
const index = [];

for (const file of files) {
  const content = JSON.parse(
    fs.readFileSync(path.join(providersDir, file), "utf8"),
  );
  index.push(content);
}

// Sort alphabetically by provider id
index.sort((a, b) => a.id.localeCompare(b.id));

console.log(
  `Building distribution bundles from ${index.length} verified providers...\n`,
);

// 1. Full minified index bundle
const payload = {
  lastUpdated: new Date().toISOString(),
  count: index.length,
  providers: index,
};
fs.writeFileSync(path.join(distDir, "index.json"), JSON.stringify(payload));
console.log(
  `[1/3] Generated dist/index.json (${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1)} KB)`,
);

// 2. Plain-text provider list (providers.txt)
const textList = index
  .map((p) => `${p.name} [${p.id}] (${p.country})`)
  .join("\n");
fs.writeFileSync(path.join(distDir, "providers.txt"), textList + "\n");
console.log(`[2/3] Generated dist/providers.txt (${index.length} lines)`);

// 3. Lightweight JSON metadata list (providers.json)
const summaryList = index.map((p) => ({
  id: p.id,
  name: p.name,
  website: p.website,
  country: p.country,
  profiles: p.profiles.map((pr) => pr.id),
}));
fs.writeFileSync(
  path.join(distDir, "providers.json"),
  JSON.stringify(summaryList, null, 2),
);
console.log(`[3/3] Generated dist/providers.json (metadata index)`);

console.log(`\nBuild complete: 3/3 targets generated.`);
