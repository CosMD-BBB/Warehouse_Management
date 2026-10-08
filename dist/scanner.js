'use strict';

// Keyboard-mode USB/Bluetooth scanners type into the focused input just like a keyboard.
// Each Enter/Tab terminator creates one independent, retryable server action.
(() => {
  const scanner = {queue:[],active:null,retry:null,working:false,generation:0,key:'',notice:'',tone:'neutral'};
  const dialogOpen = () => document.getElementById('dialog')?.open === true;
  const sessionKey = () => currentAuth && currentStore ? `${sessionEpoch}:${currentStore.id}:${currentAuth.id}:${csrfToken}` : '';
  const packingContext = () => {
    const order = orders.find(row => row.id === state.packId);
    if (state.view !== 'fulfillment' || !currentAuth || !canAction('scan') || order?.status !== 'packing') return null;
    return {key:`${sessionKey()}:${order.id}`,session:sessionKey(),id:order.id,generation:scanner.generation};
  };
  const sameSession = item => item.session === sessionKey();
  const sameContext = item => {
    const context = packingContext();
    return !!context && item.key === context.key && item.generation === scanner.generation;
  };
  const pendingCount = () => scanner.queue.length + Number(!!scanner.active && sameContext(scanner.active)) + Number(!!scanner.retry);
  const requiredLines = order => {
    const quantities = new Map();
    for (const line of order.items || []) quantities.set(line.sku,(quantities.get(line.sku) || 0) + Number(line.qty));
    return [...quantities].map(([sku,qty]) => ({sku,qty}));
  };
  const complete = order => requiredLines(order).every(line => Number(order.scanned?.[line.sku] || 0) === line.qty);

  function invalidateQueue() {
    scanner.generation++;
    scanner.queue.length = 0;
    scanner.retry = null;
    scanner.notice = '';
    scanner.tone = 'neutral';
    scanner.key = '';
  }
  function setNotice(message,tone='neutral') {
    scanner.notice = message;
    scanner.tone = tone;
    syncPacking();
  }
  function focusScanner(context) {
    if (!context || !sameContext(context) || dialogOpen()) return;
    const input = document.getElementById('scan-input');
    if (input && !input.disabled) input.focus({preventScroll:true});
  }

  function syncPacking() {
    const context = packingContext();
    if (!context) return;
    const order = orders.find(row => row.id === context.id);
    let checked = 0,total = 0;
    for (const line of requiredLines(order)) {
      const done = Number(order.scanned?.[line.sku] || 0);
      checked += done;
      total += line.qty;
      const row = [...document.querySelectorAll('[data-scanner-sku]')].find(element => element.dataset.scannerSku === line.sku);
      if (!row) continue;
      row.querySelector('[data-scanner-done]').textContent = String(done);
      row.querySelector('.pack-count').classList.toggle('positive',done === line.qty);
      const button = row.querySelector('[data-scan]');
      button.disabled = done >= line.qty;
      button.textContent = done >= line.qty ? 'ครบแล้ว' : 'ยืนยันเอง 1 ชิ้น';
    }
    const progress = document.getElementById('scanner-progress');
    if (progress) progress.textContent = `ตรวจแล้ว ${checked} / ${total} ชิ้น`;
    const count = document.getElementById('scanner-queue-count');
    if (count) count.textContent = pendingCount() ? `รอบันทึก ${pendingCount()} ครั้ง` : 'พร้อมรับรหัสถัดไป';
    const feedback = document.getElementById('scanner-feedback');
    if (feedback) {
      feedback.textContent = scanner.notice;
      feedback.dataset.tone = scanner.tone;
    }
    const retry = document.getElementById('scanner-retry');
    if (retry) retry.hidden = !scanner.retry;
    const finish = document.querySelector('[data-action="pack-complete"]');
    if (finish) finish.disabled = !complete(order) || pendingCount() > 0;
  }

  async function processQueue() {
    if (scanner.working || scanner.retry) return;
    scanner.working = true;
    let lastContext = null;
    try {
      while (scanner.queue.length && !scanner.retry) {
        const item = scanner.queue.shift();
        if (!sameContext(item)) continue;
        lastContext = item;
        scanner.active = item;
        syncPacking();
        try {
          const out = await api('/actions','POST',{action:'scan',id:item.id,code:item.code,requestId:item.requestId});
          if (!sameSession(item)) continue;
          const result = out.result;
          if (result && result.orderId === item.id && typeof result.sku === 'string' && Number.isInteger(result.scanned)) {
            const order = orders.find(row => row.id === item.id);
            if (order) { order.scanned ||= {}; order.scanned[result.sku] = result.scanned; }
          } else {
            await refreshData();
          }
          if (sameContext(item)) setNotice(result?.message || 'ตรวจสินค้าแล้ว 1 ชิ้น','success');
        } catch (error) {
          if (sameContext(item)) {
            // A network/server failure may occur after commit; retain the original request ID.
            if (!error.status || error.status >= 500) {
              scanner.retry = item;
              setNotice(`ยังยืนยันผลบันทึกไม่ได้: ${error.message} กด “ลองบันทึกครั้งเดิมอีกครั้ง” เพื่อป้องกันการนับซ้ำ`,'error');
            } else {
              setNotice(error.message || 'ไม่รับรหัสนี้ กรุณาตรวจสินค้าแล้วสแกนใหม่','error');
            }
          }
        } finally {
          scanner.active = null;
          syncPacking();
        }
      }
    } finally {
      syncPacking();
      // Refresh once after a burst. Keep the input DOM so a partly typed next code is never lost.
      if (lastContext && sameContext(lastContext) && !scanner.retry && !scanner.queue.length) {
        try { await refreshData(); if (sameContext(lastContext)) syncPacking(); }
        catch (error) { if (sameContext(lastContext)) setNotice(`บันทึกการสแกนแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ: ${error.message}`,'error'); }
      }
      scanner.working = false;
      if (scanner.queue.length && !scanner.retry) void processQueue();
    }
  }

  function enqueueScan(code) {
    const context = packingContext();
    if (!context || dialogOpen()) return;
    code = String(code || '').trim();
    if (!code) { focusScanner(context); return; }
    if (code.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(code)) {
      setNotice('รหัสต้องไม่เกิน 128 ตัวและไม่มีช่องว่าง ตั้งเครื่องสแกนให้ใช้ภาษาอังกฤษและปิดท้ายด้วย Enter หรือ Tab','error');
      focusScanner(context);
      return;
    }
    scanner.queue.push({...context,code,requestId:crypto.randomUUID()});
    if (!scanner.retry) setNotice(`รับรหัส ${code} แล้ว กำลังตรวจและบันทึก`);
    syncPacking();
    void processQueue();
    focusScanner(context);
  }

  views.fulfillment = () => {
    const queue = orders.filter(order => ['ready','packing','packed'].includes(order.status));
    if (!queue.some(order => order.id === state.packId)) state.packId = queue[0]?.id || null;
    const order = queue.find(row => row.id === state.packId);
    const lines = order ? requiredLines(order) : [];
    const products = lines.map(line => {
      const product = PRODUCTS.find(row => row.sku === line.sku);
      const done = order.status === 'packed' ? line.qty : Number(order.scanned?.[line.sku] || 0);
      return `<div class="pack-product scanner-product" data-scanner-sku="${esc(line.sku)}"><span class="product-icon">${esc(line.sku.slice(0,3))}</span><div class="name">${esc(product?.name || line.sku)}<small>${esc(line.sku)} · ตำแหน่ง ${esc(product?.location || 'ยังไม่ระบุ')}</small><small class="scanner-product-barcode">${product?.barcode ? `บาร์โค้ด ${esc(product.barcode)}` : 'ใช้รหัส SKU หรือให้ Admin กำหนดบาร์โค้ดสินค้า'}</small></div><span class="pack-count ${done === line.qty ? 'positive' : ''}"><span data-scanner-done>${done}</span><span class="scanner-count-total"> / ${line.qty}</span></span><button class="btn small" data-scan="${esc(line.sku)}" ${order.status !== 'packing' || done >= line.qty ? 'disabled' : ''}>${done >= line.qty ? 'ครบแล้ว' : 'ยืนยันเอง 1 ชิ้น'}</button></div>`;
    }).join('');
    const scannerPanel = order?.status === 'packing' ? `<section class="scanner-station" aria-labelledby="scanner-title"><div class="scanner-station-heading"><h3 id="scanner-title">${icon('scan')}สแกนตรวจสินค้าทีละชิ้น</h3><strong id="scanner-progress">ตรวจแล้ว ${sum(lines,line=>Number(order.scanned?.[line.sku] || 0))} / ${sum(lines,line=>line.qty)} ชิ้น</strong></div><form class="scan-form" id="scan-form" data-scanner-order="${esc(order.id)}"><label class="scanner-input-label" for="scan-input">บาร์โค้ดสินค้าหรือ SKU<input id="scan-input" type="text" placeholder="สแกนบาร์โค้ดหรือพิมพ์ SKU" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="scanner-help scanner-queue-count" enterkeyhint="send"></label><button class="btn primary" type="submit">ตรวจ 1 ชิ้น</button></form><p id="scanner-help" class="scanner-help">ต่อเครื่องสแกน USB หรือ Bluetooth แบบคีย์บอร์ด (HID) เลือกภาษาอังกฤษ แล้วตั้งให้ปิดท้ายด้วย Enter หรือ Tab คลิกช่องนี้ก่อนสแกน · ไม่ต้องติดตั้งส่วนเสริมเบราว์เซอร์</p><div class="scanner-state"><span id="scanner-queue-count">พร้อมรับรหัสถัดไป</span><button class="text-btn" type="button" id="scanner-focus">คลิกเพื่อพร้อมสแกน</button></div><p id="scanner-feedback" class="scanner-feedback" role="status" aria-live="polite" aria-atomic="true"></p><button class="btn small" type="button" id="scanner-retry" hidden>ลองบันทึกครั้งเดิมอีกครั้ง</button><p class="scanner-help">หนึ่งครั้งเพิ่มจำนวนตรวจ 1 ชิ้น ระบบไม่รับสินค้าผิดออเดอร์หรือจำนวนเกิน ปุ่ม “ยืนยันเอง” ใช้เมื่อไม่มีเครื่องสแกน</p></section>` : '';
    return `<div class="notice blue">${icon('scan')}ตรวจบาร์โค้ดสินค้ากับออเดอร์ก่อนปิดกล่อง · ใบจ่หน้าและการส่งมอบที่มีป้ายสาธิตยังใช้ส่งจริงไม่ได้</div><div class="split scanner-workspace"><div class="pick-list"><div class="panel-head" style="padding-bottom:15px"><h2>คิวจัดส่ง</h2><span class="badge">${queue.length} ออเดอร์</span></div>${queue.map(row=>`<button class="pick-item ${row.id === state.packId ? 'active' : ''}" data-pack-id="${esc(row.id)}"><span class="row"><strong>${esc(row.id)}</strong>${badge(row.status)}</span><small>${esc(row.channel)} · ${sum(row.items,line=>line.qty)} ชิ้น · ${row.deadline === TODAY ? 'ส่งวันนี้' : formatDate(row.deadline)}</small></button>`).join('') || '<div class="empty">จัดการคิวครบแล้ว</div>'}</div><section class="panel scanner-pack-panel">${order ? `<div class="panel-head"><div><h2>${esc(order.id)}</h2><p>${esc(order.channel)} · ${esc(order.customer)} · ${esc(order.province)}</p></div>${badge(order.status)}</div><div class="panel-body"><div class="stepper">${['กันสต๊อก','ตรวจหยิบ / แพ็ก','พร้อมส่ง'].map((label,index)=>`<span class="${index <= ['ready','packing','packed'].indexOf(order.status) ? 'done' : ''}"><b>${index + 1}</b>${label}</span>`).join('')}</div>${products}${scannerPanel}<div class="scanner-shipping-summary"><div class="stat-line"><span>ขนส่ง</span><strong>${esc(order.carrier || 'ยังไม่ระบุ')}</strong></div><div class="stat-line"><span>กำหนดส่ง</span><strong>${formatDate(order.deadline)}</strong></div><div class="stat-line"><span>จำนวนรวม</span><strong>${sum(lines,line=>line.qty)} ชิ้น</strong></div></div><div class="actions">${order.status === 'ready' ? button('เริ่มหยิบและแพ็ก','pack-start','scan','primary') : order.status === 'packing' ? `<button class="btn primary" data-action="pack-complete" ${complete(order) && !pendingCount() ? '' : 'disabled'}>${icon('check')}ตรวจครบ / ปิดกล่อง</button>` : button('ดูใบจ่หน้าสาธิต','pack-label','print') + button('จำลองส่งมอบขนส่ง','pack-dispatch','truck','primary')}</div></div>` : '<div class="empty">ไม่มีออเดอร์รอจัดส่ง เปิดคำสั่งซื้อเพื่อรับรายการเข้าใหม่</div>'}</section></div>`;
  };

  function bindScanner() {
    const form = document.getElementById('scan-form');
    const input = document.getElementById('scan-input');
    if (form && input) {
      const submit = () => { const code = input.value; input.value = ''; enqueueScan(code); };
      form.onsubmit = event => { event.preventDefault(); submit(); };
      input.onkeydown = event => {
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
          if (event.key === 'Tab' && !input.value.trim()) return;
          event.preventDefault();
          if (!event.repeat) submit();
        }
      };
    }
    document.querySelectorAll('[data-scan]').forEach(button => button.onclick = () => enqueueScan(button.dataset.scan));
    const focus = document.getElementById('scanner-focus');
    if (focus) focus.onclick = () => focusScanner(packingContext());
    const retry = document.getElementById('scanner-retry');
    if (retry) retry.onclick = () => {
      const item = scanner.retry;
      if (!item || !sameContext(item)) return;
      scanner.retry = null;
      scanner.queue.unshift(item);
      setNotice('กำลังตรวจผลบันทึกครั้งเดิม');
      void processQueue();
      focusScanner(item);
    };
    syncPacking();
  }

  function inventoryBarcodes() {
    if (state.view !== 'inventory' || !currentAuth) return;
    document.querySelectorAll('[data-stock]').forEach(stockButton => {
      const product = PRODUCTS.find(row => row.sku === stockButton.dataset.stock);
      const row = stockButton.closest('tr');
      if (!product || !row || row.querySelector('.inventory-barcode')) return;
      const info = document.createElement('small');
      info.className = 'inventory-barcode';
      info.textContent = product.barcode ? `บาร์โค้ด ${product.barcode}${product.barcodes?.length ? ` · รหัสเพิ่มเติม ${product.barcodes.length}` : ''}` : 'ยังไม่กำหนดบาร์โค้ด · สแกน SKU ได้';
      row.cells[0].append(info);
      if (currentAuth.role === 'admin' && canAction('set-barcode')) {
        const button = document.createElement('button');
        button.className = 'text-btn scanner-edit-barcode';
        button.type = 'button';
        button.dataset.barcodeSku = product.sku;
        button.textContent = 'ตั้งบาร์โค้ด';
        button.onclick = () => editBarcode(product.sku);
        stockButton.parentElement.append(button);
      }
    });
  }

  function editBarcode(sku) {
    if (currentAuth?.role !== 'admin' || !canAction('set-barcode')) return;
    const product = PRODUCTS.find(row => row.sku === sku);
    if (!product) return;
    const context = sessionKey();
    modal('ตั้งบาร์โค้ดสินค้า',esc(product.name),`<form id="barcode-form" class="scanner-barcode-form"><label class="field">SKU กลาง<input value="${esc(product.sku)}" readonly></label><label class="field">บาร์โค้ดหลัก<input name="barcode" value="${esc(product.barcode || '')}" maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="เช่น 0001234567890"><span class="form-help">เก็บเป็นข้อความ จึงคงเลข 0 ด้านหน้าได้ เว้นว่างเพื่อลบรหัสหลัก</span></label><label class="field">บาร์โค้ดเพิ่มเติม (ไม่บังคับ)<textarea name="barcodes" rows="4" maxlength="2580" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="หนึ่งรหัสต่อบรรทัด สูงสุด 20 รหัส">${esc((product.barcodes || []).join('\n'))}</textarea><span class="form-help">ทุกบาร์โค้ดต้องไม่ซ้ำกับสินค้าอื่นในร้าน รหัส SKU เดิมยังใช้สแกนได้</span></label><div class="auth-error" id="barcode-error" role="alert"></div><div class="modal-actions"><button class="btn primary" type="submit">บันทึกบาร์โค้ด</button></div></form>`);
    const form = document.getElementById('barcode-form');
    let pending = false,fingerprint = '',requestId = '';
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending || context !== sessionKey()) return;
      const values = new FormData(form);
      const body = {action:'set-barcode',sku,barcode:String(values.get('barcode') || '').trim(),barcodes:String(values.get('barcodes') || '').split(/\r?\n/u).map(value=>value.trim()).filter(Boolean)};
      const nextFingerprint = JSON.stringify(body);
      if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; requestId = crypto.randomUUID(); }
      pending = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      form.querySelector('#barcode-error').textContent = '';
      try {
        await api('/actions','POST',{...body,requestId});
        if (context !== sessionKey()) return;
        await refreshData();
        if (context !== sessionKey()) return;
        if (form.isConnected && dialogOpen()) document.getElementById('dialog').close();
        shell();
        toast('บันทึกบาร์โค้ด '+sku+' แล้ว');
      } catch (error) {
        if (form.isConnected && context === sessionKey()) form.querySelector('#barcode-error').textContent = error.message;
      } finally {
        pending = false;
        if (form.isConnected) submit.disabled = false;
      }
    };
  }

  const scannerBaseBindViews = bindViews;
  bindViews = function() { scannerBaseBindViews(); bindScanner(); };
  const scannerBaseShell = shell;
  shell = function() {
    const before = packingContext();
    const oldInput = document.getElementById('scan-input');
    const previousKey = scanner.key;
    const sameInputContext = before && previousKey === before.key && oldInput?.closest('form')?.dataset.scannerOrder === before.id;
    const draft = sameInputContext ? oldInput.value : '';
    const hadFocus = oldInput && document.activeElement === oldInput;
    scannerBaseShell();
    let after = packingContext();
    if (scanner.key !== (after?.key || '')) {
      invalidateQueue();
      scanner.key = after?.key || '';
      after = packingContext();
    }
    inventoryBarcodes();
    syncPacking();
    if (after && sameInputContext && before.key === after.key) {
      const input = document.getElementById('scan-input');
      if (input) input.value = draft;
    }
    if (after && (!oldInput || previousKey !== after.key || hadFocus)) focusScanner(after);
  };
  const scannerBaseClearSession = clearSession;
  clearSession = function() { invalidateQueue(); return scannerBaseClearSession(); };
  const scannerBaseChangeView = changeView;
  changeView = function(view) { if (view !== state.view) invalidateQueue(); return scannerBaseChangeView(view); };
  const scannerBaseExtraAction = extraAction;
  extraAction = function(action) {
    if (action === 'pack-complete' && pendingCount()) { toast('รอให้ระบบบันทึกการสแกนครบก่อนปิดกล่อง'); return; }
    return scannerBaseExtraAction(action);
  };
  document.getElementById('dialog').addEventListener('close',() => focusScanner(packingContext()));
})();
