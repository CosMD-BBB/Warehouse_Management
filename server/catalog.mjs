import {randomBytes} from 'node:crypto';
import {barcodeIndex,barcodeText} from './barcodes.mjs';

// Marketplace listings identify a variant in one shop. Their stock is a mirror
// of a central product, never another quantity to add to the physical stock.
export const CATALOG_CHANNELS=Object.freeze(['Shopee','Lazada','TikTok Shop']);
export const MAX_PRODUCTS=1000,MAX_PRODUCT_MAPPINGS=5000;
const MAX_STOCK=1000000000,MAX_MONEY=1000000;
const MAPPING_STRINGS=['id','channel','shopId','productId','variantId','sellerSku','name','centralSku','createdAt','updatedAt'];
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
function admin(actor){if(actor?.role!=='admin')fail('เฉพาะ Admin สามารถจัดการสินค้ากลางและการผูกสินค้าได้',403)}
function fields(input,allowed){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('ข้อมูลสินค้าไม่ถูกต้อง');
  const keys=new Set(['action','requestId',...allowed]);
  if(Object.keys(input).some(key=>!keys.has(key)))fail('มีข้อมูลที่ไม่รองรับในคำขอสินค้า');
}
function string(value,label,max,{required=false,defaultValue=''}={}){
  if(value===undefined)value=defaultValue;
  if(typeof value!=='string')fail(label+'ต้องเป็นข้อความ');
  if(/[\p{Cc}\p{Cf}]/u.test(value))fail('กรุณาระบุ'+label+'ให้ถูกต้อง');
  const result=value.trim();
  if(required&&!result||result.length>max)fail('กรุณาระบุ'+label+'ให้ถูกต้อง');
  return result;
}
function quantity(value,label,max=MAX_STOCK,minimum=0){
  if(!Number.isSafeInteger(value)||value<minimum||value>max)fail(label+'ต้องเป็นจำนวนเต็ม '+minimum+'–'+max);
  return value;
}
function money(value,label){
  if(value===undefined||value==='')return 0;
  if(typeof value!=='number'&&typeof value!=='string')fail(label+'ไม่ถูกต้อง');
  if(typeof value==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))fail(label+'ต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง');
  const result=typeof value==='string'?Number(value.trim()):value;
  if(!Number.isFinite(result)||result<0||result>MAX_MONEY||Math.round(result*100)/100!==result)fail(label+'ต้องเป็นจำนวน 0–1,000,000 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
  return Math.round(result*100)/100;
}
function productList(data){if(!Array.isArray(data?.products))fail('ข้อมูลคลังสินค้าไม่ถูกต้อง',409);return data.products}
function mappingList(data){
  if(data?.productMappings===undefined)return [];
  if(!Array.isArray(data.productMappings))fail('ข้อมูลการผูกสินค้าไม่ถูกต้อง',409);
  return data.productMappings;
}
function mappingId(value){
  if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))fail('รหัสการผูกสินค้าไม่ถูกต้อง');
  return value;
}
function version(value){return quantity(value,'เวอร์ชันการผูกสินค้า',Number.MAX_SAFE_INTEGER,1)}
function identity(input){
  if(!CATALOG_CHANNELS.includes(input?.channel))fail('เลือกช่องทาง Shopee, Lazada หรือ TikTok Shop');
  return {channel:input.channel,shopId:string(input.shopId,'รหัสร้านบนแพลตฟอร์ม',128,{required:true}),productId:string(input.productId,'รหัสสินค้าบนแพลตฟอร์ม',128,{required:true}),variantId:string(input.variantId,'รหัสตัวเลือกสินค้า',128)};
}
function identityKey(value){return JSON.stringify([value.channel,value.shopId,value.productId,value.variantId||''])}

