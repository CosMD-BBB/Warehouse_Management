import {randomUUID} from 'node:crypto';

export const DIRECT_CARRIERS = Object.freeze(['Flash Express', 'J&T Express', 'KEX', 'ไปรษณีย์ไทย']);
export const MAX_PICKUP_DAYS = 14;
const MARKETPLACES = new Set(['TikTok Shop', 'Shopee', 'Lazada']);
const CHANNELS = new Set([...MARKETPLACES, 'Facebook', 'LINE OA', 'Review', 'Offline sales']);
const PLATFORM_INFORMATION = {
  'TikTok Shop': {
    officialLinks: [{label: 'TikTok Shop Partner Center', url: 'https://partner.tiktokshop.com/'}, {label: 'TikTok Shop Seller Center', url: 'https://seller-th.tiktok.com/'}],
    requirements: ['สร้างแอปผู้พัฒนาและผ่านการอนุมัติของ TikTok Shop', 'ให้เจ้าของร้านอนุญาตแอปและตรวจยืนยันร้านผ่าน callback', 'ขอสิทธิ์อ่านออเดอร์และงานจัดส่ง ตรวจรูปแบบการส่งและเวลารับสินค้าที่แพลตฟอร์มอนุญาต', 'ทดสอบการจัดส่งและเลขติดตามกับร้านที่อนุญาต ก่อนเปิดเรียกรถจริง']
  },
  Shopee: {
    officialLinks: [{label: 'Shopee Open Platform', url: 'https://open.shopee.com/'}, {label: 'Shopee Seller Centre', url: 'https://seller.shopee.co.th/'}],
    requirements: ['สมัคร Shopee Open Platform และผ่านการอนุมัติแอป', 'ให้เจ้าของร้านอนุญาตแอปและตรวจยืนยันร้านผ่าน callback', 'ขอสิทธิ์อ่านออเดอร์และการจัดส่ง ตรวจขนส่ง จุดรับสินค้า และเวลาที่ Shopee อนุญาต', 'ทดสอบการจัดส่งและเลขติดตามกับร้านที่อนุญาต ก่อนเปิดเรียกรถจริง']
  },
  Lazada: {
    officialLinks: [{label: 'Lazada Open Platform', url: 'https://open.lazada.com/'}, {label: 'Lazada Seller Center', url: 'https://sellercenter.lazada.co.th/'}],
    requirements: ['สมัคร Lazada Open Platform และผ่านการอนุมัติแอป', 'ให้เจ้าของร้านอนุญาตแอปและตรวจยืนยันร้านผ่าน callback', 'ขอสิทธิ์อ่านออเดอร์และการจัดส่ง ตรวจวิธีส่งและเวลารับสินค้าที่ Lazada อนุญาต', 'ทดสอบการจัดส่งและเลขติดตามกับร้านที่อนุญาต ก่อนเปิดเรียกรถจริง']
  }
};
const CARRIER_LINKS = {
  'Flash Express': {label: 'Flash Express', url: 'https://www.flashexpress.co.th/'},
  'J&T Express': {label: 'J&T Express', url: 'https://www.jtexpress.co.th/'},
  KEX: {label: 'KEX', url: 'https://th.kex-express.com/'},
  'ไปรษณีย์ไทย': {label: 'ไปรษณีย์ไทย', url: 'https://www.thailandpost.co.th/'}
};

