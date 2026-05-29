const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function q1(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}
async function run(sql, params = []) {
  return pool.query(sql, params);
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'employee',
      daily_minutes INTEGER NOT NULL DEFAULT 480,
      active INTEGER NOT NULL DEFAULT 1,
      start_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS time_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      clock_in TIMESTAMP NOT NULL,
      clock_out TIMESTAMP,
      worked_minutes INTEGER,
      record_date DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adjustments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      minutes INTEGER NOT NULL,
      reason TEXT NOT NULL,
      type TEXT NOT NULL,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS hr_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
  `);

  const existing = await q1('SELECT id FROM hr_users WHERE username = $1', ['admin']);
  if (!existing) {
    const hash = await bcrypt.hash('ll2024', 10);
    await run('INSERT INTO hr_users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
    console.log('Admin RH criado → usuario: admin | senha: ll2024');
  }
}

migrate().catch(err => { console.error('Erro na migração:', err); process.exit(1); });

module.exports = {
  getActiveEmployees:  ()                           => q('SELECT * FROM employees WHERE active = 1'),
  getAllEmployees:      ()                           => q('SELECT * FROM employees ORDER BY active DESC, name ASC'),
  getEmployee:         (id)                         => q1('SELECT * FROM employees WHERE id = $1', [id]),

  createEmployee: async (name, pin_hash, type, daily_minutes, start_date) => {
    const r = await q1(
      'INSERT INTO employees (name, pin_hash, type, daily_minutes, start_date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, pin_hash, type, daily_minutes, start_date]
    );
    return r.id;
  },
  updateEmployee: (id, name, type, daily_minutes, active) =>
    run('UPDATE employees SET name=$1, type=$2, daily_minutes=$3, active=$4 WHERE id=$5', [name, type, daily_minutes, active, id]),
  updatePin: (id, pin_hash) =>
    run('UPDATE employees SET pin_hash=$1 WHERE id=$2', [pin_hash, id]),

  getOpenRecord: (empId, date) =>
    q1('SELECT * FROM time_records WHERE employee_id=$1 AND record_date=$2 AND clock_out IS NULL ORDER BY id DESC LIMIT 1', [empId, date]),
  getLastRecord: (empId, date) =>
    q1('SELECT * FROM time_records WHERE employee_id=$1 AND record_date=$2 ORDER BY id DESC LIMIT 1', [empId, date]),
  clockIn:  (empId, date, time) =>
    run('INSERT INTO time_records (employee_id, record_date, clock_in) VALUES ($1,$2,$3)', [empId, date, time]),
  clockOut: (recId, time, mins) =>
    run('UPDATE time_records SET clock_out=$1, worked_minutes=$2 WHERE id=$3', [time, mins, recId]),
  updateRecord: (id, clock_in, clock_out, worked_minutes) =>
    run('UPDATE time_records SET clock_in=$1, clock_out=$2, worked_minutes=$3 WHERE id=$4', [clock_in, clock_out, worked_minutes, id]),
  getRecords: (empId, start, end) =>
    q('SELECT * FROM time_records WHERE employee_id=$1 AND record_date BETWEEN $2 AND $3 ORDER BY record_date DESC, id DESC', [empId, start, end]),
  getTotalWorked: async (empId, start, end) => {
    const r = await q1(
      'SELECT COALESCE(SUM(worked_minutes),0)::int AS total FROM time_records WHERE employee_id=$1 AND record_date BETWEEN $2 AND $3 AND worked_minutes IS NOT NULL',
      [empId, start, end]
    );
    return r?.total ?? 0;
  },

  getHRUser:        (username) => q1('SELECT * FROM hr_users WHERE username=$1', [username]),
  getAllHRUsers:     ()         => q('SELECT id, username FROM hr_users ORDER BY username'),
  createHRUser:     (username, hash) => run('INSERT INTO hr_users (username, password_hash) VALUES ($1,$2)', [username, hash]),
  updateHRPassword: (id, hash) => run('UPDATE hr_users SET password_hash=$1 WHERE id=$2', [hash, id]),

  addAdjustment: (empId, minutes, reason, type, by) =>
    run('INSERT INTO adjustments (employee_id, minutes, reason, type, created_by) VALUES ($1,$2,$3,$4,$5)', [empId, minutes, reason, type, by]),
  deleteAdjustment: (id) =>
    run('DELETE FROM adjustments WHERE id=$1', [id]),
  getAdjustments: (empId, start, end) =>
    q('SELECT * FROM adjustments WHERE employee_id=$1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at DESC', [empId, start, end]),
  getTotalAdjustments: async (empId, start, end) => {
    const r = await q1(
      'SELECT COALESCE(SUM(minutes),0)::int AS total FROM adjustments WHERE employee_id=$1 AND created_at::date BETWEEN $2 AND $3',
      [empId, start, end]
    );
    return r?.total ?? 0;
  },
};
