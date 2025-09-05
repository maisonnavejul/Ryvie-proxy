import express from 'express';
import helmet from 'helmet';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(helmet());
app.use(express.json());

// Config
const PORT = process.env.PORT || 8088;
const CADDYFILE_PATH = process.env.CADDYFILE_PATH || '/home/ubuntu/Caddyfile';
const CADDY_RELOAD_CMD = process.env.CADDY_RELOAD_CMD || `caddy reload --config ${CADDYFILE_PATH}`;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'ryvie.fr';

// Default targets per service if not provided by client
const DEFAULT_TARGETS = {
  rdrive: process.env.TARGET_RDRIVE || '100.90.20.50:3010',
  rtransfer: process.env.TARGET_RTRANSFER || '100.90.20.50:3011',
  rdrop: process.env.TARGET_RDROP || '100.90.20.50:8080',
  rpictures: process.env.TARGET_RPICTURES || '100.90.20.50:2283',
  app: process.env.TARGET_APP || '100.90.20.50:3000',
  status: process.env.TARGET_STATUS || '100.90.20.50:3002',
  'backend.rdrive': process.env.TARGET_BACKEND_RDRIVE || '100.90.20.50:4000',
  'connector.rdrive': process.env.TARGET_CONNECTOR_RDRIVE || '100.90.20.50:5000',
  'document.rdrive': process.env.TARGET_DOCUMENT_RDRIVE || '100.90.20.50:8090',
};

// Utility: append to Caddyfile atomically
function appendToCaddyfile(content) {
  const current = fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '';
  const updated = current.endsWith('\n') || current.length === 0 ? current + content : current + '\n' + content;
  fs.writeFileSync(CADDYFILE_PATH, updated, 'utf8');
}

// Check whether an ID already appears in the Caddyfile hosts
function isIdUsed(id) {
  try {
    if (!fs.existsSync(CADDYFILE_PATH)) return false;
    const text = fs.readFileSync(CADDYFILE_PATH, 'utf8');
    const escapedDomain = BASE_DOMAIN.replace(/\./g, '\\.');
    const re = new RegExp(`\\.${id}\\.${escapedDomain}\\b`);
    return re.test(text);
  } catch {
    return false;
  }
}

function makeSiteBlock(host, target) {
  return `\n${host} {\n    reverse_proxy ${target}\n}\n`;
}

function makeSpecialBlock(prefix, host, target) {
  if (prefix === 'backend.rdrive') {
    return `\n${host} {\n    reverse_proxy /* ${target}\n\n    # Support des WebSockets\n    @websockets {\n        header Connection *Upgrade*\n        header Upgrade websocket\n    }\n    reverse_proxy @websockets ${target}\n}\n`;
  }
  if (prefix === 'connector.rdrive' || prefix === 'document.rdrive') {
    return `\n${host} {\n    reverse_proxy /* ${target}\n}\n`;
  }
  return null;
}

app.post('/api/register', (req, res) => {
  try {
    const { machineId, arch, os, publicIp, services } = req.body || {};
    // Allow caller to pass a backend host/IP (e.g., via curl) that we use to form targets per service
    const backendHost = req.body?.backendHost || req.body?.backendIp || req.body?.ip;

    // Utilities for dedup
    const escapedDomain = BASE_DOMAIN.replace(/\./g, '\\.');
    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const getCaddyText = () => (fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '');
    // Try to find an existing id for this backendHost
    let id = '';
    if (backendHost) {
      const text = getCaddyText();
      // Match any service label (may contain dots), then a second label that must be exactly 8 lowercase alnum chars (our id)
      const re = new RegExp(`\n[^\s]+\.([a-z0-9]{8})\.${escapedDomain} \{[\s\S]*?reverse_proxy\s+${escapeRegExp(backendHost)}:`, 'i');
      const m = text.match(re);
      if (m && m[1]) {
        id = m[1];
      }
    }
    // If no existing id found, generate a unique one (attempts up to 5 times)
    if (!id) {
      for (let i = 0; i < 5; i++) {
        const candidate = nanoid(8).toLowerCase();
        if (!isIdUsed(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id) {
        return res.status(500).json({ error: 'id_generation_failed', details: 'Could not generate a unique id' });
      }
    }

    const requested = Array.isArray(services)
      ? services.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
      : ['rdrive'];

    // Build domains and targets
    const domains = {};
    const blocks = [];
    // Known service -> default port mapping for constructing targets from backendHost
    const SERVICE_PORTS = {
      rdrive: 3010,
      rtransfer: 3011,
      rdrop: 8080,
      rpictures: 2283,
      app: 3000,
      status: 3002,
      'backend.rdrive': 4000,
      'connector.rdrive': 5000,
      'document.rdrive': 8090,
    };

    // Helper: does a block already exist for this service + id?
    const caddyTextBefore = getCaddyText();
    function hasServiceBlock(prefix, idToCheck, expectedHost) {
      const host = `${prefix}.${idToCheck}.${BASE_DOMAIN}`;
      const hostRe = new RegExp(`\\n${escapeRegExp(host)} \\{[\\s\\S]*?\\n\\}`, 'i');
      if (!hostRe.test(caddyTextBefore)) return false;
      if (!expectedHost) return true;
      const targetRe = new RegExp(`\\n${escapeRegExp(host)} \\{[\\s\\S]*?reverse_proxy\\s+${escapeRegExp(expectedHost)}(?:\\s|$)`, 'i');
      return targetRe.test(caddyTextBefore);
    }

    for (const svc of requested) {
      const prefix = String(svc).toLowerCase();
      const host = `${prefix}.${id}.${BASE_DOMAIN}`;

      // Target priority: body.services[].target > backendHost:port (if provided) > DEFAULT_TARGETS
      let target;
      const svcObj = (req.body?.services || []).find((x) => (x?.name || x) === svc);
      if (svcObj && svcObj.target) {
        target = svcObj.target;
      } else if (backendHost && SERVICE_PORTS[prefix]) {
        target = `${backendHost}:${SERVICE_PORTS[prefix]}`;
      } else {
        target = DEFAULT_TARGETS[prefix];
      }

      if (!target) continue;
      domains[prefix] = host;
      // Skip creating if block already present for this service/id and points to this target (when backendHost provided)
      if (hasServiceBlock(prefix, id, backendHost ? `${backendHost}:${SERVICE_PORTS[prefix]}` : undefined)) {
        continue;
      }
      const special = makeSpecialBlock(prefix, host, target);
      blocks.push(special || makeSiteBlock(host, target));
    }

    // Write blocks and reload Caddy
    if (blocks.length > 0) {
      // Prepend a numbered comment for traceability
      const preText = getCaddyText();
      const existingBlockMarkers = (preText.match(/^# BLOCK\s+\d+/gmi) || []).length;
      const blockNumber = existingBlockMarkers + 1;
      const header = `\n# BLOCK ${blockNumber} - backendHost=${backendHost || 'custom targets'} machineId=${machineId || ''} time=${new Date().toISOString()}\n`;
      appendToCaddyfile(header + blocks.join('\n'));
      exec(CADDY_RELOAD_CMD, (err, stdout, stderr) => {
        if (err) {
          console.error('Caddy reload failed:', err, stderr);
        } else {
          console.log('Caddy reloaded:', stdout);
        }
      });
    }

    // Static driss.ryvie.fr blocks removed; only dynamic registrations are written.

    return res.json({ id, domains, received: { machineId, arch, os, publicIp } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'registration_failed', details: String(e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`registration-service listening on :${PORT}`);
});
