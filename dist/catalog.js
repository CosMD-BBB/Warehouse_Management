'use strict';

// Products in this catalog are the tenant's single stock pool. Marketplace rows
// describe explicit listing identities; their quantities are simulated mirrors.
(() => {
  const channels = ['Shopee','Lazada','TikTok Shop'];
  let mappings = [],mappingSession = '',retrySession = '';
  const unresolved = new Map();
  const sessionKey = () => currentAuth && currentStore ? `${sessionEpoch}:${currentStore.id}:${currentAuth.id}:${csrfToken}` : '';
  const adminAction = action => currentAuth?.role === 'admin' && canAction(action);
  const activeMappings = () => mappingSession === sessionKey() ? mappings : [];
  function syncRetrySession() {
    const context = sessionKey();
    if (retrySession !== context) { unresolved.clear(); retrySession = context; }
    return context;
  }
  const productFor = sku => PRODUCTS.find(product => product.sku === sku);
  const labels = {shopId:'รหัสร้านบนแพลตฟอร์ม',productId:'รหัสสินค้า (Product ID)',variantId:'รหัสตัวเลือก (Variant / Model / SKU ID)',sellerSku:'SKU ที่ผู้ขายตั้งบนแพลตฟอร์ม',name:'ชื่อรายการบนแพลตฟอร์ม'};

  const previousApi = api;
  api = async function(path,method='GET',body) {
    const context = syncRetrySession();
    const out = await previousApi(path,method,body);
    if (path === '/state' && context && context === sessionKey() && out.store?.id === currentStore?.id && out.user?.id === currentAuth?.id) {
      mappings = Array.isArray(out.data?.productMappings) ? out.data.productMappings : [];
      mappingSession = context;
    }
    return out;
  };
  const previousClearSession = clearSession;
  clearSession = function() { mappings = []; mappingSession = ''; unresolved.clear(); retrySession = ''; return previousClearSession(); };

  function mappingRow(mapping) {
    const product = productFor(mapping.centralSku);
    const snapshot = publishedStock[mapping.channel];
    const mirror = snapshot?.qty?.[mapping.centralSku];
    const known = product && Number.isInteger(mirror) && mirror >= 0;
    const stale = known && (snapshot.revision !== stockRevision || mirror !== available(mapping.centralSku));
    const edit = adminAction('link-channel-product') ? `<button type="button" class="text-btn" data-catalog-mapping="${esc(mapping.id)}">แก้ไขการผูก</button>` : '';
    const unlink = adminAction('unlink-channel-product') ? `<button type="button" class="text-btn catalog-unlink" data-catalog-unlink="${esc(mapping.id)}">ยกเลิกการผูก</button>` : '';
    const simulate = adminAction('simulate-mapped-order') ? `<button type="button" class="btn small" data-catalog-simulate="${esc(mapping.id)}">ทดสอบออเดอร์สาธิต</button>` : '';
    return `<tr data-catalog-mapping-row="${esc(mapping.id)}"><td><div class="product-line">${channelLogo(mapping.channel)}<strong>${esc(mapping.channel)}</strong></div><small>ร้าน ${esc(mapping.shopId)}</small></td><td class="catalog-identity"><strong>${esc(mapping.name || mapping.sellerSku || mapping.productId)}</strong><small>Product: ${esc(mapping.productId)}</small><small>ตัวเลือก: ${mapping.variantId ? esc(mapping.variantId) : 'สินค้าที่ไม่มีตัวเลือก'}</small><small>SKU ผู้ขาย: ${mapping.sellerSku ? esc(mapping.sellerSku) : 'ยังไม่ระบุ'}</small></td><td><strong>${esc(mapping.centralSku)}</strong><small>${esc(product?.name || 'ไม่พบสินค้ากลาง')}</small></td><td class="num"><strong>${product ? num(available(mapping.centralSku)) : '—'}</strong><small>อ้างอิงคลังกลาง</small></td><td class="num ${stale ? 'negative' : ''}"><strong>${known ? num(mirror) : '—'}</strong><small>${known ? `สาธิต · v${esc(snapshot.revision)}` : 'สาธิต · ยังไม่มีค่าจำลอง'}</small><small>${stale ? 'รอส่งยอดจำลองล่าสุด' : 'ยังไม่ส่งไปแพลตฟอร์มจริง'}</small></td><td><div class="catalog-row-actions">${edit}${unlink}${simulate}</div></td></tr>`;
  }

  function mappingPanel() {
    const rows = activeMappings();
    return `<section class="panel catalog-mapping-panel" id="catalog-mappings"><div class="panel-head"><div><h2>ผูกสินค้าช่องทางกับสินค้ากลาง</h2><p>เลือกสินค้าและตัวเลือกของแต่ละร้านให้ใช้ SKU กลางเดียวกัน</p></div>${adminAction('link-channel-product') ? '<button type="button" class="btn small" data-catalog-action="link-product">'+icon('link')+'ผูกสินค้าช่องทาง</button>' : ''}</div><div class="panel-body"><div class="catalog-channel-summary">${channels.map(channel => `<div>${channelLogo(channel)}<span>${esc(channel)}<small>ผูกแล้ว ${rows.filter(row => row.channel === channel).length} รายการ · ยังไม่เชื่อม API</small></span></div>`).join('')}</div><p class="section-sub">รายการสินค้าหลายช่องทางผูกกับ SKU กลางเดียวกันได้ เมื่อรับออเดอร์ ระบบใช้สินค้ากองเดียวกัน ไม่บวกยอดสต๊อกแต่ละช่องทางเข้าคลัง</p><div class="notice catalog-demo-notice">${icon('alert')}ยอดช่องทางด้านล่างเป็นผลจำลองเฉพาะรายการที่ผูกไว้ ยังไม่ได้อ่านสินค้าหรืออัปเดตสต๊อกบน Shopee, Lazada หรือ TikTok Shop จริง</div></div><div class="table-scroll"><table class="data-table catalog-mapping-table"><thead><tr><th>ช่องทาง / ร้าน</th><th>สินค้า / ตัวเลือกบนช่องทาง</th><th>ผูกกับ SKU กลาง</th><th class="num">พร้อมขายกลาง</th><th class="num">ยอดช่องทางสาธิต</th><th>จัดการ</th></tr></thead><tbody>${rows.map(mappingRow).join('') || '<tr><td colspan="6" class="empty">ยังไม่ได้ผูกสินค้า เพิ่มสินค้ากลางก่อน แล้วเลือก “ผูกสินค้าช่องทาง” เพื่อจับคู่แต่ละตัวเลือก</td></tr>'}</tbody></table></div><div class="panel-body catalog-mapping-footer"><details><summary>หา ID และเชื่อมสินค้ายังไง</summary><ol><li>สร้าง SKU กลางใน Order Hub เช่น SOAP-001 แล้วรับจำนวนสินค้าที่อยู่ในคลังจริง</li><li>ดูรหัสร้าน รหัสสินค้า และรหัสตัวเลือกจากข้อมูลสินค้าของแต่ละแพลตฟอร์ม ใช้ตัวเลือกให้ตรงกับสินค้าจริง</li><li>ผูกแต่ละรายการกับ SKU กลางที่ต้องการ ไม่จับคู่อัตโนมัติจากชื่อหรือ SKU ผู้ขายที่คล้ายกัน</li><li>เมื่อได้รับสิทธิ์ API แล้ว ผู้พัฒนาจะตรวจรหัสร้านและรายการสินค้า ก่อนรับออเดอร์และส่งยอดพร้อมขายจริง</li></ol><p class="form-help">ตอนนี้กรอก ID ด้วยตนเองเพื่อเตรียมการผูก หากยังไม่ทราบ ID สามารถสร้างสินค้ากลางก่อน แล้วมาผูกเมื่อได้ข้อมูลจากแพลตฟอร์ม</p>${currentAuth?.role === 'admin' ? '<button type="button" class="text-btn" data-catalog-action="connections">ดูขั้นตอนขอสิทธิ์ API</button>' : ''}</details><div class="actions catalog-sync-actions">${canAction('retry-stock') ? button('ส่งยอดล่าสุดใหม่ (สาธิต)','retry-stock','sync') : ''}${canAction('fail-stock') ? button(blockedChannel ? 'กำลังจำลอง Lazada ขัดข้อง' : 'จำลอง Lazada ซิงค์ไม่สำเร็จ','fail-stock','alert') : ''}</div></div></section>`;
  }

  views.inventory = function() {
    if (!currentAuth || !canView('inventory')) return '';
    const total = sum(PRODUCTS,product => product.stock),held = sum(PRODUCTS,product => reserved(product.sku));
    const low = PRODUCTS.filter(product => available(product.sku) < product.min);
    const financial = currentAuth.role === 'admin';
    return `<div class="catalog-intro">${icon('box')}<div><strong>สินค้าคงคลังกลางของร้าน ${esc(currentStore?.name || '')}</strong><p>สร้างสินค้าที่นี่ แล้วผูกสินค้า Shopee, Lazada และ TikTok Shop กับ SKU กลางเดียวกัน ทุกช่องทางใช้ยอดพร้อมขายจากคลังนี้</p></div></div><div class="kpis">${kpi('คงคลังกลาง',num(total)+'<span class="unit">ชิ้น</span>','สินค้าที่อยู่ในคลังเดียวกัน',true,'box')}${kpi('กันไว้สำหรับออเดอร์',num(held)+'<span class="unit">ชิ้น</span>','รวมทุกช่องทางของร้านนี้',false,'clock')}${kpi('พร้อมขายกลาง',num(total-held)+'<span class="unit">ชิ้น</span>','คงคลัง − จำนวนที่กันไว้',false,'check')}${kpi('ต่ำกว่าจุดสั่งซื้อ',num(low.length)+'<span class="unit">SKU</span>','อิงยอดพร้อมขายกลาง',false,'alert')}</div><section class="panel catalog-products-panel"><div class="panel-head"><div><h2>รายการสินค้ากลาง</h2><p>ออเดอร์กันสต๊อกเมื่อเข้าคิวหยิบ และตัดคงคลังเมื่อส่งมอบ</p></div>${adminAction('create-product') ? '<button type="button" class="btn primary" data-catalog-action="add-product">'+icon('plus')+'เพิ่มสินค้า</button>' : ''}</div><div class="table-scroll"><table class="data-table catalog-products-table"><thead><tr><th>สินค้า / SKU กลาง / บาร์โค้ด</th><th>ตำแหน่ง</th><th class="num">คงคลัง</th><th class="num">กันไว้</th><th class="num">พร้อมขาย</th><th class="num">จุดสั่งซื้อ</th>${financial ? '<th class="num">ราคาขาย / ต้นทุน</th>' : ''}<th>สถานะ</th><th>จัดการ</th></tr></thead><tbody>${PRODUCTS.map(product => `<tr><td><div class="product-line"><span class="product-icon">${esc(product.sku.slice(0,3))}</span><div><strong>${esc(product.name)}</strong><small>${esc(product.sku)}</small>${product.sub ? '<small>'+esc(product.sub)+'</small>' : ''}</div></div></td><td>${esc(product.location || 'ยังไม่ระบุ')}</td><td class="num">${num(product.stock)}</td><td class="num">${num(reserved(product.sku))}</td><td class="num"><strong>${num(available(product.sku))}</strong></td><td class="num">${num(product.min)}</td>${financial ? '<td class="num">'+money(product.price || 0)+'<small>ต้นทุน '+money(product.cost || 0)+'</small></td>' : ''}<td><span class="stock-level"><i class="dot ${available(product.sku) <= 0 || available(product.sku) < product.min ? 'low' : ''}"></i>${available(product.sku) <= 0 ? 'ไม่มีสินค้าพร้อมขาย' : available(product.sku) < product.min ? 'ควรเติมสินค้า' : 'พร้อมขาย'}</span></td><td><div class="catalog-row-actions">${canAction('stock-receive') ? '<button type="button" class="text-btn" data-stock="'+esc(product.sku)+'">รับสินค้าเข้า</button>' : ''}${adminAction('link-channel-product') ? '<button type="button" class="text-btn" data-catalog-link-sku="'+esc(product.sku)+'">ผูกช่องทาง</button>' : ''}</div></td></tr>`).join('') || `<tr><td colspan="${financial ? 9 : 8}" class="empty">ยังไม่มีสินค้ากลาง ${adminAction('create-product') ? 'กด “เพิ่มสินค้า” เพื่อสร้าง SKU ของร้าน จำนวนเริ่มต้นเป็น 0 จนกว่าจะระบุหรือรับสินค้าเข้า' : 'ให้ Admin สร้างสินค้า แล้วบันทึกรับสินค้าที่เข้าคลัง'}</td></tr>`}</tbody></table></div></section>${mappingPanel()}<section class="panel catalog-rules-panel"><div class="panel-head"><div><h2>คลังกลางกันและตัดสินค้าอย่างไร</h2><p>จำนวนบนช่องทางสะท้อนยอดคลัง ไม่เพิ่มจำนวนสินค้าในคลัง</p></div></div><div class="panel-body catalog-rules"><div><strong>รับออเดอร์ / เข้าคิวหยิบ</strong><p>จับคู่ตัวเลือกที่ผูกไว้ แล้วกันสินค้าจาก SKU กลาง ออเดอร์ทุกช่องทางแข่งขันกันใช้ยอดเดียว</p></div><div><strong>ส่งมอบขนส่ง</strong><p>ตัดจำนวนคงคลังและปิดยอดกันพร้อมกัน ยกเลิกก่อนส่งปล่อยยอดกันกลับครั้งเดียว</p></div><div><strong>ช่องทางที่ใช้สินค้าเดียวกัน</strong><p>Shopee, Lazada และ TikTok Shop สะท้อนยอดพร้อมขายเดียวกัน ส่วน Facebook, LINE OA, Review และ Offline sales เลือกสินค้ากลางโดยตรง</p></div></div></section>${panel('ประวัติส่งยอดสต๊อกสาธิต','การกันสินค้า ยกเลิก หรือรับเข้า เปลี่ยนยอดพร้อมขายกลาง',`<div class="table-scroll"><table class="data-table"><thead><tr><th>เวลา</th><th>ช่องทาง</th><th>เวอร์ชัน</th><th>เหตุการณ์</th><th>ผลจำลอง</th></tr></thead><tbody>${stockEvents.slice(0,12).map(event => `<tr><td>${esc(event.time)}</td><td>${esc(event.channel)}</td><td>v${esc(event.revision)}</td><td>${esc(event.reason)}</td><td>${esc(event.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">ยังไม่มีการเปลี่ยนยอดสต๊อก</td></tr>'}</tbody></table></div>`)}`;
  };

  function field(name,label,{value='',required=false,type='text',maxLength,min,max,step,help='',placeholder='',readOnly=false}={}) {
    return `<label class="field">${esc(label)}<input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"${required ? ' required' : ''}${readOnly ? ' readonly' : ''}${maxLength ? ' maxlength="'+maxLength+'"' : ''}${min !== undefined ? ' min="'+min+'"' : ''}${max !== undefined ? ' max="'+max+'"' : ''}${step ? ' step="'+step+'"' : ''} placeholder="${esc(placeholder)}" autocomplete="off"${type === 'text' ? ' spellcheck="false"' : ''}>${help ? '<span class="form-help">'+esc(help)+'</span>' : ''}</label>`;
  }
  function productOptions(selected) {
    return '<option value="">เลือกสินค้ากลาง</option>'+PRODUCTS.map(product => `<option value="${esc(product.sku)}"${product.sku === selected ? ' selected' : ''}>${esc(product.sku)} · ${esc(product.name)} · พร้อมขาย ${num(available(product.sku))}</option>`).join('');
  }
  function openForm(title,sub,html) {
    const dialog = document.getElementById('dialog');
    dialog.classList.remove('shipment-dialog');
    dialog.classList.add('catalog-dialog');
    modal(title,sub,html);
  }

  // Keep the same UUID when an uncertain response is retried with the same body.
  // Inputs stay in place on failure, and a session switch cannot update this view.
  function submitAction(form,action,bodyFor,successText) {
    const context = syncRetrySession();
    const initial = bodyFor(new FormData(form));
    const operationKey = `${action}:${action === 'create-product' ? 'new' : initial.mappingId || initial.sku || 'new'}`;
    const saved = unresolved.get(operationKey);
    let pending = false,fingerprint = saved?.fingerprint || '',requestId = saved?.requestId || '',uncertain = !!saved,frozenBody = saved?.body || null;
    const fields = [...form.querySelectorAll('input,select,textarea')];
    const fieldDisabled = fields.map(input => input.disabled);
    const submit = form.querySelector('[type="submit"]');
    const submitLabel = submit?.textContent || '';
    const clearRecord = () => { if (unresolved.get(operationKey)?.requestId === requestId) unresolved.delete(operationKey); };
    const readValues = () => fields.map(input => ({name:input.name,type:input.type,value:input.value,checked:input.checked}));
    const restoreValues = values => fields.forEach((input,index) => {
      const value = values[index];
      if (!value || value.name !== input.name || value.type !== input.type) return;
      input.value = value.value;
      if (input.type === 'checkbox' || input.type === 'radio') input.checked = value.checked;
    });
    let originalValues = saved?.values || null;
    if (saved) {
      restoreValues(saved.values);
      fields.forEach(input => input.disabled = true);
      if (submit) submit.textContent = 'ลองรายการเดิมอีกครั้ง';
      form.querySelector('[data-catalog-error]').textContent = 'รายการก่อนหน้ายังยืนยันผลไม่ได้ กด “ลองรายการเดิมอีกครั้ง” ก่อนเปลี่ยนข้อมูล ระบบจะตรวจผลด้วยรหัสคำขอเดิมเพื่อป้องกันการทำรายการซ้ำ';
    }
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending || !context || context !== sessionKey() || !canAction(action)) return;
      const error = form.querySelector('[data-catalog-error]');
      error.textContent = '';
      let body;
      try { body = uncertain ? frozenBody : {action,...bodyFor(new FormData(form))}; }
      catch (failure) { error.textContent = failure.message; return; }
      const next = JSON.stringify(body);
      if (next !== fingerprint) { fingerprint = next; requestId = crypto.randomUUID(); }
      pending = true;
      frozenBody = body;
      if (!uncertain) originalValues = readValues();
      fields.forEach(input => input.disabled = true);
      const buttons = [...form.querySelectorAll('button')];
      const disabled = buttons.map(button => button.disabled);
      buttons.forEach(button => button.disabled = true);
      form.setAttribute('aria-busy','true');
      // Retain the in-flight request too: closing and reopening its dialog must
      // retry the same operation, even before the first response has arrived.
      unresolved.set(operationKey,{body:frozenBody,requestId,fingerprint,values:originalValues});
      let committed = false;
      try {
        const out = await api('/actions','POST',{...body,requestId});
        committed = true;
        if (context !== sessionKey()) return;
        await refreshData();
        if (context !== sessionKey()) return;
        clearRecord();
        if (form.isConnected) document.getElementById('dialog').close();
        shell();
        toast(typeof successText === 'function' ? successText(out.result) : successText || out.result?.message || 'บันทึกแล้ว');
      } catch (failure) {
        if (context === sessionKey()) {
          uncertain = committed || !failure.status || failure.status >= 500;
          if (uncertain && unresolved.get(operationKey)?.requestId === requestId) unresolved.set(operationKey,{body:frozenBody,requestId,fingerprint,values:originalValues});
          if (!uncertain) clearRecord();
          if (form.isConnected) error.textContent = uncertain ? `${committed ? 'บันทึกคำขอแล้ว แต่โหลดผลล่าสุดไม่ได้' : 'ยังยืนยันผลบันทึกไม่ได้'}: ${failure.message} กด “ลองรายการเดิมอีกครั้ง” ก่อนเปลี่ยนข้อมูล เพื่อป้องกันการทำรายการซ้ำ` : failure.message;
        }
      } finally {
        pending = false;
        if (form.isConnected) {
          buttons.forEach((button,index) => button.disabled = disabled[index]);
          fields.forEach((input,index) => input.disabled = uncertain || fieldDisabled[index]);
          if (submit) submit.textContent = uncertain ? 'ลองรายการเดิมอีกครั้ง' : submitLabel;
          form.removeAttribute('aria-busy');
        }
      }
    };
  }
  const errorAndSubmit = label => `<div class="auth-error" data-catalog-error role="alert"></div><div class="modal-actions"><button class="btn primary" type="submit">${esc(label)}</button></div>`;

  function addProduct() {
    if (!adminAction('create-product')) return;
    openForm('เพิ่มสินค้ากลาง','สร้างสินค้าในร้าน '+esc(currentStore?.name || ''),`<form id="catalog-product-form"><div class="catalog-form-grid">${field('sku','SKU กลาง',{required:true,maxLength:64,placeholder:'เช่น SOAP-001',help:'ใช้ A–Z, 0–9, จุด ขีดกลาง หรือขีดล่าง ไม่ซ้ำสินค้าเดิม'})}${field('name','ชื่อสินค้า',{required:true,maxLength:160,placeholder:'เช่น สบู่สูตรอ่อนโยน'})}${field('sub','รายละเอียด / ตัวเลือกสินค้า',{maxLength:300,placeholder:'เช่น ขนาด 100 กรัม'})}${field('location','ตำแหน่งจัดเก็บ',{maxLength:80,placeholder:'เช่น A-01'})}${field('stock','จำนวนคงคลังเริ่มต้น (ชิ้น)',{required:true,value:0,type:'number',min:0,max:1000000000,step:1,help:'จำนวนสินค้าที่มีอยู่จริงในคลัง เริ่มต้นเป็น 0'})}${field('min','จุดสั่งซื้อ / แจ้งเตือนต่ำ (ชิ้น)',{required:true,value:0,type:'number',min:0,max:1000000000,step:1})}${field('price','ราคาขายต่อชิ้น (บาท)',{required:true,value:0,type:'number',min:0,max:1000000,step:'0.01'})}${field('cost','ต้นทุนต่อชิ้น (บาท)',{required:true,value:0,type:'number',min:0,max:1000000,step:'0.01'})}${field('barcode','บาร์โค้ดหลัก (ไม่บังคับ)',{maxLength:128,placeholder:'เช่น 0001234567890',help:'เก็บเลข 0 ด้านหน้าได้ ตั้งรหัสเพิ่มเติมภายหลังที่ “ตั้งบาร์โค้ด”'})}</div><p class="form-help">สร้างสินค้าและยอดเริ่มต้นในคลังกลางนี้เท่านั้น การผูกสินค้าแต่ละแพลตฟอร์มไม่เพิ่มจำนวนคงคลัง</p>${errorAndSubmit('เพิ่มสินค้า')}</form>`);
    const form = document.getElementById('catalog-product-form');
    const sku = form.elements.namedItem('sku');
    sku.pattern = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
    submitAction(form,'create-product',values => ({sku:String(values.get('sku')).trim().toUpperCase(),name:String(values.get('name')).trim(),sub:String(values.get('sub')).trim(),location:String(values.get('location')).trim(),stock:Number(values.get('stock')),min:Number(values.get('min')),price:String(values.get('price')),cost:String(values.get('cost')),barcode:String(values.get('barcode')).trim()}),result => result?.message || 'เพิ่มสินค้ากลางแล้ว');
    sku.focus();
  }

  function editMapping(id='',selectedSku='') {
    if (!adminAction('link-channel-product')) return;
    if (!PRODUCTS.length) { toast('เพิ่มสินค้ากลางก่อนผูกช่องทาง'); addProduct(); return; }
    const mapping = id ? activeMappings().find(row => row.id === id) : null;
    if (id && !mapping) return;
    openForm(mapping ? 'แก้ไขการผูกสินค้าช่องทาง' : 'ผูกสินค้าช่องทาง','จับคู่รายการบนแพลตฟอร์มกับ SKU กลางของร้านนี้',`<form id="catalog-mapping-form"><div class="catalog-form-grid"><label class="field">ช่องทาง<select name="channel" required>${channels.map(channel => `<option value="${esc(channel)}"${channel === mapping?.channel ? ' selected' : ''}>${esc(channel)}</option>`).join('')}</select></label>${field('shopId',labels.shopId,{value:mapping?.shopId || '',required:true,maxLength:128,help:'ใช้รหัสร้านจากแพลตฟอร์ม ไม่ใช้รหัสร้าน Order Hub'})}${field('productId',labels.productId,{value:mapping?.productId || '',required:true,maxLength:128})}${field('variantId',labels.variantId,{value:mapping?.variantId || '',maxLength:128,help:'ใส่ ID ของตัวเลือกที่ขาย เว้นว่างได้เฉพาะสินค้าที่ไม่มีตัวเลือก'})}${field('sellerSku',labels.sellerSku,{value:mapping?.sellerSku || '',maxLength:128,help:'ไว้แสดงและค้นข้อมูล ไม่ใช้เดา SKU กลางอัตโนมัติ'})}${field('name',labels.name,{value:mapping?.name || '',maxLength:200})}<label class="field catalog-wide-field">ใช้สินค้าคงคลังกลาง<select name="centralSku" required>${productOptions(mapping?.centralSku || selectedSku)}</select><span class="form-help">หลายช่องทางหรือหลายรายการใช้สินค้ากลางเดียวกันได้ โดยไม่เพิ่มสต๊อก</span></label></div><div class="notice catalog-modal-notice">${icon('alert')}เป็นการบันทึกการจับคู่ด้วย ID ยังไม่ได้ตรวจสินค้าจาก API จริง กรุณายืนยันว่าเลือกร้านและตัวเลือกตรงกับสินค้าในคลัง</div>${mapping ? '<p class="form-help">การแก้ไขไม่เปลี่ยน SKU ของออเดอร์เดิมที่รับมาแล้ว</p>' : ''}${errorAndSubmit(mapping ? 'บันทึกการผูก' : 'ผูกสินค้า')}</form>`);
    const form = document.getElementById('catalog-mapping-form');
    submitAction(form,'link-channel-product',values => ({...(mapping ? {mappingId:mapping.id,expectedVersion:mapping.version} : {}),channel:String(values.get('channel')),shopId:String(values.get('shopId')).trim(),productId:String(values.get('productId')).trim(),variantId:String(values.get('variantId')).trim(),sellerSku:String(values.get('sellerSku')).trim(),name:String(values.get('name')).trim(),centralSku:String(values.get('centralSku'))}),result => result?.message || 'บันทึกการผูกสินค้าแล้ว');
    form.elements.namedItem(mapping ? 'centralSku' : 'shopId').focus();
  }

  function unlinkMapping(id) {
    if (!adminAction('unlink-channel-product')) return;
    const mapping = activeMappings().find(row => row.id === id);
    if (!mapping) return;
    openForm('ยกเลิกการผูกสินค้าช่องทาง',esc(mapping.channel)+' · ร้าน '+esc(mapping.shopId),`<form id="catalog-unlink-form"><div class="catalog-unlink-summary"><strong>${esc(mapping.name || mapping.productId)}</strong><p>Product ${esc(mapping.productId)} · ตัวเลือก ${esc(mapping.variantId || 'ไม่มีตัวเลือก')}</p><p>ผูกกับ SKU กลาง <strong>${esc(mapping.centralSku)}</strong></p></div><p>หลังยกเลิก รายการช่องทางนี้จะไม่มี SKU กลางที่ใช้อ้างอิง ออเดอร์เดิมและสต๊อกกลางคงเดิม ต้องผูกใหม่ก่อนทดสอบออเดอร์รายการนี้อีกครั้ง</p><label class="catalog-confirm"><input type="checkbox" required>ยืนยันยกเลิกการผูกรายการนี้</label>${errorAndSubmit('ยกเลิกการผูก')}</form>`);
    submitAction(document.getElementById('catalog-unlink-form'),'unlink-channel-product',() => ({mappingId:mapping.id,expectedVersion:mapping.version}),'ยกเลิกการผูกสินค้าแล้ว');
  }

  function simulateMapping(id) {
    if (!adminAction('simulate-mapped-order')) return;
    const mapping = activeMappings().find(row => row.id === id);
    if (!mapping) return;
    const product = productFor(mapping.centralSku);
    openForm('ทดสอบออเดอร์สาธิต',esc(mapping.channel)+' → '+esc(mapping.centralSku),`<form id="catalog-simulate-form"><p>ทดลองรับออเดอร์รายการ <strong>${esc(mapping.name || mapping.productId)}</strong> ของร้าน ${esc(mapping.shopId)} ให้ใช้ <strong>${esc(product?.name || mapping.centralSku)}</strong> จากคลังกลาง</p>${field('qty','จำนวนสั่ง (ชิ้น)',{type:'number',required:true,value:1,min:1,max:100,step:1})}<p class="form-help">พร้อมขายกลาง ${product ? num(available(product.sku)) : '—'} ชิ้น ออเดอร์สาธิตจะกันสินค้าจากยอดนี้ หากไม่พอจะพักออเดอร์ โดยไม่ทำให้สต๊อกติดลบ</p><div class="notice catalog-modal-notice">${icon('alert')}สร้างออเดอร์ข้อมูลสมมติในร้านนี้และเปลี่ยนยอดกันของคลังกลาง ไม่ได้เรียก API หรือสร้างคำสั่งซื้อบนแพลตฟอร์ม ยกเลิกออเดอร์สาธิตในหน้าคำสั่งซื้อเพื่อคืนยอดกัน</div>${errorAndSubmit('สร้างออเดอร์สาธิตและกันสต๊อก')}</form>`);
    submitAction(document.getElementById('catalog-simulate-form'),'simulate-mapped-order',values => ({mappingId:mapping.id,qty:Number(values.get('qty'))}),result => result?.status === 'hold' ? `สร้าง ${result.orderId} แล้ว · พักออเดอร์เพราะสต๊อกไม่พอ` : `สร้าง ${result?.orderId || 'ออเดอร์สาธิต'} และกันสต๊อกกลางแล้ว`);
  }

  function receiveProduct(sku) {
    if (!canAction('stock-receive')) return;
    const product = productFor(sku);
    if (!product) return;
    openForm('รับสินค้าเข้าคลังกลาง',esc(product.name)+' · '+esc(product.sku),`<form id="catalog-receive-form">${field('qty','จำนวนรับเข้า (ชิ้น)',{type:'number',required:true,value:1,min:1,max:10000,step:1})}<p class="form-help">เพิ่มจำนวนคงคลังของ SKU กลางนี้ ออเดอร์ที่กันไว้คงเดิม และยอดพร้อมขายช่องทางสาธิตจะสะท้อนยอดกลาง</p>${errorAndSubmit('บันทึกรับสินค้า')}</form>`);
    submitAction(document.getElementById('catalog-receive-form'),'stock-receive',values => ({sku:product.sku,qty:Number(values.get('qty'))}),'บันทึกรับสินค้าเข้าคลังกลางแล้ว');
  }
  function bindCatalog() {
    if (state.view !== 'inventory' || !currentAuth) return;
    document.querySelectorAll('[data-catalog-action]').forEach(button => button.onclick = () => {
      if (button.dataset.catalogAction === 'add-product') addProduct();
      if (button.dataset.catalogAction === 'link-product') editMapping();
      if (button.dataset.catalogAction === 'connections') void changeView('connections');
    });
    document.querySelectorAll('[data-catalog-link-sku]').forEach(button => button.onclick = () => editMapping('',button.dataset.catalogLinkSku));
    document.querySelectorAll('[data-catalog-mapping]').forEach(button => button.onclick = () => editMapping(button.dataset.catalogMapping));
    document.querySelectorAll('[data-catalog-unlink]').forEach(button => button.onclick = () => unlinkMapping(button.dataset.catalogUnlink));
    document.querySelectorAll('[data-catalog-simulate]').forEach(button => button.onclick = () => simulateMapping(button.dataset.catalogSimulate));
    document.querySelectorAll('[data-stock]').forEach(button => button.onclick = () => receiveProduct(button.dataset.stock));
  }
  const previousBindViews = bindViews;
  bindViews = function() { previousBindViews(); bindCatalog(); };
  const previousShell = shell;
  shell = function() {
    previousShell();
    if (state.view !== 'inventory' || !currentAuth) return;
    const actions = document.querySelector('.heading .actions');
    if (actions && adminAction('create-product')) {
      const add = document.createElement('button');
      add.className = 'btn primary';
      add.type = 'button';
      add.dataset.catalogAction = 'add-product';
      add.innerHTML = icon('plus')+'เพิ่มสินค้า';
      add.onclick = addProduct;
      actions.prepend(add);
    }
  };
  document.getElementById('dialog').addEventListener('close',() => document.getElementById('dialog').classList.remove('catalog-dialog'));
})();
