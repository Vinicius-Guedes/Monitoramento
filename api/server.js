const express = require('express');
const Docker = require('dockerode');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const HOST_PROC = process.env.HOST_PROC || '/proc';
const HOST_ROOTFS = process.env.HOST_ROOTFS || '/';

// Basic auth (optional — uncomment AUTH_USER/AUTH_PASS in docker-compose.yml)
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Monitoramento"');
      return res.status(401).send('Unauthorized');
    }
    const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
    const sep = decoded.indexOf(':');
    const user = decoded.substring(0, sep);
    const pass = decoded.substring(sep + 1);
    if (user === process.env.AUTH_USER && pass === process.env.AUTH_PASS) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Monitoramento"');
    return res.status(401).send('Unauthorized');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ── CPU usage (sampled every 2 s) ──────────────────────────────────────────
let prevIdle = 0;
let prevTotal = 0;
let cpuUsage = 0;

function sampleCpu() {
  try {
    const stat = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8');
    const parts = stat.split('\n')[0].split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const dIdle = idle - prevIdle;
    const dTotal = total - prevTotal;
    if (dTotal > 0) cpuUsage = ((dTotal - dIdle) / dTotal) * 100;
    prevIdle = idle;
    prevTotal = total;
  } catch (e) { /* ignore */ }
}
setInterval(sampleCpu, 2000);
sampleCpu();

// ── Helper readers ─────────────────────────────────────────────────────────
function getCpu() {
  try {
    const info = fs.readFileSync(`${HOST_PROC}/cpuinfo`, 'utf8');
    const cores = (info.match(/^processor/gm) || []).length;
    const m = info.match(/model name\s*:\s*(.*)/);
    return { model: m ? m[1].trim() : 'N/A', cores, usage: Math.round(cpuUsage * 100) / 100 };
  } catch {
    return { model: 'N/A', cores: 0, usage: 0 };
  }
}

