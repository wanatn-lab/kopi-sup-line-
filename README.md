# Kopi Order Cloud — Smart Order Splitter (LINE Bot + Cloudflare Worker)

โปรเจกต์นี้คือ Cloudflare Worker ตัวเดียวที่ทำ 2 หน้าที่:
1. หน้าเว็บแยกออเดอร์ (Order Splitter) — เก็บฐานข้อมูลวัตถุดิบ/ซัพพลายเออร์ใน Workers KV
2. LINE Bot "Smart Order Splitter" — รับข้อความสั่งของทาง LINE แล้วแยกกลุ่มตามซัพพลายเออร์อัตโนมัติ

## ไฟล์ในนี้
- `worker.js` — โค้ดทั้งหมด (Cloudflare Worker) วางแทนที่โค้ดเดิมใน Cloudflare dashboard ได้เลย (Edit code -> select all -> paste -> Deploy)

## Cloudflare Worker ที่ deploy อยู่
- Worker name: `supplier-order`
- URL: https://supplier-order.wanat-n.workers.dev
- Webhook URL (ใส่ใน LINE Developers Console): `https://supplier-order.wanat-n.workers.dev/webhook/line`

## ต้องตั้งค่าเองบนเครื่องใหม่ / worker ตัวใหม่ (ไม่ได้เก็บไว้ใน git เพราะเป็นความลับ)
ไปที่ Cloudflare dashboard -> Workers & Pages -> supplier-order -> Settings -> Variables and secrets:

| ชื่อตัวแปร | ค่า | หมายเหตุ |
|---|---|---|
| `LINE_CHANNEL_SECRET` | (ดูใน LINE Developers Console > Messaging API > Channel secret) | |
| `LINE_CHANNEL_ACCESS_TOKEN` | (ดูใน LINE Developers Console > Messaging API > Channel access token — กด Reissue ถ้าไม่มี) | |
| `LIFF_ID` | LIFF ID จากแท็บ LIFF ของ LINE Developers Console | ต้องตั้งเพื่อเปิดหน้าพิมพ์จำนวน/ลบรายการ |
| `LIFF_CHANNEL_ID` | Channel ID ของ LINE Login / LIFF channel เดียวกับ LIFF app | ใช้ยืนยันตัวตนแอดมินบน Worker |
| `OWNER_LINE_USER_ID` | LINE user ID ของแอดมิน | รับการ์ดออเดอร์, กดแก้ไข/ส่งซัพพลายเออร์ และใช้ API ได้คนเดียว |
| `ADMIN_LINE_USER_IDS` | LINE user ID เพิ่มเติม คั่นด้วย `,` (ไม่บังคับ) | เพิ่มผู้จัดการที่กดแก้ไข/ส่งได้; การ์ดออเดอร์ยังส่งไปที่ `OWNER_LINE_USER_ID` |
| `OCR_SPACE_API_KEY` | API key จาก OCR.space Free | ใช้อ่านรูปบิล/รายการสั่งของจาก LINE; ตั้งเป็น **Secret** เท่านั้น |

## OCR รูปภาพแบบไม่มีค่าใช้จ่าย

เมื่อพนักงานส่งรูปเข้าบอต Worker จะดึงรูปจาก LINE, ย่อเป็น JPEG ก่อน แล้วส่งไป OCR.space ด้วยภาษาไทย (`tha`). ข้อความ OCR และการ์ดออเดอร์ที่แก้ไขได้จะถูก push ไปหาแอดมิน; พนักงานได้รับเพียงข้อความยืนยันการรับรูป.

- ใช้ Cloudflare Images Free เพื่อย่อรูปสูงสุด 3 ระดับก่อน OCR โดยไม่มีการเก็บรูปใน Worker. Free plan รองรับ image transformations ใหม่ได้สูงสุด 5,000 รายการ/เดือน; หากเกิน ระบบจะไม่แปลงรูปเพิ่มและ OCR ของรูปนั้นจะไม่ถูกส่งต่อ.
- OCR.space Free รับไฟล์ได้ไม่เกิน **1 MB**. Worker จะตรวจขนาดของรูปที่ย่อแล้วก่อน upload; หากยังเกิน หรือ OCR ล้มเหลว จะแจ้งแอดมินให้ขอรูปใหม่หรือรายการข้อความแทน.
- รูปถูกส่งไปยัง OCR.space เพื่อประมวลผล จึงไม่ควรใช้กับภาพที่มีข้อมูลส่วนบุคคลหรือข้อมูลการชำระเงินที่ไม่ควรส่งให้ผู้ให้บริการภายนอก.

