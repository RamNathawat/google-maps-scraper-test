/* ===== Lead Intelligence Pipeline — Core Logic ===== */

const App = {
  leads: [],
  filtered: [],
  duplicates: [],
  sortCol: null,
  sortAsc: true,
  page: 1,
  perPage: 50,
  nicheKeywords: [],
  scoreWeights: { email: 20, website: 15, phone: 10, rating: 15, reviews: 15, niche: 10, address: 5, status: 10 },
  templates: {
    introduction: `Hi {{business_name}},\n\nI came across your {{category}} business and was impressed by your {{rating}}-star rating with {{review_count}} reviews.\n\nI help businesses like yours grow their online presence and attract more customers. I'd love to discuss how we could work together.\n\nWould you be open to a quick 15-minute call this week?\n\nBest regards`,
    service_offer: `Hello {{business_name}},\n\nAs a fellow professional in the {{city}} area, I noticed your {{category}} business could benefit from our services.\n\nWe specialize in helping local businesses:\n• Increase online visibility\n• Generate more qualified leads\n• Improve customer engagement\n\nI'd be happy to provide a free consultation to explore how we can help your business grow.\n\nLooking forward to hearing from you!\n\nBest regards`,
    partnership: `Dear {{business_name}} Team,\n\nI've been following your {{category}} business in {{city}} and I'm impressed by what you've built — {{review_count}} reviews and a {{rating}}-star rating speak volumes.\n\nI believe there's a great opportunity for us to collaborate on a partnership that would be mutually beneficial.\n\nCould we schedule a brief call to explore this further?\n\nWarm regards`
  },
  activeTemplate: 'introduction',
  previewLeadIdx: 0,
};

/* ---- CSV / JSON Parser ---- */
function parseCSV(text) {
  const lines = [];
  let current = '', inQuotes = false, row = [], i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { current += '"'; i += 2; }
      else if (ch === '"') { inQuotes = false; i++; }
      else { current += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === ',') { row.push(current.trim()); current = ''; i++; }
      else if (ch === '\n' || ch === '\r') {
        row.push(current.trim()); current = '';
        if (row.some(c => c !== '')) lines.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++;
      } else { current += ch; i++; }
    }
  }
  row.push(current.trim());
  if (row.some(c => c !== '')) lines.push(row);

  if (lines.length < 2) return [];
  const headers = lines[0].map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  return lines.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i] || '');
    return obj;
  });
}