function getMemory() {
  try {
    const raw = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
    const val = (k) => {
      const m = raw.match(new RegExp(`${k}:\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = val('MemTotal');
    const available = val('MemAvailable');
    const used = total - available;
    return { total, used, free: available, percentage: Math.round((used / total) * 10000) / 100 };
  } catch {
    return { total: 0, used: 0, free: 0, percentage: 0 };
  }
}

function getDisk() {
  try {
    const out = execSync(`df -B1 ${HOST_ROOTFS}`, { encoding: 'utf8', timeout: 5000 });
    const p = out.trim().split('\n')[1].split(/\s+/);
    return {
      total: parseInt(p[1], 10),
      used: parseInt(p[2], 10),
      free: parseInt(p[3], 10),
      percentage: parseFloat(p[4])
    };
  } catch {
    return { total: 0, used: 0, free: 0, percentage: 0 };
  }
}

function getUptime() {
  try {
    return parseFloat(fs.readFileSync(`${HOST_PROC}/uptime`, 'utf8').split(' ')[0]);
  } catch {
    return 0;
  }
}

function getHostname() {
  try {
    return fs.readFileSync(`${HOST_PROC}/sys/kernel/hostname`, 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

// ── Process memory reader ──────────────────────────────────────────────────
function getProcessesMemory() {
  const pageSize = 4096;
  const totalMem = getMemory().total;
  const procs = [];

  try {
    const dirs = fs.readdirSync(HOST_PROC).filter((d) => /^\d+$/.test(d));
    for (const pid of dirs) {
      try {
        const status = fs.readFileSync(`${HOST_PROC}/${pid}/status`, 'utf8');
        const cmdline = fs.readFileSync(`${HOST_PROC}/${pid}/cmdline`, 'utf8')
          .replace(/\0/g, ' ').trim();
        const stat = fs.readFileSync(`${HOST_PROC}/${pid}/stat`, 'utf8');

        const nameMatch = status.match(/^Name:\s+(.+)/m);
        const rssMatch = stat.match(/^\d+ \([^)]+\)\s+\S+(?:\s+\S+){20}\s+(\d+)/);
        if (!nameMatch || !rssMatch) continue;

        const name = nameMatch[1].trim();
        const rssBytes = parseInt(rssMatch[1], 10) * pageSize;
        if (rssBytes === 0) continue;

        procs.push({
          pid: parseInt(pid, 10),
          name,
          command: cmdline.substring(0, 120) || name,
          rss: rssBytes,
          percentage: totalMem > 0 ? Math.round((rssBytes / totalMem) * 10000) / 100 : 0
        });
      } catch { /* process vanished */ }
    }
  } catch { /* ignore */ }

  procs.sort((a, b) => b.rss - a.rss);
  return procs.slice(0, 30);
}

// ── Telegram Alerts ───────────────────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const ALERT_CPU  = parseInt(process.env.ALERT_CPU || '90', 10);
const ALERT_MEM  = parseInt(process.env.ALERT_MEMORY || '85', 10);
const ALERT_DISK = parseInt(process.env.ALERT_DISK || '90', 10);
const ALERT_INTERVAL = 30000;  // check every 30s
const COOLDOWN = 300000;       // 5 min between same alert

const alertCooldowns = {};
const monitoredContainers = ['gianluca', 'isabelamarques', 'viniciusguedes', 'mangiare'];

async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: 'HTML' })
    });
    if (!res.ok) console.error('Telegram error:', await res.text());
  } catch (err) {
    console.error('Telegram send failed:', err.message);
  }
}

function canAlert(key) {
  const now = Date.now();
  if (alertCooldowns[key] && now - alertCooldowns[key] < COOLDOWN) return false;
  alertCooldowns[key] = now;
  return true;
}

async function checkAlerts() {
  const hostname = getHostname();

  // CPU
  const cpu = getCpu();
  if (cpu.usage >= ALERT_CPU && canAlert('cpu')) {
    await sendTelegram(
      `🔴 <b>CPU Alta</b>\n` +
      `Servidor: ${hostname}\n` +
      `Uso: <b>${cpu.usage}%</b> (limite: ${ALERT_CPU}%)`
    );
  }

  // Memory
  const mem = getMemory();
  if (mem.percentage >= ALERT_MEM && canAlert('memory')) {
    const used = (mem.used / 1073741824).toFixed(1);
    const total = (mem.total / 1073741824).toFixed(1);
    await sendTelegram(
      `🟡 <b>Memória Alta</b>\n` +
      `Servidor: ${hostname}\n` +
      `Uso: <b>${mem.percentage}%</b> (${used}GB / ${total}GB)\n` +
      `Limite: ${ALERT_MEM}%`
    );
  }

  // Disk
  const disk = getDisk();
  if (disk.percentage >= ALERT_DISK && canAlert('disk')) {
    const used = (disk.used / 1073741824).toFixed(1);
    const total = (disk.total / 1073741824).toFixed(1);
    await sendTelegram(
      `🟠 <b>Disco Alto</b>\n` +
      `Servidor: ${hostname}\n` +
      `Uso: <b>${disk.percentage}%</b> (${used}GB / ${total}GB)\n` +
      `Limite: ${ALERT_DISK}%`
    );
  }

  // Containers down
  try {
    const list = await docker.listContainers({ all: true });
    for (const c of list) {
      const name = c.Names[0].replace(/^\//, '');
      if (!monitoredContainers.includes(name)) continue;
      if (c.State !== 'running' && canAlert(`container_${name}`)) {
        await sendTelegram(
          `⚫ <b>Container Fora</b>\n` +
          `Servidor: ${hostname}\n` +
          `Container: <b>${name}</b>\n` +
          `Estado: ${c.State}\n` +
          `Status: ${c.Status}`
        );
      }
    }
  } catch { /* ignore */ }
}

// ── Daily report (8h Brasilia / 11h UTC) ─────────────────────────────────
function formatUptimeShort(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  parts.push(m + 'min');
  return parts.join(' ');
}

async function sendDailyReport() {
  const hostname = getHostname();
  const uptime = formatUptimeShort(getUptime());
  const cpu = getCpu();
  const mem = getMemory();
  const disk = getDisk();

  let clientesStatus = '';
  try {
    const list = await docker.listContainers({ all: true });
    for (const name of monitoredContainers) {
      const c = list.find((x) => x.Names[0].replace(/^\//, '') === name);
      if (c) {
        const icon = c.State === 'running' ? '🟢' : '🔴';
        clientesStatus += `${icon} <b>${name}</b> — ${c.Status}\n`;
      } else {
        clientesStatus += `⚫ <b>${name}</b> — nao encontrado\n`;
      }
    }
  } catch {
    clientesStatus = 'Erro ao listar containers\n';
  }

  const memUsed = (mem.used / 1073741824).toFixed(1);
  const memTotal = (mem.total / 1073741824).toFixed(1);
  const diskUsed = (disk.used / 1073741824).toFixed(1);
  const diskTotal = (disk.total / 1073741824).toFixed(1);

  await sendTelegram(
    `📊 <b>Relatorio Diario</b>\n` +
    `Servidor: ${hostname}\n` +
    `Uptime: ${uptime}\n\n` +
    `<b>Recursos:</b>\n` +
    `CPU: ${cpu.usage}% (${cpu.cores} cores)\n` +
    `Memoria: ${mem.percentage}% (${memUsed}GB / ${memTotal}GB)\n` +
    `Disco: ${disk.percentage}% (${diskUsed}GB / ${diskTotal}GB)\n\n` +
    `<b>Clientes:</b>\n` +
    clientesStatus
  );
}

function scheduleDailyReport() {
  const now = new Date();
  // Brasilia = UTC-3
  const brasiliaOffset = -3 * 60;
  const localOffset = now.getTimezoneOffset();
  const brasiliaTime = new Date(now.getTime() + (localOffset + brasiliaOffset) * 60000);

  let next8h = new Date(brasiliaTime);
  next8h.setHours(8, 0, 0, 0);
  if (brasiliaTime >= next8h) next8h.setDate(next8h.getDate() + 1);

  // Convert back to server time
  const msUntil = next8h.getTime() - brasiliaTime.getTime();

  console.log(`Relatorio diario agendado em ${Math.round(msUntil / 60000)} min`);
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, msUntil);
}

if (TG_TOKEN && TG_CHAT) {
  console.log('Telegram alerts ativados (CPU>' + ALERT_CPU + '% MEM>' + ALERT_MEM + '% DISK>' + ALERT_DISK + '%)');
  setInterval(checkAlerts, ALERT_INTERVAL);
  setTimeout(checkAlerts, 5000);
  scheduleDailyReport();
} else {
  console.log('Telegram alerts desativados (sem TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)');
}

// ── API routes ─────────────────────────────────────────────────────────────
app.get('/api/system', (_req, res) => {
  try {
    res.json({
      hostname: getHostname(),
      uptime: getUptime(),
      cpu: getCpu(),
      memory: getMemory(),
      disk: getDisk()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/processes', (_req, res) => {
  try {
    res.json(getProcessesMemory());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/containers', async (_req, res) => {
  try {
    const list = await docker.listContainers({ all: true });
    const containers = list.map((c) => ({
      id: c.Id.substring(0, 12),
      name: c.Names[0].replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: c.Ports
        .filter((p) => p.PublicPort)
        .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`)
    }));
    const hidden = ['ae-se7-ui', 'ae-se7-api', 'ae-se7-db', 'pizzaria-db'];
    const visible = containers.filter((c) => !hidden.includes(c.name));

    const clientes = ['gianluca', 'isabelamarques', 'viniciusguedes', 'mangiare'];
    const grupoClientes = [];
    const grupoServicos = [];

    for (const c of visible) {
      if (clientes.includes(c.name)) {
        c.group = 'clientes';
        grupoClientes.push(c);
      } else {
        c.group = 'servicos';
        grupoServicos.push(c);
      }
    }

    grupoClientes.sort((a, b) => clientes.indexOf(a.name) - clientes.indexOf(b.name));
    grupoServicos.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ clientes: grupoClientes, servicos: grupoServicos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Monitoramento :${PORT}`));
