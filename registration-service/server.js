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
const CADDY_RELOAD_CMD = process.env.CADDY_RELOAD_CMD || 'docker-compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile';
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

// Reload Caddy configuration
function reloadCaddy() {
  return new Promise((resolve, reject) => {
    console.log(`Executing: ${CADDY_RELOAD_CMD}`);
    exec(CADDY_RELOAD_CMD, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error reloading Caddy: ${error.message}`);
        return reject(error);
      }
      if (stderr) {
        console.error(`Caddy stderr: ${stderr}`);
      }
      console.log(`Caddy reloaded successfully: ${stdout}`);
      resolve(stdout);
    });
  });
}

// Utility: append to Caddyfile atomically
async function appendToCaddyfile(content) {
  const current = fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '';
  
  // Normalize line endings and ensure exactly one newline at the end
  const normalizedCurrent = current.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
  const normalizedContent = content.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '');
  
  // Combine with exactly two newlines between blocks
  let updated = normalizedCurrent;
  if (normalizedCurrent && normalizedContent) {
    updated += '\n\n';
  }
  updated += normalizedContent + '\n';

  // Write the updated Caddyfile
  fs.writeFileSync(CADDYFILE_PATH, updated, 'utf8');
  
  // Reload Caddy configuration
  try {
    await reloadCaddy();
  } catch (error) {
    console.error('Failed to reload Caddy configuration:', error);
    throw error; // Re-throw to be caught by the caller
  }
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
  const re = new RegExp(`([a-z0-9]{8})\\\\.${escapedDomain} \\\\{[\\\\s\\\\S]*?reverse_proxy[^\\\\n]*${escapeRegExp(backendHost)}:`, 'i');
  const m = text.match(re);

  return m && m[1] ? m[1] : null;
}

function makeSiteBlock(host, target) {
  const lines = [
    `${host} {`,
    `    reverse_proxy ${target}`,
    `}`
  ];
  return lines.join('\n');
}

function makeSpecialBlock(prefix, host, target) {
  if (prefix === 'backend.rdrive') {
    const lines = [
      `${host} {`,
      `    reverse_proxy /* ${target}`,
      ``,
      `    # Support des WebSockets`,
      `    @websockets {`,
      `        header Connection *Upgrade*`,
      `        header Upgrade websocket`,
      `    }`,
      `    reverse_proxy @websockets ${target}`,
      `}`
    ];
    return lines.join('\n');
  }

  if (prefix === 'connector.rdrive' || prefix === 'document.rdrive') {
    const lines = [
      `${host} {`,
      `    reverse_proxy /* ${target}`,
      `}`
    ];
    return lines.join('\n');
  }

  return null;
}

app.post('/api/register', async (req, res) => {
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

      // Build the complete content to append
      const parts = [];
      parts.push(''); // Empty line before block comment
      parts.push(`# BLOCK ${blockNumber} - backendHost=${backendHost || 'custom targets'} machineId=${machineId || ''} time=${new Date().toISOString()}`);
      parts.push(''); // Empty line after block comment

      // Add all the blocks with empty lines between them
      parts.push(blocks.join('\n\n'));

      // Join everything with newlines and ensure proper line endings
      const contentToAppend = parts.join('\n') + '\n';

      await appendToCaddyfile(contentToAppend);
      console.log(`New registration added for ${backendHost || 'custom targets'} and Caddy configuration reloaded`);
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