function parseJSON(text) {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

function normalizeEntry(raw) {
  return {
    id: raw.input_id || raw.id || '',
    link: raw.link || '',
    title: raw.title || raw.name || '',
    category: raw.category || '',
    categories: raw.categories || raw.category || '',
    address: raw.address || '',
    website: raw.web_site || raw.website || '',
    phone: raw.phone || '',
    email: (raw.emails || raw.email || '').toString().split(',').map(e => e.trim()).filter(Boolean),
    reviewCount: parseInt(raw.review_count || raw.reviewCount || '0') || 0,
    reviewRating: parseFloat(raw.review_rating || raw.reviewRating || '0') || 0,
    latitude: parseFloat(raw.latitude || '0') || 0,
    longitude: parseFloat(raw.longitude || raw.longtitude || '0') || 0,
    cid: raw.cid || '',
    status: raw.status || '',
    description: raw.description || raw.descriptions || '',
    city: raw.city || tryExtractCity(raw.address || raw.complete_address || ''),
    placeId: raw.place_id || raw.placeId || '',
    thumbnail: raw.thumbnail || '',
    priceRange: raw.price_range || raw.priceRange || '',
    _raw: raw,
    score: 0,
    tier: 'cold',
  };
}

function tryExtractCity(addr) {
  if (!addr) return '';
  if (typeof addr === 'object') return addr.city || '';
  const parts = addr.split(',').map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
}

/* ---- Deduplication ---- */
function deduplicateLeads(leads) {
  const seen = new Map();
  const unique = [];
  const dupes = [];
  for (const lead of leads) {
    const keys = [
      lead.cid ? `cid:${lead.cid}` : null,
      lead.placeId ? `pid:${lead.placeId}` : null,
      lead.phone ? `ph:${lead.phone.replace(/\D/g, '')}` : null,
      `na:${lead.title.toLowerCase().replace(/\s+/g, '')}|${lead.address.toLowerCase().replace(/\s+/g, '')}`,
    ].filter(Boolean);
    let isDupe = false;
    for (const k of keys) {
      if (seen.has(k)) { isDupe = true; break; }
    }
    if (isDupe) { dupes.push(lead); }
    else {
      keys.forEach(k => seen.set(k, true));
      unique.push(lead);
    }
  }
  return { unique, dupes };
}

/* ---- Lead Scoring ---- */
function scoreLead(lead, weights, nicheKw) {
  let score = 0;
  if (lead.email.length > 0) score += weights.email;
  if (lead.website) score += weights.website;
  if (lead.phone) score += weights.phone;
  if (lead.reviewRating > 0) score += (lead.reviewRating / 5) * weights.rating;
  if (lead.reviewCount > 0) score += Math.min(Math.log10(lead.reviewCount + 1) * (weights.reviews / 3), weights.reviews);
  if (lead.address && lead.city) score += weights.address;
  if (lead.status && lead.status.toLowerCase().includes('open')) score += weights.status;
  else if (!lead.status) score += weights.status * 0.5;

  if (nicheKw.length > 0) {
    const catLower = (lead.category + ' ' + lead.categories).toLowerCase();
    const match = nicheKw.some(kw => catLower.includes(kw.toLowerCase()));
    if (match) score += weights.niche;
  } else {
    score += weights.niche * 0.5;
  }

  score = Math.min(Math.round(score), 100);
  let tier = 'cold';
  if (score >= 70) tier = 'hot';
  else if (score >= 40) tier = 'warm';
  return { score, tier };
}

function scoreAllLeads() {
  for (const lead of App.leads) {
    const { score, tier } = scoreLead(lead, App.scoreWeights, App.nicheKeywords);
    lead.score = score;
    lead.tier = tier;
  }
}

/* ---- Filtering ---- */
function applyFilters() {
  const search = document.getElementById('filter-search')?.value.toLowerCase() || '';
  const category = document.getElementById('filter-category')?.value || '';
  const tier = document.getElementById('filter-tier')?.value || '';
  const minRating = parseFloat(document.getElementById('filter-rating')?.value || '0');
  const minReviews = parseInt(document.getElementById('filter-reviews')?.value || '0');
  const hasEmail = document.getElementById('filter-has-email')?.checked;
  const hasWebsite = document.getElementById('filter-has-website')?.checked;

  App.filtered = App.leads.filter(l => {
    if (search && !l.title.toLowerCase().includes(search) && !l.address.toLowerCase().includes(search) && !l.city.toLowerCase().includes(search)) return false;
    if (category && !l.category.toLowerCase().includes(category.toLowerCase())) return false;
    if (tier && l.tier !== tier) return false;
    if (minRating && l.reviewRating < minRating) return false;
    if (minReviews && l.reviewCount < minReviews) return false;
    if (hasEmail && l.email.length === 0) return false;
    if (hasWebsite && !l.website) return false;
    return true;
  });

  if (App.sortCol) sortBy(App.sortCol, false);
  App.page = 1;
  renderTable();
  updateStats();
}

/* ---- Sorting ---- */
function sortBy(col, toggle = true) {
  if (toggle) {
    if (App.sortCol === col) App.sortAsc = !App.sortAsc;
    else { App.sortCol = col; App.sortAsc = true; }
  }
  App.filtered.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'number' && typeof vb === 'number') return App.sortAsc ? va - vb : vb - va;
    if (Array.isArray(va)) va = va.join(',');
    if (Array.isArray(vb)) vb = vb.join(',');
    va = (va || '').toString().toLowerCase();
    vb = (vb || '').toString().toLowerCase();
    return App.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  App.page = 1;
  renderTable();
}

