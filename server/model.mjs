import fs from 'node:fs';
import {createShipmentRequest,cancelShipmentRequest,projectShipment,closePendingShipment} from './shipping.mjs';
import {barcodeUpdate,resolveBarcode} from './barcodes.mjs';
export const ROLES={
  admin:{label:'Admin',views:['overview','orders','fulfillment','inventory','reports','connections','blueprint','users','store'],actions:['reserve','start-pack','scan','complete-pack','dispatch','cancel','resolve','create-order','update-order','stock-receive','set-barcode','request-shipment','cancel-shipment','simulate-order','retry-stock','fail-stock']},
  warehouse:{label:'Warehouse',views:['orders','fulfillment','inventory'],actions:['reserve','start-pack','scan','complete-pack','dispatch','stock-receive','request-shipment','cancel-shipment','retry-stock']},
  finance:{label:'Finance',views:['overview','orders','reports'],actions:[]}
};
export const STOCK_CHANNELS=['Shopee','Lazada','TikTok Shop'];
export const sum=(a,fn)=>a.reduce((s,x)=>s+fn(x),0);
export function reserved(data,sku){return sum(data.orders.filter(o=>o.reserved),o=>sum(o.items.filter(l=>l.sku===sku),l=>l.qty))}
export function available(data,sku){return data.products.find(p=>p.sku===sku).stock-reserved(data,sku)}
export const balance=data=>Object.fromEntries(data.products.map(p=>[p.sku,available(data,p.sku)]));
export function createSeed(){const d=JSON.parse(fs.readFileSync(new URL('./seed.json',import.meta.url),'utf8'));const qty=balance(d);d.lastStock={...qty};d.publishedStock=Object.fromEntries(STOCK_CHANNELS.map(ch=>[ch,{qty:{...qty},revision:1,state:'สาธิต: ส่งค่าแล้ว'}]));return d}
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const nextDay=()=>{const d=new Date(today()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10)};
const stamp=()=>new Date().toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',second:'2-digit'});
export function fault(message,status=400){throw Object.assign(new Error(message),{status})}
function integer(v,min,max){if(!Number.isInteger(v)||v<min||v>max)fault('จำนวนสินค้าไม่ถูกต้อง');return v}
function text(value,label,max,required=false){const v=String(value??'').trim();if(required&&!v||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))fault('กรุณาระบุ'+label+'ให้ถูกต้อง');return v}
const latinDigits=value=>String(value??'').replace(/[๐-๙]/g,c=>String(c.charCodeAt(0)-0x0e50));
function moneyCents(value,label,max=100000000){if(value!==undefined&&typeof value!=='number'&&typeof value!=='string')fault(label+'ไม่ถูกต้อง');const v=value===undefined||value===''?0:Number(value);if(!Number.isFinite(v)||v<0||v>max||Math.abs(v*100-Math.round(v*100))>0.00001)fault(label+'ไม่ถูกต้อง');return Math.round(v*100)}
function address(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fault('กรุณากรอก'+label+'ให้ครบ');
  const out={addressLine:text(value.addressLine,'ที่อยู่',300,true),subdistrict:text(value.subdistrict,'แขวง / ตำบล',80,true),district:text(value.district,'เขต / อำเภอ',80,true),province:text(value.province,'จังหวัด',80,true),postalCode:latinDigits(value.postalCode).trim()};
  if(!/^\d{5}$/.test(out.postalCode))fault('รหัสไปรษณีย์ต้องมี 5 หลัก');return out;
}
function datetime(value,fallback=new Date()){
  if(!value)return fallback;
  const raw=String(value);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(raw))fault('วันที่และเวลาไม่ถูกต้อง');
  const y=Number(raw.slice(0,4)),m=Number(raw.slice(5,7)),d=Number(raw.slice(8,10)),check=new Date(Date.UTC(y,m-1,d));
  if(y<2000||y>2100||check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d||Number(raw.slice(11,13))>23||Number(raw.slice(14,16))>59||raw[16]===':'&&Number(raw.slice(17,19))>59)fault('วันที่และเวลาไม่ถูกต้อง');
  const date=new Date(/[Z]|[+-]\d{2}:\d{2}$/.test(raw)?raw:raw+'+07:00');
  if(!Number.isFinite(date.getTime()))fault('วันที่และเวลาไม่ถูกต้อง');return date;
}
function orderInput(data,input,actor,existing=null){
  const channel=input.channel,marketplace=existing&&STOCK_CHANNELS.includes(existing.channel);
  if(marketplace){if(channel!==existing.channel)fault('เปลี่ยนช่องทางของออเดอร์ Marketplace ไม่ได้')}
  else if(!['Facebook','LINE OA','Offline sales','Review'].includes(channel))fault('ช่องทางไม่ถูกต้อง');
  const review=channel==='Review',customer=text(input.customer,'ชื่อผู้รับ',80,true),phone=latinDigits(input.phone).replace(/[\s()\-]/g,'');
  if(!/^\+?\d{9,15}$/.test(phone))fault('กรุณาระบุเบอร์โทร 9–15 หลัก');
  const shippingAddress=address(input.shippingAddress,'ที่อยู่จัดส่ง');
  if(input.billingSame!==undefined&&typeof input.billingSame!=='boolean')fault('การเลือกที่อยู่ออกบิลไม่ถูกต้อง');
  const billingSame=input.billingSame!==false,billingAddress=billingSame?null:address(input.billingAddress,'ที่อยู่ออกบิล');
  const email=text(input.email,'อีเมล',120);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fault('อีเมลไม่ถูกต้อง');
  const socialName=text(input.socialName,'ชื่อ Social',100),socialUrl=text(input.socialUrl,'ลิงก์ Social',500);
  if(socialUrl){let url;try{url=new URL(socialUrl)}catch{fault('ลิงก์ Social ไม่ถูกต้อง')}if(url.protocol!=='https:')fault('ลิงก์ Social ต้องขึ้นต้นด้วย https://')}
  const incoming=input.items??(input.sku?[{sku:input.sku,qty:input.qty}]:[]);
  if(!Array.isArray(incoming)||incoming.length<1||incoming.length>50)fault('เลือกสินค้าอย่างน้อย 1 รายการ และไม่เกิน 50 รายการ');
  const seen=new Set();let subtotal=0,lineDiscount=0;
  const items=incoming.map(l=>{
    if(!l||typeof l!=='object')fault('รายการสินค้าไม่ถูกต้อง');
    const p=data.products.find(p=>p.sku===l.sku);if(!p)fault('ไม่พบ SKU');if(seen.has(p.sku))fault('สินค้าซ้ำ กรุณารวมจำนวนในรายการเดียว');seen.add(p.sku);
    const qty=integer(l.qty,1,100),price=review?0:moneyCents(l.price===undefined?p.price:l.price,'ราคาสินค้า',1000000),discount=review?0:moneyCents(l.discount,'ส่วนลดสินค้า');
    if(discount>price*qty)fault('ส่วนลดสินค้าต้องไม่เกินมูลค่ารายการ');subtotal+=price*qty;lineDiscount+=discount;
    return {sku:p.sku,qty,price:price/100,cost:p.cost,discount:discount/100};
  });
  const discount=review?0:moneyCents(input.discount,'ส่วนลดท้ายบิล'),shippingFee=review?0:moneyCents(input.shippingFee,'ค่าจัดส่ง',1000000),itemNetTotal=subtotal-lineDiscount;
  if(discount>itemNetTotal)fault('ส่วนลดท้ายบิลต้องไม่เกินมูลค่าสินค้าหลังส่วนลด');
  const grandTotal=itemNetTotal-discount+shippingFee,p=input.payment||{};
  if(typeof p!=='object'||Array.isArray(p))fault('ข้อมูลการชำระเงินไม่ถูกต้อง');
  const method=review?'free':p.method||'unpaid',status=review?'confirmed':p.status||'pending';
  if(!['transfer','cod','unpaid','free'].includes(method)||!['pending','confirmed'].includes(status)||!review&&method==='free')fault('วิธีหรือสถานะชำระเงินไม่ถูกต้อง');
  const amount=review?0:moneyCents(p.amount,'ยอดชำระ');if(amount>grandTotal)fault('ยอดชำระต้องไม่เกินยอดรวม');
  if(method==='unpaid'&&(amount||status!=='pending'))fault('ยังไม่ระบุการชำระเงินต้องเป็นสถานะรอตรวจสอบ');
  const payment={method,status,amount:amount/100,paidAt:p.paidAt?datetime(p.paidAt).toISOString():'',bankName:text(p.bankName,'ธนาคาร / บัญชีรับเงิน',100),reference:text(p.reference,'เลขอ้างอิงชำระเงิน',120),verificationSource:'manual'};
  if(status==='confirmed'){payment.confirmedBy=actor.name;payment.confirmedAt=new Date().toISOString()}
  const created=datetime(input.createdAt),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(created),time=created.toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'});
  return {version:2,channel,customer,phone,email,socialName,socialUrl,shippingAddress,billingSame,billingAddress,province:shippingAddress.province,items,subtotal:subtotal/100,lineDiscount:lineDiscount/100,itemNetTotal:itemNetTotal/100,discount:discount/100,shippingFee:shippingFee/100,grandTotal:grandTotal/100,payment,carrier:text(input.carrier||'Flash Express','ขนส่ง',60,true),notes:text(input.notes,'หมายเหตุ',1000),tags:text(input.tags,'แท็ก',200),createdAt:created.toISOString(),date,time};
}
function demands(items){const out=new Map();for(const l of items)out.set(l.sku,(out.get(l.sku)||0)+l.qty);return out}
function canReserve(data,items){return [...demands(items)].every(([sku,qty])=>data.products.some(p=>p.sku===sku)&&available(data,sku)>=qty)}
function publish(data,reason){const qty=balance(data);if(JSON.stringify(qty)===JSON.stringify(data.lastStock))return;data.stockRevision++;data.lastStock={...qty};for(const ch of STOCK_CHANNELS){const p=data.publishedStock[ch];if(ch===data.blockedChannel)p.state='สาธิต: รอลองใหม่';else Object.assign(p,{qty:{...qty},revision:data.stockRevision,state:'สาธิต: ส่งค่าแล้ว'});data.stockEvents.unshift({channel:ch,revision:data.stockRevision,reason,status:p.state,time:stamp()})}data.stockEvents=data.stockEvents.slice(0,500)}
function event(data,o,message,actor){data.audit.unshift({orderId:o?.id||'STOCK',time:stamp(),at:new Date().toISOString(),text:message,actor:actor.name});data.audit=data.audit.slice(0,2000);publish(data,message)}
function reserve(data,o,actor){if(o.status!=='new')fault('ออเดอร์นี้ไม่ได้อยู่สถานะเข้าใหม่');if(!canReserve(data,o.items)){o.status='hold';o.holdReason='สินค้าไม่พอ';event(data,o,'พักออเดอร์: สินค้าไม่เพียงพอ',actor);return 'สินค้าไม่พอ ออเดอร์อยู่ในรายการที่ต้องตรวจสอบ'}o.reserved=true;o.status='ready';event(data,o,'กันสต๊อกและเข้าคิวหยิบ',actor);return 'กันสต๊อกแล้ว'}
export function perform(data,action,input,actor){
  let o=input.id?data.orders.find(o=>o.id===input.id):null;
  if(['reserve','start-pack','scan','complete-pack','dispatch','cancel','resolve','update-order'].includes(action)&&!o)fault('ไม่พบออเดอร์',404);
  switch(action){
    case 'request-shipment':return createShipmentRequest(data,input,actor);
    case 'cancel-shipment':return cancelShipmentRequest(data,input,actor);
    case 'reserve':return reserve(data,o,actor);
    case 'start-pack':if(o.status!=='ready'||!o.reserved)fault('ต้องเป็นออเดอร์ที่กันสต๊อกและรอหยิบ');o.status='packing';o.scanned={};event(data,o,'เริ่มหยิบและแพ็ก',actor);break;
    case 'scan':{
      if(o.status!=='packing')fault('กรุณาเริ่มแพ็กก่อน');
      const product=resolveBarcode(data.products,input.code!==undefined?input.code:input.sku),sku=product.sku;
      if(input.code!==undefined&&input.sku!==undefined&&input.sku!==sku)fault('บาร์โค้ดไม่ตรงกับ SKU ที่ระบุ');
      const qty=demands(o.items).get(sku);if(!qty)fault('สินค้าที่สแกนไม่อยู่ในออเดอร์');
      const count=o.scanned?.[sku]||0;if(count>=qty)fault('สินค้ารายการนี้ครบแล้ว');
      o.scanned??={};o.scanned[sku]=count+1;event(data,o,'ตรวจสินค้า '+sku+' '+o.scanned[sku]+'/'+qty,actor);
      return {message:'ตรวจสินค้า '+sku+' '+o.scanned[sku]+'/'+qty,orderId:o.id,sku,scanned:o.scanned[sku],required:qty};
    }
    case 'complete-pack':if(o.status!=='packing'||![...demands(o.items)].every(([sku,qty])=>(o.scanned[sku]||0)===qty))fault('กรุณาตรวจสินค้าให้ครบก่อนปิดกล่อง');o.status='packed';event(data,o,'ตรวจครบและปิดกล่อง',actor);break;
    case 'dispatch':{
      if(o.status!=='packed'||!o.reserved)fault('ต้องแพ็กสินค้าให้ครบก่อนส่ง');
      const qty=demands(o.items);if([...qty].some(([sku,n])=>!data.products.some(p=>p.sku===sku&&p.stock>=n)))fault('สินค้าคงคลังไม่พอ');
      for(const [sku,n]of qty)data.products.find(p=>p.sku===sku).stock-=n;
      closePendingShipment(o,'ปิดคำขอเตรียมขนส่งหลังจำลองส่งมอบ');
      o.reserved=false;o.status='shipped';o.tracking='DEMO'+o.id.replace(/[^A-Z0-9]/g,'')+'TH';event(data,o,'จำลองส่งมอบขนส่งและตัดคงคลัง',actor);break;
    }
    case 'cancel':if(!['new','ready','packing','packed','hold'].includes(o.status))fault('ออเดอร์ส่งแล้วต้องใช้กระบวนการคืนสินค้า');closePendingShipment(o,'ยกเลิกออเดอร์');o.status='cancelled';o.reserved=false;o.scanned={};event(data,o,'ยกเลิกและปล่อยยอดกันสต๊อก',actor);break;
    case 'resolve':if(o.status!=='hold'||input.confirmed!==true)fault('กรุณายืนยันการตรวจข้อมูลก่อน');o.status='new';o.holdReason='';return reserve(data,o,actor);
    case 'stock-receive':{const p=data.products.find(p=>p.sku===input.sku);if(!p)fault('ไม่พบสินค้า');p.stock+=integer(input.qty,1,10000);event(data,null,'รับสินค้าเข้า '+p.sku+' '+input.qty+' ชิ้น',actor);break}
    case 'set-barcode':{
      const {product,barcode,barcodes}=barcodeUpdate(data.products,input.sku,input);
      Object.assign(product,{barcode,barcodes});event(data,null,'บันทึกบาร์โค้ดสินค้า '+product.sku,actor);break;
    }
    case 'create-order':{
      const fields=orderInput(data,input,actor);o={id:'OH-'+(actor.store_code||'main').toUpperCase()+'-M'+Date.now().toString(36).toUpperCase()+data.orders.length,external:'MANUAL-'+data.orders.length,...fields,refund:0,status:'new',reserved:false,tracking:'',deadline:nextDay(),scanned:{},createdVia:'เปิดโดย '+actor.name};
      data.orders.push(o);event(data,o,'เปิดออเดอร์กลางสาธิตพร้อมข้อมูลจัดส่ง',actor);if(o.channel==='Review')reserve(data,o,actor);
      return {message:'สร้าง '+o.id+' แล้ว',orderId:o.id,status:o.status};
    }
    case 'update-order':{
      if(!['new','hold','ready'].includes(o.status))fault('แก้ไขออเดอร์ได้ก่อนเริ่มแพ็กเท่านั้น',409);
      const fields=orderInput(data,input,actor,o),wasReserved=o.reserved,oldStatus=o.status;
      Object.assign(o,fields,{reserved:false,scanned:{}});
      if(wasReserved){if(!canReserve(data,o.items))fault('สต๊อกไม่พอสำหรับรายการใหม่ ออเดอร์เดิมยังคงไว้',409);o.reserved=true;o.status='ready'}
      else if(o.channel==='Review'){o.status='new';reserve(data,o,actor)}
      else o.status=oldStatus;
      event(data,o,'แก้ไขข้อมูลออเดอร์ก่อนแพ็ก',actor);return {message:'บันทึก '+o.id+' แล้ว',orderId:o.id,status:o.status};
    }
    case 'simulate-order':{
      const sampleId='OH-'+(actor.store_code||'main').toUpperCase()+'-SYNC-001';data.syncCount++;
      if(data.orders.some(o=>o.id===sampleId||o.external==='SHOPEE-DEMO-001'))return 'ข้ามเหตุการณ์ซ้ำ จำนวนและสต๊อกไม่เปลี่ยน';
      const p=data.products[0];if(!p)fault('กรุณาเพิ่มสินค้าก่อนทดลองรับออเดอร์');
      o={id:sampleId,external:'SHOPEE-DEMO-001',channel:'Shopee',date:today(),time:stamp().slice(0,5),customer:'ลูกค้าจากเหตุการณ์จำลอง',province:'กรุงเทพมหานคร',items:[{sku:p.sku,qty:1,price:p.price,cost:p.cost}],discount:0,refund:0,status:'new',reserved:false,carrier:'Flash Express',tracking:'',deadline:nextDay(),scanned:{},createdVia:'เหตุการณ์สาธิต'};data.orders.push(o);return reserve(data,o,actor);
    }
    case 'fail-stock':data.blockedChannel='Lazada';return 'จำลอง Lazada ไม่พร้อมรับ ลองเปลี่ยนยอดสต๊อก';
    case 'retry-stock':data.blockedChannel='';for(const ch of STOCK_CHANNELS)Object.assign(data.publishedStock[ch],{qty:balance(data),revision:data.stockRevision,state:'สาธิต: ส่งค่าแล้ว'});data.stockEvents.unshift({channel:'ทุกช่องทาง',revision:data.stockRevision,reason:'ส่งยอดปัจจุบันล่าสุดอีกครั้ง',status:'สาธิต: ส่งค่าแล้ว',time:stamp()});break;
    default:fault('ไม่รู้จักคำสั่ง',400);
  }
  return 'บันทึกการเปลี่ยนแปลงแล้ว';
}
export function projectData(data,role){
  const out=structuredClone(data);delete out.lastStock;
  for(const order of out.orders)if(order.shipment)order.shipment=projectShipment(order.shipment);
  if(role==='warehouse'){
    for(const p of out.products){delete p.price;delete p.cost}
    for(const o of out.orders){for(const k of ['discount','refund','subtotal','lineDiscount','itemNetTotal','shippingFee','grandTotal','payment'])delete o[k];for(const l of o.items){delete l.price;delete l.cost;delete l.discount}}
    delete out.payouts;delete out.expenses;
  }
  if(role==='finance')out.audit=out.audit.slice(0,200);
  return out;
}
