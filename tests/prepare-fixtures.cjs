const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../chatgpt-thread-navigator.user.js'), 'utf8');
for (const [platform, hostname] of [['claude','claude.ai'],['doubao','www.doubao.com']]) {
  // 仅为本地测试替换 hostname，使其选择与真实站点相同的适配器。
  fs.writeFileSync(path.join(__dirname, `fixture-${platform}.js`), source.replace('const SITE_HOST = location.hostname;', `const SITE_HOST = '${hostname}';`));
}