/* ---- Outreach ---- */
function renderTemplate(template, lead) {
  return template
    .replace(/\{\{business_name\}\}/g, lead.title || 'there')
    .replace(/\{\{category\}\}/g, lead.category || 'business')
    .replace(/\{\{city\}\}/g, lead.city || 'your area')
    .replace(/\{\{email\}\}/g, lead.email[0] || '')
    .replace(/\{\{phone\}\}/g, lead.phone || '')
    .replace(/\{\{website\}\}/g, lead.website || '')
    .replace(/\{\{rating\}\}/g, lead.reviewRating.toFixed(1))
    .replace(/\{\{review_count\}\}/g, lead.reviewCount.toString())
    .replace(/\{\{address\}\}/g, lead.address || '');
}

function renderPreviewHTML(template, lead) {
  return template
    .replace(/\{\{business_name\}\}/g, `<span class="highlight">${lead.title || 'there'}</span>`)
    .replace(/\{\{category\}\}/g, `<span class="highlight">${lead.category || 'business'}</span>`)
    .replace(/\{\{city\}\}/g, `<span class="highlight">${lead.city || 'your area'}</span>`)
    .replace(/\{\{email\}\}/g, `<span class="highlight">${lead.email[0] || ''}</span>`)
    .replace(/\{\{phone\}\}/g, `<span class="highlight">${lead.phone || ''}</span>`)
    .replace(/\{\{website\}\}/g, `<span class="highlight">${lead.website || ''}</span>`)
    .replace(/\{\{rating\}\}/g, `<span class="highlight">${lead.reviewRating.toFixed(1)}</span>`)
    .replace(/\{\{review_count\}\}/g, `<span class="highlight">${lead.reviewCount}</span>`)
    .replace(/\{\{address\}\}/g, `<span class="highlight">${lead.address || ''}</span>`)
    .replace(/\n/g, '<br>');
}

/* ---- Export ---- */
function exportFilteredCSV() {
  if (App.filtered.length === 0) return showToast('No data to export', 'info');
  const cols = ['title', 'category', 'address', 'city', 'phone', 'email', 'website', 'reviewRating', 'reviewCount', 'score', 'tier', 'link'];
  const header = cols.join(',');
  const rows = App.filtered.map(l => cols.map(c => {
    let v = l[c];
    if (Array.isArray(v)) v = v.join('; ');
    return `"${String(v || '').replace(/"/g, '""')}"`;
  }).join(','));
  download('leads_qualified.csv', [header, ...rows].join('\n'), 'text/csv');
  showToast(`Exported ${App.filtered.length} leads`, 'success');
}

function exportOutreachEmails() {
  const template = document.getElementById('template-editor').value;
  const emailLeads = App.filtered.filter(l => l.email.length > 0);
  if (emailLeads.length === 0) return showToast('No leads with emails', 'info');
  const output = emailLeads.map(l => {
    return `TO: ${l.email[0]}\nSUBJECT: Partnership Opportunity — ${l.title}\n\n${renderTemplate(template, l)}\n\n---\n`;
  }).join('\n');
  download('outreach_emails.txt', output, 'text/plain');
  showToast(`Generated ${emailLeads.length} emails`, 'success');
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---- Rendering ---- */
function updateStats() {
  const total = App.leads.length;
  const shown = App.filtered.length;
  const withEmail = App.leads.filter(l => l.email.length > 0).length;
  const hot = App.filtered.filter(l => l.tier === 'hot').length;
  const warm = App.filtered.filter(l => l.tier === 'warm').length;
  const cold = App.filtered.filter(l => l.tier === 'cold').length;

  setText('stat-total', total);
  setText('stat-dupes', App.duplicates.length);
  setText('stat-emails', withEmail);
  setText('stat-email-sub', total > 0 ? `${Math.round(withEmail / total * 100)}% coverage` : '');
  setText('stat-hot', hot);
  setText('stat-warm', warm);
  setText('stat-cold', cold);
  setText('stat-shown', shown);

  // populate category filter
  const catSelect = document.getElementById('filter-category');
  if (catSelect && catSelect.options.length <= 1) {
    const cats = [...new Set(App.leads.map(l => l.category).filter(Boolean))].sort();
    cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSelect.appendChild(o); });
  }
}

