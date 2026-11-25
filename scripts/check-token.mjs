// Проверка токена WB: срок действия, доступные категории, режим «только чтение».
// Токен читается из .env и на экран не выводится.
import { config } from '../src/config.mjs';

const NEEDED = { 1: 'Контент (размеры упаковки)', 2: 'Аналитика', 3: 'Цены и скидки', 6: 'Продвижение', 7: 'Вопросы и отзывы', 13: 'Финансы' };

if (!config.wbToken) {
  console.error('WB_API_TOKEN не задан в .env');
  process.exit(1);
}
let payload;
try {
  payload = JSON.parse(Buffer.from(config.wbToken.split('.')[1], 'base64url').toString('utf8'));
} catch {
  console.error('Токен не похож на токен WB (JWT). Скопируйте его заново.');
  process.exit(1);
}
const exp = payload.exp ? new Date(payload.exp * 1000) : null;
console.log(`Тип токена: ${{ 1: 'базовый', 2: 'тестовый', 3: 'персональный', 4: 'сервисный' }[payload.acc] || 'неизвестно'}`);
if (exp) console.log(`Действует до: ${exp.toLocaleString('ru-RU')}${exp < new Date() ? ' — ИСТЁК!' : ''}`);
const s = Number(payload.s || 0);
const has = (bit) => (s & (1 << bit)) !== 0;
let ok = true;
for (const [bit, name] of Object.entries(NEEDED)) {
  const yes = has(Number(bit));
  if (!yes) ok = false;
  console.log(`${yes ? 'есть ' : 'НЕТ  '} ${name}`);
}
console.log(has(30) ? 'Режим: только чтение — хорошо' : 'Внимание: токен с правом записи. Безопаснее создать токен «Только чтение».');
if (payload.acc === 2) console.log('Это тестовый токен — он работает только с песочницей WB, реальных данных не будет.');
process.exit(ok ? 0 : 1);
