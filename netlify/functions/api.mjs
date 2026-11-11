import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const STATUSES = new Set(['New Report', 'Under Review', 'Assigned', 'In Progress', 'Verification', 'Closed']);
const RANKS = new Set(['A', 'B', 'C']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function env(name) { return (process.env[name] || '').trim(); }
function requireDbConfig() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่า SUPABASE_URL และ SUPABASE_SECRET_KEY ใน Netlify');
  return { url: url.replace(/\/$/, ''), key };
}
async function db(table, method = 'GET', params = {}, body = undefined, prefer = '') {
  const { url, key } = requireDbConfig();
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = data?.message || data?.hint || data?.details || `Database returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}
function reportFromDb(row) {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    dept: row.dept,
    place: row.place,
    equipment: row.equipment || '',
    detail: row.detail,
    status: row.status,
    date: row.report_date,
    reporter: row.reporter,
    reporterId: row.reporter_id,
    photos: row.photos || [],
    suggestion: row.suggestion || '',
    action: row.action || '',
    ownerId: row.owner_id || '',
    ownerName: row.owner_name || 'Admin - รอมอบหมาย',
    rank: row.rank || '',
    notificationNo: row.notification_no || '',
    isCleared: row.is_cleared === true,
    clearReason: row.clear_reason || '',
    duplicateOf: row.duplicate_of || '',
    clearedAt: row.cleared_at || null,
    clearedBy: row.cleared_by || '',
    history: row.history || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function employeePublic(row) {
  return { id: row.employee_id, name: row.full_name, dept: row.department };
}
function employeeAdmin(row) {
  return { ...employeePublic(row), email: row.email || '', active: row.active !== false };
}
function safeString(value, max, label, required = false) {
  const v = String(value ?? '').trim();
  if (required && !v) throw new Error(`${label} จำเป็นต้องกรอก`);
  if (v.length > max) throw new Error(`${label} ยาวเกิน ${max} ตัวอักษร`);
  return v;
}
function getSessionSecret() {
  const secret = env('ADMIN_SESSION_SECRET');
  if (secret.length < 32) throw new Error('กรุณาตั้ง ADMIN_SESSION_SECRET ความยาวอย่างน้อย 32 ตัวอักษร');
  return secret;
}
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyToken(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', getSessionSecret()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Date.now();
  } catch { return false; }
}
function safeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function requireAdmin(request) {
  if (!verifyToken(request)) throw Object.assign(new Error('กรุณาเข้าสู่ระบบ Admin ใหม่'), { status: 401 });
}
async function getEmployeeById(id) {
  const rows = await db('employees', 'GET', {
    select: 'employee_id,full_name,department,email,active',
    employee_id: `eq.${id}`,
    active: 'eq.true',
    limit: '1'
  });
  return rows?.[0] || null;
}
async function sendMail({ to, subject, text, reportId }) {
  const apiKey = env('RESEND_API_KEY');
  const from = env('RESEND_FROM_EMAIL');
  if (!to) return { status: 'skipped', error: 'ไม่พบ E-mail ในทะเบียนพนักงาน' };
  if (!apiKey || !from) return { status: 'not_configured', error: 'ยังไม่ได้ตั้งค่า RESEND_API_KEY หรือ RESEND_FROM_EMAIL' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return { status: 'failed', error: result.message || result.name || `Resend HTTP ${response.status}` };
    return { status: 'sent', providerId: result.id || null, error: null };
  } catch (error) {
    return { status: 'failed', error: error.message || 'Email service unavailable' };
  }
}
async function logMail(reportId, recipient, subject, outcome) {
  try {
    await db('email_logs', 'POST', { select: 'id' }, {
      report_id: reportId,
      recipient,
      subject,
      status: outcome.status,
      provider_id: outcome.providerId || null,
      error: outcome.error || null
    }, 'return=minimal');
  } catch (error) {
    console.error('Could not write email log:', error.message);
  }
}
async function notifyReporter(report, kind) {
  const employee = await getEmployeeById(report.reporter_id);
  const to = employee?.email || '';
  if (!to) {
    await logMail(report.id, '', kind === 'created' ? `รับรายงาน ${report.id}` : `อัปเดต ${report.id}`, { status: 'skipped', error: 'ไม่พบ E-mail ในทะเบียนพนักงาน' });
    return;
  }
  const isCreated = kind === 'created';
  const subject = isCreated ? `รับรายงาน Safety Observation ${report.id}` : `อัปเดตความคืบหน้า Safety Observation ${report.id}`;
  const text = isCreated
    ? `ระบบได้รับรายงานของคุณแล้ว\nเลขที่: ${report.id}\nประเภท: ${report.type} / ${report.category}\nสถานะ: ${report.status}\nระบบจะแจ้งความคืบหน้าเมื่อ Admin อัปเดต\n\nSafety Observation System`
    : `รายงาน: ${report.id}\nประเภท: ${report.type} / ${report.category}\nสถานะ: ${report.status}\nผู้รับผิดชอบปัจจุบัน: ${report.owner_name || 'รอมอบหมาย'}\nระดับความรุนแรง: ${report.rank ? `RANK ${report.rank}` : 'รอประเมิน'}\nความคืบหน้า: ${report.action || '-'}\n\nSafety Observation System`;
  const outcome = await sendMail({ to, subject, text, reportId: report.id });
  await logMail(report.id, to, subject, outcome);
}
async function publicBootstrap() {
  const [reportRows, employeeRows] = await Promise.all([
    db('reports', 'GET', { select: 'id,type,category,dept,place,equipment,detail,status,report_date,reporter,reporter_id,suggestion,action,owner_id,owner_name,rank,notification_no,is_cleared,clear_reason,duplicate_of,cleared_at,cleared_by,history,created_at,updated_at', order: 'created_at.desc', limit: '2000' }),
    db('employees', 'GET', { select: 'employee_id,full_name,department', active: 'eq.true', order: 'full_name.asc', limit: '5000' })
  ]);
  return json({ reports: (reportRows || []).map(reportFromDb), employees: (employeeRows || []).map(employeePublic) });
}
async function publicReportDetail(id) {
  const rows = await db('reports', 'GET', { select: '*', id: `eq.${id}`, limit: '1' });
  if (!rows?.[0]) return json({ error: 'ไม่พบรายงานนี้' }, 404);
  return json({ report: reportFromDb(rows[0]) });
}
async function createReport(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 8 * 1024 * 1024) return json({ error: 'ไฟล์หรือข้อมูลมีขนาดใหญ่เกินไป (สูงสุด 8 MB ต่อรายงาน)' }, 413);
  const input = await request.json();
  const type = safeString(input.type, 60, 'ประเภทเหตุการณ์', true);
  if (!['Unsafe Action', 'Unsafe Condition', 'Near Miss', '5S'].includes(type)) return json({ error: 'ประเภทเหตุการณ์ไม่ถูกต้อง' }, 400);
  const reporterId = safeString(input.reporterId, 80, 'รหัสพนักงาน', true);
  const employee = await getEmployeeById(reporterId);
  const photos = Array.isArray(input.photos) ? input.photos.slice(0, 5) : [];
  let photoBytes = 0;
  for (const photo of photos) {
    if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/i.test(photo)) return json({ error: 'รูปภาพไม่ถูกต้อง' }, 400);
    const size = Math.ceil((photo.split(',')[1] || '').length * 0.75);
    photoBytes += size;
    if (size > 1.5 * 1024 * 1024) return json({ error: 'รูปภาพแต่ละรูปต้องมีขนาดไม่เกิน 1.5 MB' }, 413);
  }
  if (photoBytes > 5 * 1024 * 1024) return json({ error: 'ขนาดรูปภาพรวมต้องไม่เกิน 5 MB' }, 413);
  const now = new Date();
  const reportDate = safeString(input.date || now.toISOString().slice(0, 10), 10, 'วันที่');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' }, 400);
  const id = `SAF-${reportDate.slice(0, 4)}-${randomBytes(4).toString('hex').toUpperCase()}`;
  const row = {
    id,
    type,
    category: safeString(input.category, 180, 'หัวข้อย่อย', true),
    dept: safeString(employee?.department || input.dept, 100, 'แผนก', true),
    place: safeString(input.place, 180, 'สถานที่เกิดเหตุ', true),
    equipment: safeString(input.equipment, 180, 'เครื่องจักร/อุปกรณ์'),
    detail: safeString(input.detail, 5000, 'รายละเอียดเหตุการณ์', true),
    status: 'New Report',
    report_date: reportDate,
    reporter: safeString(employee?.full_name || input.reporter, 150, 'ชื่อผู้รายงาน', true),
    reporter_id: reporterId,
    photos,
    suggestion: safeString(input.suggestion, 3000, 'แนวทางแก้ไข'),
    action: 'รอ Admin ตรวจสอบและมอบหมายผู้รับผิดชอบ',
    owner_id: null,
    owner_name: 'Admin - รอรับเรื่อง',
    rank: null,
    history: [{ date: now.toISOString(), status: 'New Report', owner: 'Admin - รอรับเรื่อง', note: 'รับแจ้งรายงาน' }]
  };
  const created = await db('reports', 'POST', { select: '*' }, row, 'return=representation');
  const saved = created?.[0];
  if (!saved) throw new Error('ไม่สามารถบันทึกรายงานได้');
  await notifyReporter(saved, 'created');
  return json({ report: reportFromDb(saved) }, 201);
}
async function adminReports() {
  const rows = await db('reports', 'GET', { select: 'id,type,category,dept,place,equipment,detail,status,report_date,reporter,reporter_id,suggestion,action,owner_id,owner_name,rank,notification_no,is_cleared,clear_reason,duplicate_of,cleared_at,cleared_by,history,created_at,updated_at', order: 'created_at.desc', limit: '2000' });
  return json({ reports: (rows || []).map(reportFromDb) });
}
async function updateReport(id, request) {
  const input = await request.json();
  const found = await db('reports', 'GET', { select: '*', id: `eq.${id}`, limit: '1' });
  const current = found?.[0];
  if (!current) return json({ error: 'ไม่พบรายงานนี้' }, 404);
  const changes = {};
  if (input.status !== undefined) {
    if (!STATUSES.has(input.status)) return json({ error: 'สถานะไม่ถูกต้อง' }, 400);
    changes.status = input.status;
  }
  if (input.rank !== undefined) {
    if (input.rank !== null && input.rank !== '' && !RANKS.has(input.rank)) return json({ error: 'Rank ไม่ถูกต้อง' }, 400);
    changes.rank = input.rank || null;
  }
  if (input.ownerId !== undefined) {
    const ownerId = input.ownerId || null;
    if (ownerId) {
      const owner = await getEmployeeById(ownerId);
      if (!owner) return json({ error: 'ไม่พบรหัสผู้รับผิดชอบในทะเบียนพนักงาน' }, 400);
      changes.owner_id = owner.employee_id;
      changes.owner_name = `${owner.full_name} (${owner.employee_id})`;
    } else {
      changes.owner_id = null;
      changes.owner_name = 'Admin - รอมอบหมาย';
    }
  }
  const effectiveOwnerId = input.ownerId !== undefined ? input.ownerId : current.owner_id;
  if (input.status === 'Assigned' && !effectiveOwnerId) return json({ error: 'กรุณาเลือกผู้รับผิดชอบก่อนเปลี่ยนสถานะเป็น Assigned' }, 400);
  if (input.clearDuplicate === true && current.is_cleared === true) return json({ error: 'รายงานนี้ถูก Clear ไปแล้ว' }, 409);
  if (input.action !== undefined) changes.action = safeString(input.action, 3000, 'ความคืบหน้า');
  if (input.suggestion !== undefined) changes.suggestion = safeString(input.suggestion, 3000, 'แนวทางแก้ไข');
  if (input.notificationNo !== undefined) changes.notification_no = safeString(input.notificationNo, 100, 'เลข Notification');
  if (input.clearDuplicate === true) {
    const reason = safeString(input.clearReason, 1000, 'เหตุผลการ Clear', true);
    const duplicateOf = safeString(input.duplicateOf, 100, 'เลขรายงานหลักที่ซ้ำกัน', true);
    if (duplicateOf === id) return json({ error: 'ไม่สามารถระบุรายงานเดียวกันเป็นรายการหลักได้' }, 400);
    const target = await db('reports', 'GET', { select: 'id', id: `eq.${duplicateOf}`, limit: '1' });
    if (!target?.[0]) return json({ error: 'ไม่พบเลขรายงานหลักที่ระบุ' }, 400);
    changes.is_cleared = true;
    changes.clear_reason = reason;
    changes.duplicate_of = duplicateOf;
    changes.cleared_at = new Date().toISOString();
    changes.cleared_by = 'Admin';
  }
  const changed = Object.entries(changes).some(([key, value]) => String(current[key] ?? '') !== String(value ?? ''));
  if (!changed) return json({ report: reportFromDb(current), email: 'not_needed' });
  const next = { ...current, ...changes };
  const ownerName = next.owner_name || 'Admin - รอมอบหมาย';
  const note = [`สถานะ: ${next.status}`, `ผู้รับผิดชอบ: ${ownerName}`, `Rank: ${next.rank ? `RANK ${next.rank}` : 'รอประเมิน'}`, next.action].filter(Boolean).join(' · ');
  const history = Array.isArray(current.history) ? [...current.history] : [];
  if (input.clearDuplicate === true) history.unshift({ date: new Date().toISOString(), status: next.status, owner: 'Admin', note: `Clear รายงานซ้ำ: ${changes.clear_reason} · รายงานหลัก: ${changes.duplicate_of}` });
  history.unshift({ date: new Date().toISOString(), status: next.status, owner: ownerName, note });
  changes.history = history.slice(0, 200);
  changes.updated_at = new Date().toISOString();
  const updated = await db('reports', 'PATCH', { id: `eq.${id}`, select: '*' }, changes, 'return=representation');
  const saved = updated?.[0];
  if (!saved) throw new Error('บันทึกการเปลี่ยนแปลงไม่สำเร็จ');
  await notifyReporter(saved, 'updated');
  let assignmentEmail = null;
  if (saved.status === 'Assigned' && saved.owner_id && (current.status !== 'Assigned' || current.owner_id !== saved.owner_id)) {
    const assignee = await getEmployeeById(saved.owner_id);
    const subject = `มอบหมายงาน Safety Observation ${saved.id}`;
    const text = `คุณได้รับมอบหมายให้รับผิดชอบรายงาน Safety Observation\nเลขที่รายงาน: ${saved.id}\nประเภท: ${saved.type} / ${saved.category}\nแผนก: ${saved.dept}\nสถานที่: ${saved.place}\nเลข Notification: ${saved.notification_no || '-'}\nรายละเอียด: ${saved.detail}\n\nกรุณาเข้าสู่ระบบเพื่อติดตามและอัปเดตความคืบหน้า\nSafety Observation System`;
    assignmentEmail = await sendMail({ to: assignee?.email || '', subject, text, reportId: saved.id });
    await logMail(saved.id, assignee?.email || '', subject, assignmentEmail);
  }
  return json({ report: reportFromDb(saved), assignmentEmail });
}
async function listEmployees() {
  const rows = await db('employees', 'GET', { select: '*', order: 'full_name.asc', limit: '5000' });
  return json({ employees: (rows || []).map(employeeAdmin) });
}
function employeeRow(input) {
  return {
    employee_id: safeString(input.id, 80, 'รหัสพนักงาน', true),
    full_name: safeString(input.name, 150, 'ชื่อพนักงาน', true),
    department: safeString(input.dept, 100, 'แผนก', true),
    email: safeString(input.email, 254, 'E-mail'),
    active: input.active !== false,
    updated_at: new Date().toISOString()
  };
}
async function upsertEmployees(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 1000) return json({ error: 'ต้องส่งรายชื่อพนักงาน 1–1,000 รายการต่อครั้ง' }, 400);
  const rows = items.map(employeeRow);
  const ids = rows.map(x => x.employee_id.toLowerCase());
  if (new Set(ids).size !== ids.length) return json({ error: 'พบรหัสพนักงานซ้ำในไฟล์ที่นำเข้า' }, 400);
  await db('employees', 'POST', { on_conflict: 'employee_id' }, rows, 'resolution=merge-duplicates,return=minimal');
  return json({ count: rows.length });
}
async function mailLogs() {
  const rows = await db('email_logs', 'GET', { select: 'id,report_id,recipient,subject,status,provider_id,error,created_at', order: 'created_at.desc', limit: '500' });
  return json({ messages: (rows || []).map(x => ({ id: x.id, reportId: x.report_id, recipient: x.recipient, subject: x.subject, status: x.status, providerId: x.provider_id, error: x.error, createdAt: x.created_at })) });
}
export default async (request, context) => {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    const url = new URL(request.url);
    const base = '/.netlify/functions/api';
    let path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname.replace(/^\/api/, '');
    path = path.replace(/\/$/, '') || '/';

    if (path === '/health' && request.method === 'GET') {
      const { url: dbUrl } = requireDbConfig();
      await db('reports', 'GET', { select: 'id', limit: '1' });
      return json({ ok: true, databaseConfigured: !!dbUrl, emailConfigured: !!env('RESEND_API_KEY') && !!env('RESEND_FROM_EMAIL') });
    }
    if (path === '/admin/login' && request.method === 'POST') {
      const configuredPassword = env('ADMIN_PASSWORD');
      if (!configuredPassword) return json({ error: 'ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน Netlify' }, 503);
      const input = await request.json();
      if (!safeEqualText(input.password || '', configuredPassword)) return json({ error: 'รหัสผ่านไม่ถูกต้อง' }, 401);
      return json({ token: makeToken(), expiresIn: 43200 });
    }
    if (path.startsWith('/admin/')) await requireAdmin(request);

    if (path === '/public/bootstrap' && request.method === 'GET') return await publicBootstrap();
    const publicReportMatch = path.match(/^\/public\/reports\/([^/]+)$/);
    if (publicReportMatch && request.method === 'GET') return await publicReportDetail(decodeURIComponent(publicReportMatch[1]));
    if (path === '/public/reports' && request.method === 'POST') return await createReport(request);
    if (path === '/admin/reports' && request.method === 'GET') return await adminReports();
    if (path === '/admin/employees' && request.method === 'GET') return await listEmployees();
    if (path === '/admin/employees' && request.method === 'POST') {
      const input = await request.json();
      const row = employeeRow(input);
      await db('employees', 'POST', { on_conflict: 'employee_id' }, row, 'resolution=merge-duplicates,return=minimal');
      return json({ ok: true });
    }
    if (path === '/admin/employees/import' && request.method === 'POST') {
      const input = await request.json();
      return await upsertEmployees(input.employees);
    }
    const employeeMatch = path.match(/^\/admin\/employees\/([^/]+)$/);
    if (employeeMatch && request.method === 'DELETE') {
      await db('employees', 'DELETE', { employee_id: `eq.${decodeURIComponent(employeeMatch[1])}` }, undefined, 'return=minimal');
      return json({ ok: true });
    }
    const reportMatch = path.match(/^\/admin\/reports\/([^/]+)$/);
    if (reportMatch && request.method === 'PATCH') return await updateReport(decodeURIComponent(reportMatch[1]), request);
    if (reportMatch && request.method === 'DELETE') {
      await db('reports', 'DELETE', { id: `eq.${decodeURIComponent(reportMatch[1])}` }, undefined, 'return=minimal');
      return json({ ok: true });
    }
    if (path === '/admin/mail' && request.method === 'GET') return await mailLogs();
    return json({ error: 'ไม่พบ API endpoint นี้' }, 404);
  } catch (error) {
    console.error('Safety API error:', error.message);
    return json({ error: error.message || 'Internal server error' }, error.status || 500);
  }
};
