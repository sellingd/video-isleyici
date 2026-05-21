const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app  = express();
const PORT = process.env.PORT || 3000;

// Temp dir for uploads & outputs
const TMP = path.join(os.tmpdir(), 'video-isleyici');
fs.mkdirSync(TMP, { recursive: true });

// Jobs store
const jobs = {};

// Multer — memory storage, max 500MB per file
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(TMP, req.jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.fieldname + '_' + file.originalname)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Attach jobId before multer runs
app.use('/api/process', (req, res, next) => {
  req.jobId = uuidv4().slice(0, 8);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Process videos ───────────────────────────────────────────────────
app.post('/api/process', upload.any(), async (req, res) => {
  const jobId    = req.jobId;
  const firmId   = req.body.firm_id;
  const dir      = path.join(TMP, jobId);
  const outDir   = path.join(dir, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const FIRMS = {
    'sefer':      'SeferDernegi',
    'img-avrupa': 'IMGAvrupa',
    'img-tr':     'IMGTurkiye',
  };
  const prefix = FIRMS[firmId] || 'Video';

  // Find intro, outro, main videos from uploaded files
  const introFile = req.files.find(f => f.fieldname === 'intro');
  const outroFile = req.files.find(f => f.fieldname === 'outro');
  const videoFiles = req.files.filter(f => f.fieldname === 'video').sort((a,b) => a.originalname.localeCompare(b.originalname));

  if (!introFile || !outroFile || videoFiles.length === 0) {
    return res.json({ error: 'Intro, outro ve en az 1 video gerekli.' });
  }

  jobs[jobId] = {
    total:    videoFiles.length,
    done:     0,
    errors:   0,
    statuses: videoFiles.map(() => 'waiting'),
    log:      [],
    finished: false,
    outputs:  [],
    _sent:    0,
  };

  res.json({ job_id: jobId });

  // Process in background
  processJob(jobId, dir, outDir, introFile.path, outroFile.path, videoFiles, prefix);
});

async function processJob(jobId, dir, outDir, introPath, outroPath, videoFiles, prefix) {
  const job = jobs[jobId];

  function jlog(msg, type = '') {
    job.log.push({ msg, type });
    console.log(`[${jobId}] ${msg}`);
  }

  for (let i = 0; i < videoFiles.length; i++) {
    job.statuses[i] = 'processing';
    const vf   = videoFiles[i];
    const base = path.basename(vf.originalname, path.extname(vf.originalname));
    const outFile = path.join(outDir, `${prefix}_${base}_final.mp4`);
    const listFile = path.join(dir, `list_${i}.txt`);

    jlog(`[${i+1}/${videoFiles.length}] ${vf.originalname} işleniyor...`);

    // Write concat list
    fs.writeFileSync(listFile,
      `file '${introPath}'\nfile '${vf.path}'\nfile '${outroPath}'\n`
    );

    try {
      await runFFmpeg(listFile, outFile);
      job.statuses[i] = 'done';
      job.done++;
      job.outputs.push({ name: `${prefix}_${base}_final.mp4`, path: outFile, jobId });
      jlog(`[${i+1}/${videoFiles.length}] ✓ Tamamlandı`, 's');
    } catch (err) {
      job.statuses[i] = 'error';
      job.errors++;
      jlog(`[${i+1}/${videoFiles.length}] Hata: ${err.message}`, 'e');
    }
  }

  job.finished = true;
  jlog(`Tamamlandı: ${job.done} başarılı, ${job.errors} hatalı.`, job.errors ? 'w' : 's');

  // Cleanup input files after 10 minutes
  setTimeout(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete jobs[jobId];
  }, 10 * 60 * 1000);
}

function runFFmpeg(listFile, outFile) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 26',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart'
      ])
      .output(outFile)
      .on('end', resolve)
      .on('error', err => reject(err))
      .run();
  });
}

// ── API: Job status ───────────────────────────────────────────────────────
app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.json({ error: 'Job bulunamadı' });
  const sent    = job._sent || 0;
  const newLogs = job.log.slice(sent);
  job._sent     = sent + newLogs.length;
  res.json({
    done:     job.done,
    errors:   job.errors,
    statuses: job.statuses,
    log:      newLogs,
    finished: job.finished,
    outputs:  job.finished ? job.outputs.map(o => ({ name: o.name, url: `/api/download/${o.jobId}/${o.name}` })) : [],
  });
});

// ── API: Download output ──────────────────────────────────────────────────
app.get('/api/download/:jobId/:filename', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).send('Dosya bulunamadı');
  const output = job.outputs.find(o => o.name === req.params.filename);
  if (!output || !fs.existsSync(output.path)) return res.status(404).send('Dosya bulunamadı');
  res.download(output.path, output.name);
});

app.listen(PORT, () => {
  console.log(`\n✅  Video İşleyici → http://localhost:${PORT}\n`);
});
