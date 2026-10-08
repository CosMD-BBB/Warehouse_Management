# เปิดตัวอย่าง Order Hub บน Vercel

โค้ดนี้เพิ่ม Vercel Node 24 Function สำหรับระบบเดิม ใช้หน้าจอ Login ออเดอร์ สต๊อก รายงาน และร้านค้าเดิมทั้งหมด ต้องมี PostgreSQL สำหรับบันทึกข้อมูลทดลองถาวร ไม่ใช้ฐานข้อมูลหรือบัญชีจาก Mac ของผู้ใช้

## สำหรับเจ้าของโปรเจกต์ Vercel เดิม

1. เปิด **โปรเจกต์ Order Hub เดิม** ใน Vercel และตรวจว่าเชื่อม repository `CosMD-BBB/Warehouse_Management` ห้ามสร้างโปรเจกต์ทดแทนเพื่อแก้การเข้าถึง Site เดิม
2. ไปที่ **Storage / Marketplace** แล้วเพิ่ม **Neon (Postgres)** หรือเชื่อม PostgreSQL ที่มีอยู่ ให้เชื่อมกับ environment **Preview** สำหรับตัวอย่างนี้ เลือกแผนตามหน้าราคาของผู้ให้บริการ
3. ให้ integration เพิ่ม `DATABASE_URL` หรือ `POSTGRES_URL` ให้โปรเจกต์โดยอัตโนมัติ ถ้าไม่มีตัวแปรนี้ ให้เพิ่ม `ORDER_HUB_DEMO_DATABASE_URL` ใน Vercel เป็น secret สำหรับ Preview คัดลอก connection string ภายในหน้าผู้ให้บริการเท่านั้น ไม่ส่งลงแชตหรือ commit ลง repository
4. ใช้ deployment จากสาขา **`vercel-demo`** ของ repository เดิม ตั้ง **Framework Preset: Other**, **Node.js: 24.x**, **Root Directory: โฟลเดอร์รากของ repository** และให้ใช้ `vercel.json` ที่มากับโค้ด ยกเลิก override ที่ยังบังคับ output เป็น `dist` หรือรัน static server Build Command คือ `node scripts/build-vercel.mjs` และ Output Directory คือ `.vercel-static`
5. **Redeploy** Preview หลังเชื่อมฐานข้อมูลแล้ว เปิดลิงก์จาก **Visit** ของ deployment นั้น คง **Deployment Protection / Vercel Authentication** ไว้ระหว่างสร้าง Admin
6. หน้าแรกให้คุณตั้งชื่อร้าน รหัสร้าน ชื่อผู้ใช้ และรหัสผ่านของตัวเอง ไม่มีบัญชีหรือรหัสผ่านเริ่มต้น จากนั้นลองสร้างออเดอร์หลายสินค้า ที่อยู่ สต๊อก งานแพ็ก รายงาน และร้านค้าได้

การ push source และการตรวจ build ใน Cloud ไม่ได้ยืนยันว่า Vercel deploy สำเร็จ ต้องตรวจ deployment ในโปรเจกต์จริง หาก build ล้มเหลว ให้ดู Build Logs ของ deployment นั้น หาก API ไม่พร้อม ให้ตรวจ environment และ Function Logs โดยไม่เปิดเผย connection string หรือรหัสผ่าน

หาก deployment เก่าแจ้ง `The Output Directory ".vercel-static" is empty` ให้สร้าง deployment ใหม่จาก branch `vercel-demo` เวอร์ชันล่าสุด แทนการ Redeploy commit เก่า สคริปต์ build รุ่นแก้ไขสร้างไฟล์ข้อความสำหรับให้ output ไม่ว่าง ทุกหน้าและ API ยังคงผ่าน Node Function และ Login จริง

## ค่าที่ระบบใช้

