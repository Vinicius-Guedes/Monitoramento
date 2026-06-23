const CIRC = 2 * Math.PI * 54; // 339.29
const REFRESH = 5000;

// ── Helpers ────────────────────────────────────────────────────
function formatBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  parts.push(m + 'min');
  return parts.join(' ');
}

function gaugeColor(pct) {
  if (pct < 60) return 'ok';
  if (pct < 85) return 'warn';
  return 'danger';
}

function setGauge(ringId, labelId, pct) {
  const ring = document.getElementById(ringId);
  const label = document.getElementById(labelId);
  const clamped = Math.min(100, Math.max(0, pct));
  ring.style.strokeDashoffset = CIRC * (1 - clamped / 100);
  ring.className.baseVal = 'gauge-fill ' + gaugeColor(clamped);
  label.textContent = Math.round(clamped) + '%';
}

function timeAgo() {
  const now = new Date();
  return now.toLocaleTimeString('pt-BR');
}

// ── Fetch & render ─────────────────────────────────────────────
let errorCount = 0;

async function fetchSystem() {
  const res = await fetch('/api/system');
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

async function fetchContainers() {
  const res = await fetch('/api/containers');
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

function renderSystem(data) {
  document.getElementById('hostname').textContent = data.hostname;

  // CPU
  setGauge('cpu-ring', 'cpu-value', data.cpu.usage);
  document.getElementById('cpu-model').textContent = data.cpu.model;
  document.getElementById('cpu-cores').textContent = data.cpu.cores + ' cores';

  // Memory
  setGauge('mem-ring', 'mem-value', data.memory.percentage);
  document.getElementById('mem-detail').textContent =
    formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total);
  document.getElementById('mem-free').textContent =
    formatBytes(data.memory.free) + ' livre';

  // Disk
  setGauge('disk-ring', 'disk-value', data.disk.percentage);
  document.getElementById('disk-detail').textContent =
    formatBytes(data.disk.used) + ' / ' + formatBytes(data.disk.total);
  document.getElementById('disk-free').textContent =
    formatBytes(data.disk.free) + ' livre';

  // Uptime
  document.getElementById('uptime-value').textContent = formatUptime(data.uptime);
}

function renderContainers(list) {
  const grid = document.getElementById('container-grid');
  const running = list.filter(c => c.state === 'running').length;
  document.getElementById('container-count').textContent =
    running + ' rodando / ' + list.length + ' total';

  grid.innerHTML = list.map(c => {
    const ports = c.ports.length ? '<div class="ct-ports">' + c.ports.join(', ') + '</div>' : '';
    return `
      <div class="ct-card ${c.state}">
        <div class="ct-header">
          <span class="ct-name">${c.name}</span>
          <span class="ct-state ${c.state}">${c.state}</span>
        </div>
        <div class="ct-image">${c.image}</div>
        <div class="ct-status">${c.status}</div>
        ${ports}
      </div>`;
  }).join('');
}

async function refresh() {
  try {
    const [sys, containers] = await Promise.all([fetchSystem(), fetchContainers()]);
    renderSystem(sys);
    renderContainers(containers);
    errorCount = 0;
    document.getElementById('badge-live').className = 'badge-live';
    document.getElementById('last-update').textContent = timeAgo();
  } catch (err) {
    errorCount++;
    if (errorCount >= 3) {
      document.getElementById('badge-live').className = 'badge-live error';
      document.getElementById('badge-live').querySelector('.pulse').style.animation = 'none';
    }
    console.error('Refresh error:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();
  setInterval(refresh, REFRESH);
});
