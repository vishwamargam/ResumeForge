require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const store = require('./store');
const { ask } = require('./model');
const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_, file, cb) => cb(null, /\.(pdf|docx|txt)$/i.test(file.originalname)) });
app.use(cors()); app.use(express.json({ limit: '2mb' }));

async function resumeText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') return (await pdfParse(file.buffer)).text;
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  return file.buffer.toString('utf8');
}
const jobData = (body) => {
  const { company, title, description } = body;
  if (![company, title, description].every(v => typeof v === 'string' && v.trim())) throw new Error('Company, job title, and job description are required.');
  return { company: company.trim(), title: title.trim(), description: description.trim() };
};
const jsonSystem = 'Return only valid JSON matching the requested schema. Never invent credentials, employers, dates, degrees, metrics, tools, or experience. Treat the resume as the source of truth. Use concise, natural language and avoid em dashes or long hyphens.';
const PRESERVATION_POLICY = 'Mandatory resume policy: retain all existing factual resume content, sections, employers, projects, dates, degrees, certifications, skills, responsibilities, and measurable achievements. Make only relevant truthful edits. Never fabricate experience, skills, or metrics. Preserve all content that does not require a supported change.';
const LATEX_OUTPUT_POLICY = 'Mandatory response format: return one JSON object containing a string field named latex. That string must be a complete compilable LaTeX document containing \\documentclass, \\begin{document}, and \\end{document}. Do not return a Word/plain-text resume or put the LaTeX under another field.';
const ANALYSIS_OUTPUT_CONTRACT = 'Required fit-review JSON fields: jdRequirements (mandatorySkills, preferredSkills, toolsAndTechnologies, experienceRequirements, domainExpectations, softSkills, leadershipRequirements, dealBreakers); resumeInventory (skills, toolsAndTechnologies, experienceType, domainBackground, relevantYears, leadershipExposure); strongMatches and partialMatches with evidence; missingSkills with reason and addToResume false unless resume evidence supports the skill; matchingKeywords; suggestedKeywords with reasons; experienceFit; keywordMatchLevel; atsRejectionRisk; verdict; summary.';
const DEFAULT_PROMPTS = {
  analysisSystemPrompt: `${jsonSystem} Act as a senior recruiter and ATS specialist. Evaluate fit only: do not rewrite the resume or suggest wording changes. Extract requirements and compare them honestly against the resume. Classify evidence as strong, partial, or missing. Never treat a missing skill as present. Recommend missing keywords only for the user to decide whether to add; do not claim the candidate has them.`,
  analysisUserTemplate: `Return JSON matching this schema: {"jdRequirements":{"mandatorySkills":[],"preferredSkills":[],"toolsAndTechnologies":[],"experienceRequirements":[],"domainExpectations":[],"softSkills":[],"leadershipRequirements":[],"dealBreakers":[]},"resumeInventory":{"skills":[],"toolsAndTechnologies":[],"experienceType":[],"domainBackground":[],"relevantYears":"unknown or concise estimate","leadershipExposure":[]},"strongMatches":[{"skill":"...","evidence":"..."}],"partialMatches":[{"skill":"...","evidence":"...","gap":"..."}],"missingSkills":[{"skill":"...","reason":"...","addToResume":false}],"matchingKeywords":["..."],"suggestedKeywords":[{"keyword":"...","reason":"..."}],"experienceFit":"Matched | Slightly Mismatched | Mismatched","keywordMatchLevel":"High | Medium | Low","atsRejectionRisk":"Low | Medium | High","verdict":"Apply | Cautious Apply | Do Not Apply","summary":"brief recruiter-style explanation"}. For each missing skill, addToResume must be false unless the resume itself contains evidence. Do not invent evidence. Resume:\n{{resumeText}}\n\nTarget: {{company}} | {{title}}\nJob description:\n{{jobDescription}}\n\nApplicant instructions for this role (context only; do not rewrite):\n{{manualInstructions}}`,
  tailoringSystemPrompt: `${jsonSystem} Tailor the resume for this specific role using only verified facts from the source resume and clearly identified user-provided facts. Preserve the candidate's existing information and sections. Do not remove employers, projects, internships, dates, degrees, certifications, skills, responsibilities, or quantified results. Keep all meaningful source content. Make only targeted, relevant edits to wording, ordering, and emphasis. If a section or detail needs no change, keep it as written. Never invent credentials, skills, experience, metrics, or claims. Add a user-selected missing keyword only if the source or user instructions provide truthful supporting evidence; otherwise leave it out and explain the gap. Apply the user's manual instructions when truthful and compatible with preserving source facts. Produce ATS-friendly, single-column, compilable LaTeX using standard headings and simple bullets, without tables, icons, columns, or graphics. Escape LaTeX special characters, especially ampersands as \\&. No long hyphens. Avoid generic AI-sounding language. Also assess the result and provide estimated scores, not scores from a particular ATS product.`,
  tailoringUserTemplate: `Return JSON {"latex":"complete LaTeX source","resumeSummary":"brief description","atsScore":0,"matchPercentage":0,"scoreSummary":"one short explanation"}. Scores must be integers from 0 to 100. ATS score reflects parseability, standard sections, and layout. Match percentage reflects supported job requirements present. If no relevant content needs improvement, keep the base resume content unchanged. Source resume:\n{{resumeText}}\n\nTarget: {{company}} | {{title}}\nJob description:\n{{jobDescription}}\n\nUser-confirmed keywords to include only when supported:\n{{chosenKeywords}}\n\nUser's additional instructions for this role:\n{{manualInstructions}}`
};
const promptFields = Object.keys(DEFAULT_PROMPTS);
const APPLICATION_STATUSES = ['applied', 'shortlisted', 'interviewing', 'hr_rounds', 'selected'];
const pdfCacheDir = path.resolve(process.env.DATA_DIR || './data', 'pdf-cache');
const pdfCompilations = new Map();
function validatePromptSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prompt settings must be an object.');
  const next = {};
  for (const field of promptFields) {
    if (typeof value[field] !== 'string' || value[field].length > 12000) throw new Error(`Prompt field ${field} is missing or exceeds 12,000 characters.`);
    next[field] = value[field];
  }
  return next;
}
function resolvePrompts(value) {
  if (typeof value === 'string' && value.trim()) {
    try { value = JSON.parse(value); } catch { throw new Error('Prompt settings were not valid JSON.'); }
  }
  const current = value || store.getPromptSettings();
  return current ? validatePromptSet({ ...DEFAULT_PROMPTS, ...current }) : DEFAULT_PROMPTS;
}
function renderPrompt(template, values) {
  return template.replace(/{{(\w+)}}/g, (_, key) => values[key] ?? '');
}
function safePdfFileName(value, company, title) {
  const proposed = typeof value === 'string' && value.trim() ? value.trim() : `${company}-${title}-resume.pdf`;
  const file = path.basename(proposed.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim();
  const stem = file.replace(/\.pdf$/i, '').trim();
  return `${stem || 'resume'}.pdf`;
}
function escapeLatexAmpersands(source) {
  const token = '__CAREERFOLIO_ESCAPED_AMPERSAND__';
  return source.replace(/\\&/g, token).replace(/&/g, '\\&').replaceAll(token, '\\&');
}
async function compileCachedPdf(cacheKey, latex) {
  fs.mkdirSync(pdfCacheDir, { recursive: true });
  const target = path.join(pdfCacheDir, `${cacheKey}.pdf`);
  if (fs.existsSync(target)) return target;
  if (pdfCompilations.has(cacheKey)) return pdfCompilations.get(cacheKey);
  const task = (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careerfolio-'));
    try {
      const tex = path.join(dir, 'resume.tex');
      fs.writeFileSync(tex, latex, 'utf8');
      const engine = process.env.LATEX_ENGINE || 'tectonic';
      const engineName = path.basename(engine).toLowerCase();
      const args = engineName.startsWith('tectonic') ? ['--keep-logs', '--outdir', dir, tex] : ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${dir}`, tex];
      try { await execFileAsync(engine, args, { timeout: 60000, windowsHide: true }); }
      catch (e) {
        if (e.code === 'ENOENT') throw new Error(`PDF engine "${engine}" was not found. Install Tectonic or set LATEX_ENGINE to your LaTeX compiler executable.`);
        throw new Error(`PDF compilation failed: ${(e.stderr || e.message).slice(0, 600)}`);
      }
      const generated = path.join(dir, 'resume.pdf');
      if (!fs.existsSync(generated)) throw new Error('The LaTeX compiler did not create a PDF.');
      await fs.promises.copyFile(generated, target);
      return target;
    } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
  })();
  pdfCompilations.set(cacheKey, task);
  try { return await task; } finally { pdfCompilations.delete(cacheKey); }
}

app.get('/api/health', (_, res) => res.json({ ok: true, provider: process.env.MODEL_PROVIDER || 'openai', model: process.env.MODEL_NAME || '' }));
app.get('/api/prompts', (_, res) => res.json(resolvePrompts()));
app.put('/api/prompts', (req, res) => {
  try { const prompts = validatePromptSet({ ...DEFAULT_PROMPTS, ...req.body.prompts }); store.savePromptSettings(prompts); res.json(prompts); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/base-resume', (_, res) => {
  const base = store.getBaseResume();
  if (!base) return res.json({ saved: false });
  const { sourceName, format, updatedAt } = base;
  res.json({ saved: true, sourceName, format, updatedAt });
});
app.put('/api/base-resume', upload.single('resume'), async (req, res) => {
  try {
    let next;
    if (req.file) {
      const resume = await resumeText(req.file);
      if (!resume.trim()) return res.status(400).json({ error: 'Could not read text from that file. Try a text based PDF, DOCX, or TXT.' });
      next = { sourceName: req.file.originalname, format: path.extname(req.file.originalname).slice(1).toLowerCase(), resumeText: resume, fileBase64: req.file.buffer.toString('base64'), updatedAt: new Date().toISOString() };
    } else if (typeof req.body.latex === 'string' && req.body.latex.trim()) {
      const latex = req.body.latex.trim();
      if (latex.length > 200000) return res.status(413).json({ error: 'LaTeX source must be under 200 KB.' });
      next = { sourceName: req.body.sourceName || 'base-resume.tex', format: 'latex', latex, resumeText: latex, updatedAt: new Date().toISOString() };
    } else return res.status(400).json({ error: 'Upload a resume file or paste LaTeX source.' });
    store.saveBaseResume(next);
    res.json({ saved: true, sourceName: next.sourceName, format: next.format, updatedAt: next.updatedAt });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not save the base resume.' }); }
});
app.delete('/api/base-resume', (_, res) => { store.saveBaseResume(null); res.status(204).end(); });
app.get('/api/base-resume/download', (req, res) => {
  const base = store.getBaseResume();
  if (!base) return res.status(404).json({ error: 'No base resume is saved.' });
  const ext = base.format === 'latex' ? 'tex' : base.format;
  const contentTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain; charset=utf-8', latex: 'application/x-tex; charset=utf-8' };
  const buffer = base.format === 'latex' ? Buffer.from(base.latex, 'utf8') : Buffer.from(base.fileBase64 || '', 'base64');
  if (!buffer.length) return res.status(404).json({ error: 'The saved base resume file is unavailable.' });
  res.setHeader('Content-Type', contentTypes[base.format] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(base.sourceName || `base-resume.${ext}`).replace(/["\r\n]/g, '')}"`);
  res.send(buffer);
});
app.get('/api/base-resume/preview', async (req, res) => {
  const base = store.getBaseResume();
  if (!base) return res.status(404).json({ error: 'No base resume is saved.' });
  if (base.format === 'pdf') {
    const buffer = Buffer.from(base.fileBase64 || '', 'base64');
    if (!buffer.length) return res.status(404).json({ error: 'The saved base PDF is unavailable.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="base-resume.pdf"');
    return res.send(buffer);
  }
  if (base.format !== 'latex') return res.status(415).json({ error: 'Preview is available for saved PDFs and LaTeX resumes.' });
  try {
    const latex = escapeLatexAmpersands(base.latex);
    const key = `base-${require('crypto').createHash('sha256').update(latex).digest('hex').slice(0, 16)}`;
    const pdf = await compileCachedPdf(key, latex);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="base-resume.pdf"');
    res.sendFile(pdf);
  } catch (error) { if (!res.headersSent) res.status(500).json({ error: error.message }); }
});
app.post('/api/base-resume/customize', async (req, res) => {
  try {
    const base = store.getBaseResume();
    if (!base) return res.status(400).json({ error: 'Save a base resume before customizing it.' });
    const instructions = String(req.body.instructions || '').trim();
    if (!instructions) return res.status(400).json({ error: 'Enter instructions for customizing the base resume.' });
    if (instructions.length > 10000) return res.status(413).json({ error: 'Instructions must be under 10,000 characters.' });
    const source = base.latex || base.resumeText;
    const system = `${jsonSystem} Apply the user's instructions to this base resume. Preserve every existing fact, employer, project, internship, date, degree, certification, skill, achievement, and meaningful section. Do not remove information. Change only what the user's instructions require and what can be supported truthfully. If no changes are needed, preserve the source content. Never invent experience or metrics. Return complete ATS-friendly single-column compilable LaTeX with standard sections and simple bullets. Escape LaTeX special characters, especially ampersands as \\&. Avoid long hyphens and generic AI-sounding language.`;
    const result = await ask(system, `Return JSON {"latex":"complete LaTeX source","notes":"short summary of changes"}. Base resume:\n${source.slice(0, 24000)}\n\nUser instructions:\n${instructions}`);
    if (typeof result.latex !== 'string' || !result.latex.includes('\\documentclass')) throw new Error('The model did not return a complete LaTeX document. Please try again.');
    res.json({ latex: escapeLatexAmpersands(result.latex), notes: result.notes || '' });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not customize the base resume.' }); }
});
app.post('/api/latex/preview', async (req, res) => {
  try {
    const latex = String(req.body.latex || '').trim();
    if (!latex.includes('\\documentclass')) return res.status(400).json({ error: 'Provide a complete LaTeX document.' });
    if (latex.length > 300000) return res.status(413).json({ error: 'LaTeX source must be under 300 KB.' });
    const safeLatex = escapeLatexAmpersands(latex);
    const key = `custom-${require('crypto').createHash('sha256').update(safeLatex).digest('hex').slice(0, 20)}`;
    const pdf = await compileCachedPdf(key, safeLatex);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="resume-preview.pdf"');
    res.sendFile(pdf);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/api/applications', (_, res) => res.json(store.all()));
app.get('/api/applications/:id', (req, res) => { const row = store.get(req.params.id); row ? res.json(row) : res.status(404).json({ error: 'Application not found.' }); });
app.patch('/api/applications/:id/status', (req, res) => {
  const row = store.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Application not found.' });
  const status = String(req.body.status || '');
  if (!APPLICATION_STATUSES.includes(status)) return res.status(400).json({ error: 'Choose a valid application status.' });
  const currentStatus = row.status || 'applied';
  const timeline = Array.isArray(row.statusTimeline) && row.statusTimeline.length ? row.statusTimeline : [{ status: currentStatus, changedAt: row.createdAt }];
  if (status === currentStatus) return res.json({ ...row, status: currentStatus, statusTimeline: timeline });
  const updated = store.update(row.id, { status, statusTimeline: [...timeline, { status, changedAt: new Date().toISOString() }] });
  res.json(updated);
});
app.post('/api/analyze', upload.single('resume'), async (req, res) => {
  try {
    const job = jobData(req.body);
    const manualInstructions = String(req.body.manualInstructions || '').trim().slice(0, 10000);
    const base = req.file ? { resumeText: await resumeText(req.file) } : store.getBaseResume();
    if (!base) return res.status(400).json({ error: 'Save a base PDF or LaTeX resume before analyzing a job.' });
    const resume = base.resumeText;
    if (!resume.trim()) return res.status(400).json({ error: 'Could not read text from that file. Try a text based PDF, DOCX, or TXT.' });
    const prompts = resolvePrompts(req.body.prompts);
    const analysisRequest = renderPrompt(prompts.analysisUserTemplate, { resumeText: resume.slice(0, 24000), company: job.company, title: job.title, jobDescription: job.description.slice(0, 14000), manualInstructions });
    const result = await ask(prompts.analysisSystemPrompt, `${analysisRequest}\n\n${ANALYSIS_OUTPUT_CONTRACT}`);
    res.json({ ...job, ...result, resumeText: resume.slice(0, 24000), manualInstructions, promptsUsed: prompts });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not analyze this resume.' }); }
});
app.post('/api/applications', async (req, res) => {
  try {
    const job = jobData(req.body); const resumeText = String(req.body.resumeText || '').trim();
    const manualInstructions = String(req.body.manualInstructions || '').trim().slice(0, 10000);
    const chosenKeywords = Array.isArray(req.body.chosenKeywords) ? req.body.chosenKeywords.filter(x => typeof x === 'string').slice(0, 40) : [];
    const unselectedKeywords = Array.isArray(req.body.unselectedKeywords) ? req.body.unselectedKeywords.filter(x => typeof x === 'string').filter(x => !chosenKeywords.includes(x)).slice(0, 80) : [];
    if (!resumeText) return res.status(400).json({ error: 'Resume text is required.' });
    const prompts = resolvePrompts(req.body.prompts);
    const tailoringSystem = `${prompts.tailoringSystemPrompt}\n\n${PRESERVATION_POLICY}\n\nKeyword selection rule: the user explicitly approved only this list: ${JSON.stringify(chosenKeywords)}. Do not add any other suggested or missing JD keywords. Keep keywords already present in the source resume. Treat the approved list as the only permission to add new keywords, and do not claim experience beyond the source resume and user instructions.\n\n${LATEX_OUTPUT_POLICY}`;
    const tailoringRequest = `${renderPrompt(prompts.tailoringUserTemplate, { resumeText: resumeText.slice(0, 24000), company: job.company, title: job.title, jobDescription: job.description.slice(0, 14000), chosenKeywords: JSON.stringify(chosenKeywords), manualInstructions })}\n\nUser-approved keywords: ${JSON.stringify(chosenKeywords)}\nSuggested keywords the user did NOT approve: ${JSON.stringify(unselectedKeywords)}. Do not add these to the resume. Keep any of them that already appear in the source resume.\n\n${LATEX_OUTPUT_POLICY}`;
    let result = await ask(tailoringSystem, tailoringRequest);
    const findLatex = value => value.latex || value.latexSource || value.latexCode || Object.entries(value).find(([name, content]) => /latex/i.test(name) && typeof content === 'string')?.[1];
    let latexSource = findLatex(result);
    const isCompleteLatex = value => typeof value === 'string' && value.includes('\\documentclass') && value.includes('\\begin{document}') && value.includes('\\end{document}');
    if (!isCompleteLatex(latexSource)) {
      const firstAttemptInfo = `The previous JSON had keys [${Object.keys(result).join(', ')}]. Its LaTeX field length was ${typeof latexSource === 'string' ? latexSource.length : 0} characters. Required markers present: documentclass=${Boolean(latexSource?.includes?.('\\documentclass'))}, beginDocument=${Boolean(latexSource?.includes?.('\\begin{document}'))}, endDocument=${Boolean(latexSource?.includes?.('\\end{document}'))}.`;
      result = await ask(tailoringSystem, `${tailoringRequest}\n\nThe previous response failed this check: ${firstAttemptInfo} Correct it now. Return the full resume as one compilable LaTeX document in the JSON field named latex. Do not return plain text, a fragment, or an alternate field name.`);
      latexSource = findLatex(result);
    }
    if (!isCompleteLatex(latexSource)) {
      const keys = Object.keys(result).join(', ') || 'none';
      const length = typeof latexSource === 'string' ? latexSource.length : 0;
      throw new Error(`The model returned JSON, but no complete LaTeX document after retry (response keys: ${keys}; LaTeX field length: ${length}). Check that the selected model supports long structured responses and that custom prompts request a full document.`);
    }
    const firstDraft = escapeLatexAmpersands(latexSource);
    const reviewSystem = `${jsonSystem} You are the final resume quality reviewer. Review the first draft for grammar, spelling, LaTeX syntax hazards, accidental factual changes, omitted source facts, and unapproved JD keyword additions. Correct genuine problems only. Preserve all source resume facts and content. Keep source keywords, but do not add any JD keywords unless explicitly in the approved list. Do not invent or imply unverified skills or experience. Return JSON with a complete LaTeX document in the latex field. No commentary in the LaTeX.`;
    const reviewRequest = `Perform the second and final review pass. Return JSON {"latex":"complete revised LaTeX document"}. If no corrections are needed, return the first draft unchanged.\n\nApproved new keywords (the user selected these): ${JSON.stringify(chosenKeywords)}\nUnapproved suggestions (must not be newly added): ${JSON.stringify(unselectedKeywords)}\n\nOriginal source resume:\n${resumeText.slice(0, 24000)}\n\nJob: ${job.company} | ${job.title}\nJob description:\n${job.description.slice(0, 14000)}\n\nUser instructions:\n${manualInstructions}\n\nFirst-pass LaTeX draft:\n${firstDraft}\n\n${LATEX_OUTPUT_POLICY}`;
    const reviewed = await ask(reviewSystem, reviewRequest);
    const reviewedLatex = findLatex(reviewed);
    if (!isCompleteLatex(reviewedLatex)) throw new Error('The final resume review did not return a complete LaTeX document. Nothing was saved; please retry.');
    result.latex = escapeLatexAmpersands(reviewedLatex);
    const atsScore = Math.max(0, Math.min(100, Math.round(Number(result.atsScore) || 0)));
    const matchPercentage = Math.max(0, Math.min(100, Math.round(Number(result.matchPercentage) || 0)));
    const now = new Date().toISOString();
    const fileName = safePdfFileName(req.body.fileName, job.company, job.title);
    const row = store.add({ id: require('crypto').randomUUID(), ...job, fileName, manualInstructions, chosenKeywords, latex: result.latex, resumeSummary: result.resumeSummary || '', atsScore, matchPercentage, scoreSummary: result.scoreSummary || '', promptsUsed: prompts, status: 'applied', statusTimeline: [{ status: 'applied', changedAt: now }], createdAt: now, updatedAt: now });
    res.status(201).json(row);
  } catch (error) { res.status(400).json({ error: error.message || 'Could not generate the resume.' }); }
});
app.get('/api/applications/:id/pdf', async (req, res) => {
  const row = store.get(req.params.id); if (!row) return res.status(404).json({ error: 'Application not found.' });
  try {
    const safeLatex = escapeLatexAmpersands(row.latex);
    if (safeLatex !== row.latex) store.update(row.id, { latex: safeLatex });
    const hash = require('crypto').createHash('sha256').update(safeLatex).digest('hex').slice(0, 16);
    const pdf = await compileCachedPdf(`${row.id}-${hash}`, safeLatex);
    res.download(pdf, row.fileName || safePdfFileName('', row.company, row.title));
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.delete('/api/applications/:id', (req, res) => store.remove(req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'Application not found.' }));
app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('*', (req, res, next) => req.path.startsWith('/api') ? next() : res.sendFile(path.resolve(__dirname, '../dist/index.html')));
const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Careerfolio API listening on ${port}`));
