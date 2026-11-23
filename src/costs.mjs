// Себестоимость из Google Таблицы «Финансы V3», лист «Себестоимость» (колонки «Артикул», «Наименование», «Себестоимость»).
// Это тот же лист, который правится в Менеджменте (tea-master-team.ru/management/costs/) — единый источник.
// Связь с WB — по артикулу продавца (vendorCode), например SMOLA-SMILE-10,5.
import { nowIso, transaction } from './db.mjs';
import { createSheetsReader, sheetRange } from './google-sheets.mjs';

// Те же правила, что в Менеджменте: «165,35» → 165.35; «146,00%», «.», пусто → не число
export function toCost(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const s = value.replace(/\s/g, '').replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
}

const normArticle = (a) => String(a ?? '').trim().toUpperCase();

export function parseCostSheet(values) {
  const header = (values[0] ?? []).map((v) => String(v ?? '').trim());
  const articleCol = header.indexOf('Артикул');
  const nameCol = header.indexOf('Наименование');
  const costCol = header.indexOf('Себестоимость');
  if (articleCol === -1 || costCol === -1) throw new Error('На листе себестоимости нет колонок «Артикул» и «Себестоимость» в первой строке.');
  const map = new Map();
  for (const line of values.slice(1)) {
    const article = normArticle(line[articleCol]);
    if (!article) continue;
    map.set(article, { article: String(line[articleCol]).trim(), name: nameCol === -1 ? '' : String(line[nameCol] ?? '').trim(), cost: toCost(line[costCol]), raw: line[costCol] });
  }
  return map;
}

// Проставляет себестоимость отслеживаемым товарам по артикулу продавца
export function applyCosts(db, map) {
  const products = db.prepare('SELECT nm_id, vendor_code FROM products WHERE active = 1').all();
  const matched = [];
  const missing = [];
  const invalid = [];
  transaction(db, () => {
    const up = db.prepare("UPDATE products SET cost_per_unit = ?, cost_source = 'sheet', cost_updated_at = ? WHERE nm_id = ?");
    for (const p of products) {
      const row = p.vendor_code ? map.get(normArticle(p.vendor_code)) : null;
      if (!row) missing.push(p.vendor_code || String(p.nm_id));
      else if (row.cost == null || row.cost <= 0) invalid.push(`${row.article} («${row.raw ?? ''}»)`);
      else {
        up.run(row.cost, nowIso(), p.nm_id);
        matched.push(`${row.article}=${row.cost}`);
      }
    }
  });
  if (!matched.length && products.length) {
    throw new Error(`Ни один артикул не найден в листе себестоимости. Не найдены: ${missing.slice(0, 5).join(', ')}`);
  }
  return { matched: matched.length, missing, invalid };
}

export function createCostsSource(cfg) {
  const reader = createSheetsReader({ keyFile: cfg.googleKeyFile, spreadsheetId: cfg.costsSpreadsheetId });
  return { read: async () => parseCostSheet(await reader.getValues(sheetRange(cfg.costsSheet, 'A1:Z'))) };
}

// Шаг сбора данных: читает лист и обновляет себестоимость
export async function collectCosts(source, db) {
  return applyCosts(db, await source.read());
}