export function createProduct(data,input,actor){
  admin(actor);fields(input,['sku','name','sub','location','min','price','cost','stock','barcode','barcodes']);
  const products=productList(data);
  if(products.length>=MAX_PRODUCTS)fail('เพิ่มสินค้ากลางได้ไม่เกิน '+MAX_PRODUCTS+' รายการ',409);
  const sku=string(input.sku,'SKU',64,{required:true}).toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku))fail('SKU ใช้อักษร A–Z ตัวเลข จุด ขีดกลาง หรือขีดล่าง และขึ้นต้นด้วยอักษรหรือตัวเลข');
  if(products.some(product=>product.sku===sku))fail('SKU นี้มีอยู่ในคลังแล้ว',409);
  const product={sku,name:string(input.name,'ชื่อสินค้า',160,{required:true}),sub:string(input.sub,'รายละเอียดสินค้า',300),location:string(input.location,'ตำแหน่งเก็บ',80),min:quantity(input.min===undefined?0:input.min,'จุดสั่งซื้อใหม่'),price:money(input.price,'ราคาขาย'),cost:money(input.cost,'ต้นทุน'),stock:quantity(input.stock===undefined?0:input.stock,'จำนวนคงคลัง'),barcode:barcodeText(input.barcode===undefined?'':input.barcode,{allowEmpty:true}),barcodes:[]};
  const aliases=input.barcodes===undefined?[]:input.barcodes;
  if(!Array.isArray(aliases)||aliases.length>20)fail('กำหนดบาร์โค้ดสำรองได้ไม่เกิน 20 รหัส');
  product.barcodes=aliases.map(code=>barcodeText(code));
  const ownCodes=[sku,...(product.barcode?[product.barcode]:[]),...product.barcodes];
  if(new Set(ownCodes).size!==ownCodes.length)fail('บาร์โค้ดหลัก บาร์โค้ดสำรอง และ SKU ต้องไม่ซ้ำกัน',409);
  // Validate every code and field before touching persisted state.
  barcodeIndex([...products,product]);products.push(product);
  return {message:'เพิ่มสินค้ากลาง '+sku+' แล้ว',sku};
}

export function linkChannelProduct(data,input,actor){
  admin(actor);fields(input,['mappingId','expectedVersion','channel','shopId','productId','variantId','sellerSku','name','centralSku']);
  const mappings=mappingList(data),external=identity(input),centralSku=string(input.centralSku,'SKU กลาง',64,{required:true});
  if(!productList(data).some(product=>product.sku===centralSku))fail('ไม่พบ SKU กลางในคลังของร้านนี้',404);
  let existing=null;
  if(input.mappingId!==undefined){
    const id=mappingId(input.mappingId);existing=mappings.find(mapping=>mapping.id===id);
    if(!existing)fail('ไม่พบการผูกสินค้าในร้านนี้',404);
    if(version(input.expectedVersion)!==existing.version)fail('การผูกสินค้านี้ถูกแก้ไขแล้ว กรุณาโหลดข้อมูลล่าสุด',409);
    if(existing.version===Number.MAX_SAFE_INTEGER)fail('เวอร์ชันการผูกสินค้าเกินขอบเขต',409);
  }else{
    if(input.expectedVersion!==undefined)fail('ระบุเวอร์ชันได้เฉพาะตอนแก้ไขการผูกสินค้า');
    if(mappings.length>=MAX_PRODUCT_MAPPINGS)fail('ผูกสินค้าได้ไม่เกิน '+MAX_PRODUCT_MAPPINGS+' รายการ',409);
  }
  if(mappings.some(mapping=>mapping!==existing&&identityKey(mapping)===identityKey(external)))fail('สินค้าหรือตัวเลือกนี้ของร้านบนแพลตฟอร์มถูกผูกไว้แล้ว',409);
  const now=new Date().toISOString();
  const next={id:existing?.id||randomBytes(16).toString('hex'),...external,sellerSku:string(input.sellerSku,'SKU บนแพลตฟอร์ม',128),name:string(input.name,'ชื่อสินค้าบนแพลตฟอร์ม',200),centralSku,version:existing?existing.version+1:1,createdAt:existing?.createdAt||now,updatedAt:now};
  if(existing)mappings[mappings.indexOf(existing)]=next;
  else{if(data.productMappings===undefined)data.productMappings=[];data.productMappings.push(next)}
  return {message:'ผูก '+external.channel+' กับสินค้ากลาง '+centralSku+' แล้ว',mappingId:next.id,version:next.version};
}

