import { recoverItchJam } from './recover-itch-jam';

recoverItchJam({
  id: '2026-summer', base: 'https://itch.io/jam/viprpg-summer-2026', expectedRows: 37,
  name: 'VIPRPG 夏の陣 2026', type: 'summer', period: '2026/7/25 00:00–9/6 00:00 (JST)',
}).catch(error => { console.error(error); process.exitCode = 1; });