function renderTable() {
  const tbody = document.getElementById('leads-tbody');
  if (!tbody) return;
  const start = (App.page - 1) * App.perPage;
  const pageData = App.filtered.slice(start, start + App.perPage);

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted);">No leads match your filters</td></tr>`;
  } else {
    tbody.innerHTML = pageData.map((l, i) => {
      const globalIdx = start + i;
      const tierBadge = l.tier === 'hot' ? 'badge-hot' : l.tier === 'warm' ? 'badge-warm' : 'badge-cold';
      const tierIcon = l.tier === 'hot' ? '🔥' : l.tier === 'warm' ? '🟡' : '🔵';
      const emailDisplay = l.email.length > 0
        ? `<span class="email-cell">${escHtml(l.email[0])}</span>`
        : `<span class="no-email">—</span>`;
      const stars = '⭐ ' + l.reviewRating.toFixed(1);
      return `<tr>
        <td title="${escHtml(l.title)}">${escHtml(l.title)}</td>
        <td>${escHtml(l.category)}</td>
        <td title="${escHtml(l.address)}">${escHtml(l.city || l.address)}</td>
        <td>${stars} <span style="color:var(--text-muted)">(${l.reviewCount})</span></td>
        <td>${emailDisplay}</td>
        <td>${l.phone ? escHtml(l.phone) : '<span class="no-email">—</span>'}</td>
        <td><span class="badge ${tierBadge}">${tierIcon} ${l.score}</span></td>
        <td>
          ${l.email.length > 0 ? `<button class="btn btn-sm btn-secondary" onclick="previewOutreach(${globalIdx})" title="Generate outreach">✉️</button>` : ''}
          ${l.website ? `<a href="${escHtml(l.website)}" target="_blank" class="btn btn-sm btn-ghost" title="Visit website">🌐</a>` : ''}
          ${l.link ? `<a href="${escHtml(l.link)}" target="_blank" class="btn btn-sm btn-ghost" title="View on Maps">📍</a>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  // Pagination
  const totalPages = Math.max(1, Math.ceil(App.filtered.length / App.perPage));
  setText('page-info', `Page ${App.page} of ${totalPages} (${App.filtered.length} leads)`);
  const prevBtn = document.getElementById('page-prev');
  const nextBtn = document.getElementById('page-next');
  if (prevBtn) prevBtn.disabled = App.page <= 1;
  if (nextBtn) nextBtn.disabled = App.page >= totalPages;

  // Update sort indicators
  document.querySelectorAll('thead th[data-col]').forEach(th => {
    th.classList.toggle('active', th.dataset.col === App.sortCol);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.col === App.sortCol ? (App.sortAsc ? '▲' : '▼') : '↕';
  });
}

function previewOutreach(idx) {
  App.previewLeadIdx = idx;
  switchTab('outreach');
  updateOutreachPreview();
  document.getElementById('outreach-section')?.scrollIntoView({ behavior: 'smooth' });
}

function updateOutreachPreview() {
  const lead = App.filtered[App.previewLeadIdx] || App.filtered[0];
  if (!lead) return;
  const template = document.getElementById('template-editor')?.value || '';
  const previewBox = document.getElementById('outreach-preview');
  if (previewBox) previewBox.innerHTML = renderPreviewHTML(template, lead);
  setText('preview-lead-name', lead.title);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === `tab-${tabName}`));
}