export function unlinkChannelProduct(data,input,actor){
  admin(actor);fields(input,['mappingId','expectedVersion']);
  const mappings=mappingList(data),id=mappingId(input.mappingId),existing=mappings.find(mapping=>mapping.id===id);
  if(!existing)fail('ไม่พบการผูกสินค้าในร้านนี้',404);
  if(version(input.expectedVersion)!==existing.version)fail('การผูกสินค้านี้ถูกแก้ไขแล้ว กรุณาโหลดข้อมูลล่าสุด',409);
  mappings.splice(mappings.indexOf(existing),1);
  return {message:'ยกเลิกการผูกสินค้าแล้ว ออเดอร์เดิมและสต๊อกกลางยังคงไว้',mappingId:id};
}

export function resolveChannelProduct(data,input){
  const external=identity(input),matches=mappingList(data).filter(mapping=>identityKey(mapping)===identityKey(external));
  if(matches.length!==1)fail(matches.length?'การผูกสินค้าในร้านนี้ซ้ำ กรุณาให้ Admin ตรวจสอบ':'สินค้าช่องทางนี้ยังไม่ได้ผูกกับ SKU กลาง กรุณาตรวจสอบก่อนรับออเดอร์',409);
  const mapping=matches[0],product=productList(data).find(product=>product.sku===mapping.centralSku);
  if(!product)fail('SKU กลางของการผูกสินค้านี้ไม่อยู่ในคลัง กรุณาให้ Admin ตรวจสอบ',409);
  return {mapping,product};
}

export function resolveChannelItems(data,input){
  if(!Array.isArray(input?.items)||input.items.length<1||input.items.length>50)fail('รายการสินค้าช่องทางต้องมี 1–50 รายการ');
  const resolved=new Map();
  for(const item of input.items){
    if(!item||typeof item!=='object'||Array.isArray(item))fail('รายการสินค้าช่องทางไม่ถูกต้อง');
    const qty=quantity(item.qty,'จำนวนสินค้า',100,1),{product}=resolveChannelProduct(data,{channel:input.channel,shopId:input.shopId,productId:item.productId,variantId:item.variantId});
    const existing=resolved.get(product.sku);
    if(existing)existing.qty+=qty;
    else resolved.set(product.sku,{sku:product.sku,qty,price:product.price,cost:product.cost});
  }
  // Resolving the complete batch has no side effects. Reservation happens later
  // as one store transaction, with combined demand for repeated central SKUs.
  return [...resolved.values()];
}

export function mappedOrderItems(data,input,actor){
  admin(actor);fields(input,['mappingId','qty']);
  const id=mappingId(input.mappingId),mapping=mappingList(data).find(mapping=>mapping.id===id);
  if(!mapping)fail('ไม่พบการผูกสินค้าในร้านนี้',404);
  const qty=quantity(input.qty,'จำนวนสินค้า',100,1);
  const items=resolveChannelItems(data,{channel:mapping.channel,shopId:mapping.shopId,items:[{productId:mapping.productId,variantId:mapping.variantId,qty}]});
  return {mapping,items};
}

export function projectProductMappings(mappings){
  if(!Array.isArray(mappings))return [];
  return mappings.filter(mapping=>mapping&&typeof mapping==='object').map(mapping=>{
    const out=Object.fromEntries(MAPPING_STRINGS.map(field=>[field,typeof mapping[field]==='string'?mapping[field]:'']));
    out.version=Number.isSafeInteger(mapping.version)&&mapping.version>0?mapping.version:0;
    return out;
  });
}
