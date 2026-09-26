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

index.sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  lastUpdated: new Date().toISOString(),
  count: index.length,
  providers: index
};
fs.writeFileSync(path.join(distDir, 'index.json'), JSON.stringify(payload));

const textList = index.map(p => `${p.name} [${p.id}] (${p.country})`).join('\n');
fs.writeFileSync(path.join(distDir, 'providers.txt'), textList + '\n');

const summaryList = index.map(p => ({
  id: p.id,
  name: p.name,
  website: p.website,
  country: p.country,
  profiles: p.profiles.map(pr => pr.id)
}));
fs.writeFileSync(path.join(distDir, 'providers.json'), JSON.stringify(summaryList, null, 2));

console.log(`Successfully built index.json, providers.txt, and providers.json (${index.length} providers)`);