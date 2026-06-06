require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Timezone helpers (UTC-3, Brasília) ──────────────────────────────────────

function localDate(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}
function localNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T');
}
function firstOfMonth(monthStr) {
  if (monthStr) return `${monthStr}-01`;
  const m = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  return `${m}-01`;
}
function lastOfMonth(monthStr) {
  const [y, m] = (monthStr || localDate().slice(0, 7)).split('-').map(Number);
  return localDate(new Date(y, m, 0));
}
function countWorkDays(startStr, endStr) {
  let count = 0;
  const cur = new Date(startStr + 'T12:00:00');
  const end = new Date(endStr + 'T12:00:00');
  while (cur <= end) {
    const day = cur.getDay();
    if (day >= 1 && day <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}
async function calcBalance(employee, startDate, endDate) {
  const today = localDate();
  const effectiveStart = employee.start_date > startDate ? employee.start_date : startDate;
  const effectiveEnd   = endDate > today ? today : endDate;

  if (!effectiveStart || !effectiveEnd || effectiveStart > effectiveEnd) {
    return { expected_minutes: 0, worked_minutes: 0, adjustment_minutes: 0, balance_minutes: 0, work_days: 0 };
  }
  const work_days          = countWorkDays(effectiveStart, effectiveEnd);
  const expected_minutes   = work_days * employee.daily_minutes;
  const worked_minutes     = await db.getTotalWorked(employee.id, effectiveStart, effectiveEnd);
  const adjustment_minutes = await db.getTotalAdjustments(employee.id, effectiveStart, effectiveEnd);
  const balance_minutes    = (worked_minutes + adjustment_minutes) - expected_minutes;
  return { expected_minutes, worked_minutes, adjustment_minutes, balance_minutes, work_days };
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'll-ponto-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000, httpOnly: true }
}));

// ── Employee: clock in / out ─────────────────────────────────────────────────

app.post('/api/ponto', async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN deve ter 4 dígitos' });
  }

  const employees = await db.getActiveEmployees();
  const matches   = await Promise.all(
    employees.map(emp => bcrypt.compare(pin, emp.pin_hash).then(ok => ok ? emp : null))
  );
  const employee = matches.find(Boolean);
  if (!employee) return res.status(401).json({ error: 'PIN inválido' });

  const today = localDate();
  const now   = localNow();
  const open  = await db.getOpenRecord(employee.id, today);

  let action, worked_minutes = null;
  if (!open) {
    await db.clockIn(employee.id, today, now);
    action = 'entrada';
  } else {
    worked_minutes = Math.max(0, Math.round((new Date(now) - new Date(open.clock_in)) / 60000));
    await db.clockOut(open.id, now, worked_minutes);
    action = 'saida';
  }

  const balance = await calcBalance(employee, firstOfMonth(), today);
  res.json({ action, name: employee.name, time: now, worked_minutes, balance_month: balance.balance_minutes });
});

// ── HR: auth ─────────────────────────────────────────────────────────────────

function requireHR(req, res, next) {
  if (!req.session.hrUser) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  next();
}

app.post('/api/rh/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.getHRUser(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  req.session.hrUser = { id: user.id, username: user.username };
  res.json({ success: true, username: user.username });
});

app.post('/api/rh/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/rh/me', (req, res) => {
  if (!req.session.hrUser) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.hrUser.username });
});

// ── HR: employees ─────────────────────────────────────────────────────────────

app.get('/api/rh/funcionarios', requireHR, async (req, res) => {
  const month   = req.query.month || localDate().slice(0, 7);
  const start   = firstOfMonth(month);
  const end     = lastOfMonth(month);
  const today   = localDate();

  const employees = await db.getAllEmployees();
  const result = await Promise.all(employees.map(async emp => {
    const lastPunch = await db.getLastPunch(emp.id);
    return {
      ...emp,
      working_now: !!(await db.getOpenRecord(emp.id, today)),
      ...(await calcBalance(emp, start, end)),
      total_balance: (await calcBalance(emp, emp.start_date, today)).balance_minutes,
      last_punch_date: lastPunch?.record_date || null,
      last_punch_in:   lastPunch?.clock_in    || null,
      last_punch_out:  lastPunch?.clock_out   || null
    };
  }));

  res.json(result);
});