function fault(message, status = 400) { throw Object.assign(new Error(message), {status}); }
function scalarText(value, label, maximum, required = true) {
  if (value !== undefined && value !== null && typeof value !== 'string') fault('กรุณาระบุ' + label + 'ให้ถูกต้อง');
  const result = (value ?? '').trim();
  if ((required && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) fault('กรุณาระบุ' + label + 'ให้ถูกต้อง');
  return result;
}
function object(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault('กรุณาระบุ' + label + 'ให้ครบ');
  if (Object.keys(value).some(key => !allowed.includes(key))) fault('ข้อมูล' + label + 'มีช่องที่ไม่อนุญาต');
  return value;
}
const digits = value => String(value ?? '').replace(/[๐-๙]/gu, char => String(char.charCodeAt(0) - 0x0e50));
function contact(value, label) {
  object(value, label, ['name', 'phone', 'addressLine', 'subdistrict', 'district', 'province', 'postalCode']);
  const phone = digits(scalarText(value.phone, 'เบอร์โทร' + label, 30)).replace(/[\s()\-]/gu, '');
  if (!/^\+?\d{9,15}$/u.test(phone)) fault('เบอร์โทร' + label + 'ต้องมี 9–15 หลัก');
  const postalCode = digits(scalarText(value.postalCode, 'รหัสไปรษณีย์' + label, 5));
  if (!/^\d{5}$/u.test(postalCode)) fault('รหัสไปรษณีย์' + label + 'ต้องมี 5 หลัก');
  return {
    name: scalarText(value.name, 'ชื่อ' + label, 80), phone,
    addressLine: scalarText(value.addressLine, 'บ้าน / ถนน' + label, 300),
    subdistrict: scalarText(value.subdistrict, 'ตำบล' + label, 80),
    district: scalarText(value.district, 'อำเภอ' + label, 80),
    province: scalarText(value.province, 'จังหวัด' + label, 80), postalCode
  };
}
function parcel(value) {
  object(value, 'พัสดุ', ['weightGrams', 'lengthCm', 'widthCm', 'heightCm']);
  if (!Number.isInteger(value.weightGrams) || value.weightGrams < 1 || value.weightGrams > 100000) fault('น้ำหนักพัสดุต้องเป็นจำนวนกรัม 1–100000');
  for (const key of ['lengthCm', 'widthCm', 'heightCm']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 300) fault('ขนาดกล่องแต่ละด้านต้องมากกว่า 0 และไม่เกิน 300 เซนติเมตร');
  return {weightGrams: value.weightGrams, lengthCm: value.lengthCm, widthCm: value.widthCm, heightCm: value.heightCm};
}
function clock(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) fault('เวลาระบบไม่ถูกต้อง', 500);
  return date;
}
export function bangkokDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'}).format(clock(now));
}
function pickupDate(value, method, now) {
  if (method === 'dropoff') {
    if (value !== undefined && value !== '') fault('ส่งเองไม่ต้องเลือกวันเรียกรับสินค้า');
    return '';
  }
  const result = scalarText(value, 'วันเรียกรับสินค้า', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) fault('วันเรียกรับสินค้าต้องเป็นวันที่ที่ถูกต้อง');
  const date = new Date(result + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result) fault('วันเรียกรับสินค้าต้องเป็นวันที่ที่ถูกต้อง');
  const first = new Date(bangkokDate(now) + 'T00:00:00Z');
  const last = new Date(first.getTime() + MAX_PICKUP_DAYS * 86400000);
  if (date < first || date > last) fault('เลือกวันเรียกรับตั้งแต่วันนี้ถึงอีก ' + MAX_PICKUP_DAYS + ' วัน ตามเวลาไทย');
  return result;
}
function pickupTimes(input) {
  const from = scalarText(input.pickupTimeFrom, 'เวลาเริ่มรับสินค้า', 5, false);
  const to = scalarText(input.pickupTimeTo, 'เวลาสิ้นสุดรับสินค้า', 5, false);
  if (input.method === 'dropoff' && (from || to)) fault('ส่งเองไม่ต้องเลือกเวลาเรียกรับสินค้า');
  if (!from && !to) return {pickupTimeFrom: '', pickupTimeTo: ''};
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (!time.test(from) || !time.test(to) || from >= to) fault('กรุณาเลือกช่วงเวลารับสินค้าที่ถูกต้อง เวลาเริ่มต้องก่อนเวลาสิ้นสุด');
  return {pickupTimeFrom: from, pickupTimeTo: to};
}

