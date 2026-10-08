# Careerfolio

A local job application tracker with a React frontend and Node/Express API. Save a reusable base resume as a PDF or LaTeX source, compare it with job descriptions, choose relevant suggested keywords, generate an ATS-friendly LaTeX resume, and save each application for later. Replace the saved base resume at any time.

Saved applications track status from Applied through Shortlisted, Interviewing, HR rounds, and Selected. Status changes are timestamped in each application's timeline and can be filtered in the application list.

## Setup

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and set `MODEL_PROVIDER`, `MODEL_NAME`, and `MODEL_API_KEY`.
3. Install dependencies and start the app:

   ```sh
   npm install
   npm run dev
   ```

   Open the Vite URL shown in the terminal. `npm start` serves the production build from the Node server after running `npm run build`.

Providers supported directly are OpenAI, Anthropic, and Google Gemini. Set `MODEL_PROVIDER=openai-compatible` and `MODEL_BASE_URL` for an OpenAI-compatible endpoint. The API key stays on the server and is never sent to the browser.

## PDF downloads

The application stores the generated `.tex` source and compiles a PDF for preview and download. Install [Tectonic](https://tectonic-typesetting.github.io/) and make its executable available on `PATH`, or set `LATEX_ENGINE` in `.env` to `pdflatex` or another compatible compiler executable. For Tectonic, the app uses its `--outdir` arguments; other engines use the standard LaTeX output directory arguments. If a Tectonic install reports a missing Fontconfig configuration, try `LATEX_ENGINE=pdflatex` with a TeX distribution installed. PDF preview requires the compiler at generation time.

The generated application also includes model-estimated ATS readability and job-match scores. Treat these as guidance rather than scores from any particular employer's ATS.

The application form's **View or change AI prompts** panel shows the analysis and tailoring instructions plus their templates. Use **Use for this application** for an in-memory override that resets when you start another application, or **Save permanently** to store the prompt settings in `data/prompt-settings.json`. Each saved application stores the prompt templates used to create it, which can be viewed from its resume preview.

## Data and privacy

Saved application details and generated LaTeX are stored in `data/applications.json`; the reusable base resume is stored in `data/base-resume.json`; compiled PDFs are cached under `data/pdf-cache` (or the directory set in `DATA_DIR`). The first LaTeX compilation can take longer, then preview and download reuse that cached PDF. The base PDF is stored locally with its extracted text. Extracted resume text is sent to your configured model provider to analyze and tailor each application.

The tracker currently has no sign-in or multi-user isolation and is intended for a personal/local deployment.
