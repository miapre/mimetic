/**
 * Mimic AI — Build Completion Contract
 *
 * Enforces a mandatory post-build contract. After every build:
 * 1. Truth check — is the output coherent and inspectable?
 * 2. Learning artifacts — generated and persisted
 * 3. HTML report — rich artifact for user review
 * 4. User-visible summary — returned to caller
 *
 * Usage:
 *   import { completeBuild } from './build-completion.js';
 *   const report = await completeBuild(buildResult, bridgeCall);
 *   // report.userSummary is the text to show the user
 *   // report.htmlReportPath is the HTML file path
 */

import { recordBuild } from './build-learning.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, '..', '..');

function localDateDir(now) {
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
function localTimeFile(now) {
  return `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
}

/**
 * Complete a build with the mandatory contract.
 *
 * @param {Object} buildResult
 * @param {string} buildResult.source — build input description
 * @param {string} buildResult.artboardId — Figma artboard node ID
 * @param {number} buildResult.dsComponents — count
 * @param {number} buildResult.primitives — count
 * @param {number} buildResult.iconCount — count
 * @param {string[]} buildResult.componentNames — DS components used
 * @param {string[]} buildResult.sections — sections built
 * @param {Object[]} buildResult.dsCompliance — compliance log
 * @param {number} buildResult.startTime — Date.now() at build start
 * @param {boolean} [buildResult.failed] — true if build failed
 * @param {string} [buildResult.failureReason] — why it failed
 * @param {Function} [bridgeCall] — bridge call function for truth check
 * @returns {Object} { status, userSummary, artifactPaths, htmlReportPath, truthCheck }
 */
export async function completeBuild(buildResult, bridgeCall) {
  const now = new Date();
  const elapsed = buildResult.startTime ? Math.round((Date.now() - buildResult.startTime) / 1000) : null;

  // ── 1. TRUTH CHECK ──
  let truthCheck = { passed: false, reason: 'not_checked' };
  if (!buildResult.failed && buildResult.artboardId && bridgeCall) {
    try {
      const pageNodes = await bridgeCall('get_page_nodes', {});
      const nodes = pageNodes.nodes || [];
      const artboard = nodes.find(n => n.id === buildResult.artboardId);

      if (!artboard) {
        truthCheck = { passed: false, reason: 'artboard_not_found' };
      } else if (artboard.width < 100 || artboard.height < 100) {
        truthCheck = { passed: false, reason: 'artboard_collapsed: ' + artboard.width + 'x' + artboard.height };
      } else {
        truthCheck = { passed: true, reason: 'artboard_exists', width: artboard.width, height: artboard.height };
      }
    } catch (e) {
      truthCheck = { passed: false, reason: 'truth_check_error: ' + e.message };
    }
  } else if (buildResult.failed) {
    truthCheck = { passed: false, reason: 'build_failed: ' + (buildResult.failureReason || 'unknown') };
  }

  const buildStatus = buildResult.failed ? 'FAILED' : truthCheck.passed ? 'SUCCESS' : 'PARTIAL';

  // ── 2. LEARNING ARTIFACTS ──
  const learning = recordBuild({
    source: buildResult.source || 'unknown',
    dsComponents: buildResult.dsComponents || 0,
    primitives: buildResult.primitives || 0,
    componentNames: buildResult.componentNames || [],
    fallbackTypes: buildResult.sections || [],
    figmaNodeId: buildResult.artboardId,
    dsCompliance: buildResult.dsCompliance || [],
  });

  // ── 3. HTML REPORT ──
  const htmlReportPath = generateHtmlReport(now, buildResult, buildStatus, truthCheck, learning, elapsed);

  // ── 4. USER SUMMARY ──
  const compliance = buildResult.dsCompliance || [];
  const dsTextStyles = compliance.filter(c => c?.textStyle === 'ds_style').length;
  const dsFills = compliance.filter(c => c?.fill === 'ds_style' || c?.fill === 'ds_variable').length;
  const rawFills = compliance.filter(c => c?.fill === 'raw_fallback').length;

  const lines = [
    `## Build ${buildStatus}`,
    '',
    `**Source:** ${buildResult.source || 'unknown'}`,
    buildResult.artboardId ? `**Figma artboard:** ${buildResult.artboardId}` : null,
    truthCheck.passed ? `**Output:** ${truthCheck.width}×${truthCheck.height} — inspectable` : `**Output:** ${truthCheck.reason}`,
    '',
    '### Metrics',
    `- DS components: ${buildResult.dsComponents || 0}`,
    `- Icons: ${buildResult.iconCount || 0}`,
    `- Primitives: ${buildResult.primitives || 0}`,
    `- Sections: ${(buildResult.sections || []).join(', ')}`,
    dsTextStyles > 0 ? `- DS text styles: ${dsTextStyles}` : null,
    dsFills > 0 ? `- DS fills: ${dsFills}` : null,
    rawFills > 0 ? `- Raw fills: ${rawFills}` : null,
    elapsed ? `- Build time: ~${elapsed}s` : null,
    '',
    '### Generated Files',
    `- Build artifact: \`${learning.artifactPath}\``,
    `- Build report: \`${learning.reportPath}\``,
    `- HTML report: \`${htmlReportPath}\``,
    learning.knowledgePath ? `- Knowledge: \`${learning.knowledgePath}\`` : null,
    '',
    learning.success ? '### What Mimic Learned' : null,
    learning.success ? `- Components tracked: ${Object.keys(learning).length > 0 ? 'updated' : 'none'}` : null,
    learning.success ? `- Recommendations: ${learning.recommendationsPath ? 'updated' : 'none new'}` : null,
  ].filter(Boolean).join('\n');

  return {
    status: buildStatus,
    truthCheck,
    userSummary: lines,
    artifactPaths: {
      buildArtifact: learning.artifactPath,
      buildReport: learning.reportPath,
      htmlReport: htmlReportPath,
      knowledge: learning.knowledgePath,
    },
    htmlReportPath,
    elapsed,
  };
}