// Readiness is intentionally independent of connection drafts and browser flags.
// Only a future verified server-side adapter may perform any provider request.
export function shippingReadiness(channel, carrier = '') {
  if (!CHANNELS.has(channel)) fault('ช่องทางจัดส่งไม่ถูกต้อง');
  const marketplace = MARKETPLACES.has(channel), provider = marketplace ? channel : carrier;
  const information = marketplace ? PLATFORM_INFORMATION[channel] : {
    officialLinks: CARRIER_LINKS[carrier] ? [CARRIER_LINKS[carrier]] : [],
    requirements: ['ติดต่อขนส่งที่เลือกเพื่อสมัครบัญชีและขอสิทธิ์ API', 'เก็บข้อมูลเชื่อมต่อบนเซิร์ฟเวอร์และยืนยันบัญชีขนส่ง', 'ตรวจพื้นที่บริการ วิธีรับสินค้า และเวลาที่ขนส่งอนุญาต', 'ทดสอบเรียกรับ ยกเลิก และเลขติดตามก่อนเปิดใช้งานจริง']
  };
  return {
    status: 'not_connected', ready: false, connectionRequired: marketplace ? 'platform' : 'carrier',
    provider, channel,
    message: marketplace ? 'ยังไม่ได้เชื่อม API จัดส่งของ ' + provider + ' ต้องอนุญาตร้านและตรวจบริการจัดส่งของแพลตฟอร์มก่อน'
      : 'ยังไม่ได้เชื่อม API ขนส่ง ' + (provider || 'ที่เลือก') + ' ต้องสมัครบัญชีและตรวจบริการของขนส่งก่อน',
    officialLinks: structuredClone(information.officialLinks), requirements: [...information.requirements]
  };
}
function actorAndOrder(data, input, actor, allowedFields) {
  if (!actor || !['admin', 'warehouse'].includes(actor.role)) fault('ไม่มีสิทธิ์เตรียมคำขอจัดส่ง', 403);
  object(input, 'คำขอจัดส่ง', allowedFields);
  const id = scalarText(input.id, 'เลขออเดอร์', 160);
  const order = data.orders.find(candidate => candidate.id === id);
  if (!order) fault('ไม่พบออเดอร์', 404);
  if (order.status !== 'packed' || order.reserved !== true) fault('ต้องแพ็กสินค้าให้ครบและกันสต๊อกไว้ก่อนเตรียมคำขอจัดส่ง', 409);
  return order;
}
function audit(data, order, actor, message, now) {
  const date = clock(now);
  data.audit ??= [];
  data.audit.unshift({orderId: order.id, at: date.toISOString(), time: date.toLocaleTimeString('th-TH', {timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit'}), actor: actor.name, text: message});
  data.audit = data.audit.slice(0, 2000);
}
function response(shipment) {
  return {
    message: 'บันทึกข้อมูลเตรียมจัดส่งแล้ว ยังไม่ได้เรียกรถหรือแจ้งแพลตฟอร์ม',
    shipmentId: shipment.id, status: shipment.status, readiness: shippingReadiness(shipment.channel, shipment.carrier)
  };
}

export function createShipmentRequest(data, input, actor, {now = Date.now()} = {}) {
  const order = actorAndOrder(data, input, actor, ['action', 'id', 'requestId', 'method', 'pickupDate', 'pickupTimeFrom', 'pickupTimeTo', 'package', 'sender', 'carrier', 'notes']);
  if (!CHANNELS.has(order.channel)) fault('ช่องทางจัดส่งไม่ถูกต้อง');
  const marketplace = MARKETPLACES.has(order.channel);
  if (marketplace && Object.hasOwn(input, 'carrier')) fault('ออเดอร์ Marketplace ต้องใช้บริการจัดส่งที่แพลตฟอร์มกำหนด เปลี่ยนขนส่งจากคำขอนี้ไม่ได้');
  const carrier = scalarText(marketplace ? order.carrier : input.carrier ?? order.carrier, 'ขนส่ง', 60);
  if (!marketplace && !DIRECT_CARRIERS.includes(carrier)) fault('กรุณาเลือกขนส่งที่รองรับ: ' + DIRECT_CARRIERS.join(', '));
  if (!['pickup', 'dropoff'].includes(input.method)) fault('กรุณาเลือกเรียกรับหรือส่งเอง');
  const sourceOrderExternal = scalarText(order.external, 'เลขออเดอร์ต้นทาง', 160, marketplace);
  const recipient = contact({
    name: order.customer, phone: order.phone,
    addressLine: order.shippingAddress?.addressLine, subdistrict: order.shippingAddress?.subdistrict,
    district: order.shippingAddress?.district, province: order.shippingAddress?.province,
    postalCode: order.shippingAddress?.postalCode
  }, 'ผู้รับจากออเดอร์');
  const quantities = new Map();
  if (!Array.isArray(order.items) || !order.items.length) fault('ออเดอร์ไม่มีสินค้าสำหรับจัดส่ง');
  for (const line of order.items) {
    if (!line || typeof line.sku !== 'string' || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 100 || !data.products.some(product => product.sku === line.sku)) fault('สินค้าในออเดอร์ไม่ถูกต้อง');
    quantities.set(line.sku, (quantities.get(line.sku) || 0) + line.qty);
  }
  const fields = {
    provider: marketplace ? order.channel : carrier, carrier, channel: order.channel,
    connectionRequired: marketplace ? 'platform' : 'carrier', sourceOrderExternal,
    method: input.method, pickupDate: pickupDate(input.pickupDate, input.method, now),
    ...pickupTimes(input),
    package: parcel(input.package), sender: contact(input.sender, 'ผู้ส่ง'), recipient,
    items: [...quantities].map(([sku, qty]) => ({sku, qty})), notes: scalarText(input.notes, 'หมายเหตุจัดส่ง', 500, false)
  };
  // A packed order has one active preparation. Equal retries return that same
  // identity; changed details require explicit cancellation before replacement.
  if (order.shipment && order.shipment.status !== 'cancelled') {
    if (order.shipment.status !== 'awaiting_connection') fault('คำขอจัดส่งนี้ไม่อยู่ในสถานะที่แก้ไขได้', 409);
    const existing = Object.fromEntries(Object.keys(fields).map(key => [key, order.shipment[key]]));
    if (JSON.stringify(existing) !== JSON.stringify(fields)) fault('มีคำขอจัดส่งของออเดอร์นี้แล้ว หากต้องการเปลี่ยนข้อมูล ให้ยกเลิกคำขอเดิมก่อน', 409);
    return response(order.shipment);
  }
  const shipment = {id: 'SHIP-' + randomUUID(), ...fields, status: 'awaiting_connection', createdAt: clock(now).toISOString(), createdBy: actor.name};
  order.shipment = shipment;
  audit(data, order, actor, 'เตรียมคำขอจัดส่ง ' + shipment.id + ' รอเชื่อม API ' + shipment.provider + ' ยังไม่ได้เรียกรถ', now);
  return response(shipment);
}

export function cancelShipmentRequest(data, input, actor, {now = Date.now()} = {}) {
  const order = actorAndOrder(data, input, actor, ['action', 'id', 'requestId']);
  const shipment = order.shipment;
  if (!shipment) fault('ยังไม่มีคำขอจัดส่งของออเดอร์นี้', 409);
  if (shipment.status === 'cancelled') return {message: 'ยกเลิกข้อมูลเตรียมจัดส่งแล้ว', shipmentId: shipment.id, status: 'cancelled'};
  if (shipment.status !== 'awaiting_connection') fault('คำขอจัดส่งนี้ไม่อยู่ในสถานะที่ยกเลิกได้', 409);
  const date = clock(now);
  Object.assign(shipment, {status: 'cancelled', cancelledAt: date.toISOString(), cancelledBy: actor.name});
  audit(data, order, actor, 'ยกเลิกข้อมูลเตรียมจัดส่ง ' + shipment.id + ' ไม่มีการยกเลิกกับขนส่งจริง', now);
  return {message: 'ยกเลิกข้อมูลเตรียมจัดส่งแล้ว ไม่มีการยกเลิกกับขนส่งจริง', shipmentId: shipment.id, status: 'cancelled'};
}

// Projection treats saved data as untrusted. In particular, never forward a
// future provider response or token because it happens to live on the draft.
export function projectShipment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['id', 'status', 'provider', 'carrier', 'channel', 'connectionRequired', 'sourceOrderExternal', 'method', 'pickupDate', 'pickupTimeFrom', 'pickupTimeTo', 'notes', 'createdAt', 'createdBy', 'cancelledAt', 'cancelledBy', 'cancellationReason']) {
    if (typeof value[key] === 'string') out[key] = value[key];
  }
  for (const key of ['sender', 'recipient']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) continue;
    out[key] = {};
    for (const field of ['name', 'phone', 'addressLine', 'subdistrict', 'district', 'province', 'postalCode']) if (typeof value[key][field] === 'string') out[key][field] = value[key][field];
  }
  if (value.package && typeof value.package === 'object' && !Array.isArray(value.package)) {
    out.package = {};
    for (const key of ['weightGrams', 'lengthCm', 'widthCm', 'heightCm']) if (typeof value.package[key] === 'number' && Number.isFinite(value.package[key])) out.package[key] = value.package[key];
  }
  if (Array.isArray(value.items)) out.items = value.items.filter(item => item && typeof item.sku === 'string' && Number.isInteger(item.qty) && item.qty > 0).map(item => ({sku: item.sku, qty: item.qty}));
  if (CHANNELS.has(out.channel)) out.readiness = shippingReadiness(out.channel, out.carrier ?? '');
  return out;
}

// Closing the parent order makes its internal preparation ineligible for any
// future worker. This is not a cancellation sent to an external provider.
export function closePendingShipment(order, reason, {now = Date.now()} = {}) {
  if (!order?.shipment || order.shipment.status !== 'awaiting_connection') return false;
  const cancellationReason = scalarText(reason, 'เหตุผลปิดคำขอจัดส่ง', 160);
  const date = clock(now);
  Object.assign(order.shipment, {status: 'cancelled', cancelledAt: date.toISOString(), cancelledBy: 'system', cancellationReason});
  return true;
}
