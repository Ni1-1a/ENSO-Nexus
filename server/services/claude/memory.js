'use strict';
const fs = require('fs');
const AdmZip = require('adm-zip');
const config = require('../../config');
const { db } = require('../../db');

const MAX_TEXT_DOC_CHARS = 60000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

function extractDocxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return '';
    const xml = entry.getData().toString('utf8');
    return xml
      .replace(/<w:p[ >]/g, '\n<')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_TEXT_DOC_CHARS);
  } catch {
    return '';
  }
}

/** Extract text layer from a PDF (used for local models that can't take PDFs natively). */
async function extractPdfText(filePath, charLimit) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fs.readFileSync(filePath));
    return (data.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, charLimit);
  } catch {
    return '';
  }
}

/**
 * Build content blocks describing session documents (untrusted data, clearly fenced).
 * provider 'anthropic': PDFs go as native document blocks, images as image blocks.
 * provider 'local': PDFs go as extracted text (scan without text layer -> honest note).
 */
async function buildDocumentBlocks(sessionId, provider = 'anthropic') {
  const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const blocks = [];
  const manifest = [];
  for (const f of files) {
    manifest.push(`- ${f.original_name} (${f.ext}, ${Math.round(f.size / 1024)} КБ)`);
    try {
      if (f.ext === 'pdf' && provider === 'local') {
        const text = await extractPdfText(f.stored_path, config.localAiDocCharLimit);
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true">\n` +
            (text || '(PDF без текстового слоя — вероятно скан; содержимое не извлечено, учитывай только метаданные)') +
            '\n</uploaded_document>',
        });
      } else if (f.ext === 'pdf' && f.size <= MAX_PDF_BYTES) {
        const data = fs.readFileSync(f.stored_path).toString('base64');
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
          title: f.original_name,
        });
      } else if (['txt', 'md', 'json', 'csv', 'dxf'].includes(f.ext)) {
        const text = fs.readFileSync(f.stored_path, 'utf8').slice(0, MAX_TEXT_DOC_CHARS);
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true">\n${text}\n</uploaded_document>`,
        });
      } else if (f.ext === 'docx') {
        const text = extractDocxText(f.stored_path);
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true">\n${text || '(текст извлечь не удалось)'}\n</uploaded_document>`,
        });
      } else if (['png', 'jpg', 'jpeg'].includes(f.ext) && provider === 'anthropic' && f.size <= 5 * 1024 * 1024) {
        const media = f.ext === 'png' ? 'image/png' : 'image/jpeg';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: media, data: fs.readFileSync(f.stored_path).toString('base64') },
        });
      }
      // dwg and oversized files: metadata only (already in manifest)
    } catch { /* file unreadable — stays metadata-only */ }
  }
  return { blocks, manifest };
}

/**
 * Working context for the model:
 *  full history lives in SQLite; the model gets summary + facts + Q&A + recent messages + documents.
 */
async function buildContext(sessionId, provider = 'anthropic') {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const questions = db.prepare('SELECT text, why, status, answer FROM questions WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const allMessages = db.prepare(
    "SELECT role, kind, content, created_at FROM messages WHERE session_id = ? AND kind != 'error' ORDER BY created_at",
  ).all(sessionId);
  const recent = allMessages.slice(-config.recentMessagesInContext);

  const { blocks: docBlocks, manifest } = await buildDocumentBlocks(sessionId, provider);

  const stateParts = [];
  if (session.summary) stateParts.push(`## Резюме предыдущей части диалога\n${session.summary}`);
  if (session.comment) stateParts.push(`## Комментарий пользователя к исходным данным\n${session.comment}`);
  if (manifest.length) stateParts.push(`## Загруженные файлы\n${manifest.join('\n')}`);
  if (facts.length) {
    stateParts.push('## Ранее извлечённые факты\n' + facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`).join('\n'));
  }
  const answered = questions.filter((q) => q.status === 'answered' || q.answer);
  if (answered.length) {
    stateParts.push('## Ответы пользователя на уточняющие вопросы\n' +
      answered.map((q) => `- Вопрос: ${q.text}\n  Ответ: ${q.answer}`).join('\n'));
  }
  const pending = questions.filter((q) => q.status === 'pending');
  if (pending.length) {
    stateParts.push('## Вопросы, ещё ожидающие ответа (не задавай их повторно)\n' + pending.map((q) => `- ${q.text}`).join('\n'));
  }

  const history = recent.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.kind === 'comment' ? `[Комментарий к данным] ${m.content}` :
      m.kind === 'answer' ? `[Ответ на уточняющий вопрос] ${m.content}` : m.content,
  }));

  return { session, stateText: stateParts.join('\n\n'), docBlocks, history, messagesTotal: allMessages.length };
}

module.exports = { buildContext, extractDocxText, extractPdfText };