app.get('/api/rh/funcionario/:id', requireHR, async (req, res) => {
  const emp = await db.getEmployee(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Não encontrado' });

  const month  = req.query.month || localDate().slice(0, 7);
  const start  = firstOfMonth(month);
  const end    = lastOfMonth(month);
  const today  = localDate();

  res.json({
    employee:     emp,
    records:      await db.getRecords(emp.id, start, end),
    adjustments:  await db.getAdjustments(emp.id, start, end),
    balance:      await calcBalance(emp, start, end),
    totalBalance: await calcBalance(emp, emp.start_date, today)
  });
});

app.post('/api/rh/funcionario', requireHR, async (req, res) => {
  const { name, pin, type } = req.body;
  if (!name?.trim() || !type) return res.status(400).json({ error: 'Nome e tipo são obrigatórios' });
  if (!/^\d{4}$/.test(pin))  return res.status(400).json({ error: 'PIN deve ter exatamente 4 dígitos' });

  const daily_minutes = type === 'intern' ? 240 : 450;
  const pin_hash      = await bcrypt.hash(pin, 10);
  const id            = await db.createEmployee(name.trim(), pin_hash, type, daily_minutes, localDate());
  res.json({ success: true, id });
});

app.put('/api/rh/funcionario/:id', requireHR, async (req, res) => {
  const { name, type, active } = req.body;
  if (!name?.trim() || !type) return res.status(400).json({ error: 'Nome e tipo são obrigatórios' });
  await db.updateEmployee(req.params.id, name.trim(), type, type === 'intern' ? 240 : 450, active ? 1 : 0);
  res.json({ success: true });
});

app.delete('/api/rh/funcionario/:id', requireHR, async (req, res) => {
  const emp = await db.getEmployee(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Funcionário não encontrado' });
  await db.deleteEmployee(req.params.id);
  res.json({ success: true, name: emp.name });
});

app.put('/api/rh/funcionario/:id/pin', requireHR, async (req, res) => {
  if (!/^\d{4}$/.test(req.body.pin)) return res.status(400).json({ error: 'PIN deve ter 4 dígitos' });
  await db.updatePin(req.params.id, await bcrypt.hash(req.body.pin, 10));
  res.json({ success: true });
});

// ── HR: adjustments ───────────────────────────────────────────────────────────

app.post('/api/rh/ajuste', requireHR, async (req, res) => {
  const { employee_id, minutes, reason, type } = req.body;
  if (!employee_id || minutes === undefined || !reason?.trim() || !type) {
    return res.status(400).json({ error: 'Preencha todos os campos' });
  }
  await db.addAdjustment(employee_id, parseInt(minutes), reason.trim(), type, req.session.hrUser.id);
  res.json({ success: true });
});

app.delete('/api/rh/ajuste/:id', requireHR, async (req, res) => {
  await db.deleteAdjustment(req.params.id);
  res.json({ success: true });
});

// ── HR: time record edit ──────────────────────────────────────────────────────

app.put('/api/rh/registro/:id', requireHR, async (req, res) => {
  const { clock_in, clock_out } = req.body;
  if (!clock_in) return res.status(400).json({ error: 'Horário de entrada é obrigatório' });
  const worked = clock_out
    ? Math.max(0, Math.round((new Date(clock_out) - new Date(clock_in)) / 60000))
    : null;
  await db.updateRecord(req.params.id, clock_in, clock_out || null, worked);
  res.json({ success: true });
});

// ── HR: manage HR users ───────────────────────────────────────────────────────

app.get('/api/rh/usuarios', requireHR, async (req, res) => {
  res.json(await db.getAllHRUsers());
});

app.post('/api/rh/usuario', requireHR, async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  try {
    await db.createHRUser(username.trim(), await bcrypt.hash(password, 10));
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Usuário já existe' });
  }
});

app.put('/api/rh/usuario/:id/senha', requireHR, async (req, res) => {
  if (!req.body.password) return res.status(400).json({ error: 'Nova senha obrigatória' });
  await db.updateHRPassword(req.params.id, await bcrypt.hash(req.body.password, 10));
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`\nPonto LL rodando em http://localhost:${PORT}\n`));
