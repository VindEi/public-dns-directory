import fs from 'node:fs';
import path from 'node:path';

const providersDir = './providers';
const distDir = './dist';

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const files = fs.readdirSync(providersDir).filter(f => f.endsWith('.json'));
const index = [];

for (const file of files) {
  const content = JSON.parse(fs.readFileSync(path.join(providersDir, file), 'utf8'));
  index.push(content);
}

// Sort alphabetically by ID
index.sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  lastUpdated: new Date().toISOString(),
  count: index.length,
  providers: index
};

fs.writeFileSync(path.join(distDir, 'index.json'), JSON.stringify(payload));
console.log(`Successfully bundled ${index.length} providers into dist/index.json`);
