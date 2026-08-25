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
| `LIFF_ID` หรือ `LIFF_BASE_URL` | (ถ้าทำหน้าแก้ไขจำนวนผ่าน LIFF) | ไม่ตั้งก็ยังใช้บอทหลักได้ปกติ |

**สำคัญ:** หลังแก้ Settings ทุกครั้ง ต้องเข้าไปที่แท็บ **Deployments** แล้วกด **Promote version** ที่เวอร์ชันล่าสุด ไม่งั้น Cloudflare จะยังใช้เวอร์ชันเก่าอยู่ (จุดที่ทำให้บอทไม่ตอบมาแล้วรอบนึง)

ไปที่ Settings -> Bindings:
| Variable name | ประเภท | ค่า |
|---|---|---|
| `KOPI_KV` | KV Namespace | `kopi-order-cloud-state` |

## LINE Official Account
- Provider: Kopi Order Cloud
- OA Account name: โกปี๊ Sup (@543fgwit)
- Messaging API เปิดใช้งานแล้ว, Auto-reply / Greeting message ปิดไว้ (กันชนกับบอท)

## บันทึกการแก้บั๊ก (25 ส.ค. 2026)
เพิ่ม `console.error(...)` ในจุดที่เคยเงียบ (ไม่แจ้ง error) เวลา LINE Reply API ตอบกลับไม่สำเร็จ หรือโค้ดใน webhook พัง — เช็ค log ได้ที่ Cloudflare dashboard -> supplier-order -> Observability
