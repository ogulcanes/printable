// Veritabanı erişim katmanı — PostgreSQL (Supabase).
//
// Uygulama SQLite + better-sqlite3 ile yazılmıştı: senkron ve SQLite lehçesi.
// Supabase Postgres'tir ve asenkrondur. Bu dosya iki farkı da tek yerde emer:
//
//   1) Asenkron  : better-sqlite3'ün prepare().get/all/run şekli korunur,
//                  çağrı noktalarında yalnızca `await` vardır.
//   2) Lehçe     : `?` ve `@isim` parametreleri Postgres'in `$1, $2` biçimine
//                  çevrilir; INSERT'lere lastInsertRowid için RETURNING eklenir.
//
//   Yerel geliştirme : PGlite (kurulum gerektirmeyen gömülü Postgres, data/pgdata)
//   Üretim (Supabase): DATABASE_URL ile gerçek Postgres
//
// Tek fark ortam değişkeni; SQL aynı.

const path = require("path");

const CONNECTION = process.env.DATABASE_URL || "";
const usingSupabase = Boolean(CONNECTION);

/* Postgres bazı sayısal tipleri STRING döndürür ve bu sessiz hatalara yol açar:
   - int8  (COUNT(*))      → "0" gelirse `if (!count)` yanlış çalışır, seed atlanır
   - numeric (ROUND/AVG)   → "4.0" gelirse puan sayı değil metin olur
   İkisini de sayıya çeviriyoruz. */
const NUMERIC_OIDS = { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v) };

let client;          // { query(sql, params) -> { rows, rowCount } }
let readyPromise;

async function connect() {
  if (usingSupabase) {
    const pg = require("pg");
    Object.entries(NUMERIC_OIDS).forEach(([oid, parser]) => pg.types.setTypeParser(Number(oid), parser));
    // Supabase bağlantıları TLS ister; havuz serverless'ta küçük tutulur.
    const pool = new pg.Pool({
      connectionString: CONNECTION,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000
    });
    client = {
      query: (sql, params) => pool.query(sql, params),
      begin: () => pool.connect(),
      pool
    };
    return;
  }

  const { PGlite } = require("@electric-sql/pglite");
  const store = new PGlite(path.join(__dirname, "data", "pgdata"), {
    parsers: NUMERIC_OIDS
  });
  await store.waitReady;
  client = {
    query: (sql, params) => store.query(sql, params || []),
    begin: null,                       // PGlite tek bağlantılı; BEGIN/COMMIT ile yürütülür
    raw: store
  };
}

const ready = () => (readyPromise ||= connect());

/* ---------- parametre çevirisi ----------
   `?`      → $1, $2 ...        (sırayla)
   `@isim`  → $n                (nesneden sıraya göre)
   String ve dollar-quoted bloklar atlanır ki içlerindeki ? bozulmasın. */
function translate(sql, args) {
  const named = args.length === 1 && args[0] !== null && typeof args[0] === "object"
    && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0]) && !(args[0] instanceof Date);

  const params = [];
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {                       // string / tanımlayıcı
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) { j += 2; continue; }
        if (sql[j] === quote) break;
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "?" && !named) {
      params.push(args[params.length]);
      out += `$${params.length}`;
      i += 1;
      continue;
    }
    if (c === "@" && named) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        const value = args[0][m[1]];
        params.push(value === undefined ? null : value);
        out += `$${params.length}`;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }

  if (!named) {
    // Pozisyonel: kalan argümanları da (ör. hiç ? yoksa) yok say.
    return [out, params.map((v) => (v === undefined ? null : v))];
  }
  return [out, params];
}

// id sütunu OLMAYAN tablolar — bunlara RETURNING id eklenemez.
const NO_ID_TABLES = new Set([
  "product_colors", "product_categories", "campaign_products", "campaign_categories"
]);

// INSERT ise ve çağıran lastInsertRowid bekliyorsa RETURNING id ekle.
function withReturning(sql) {
  if (!/^\s*INSERT\s+INTO/i.test(sql)) return sql;
  if (/\bRETURNING\b/i.test(sql)) return sql;
  const m = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
  if (m && NO_ID_TABLES.has(m[1].toLowerCase())) return sql;
  return `${sql.replace(/;\s*$/, "")} RETURNING id`;
}

function makeStatement(runner, sql) {
  return {
    async get(...args) {
      await ready();
      const [text, params] = translate(sql, args);
      const result = await runner(text, params);
      return result.rows[0];
    },
    async all(...args) {
      await ready();
      const [text, params] = translate(sql, args);
      const result = await runner(text, params);
      return result.rows;
    },
    async run(...args) {
      await ready();
      const [text, params] = translate(withReturning(sql), args);
      const result = await runner(text, params);
      return {
        changes: result.rowCount ?? result.affectedRows ?? 0,
        lastInsertRowid: result.rows?.[0]?.id
      };
    }
  };
}

const runOn = (target) => (text, params) => target.query(text, params);

const db = {
  prepare: (sql) => makeStatement((text, params) => client.query(text, params), sql),

  async exec(sql) {
    await ready();
    // Çok ifadeli blok (şema kurulumu).
    if (client.raw) return client.raw.exec(sql);
    return client.query(sql);
  },

  /* Transaction. Geri çağırıma tx tutamacı verilir; içerideki her sorgu aynı
     bağlantıda ve aynı transaction'da gider:

       await db.transaction(async (tx) => {
         await tx.prepare("INSERT ...").run({ ... });
       });                                                                   */
  async transaction(fn) {
    await ready();

    // Supabase: havuzdan tek bağlantı al, onun üzerinde yürüt.
    if (client.begin) {
      const conn = await client.begin();
      try {
        await conn.query("BEGIN");
        const result = await fn({ prepare: (sql) => makeStatement(runOn(conn), sql) });
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        try { await conn.query("ROLLBACK"); } catch { /* bağlantı zaten kopmuş olabilir */ }
        throw error;
      } finally {
        conn.release();
      }
    }

    // PGlite: tek bağlantı, doğrudan BEGIN/COMMIT.
    await client.query("BEGIN");
    try {
      const result = await fn({ prepare: (sql) => makeStatement((t, p) => client.query(t, p), sql) });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* yoksay */ }
      throw error;
    }
  },

  ready,
  usingSupabase,

  /* PGlite (yerel geliştirme) gömülü bir Postgres'tir ve süreç zorla
     öldürüldüğünde veri klasörü bozulabilir. Düzgün kapanışta dosyaları
     kapatıyoruz. Supabase tarafında havuzu serbest bırakır. */
  async close() {
    if (!readyPromise) return;
    try {
      if (client?.raw?.close) await client.raw.close();
      else if (client?.pool?.end) await client.pool.end();
    } catch { /* kapanışta hatayı yutuyoruz */ }
  }
};

module.exports = db;
