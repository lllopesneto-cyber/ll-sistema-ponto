const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ponto.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'employee',
    daily_minutes INTEGER NOT NULL DEFAULT 480,
    active INTEGER NOT NULL DEFAULT 1,
    start_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS time_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    clock_in DATETIME NOT NULL,
    clock_out DATETIME,
    worked_minutes INTEGER,
    record_date DATE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    minutes INTEGER NOT NULL,
    reason TEXT NOT NULL,
    type TEXT NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hr_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

const existing = db.prepare('SELECT id FROM hr_users WHERE username = ?').get('admin');
if (!existing) {
  const hash = bcrypt.hashSync('ll2024', 10);
  db.prepare('INSERT INTO hr_users (username, password_hash) VALUES (?, ?)').run('admin', hash);
  console.log('Admin RH criado → usuario: admin | senha: ll2024');
}

const q = {
  getActiveEmployees:    db.prepare('SELECT * FROM employees WHERE active = 1'),
  getAllEmployees:        db.prepare('SELECT * FROM employees ORDER BY active DESC, name ASC'),
  getEmployee:           db.prepare('SELECT * FROM employees WHERE id = ?'),
  createEmployee:        db.prepare('INSERT INTO employees (name, pin_hash, type, daily_minutes, start_date) VALUES (@name, @pin_hash, @type, @daily_minutes, @start_date)'),
  updateEmployee:        db.prepare('UPDATE employees SET name=@name, type=@type, daily_minutes=@daily_minutes, active=@active WHERE id=@id'),
  updatePin:             db.prepare('UPDATE employees SET pin_hash=@pin_hash WHERE id=@id'),

  getOpenRecord:         db.prepare('SELECT * FROM time_records WHERE employee_id=? AND record_date=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1'),
  getLastRecord:         db.prepare('SELECT * FROM time_records WHERE employee_id=? AND record_date=? ORDER BY id DESC LIMIT 1'),
  clockIn:               db.prepare('INSERT INTO time_records (employee_id, record_date, clock_in) VALUES (?, ?, ?)'),
  clockOut:              db.prepare('UPDATE time_records SET clock_out=?, worked_minutes=? WHERE id=?'),
  updateRecord:          db.prepare('UPDATE time_records SET clock_in=@clock_in, clock_out=@clock_out, worked_minutes=@worked_minutes WHERE id=@id'),
  getRecords:            db.prepare('SELECT * FROM time_records WHERE employee_id=? AND record_date BETWEEN ? AND ? ORDER BY record_date DESC, id DESC'),
  getTotalWorked:        db.prepare('SELECT COALESCE(SUM(worked_minutes),0) as total FROM time_records WHERE employee_id=? AND record_date BETWEEN ? AND ? AND worked_minutes IS NOT NULL'),

  getHRUser:             db.prepare('SELECT * FROM hr_users WHERE username=?'),
  getAllHRUsers:          db.prepare('SELECT id, username FROM hr_users ORDER BY username'),
  createHRUser:          db.prepare('INSERT INTO hr_users (username, password_hash) VALUES (?, ?)'),
  updateHRPassword:      db.prepare('UPDATE hr_users SET password_hash=? WHERE id=?'),

  addAdjustment:         db.prepare('INSERT INTO adjustments (employee_id, minutes, reason, type, created_by) VALUES (?, ?, ?, ?, ?)'),
  deleteAdjustment:      db.prepare('DELETE FROM adjustments WHERE id=?'),
  getAdjustments:        db.prepare('SELECT * FROM adjustments WHERE employee_id=? AND DATE(created_at) BETWEEN ? AND ? ORDER BY created_at DESC'),
  getTotalAdjustments:   db.prepare('SELECT COALESCE(SUM(minutes),0) as total FROM adjustments WHERE employee_id=? AND DATE(created_at) BETWEEN ? AND ?'),
};

module.exports = {
  getActiveEmployees:  ()                           => q.getActiveEmployees.all(),
  getAllEmployees:      ()                           => q.getAllEmployees.all(),
  getEmployee:         (id)                         => q.getEmployee.get(id),
  createEmployee:      (name, pin_hash, type, daily_minutes, start_date) =>
                         q.createEmployee.run({ name, pin_hash, type, daily_minutes, start_date }).lastInsertRowid,
  updateEmployee:      (id, name, type, daily_minutes, active) =>
                         q.updateEmployee.run({ id, name, type, daily_minutes, active }),
  updatePin:           (id, pin_hash)               => q.updatePin.run({ pin_hash, id }),

  getOpenRecord:       (empId, date)                => q.getOpenRecord.get(empId, date),
  getLastRecord:       (empId, date)                => q.getLastRecord.get(empId, date),
  clockIn:             (empId, date, time)          => q.clockIn.run(empId, date, time),
  clockOut:            (recId, time, mins)          => q.clockOut.run(time, mins, recId),
  updateRecord:        (id, clock_in, clock_out, worked_minutes) =>
                         q.updateRecord.run({ id, clock_in, clock_out, worked_minutes }),
  getRecords:          (empId, start, end)          => q.getRecords.all(empId, start, end),
  getTotalWorked:      (empId, start, end)          => q.getTotalWorked.get(empId, start, end)?.total || 0,

  getHRUser:           (username)                   => q.getHRUser.get(username),
  getAllHRUsers:        ()                           => q.getAllHRUsers.all(),
  createHRUser:        (username, hash)             => q.createHRUser.run(username, hash),
  updateHRPassword:    (id, hash)                   => q.updateHRPassword.run(hash, id),

  addAdjustment:       (empId, minutes, reason, type, by) => q.addAdjustment.run(empId, minutes, reason, type, by),
  deleteAdjustment:    (id)                         => q.deleteAdjustment.run(id),
  getAdjustments:      (empId, start, end)          => q.getAdjustments.all(empId, start, end),
  getTotalAdjustments: (empId, start, end)          => q.getTotalAdjustments.get(empId, start, end)?.total || 0,
};
