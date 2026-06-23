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
    const hidden = ['ae-se7-ui', 'ae-se7-api', 'ae-se7-db'];
    const visible = containers.filter((c) => !hidden.includes(c.name));
    const priority = ['gianluca', 'isabelamarques', 'viniciusguedes', 'mangiare'];
    visible.sort((a, b) => {
      const ai = priority.indexOf(a.name);
      const bi = priority.indexOf(b.name);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json(visible);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Monitoramento :${PORT}`));
