# Safety Observation System — Netlify deployment package

แพ็กเกจนี้ยกระดับหน้าเว็บไซต์ V7 ให้ใช้ฐานข้อมูลกลาง Supabase และ Netlify Functions แทน `localStorage` เพื่อให้พนักงานหลายเครื่องเห็นรายงานชุดเดียวกัน พร้อมระบบ Admin Login ฝั่ง Server และส่งอีเมลผ่าน Resend

## ของที่ต้องมี

1. บัญชี Netlify สำหรับ Hosting/Functions
2. บัญชี Supabase สำหรับ PostgreSQL Database
3. บัญชี Resend และโดเมน/อีเมลผู้ส่งที่ผ่านการยืนยัน (ใช้เฉพาะเมื่อต้องการส่งอีเมลจริง)
4. GitHub หรือ GitLab เพื่อเชื่อมโปรเจกต์กับ Netlify (แนะนำวิธีนี้สำหรับ Functions)

> **สำคัญ:** อย่าใช้ Netlify Drop กับไฟล์ HTML เดี่ยว หากต้องการให้ API Functions ทำงาน ต้อง Deploy โปรเจกต์ทั้งชุดผ่าน Git หรือ Netlify CLI และต้องมี Environment Variables ครบก่อนใช้งานจริง

## ขั้นตอนที่ 1 — สร้างฐานข้อมูล Supabase

1. เข้า https://supabase.com/ แล้วสร้าง Project ใหม่
2. เปิดเมนู SQL Editor
3. เปิดไฟล์ `schema.sql` ในแพ็กเกจนี้ คัดลอกทั้งหมดไปวางใน SQL Editor แล้วกด Run
4. ไปที่ Project Settings / API Keys (หรือ Connect) แล้วคัดลอก
   - Project URL
   - Secret API key ที่ขึ้นต้นด้วย `sb_secret_`
5. **ห้ามนำ Secret key ไปใส่ใน HTML หรือส่งให้ผู้ใช้งานทั่วไป** ต้องใส่ใน Netlify Environment Variables เท่านั้น

## ขั้นตอนที่ 2 — เตรียมค่า Environment Variables

สร้างค่าต่อไปนี้ (ตั้งรหัสผ่านที่คาดเดายาก ไม่ใช้ตัวอย่างในไฟล์):

