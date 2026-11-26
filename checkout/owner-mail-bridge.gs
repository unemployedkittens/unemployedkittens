const OWNER_EMAIL = 'unemployedkittens@gmail.com';
const SCHEMA_VERSION = 'rent-a-kitten.brief.v1';

// Run once in the Apps Script editor, then open Project Settings → Script properties.
function initializeOwnerMail() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('OWNER_MAIL_SECRET')) {
    const secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    properties.setProperty('OWNER_MAIL_SECRET', secret);
  }

  // Requests the permission this web app needs without sending a message.
  MailApp.getRemainingDailyQuota();
}

function doPost(event) {
  const raw = event && event.postData && event.postData.contents;
  if (!raw || raw.length > 6800000) return respond(false);

  try {
    const { payload, signature } = JSON.parse(raw);
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty('OWNER_MAIL_SECRET');
    if (!secret || typeof payload !== 'string' || typeof signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(signature)) return respond(false);

    const expected = Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8)
      .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
    let mismatch = 0;
    for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (mismatch !== 0) return respond(false);

    const message = JSON.parse(payload);
    const brief = message.brief;
    const now = Math.floor(Date.now() / 1000);
    if (!/^[a-f0-9-]{36}$/.test(message.delivery_id || '') ||
        !Number.isSafeInteger(message.issued_at) || Math.abs(now - message.issued_at) > 300 ||
        !brief || brief.schema_version !== SCHEMA_VERSION || !/^UK-[A-F0-9-]{36}$/.test(brief.tracking_id || '')) {
      return respond(false);
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return respond(false);
    try {
      const deliveryKey = 'sent_' + message.delivery_id;
      if (properties.getProperty(deliveryKey)) return respond(true);

      const search = brief.search_request;
      const attachments = [
        Utilities.newBlob(JSON.stringify(brief, null, 2), 'application/json', 'rental-brief.v1.json')
      ];
      if (search.reference_image && message.reference_image) {
        attachments.push(Utilities.newBlob(
          Utilities.base64Decode(message.reference_image),
          search.reference_image.mime_type,
          search.reference_image.filename
        ));
      }

      MailApp.sendEmail({
        to: OWNER_EMAIL,
        name: 'Unemployed Kittens',
        subject: '[Rent a Kitten] Paid rental ' + brief.tracking_id,
        body: [
          'RENT A KITTEN',
          'Tracking ID: ' + brief.tracking_id,
          'Verified payment: ' + brief.payment.provider + ' at ' + brief.payment.verified_at,
          '',
          'SEARCH BRIEF',
          'Product or service: ' + search.product_or_service,
          'Requirements: ' + search.requirements,
          'Quantity: ' + search.quantity,
          'Maximum budget: ' + search.maximum_budget,
          'Location: ' + search.location,
          'Priority: ' + search.priority,
          'Target results: ' + search.result_limit,
          'Reference image: ' + (search.reference_image ? search.reference_image.filename : 'None'),
          '',
          'CUSTOMER CONTACT',
          'Email: ' + brief.customer.email,
          'WhatsApp: ' + (brief.customer.whatsapp == null ? 'None' : brief.customer.whatsapp),
          'Telegram: ' + (brief.customer.telegram == null ? 'None' : brief.customer.telegram),
          '',
          'For the grounded-search workflow, import search_request from rental-brief.v1.json.'
        ].join('\n'),
        attachments
      });
      properties.setProperty(deliveryKey, '1');
      return respond(true);
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return respond(false);
  }
}

function respond(accepted) {
  return ContentService.createTextOutput(JSON.stringify({ accepted }))
    .setMimeType(ContentService.MimeType.JSON);
}