| ตัวแปร | การใช้งาน |
| --- | --- |
| `DATABASE_URL` หรือ `POSTGRES_URL` | PostgreSQL ที่ integration เพิ่มให้ ต้องรองรับ TLS ที่ตรวจใบรับรอง |
| `ORDER_HUB_DEMO_DATABASE_URL` | ใช้แทน URL อัตโนมัติได้ ตั้งใน Vercel เป็น secret |
| `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | โดเมนที่ Vercel ให้กับ deployment ใช้ตรวจ Host/Origin แบบตรงค่า ระบบไม่ยอมรับโดเมนจาก forwarded headers |
| `VERCEL_ENV` | แยกฐานข้อมูลทดลอง Preview / Production / Development อัตโนมัติ |
| `ORDER_HUB_DEMO_NAMESPACE` | ตัวเลือกสำหรับกำหนดพื้นที่ข้อมูลทดลองเอง หากใช้ PostgreSQL เดียวร่วมหลายโปรเจกต์ ต้องไม่ใช้ค่าเดียวกันโดยไม่ได้ตั้งใจ |
| `ORDER_HUB_PUBLIC_ORIGIN` | ตั้งเฉพาะกรณีใช้โดเมนกำหนดเอง ค่าเป็น HTTPS origin เช่น `https://ชื่อเว็บของคุณ` เมื่อตั้งแล้ว ระบบยอมรับเฉพาะโดเมนนี้ |

เปิด **Automatically expose System Environment Variables** ใน Vercel ถ้าโปรเจกต์ปิดไว้ ระบบต้องได้รับโดเมน Vercel ที่ถูกต้อง ค่ากำหนดเองที่ไม่ตรงโดเมนจริงจะถูกปฏิเสธ ไม่แก้โดยปิด Host/Origin validation

Preview และ Production ใช้พื้นที่ข้อมูลต่างกันเป็นค่าเริ่มต้น Preview รุ่นใหม่ของโปรเจกต์และ environment เดิมใช้ข้อมูลเดิม หากเปลี่ยนชื่อโดเมนประจำโปรเจกต์ ให้คง `ORDER_HUB_DEMO_NAMESPACE` ของตัวอย่างเดิมไว้ก่อนเปลี่ยน เพื่อไม่ให้ระบบเลือกพื้นที่ข้อมูลใหม่

## ขอบเขตตัวอย่าง

PostgreSQL เก็บ snapshot ของ SQLite ที่สร้างจากข้อมูลสาธิตของระบบ แต่ละคำขอ API ล็อกข้อมูลนี้ โหลดเข้าไฟล์ชั่วคราวเฉพาะคำขอ แล้วให้ backend เดิมตรวจ Login / CSRF / role / tenant และปรับสต๊อกตามธุรกรรมเดิม เมื่อบันทึก snapshot ใหม่และ PostgreSQL COMMIT สำเร็จ จึงตอบผลและส่ง session cookie ให้ browser Login throttling ถูกบันทึกด้วยและไม่รีเซ็ตเมื่อ Vercel เริ่มตัวรันใหม่

ภาพและฟอนต์ไม่ต้องใช้ฐานข้อมูล ทุกเส้นทางผ่าน Function และรายการไฟล์ที่อนุญาต Public output มีเพียงไฟล์ข้อความที่สร้างตอน build เพื่อให้ Vercel ยอมรับ output ที่ไม่ว่าง ไม่มีหน้าแอป seed หรือฐานข้อมูลอยู่ในนั้น หากฐานข้อมูลไม่พร้อม API ตอบ 503 และไม่สร้างฐานข้อมูลชั่วคราวมาแทนเพื่อแสดงว่าบันทึกสำเร็จ การตอบผลสูญหายหลัง COMMIT อาจให้ 503 แม้ข้อมูลบันทึกแล้ว ใช้ request ID เดิมสำหรับ retry งานที่รองรับ idempotency

วิธี snapshot นี้เหมาะกับตัวอย่างที่มีผู้ใช้จำนวนน้อย API แต่ละคำขอใช้ lock ร่วมกันและ snapshot จำกัด 10 MiB การใช้งานจริงจำนวนมากควรย้ายข้อมูลเป็นตารางถาวรและ transaction โดยตรง ค่าเชื่อม Platform / OAuth / ขนส่ง / ธนาคารยังเป็นส่วนที่ไม่เชื่อมจริงตามป้ายเดิม และยังไม่ได้ย้ายฐานข้อมูลจริงในเครื่องผู้ใช้

Site ID เดิม `appgprj_6ac5d357e9988191916bd6f86d096ad3` คงไว้ การเตรียม Vercel preview นี้ไม่สร้าง Site ใหม่ทดแทนใน Sites