/* ---- File Upload ---- */
function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      let rawLeads;
      if (file.name.endsWith('.json')) rawLeads = parseJSON(text);
      else rawLeads = parseCSV(text);

      if (rawLeads.length === 0) return showToast('No valid data found in file', 'info');

      const normalized = rawLeads.map(normalizeEntry);
      const { unique, dupes } = deduplicateLeads(normalized);

      App.leads = unique;
      App.duplicates = dupes;

      scoreAllLeads();
      App.filtered = [...App.leads];
      App.page = 1;

      applyFilters();
      showToast(`Loaded ${rawLeads.length} leads — ${dupes.length} duplicates removed`, 'success');

      document.getElementById('upload-section')?.classList.add('hidden');
      document.getElementById('dashboard')?.classList.remove('hidden');
    } catch (err) {
      showToast('Error parsing file: ' + err.message, 'info');
    }
  };
  reader.readAsText(file);
}

/* ---- Utilities ---- */
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${type === 'success' ? '✅' : 'ℹ️'} ${msg}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'success'));
}

/* ---- Init ---- */
document.addEventListener('DOMContentLoaded', () => {
  // Upload zone
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  if (uploadZone && fileInput) {
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
  }

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Filters
  document.querySelectorAll('.filter-bar input, .filter-bar select').forEach(el => {
    el.addEventListener('input', () => { applyFilters(); });
    el.addEventListener('change', () => { applyFilters(); });
  });

  // Sort
  document.querySelectorAll('thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => sortBy(th.dataset.col));
  });

  // Pagination
  document.getElementById('page-prev')?.addEventListener('click', () => { if (App.page > 1) { App.page--; renderTable(); } });
  document.getElementById('page-next')?.addEventListener('click', () => {
    const totalPages = Math.ceil(App.filtered.length / App.perPage);
    if (App.page < totalPages) { App.page++; renderTable(); }
  });

  // Template
  const templateSelect = document.getElementById('template-select');
  const templateEditor = document.getElementById('template-editor');
  if (templateSelect) {
    templateSelect.addEventListener('change', () => {
      App.activeTemplate = templateSelect.value;
      if (templateEditor) templateEditor.value = App.templates[App.activeTemplate];
      updateOutreachPreview();
    });
  }
  if (templateEditor) {
    templateEditor.value = App.templates.introduction;
    templateEditor.addEventListener('input', updateOutreachPreview);
  }

  // Merge tag buttons
  document.querySelectorAll('.merge-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      if (templateEditor) {
        const pos = templateEditor.selectionStart;
        const text = templateEditor.value;
        templateEditor.value = text.slice(0, pos) + btn.dataset.tag + text.slice(pos);
        templateEditor.focus();
        updateOutreachPreview();
      }
    });
  });

  // Niche keywords
  document.getElementById('niche-keywords')?.addEventListener('input', e => {
    App.nicheKeywords = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    scoreAllLeads();
    applyFilters();
  });

  // Score weight inputs
  document.querySelectorAll('.score-config input[type="number"]').forEach(input => {
    input.addEventListener('change', () => {
      App.scoreWeights[input.dataset.weight] = parseInt(input.value) || 0;
      scoreAllLeads();
      applyFilters();
    });
  });

  // Copy single outreach
  document.getElementById('btn-copy-outreach')?.addEventListener('click', () => {
    const lead = App.filtered[App.previewLeadIdx] || App.filtered[0];
    if (!lead) return;
    const template = document.getElementById('template-editor')?.value || '';
    copyToClipboard(renderTemplate(template, lead));
  });

  // Export buttons
  document.getElementById('btn-export-csv')?.addEventListener('click', exportFilteredCSV);
  document.getElementById('btn-export-emails')?.addEventListener('click', exportOutreachEmails);

  // Reset / new upload
  document.getElementById('btn-new-upload')?.addEventListener('click', () => {
    App.leads = []; App.filtered = []; App.duplicates = [];
    document.getElementById('dashboard')?.classList.add('hidden');
    document.getElementById('upload-section')?.classList.remove('hidden');
    const catSelect = document.getElementById('filter-category');
    if (catSelect) { catSelect.innerHTML = '<option value="">All Categories</option>'; }
  });
});