| Variable | ค่า |
|---|---|
| `SUPABASE_URL` | Project URL จาก Supabase เช่น `https://xxxxx.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret API key ของ Supabase (`sb_secret_...`) |
| `ADMIN_PASSWORD` | รหัสผ่าน Admin ที่คุณกำหนดเอง |
| `ADMIN_SESSION_SECRET` | สุ่มข้อความลับยาวอย่างน้อย 32 ตัวอักษร (แนะนำ 48–64 ตัวอักษร) |
| `RESEND_API_KEY` | API Key จาก Resend (`re_...`) |
| `RESEND_FROM_EMAIL` | ผู้ส่งที่ Verify แล้ว เช่น `Safety System <safety@yourdomain.com>` |

ถ้ายังไม่เปิดใช้ Email สามารถเว้น `RESEND_API_KEY` และ `RESEND_FROM_EMAIL` ไว้ก่อนได้ ระบบยังรับรายงานและบันทึกข้อมูลได้ แต่จะไม่ส่งอีเมล

ตัวอย่างสร้าง `ADMIN_SESSION_SECRET` แบบสุ่มบนเครื่องที่ติดตั้ง Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## ขั้นตอนที่ 3 — Deploy ไป Netlify

1. แตกไฟล์ ZIP นี้ลงในโฟลเดอร์
2. สร้าง Repository ใหม่ใน GitHub แล้ว Upload ไฟล์/โฟลเดอร์ทั้งหมดในแพ็กเกจนี้เข้า Repository (ต้องมี `netlify.toml`, `public/index.html`, `netlify/functions/api.mjs` และ `schema.sql` ตามโครงสร้างนี้)
3. เข้า https://app.netlify.com/start แล้วเลือก Import from Git
4. เลือก Repository ที่อัปโหลดไว้
5. ตรวจสอบ Build settings:
   - Base directory: เว้นว่าง
   - Build command: เว้นว่าง (ไม่มีขั้นตอน Build)
   - Publish directory: `public`
   - Functions directory: `netlify/functions` (อ่านจาก `netlify.toml`)
6. ก่อน Publish หรือหลังสร้าง Site ให้เข้า Project configuration / Environment variables แล้วเพิ่มตัวแปรทั้งหมดจากตารางในขั้นตอนที่ 2 โดยกำหนด Scope ให้ใช้กับ **Functions** ด้วย
7. สั่ง Deploy ใหม่อีกครั้งหลังเพิ่ม/แก้ Environment Variables

Netlify URL ที่ได้จะเปิดหน้า Public ให้พนักงานเข้าใช้งานได้ ส่วน API จะทำงานผ่าน Netlify Functions ที่ `/api/...`

## ขั้นตอนที่ 4 — เริ่มใช้งาน

1. เข้า URL ของเว็บไซต์ที่ Netlify สร้างให้
2. เปิดเมนู Admin แล้ว Login ด้วยค่า `ADMIN_PASSWORD`
3. เข้า Admin > ทะเบียนพนักงาน เพื่อเพิ่มพนักงานทีละคน หรือ Import CSV
4. รูปแบบ CSV ต้องมี Header ตามนี้:

```csv
employeeId,name,department,email
100001,สมชาย ใจดี,PPDT,somchai@example.com
100002,สมหญิง รักงาน,PPM,somying@example.com
```

5. ทดลองส่งรายงานด้วยรหัสพนักงานที่มีในทะเบียน
6. ทดลองอัปเดต Progress / ผู้รับผิดชอบ / Rank A-B-C ในหน้า Admin แล้วตรวจ Email Log

## การส่งอีเมล

- เมื่อมีรายงานใหม่ ระบบค้นหา E-mail จากรหัสพนักงานในทะเบียนกลาง แล้วส่งข้อความยืนยันให้ผู้รายงาน
- เมื่อ Admin เปลี่ยนสถานะ ผู้รับผิดชอบ Rank หรือรายละเอียดความคืบหน้า ระบบจะส่งอีเมลแจ้งผู้รายงานอีกครั้ง
- ถ้าไม่มี E-mail ในทะเบียน หรือยังไม่ได้ตั้งค่า Resend ระบบบันทึกสถานะไว้ใน Email Log แต่ไม่สามารถส่งได้
- ต้อง Verify Domain/Sender ใน Resend ก่อนส่งไปยัง E-mail ผู้รับจริง

## หมายเหตุด้านความปลอดภัยและการใช้งาน

- หน้า Public แสดงข้อมูลรายงานเพื่อให้ค้นหาและติดตามได้ แต่ไม่ส่ง E-mail ของพนักงานกลับไปยัง Browser
- การเปิดระบบ Public หมายความว่าผู้เข้าชมสามารถเห็นรายละเอียดรายงานและรูปภาพได้ตาม Requirement ควรหลีกเลี่ยงการใส่ข้อมูลส่วนบุคคลที่ไม่จำเป็นในรายละเอียด/รูปภาพ
- Admin ใช้ Session Token อายุ 12 ชั่วโมง เก็บใน `sessionStorage`; รหัสผ่านและ Secret อยู่ฝั่ง Server เท่านั้น
- ฐานข้อมูลเปิด RLS และปิดสิทธิ์ `anon`/`authenticated`; Backend ใช้ Supabase Secret key ฝั่ง Server
- รูปภาพรับได้สูงสุด 5 ภาพต่อรายงาน; จำกัด 1.5 MB ต่อรูป และ 5 MB รวม
- ชุดนี้ออกแบบเป็นระบบขนาดเล็ก/การทดลองใช้งานภายใน หากมีผู้ใช้จำนวนมากหรือจำเป็นต้องมีการ Audit/ความพร้อมใช้งานระดับองค์กร แนะนำเพิ่มระบบ SSO, Rate limiting/CAPTCHA, Storage สำหรับรูปภาพ, Backup/Retention, และใช้การอัปเดตแบบ Database transaction/RPC
- Rank A/B/C ยังให้ Admin เป็นผู้ประเมินเอง ตามเอกสารความรุนแรงที่แนบมา; PDF ไม่ได้ให้สูตรคำนวณ Matrix เป็นคะแนนตัวเลข
- คะแนนพนักงานยังคง 1 คะแนนต่อรายงาน เป็น Participation Score ตาม V7 ไม่ใช่การจัดอันดับความปลอดภัย

## ทดสอบ API หลัง Deploy

เปิด URL ต่อไปนี้ โดยแทนที่ `<your-site>` ด้วยโดเมน Netlify:

- `https://<your-site>/api/health` — ควรได้ JSON ที่ `ok: true`
- `https://<your-site>/api/public/bootstrap` — ควรได้ `reports` และ `employees` (ข้อมูลรายชื่อที่ไม่รวม E-mail)

หาก `/api/health` แสดง error ให้ตรวจ Environment Variables และดู Function logs ใน Netlify ก่อนเริ่มใช้งานจริง
