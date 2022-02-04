const mysql = require('mysql2/promise');
const config = require('./config/config');

const pool = mysql.createPool({
    host: config.db_host,
    port: config.db_port,
    user: config.db_id,
    password: config.db_pw,
    database: config.db_schema,
    connectionLimit: 10
});

module.exports = pool;