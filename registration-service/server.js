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
  const current = fs.readFileSync(CADDYFILE_PATH, 'utf8');
  const updated = current.endsWith('\n') ? current + content : current + '\n' + content;
  fs.writeFileSync(CADDYFILE_PATH, updated, 'utf8');
}

function makeSiteBlock(host, target) {
  return `\n${host} {\n    reverse_proxy ${target}\n}\n`;
}

app.post('/api/register', (req, res) => {
  try {
    const { machineId, arch, os, publicIp, services } = req.body || {};

    const id = nanoid(8);

    const requested = Array.isArray(services)
      ? services.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
      : ['rdrive'];

    // Build domains and targets
    const domains = {};
    const blocks = [];

    for (const svc of requested) {
      const prefix = String(svc).toLowerCase();
      const host = `${prefix}.${id}.${BASE_DOMAIN}`;

      // Target priority: body.services[].target OR DEFAULT_TARGETS
      let target;
      const svcObj = (req.body?.services || []).find((x) => (x?.name || x) === svc);
      if (svcObj && svcObj.target) {
        target = svcObj.target;
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

app.listen(PORT, () => {
  console.log(`registration-service listening on :${PORT}`);
});
