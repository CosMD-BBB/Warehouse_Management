// Scanner input is text. Never coerce to numbers: GTIN/EAN codes can start with 0.
const MAX_CODE_LENGTH=128,MAX_ALIASES=20;
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
export function barcodeText(value,{allowEmpty=false}={}){
  if(typeof value!=='string'||value.length>MAX_CODE_LENGTH||/[\s\p{Cc}\p{Cf}]/u.test(value)||!allowEmpty&&!value.length)fail('บาร์โค้ดต้องเป็นข้อความ 1–128 ตัวอักษร ไม่มีช่องว่างหรืออักขระควบคุม');
  return value;
}
function productCodes(product){
  if(typeof product.sku!=='string'||!product.sku.length)fail('SKU ในคลังไม่ถูกต้อง กรุณาให้ Admin ตรวจสอบ',409);
  const codes=[product.sku];
  if(product.barcode!==undefined&&product.barcode!=='')codes.push(barcodeText(product.barcode));
  if(product.barcodes!==undefined){
    if(!Array.isArray(product.barcodes)||product.barcodes.length>MAX_ALIASES)fail('กำหนดบาร์โค้ดสำรองได้ไม่เกิน 20 รหัส');
    codes.push(...product.barcodes.map(code=>barcodeText(code)));
  }
  return codes;
}
export function barcodeIndex(products){
  const index=new Map();
  for(const product of products){
    for(const code of productCodes(product)){
      const existing=index.get(code);
      if(existing&&existing!==product)fail('บาร์โค้ดหรือ SKU ซ้ำกับสินค้าอื่น กรุณาให้ Admin แก้ไขก่อนสแกน',409);
      index.set(code,product);
    }
  }
  return index;
}
export function resolveBarcode(products,code){
  const product=barcodeIndex(products).get(barcodeText(code));
  if(!product)fail('ไม่พบบาร์โค้ดหรือ SKU นี้ในคลังของร้าน');
  return product;
}
export function barcodeUpdate(products,sku,input){
  const product=products.find(product=>product.sku===sku);
  if(!product)fail('ไม่พบสินค้า',404);
  const barcode=barcodeText(input.barcode===undefined?'':input.barcode,{allowEmpty:true});
  const aliases=input.barcodes===undefined?[]:input.barcodes;
  if(!Array.isArray(aliases)||aliases.length>MAX_ALIASES)fail('กำหนดบาร์โค้ดสำรองได้ไม่เกิน 20 รหัส');
  const barcodes=aliases.map(code=>barcodeText(code));
  const ownCodes=[product.sku,...(barcode?[barcode]:[]),...barcodes];
  if(new Set(ownCodes).size!==ownCodes.length)fail('บาร์โค้ดหลัก บาร์โค้ดสำรอง และ SKU ต้องไม่ซ้ำกัน',409);
  const next={...product,barcode,barcodes};
  // Validate the complete proposed catalog before modifying persisted state.
  barcodeIndex(products.map(item=>item===product?next:item));
  return {product,barcode,barcodes};
}
