# เปิด Order Hub จาก GitHub

GitHub repository เก็บซอร์สและรันชุดทดสอบผ่าน GitHub Actions ได้ ส่วนเว็บไซต์ต้องใช้บริการที่รัน **Node.js 24 ขึ้นไปหรือ Docker** และมี **ดิสก์ถาวรสำหรับ SQLite** GitHub Pages รัน backend ของระบบนี้ไม่ได้

## สิ่งที่เตรียมไว้

- `Dockerfile` สำหรับ backend จริง; ไม่มีฐานข้อมูล บัญชี เซสชัน หรือรหัสผ่านตั้งต้นใน image
- GitHub Actions รัน `npm test` บน Node 24; ไม่มีขั้นตอน deploy ไปโฮสต์ที่ยังไม่ได้กำหนด
- Login, สิทธิ์, CSRF และข้อมูลแยกร้านยังบังคับจาก server
- HTTPS hosting ใช้ Host และ Origin ที่ระบุแน่นอน และ cookie แบบ Secure

## ตั้งค่าบนบริการโฮสต์

เชื่อม repository `CosMD-BBB/warehouse` สาขา `main` กับบริการโฮสต์ที่เจ้าของร้านเลือก ใช้ instance เดียวสำหรับ SQLite และติดตั้งดิสก์ถาวรที่ `/data` อย่าติดตั้งบน filesystem ชั่วคราวแล้วอ้างว่าข้อมูลคงอยู่หลัง redeploy

| ตัวแปร | ค่าที่ต้องตั้ง |
| --- | --- |
| `ORDER_HUB_PUBLIC_ORIGIN` | HTTPS origin จริงของเว็บไซต์ เช่น `https://order-hub.example` โดยเปลี่ยนชื่อเป็นโดเมนของคุณ ไม่มี path/query |
| `ORDER_HUB_HOST` | `0.0.0.0` สำหรับ container/hosting; ค่าเริ่มต้นแบบเปิดในเครื่องคือ `127.0.0.1` |
| `PORT` | พอร์ตที่บริการโฮสต์กำหนด; หากใช้ `ORDER_HUB_PORT` ค่านั้นจะมีลำดับสูงกว่า |
| `ORDER_HUB_DB` | `/data/order-hub.sqlite` บนดิสก์ถาวร |

`https://order-hub.example` เป็นค่าตัวอย่างในคู่มือ ไม่ใช่เว็บไซต์ที่เปิดใช้งานแล้ว ไม่มี secret ที่ต้องนำมาใส่ใน repository

ถ้าใช้ Node โดยตรง ไม่ต้องติดตั้ง dependency เพิ่ม ใช้ `npm start` หากใช้ Docker ให้ build จาก `Dockerfile` และส่งตัวแปรข้างต้นตอนเริ่ม container ค่า `ORDER_HUB_PUBLIC_ORIGIN` จำเป็นก่อนรับการเชื่อมต่อแบบ non-loopback; config ผิดจะหยุดเริ่มระบบก่อนสร้างฐานข้อมูล

TLS ต้องสิ้นสุดที่ HTTPS proxy ของผู้ให้บริการ โดย proxy ส่ง Host จริงของเว็บไซต์ให้ backend และจำกัดการเข้าถึงพอร์ต HTTP ภายใน ไม่เปิดพอร์ต backend เปล่าออกสู่อินเทอร์เน็ต ระบบไม่ใช้ `Forwarded` หรือ `X-Forwarded-*` เพื่อให้สิทธิ์ Host/Origin และไม่ถือ Origin ที่ client ส่งมาเป็นหลักฐานว่า socket ใช้ TLS

## สร้างบัญชีร้านและตรวจหลัง deploy

ให้หน้า setup เข้าถึงได้เฉพาะเจ้าของร้านผ่าน access control ของผู้ให้บริการก่อนสร้าง Admin ครั้งแรก เพราะฐานข้อมูลใหม่จะรับผู้สร้างบัญชีคนแรก เจ้าของร้านเลือกชื่อผู้ใช้และรหัสผ่านเอง จากนั้นตรวจ Login/Logout และเปิดให้ทีมเข้าตามสิทธิ์ อย่าทิ้งหน้า setup ของฐานข้อมูลใหม่ไว้บนลิงก์สาธารณะที่ใครก็สร้างเจ้าของร้านได้

ตรวจบน HTTPS URL จริงว่าภาพ/ฟอนต์โหลดครบ, cookie เป็น HttpOnly/Secure, mutation ต่าง Origin ถูกปฏิเสธ, Warehouse ไม่ได้ข้อมูลราคา/ต้นทุน, Finance แก้สต๊อกไม่ได้ และร้านใหม่ไม่เห็นข้อมูลร้านเดิม ตรวจ persistence หลัง restart และตั้งการสำรองด้วย SQLite backup API ฝั่งโฮสต์

เมื่อกำหนด public origin แล้ว health probe ต้องใช้ Host ที่ตรงกับ origin ด้วย เช่น GET `/api/auth/status` ที่ Host ของเว็บไซต์ หาก provider ส่ง Host ภายในที่ต่างออกไป probe จะได้ 403 ตามการป้องกันของระบบ

`npm test` ควรรันในขั้น CI/build ก่อนตั้งค่า public-origin ของแอป; fixture เดิมใช้ loopback และ tests ใหม่ตรวจ origin ที่กำหนดโดยตรง ไม่ใช้ผลทดสอบภายในแทนการตรวจ HTTPS URL จริง

## สถานะการส่งขึ้น GitHub และเว็บไซต์

ดู [GITHUB_DELIVERY.md](GITHUB_DELIVERY.md) สำหรับผล upload และข้อจำกัดปัจจุบัน การ push repository หรือผ่าน CI ไม่ได้ยืนยันว่าเว็บไซต์ deploy สำเร็จ และลิงก์ repository ไม่ใช่ลิงก์ระบบ Order Hub

รักษา Site ID เดิม `appgprj_6ac5d357e9988191916bd6f86d096ad3`; ไม่สร้าง Site ทดแทนเพื่อเลี่ยงปัญหา `project_not_found` และไม่เผยแพร่ `dist` เดี่ยวแทน backend
