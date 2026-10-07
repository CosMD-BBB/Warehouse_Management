'use strict';
const connectGuides={
Shopee:{kind:'marketplace',desc:'รวมออเดอร์และอัปเดตสต๊อก Shopee',steps:['ใช้บัญชีเจ้าของร้านหรือบัญชีที่มีสิทธิ์อนุญาตแอป','เมื่อระบบพร้อม กดเชื่อมต่อแล้วเข้าสู่ระบบบนหน้า Shopee','ตรวจชื่อร้านและสิทธิ์ที่ขอ ก่อนยืนยัน'],tech:[['แอปผู้พัฒนา','ตรวจ Partner App และสิทธิ์ของบัญชีจริงใน Open Platform'],['สิทธิ์ร้านค้า','ยืนยันวิธีอนุญาตและเงื่อนไขของร้านก่อนเปิดเชื่อมต่อ'],['การทดสอบ','ทดสอบอ่านออเดอร์และสต๊อกก่อนอัปเดตจริง']],url:'https://open.shopee.com/'},
Lazada:{kind:'marketplace',desc:'รวมออเดอร์ แพ็ก จัดส่ง และสต๊อก Lazada',steps:['เลือกประเทศไทย (Thailand) ในหน้าการอนุญาต','เลือก Use Seller Login แล้วเข้าสู่บัญชีร้าน','ตรวจบัญชีและกด Authorize เพื่ออนุญาตแอป'],tech:[['App Key / App Secret','จากแอปใน Lazada Open Platform เก็บบนเซิร์ฟเวอร์'],['Callback URL','HTTPS ของระบบจริง ต้องตรงกับที่ตั้งในแอป'],['API Permission','สิทธิ์ออเดอร์ สต๊อก และจัดส่งตามงาน']],url:'https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533'},
'TikTok Shop':{kind:'marketplace',desc:'รวมออเดอร์ TikTok Shop และใช้สต๊อกกลาง',steps:['ใช้บัญชีผู้ขายของร้าน ไม่ใช่ Creator หรือ Affiliate','เมื่อแอปพร้อม เปิดหน้าการอนุญาตของ TikTok Shop','เลือกร้าน ตรวจสิทธิ์ และยืนยัน'],tech:[['App Key / App Secret','จาก Partner Center เก็บข้อมูลลับบนเซิร์ฟเวอร์'],['Market / Seller type','ต้องตรงประเทศและประเภทผู้ขาย'],['Redirect / Webhook','ปลายทาง HTTPS และ app review ตามประเภทแอป']],url:'https://partner.tiktokshop.com/docv2/page/app-review-process'},
'LINE OA':{kind:'messaging',desc:'เชื่อมข้อความ LINE OA แล้วให้ทีมยืนยันเป็นออเดอร์',steps:['ผู้ดูแล OA เปิด Messaging API ใน LINE Official Account Manager','ผู้ดูแลระบบตั้ง Channel access token และ Channel secret บนเซิร์ฟเวอร์','ตั้ง Webhook URL กด Verify เปิด Use webhook แล้วส่งข้อความทดสอบ'],tech:[['Channel access token','LINE Developers → Messaging API'],['Channel secret','ใช้ตรวจเหตุการณ์ที่ส่งมาจาก LINE'],['Webhook URL','HTTPS ของระบบจริง ตรวจระบบแชตเดิมก่อนเปลี่ยน']],url:'https://developers.line.biz/en/docs/messaging-api/building-bot/'},
Facebook:{kind:'messaging',desc:'เชื่อมข้อความเพจ Facebook แล้วเปิดออเดอร์กลาง',steps:['ใช้บัญชี Facebook ที่มีสิทธิ์จัดการเพจ','เมื่อแอปพร้อม เข้าสู่ Facebook แล้วเลือกเพจ','อนุญาตสิทธิ์ที่จำเป็น จากนั้นส่งข้อความทดสอบ'],tech:[['Meta App','ตั้ง Facebook Login และสิทธิ์เพจที่จำเป็น'],['Page access / Token','ให้เจ้าของเพจอนุญาต Token อยู่บนเซิร์ฟเวอร์'],['Webhook / Review','ใช้ HTTPS และผ่าน review ตามสิทธิ์ที่ใช้งาน']],url:'https://developers.facebook.com/docs/messenger-platform/'},
Review:{kind:'manual',desc:'ส่งสินค้าฟรีให้ผู้รีวิวโดยใช้สต๊อกกลาง',steps:['บันทึกชื่อทีมที่ดูแลการส่งรีวิว','Admin เปิดออเดอร์และเลือก Review','เข้าคิวหยิบแพ็ก ไม่เพิ่มยอดขาย และแยกต้นทุนการตลาด'],tech:[]},
'Offline sales':{kind:'manual',desc:'บันทึกยอดหน้าร้านหรืองานขายของทีม',steps:['บันทึกชื่อสาขาหรือทีมขาย','Admin เปิดออเดอร์และเลือก Offline sales','ตรวจการชำระเงินและเข้าคิวหยิบ ใช้สต๊อกกองเดียวกัน'],tech:[]}
};
const apiRequestGuides={
  "Shopee": {
    "mode": "API คำสั่งซื้อและสต๊อก",
    "intro": "ขอสิทธิ์ให้ระบบของร้านอ่านออเดอร์ จัดส่ง และส่งยอดสต๊อกกลางกลับไปยัง Shopee",
    "eligibility": "ตรวจคุณสมบัติก่อนสมัคร: คู่มือผู้ขายไทยระบุ Shopee Mall หรือ Managed Seller สำหรับการสมัครระบบใช้กับร้านตนเอง หากไม่แน่ใจ ให้ตรวจสอบกับผู้ดูแลบัญชี Shopee ก่อน",
    "eligibilityUrl": "https://open.shopee.com/developer-guide/12",
    "steps": [
      {
        "title": "สมัครและยืนยันบัญชีนักพัฒนา",
        "who": "เจ้าของร้าน",
        "body": "เข้า Shopee Open Platform → Log In → Sign up ใช้อีเมลที่บริษัทดูแลได้ แล้วไป Console → App Management → App List เลือก Shopee Seller และประเภท Individual Seller หรือ Registered Business Seller ให้ตรงกับร้าน ส่งข้อมูลให้ Shopee ตรวจสอบ",
        "links": [
          [
            "สมัคร Shopee Open Platform",
            "https://open.shopee.com/"
          ],
          [
            "คุณสมบัติและขั้นตอนสมัคร",
            "https://open.shopee.com/developer-guide/12"
          ]
        ]
      },
      {
        "title": "สร้างแอปสำหรับระบบของร้าน",
        "who": "เจ้าของร้าน + ผู้พัฒนาระบบ",
        "body": "เมื่อบัญชีผ่านอนุมัติ เข้า Console → Create App เลือก Seller In-house System สำหรับใช้กับร้านของตนเอง กรอกชื่อ Order Hub คำอธิบาย และโลโก้ แอปเริ่มต้นจะได้ Test Partner ID และ Test Key สำหรับทดสอบ",
        "links": [
          [
            "วิธีสร้างแอปและขอ Go Live",
            "https://open.shopee.com/developer-guide/14"
          ]
        ]
      },
      {
        "title": "ตั้งค่าแอปและตรวจสิทธิ์ API",
        "who": "ผู้พัฒนาระบบ",
        "body": "ตรวจ API Permission ของแอปให้ครอบคลุมอ่านคำสั่งซื้อ สินค้า สต๊อก และงานจัดส่งที่ต้องใช้ เตรียม URL รับผลการอนุญาตของระบบจริง แล้วตั้ง Test / Live Redirect URL Domain ให้ตรงกัน เก็บ Partner Key ไว้บนเซิร์ฟเวอร์",
        "links": [
          [
            "สิทธิ์ของแอปแต่ละประเภท",
            "https://open.shopee.com/developer-guide/14"
          ],
          [
            "ตั้ง URL รับผลการอนุญาต",
            "https://open.shopee.com/developer-guide/20"
          ]
        ]
      },
      {
        "title": "ทดสอบและขอเปิดใช้งานจริง",
        "who": "ผู้พัฒนาระบบ",
        "body": "ใช้ข้อมูลทดสอบใน Sandbox ทดสอบรับออเดอร์และสต๊อกให้ครบ แล้วเลือก App List → Go Live ส่งข้อมูลตามที่ Shopee ขอ เมื่อผ่านจึงเปลี่ยนไปใช้ Live Partner ID และ Live Key สำหรับร้านจริง",
        "links": [
          [
            "ทดสอบและเปลี่ยนเป็น Live",
            "https://open.shopee.com/developer-guide/14"
          ]
        ]
      },
      {
        "title": "ให้เจ้าของร้านอนุญาตแอป",
        "who": "เจ้าของร้าน",
        "body": "เมื่อ Order Hub มีตัวเชื่อมพร้อมแล้ว กดลิงก์อนุญาตของแอปจริง ล็อกอินบัญชีร้านหรือบัญชีหลักบนหน้า Shopee ยืนยันรหัสที่ Shopee ส่งมา แล้วกด Confirm Authorization และเลือกระยะอนุญาต ระบบจะรับผลกลับมาตรวจชื่อร้านและสิทธิ์",
        "links": [
          [
            "วิธีอนุญาตร้านและบัญชีที่ใช้ได้",
            "https://open.shopee.com/developer-guide/20"
          ]
        ]
      },
      {
        "title": "ตรวจออเดอร์และสต๊อกก่อนเปิดใช้",
        "who": "ผู้พัฒนาระบบ + ทีมคลัง",
        "body": "อ่านออเดอร์จริงหนึ่งรายการ เทียบเลขออเดอร์และสินค้า จับคู่ SKU กับคลังกลาง ตรวจยอดพร้อมขาย และทดสอบเหตุการณ์ซ้ำก่อนเปิดอัปเดตสต๊อกจริง",
        "links": [
          [
            "คู่มือ Shopee Open Platform",
            "https://open.shopee.com/developer-guide/4"
          ]
        ]
      }
    ],
    "fields": [
      [
        "Partner ID / Partner Key",
        "รายละเอียดแอปใน Shopee Open Platform แยก Test และ Live"
      ],
      [
        "Redirect URL Domain",
        "โดเมนของระบบที่รับผลอนุญาตได้จริง ต้องตรงกับแอป"
      ],
      [
        "Shop ID และ token",
        "ระบบรับหลังเจ้าของร้านอนุญาต ไม่ต้องคัดลอกมาใส่ในแบบร่างนี้"
      ]
    ],
    "done": "เชื่อมสำเร็จเมื่อระบบยืนยันร้านและอ่านออเดอร์จริงได้ แล้วจึงเปิดการส่งสต๊อกหลังจับคู่ SKU ครบ"
  },
  "Lazada": {
    "mode": "API คำสั่งซื้อและสต๊อก",
    "intro": "สมัครแอปสำหรับร้านของคุณ ตรวจกลุ่มสิทธิ์ API แล้วให้บัญชีผู้ขายอนุญาตร้าน",
    "eligibility": "เส้นทางและการอนุญาตขึ้นกับประเภทผู้พัฒนาและแอป หากแอปใช้ Seller Whitelist ต้องเพิ่มร้านให้ถูกประเทศก่อนอนุญาต",
    "eligibilityUrl": "https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533",
    "steps": [
      {
        "title": "สมัครและส่งข้อมูลผู้พัฒนา",
        "who": "เจ้าของร้าน",
        "body": "เข้า Lazada Open Platform → Create Account ยืนยันอีเมล จากนั้นเปิด User ID → Profile กรอกข้อมูลและเอกสารตามที่ Lazada ขอ ระบุว่าพัฒนาระบบสำหรับจัดการคำสั่งซื้อและสต๊อกของร้านตนเอง",
        "links": [
          [
            "เปิด Lazada Open Platform",
            "https://open.lazada.com/"
          ],
          [
            "สมัครและขอประเภทแอป",
            "https://open.lazada.com/apps/doc/doc?docId=108149&nodeId=10552"
          ]
        ]
      },
      {
        "title": "สร้างแอปและขอกลุ่มสิทธิ์",
        "who": "ผู้พัฒนาระบบ",
        "body": "หลังสร้างแอป ตรวจ App Overview → API Permission Group หากกลุ่มสิทธิ์ยังเป็น Inactive ให้กด Apply และกรอก Reason อธิบายการอ่านออเดอร์ จัดส่ง และปรับสต๊อก แนบเอกสารเพิ่มเติมเมื่อจำเป็น",
        "links": [
          [
            "วิธีขอสิทธิ์ API",
            "https://open.lazada.com/apps/doc/doc?docId=108131&nodeId=10535"
          ]
        ]
      },
      {
        "title": "เตรียมการรับผลและเพิ่มร้านถ้าจำเป็น",
        "who": "ผู้พัฒนาระบบ + เจ้าของร้าน",
        "body": "ตั้ง Callback URL ของระบบจริง เก็บ App Key และ App Secret บนเซิร์ฟเวอร์ ตรวจนโยบาย Authorization หากแอปกำหนด Authorized Seller Whitelist ให้เพิ่ม Seller ID / short code และประเทศร้านตามหน้าตั้งค่า",
        "links": [
          [
            "ข้อมูลแอปและสถานะ",
            "https://open.lazada.com/apps/doc/doc?docId=108055&nodeId=10433"
          ],
          [
            "เงื่อนไข Seller Whitelist",
            "https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533"
          ]
        ]
      },
      {
        "title": "เจ้าของร้านอนุญาตผ่าน Lazada",
        "who": "เจ้าของร้าน",
        "body": "เปิดลิงก์อนุญาตจากแอปจริง เลือก Thailand → Use Seller Login ล็อกอินบัญชีร้าน ตรวจร้านและสิทธิ์ แล้วกด Authorize ระบบต้องรับผลและตรวจสิทธิ์ที่ได้ก่อนแสดงว่าเชื่อมแล้ว",
        "links": [
          [
            "ขั้นตอน Authorize ร้าน",
            "https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533"
          ]
        ]
      },
      {
        "title": "ทดสอบออเดอร์และขอใช้จริง",
        "who": "ผู้พัฒนาระบบ + ทีมคลัง",
        "body": "ทดสอบ GetOrders / GetOrderItems และงานจัดส่งที่ใช้จริง ตรวจสิทธิ์ปรับสต๊อก เช่น UpdateSellableQuantity แล้วดำเนินการ Apply Online ตามสถานะแอป ตรวจนโยบายการอนุญาตอีกครั้งก่อนเปิดใช้กับร้านจริง",
        "links": [
          [
            "คำสั่งซื้อและจัดส่ง",
            "https://open.lazada.com/apps/doc/doc?docId=120984&nodeId=30764"
          ],
          [
            "สินค้าและสต๊อก",
            "https://open.lazada.com/apps/doc/doc?docId=120945&nodeId=29614"
          ]
        ]
      }
    ],
    "fields": [
      [
        "App Key / App Secret",
        "รายละเอียดแอปใน Lazada Open Platform เก็บ Secret ฝั่งเซิร์ฟเวอร์"
      ],
      [
        "Callback URL",
        "URL ของระบบที่รับผลการอนุญาตได้จริง"
      ],
      [
        "API Permission Group",
        "กลุ่มอ่านออเดอร์ สินค้า จัดส่ง และปรับสต๊อกตามฟังก์ชัน"
      ],
      [
        "Seller ID / short code",
        "เตรียมเฉพาะกรณีที่แอปต้องใช้ Seller Whitelist"
      ]
    ],
    "done": "ตรวจทั้งการอนุญาตร้านและ API Permission Group การกด Authorize สำเร็จอาจยังไม่ได้สิทธิ์ทุกฟังก์ชัน"
  },
  "TikTok Shop": {
    "mode": "API คำสั่งซื้อและสต๊อก",
    "intro": "ใช้เส้นทาง seller developer และแอปสำหรับร้านของตนเอง พร้อมสิทธิ์อ่านออเดอร์และปรับสต๊อก",
    "eligibility": "ประเภทแอป ประเทศ และ Seller type ต้องตรงร้านไทย ขั้นตอน Review ขึ้นกับประเภทแอปและสถานะที่ Partner Center แสดง",
    "eligibilityUrl": "https://partner.tiktokshop.com/docv2/page/app-review-process",
    "steps": [
      {
        "title": "สมัครเส้นทางสำหรับผู้ขาย",
        "who": "เจ้าของร้าน",
        "body": "เข้า TikTok Shop Partner Center และเลือกเส้นทาง seller developer สำหรับระบบของร้านตนเอง ดำเนินการยืนยันบัญชีตามที่แสดง ใช้บัญชีผู้ขาย TikTok Shop",
        "links": [
          [
            "เปิด Partner Center สำหรับร้านไทย",
            "https://partner.tiktokshop.com/"
          ],
          [
            "เส้นทางและข้อกำหนดของแอป",
            "https://partner.tiktokshop.com/docv2/page/app-review-process"
          ]
        ]
      },
      {
        "title": "สร้าง Custom app สำหรับร้าน",
        "who": "ผู้พัฒนาระบบ",
        "body": "ไป App & Service → Create app & service → Custom ตั้งชื่อและหมวดให้ตรงงาน เลือก Market: Thailand และ Seller type ให้ตรงร้าน เปิด Enable API แล้วตั้ง Redirect URL หากต้องรับเหตุการณ์อัตโนมัติให้เตรียม Webhook URL ด้วย",
        "links": [
          [
            "คู่มือสร้างแอป (ตัวอย่างหน้าจอ US / ROW)",
            "https://partner.us.tiktokshop.com/docv2/page/create-your-app"
          ]
        ]
      },
      {
        "title": "เปิดสิทธิ์ออเดอร์และสินค้า",
        "who": "ผู้พัฒนาระบบ",
        "body": "เปิด API scopes ที่จำเป็นสำหรับรับออเดอร์และจัดส่ง หากต้องส่งสต๊อกกลางกลับไป TikTok Shop ให้ตรวจ Product Modify (seller.product.write) สำหรับ Update Inventory เก็บ App Secret บนเซิร์ฟเวอร์",
        "links": [
          [
            "Order Management System",
            "https://partner.tiktokshop.com/docv2/page/order-management-system-oms"
          ],
          [
            "Update Inventory และสิทธิ์ที่ใช้",
            "https://partner.tiktokshop.com/docv2/page/update-inventory"
          ]
        ]
      },
      {
        "title": "ให้เจ้าของร้านอนุญาตแอป",
        "who": "เจ้าของร้าน",
        "body": "เปิด seller authorization link จากแอปจริง ล็อกอินบัญชีผู้ขาย เลือกร้านและตรวจสิทธิ์ก่อนยืนยัน ระบบต้องรับผลกลับมาและตรวจร้านกับสิทธิ์ที่ได้รับ",
        "links": [
          [
            "ข้อมูลแอปและการอนุญาต",
            "https://partner.us.tiktokshop.com/docv2/page/create-your-app"
          ]
        ]
      },
      {
        "title": "ทดสอบและผ่านขั้นตอนที่แอปกำหนด",
        "who": "ผู้พัฒนาระบบ + ทีมคลัง",
        "body": "ทดสอบใน Development Shop ก่อนเชื่อมร้านจริง ระบบสำหรับร้านตนเองโดยทั่วไปไม่ต้องผ่าน marketplace app review แต่หากเป็น Connector หรือ Partner Center ขอ Review / security checks ต้องทำให้ครบ แล้วจึงเทียบออเดอร์และสต๊อกจริง",
        "links": [
          [
            "Development Shop",
            "https://partner.tiktokshop.com/docv2/page/ar5ppjvv"
          ],
          [
            "ตรวจเงื่อนไข App Review",
            "https://partner.tiktokshop.com/docv2/page/app-review-process"
          ]
        ]
      }
    ],
    "fields": [
      [
        "Market / Seller type",
        "เลือกประเทศ Thailand และประเภทผู้ขายให้ตรงร้าน"
      ],
      [
        "App Key / App Secret / Service ID",
        "จากรายละเอียดแอปใน Partner Center"
      ],
      [
        "Redirect URL / Webhook URL",
        "ปลายทางของระบบจริง โดย Webhook ใช้เมื่อรับเหตุการณ์อัตโนมัติ"
      ],
      [
        "API scopes",
        "ออเดอร์ งานจัดส่ง และ Product Modify เมื่อปรับสต๊อก"
      ]
    ],
    "done": "ใช้ Partner Center ประเทศที่ถูกต้อง และเปิดใช้จริงเมื่อทดสอบออเดอร์กับสต๊อกผ่านตามสถานะแอป"
  },
  "Facebook": {
    "mode": "ข้อความเพจ → ทีมยืนยันออเดอร์",
    "intro": "รับข้อความจากเพจเข้าระบบ ให้ทีมตรวจสินค้า การชำระเงินและที่อยู่ แล้วสร้างออเดอร์กลาง",
    "eligibility": "ช่องทางนี้เชื่อม Messenger ของเพจ การได้รับข้อความไม่ได้ยืนยันว่าเกิดคำสั่งซื้อหรือชำระเงินแล้ว",
    "eligibilityUrl": "https://developers.facebook.com/docs/messenger-platform/get-started/",
    "steps": [
      {
        "title": "เตรียมเพจและบัญชีผู้ดูแล",
        "who": "เจ้าของเพจ",
        "body": "เลือก Facebook Page ที่ต้องรับข้อความ และใช้บัญชีที่มีสิทธิ์จัดการงานข้อความของเพจ ผู้พัฒนาต้องเตรียม Meta app สำหรับ Messenger",
        "links": [
          [
            "Meta for Developers",
            "https://developers.facebook.com/"
          ],
          [
            "เริ่มต้น Messenger Platform",
            "https://developers.facebook.com/docs/messenger-platform/get-started/"
          ]
        ]
      },
      {
        "title": "ตั้งค่าแอปและสิทธิ์ข้อความ",
        "who": "ผู้พัฒนาระบบ",
        "body": "ตรวจ Page access token และ pages_messaging สำหรับงานข้อความ หากอ่านประวัติสนทนาให้ตรวจ pages_manage_metadata และ pages_read_engagement ตาม API ที่ใช้ เก็บ token บนเซิร์ฟเวอร์",
        "links": [
          [
            "เอกสาร Messenger API โดย Meta",
            "https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api"
          ],
          [
            "สิทธิ์อ่านบทสนทนา",
            "https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a"
          ]
        ]
      },
      {
        "title": "ตั้งรับข้อความและตรวจ App Review",
        "who": "ผู้พัฒนาระบบ",
        "body": "ตั้ง Webhook ของระบบจริง ตรวจขั้นตอน App Review / Advanced Access สำหรับข้อมูลของบุคคลนอกบทบาททดสอบตามสิทธิ์และสถานะแอป ก่อนเปิดให้ลูกค้าทั่วไปใช้",
        "links": [
          [
            "ตั้งค่า Webhooks",
            "https://developers.facebook.com/docs/messenger-platform/webhooks/"
          ],
          [
            "ตรวจ App Review",
            "https://developers.facebook.com/docs/messenger-platform/app-review/"
          ]
        ]
      },
      {
        "title": "อนุญาตเพจและทดสอบข้อความ",
        "who": "เจ้าของเพจ + ทีมขาย",
        "body": "เมื่อแอปพร้อม ให้ผู้มีสิทธิ์อนุญาตเพจ ส่งข้อความทดสอบ แล้วตรวจว่าข้อความเข้าระบบ จากนั้นทีมขายตรวจสินค้า จำนวน ราคา การชำระเงินและที่อยู่ ก่อนสร้างและยืนยันออเดอร์เพื่อกันสต๊อก",
        "links": [
          [
            "คู่มือ Messenger Platform",
            "https://developers.facebook.com/docs/messenger-platform/"
          ]
        ]
      }
    ],
    "fields": [
      [
        "Meta app และ Facebook Page",
        "แอปสำหรับ Messenger และเพจที่ผู้ดูแลมีสิทธิ์"
      ],
      [
        "Page access token / API permissions",
        "เก็บ token บนเซิร์ฟเวอร์และตรวจสิทธิ์ตามงาน"
      ],
      [
        "Webhook / App Review",
        "ตั้งปลายทางระบบจริงและผ่านขั้นตอนที่ Meta ขอ"
      ]
    ],
    "done": "ข้อความเข้า → ทีมตรวจและยืนยัน → สร้างออเดอร์ → กันสต๊อก → จัดส่ง"
  },
  "LINE OA": {
    "mode": "ข้อความ OA → ทีมยืนยันออเดอร์",
    "intro": "เชื่อม Messaging API ของ LINE Official Account เพื่อรับข้อความ แล้วให้ทีมยืนยันออเดอร์กลาง",
    "eligibility": "หนึ่งช่องทางตั้ง Webhook ได้หนึ่งปลายทาง ต้องตรวจระบบแชตเดิมก่อนเปลี่ยน และเลือก Provider ให้ถูกต้องเพราะย้ายภายหลังไม่ได้",
    "eligibilityUrl": "https://developers.line.biz/en/docs/messaging-api/getting-started/",
    "steps": [
      {
        "title": "เปิด Messaging API ของ OA",
        "who": "เจ้าของ LINE OA",
        "body": "เข้า LINE Official Account Manager เลือกบัญชี OA แล้วเปิด Messaging API เลือก Provider ของบริษัทให้ถูกต้อง จากนั้นตรวจช่องทางที่สร้างใน LINE Developers Console",
        "links": [
          [
            "LINE Official Account Manager",
            "https://manager.line.biz/"
          ],
          [
            "วิธีเปิด Messaging API",
            "https://developers.line.biz/en/docs/messaging-api/getting-started/"
          ]
        ]
      },
      {
        "title": "เตรียมข้อมูลช่องทางฝั่งระบบ",
        "who": "ผู้พัฒนาระบบ",
        "body": "เข้า LINE Developers Console ด้วยบัญชีที่มีสิทธิ์ Channel Admin ตรวจ Channel secret ที่ Basic settings และเตรียม Channel access token ตามวิธีที่ LINE รองรับ เก็บข้อมูลลับและตรวจลายเซ็นเหตุการณ์บนเซิร์ฟเวอร์",
        "links": [
          [
            "เปิด LINE Developers Console",
            "https://developers.line.biz/console/"
          ],
          [
            "ตรวจลายเซ็นของ Webhook",
            "https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/"
          ]
        ]
      },
      {
        "title": "ตั้ง URL รับข้อความ",
        "who": "ผู้พัฒนาระบบ + เจ้าของ OA",
        "body": "ที่แท็บ Messaging API ใส่ Webhook URL แบบ HTTPS ของระบบจริง → Update → Verify ให้ผ่าน → เปิด Use webhook หาก OA มีระบบแชตเดิม ต้องจัดการปลายทางร่วมกันก่อนเปลี่ยน",
        "links": [
          [
            "ตั้ง Webhook และ access token",
            "https://developers.line.biz/en/docs/messaging-api/building-bot/"
          ]
        ]
      },
      {
        "title": "ทดสอบข้อความและสร้างออเดอร์",
        "who": "ทีมขาย",
        "body": "ส่งข้อความทดสอบเข้า OA ตรวจว่าระบบรับได้ แล้วให้ทีมตรวจสินค้า จำนวน ราคา การชำระเงินและที่อยู่ก่อนสร้างออเดอร์ เมื่อยืนยันจึงกันสต๊อกกลาง",
        "links": [
          [
            "การทำงานของ Messaging API",
            "https://developers.line.biz/en/docs/messaging-api/overview/"
          ]
        ]
      }
    ],
    "fields": [
      [
        "LINE OA / Provider",
        "บัญชี Official Account และ Provider ของบริษัท"
      ],
      [
        "Channel secret",
        "LINE Developers Console → Basic settings"
      ],
      [
        "Channel access token",
        "ตั้งตามวิธีที่ LINE รองรับ ไม่จำกัดเฉพาะ long-lived token"
      ],
      [
        "Webhook URL",
        "HTTPS ของระบบจริง ตรวจ Verify และ Use webhook"
      ]
    ],
    "done": "LINE OA ใช้รับข้อความ; หากต้องการออเดอร์ LINE SHOPPING ต้องประเมินการเชื่อมต่อแยกต่างหาก"
  },
  "Review": {
    "mode": "บันทึกออเดอร์ส่งฟรีในระบบ",
    "intro": "ส่งสินค้าให้ผู้รีวิวหรืออินฟลูเอนเซอร์ ใช้สต๊อกกลางและแสดงต้นทุนการส่งรีวิวแยกจากยอดขาย",
    "steps": [
      {
        "title": "เปิดออเดอร์ส่งรีวิว",
        "who": "Admin",
        "body": "เข้าเมนูคำสั่งซื้อ → เพิ่มออเดอร์ เลือก Review ระบุผู้รับ สินค้า และจำนวน ระบบตั้งยอดขายเป็นศูนย์และลองกันสต๊อกกลาง",
        "links": []
      },
      {
        "title": "หยิบ แพ็ก และจัดส่ง",
        "who": "ทีมคลัง",
        "body": "ตรวจ SKU และจำนวนให้ครบก่อนปิดกล่อง เมื่อส่งมอบจึงตัดสินค้าคงคลัง รายงานจะแสดงต้นทุนสินค้าที่ส่งรีวิวโดยไม่เพิ่มยอดขาย",
        "links": []
      }
    ],
    "fields": [],
    "done": "ช่องทาง Review ไม่ต้องสมัครแอปหรือขอสิทธิ์ API"
  },
  "Offline sales": {
    "mode": "บันทึกออเดอร์หน้าร้านในระบบ",
    "intro": "บันทึกยอดหน้าร้านหรืองานขายของทีมโดยใช้สต๊อกกองเดียวกับช่องทางออนไลน์",
    "steps": [
      {
        "title": "เปิดออเดอร์หน้าร้าน",
        "who": "Admin / ทีมขายผ่าน Admin",
        "body": "เข้าเมนูคำสั่งซื้อ → เพิ่มออเดอร์ เลือก Offline sales ระบุสินค้า จำนวน และข้อมูลผู้รับ ตรวจการชำระเงินตามงานขาย",
        "links": []
      },
      {
        "title": "ยืนยันและกันสต๊อกกลาง",
        "who": "Admin + ทีมคลัง",
        "body": "ตรวจรายการแล้วเข้าคิวหยิบ กันสต๊อก ตรวจแพ็กและส่งมอบตามขั้นตอน ปัจจุบันเป็นการบันทึกด้วยตนเอง หากจะรับออเดอร์จาก POS ต้องประเมิน API ของ POS เพิ่ม",
        "links": []
      }
    ],
    "fields": [],
    "done": "ช่องทาง Offline sales ปัจจุบันไม่ต้องสมัคร API ของ marketplace"
  }
};
let activeAPIGuide='Shopee';
function guideLink(label,url){return `<a class="guide-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${icon('link')}</a>`}
function apiGuideBody(channel){
  const g=apiRequestGuides[channel];
  return `<div class="api-guide-content" data-guide-content="${esc(channel)}"><div class="api-guide-heading">${channelLogo(channel)}<div><span class="eyebrow">${esc(g.mode)}</span><h3>${esc(channel)}</h3><p>${esc(g.intro)}</p></div></div>${g.eligibility?`<div class="api-eligibility"><strong>ตรวจเรื่องนี้ก่อนเริ่ม</strong><p>${esc(g.eligibility)}</p>${guideLink('ดูเงื่อนไขทางการ',g.eligibilityUrl)}</div>`:''}<ol class="api-steps">${g.steps.map((s,i)=>`<li class="api-step"><span class="api-step-number">${String(i+1).padStart(2,'0')}</span><div><div class="api-step-top"><h4>${esc(s.title)}</h4><span class="api-owner">${esc(s.who)}</span></div><p>${esc(s.body)}</p>${s.links.length?`<div class="api-step-links">${s.links.map(([label,url])=>guideLink(label,url)).join('')}</div>`:''}</div></li>`).join('')}</ol>${g.fields.length?`<details class="advanced-guide api-fields"><summary>ข้อมูลที่ผู้พัฒนาต้องตั้งค่า และหาได้ที่ไหน</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>ข้อมูล</th><th>หา / ตั้งค่าที่ไหน</th></tr></thead><tbody>${g.fields.map(([k,v])=>`<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div><p class="form-help">ข้อมูลลับของแอปเก็บบนเซิร์ฟเวอร์ของระบบจริง แบบร่างในหน้านี้เก็บเฉพาะชื่อร้านและลิงก์ร้าน</p></details>`:''}<div class="api-result"><strong>เมื่อทำครบแล้ว</strong><p>${esc(g.done)}</p></div><p class="api-source-date">อ้างอิงคู่มือทางการ · ตรวจเมื่อ 7 ต.ค. 2026 · เมนูและเงื่อนไขขึ้นกับประเภทบัญชีและสถานะแอป</p></div>`
}
function apiGuidePanel(){return panel('วิธีขอเชื่อม API คำสั่งซื้อ','เลือกช่องทาง แล้วทำตามขั้นตอนพร้อมลิงก์ทางการ',`<div class="api-guide-tabs" role="tablist" aria-label="คู่มือ API ตามช่องทาง">${CHANNELS.map(c=>`<button class="api-guide-tab ${activeAPIGuide===c.name?'active':''}" role="tab" aria-selected="${activeAPIGuide===c.name}" data-api-tab="${esc(c.name)}">${esc(c.name)}</button>`).join('')}</div><div class="panel-body" id="api-guide-body" role="tabpanel">${apiGuideBody(activeAPIGuide)}</div>`,'','api-guide-panel')}
views.connections=()=>`<div class="notice blue">${icon('link')}บันทึกข้อมูลร้านและอ่านวิธีขอ API ได้ที่นี่ · การอนุญาตแอปและทดสอบร้านจริงยังรอพัฒนาตัวเชื่อม</div><div class="connection-grid">${CHANNELS.map(c=>{const g=connectGuides[c.name],d=connectionDrafts.find(d=>d.channel===c.name);return `<article class="connection-card"><div class="card-title">${channelLogo(c.name)}<div><h2>${c.name}</h2><span class="badge ${d?'ready':''}">${d?(g.kind==='manual'?'บันทึกช่องทางแล้ว':'เตรียมข้อมูลร้านแล้ว'):'ยังไม่ตั้งค่า'}</span></div></div><p>${g.desc}</p><div class="connection-card-actions"><button class="btn" data-connection="${esc(c.name)}">${d?'ตั้งค่าต่อ / แก้ไข':'เริ่มตั้งค่า'}</button><button class="text-btn" data-guide="${esc(c.name)}">${g.kind==='manual'?'วิธีบันทึกออเดอร์':'วิธีขอเชื่อม API'}</button></div>${d?`<div class="connection-draft-name">${esc(d.storeName)} · คลังกลาง</div>`:''}</article>`}).join('')}</div><div id="api-guide" style="margin-top:24px">${apiGuidePanel()}</div>`;
function bindGuideControls(){
  document.querySelectorAll('[data-api-tab]').forEach(b=>b.onclick=()=>{activeAPIGuide=b.dataset.apiTab;document.getElementById('api-guide-body').innerHTML=apiGuideBody(activeAPIGuide);document.querySelectorAll('[data-api-tab]').forEach(t=>{const active=t.dataset.apiTab===activeAPIGuide;t.classList.toggle('active',active);t.setAttribute('aria-selected',String(active))})});
  document.querySelectorAll('[data-guide]').forEach(b=>b.onclick=()=>openAPIGuide(b.dataset.guide,b.dataset.guideReturn===undefined?null:Number(b.dataset.guideReturn)));
}
function bindConnections(){document.querySelectorAll('[data-connection]').forEach(b=>b.onclick=()=>openConnectionWizard(b.dataset.connection));bindGuideControls()}
function openAPIGuide(channel,returnStep=null){
  if(currentAuth?.role!=='admin'||!apiRequestGuides[channel])return;
  modal('วิธีขอเชื่อม '+channel,'ขั้นตอนสำหรับเจ้าของร้านและผู้พัฒนาระบบ',apiGuideBody(channel)+`<div class="modal-actions"><button class="btn primary" id="guide-return">${returnStep===null?'ปิดคู่มือ':'กลับไปตั้งค่าร้าน'}</button></div>`);
  document.getElementById('dialog').classList.add('guide-dialog');
  document.getElementById('guide-return').onclick=()=>{document.getElementById('dialog').classList.remove('guide-dialog');if(returnStep===null)document.getElementById('dialog').close();else openConnectionWizard(channel,returnStep)};
}
function connectionHelp(){openAPIGuide(activeAPIGuide)}
function openConnectionWizard(channel,step=1){
  if(currentAuth?.role!=='admin')return;
  const g=connectGuides[channel],d=connectionDrafts.find(d=>d.channel===channel)||{};if(!g)return;
  const manual=g.kind==='manual';
  document.getElementById('dialog').classList.remove('guide-dialog');
  let content=`<div class="wizard-stepper">${['เลือกช่องทาง','ข้อมูลร้าน','แอปและอนุญาตบัญชี','ตรวจความพร้อม'].map((s,i)=>`<div class="wizard-step ${i<=step?'active':''}"><b>0${i+1}</b>${s}</div>`).join('')}</div><div class="wizard-platform">${channelLogo(channel)}<div><h3>${channel}</h3><small>${g.desc}</small></div></div>`;
  if(step===1)content+=`<form id="connection-form"><div class="wizard-fields"><label class="field">ชื่อร้าน / ชื่อเรียกในระบบ<input name="storeName" value="${esc(d.storeName||'')}" placeholder="เช่น ร้านหลัก ${channel}" maxlength="80" required><span class="form-help">ใช้ชื่อที่ทีมจำได้ เช่น ร้านหลัก หรือสาขาสยาม</span></label><label class="field">ลิงก์ร้านหรือเพจ (ไม่บังคับ)<input name="storeUrl" type="url" value="${esc(d.storeUrl||'')}" placeholder="https://..." maxlength="500"><span class="form-help">คัดลอกจากหน้าโปรไฟล์ร้านหรือเพจ ไม่ต้องใส่รหัสผ่าน</span></label><label class="field">คลังที่ใช้<input value="คลังกลาง — สต๊อกเดียวกันทุกช่องทาง" readonly></label></div><div class="auth-error" id="connection-error"></div><div class="modal-actions"><button class="btn primary" type="submit">บันทึกและดูขั้นตอนถัดไป</button></div></form>`;
  else if(step===2)content+=`<h3>${manual?'วิธีบันทึกช่องทางภายใน':'ขอแอปและสิทธิ์ก่อนอนุญาตร้าน'}</h3>${manual?'':`<div class="wizard-callout"><strong>ข้อมูลร้านบันทึกแล้ว · ตัวเชื่อม API ยังรอพัฒนา</strong><p>ต้องสมัครแอปกับแพลตฟอร์มและตั้งค่าระบบที่รับผลอนุญาตได้จริงก่อน ลิงก์ด้านล่างเป็นคู่มือและหน้าสมัคร การกดอ่านคู่มือยังไม่เชื่อมบัญชีร้าน</p></div>`}${apiGuideBody(channel)}<div class="modal-actions"><button class="btn" id="wizard-back">แก้ข้อมูลร้าน</button><button class="btn primary" id="wizard-check">ตรวจความพร้อม</button></div>`;
  else content+=`<h3>ผลตรวจความพร้อม</h3><div class="stat-line"><span>ข้อมูลร้าน ${esc(d.storeName||'')}</span><span class="badge packed">บันทึกแล้ว</span></div><div class="stat-line"><span>ใช้คลังกลาง</span><span class="badge packed">พร้อม</span></div><div class="stat-line"><span>${manual?'เปิดออเดอร์ในระบบ':'แอปและสิทธิ์ API'}</span><span class="badge ${manual?'packed':'hold'}">${manual?'พร้อม':'ยังไม่ตั้งค่า'}</span></div>${manual?'':`<div class="api-readiness-action"><button class="text-btn" data-guide="${esc(channel)}" data-guide-return="3">ดูวิธีขอแอปและสิทธิ์ API ${icon('link')}</button></div>`}<div class="stat-line"><span>ทดสอบอ่านออเดอร์จริง</span><span class="badge">${manual?'ไม่ใช้ API':'ยังไม่ได้ทดสอบ'}</span></div><div class="wizard-callout"><strong>${manual?'พร้อมเริ่มบันทึกออเดอร์':'เตรียมข้อมูลแล้ว ยังไม่เชื่อม API'}</strong><p>${manual?'ออเดอร์ในช่องทางนี้ใช้สต๊อกเดียวกับช่องทางอื่น':'ขั้นต่อไป: เจ้าของร้านสมัครตามคู่มือ และผู้พัฒนาเพิ่มตัวเชื่อมพร้อม URL ระบบจริง เมื่อพร้อมแล้วจึงให้ร้านกดอนุญาตและทดสอบออเดอร์ ไม่ต้องกรอกข้อมูลร้านซ้ำ'}</p></div><div class="modal-actions"><button class="btn" id="wizard-back">ดูขั้นตอนขอ API</button><button class="btn primary" id="wizard-done">${manual?'ไปเปิดออเดอร์':'เสร็จสิ้นการเตรียมข้อมูล'}</button></div>`;
  modal('ตั้งค่า '+channel,'ทำทีละขั้น ข้อมูลร้านบันทึกไว้ต่อได้',content);
  if(step===2)document.getElementById('dialog').classList.add('guide-dialog');
  const form=document.getElementById('connection-form');if(form)form.onsubmit=async e=>{e.preventDefault();try{await api('/connections','POST',{channel,...Object.fromEntries(new FormData(e.target))});connectionDrafts=(await api('/connections')).drafts;openConnectionWizard(channel,2);shell()}catch(err){document.getElementById('connection-error').textContent=err.message}};
  const back=document.getElementById('wizard-back');if(back)back.onclick=()=>openConnectionWizard(channel,step-1);
  const check=document.getElementById('wizard-check');if(check)check.onclick=async()=>{try{connectionDrafts=(await api('/connections')).drafts;openConnectionWizard(channel,3)}catch(e){toast(e.message)}};
  const done=document.getElementById('wizard-done');if(done)done.onclick=()=>{document.getElementById('dialog').classList.remove('guide-dialog');document.getElementById('dialog').close();if(manual){changeView('orders');newOrder()}else shell()};
  bindGuideControls();
}
const PRESETS=[['today','วันนี้'],['yesterday','เมื่อวาน'],['7days','7 วันล่าสุด'],['30days','30 วันล่าสุด'],['month','เดือนล่าสุด'],['3months','3 เดือนล่าสุด'],['year','ปีนี้'],['lastyear','ปีที่แล้ว']];
const iso=d=>d.toISOString().slice(0,10);function dateRange(key,today=TODAY){const [y,m,d]=today.split('-').map(Number),end=new Date(Date.UTC(y,m-1,d)),shift=n=>iso(new Date(end.getTime()+n*86400000));switch(key){case 'today':return [today,today];case 'yesterday':return [shift(-1),shift(-1)];case '7days':return [shift(-6),today];case '30days':return [shift(-29),today];case 'month':return [iso(new Date(Date.UTC(y,m-1,1))),today];case '3months':return [iso(new Date(Date.UTC(y,m-3,1))),today];case 'year':return [y+'-01-01',today];case 'lastyear':return [(y-1)+'-01-01',(y-1)+'-12-31'];default:throw Error('ไม่พบช่วงวันที่')}}
let activePreset='7days';const datedFilter=filterbar;filterbar=function(extra){return `<div class="date-presets" aria-label="เลือกช่วงวันที่">${PRESETS.map(([k,t])=>`<button data-date-preset="${k}" title="${k==='month'?'ตั้งแต่วันที่ 1 ของเดือนนี้ถึงวันนี้':k==='3months'?'เดือนนี้และ 2 เดือนก่อนหน้า จนถึงวันนี้':t}" class="date-preset ${activePreset===k?'active':''}">${t}</button>`).join('')}</div>`+datedFilter(extra)};
const existingBind=bind;bind=function(){existingBind();document.querySelectorAll('[data-date-preset]').forEach(b=>b.onclick=()=>{const [from,to]=dateRange(b.dataset.datePreset);Object.assign(state,{from,to,page:1});activePreset=b.dataset.datePreset;state.selected.clear();shell()});for(const id of ['from','to']){const input=document.getElementById(id);if(input){const old=input.onchange;input.onchange=e=>{activePreset='';old(e)}}}};
const originalAction=action;action=function(a){if(a==='reset'){const [from,to]=dateRange('7days');Object.assign(state,{from,to,channel:'',product:'',province:'',q:'',status:'all',page:1});activePreset='7days';state.selected.clear();shell();return}originalAction(a)};
const [initialFrom,initialTo]=dateRange('7days');state.from=initialFrom;state.to=initialTo;
document.getElementById('dialog').addEventListener('close',()=>document.getElementById('dialog').classList.remove('guide-dialog'));
bootAuth();
