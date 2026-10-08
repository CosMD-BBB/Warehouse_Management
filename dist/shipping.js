'use strict';

// Packing scans, account authentication and order editing load first. These
// additions retain their views and only prepare a shipment; no courier is called.
(() => {
  const marketplaceLinks = {
    'Shopee': { seller: 'https://seller.shopee.co.th/', developer: 'https://open.shopee.com/' },
    'TikTok Shop': { seller: 'https://seller-th.tiktok.com/', developer: 'https://partner.tiktokshop.com/' },
    'Lazada': { seller: 'https://sellercenter.lazada.co.th/', developer: 'https://open.lazada.com/' }
  };
  const directCarriers = ['Flash Express', 'J&T Express', 'KEX', 'ไปรษณีย์ไทย'];
  const carrierLinks = {
    'Flash Express': 'https://www.flashexpress.co.th/',
    'J&T Express': 'https://www.jtexpress.co.th/',
    'KEX': 'https://th.kex-express.com/',
    'ไปรษณีย์ไทย': 'https://www.thailandpost.co.th/'
  };
  const canPrepare = () => canAction('request-shipment');
  const canCancel = () => canAction('cancel-shipment');
  const awaiting = order => order.shipment?.status === 'awaiting_connection';
  const htmlLink = (label, url) => `<a class="guide-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${icon('link')}</a>`;
  const thaiDate = (offset = 0) => {
    const now = new Date();
    now.setUTCDate(now.getUTCDate() + offset);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const completeRecipient = order => !!order.phone && !!order.shippingAddress && ['addressLine', 'subdistrict', 'district', 'province', 'postalCode'].every(key => String(order.shippingAddress[key] || '').trim());
  const shipmentButtons = (order, context) => {
    if (order.status !== 'packed') return '';
    if (awaiting(order)) return canCancel() ? `<button type="button" class="btn small" data-action="${context}-cancel-shipment">ยกเลิกคำขอที่เตรียมไว้</button>` : '';
    return canPrepare() ? `<button type="button" class="btn primary" data-action="${context}-request-shipment">${icon('truck')}เตรียมเรียกขนส่ง</button>` : '';
  };
  const shipmentSummary = order => {
    const shipment = order.shipment;
    if (!shipment) return '<p>บันทึกข้อมูลพัสดุและจุดรับสินค้าหลังปิดกล่อง เพื่อเตรียมส่งคำขอเมื่อเชื่อมบัญชีพร้อมแล้ว</p>';
    const cancelled = shipment.status === 'cancelled';
    return `<div class="shipping-status-row"><span class="badge ${cancelled ? '' : 'hold'}">${cancelled ? 'ยกเลิกคำขอที่เตรียมไว้แล้ว' : 'รอเชื่อมต่อแพลตฟอร์ม / ขนส่ง'}</span><strong>${esc(shipment.provider || shipment.carrier || order.channel)}</strong></div><p>${shipment.method === 'pickup' ? 'รับพัสดุที่ร้าน' : 'นำพัสดุไปส่งเอง'}${shipment.pickupDate ? ' · วันที่ขอ ' + esc(formatDate(shipment.pickupDate)) : ''}${shipment.pickupTimeFrom && shipment.pickupTimeTo ? ' · ' + esc(shipment.pickupTimeFrom) + '–' + esc(shipment.pickupTimeTo) + ' น. (ไทย)' : ''}</p><div class="shipping-package-summary"><span>น้ำหนัก ${esc(shipment.package?.weightGrams || '')} กรัม</span><span>ขนาด ${esc(shipment.package?.lengthCm || '')} × ${esc(shipment.package?.widthCm || '')} × ${esc(shipment.package?.heightCm || '')} ซม.</span></div>${shipment.sender ? `<p class="shipping-wrap">จุดรับ: ${esc(shipment.sender.name)} · ${esc(shipment.sender.phone)}<br>${esc(orderAddressText(shipment.sender))}</p>` : ''}<p class="shipping-pending-note">${cancelled ? (order.status === 'packed' ? 'รายการนี้ยังไม่เคยส่งคำขอไปยังผู้ให้บริการ สามารถเตรียมข้อมูลใหม่ได้' : 'ปิดคำขอเตรียมขนส่งตามสถานะออเดอร์แล้ว รายการนี้ยังไม่เคยส่งคำขอไปยังผู้ให้บริการ') : 'บันทึกข้อมูลแล้ว แต่ยังไม่ได้เรียกรถ จองงานขนส่ง หรือออกใบจ่าหน้าจริง'}</p>`;
  };
  const shipmentCard = (order, context = 'pack') => `<section class="shipping-preparation" data-shipment-order="${esc(order.id)}"><div class="shipping-card-heading">${icon('truck')}<div><h3>เตรียมเรียกขนส่งหลังแพ็ก</h3><small>ส่งคำขอจริงได้เมื่อแอปและบัญชีผู้ให้บริการได้รับอนุญาต</small></div></div>${shipmentSummary(order)}${!completeRecipient(order) ? '<p class="shipping-address-warning">ข้อมูลผู้รับของออเดอร์นี้ยังไม่ครบ ต้องมีเบอร์โทรและที่อยู่ทุกช่องก่อนเตรียมคำขอ</p>' : ''}<div class="actions">${shipmentButtons(order, context)}</div></section>`;

  const previousFulfillment = views.fulfillment;
  views.fulfillment = function () {
    const html = previousFulfillment();
    const order = orders.find(item => item.id === state.packId);
    return html + (order?.status === 'packed' && canView('fulfillment') ? shipmentCard(order) : '');
  };
  const previousShowOrder = showOrder;
  showOrder = function (id) {
    document.getElementById('dialog').classList.remove('shipment-dialog');
    previousShowOrder(id);
    const order = orders.find(item => item.id === id);
    if (!currentAuth || !order || (!order.shipment && order.status !== 'packed')) return;
    const body = document.querySelector('#dialog .modal-body');
    const actions = body?.querySelector('.modal-actions');
    if (body) {
      const section = document.createElement('section');
      section.className = 'shipping-detail';
      section.innerHTML = shipmentCard(order, 'detail');
      if (actions) actions.before(section); else body.append(section);
      section.querySelectorAll('[data-action]').forEach(button => button.onclick = () => extraAction(button.dataset.action));
    }
  };

  function readinessMarkup(channel, carrier) {
    const marketplace = marketplaceLinks[channel];
    const ownerSteps = marketplace
      ? 'เจ้าของร้านสมัครแอปผู้พัฒนา ขอสิทธิ์ออเดอร์ / สต๊อก / จัดส่งตามที่แพลตฟอร์มอนุญาต และอนุญาตบัญชีร้านผ่านหน้าของแพลตฟอร์ม'
      : 'เจ้าของร้านเลือกขนส่งและเปิดบัญชีธุรกิจ ขอสิทธิ์ API รับพัสดุ / ใบจ่าหน้า / ติดตามกับขนส่งที่เลือก';
    const developerSteps = marketplace
      ? 'ผู้พัฒนาตั้งค่าข้อมูลลับบนเซิร์ฟเวอร์ รับผลอนุญาต ตรวจร้านและประเทศให้ตรง ทดสอบอ่านออเดอร์ ส่งคำขอจัดส่ง และรับสถานะโดยไม่ทำรายการซ้ำ'
      : 'ผู้พัฒนาตั้งค่าบัญชีขนส่งบนเซิร์ฟเวอร์ ทดสอบสร้างพัสดุ จุดรับ ใบจ่าหน้า และสถานะติดตามตามสิทธิ์ของบัญชี';
    return `<div class="shipping-readiness"><span class="badge hold">ยังไม่ได้เชื่อมบัญชีจริง</span><p>${marketplace ? `ออเดอร์ ${esc(channel)} ต้องจัดส่งผ่านบัญชีร้านและวิธีที่แพลตฟอร์มกำหนด` : `ออเดอร์ ${esc(channel)} ใช้ API ของขนส่งโดยตรง${carrier ? ' เช่น ' + esc(carrier) : ''}`}</p><details><summary>ต้องทำอะไรจึงจะเรียกขนส่งจริงได้</summary><div class="shipping-readiness-steps"><p><strong>เจ้าของร้าน</strong>${ownerSteps}</p><p><strong>ผู้พัฒนาระบบ</strong>${developerSteps}</p><p><strong>ตรวจความพร้อม</strong>ยืนยันบัญชีและสิทธิ์ เลขออเดอร์ ผู้รับ / จุดรับ SKU และช่วงเวลาที่ผู้ให้บริการรับได้ ก่อนส่งคำขอจริง</p></div>${marketplace ? `<div class="shipping-source-links">${htmlLink('เปิด Seller Center', marketplace.seller)}${htmlLink('เปิดเว็บผู้พัฒนา', marketplace.developer)}</div>${currentAuth?.role === 'admin' ? `<button type="button" class="text-btn shipping-guide-button" data-shipping-guide="${esc(channel)}">ดูขั้นตอนเชื่อม ${esc(channel)} ใน Order Hub</button>` : '<p class="form-help">ให้ Admin ของร้านดำเนินการเชื่อมบัญชีในเมนูเชื่อมต่อช่องทาง</p>'}` : '<p class="form-help">การอนุญาต Facebook หรือ LINE OA ใช้รับข้อความ ไม่ได้อนุญาตให้เรียกขนส่งผ่าน Marketplace</p>'}</details></div>`;
  }

  function prepareShipment(order) {
    if (!canPrepare() || order.status !== 'packed') { toast('ต้องแพ็กครบและมีสิทธิ์เตรียมขนส่งก่อน'); return; }
    if (awaiting(order)) { toast('มีคำขอที่เตรียมไว้แล้ว หากต้องการแก้ไขให้ยกเลิกคำขอเดิมก่อน'); return; }
    const marketplace = !!marketplaceLinks[order.channel];
    const prior = order.shipment || {};
    const sender = prior.sender || {};
    const parcel = prior.package || {};
    const validRecipient = completeRecipient(order);
    const carrier = directCarriers.includes(prior.carrier || order.carrier) ? prior.carrier || order.carrier : '';
    const date = prior.pickupDate >= thaiDate() && prior.pickupDate <= thaiDate(14) ? prior.pickupDate : thaiDate();
    const timeFields = `<div class="shipping-field-grid shipping-pickup-times"><label class="field">ช่วงเวลาที่ต้องการ เริ่ม (ไทย)<input name="pickupTimeFrom" type="time" value="${esc(prior.pickupTimeFrom || '')}"></label><label class="field">ถึงเวลา (ไทย)<input name="pickupTimeTo" type="time" value="${esc(prior.pickupTimeTo || '')}"></label></div>`;
    const formMarkup = `<form id="shipment-form" class="shipping-form"><section class="shipping-form-section"><h3>ออเดอร์และผู้รับ</h3><div class="shipping-order-reference"><span>ช่องทาง <strong>${esc(order.channel)}</strong></span><span>เลขออเดอร์ ${marketplace ? 'แพลตฟอร์ม' : 'ต้นทาง'} <strong>${esc(order.external || order.id)}</strong></span></div><p class="shipping-wrap">${esc(order.customer)} · ${esc(order.phone || 'ยังไม่มีเบอร์โทร')}<br>${esc(orderAddressText(order.shippingAddress, 'ที่อยู่ยังไม่ครบ'))}</p>${!validRecipient ? '<div class="shipping-address-warning" role="alert">ข้อมูลผู้รับยังไม่ครบ จึงบันทึกคำขอไม่ได้ ต้องมีเบอร์โทร บ้าน / ถนน ตำบล อำเภอ จังหวัด และรหัสไปรษณีย์จากออเดอร์ที่ถูกต้อง</div>' : ''}${marketplace ? `<p class="form-help">ระบบใช้ ${esc(order.channel)} และเลขออเดอร์ของรายการนี้โดยตรง ขนส่งและจุดรับจริงต้องตรวจจากบัญชีร้านหลังเชื่อมต่อ</p>` : `<label class="field">ขนส่งที่จะใช้<select name="carrier" required><option value="">เลือกขนส่งโดยตรง</option>${directCarriers.map(name => `<option value="${esc(name)}" ${name === carrier ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><span class="form-help">เลือกบัญชีขนส่งที่จะเชื่อมสำหรับออเดอร์นี้</span></label>`}</section><section class="shipping-form-section"><h3>ข้อมูลกล่องพัสดุ</h3><div class="shipping-field-grid"><label class="field">น้ำหนักรวมกล่อง (กรัม)<input name="weightGrams" type="number" min="1" max="100000" step="1" value="${esc(parcel.weightGrams || '')}" placeholder="เช่น 500" required inputmode="numeric"></label><label class="field">ความยาว (ซม.)<input name="lengthCm" type="number" min="0.01" max="300" step="0.01" value="${esc(parcel.lengthCm || '')}" required inputmode="decimal"></label><label class="field">ความกว้าง (ซม.)<input name="widthCm" type="number" min="0.01" max="300" step="0.01" value="${esc(parcel.widthCm || '')}" required inputmode="decimal"></label><label class="field">ความสูง (ซม.)<input name="heightCm" type="number" min="0.01" max="300" step="0.01" value="${esc(parcel.heightCm || '')}" required inputmode="decimal"></label></div></section><section class="shipping-form-section"><h3>ผู้ส่งและจุดรับพัสดุ</h3><div class="shipping-field-grid"><label class="field">ชื่อผู้ติดต่อ<input name="senderName" required maxlength="80" value="${esc(sender.name || '')}" autocomplete="name"></label><label class="field">เบอร์โทรผู้ติดต่อ<input name="senderPhone" type="tel" required maxlength="25" value="${esc(sender.phone || '')}" autocomplete="tel" inputmode="tel"></label><label class="field shipping-span-full">บ้านเลขที่ / อาคาร / ถนน<textarea name="senderAddressLine" required maxlength="300" rows="2" autocomplete="address-line1">${esc(sender.addressLine || '')}</textarea></label><label class="field">แขวง / ตำบล<input name="senderSubdistrict" required maxlength="80" value="${esc(sender.subdistrict || '')}"></label><label class="field">เขต / อำเภอ<input name="senderDistrict" required maxlength="80" value="${esc(sender.district || '')}"></label><label class="field">จังหวัด<input name="senderProvince" required maxlength="80" value="${esc(sender.province || '')}" list="shipment-provinces"></label><label class="field">รหัสไปรษณีย์<input name="senderPostalCode" required pattern="[0-9]{5}" minlength="5" maxlength="5" value="${esc(sender.postalCode || '')}" inputmode="numeric" autocomplete="postal-code"></label></div><datalist id="shipment-provinces">${ORDER_EDITOR_PROVINCES.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist></section><section class="shipping-form-section"><h3>วิธีส่งมอบ</h3><label class="field">วิธีส่งพัสดุ<select name="method"><option value="pickup" ${prior.method !== 'dropoff' ? 'selected' : ''}>ให้ขนส่งเข้ารับที่ร้าน</option><option value="dropoff" ${prior.method === 'dropoff' ? 'selected' : ''}>นำพัสดุไปส่งเอง</option></select></label><div id="shipment-pickup-fields" class="shipping-pickup-fields"><label class="field">วันที่ขอเข้ารับ (เวลาไทย)<input name="pickupDate" type="date" min="${thaiDate()}" max="${thaiDate(14)}" value="${esc(date)}" required></label>${timeFields}</div><label class="field shipping-notes-field">หมายเหตุจุดรับ / การส่ง<textarea name="notes" maxlength="500" rows="2" placeholder="เช่น โทรก่อนเข้ารับ">${esc(prior.notes || '')}</textarea></label><p class="form-help">วันและเวลานี้เป็นความต้องการของร้าน ต้องรอผู้ให้บริการยืนยันรอบเข้ารับหลังเชื่อม API</p></section>${readinessMarkup(order.channel, carrier)}<div class="shipping-save-note">บันทึกครั้งนี้เตรียมข้อมูลไว้ในร้าน ยังไม่เรียกรถหรือจองขนส่ง และออเดอร์ยังอยู่สถานะแพ็กครบโดยคงสต๊อกที่กันไว้</div><div class="auth-error" id="shipment-error" role="alert"></div><div class="modal-actions"><button type="button" class="btn" id="shipment-back">กลับไปตรวจออเดอร์</button><button type="submit" class="btn primary" ${validRecipient ? '' : 'disabled'}>บันทึกคำขอเตรียมขนส่ง</button></div></form>`;
    modal('เตรียมเรียกขนส่ง', esc(order.id + ' · ' + order.channel), formMarkup);
    const dialog = document.getElementById('dialog');
    dialog.classList.remove('order-detail-dialog', 'order-editor-dialog', 'guide-dialog');
    dialog.classList.add('shipment-dialog');
    dialog.addEventListener('close', () => dialog.classList.remove('shipment-dialog'), { once: true });
    const form = document.getElementById('shipment-form');
    const requestId = crypto.randomUUID();
    const epoch = sessionEpoch;
    let pending = false;
    if (!marketplace) {
      const carrierSelect = form.elements.carrier;
      const explanation = form.querySelector('.shipping-readiness > p');
      const updateCarrierExplanation = () => {
        const selectedCarrier = carrierSelect.value;
        explanation.textContent = `ออเดอร์ ${order.channel} ใช้ API ของ${selectedCarrier ? 'ขนส่ง ' + selectedCarrier : 'ขนส่งที่เลือก'} โดยตรง`;
      };
      carrierSelect.onchange = updateCarrierExplanation;
      updateCarrierExplanation();
    }
    const methodChanged = () => {
      const pickup = form.elements.method.value === 'pickup';
      const dateInput = form.elements.pickupDate;
      dateInput.required = pickup;
      dateInput.disabled = !pickup;
      document.getElementById('shipment-pickup-fields').hidden = !pickup;
      form.elements.pickupTimeFrom.disabled = !pickup;
      form.elements.pickupTimeTo.disabled = !pickup;
    };
    form.elements.method.onchange = methodChanged;
    methodChanged();
    document.getElementById('shipment-back').onclick = () => showOrder(order.id);
    bindShippingGuides(form);
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending || !validRecipient || !canPrepare()) return;
      const values = new FormData(form);
      const error = document.getElementById('shipment-error');
      error.textContent = '';
      const timeFrom = String(values.get('pickupTimeFrom') || '');
      const timeTo = String(values.get('pickupTimeTo') || '');
      if ((timeFrom && !timeTo) || (!timeFrom && timeTo) || (timeFrom && timeFrom >= timeTo)) {
        error.textContent = 'กรอกช่วงเวลาเริ่มและสิ้นสุดให้ครบ โดยเวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม';
        return;
      }
      const input = {
        id: order.id, requestId, method: values.get('method'),
        pickupDate: values.get('method') === 'pickup' ? String(values.get('pickupDate')) : '',
        pickupTimeFrom: timeFrom, pickupTimeTo: timeTo,
        package: { weightGrams: Number(values.get('weightGrams')), lengthCm: Number(values.get('lengthCm')), widthCm: Number(values.get('widthCm')), heightCm: Number(values.get('heightCm')) },
        sender: { name: String(values.get('senderName')).trim(), phone: String(values.get('senderPhone')).trim(), addressLine: String(values.get('senderAddressLine')).trim(), subdistrict: String(values.get('senderSubdistrict')).trim(), district: String(values.get('senderDistrict')).trim(), province: String(values.get('senderProvince')).trim(), postalCode: String(values.get('senderPostalCode')).trim() },
        notes: String(values.get('notes') || '').trim()
      };
      if (!marketplace) input.carrier = String(values.get('carrier'));
      pending = true;
      form.querySelector('button[type="submit"]').disabled = true;
      try {
        await runAction('request-shipment', input);
        if (epoch !== sessionEpoch) return;
        if (form.isConnected && dialog.open) showOrder(order.id);
        toast('บันทึกข้อมูลแล้ว · รอเชื่อมต่อแพลตฟอร์ม / ขนส่ง ยังไม่ได้เรียกรถจริง');
      } catch (failure) {
        if (form.isConnected && epoch === sessionEpoch) {
          error.textContent = failure.message;
          pending = false;
          form.querySelector('button[type="submit"]').disabled = false;
        }
      }
    };
  }

  function cancelPreparedShipment(order) {
    if (!order || !awaiting(order) || !canCancel()) return;
    modal('ยกเลิกคำขอที่เตรียมไว้', esc(order.id), `<p>ยกเลิกเฉพาะข้อมูลเตรียมขนส่งของออเดอร์นี้ แล้วเตรียมคำขอใหม่ได้ สินค้ายังแพ็กครบและกันสต๊อกไว้ตามเดิม</p><p class="form-help">ยังไม่มีงานจองจริงกับผู้ให้บริการ จึงไม่มีการส่งคำสั่งยกเลิกรถออกไป</p><form id="shipment-cancel-form"><div class="auth-error" id="shipment-cancel-error" role="alert"></div><div class="modal-actions"><button type="button" class="btn" id="shipment-cancel-back">กลับไปตรวจออเดอร์</button><button type="submit" class="btn danger">ยกเลิกคำขอที่เตรียมไว้</button></div></form>`);
    const form = document.getElementById('shipment-cancel-form');
    const requestId = crypto.randomUUID();
    const epoch = sessionEpoch;
    let pending = false;
    document.getElementById('shipment-cancel-back').onclick = () => showOrder(order.id);
    form.onsubmit = async event => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await runAction('cancel-shipment', { id: order.id, requestId });
        if (epoch !== sessionEpoch) return;
        if (form.isConnected && document.getElementById('dialog').open) showOrder(order.id);
        toast('ยกเลิกคำขอที่เตรียมไว้แล้ว');
      } catch (failure) {
        if (form.isConnected && epoch === sessionEpoch) {
          document.getElementById('shipment-cancel-error').textContent = failure.message;
          pending = false;
          submit.disabled = false;
        }
      }
    };
  }

  const previousExtraAction = extraAction;
  extraAction = function (name) {
    if (['pack-request-shipment', 'detail-request-shipment', 'pack-cancel-shipment', 'detail-cancel-shipment'].includes(name)) {
      const order = orders.find(item => item.id === (name.startsWith('detail') ? state.detailId : state.packId));
      if (!order) { toast('ไม่พบออเดอร์ในร้านนี้'); return; }
      if (name.endsWith('cancel-shipment')) cancelPreparedShipment(order); else prepareShipment(order);
      return;
    }
    return previousExtraAction(name);
  };

  function bindShippingGuides(root = document) {
    root.querySelectorAll('[data-shipping-guide]').forEach(button => {
      button.onclick = async () => {
        if (currentAuth?.role !== 'admin') return;
        const channel = button.dataset.shippingGuide;
        if (!marketplaceLinks[channel]) return;
        activeAPIGuide = channel;
        document.getElementById('dialog').close();
        await changeView('connections');
        document.getElementById('api-guide')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
  }
  const previousConnections = views.connections;
  views.connections = function () {
    return previousConnections() + `<section class="panel shipping-connection-panel"><div class="panel-head"><div><h2>เชื่อมการจัดส่งและเรียกรับพัสดุ</h2><p>เลือกวิธีตามช่องทางออเดอร์ บันทึกแบบร่างร้านไม่ได้หมายความว่าอนุญาต API แล้ว</p></div><span class="badge hold">รอแอปและสิทธิ์จริง</span></div><div class="panel-body"><div class="shipping-platform-grid">${Object.keys(marketplaceLinks).map(channel => `<article class="shipping-platform-card"><div class="shipping-platform-heading">${channelLogo(channel)}<h3>${esc(channel)}</h3></div><p>ใช้เลขออเดอร์และบัญชีร้านของ ${esc(channel)} ตรวจวิธีส่งและรอบเข้ารับจากแพลตฟอร์ม</p>${readinessMarkup(channel, '')}</article>`).join('')}</div><div class="shipping-direct-guide"><h3>Facebook · LINE OA · Review · Offline sales</h3><p>เลือก Flash Express, J&T Express, KEX หรือไปรษณีย์ไทยตอนเตรียมพัสดุ และขอเชื่อมบัญชีขนส่งโดยตรง ช่องทางเหล่านี้ไม่มีงานเรียกรับผ่าน API ของ Shopee, TikTok Shop หรือ Lazada</p><ol><li><strong>เจ้าของร้าน:</strong> เปิดบัญชีและขอสิทธิ์ API กับขนส่งที่เลือก</li><li><strong>ผู้พัฒนา:</strong> ตั้งค่าข้อมูลลับบนเซิร์ฟเวอร์ ทดสอบรับพัสดุ ใบจ่าหน้า และสถานะติดตาม</li><li><strong>ตรวจความพร้อม:</strong> ผู้รับ จุดรับ น้ำหนัก ขนาด และรอบเข้ารับต้องผ่านข้อกำหนดของผู้ให้บริการ</li></ol><div class="shipping-source-links">${directCarriers.map(name => htmlLink(name, carrierLinks[name])).join('')}</div><p class="shipping-pending-note">ระบบปัจจุบันบันทึกคำขอเตรียมขนส่งได้ ยังไม่ส่งคำขอจริงจนกว่าจะเชื่อมและทดสอบบัญชีสำเร็จ</p></div></div></section>`;
  };
  const previousBindViews = bindViews;
  bindViews = function () { previousBindViews(); bindShippingGuides(); };
})();
