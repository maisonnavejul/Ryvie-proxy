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
const CADDYFILE_PATH = process.env.CADDYFILE_PATH || '/etc/caddy/Caddyfile';
const CADDY_RELOAD_CMD = process.env.CADDY_RELOAD_CMD || `caddy reload --config ${CADDYFILE_PATH}`;
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'ryvie.fr';

// Default targets per service if not provided by client
const DEFAULT_TARGETS = {
  rdrive: process.env.TARGET_RDRIVE || '100.90.20.50:3010',
  rtransfer: process.env.TARGET_RTRANSFER || '100.90.20.50:3011',
  rdrop: process.env.TARGET_RDROP || '100.90.20.50:8080',
  rpictures: process.env.TARGET_RPICTURES || '100.90.20.50:2283',
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

// Ensure static blocks for driss.ryvie.fr are present in the Caddyfile
const STATIC_MARKER_BEGIN = '# BEGIN STATIC DRISS BLOCKS';
const STATIC_MARKER_END = '# END STATIC DRISS BLOCKS';
const STATIC_BLOCKS = `\n${STATIC_MARKER_BEGIN}\nportainer.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:9000\n}\nrtransfer.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:3011\n}\nrdrop.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:8080\n}\n\nrpictures.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:2283\n}\n# principal\nrdrive.driss.ryvie.fr {\n    reverse_proxy /* 100.90.20.50:3010\n}\nbackend.rdrive.driss.ryvie.fr {\n    reverse_proxy /* 100.90.20.50:4000\n\n    # Support des WebSockets\n    @websockets {\n        header Connection *Upgrade*\n        header Upgrade websocket\n    }\n    reverse_proxy @websockets 100.90.20.50:4000\n}\n\n# OnlyOffice Connector\nconnector.rdrive.driss.ryvie.fr {\n    reverse_proxy /* 100.90.20.50:5000\n}\n\n# OnlyOffice Document Server\ndocument.rdrive.driss.ryvie.fr {\n    reverse_proxy /* 100.90.20.50:8090\n}\napp.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:3000\n}\nstatus.driss.ryvie.fr {\n    reverse_proxy 100.90.20.50:3002\n}\n${STATIC_MARKER_END}\n`;

function ensureStaticBlocks() {
  try {
    const current = fs.existsSync(CADDYFILE_PATH) ? fs.readFileSync(CADDYFILE_PATH, 'utf8') : '';
    if (current.includes(STATIC_MARKER_BEGIN) && current.includes(STATIC_MARKER_END)) {
      return false; // already present
    }
    appendToCaddyfile(STATIC_BLOCKS);
    return true;
  } catch (e) {
    console.error('Failed to ensure static Caddy blocks:', e);
    return false;
  }
}

app.post('/api/register', (req, res) => {
  try {
    const { machineId, arch, os, publicIp, services } = req.body || {};
    // Allow caller to pass a backend host/IP (e.g., via curl) that we use to form targets per service
    const backendHost = req.body?.backendHost || req.body?.backendIp || req.body?.ip;

    // Generate a unique ID (attempts up to 5 times)
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

    // Build domains and targets
    const domains = {};
    const blocks = [];
    // Known service -> default port mapping for constructing targets from backendHost
    const SERVICE_PORTS = { rdrive: 3010, rtransfer: 3011, rdrop: 8080, rpictures: 2283 };

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
      blocks.push(makeSiteBlock(host, target));
    }

    // Write blocks and reload Caddy
    if (blocks.length > 0) {
      appendToCaddyfile(blocks.join('\n'));
      exec(CADDY_RELOAD_CMD, (err, stdout, stderr) => {
        if (err) {
          console.error('Caddy reload failed:', err, stderr);
        } else {
          console.log('Caddy reloaded:', stdout);
        }
      });
    }

    return res.json({ id, domains, received: { machineId, arch, os, publicIp } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'registration_failed', details: String(e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// On startup, ensure static driss.ryvie.fr blocks are present; reload Caddy if we appended them
if (ensureStaticBlocks()) {
  exec(CADDY_RELOAD_CMD, (err, stdout, stderr) => {
    if (err) {
      console.error('Caddy reload (startup static blocks) failed:', err, stderr);
    } else {
      console.log('Caddy reloaded (startup static blocks):', stdout);
    }
  });
}

app.listen(PORT, () => {
  console.log(`registration-service listening on :${PORT}`);
});