function generateHtmlReport(now, buildResult, status, truthCheck, learning, elapsed) {
  const dateDir = localDateDir(now);
  const dir = resolve(PROJECT_ROOT, 'mimic', 'reports', dateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${localTimeFile(now)}.html`);

  const compliance = buildResult.dsCompliance || [];
  const dsText = compliance.filter(c => c?.textStyle === 'ds_style').length;
  const dsFills = compliance.filter(c => c?.fill === 'ds_style' || c?.fill === 'ds_variable').length;
  const rawFills = compliance.filter(c => c?.fill === 'raw_fallback').length;
  const dsStrokes = compliance.filter(c => c?.stroke === 'ds_style' || c?.stroke === 'ds_variable').length;

  const statusColor = status === 'SUCCESS' ? '#16a34a' : status === 'FAILED' ? '#dc2626' : '#d97706';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mimic Build Report — ${now.toISOString()}</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 32px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 8px; }
  h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: #475569; }
  .status { display: inline-block; padding: 4px 12px; border-radius: 100px; font-size: 13px; font-weight: 600; color: #fff; background: ${statusColor}; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0; }
  .metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .metric-value { font-size: 28px; font-weight: 700; color: #0f172a; }
  .metric-label { font-size: 12px; color: #64748b; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
  th { font-weight: 600; color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #475569; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 500; }
  .tag-ds { background: #dcfce7; color: #166534; }
  .tag-raw { background: #fef3c7; color: #92400e; }
  .tag-none { background: #f1f5f9; color: #64748b; }
</style>
</head>
<body>
<div class="card">
  <h1>Mimic Build Report</h1>
  <p style="color:#64748b;margin:0 0 16px">${now.toLocaleString()} · ${buildResult.source || 'unknown'}</p>
  <span class="status">${status}</span>
  ${truthCheck.passed ? `<span style="margin-left:8px;color:#64748b;font-size:13px">${truthCheck.width}×${truthCheck.height} · inspectable</span>` : `<span style="margin-left:8px;color:#dc2626;font-size:13px">${truthCheck.reason}</span>`}
</div>

<div class="card">
  <h2>Metrics</h2>
  <div class="grid">
    <div class="metric"><div class="metric-value">${buildResult.dsComponents || 0}</div><div class="metric-label">DS Components</div></div>
    <div class="metric"><div class="metric-value">${buildResult.iconCount || 0}</div><div class="metric-label">DS Icons</div></div>
    <div class="metric"><div class="metric-value">${buildResult.primitives || 0}</div><div class="metric-label">Primitives</div></div>
    <div class="metric"><div class="metric-value">${elapsed ? elapsed + 's' : '—'}</div><div class="metric-label">Build Time</div></div>
  </div>
</div>

<div class="card">
  <h2>DS Compliance</h2>
  <table>
    <thead><tr><th>Token Type</th><th>DS-Backed</th><th>Raw</th></tr></thead>
    <tbody>
      <tr><td>Text styles</td><td><span class="tag tag-ds">${dsText}</span></td><td>${compliance.filter(c => c?.textStyle === 'raw_fallback').length || '0'}</td></tr>
      <tr><td>Fills</td><td><span class="tag tag-ds">${dsFills}</span></td><td>${rawFills > 0 ? '<span class="tag tag-raw">' + rawFills + '</span>' : '0'}</td></tr>
      <tr><td>Strokes</td><td><span class="tag tag-ds">${dsStrokes}</span></td><td>${compliance.filter(c => c?.stroke === 'raw_fallback').length || '0'}</td></tr>
    </tbody>
  </table>
</div>

<div class="card">
  <h2>Sections Built</h2>
  <p>${(buildResult.sections || []).join(' · ') || 'none'}</p>
</div>

<div class="card">
  <h2>Generated Files</h2>
  <table>
    <tbody>
      <tr><td>Build artifact</td><td class="mono">${learning.artifactPath || '—'}</td></tr>
      <tr><td>Build report</td><td class="mono">${learning.reportPath || '—'}</td></tr>
      <tr><td>HTML report</td><td class="mono">${path}</td></tr>
      <tr><td>Knowledge</td><td class="mono">${learning.knowledgePath || '—'}</td></tr>
    </tbody>
  </table>
</div>

<div class="card" style="color:#64748b;font-size:12px">
  Generated by Mimic AI · Build completion contract v1
</div>
</body>
</html>`;

  writeFileSync(path, html, 'utf8');
  return path;
}
