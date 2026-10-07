# เปิดตัวอย่าง Order Hub ผ่าน GitHub

[เปิดหรือกลับเข้าใช้ตัวอย่าง](https://codespaces.new/CosMD-BBB/Warehouse_Management/tree/main?quickstart=1)

1. เข้าสู่บัญชี GitHub ที่เข้าถึง repository นี้ได้
2. กด **Create codespace** แล้วรอการเตรียมระบบ ครั้งต่อไปเลือก **Resume codespace** เพื่อใช้บัญชีและข้อมูลทดลองเดิม
3. ระบบเริ่มเว็บอัตโนมัติ หากไม่เปิดแท็บเว็บ ให้ไปที่แท็บ **Ports** แถว **4180 / Order Hub** แล้วกดไอคอน **Open in Browser** ตรวจว่าพอร์ตเป็น **Private** ก่อนสร้าง Admin
4. สร้างชื่อร้าน รหัสร้าน และบัญชี Admin ด้วยข้อมูลของคุณเอง ไม่มีชื่อผู้ใช้หรือรหัสผ่านเริ่มต้น จากนั้นลองออเดอร์ สต๊อก งานแพ็ก รายงาน และร้านค้าได้

ลิงก์ด้านบนเป็นหน้าสร้างหรือเปิด Codespace ยังไม่ใช่ URL ของเว็บไซต์ที่ deploy แล้ว URL เว็บจริงจะเกิดหลัง GitHub สร้าง Codespace และ forward พอร์ตให้สำเร็จ ต้องตรวจการเปิดหน้าเว็บและ Login บน Codespace จริงก่อนยืนยันว่าใช้งานผ่าน GitHub ได้แล้ว การตั้งค่านี้ไม่เผยแพร่ Site ใหม่ และไม่แก้ไข Site ID เดิม

## ข้อมูลและการทำงาน

ใช้ Node 24 และ `server/index.mjs` จริง ไม่ต้องติดตั้ง npm dependencies และไม่ใช้ static server แทนระบบ Login ฐานข้อมูลทดลองแยกเป็น `.local/codespaces-demo.sqlite` ไม่มีข้อมูลลูกค้าจริงหรือฐานข้อมูลใน Mac ของผู้ใช้ ข้อมูลและบัญชีอยู่ในพื้นที่ทำงาน Codespace เดิม เมื่อหยุดแล้วเปิดใหม่จะใช้ฐานข้อมูลเดิม การสร้าง Codespace ใหม่เริ่มฐานข้อมูลและบัญชีใหม่ และการลบ Codespace ลบข้อมูลทดลองในนั้นด้วย

พอร์ตคงการมองเห็นแบบ **Private** ซึ่งเป็นค่าเริ่มต้นของ GitHub ให้เจ้าของ Codespace สร้าง Admin ก่อน ไม่มีขั้นตอนเปิดพอร์ตสาธารณะหรือปิด authentication ผู้ใช้เลือกบัญชี Admin เอง และสิทธิ์ admin / warehouse / finance, tenant isolation, CSRF และ cookie HttpOnly/Secure ยังคงบังคับจาก backend

ตัวเริ่มระบบคำนวณ HTTPS origin จากชื่อ Codespace และโดเมน forwarding ที่ GitHub ให้ แล้วกำหนด Host/Origin ที่ยอมรับแบบตรงค่าเดียว ไม่เชื่อถือ `X-Forwarded-Host` ถ้ามีค่าการตั้งระบบที่ขัดกัน ตัวเริ่มระบบจะหยุดและแจ้งข้อผิดพลาดแทนการเขียนทับ ไม่เปลี่ยนฐานข้อมูลหรือหยุดโปรเซสที่ไม่เกี่ยวข้อง

## เมื่อเว็บยังไม่เปิด

- ถ้าเข้าถึง repository ไม่ได้ ให้เข้าสู่บัญชี GitHub ที่มีสิทธิ์ repository นี้
- ถ้าเห็นหน้า editor ให้เปิด **Ports → 4180 → Open in Browser** หากพอร์ตยังไม่ปรากฏ ให้ตรวจ **Creation log** และ `.local/codespaces-demo.log` สำหรับข้อความเริ่มระบบ ห้ามแชร์รหัสผ่านหรือ token
- ถ้า Codespace เดิมไม่มีการตั้งค่าใหม่นี้ ให้สร้างใหม่จาก `main` หรือเก็บงานที่ยังไม่ commit ก่อนอัปเดตและ rebuild dev container
- ถ้าเจอ **Host not allowed** ต้องตรวจ Host ที่ GitHub ส่งถึง backend และ URL forwarding จริงก่อนแก้ไข ห้ามปิด Host/Origin validation เพื่อให้ผ่าน
- ถ้า GitHub ไม่อนุญาตให้สร้างหรือเปิด Codespace ให้ตรวจสิทธิ์และโควต้าของบัญชี ข้อจำกัดนี้ไม่ได้เกิดจากหน้า Order Hub

Codespaces เป็นพื้นที่ทดลองที่หยุดเมื่อไม่ได้ใช้ และใช้โควต้าประมวลผลกับพื้นที่เก็บข้อมูลของบัญชี GitHub อาจมีค่าใช้จ่ายเมื่อเปิดการใช้งานเกินโควต้า ดู [ราคาและโควต้าทางการ](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces) ไม่เหมาะกับเว็บที่ต้องเปิดให้คนทั่วไปตลอดเวลา การเผยแพร่ถาวรต้องใช้ Node hosting และดิสก์ถาวรตาม [HOSTING.md](HOSTING.md)

คู่มือทางการ: [ลิงก์สร้างและกลับเข้า Codespace](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/setting-up-your-repository/facilitating-quick-creation-and-resumption-of-codespaces), [การเปิดพอร์ต](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)
