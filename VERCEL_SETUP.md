# เปิดตัวอย่าง Order Hub บน Vercel

โค้ดนี้เพิ่ม Vercel Node 24 Function สำหรับระบบเดิม Preview ของสาขา `vercel-demo` เปิดให้เข้าลอง Dashboard ออเดอร์ สต๊อก และรายงานได้ทันที โดยแต่ละผู้เข้าชมมีข้อมูลตัวอย่างของตัวเอง ระบบยังใช้ PostgreSQL และ session ฝั่งเซิร์ฟเวอร์ Local และ Production ใช้ Login ตามเดิม ไม่ใช้ฐานข้อมูลหรือบัญชีจาก Mac ของผู้ใช้

## สำหรับเจ้าของโปรเจกต์ Vercel เดิม

1. เปิด **โปรเจกต์ Order Hub เดิม** ใน Vercel และตรวจว่าเชื่อม repository `CosMD-BBB/Warehouse_Management` ห้ามสร้างโปรเจกต์ทดแทนเพื่อแก้การเข้าถึง Site เดิม
2. ไปที่ **Storage / Marketplace** แล้วเพิ่ม **Neon (Postgres)** หรือเชื่อม PostgreSQL ที่มีอยู่ ให้เชื่อมกับ environment **Preview** สำหรับตัวอย่างนี้ เลือกแผนตามหน้าราคาของผู้ให้บริการ
3. ให้ integration เพิ่ม `DATABASE_URL` หรือ `POSTGRES_URL` ให้โปรเจกต์โดยอัตโนมัติ ถ้าไม่มีตัวแปรนี้ ให้เพิ่ม `ORDER_HUB_DEMO_DATABASE_URL` ใน Vercel เป็น secret สำหรับ Preview คัดลอก connection string ภายในหน้าผู้ให้บริการเท่านั้น ไม่ส่งลงแชตหรือ commit ลง repository
4. ใช้ deployment จากสาขา **`vercel-demo`** ของ repository เดิม ตั้ง **Framework Preset: Other**, **Node.js: 24.x**, **Root Directory: โฟลเดอร์รากของ repository** และให้ใช้ `vercel.json` ที่มากับโค้ด ยกเลิก override ที่ยังบังคับ output เป็น `dist` หรือรัน static server Build Command คือ `node scripts/build-vercel.mjs` และ Output Directory คือ `.vercel-static`
5. สร้าง Preview จาก commit ล่าสุดของ `vercel-demo` หลังเชื่อมฐานข้อมูล แล้วเปิดลิงก์จาก **Visit** เพื่อให้ทุกคนเปิดได้ตามคำขอ ไปที่ **Settings ของโปรเจกต์ → Deployment Protection → Vercel Authentication** ปิดแล้ว **Save** การตั้งค่านี้อยู่ในบัญชี Vercel และไม่ได้เปลี่ยนจากการ push source หรือแชตนี้
6. หน้าแรกของ Preview สาขานี้เข้าสู่ Dashboard ด้วยพื้นที่ทดลองส่วนตัวอัตโนมัติ ไม่มีฟอร์ม Login หรือบัญชีเริ่มต้นให้กรอก ลองสร้างออเดอร์หลายสินค้า ที่อยู่ สต๊อก งานแพ็ก และรายงานได้ ปุ่ม **เริ่มใหม่** คืนข้อมูลตัวอย่างเฉพาะพื้นที่ของคุณ หน้าบัญชีเป็นตัวอย่างสิทธิ์และไม่รับรหัสผ่านในโหมดนี้

การ push source และการตรวจ build ใน Cloud ไม่ได้ยืนยันว่า Vercel deploy สำเร็จ ต้องตรวจ deployment ในโปรเจกต์จริง หาก build ล้มเหลว ให้ดู Build Logs ของ deployment นั้น หาก API ไม่พร้อม ให้ตรวจ environment และ Function Logs โดยไม่เปิดเผย connection string หรือรหัสผ่าน

