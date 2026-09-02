"use strict";

function mysqlConfigured(env = process.env) {
  return Boolean(env.MYSQL_URL || (env.MYSQL_USER && env.MYSQL_DATABASE));
}

function mysqlConfig(env = process.env, overrides = {}) {
  let connection;
  if (env.MYSQL_URL) {
    const url = new URL(env.MYSQL_URL);
    connection = {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, ""))
    };
  } else {
    connection = {
      host: env.MYSQL_HOST || "localhost",
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || "",
      password: env.MYSQL_PASSWORD || "",
      database: env.MYSQL_DATABASE || ""
    };
  }

  return {
    ...connection,
    charset: "utf8mb4",
    timezone: "Z",
    decimalNumbers: true,
    ...overrides
  };
}

module.exports = { mysqlConfigured, mysqlConfig };
