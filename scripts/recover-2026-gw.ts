import { recoverItchJam } from './recover-itch-jam';

recoverItchJam({
  id: '2026-gw', base: 'https://itch.io/jam/viprpg-gw-2026', expectedRows: 41,
  name: 'VIPRPG GW祭 2026', type: 'gw', period: '2026/4/18 00:00–6/1 00:00 (JST)',
}).catch(error => { console.error(error); process.exitCode = 1; });