### ตั้งค่า

1. สมัครและสร้าง API key แบบ Free ที่ OCR.space.
2. ใน Cloudflare Dashboard ไปที่ **Workers & Pages → supplier-order → Settings → Variables and Secrets** แล้วเพิ่ม `OCR_SPACE_API_KEY` เป็น **Secret**.
3. ที่ **Workers & Pages → supplier-order → Settings → Images** เปิดใช้ Image Transformations หากบัญชีแสดงปุ่มให้เปิดใช้.
4. Deploy `worker.js` เวอร์ชันนี้ แล้วส่งภาพบิลทดสอบในแชตส่วนตัวกับบอต.

ห้ามนำ key ไปวางใน JavaScript ฝั่งเว็บหรือ `wrangler.toml`.
| `LIFF_BASE_URL` | `https://liff.line.me/<LIFF_ID>` (ไม่บังคับ) | ปกติไม่ต้องตั้ง เพราะระบบสร้างจาก `LIFF_ID` ให้เอง |

**สำคัญ:** หลังแก้ Settings ทุกครั้ง ต้องเข้าไปที่แท็บ **Deployments** แล้วกด **Promote version** ที่เวอร์ชันล่าสุด ไม่งั้น Cloudflare จะยังใช้เวอร์ชันเก่าอยู่ (จุดที่ทำให้บอทไม่ตอบมาแล้วรอบนึง)

ไปที่ Settings -> Bindings:
| Variable name | ประเภท | ค่า |
|---|---|---|
| `KOPI_KV` | KV Namespace | `kopi-order-cloud-state` |

## ตั้งค่า LIFF สำหรับแก้ไขออเดอร์

1. ใน LINE Developers Console สร้าง/เลือก LIFF app ที่ผูกกับ channel เดียวกับบอต แล้วตั้ง **Endpoint URL** เป็น `https://supplier-order.wanat-n.workers.dev/liff`.
2. เปิด scope อย่างน้อย `openid` เพื่อให้ Worker ยืนยันว่าเป็น LINE ของแอดมินจริง.
3. ตั้งค่า `LIFF_ID`, `LIFF_CHANNEL_ID` และ `OWNER_LINE_USER_ID` ตามตารางข้างต้น แล้ว Promote deployment ของ Worker.
4. ที่หน้า **Roles** ของ channel เชิญ LINE Business ID ที่ใช้ทดสอบเป็น **Admin** หรือ **Tester** แล้วกดรับคำเชิญ. ขณะ channel อยู่สถานะ **Developing** ผู้ที่ไม่มี role จะเปิด LIFF ไม่ได้และ LINE จะแสดง `400 Bad Request` แบบในภาพ.

ปุ่ม **✏️ แก้ไข** จะเปิด LIFF ให้พิมพ์จำนวนตรง ๆ หรือกด **×** เพื่อลบรายการนั้น แล้วกลับไปกด **ส่งเลย** ในแชทได้ทันที. ปุ่ม **🔀 ย้ายซัพ** ในแชทยังใช้จัดกลุ่มไปซัพพลายเออร์อื่นได้เหมือนเดิม.

## สิทธิ์พนักงานและแอดมิน

- ทุกคนส่งข้อความรายการสั่งของเข้าบอตได้ แต่จะได้รับเพียงข้อความตอบรับ
- การ์ดสรุปที่มีปุ่ม **แก้ไข / ย้ายซัพ / ส่งเลย** ถูกส่งไปยังแชตส่วนตัวของแอดมินเท่านั้น
- ผู้ที่ไม่ใช่แอดมินกด postback ที่คัดลอกมาไม่ได้ และไม่สามารถใช้หน้า LIFF แก้ไขออเดอร์ได้

## LINE Official Account
- Provider: Kopi Order Cloud
- OA Account name: โกปี๊ Sup (@543fgwit)
- Messaging API เปิดใช้งานแล้ว, Auto-reply / Greeting message ปิดไว้ (กันชนกับบอท)

## บันทึกการแก้บั๊ก (25 ส.ค. 2026)
เพิ่ม `console.error(...)` ในจุดที่เคยเงียบ (ไม่แจ้ง error) เวลา LINE Reply API ตอบกลับไม่สำเร็จ หรือโค้ดใน webhook พัง — เช็ค log ได้ที่ Cloudflare dashboard -> supplier-order -> Observability
