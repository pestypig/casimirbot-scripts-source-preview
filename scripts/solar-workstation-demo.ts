/** Local-only demo: existing production solar route, explicit static files only. */
import express from 'express';
import path from 'node:path';
import { starWatcherRouter } from '../server/routes/star-watcher';
const app = express();
const root = process.cwd();
app.get('/', (_req, res) => res.sendFile(path.join(root, 'public/solar-workstation-demo.html')));
app.get('/solar-workstation-comparison.js', (_req, res) => res.sendFile(path.join(root, 'public/solar-workstation-comparison.js')));
app.get('/observation.json', (_req, res) => res.sendFile(path.join(root,
  'artifacts/research/solar-workstation-demo-20260926/observation.json')));
// This demo exposes only bounded image reads, not every action on the router.
app.use('/api/star-watcher', (req, res, next) => {
  const start = Date.parse(String(req.query.start ?? ''));
  const end = Date.parse(String(req.query.end ?? ''));
  if (req.method !== 'GET' || req.path !== '/sunpy-export' ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 600000 ||
      req.query.maxFrames !== '1' || req.query.includeEvents !== 'false' || req.query.bridge !== 'off') {
    res.status(400).json({ error: 'demo_allows_only_bounded_image_reads' });
    return;
  }
  next();
}, starWatcherRouter);
app.listen(5184, '127.0.0.1', () => console.log('Solar workstation demo: http://127.0.0.1:5184'));
