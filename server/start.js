// Ponto de entrada: restaura o banco da nuvem (se necessário) ANTES de abri-lo, e então liga o servidor.
'use strict';
require('./config'); // carrega .env
const path = require('node:path');
const cloud = require('./cloudbackup');

(async () => {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const dbFile = process.env.DB_FILE || path.join(dataDir, 'nexus.db');
  if (cloud.enabled()) {
    try {
      const r = await cloud.restoreIfNeeded(dbFile);
      console.log('[backup]', r.restored ? `banco restaurado da nuvem (${Math.ceil(r.bytes / 1024)} KB, cópia de ${r.at})` : r.skipped);
    } catch (e) {
      // não sobe com banco vazio se havia cópia e ela falhou: evita "perder" pedidos por engano
      console.error('[backup] FALHA ao restaurar:', e.message);
      console.error('Corrija a configuração (FIREBASE_SERVICE_ACCOUNT / APP_SECRET) e reinicie.');
      process.exit(1);
    }
  }
  require('./server').listen();
})();
