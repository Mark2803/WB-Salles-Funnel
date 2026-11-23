// Разовый сбор данных из WB API (без запуска сайта).
// Запуск: npm run collect          — быстрый (воронка, остатки, цены, реклама)
//         npm run collect -- full  — полный (плюс отзывы, финотчёт, поиск)
import { config } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

const kind = process.argv.includes('full') ? 'full' : 'quick';
const db = openDb(config.dataDir);
console.log(`Сбор данных (${kind === 'full' ? 'полный' : 'быстрый'}), артикулов: ${config.trackedNmIds.length}. Это займёт несколько минут из-за лимитов WB.`);
const result = await runSync(db, { kind });
for (const d of result.details || []) {
  console.log(`${d.ok ? 'OK    ' : 'ОШИБКА'} ${d.label}${d.ok ? ` — ${JSON.stringify(d.result)}` : ` — ${d.error}`}`);
}
console.log(`Итог: ${result.status}`);
db.close();
process.exit(result.status === 'error' ? 1 : 0);