หาก deployment เก่าแจ้ง `The Output Directory ".vercel-static" is empty` ให้สร้าง deployment ใหม่จาก branch `vercel-demo` เวอร์ชันล่าสุด แทนการ Redeploy commit เก่า สคริปต์ build รุ่นแก้ไขสร้างไฟล์ข้อความสำหรับให้ output ไม่ว่าง ทุกหน้าและ API ยังคงผ่าน Node Function ที่ตรวจ session ฝั่งเซิร์ฟเวอร์

## พื้นที่ทดลองสาธารณะ

โหมดนี้เปิดเฉพาะเมื่อ Vercel ให้ค่า `VERCEL_ENV=preview` และ `VERCEL_GIT_COMMIT_REF=vercel-demo` จึงต้องเปิด System Environment Variables ตามด้านล่าง ข้อมูลทดลองสาธารณะอยู่ในตาราง PostgreSQL แยกจากข้อมูล Login เดิม แต่ละ browser มี cookie สำหรับพื้นที่ของตัวเองและได้รับ guest session โดยอัตโนมัติ ไม่มีรหัสผ่านผู้ทดลองอยู่ในหน้าเว็บหรือ source

พื้นที่หมดอายุหลังไม่ได้ใช้ 24 ชั่วโมง รองรับพื้นที่ที่ยังใช้งานสูงสุด 100 แห่งต่อโปรเจกต์ และแต่ละพื้นที่มีขนาด snapshot สูงสุด 2 MiB ถ้าถึงขีดจำกัด ระบบแจ้งให้ลองใหม่โดยไม่เปิดข้อมูลพื้นที่อื่น การเริ่มใหม่ล้างเฉพาะข้อมูลของผู้กดและยกเลิก session เดิม การเพิ่มบัญชี เปลี่ยนรหัสผ่าน และสร้างร้านใหม่ปิดในโหมดนี้ ชื่อร้าน สินค้า ออเดอร์ และงานคลังทดลองได้ด้วยข้อมูลสมมติ

Production และ Local ไม่เปิด guest อัตโนมัติ ต้องตั้ง Admin หรือใช้บัญชีร้านตาม Login เดิม การเปิดสาธารณะของ Preview ไม่ได้เปลี่ยนฐานข้อมูลจริงหรือย้ายข้อมูลจาก Mac

## สมัครใช้บริการและลืมรหัสผ่าน

หน้าเดโมมีปุ่ม **สมัครใช้บริการ** และ **เข้าสู่ระบบ** ที่เปิด `/account` ส่วนนี้ใช้บัญชีจริงแยกจาก guest สร้างร้านใหม่ได้หลังยืนยันอีเมลด้วย OTP และมี **ลืมรหัสผ่าน** สำหรับบัญชีที่ผูกอีเมลแล้ว ต้องตั้งค่า Resend และโดเมนผู้ส่งตาม [EMAIL_SETUP.md](EMAIL_SETUP.md) ก่อนใช้อีเมลจริง

ให้เปิดปุ่ม Visit ของ deployment เวอร์ชันล่าสุด ลิงก์ deployment เก่าที่มีรหัสสุ่มผูกกับ source เก่า จึงอาจยังไม่มี Register หรือการกู้รหัสที่เพิ่มใหม่ บัญชีเดิมไม่ถูกลบ; ก่อนอัปเกรด schema ระบบเก็บสำรองใน PostgreSQL และใช้ namespace เดิม

## ค่าที่ระบบใช้

