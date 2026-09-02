// Veritabanı erişim katmanı — PostgreSQL (Supabase), MySQL/MariaDB (Alastyr)
// ve yerel PGlite.
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
//   Üretim (Alastyr) : MYSQL_URL ile MySQL/MariaDB
//
// Tek fark ortam değişkeni; SQL aynı.

const path = require("path");
const { mysqlConfigured, mysqlConfig } = require("./mysql-config");

const POSTGRES_CONNECTION = process.env.DATABASE_URL || "";
const dialect = mysqlConfigured() ? "mysql" : POSTGRES_CONNECTION ? "postgres" : "pglite";
const usingSupabase = dialect === "postgres";
const usingMysql = dialect === "mysql";

/* Postgres bazı sayısal tipleri STRING döndürür ve bu sessiz hatalara yol açar:
   - int8  (COUNT(*))      → "0" gelirse `if (!count)` yanlış çalışır, seed atlanır
   - numeric (ROUND/AVG)   → "4.0" gelirse puan sayı değil metin olur
   İkisini de sayıya çeviriyoruz. */
const NUMERIC_OIDS = { 20: (v) => parseInt(v, 10), 1700: (v) => parseFloat(v) };

let client;          // { query(sql, params) -> { rows, rowCount } }
let readyPromise;

/* MariaDB'de KEY ayırılmış bir sözcüktür. SQL metnindeki gerçek tanımlayıcıları
   tırnak içine alırken string ve yorumların içini değiştirmiyoruz. */
function quoteMysqlKey(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) { j += 2; continue; }
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === quote) { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end === -1) return out + sql.slice(i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const next = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, next);
      i = next;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
    if (match) {
      out += match[0].toLowerCase() === "key" ? "`key`" : match[0];
      i += match[0].length;
      continue;
    }
    out += c;
    i += 1;
  }
  // Buradaki KEY sözcükleri sütun adı değil, MySQL söz diziminin parçasıdır.
  return out
    .replace(/\bPRIMARY\s+`key`/gi, "PRIMARY KEY")
    .replace(/\bFOREIGN\s+`key`/gi, "FOREIGN KEY")
    .replace(/\bUNIQUE\s+`key`/gi, "UNIQUE KEY")
    .replace(/\bDUPLICATE\s+`key`/gi, "DUPLICATE KEY");
}

/* Uygulamadaki SQL'in büyük bölümü zaten iki motorda da aynıdır. Burada yalnız
   PostgreSQL'e özgü küçük lehçe farklarını MariaDB karşılıklarına çeviriyoruz.
   Böylece iş kuralları ve API rotaları iki ayrı koda bölünmüyor. */
function mysqlSql(sql) {
  let out = String(sql);

  // Şema tipleri.
  out = out
    .replace(/\bINTEGER\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY\b/gi, "INT AUTO_INCREMENT PRIMARY KEY")
    .replace(/\bTIMESTAMPTZ\b/gi, "DATETIME")
    .replace(/\bREAL\b/gi, "DOUBLE")
    // AUTO_INCREMENT sütununa açık id yazmak MySQL'de ek anahtar sözcük istemez.
    .replace(/\s+OVERRIDING\s+SYSTEM\s+VALUE\b/gi, "");

  // Uzun metin ve URL alanları VARCHAR(255)'e kırpılmamalı.
  const longColumns = [
    "address", "billing_address", "campaign_summary", "canonical", "contact_address",
    "content", "cost_inputs", "customization_data", "description", "image_path",
    "inputs", "legal_address", "logo_path", "media_url", "message", "notes",
    "og_description", "og_image", "payment_failure_message", "return_address",
    "shipping_address", "social_links"
  ].join("|");
  out = out.replace(new RegExp(`^(\\s*(?:${longColumns})\\s+)TEXT\\b`, "gim"), "$1LONGTEXT");
  out = out
    .replace(/^(\s*(?:key|slug|code|order_number|payment_reference|token_hash|username|scale)\s+)TEXT\b/gim, "$1VARCHAR(191)")
    .replace(/\bTEXT\b/gi, "VARCHAR(255)");
  // MySQL/MariaDB sürümleri TEXT/LONGTEXT varsayılanlarında farklı davranır.
  // Uygulama bu alanı her INSERT'te doldurduğu için şemadaki boş varsayılanı
  // kaldırmak en taşınabilir karşılıktır.
  out = out.replace(/\bLONGTEXT\s+NOT\s+NULL\s+DEFAULT\s+''/gi, "LONGTEXT NOT NULL");

  // information_schema'da PostgreSQL'in public şeması yerine etkin MySQL DB'si.
  out = out.replace(/table_schema\s*=\s*'public'/gi, "table_schema = DATABASE()");

  // MariaDB kısmi indeks desteklemez. NULL değerler UNIQUE indekste birden çok
  // kez bulunabildiği için WHERE koşulunu kaldırmak aynı iş kuralını korur.
  out = out.replace(
    /(CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+[\s\S]*?\([^;]+?\))\s+WHERE\s+[^;]+(?:;|$)/gi,
    "$1"
  );

  // MariaDB CREATE INDEX IF NOT EXISTS kabul eder; Alastyr'ın kesin motor
  // sürümünden bağımsız kalmak için Oracle MySQL 8 ile de geçerli biçim.
  out = out.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, "CREATE $1INDEX");

  // PostgreSQL upsert -> MariaDB upsert.
  if (/\bON\s+CONFLICT\b/i.test(out)) {
    if (/\bDO\s+NOTHING\b/i.test(out)) {
      out = out.replace(/\bINSERT\s+INTO\b/gi, "INSERT IGNORE INTO");
      out = out.replace(/\s+ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+NOTHING\b/gi, "");
    } else {
      out = out.replace(/\s+ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\s+/gi, " ON DUPLICATE KEY UPDATE ");
      out = out.replace(/\bEXCLUDED\.([A-Za-z_][A-Za-z0-9_]*)\b/gi, "VALUES($1)");
      // PostgreSQL upsert güncellemesine WHERE ekleyebilir; MySQL ekleyemez.
      // Revizyon kilidinde aynı etkiyi koşullu atamayla ve affectedRows=0 ile
      // koruyoruz.
      out = out.replace(
        /value\s*=\s*VALUES\(value\)\s+WHERE\s+app_meta\.value\s*<>\s*VALUES\(value\)/gi,
        "value = IF(app_meta.value <> VALUES(value), VALUES(value), app_meta.value)"
      );
    }
  }

  // PostgreSQL cast ve interval biçimleri.
  out = out
    .replace(/(COUNT\s*\(\s*\*\s*\)|SUM\s*\([^)]*\))::int\b/gi, "CAST($1 AS SIGNED)")
    .replace(/::numeric\b/gi, "")
    .replace(/([A-Za-z_][A-Za-z0-9_.]*)::date\b/gi, "DATE($1)")
    .replace(/NOW\(\)\s*\+\s*INTERVAL\s*'([0-9]+)\s+minutes?'/gi, "DATE_ADD(NOW(), INTERVAL $1 MINUTE)")
    // MySQL'de DESC sıralama NULL değerleri zaten sona koyar.
    .replace(/\s+NULLS\s+LAST\b/gi, "");

  return quoteMysqlKey(out);
}

function splitMysqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  const source = String(sql);

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && next) {
        current += next;
        i += 1;
      } else if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      current += char + next;
      i += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += char + next;
      i += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function mysqlQuery(target, sql, params) {
  const [result] = await target.query(mysqlSql(sql), params || []);
  const rows = Array.isArray(result) ? result : [];
  return {
    rows,
    rowCount: result?.affectedRows ?? rows.length,
    affectedRows: result?.affectedRows ?? 0,
    insertId: result?.insertId
  };
}

async function connect() {
  if (usingMysql) {
    const mysql = require("mysql2/promise");
    const pool = mysql.createPool(mysqlConfig(process.env, {
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: true
    }));
    await pool.query("SELECT 1");
    client = {
      query: (sql, params) => mysqlQuery(pool, sql, params),
      begin: async () => {
        const conn = await pool.getConnection();
        return {
          query: (sql, params) => mysqlQuery(conn, sql, params),
          release: () => conn.release()
        };
      },
      pool
    };
    return;
  }

  if (usingSupabase) {
    const pg = require("pg");
    Object.entries(NUMERIC_OIDS).forEach(([oid, parser]) => pg.types.setTypeParser(Number(oid), parser));
    // Supabase bağlantıları TLS ister; havuz serverless'ta küçük tutulur.
    /* Zaman aşımları olmadan basarısiz bir baglanti sonsuza kadar bekliyor:
       istek asla yanit vermiyor, log'da da hata görünmüyor. Kısa timeout'lar
       sessiz beklemeyi net bir hataya çeviriyor. */
    const pool = new pg.Pool({
      connectionString: POSTGRES_CONNECTION,
      ssl: { rejectUnauthorized: false },
      // 3 fazla dardı: es zamanli istekler siraya girip baglanti zaman asimina
      // ugruyordu. Supabase pooler istemci basina 200 baglantiya izin veriyor.
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 15_000,
      query_timeout: 15_000
    });
    pool.on("error", (error) => console.error("Postgres havuz hatası:", error.message));
    client = {
      query: (sql, params) => pool.query(sql, params),
      begin: () => pool.connect(),
      pool
    };
    return;
  }

  const { PGlite } = require("@electric-sql/pglite");
  // Entegrasyon testleri gerçek yerel veriyi kirletmeden ayrı bir PGlite klasörü
  // kullanabilir. Üretimde DATABASE_URL varken bu yol zaten devreye girmez.
  const localStorePath = process.env.PGLITE_DATA_DIR
    ? path.resolve(process.env.PGLITE_DATA_DIR)
    : path.join(__dirname, "data", "pgdata");
  const store = new PGlite(localStorePath, {
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
      out += usingMysql ? "?" : `$${params.length}`;
      i += 1;
      continue;
    }
    if (c === "@" && named) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        const value = args[0][m[1]];
        params.push(value === undefined ? null : value);
        out += usingMysql ? "?" : `$${params.length}`;
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
  "product_colors", "product_categories", "campaign_products", "campaign_categories",
  "app_meta"
]);

// INSERT ise ve çağıran lastInsertRowid bekliyorsa RETURNING id ekle.
function withReturning(sql) {
  if (usingMysql) return sql;
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
        lastInsertRowid: result.rows?.[0]?.id ?? result.insertId
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
    if (usingMysql) {
      // Oracle MySQL CREATE INDEX IF NOT EXISTS desteklemez. Şema kurulumu bir
      // hatadan sonra tekrarlandığında daha önce oluşmuş indeks/sütun yüzünden
      // takılmaması için DDL bloklarını tek tek ve idempotent yürütüyoruz.
      const statements = splitMysqlStatements(sql);
      let last;
      for (const statement of statements) {
        try {
          last = await client.query(statement);
        } catch (error) {
          if (!["ER_DUP_KEYNAME", "ER_DUP_FIELDNAME"].includes(error.code)) throw error;
        }
      }
      return last;
    }
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
  usingMysql,
  dialect,

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
