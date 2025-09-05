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
const CADDYFILE_PATH = process.env.CADDYFILE_PATH || '/root/Caddyfile';
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

// Utility: append to Caddyfile atomically
function appendToCaddyfile(content) {
  const current = fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '';
  const updated = current.endsWith('\\n') || current.length === 0 ? current + content : current + '\\n' + content;
  fs.writeFileSync(CADDYFILE_PATH, updated, 'utf8');
}

// Check whether an ID already appears in the Caddyfile hosts
function isIdUsed(id) {
  try {
    if (!fs.existsSync(CADDYFILE_PATH)) return false;
    const text = fs.readFileSync(CADDYFILE_PATH, 'utf8');
    const escapedDomain = BASE_DOMAIN.replace(/\\./g, '\\\\.');
    const re = new RegExp(`\\\\.${id}\\\\.${escapedDomain}\\\\b`);
    return re.test(text);
  } catch {
    return false;
  }
}

// Check if backendHost IP already exists in the Caddyfile
function isBackendHostRegistered(backendHost) {
  if (!backendHost || !fs.existsSync(CADDYFILE_PATH)) return false;

  const text = fs.readFileSync(CADDYFILE_PATH, 'utf8');
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');

  // Check if this IP appears in any reverse_proxy directive
  const re = new RegExp(`reverse_proxy[^\\\\n]*${escapeRegExp(backendHost)}:`, 'i');
  return re.test(text);
}

// Find ID associated with a backendHost
function findIdByBackendHost(backendHost) {
  if (!backendHost || !fs.existsSync(CADDYFILE_PATH)) return null;

  const text = fs.readFileSync(CADDYFILE_PATH, 'utf8');
  const escapedDomain = BASE_DOMAIN.replace(/\\./g, '\\\\.');
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');

  // Look for any block with this IP
  const re = new RegExp(`\\n[^\\s]+\\.([a-z0-9]{8})\\.${escapedDomain} \\{[\\s\\S]*?reverse_proxy[^\\\\n]*${escapeRegExp(backendHost)}:`, 'i');
  const m = text.match(re);

  return m && m[1] ? m[1] : null;
}

function makeSiteBlock(host, target) {
  return `\\n${host} {\\n    reverse_proxy ${target}\\n}\\n`;
}

function makeSpecialBlock(prefix, host, target) {
  if (prefix === 'backend.rdrive') {
    return `\\n${host} {\\n    reverse_proxy /* ${target}\\n\\n    # Support des WebSockets\\n    @websockets {\\n        header Connection *Upgrade*\\n        header Upgrade websocket\\n    }\\n    reverse_proxy @websockets ${target}\\n}\\n`;
  }
  if (prefix === 'connector.rdrive' || prefix === 'document.rdrive') {
    return `\\n${host} {\\n    reverse_proxy /* ${target}\\n}\\n`;
  }
  return null;
}

app.post('/api/register', (req, res) => {
  try {
    const { machineId, arch, os, publicIp, services } = req.body || {};

    // Allow caller to pass a backend host/IP
    const backendHost = req.body?.backendHost || req.body?.backendIp || req.body?.ip;

    // Check if this backendHost is already registered
    if (backendHost && isBackendHostRegistered(backendHost)) {
      const existingId = findIdByBackendHost(backendHost);
      console.log(`BackendHost ${backendHost} already registered with ID ${existingId}. Skipping.`);

      // Build the domains object for the existing registration
      const requested = Array.isArray(services)
        ? services.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
        : ['rdrive'];

      const domains = {};
      for (const svc of requested) {
        const prefix = String(svc).toLowerCase();
        if (existingId) {
          domains[prefix] = `${prefix}.${existingId}.${BASE_DOMAIN}`;
        }
      }

      return res.json({
        id: existingId,
        status: 'already_exists',
        message: `BackendHost ${backendHost} is already registered`,
        domains,
        received: { machineId, arch, os, publicIp, backendHost }
      });
    }

    // Generate a new unique ID
    let id = '';
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

    const requested = Array.isArray(services)
      ? services.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
      : ['rdrive'];

    // Build domains and blocks
    const domains = {};
    const blocks = [];

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

      const special = makeSpecialBlock(prefix, host, target);
      blocks.push(special || makeSiteBlock(host, target));
    }

    // Write blocks only if there are any and this is a new registration
    if (blocks.length > 0) {
      const preText = fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '';
      const existingBlockMarkers = (preText.match(/^# BLOCK\\s+\\d+/gmi) || []).length;
      const blockNumber = existingBlockMarkers + 1;
      const header = `\\n# BLOCK ${blockNumber} - backendHost=${backendHost || 'custom targets'} machineId=${machineId || ''} time=${new Date().toISOString()}\\n`;

      appendToCaddyfile(header + blocks.join('\\n'));
      console.log(`New registration added for ${backendHost || 'custom targets'}; Caddy should auto-reload via --watch`);
    }

    return res.json({
      id,
      domains,
      status: 'created',
      received: { machineId, arch, os, publicIp, backendHost }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'registration_failed', details: String(e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`registration-service listening on :${PORT}`);
});