| ตัวแปร | การใช้งาน |
| --- | --- |
| `DATABASE_URL` หรือ `POSTGRES_URL` | PostgreSQL ที่ integration เพิ่มให้ ต้องรองรับ TLS ที่ตรวจใบรับรอง |
| `ORDER_HUB_DEMO_DATABASE_URL` | ใช้แทน URL อัตโนมัติได้ ตั้งใน Vercel เป็น secret |
| `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | โดเมนที่ Vercel ให้กับ deployment ใช้ตรวจ Host/Origin แบบตรงค่า ระบบไม่ยอมรับโดเมนจาก forwarded headers |
| `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF` | แยก Preview / Production / Development และเปิด public demo เฉพาะ Preview ของสาขา `vercel-demo` |
| `ORDER_HUB_DEMO_NAMESPACE` | ตัวเลือกสำหรับกำหนดพื้นที่ข้อมูลทดลองเอง หากใช้ PostgreSQL เดียวร่วมหลายโปรเจกต์ ต้องไม่ใช้ค่าเดียวกันโดยไม่ได้ตั้งใจ |
| `ORDER_HUB_PUBLIC_ORIGIN` | ตั้งเฉพาะกรณีใช้โดเมนกำหนดเอง ค่าเป็น HTTPS origin เช่น `https://ชื่อเว็บของคุณ` เมื่อตั้งแล้ว ระบบยอมรับเฉพาะโดเมนนี้ |

เปิด **Automatically expose System Environment Variables** ใน Vercel ถ้าโปรเจกต์ปิดไว้ ระบบต้องได้รับโดเมน Vercel ที่ถูกต้อง ค่ากำหนดเองที่ไม่ตรงโดเมนจริงจะถูกปฏิเสธ ไม่แก้โดยปิด Host/Origin validation

Preview และ Production ใช้พื้นที่ข้อมูลต่างกันเป็นค่าเริ่มต้น Preview รุ่นใหม่ของโปรเจกต์และ environment เดิมใช้ข้อมูลเดิม หากเปลี่ยนชื่อโดเมนประจำโปรเจกต์ ให้คง `ORDER_HUB_DEMO_NAMESPACE` ของตัวอย่างเดิมไว้ก่อนเปลี่ยน เพื่อไม่ให้ระบบเลือกพื้นที่ข้อมูลใหม่

## ขอบเขตตัวอย่าง

PostgreSQL เก็บ snapshot ของ SQLite ที่สร้างจากข้อมูลสาธิตของระบบ แต่ละคำขอ API ล็อกข้อมูลนี้ โหลดเข้าไฟล์ชั่วคราวเฉพาะคำขอ แล้วให้ backend เดิมตรวจ Login / CSRF / role / tenant และปรับสต๊อกตามธุรกรรมเดิม เมื่อบันทึก snapshot ใหม่และ PostgreSQL COMMIT สำเร็จ จึงตอบผลและส่ง session cookie ให้ browser Login throttling ถูกบันทึกด้วยและไม่รีเซ็ตเมื่อ Vercel เริ่มตัวรันใหม่

ภาพและฟอนต์ไม่ต้องใช้ฐานข้อมูล ทุกเส้นทางผ่าน Function และรายการไฟล์ที่อนุญาต Public output มีเพียงไฟล์ข้อความที่สร้างตอน build เพื่อให้ Vercel ยอมรับ output ที่ไม่ว่าง ไม่มีหน้าแอป seed หรือฐานข้อมูลอยู่ในนั้น หากฐานข้อมูลไม่พร้อม API ตอบ 503 และไม่สร้างฐานข้อมูลชั่วคราวมาแทนเพื่อแสดงว่าบันทึกสำเร็จ การตอบผลสูญหายหลัง COMMIT อาจให้ 503 แม้ข้อมูลบันทึกแล้ว ใช้ request ID เดิมสำหรับ retry งานที่รองรับ idempotency

วิธี snapshot นี้เหมาะกับตัวอย่างที่มีผู้ใช้จำนวนน้อย API แต่ละคำขอใช้ lock ร่วมกันและ snapshot จำกัด 10 MiB การใช้งานจริงจำนวนมากควรย้ายข้อมูลเป็นตารางถาวรและ transaction โดยตรง ค่าเชื่อม Platform / OAuth / ขนส่ง / ธนาคารยังเป็นส่วนที่ไม่เชื่อมจริงตามป้ายเดิม และยังไม่ได้ย้ายฐานข้อมูลจริงในเครื่องผู้ใช้

Site ID เดิม `appgprj_6ac5d357e9988191916bd6f86d096ad3` คงไว้ การเตรียม Vercel preview นี้ไม่สร้าง Site ใหม่ทดแทนใน Sites
